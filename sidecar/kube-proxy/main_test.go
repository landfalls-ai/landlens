package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef"

// fakeAPIServer records what reached "the cluster".
func fakeAPIServer(t *testing.T) (*httptest.Server, *http.Request) {
	t.Helper()
	var seen http.Request
	// TLS, because client-go only sends credentials to a TLS server.
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = *r.Clone(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"kind":"PodList","path":%q}`, r.URL.Path)
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func writeKubeconfig(t *testing.T, server string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	cfg := fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- name: fake
  cluster: {server: %q, insecure-skip-tls-verify: true}
users:
- name: fake-user
  user: {token: user-token-from-kubeconfig}
contexts:
- name: fake-ctx
  context: {cluster: fake, user: fake-user}
current-context: fake-ctx
`, server)
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func newTestProxy(t *testing.T) (*httptest.Server, *http.Request) {
	t.Helper()
	api, seen := fakeAPIServer(t)
	cfg, err := loadConfig(writeKubeconfig(t, api.URL), "fake-ctx")
	if err != nil {
		t.Fatal(err)
	}
	h, err := newHandler(cfg, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(h)
	t.Cleanup(proxy.Close)
	return proxy, seen
}

func TestRefusesCallersWithoutTheSecret(t *testing.T) {
	proxy, seen := newTestProxy(t)
	for _, secret := range []string{"", "wrong", testSecret + "x"} {
		req, _ := http.NewRequest("GET", proxy.URL+"/api/v1/pods", nil)
		if secret != "" {
			req.Header.Set(SecretHeader, secret)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized || !strings.Contains(string(body), `"kind":"Status"`) {
			t.Fatalf("secret %q: got %d %s, want 401 Status", secret, res.StatusCode, body)
		}
	}
	if seen.URL != nil {
		t.Fatalf("a refused request reached the API server: %s", seen.URL)
	}
}

func TestForwardsWithTheUsersCredentialsOnly(t *testing.T) {
	proxy, seen := newTestProxy(t)
	req, _ := http.NewRequest("GET", proxy.URL+"/api/v1/namespaces/a/pods?limit=5", nil)
	req.Header.Set(SecretHeader, testSecret)
	req.Header.Set("Authorization", "Bearer caller-token")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if got := seen.Header.Get("Authorization"); got != "Bearer user-token-from-kubeconfig" {
		t.Fatalf("Authorization at the API server = %q, want the kubeconfig user's token", got)
	}
	if seen.Header.Get(SecretHeader) != "" {
		t.Fatal("the sidecar secret was forwarded to the API server")
	}
	if seen.URL.Path != "/api/v1/namespaces/a/pods" || seen.URL.Query().Get("limit") != "5" {
		t.Fatalf("forwarded %s", seen.URL)
	}
}

func TestHealth(t *testing.T) {
	proxy, _ := newTestProxy(t)
	req, _ := http.NewRequest("GET", proxy.URL+"/_landlens/health", nil)
	req.Header.Set(SecretHeader, testSecret)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != `{"ok":true}` {
		t.Fatalf("health = %s", body)
	}
}

func TestUnknownContextIsAnError(t *testing.T) {
	api, _ := fakeAPIServer(t)
	if _, err := loadConfig(writeKubeconfig(t, api.URL), "nope"); err == nil {
		t.Fatal("want an error for a missing context")
	}
}

func TestLoopbackCertIsValidFor127001(t *testing.T) {
	c, err := newLoopbackCert(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(c.Cert))
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	if _, err := cert.Verify(x509.VerifyOptions{Roots: pool, DNSName: "127.0.0.1"}); err != nil {
		t.Fatalf("does not verify for 127.0.0.1: %v", err)
	}
	if _, err := tls.X509KeyPair([]byte(c.Cert), []byte(c.Key)); err != nil {
		t.Fatalf("cert and key don't pair: %v", err)
	}
}
