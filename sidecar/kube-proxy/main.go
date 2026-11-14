// Command landlens-kube-proxy holds one cluster's credentials for Landlens.
//
// Landlens starts one per connected cluster. It reads the user's kubeconfig with client-go, so exec plugins, OIDC
// tokens and client certificates behave exactly as in kubectl, and forwards requests to the API server with those
// credentials. It listens on loopback only and answers only callers that present the per-process secret Landlens
// passed in LANDLENS_SIDECAR_SECRET, so no other local process can borrow the user's credentials. It exits when its
// stdin closes, so it never outlives Landlens.
//
// With --loopback-cert it instead prints a fresh certificate for Landlens's front door (cert.go).
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// SecretHeader carries the per-process secret on every request from Landlens.
const SecretHeader = "X-Landlens-Sidecar"

// minSecretLen is the shortest secret accepted (32 bytes hex-encoded by Landlens is 64 characters).
const minSecretLen = 32

// Ready is the one JSON line written to stdout once the sidecar listens.
type Ready struct {
	Listening string `json:"listening"`
	Context   string `json:"context"`
	Server    string `json:"server"`
}

func main() {
	if err := run(); err != nil {
		slog.Error("landlens-kube-proxy stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	kubeconfig := flag.String("kubeconfig", "", "kubeconfig file(s), separated like KUBECONFIG; empty uses the default rules")
	contextName := flag.String("context", "", "the kubeconfig context to serve (required)")
	certMode := flag.Bool("loopback-cert", false, "print a fresh self-signed certificate and key for 127.0.0.1 as JSON, and exit")
	flag.Parse()
	if *certMode {
		return printLoopbackCert(os.Stdout)
	}
	if *contextName == "" {
		return errors.New("--context is required")
	}
	secret := os.Getenv("LANDLENS_SIDECAR_SECRET")
	if len(secret) < minSecretLen {
		return fmt.Errorf("LANDLENS_SIDECAR_SECRET must be at least %d characters", minSecretLen)
	}
	// Don't leak the secret to exec credential plugins the transport may start.
	_ = os.Unsetenv("LANDLENS_SIDECAR_SECRET")

	cfg, err := loadConfig(*kubeconfig, *contextName)
	if err != nil {
		return err
	}
	handler, err := newHandler(cfg, secret)
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}

	ready, _ := json.Marshal(Ready{Listening: ln.Addr().String(), Context: *contextName, Server: cfg.Host})
	fmt.Println(string(ready))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { // stdin closing means Landlens is gone
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// loadConfig reads one context from the kubeconfig the way kubectl does.
func loadConfig(kubeconfig, contextName string) (*rest.Config, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if kubeconfig != "" {
		rules.ExplicitPath = ""
		rules.Precedence = splitList(kubeconfig)
	}
	cfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules,
		&clientcmd.ConfigOverrides{CurrentContext: contextName}).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("context %q: %w", contextName, err)
	}
	// Upgraded connections (exec, attach, port-forward) need HTTP/1.1 end to end.
	cfg.TLSClientConfig.NextProtos = []string{"http/1.1"}
	cfg.UserAgent = "landlens-kube-proxy"
	return cfg, nil
}

func splitList(s string) []string {
	var out []string
	for _, p := range filepathSplit(s) {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// newHandler builds the authenticated reverse proxy to the cluster's API server.
func newHandler(cfg *rest.Config, secret string) (http.Handler, error) {
	transport, err := rest.TransportFor(cfg)
	if err != nil {
		return nil, err
	}
	target, err := url.Parse(cfg.Host)
	if err != nil {
		return nil, err
	}
	if target.Scheme == "" {
		target.Scheme = "https"
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
			// The caller's own credentials (if any) never reach the cluster; client-go adds the user's.
			r.Out.Header.Del("Authorization")
			r.Out.Header.Del(SecretHeader)
			r.Out.Header.Del("Cookie")
		},
		Transport:     transport,
		FlushInterval: -1, // stream watches and logs as they arrive
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeStatus(w, http.StatusBadGateway, "BadGateway", "landlens-kube-proxy: "+err.Error())
		},
	}
	want := []byte(secret)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get(SecretHeader))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			writeStatus(w, http.StatusUnauthorized, "Unauthorized", "landlens-kube-proxy: missing or wrong sidecar secret")
			return
		}
		if r.URL.Path == "/_landlens/health" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		proxy.ServeHTTP(w, r)
	}), nil
}

// writeStatus answers with a Kubernetes Status object, so kubectl and Landlens show the reason.
func writeStatus(w http.ResponseWriter, code int, reason, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"kind": "Status", "apiVersion": "v1", "status": "Failure",
		"reason": reason, "message": message, "code": code,
	})
}
