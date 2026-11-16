package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
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
	req.Header.Set("Impersonate-User", "system:admin")
	req.Header.Add("Impersonate-Group", "system:masters")
	req.Header.Set("Impersonate-Extra-Scopes", "x")
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
	for k := range seen.Header {
		if strings.HasPrefix(k, "Impersonate-") {
			t.Fatalf("impersonation header %s reached the API server", k)
		}
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
	parse := func(p string) *x509.Certificate {
		block, _ := pem.Decode([]byte(p))
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		return cert
	}
	leaf, ca := parse(c.Cert), parse(c.CA)
	if leaf.IsCA || leaf.KeyUsage&x509.KeyUsageCertSign != 0 {
		t.Fatal("the serving certificate must not be a CA")
	}
	if !ca.IsCA || !ca.MaxPathLenZero || !ca.PermittedDNSDomainsCritical {
		t.Fatal("the CA must sign leaves only, and only for localhost")
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "127.0.0.1"}); err != nil {
		t.Fatalf("does not verify for 127.0.0.1: %v", err)
	}
	if _, err := tls.X509KeyPair([]byte(c.Cert), []byte(c.Key)); err != nil {
		t.Fatalf("cert and key don't pair: %v", err)
	}
	if strings.Contains(c.Key, c.CA) {
		t.Fatal("only the leaf's key leaves")
	}
}

func TestSecretComesFromTheFirstLineOfStdin(t *testing.T) {
	got, err := readSecret(bufio.NewReader(strings.NewReader(testSecret + "\nrest stays for the EOF watch")))
	if err != nil || got != testSecret {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := readSecret(bufio.NewReader(strings.NewReader("short\n"))); err == nil {
		t.Fatal("a short secret must be refused")
	}
	if _, err := readSecret(bufio.NewReader(strings.NewReader(""))); err == nil {
		t.Fatal("no secret must be refused")
	}
}

// Review of wave 6 part 5, L1: a GKE cluster's sidecar checks the address it dials, after resolution, so a name or
// a spelling that lands on this machine or the metadata server is refused there too.
func TestRefuseLocalChecksTheResolvedAddress(t *testing.T) {
	api, seen := fakeAPIServer(t)
	local := strings.Replace(api.URL, "127.0.0.1", "localhost", 1)
	cfg, err := loadConfig(writeKubeconfig(t, local), "fake-ctx")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Dial = refusingLocalDialer()
	h, err := newHandler(cfg, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(h)
	t.Cleanup(proxy.Close)
	req, _ := http.NewRequest("GET", proxy.URL+"/version", nil)
	req.Header.Set(SecretHeader, testSecret)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d, want 502: the loopback API server was dialled", res.StatusCode)
	}
	if seen.URL != nil {
		t.Fatalf("the request reached %s", seen.URL)
	}
}

func TestLocalAddresses(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "127.9.9.9", "::1", "169.254.169.254", "fe80::1", "0.0.0.0", "0.1.2.3", "::", "224.0.0.1", "ff02::1"} {
		if !localAddress(net.ParseIP(s)) {
			t.Errorf("%s should be refused", s)
		}
	}
	for _, s := range []string{"10.0.0.2", "172.16.0.2", "192.168.1.2", "34.120.18.77", "2600:1900::1"} {
		if localAddress(net.ParseIP(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
	if !localAddress(nil) {
		t.Error("an address that isn't one should be refused")
	}
}

// The fake Google's shop-prod CA (packages/gcp/test/fake-gcp.ts FAKE_CLUSTER_CA) and its fingerprint, which
// packages/gcp's caFingerprint must give too: the two sides compare these.
const (
	fakeClusterCA   = "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJkRENDQVJxZ0F3SUJBZ0lVS21ab2hnZGZMbkt6MUlBdW9LbHo3Vk1zWVNFd0NnWUlLb1pJemowRUF3SXcKSHpFZE1Cc0dBMVVFQXd3VWJHRnVaR3hsYm5NdFptRnJaUzFuYTJVdFkyRXdJQmNOTWpZeE1URTFNVE15T0RBNQpXaGdQTWpFeU5qRXdNakl4TXpJNE1EbGFNQjh4SFRBYkJnTlZCQU1NRkd4aGJtUnNaVzV6TFdaaGEyVXRaMnRsCkxXTmhNRmt3RXdZSEtvWkl6ajBDQVFZSUtvWkl6ajBEQVFjRFFnQUVjUDJqQ3Y1N1Q4RW5UOEJWTFR3TFJET3QKczhPYXl1NjRUeThwbkdZVVpGdmQxa24rU3NOVXEzZ2JGRllvdHBKL25BSVk2VUlnYml4YTUvSncvY0ZiNktNeQpNREF3SFFZRFZSME9CQllFRlA0YXlDRkRhUDVzUmZjVERRUGV4azJIVDQ4cU1BOEdBMVVkRXdFQi93UUZNQU1CCkFmOHdDZ1lJS29aSXpqMEVBd0lEU0FBd1JRSWhBTEJSVGcwRW1CKysrYWJta3JKT3pFUU1aejlyMEQwRzhHZS8KVHFROCtmN2VBaUJZVFRvVXc0UFVKR0l6TmRWbmhHTjY5bnFVQ1g1VWJjdVo4MGVFTDFwYW9nPT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo="
	fakeClusterCAFP = "a20a863e00045e5b656f2018980676f61dda45d44e12af370e874bca5b5eed97"
)

// readyFor loads a one-context kubeconfig whose cluster entry is `cluster` and returns the Ready line's tls part.
func readyFor(t *testing.T, cluster string) ReadyTLS {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	cfg := fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: %s
users:
- name: u
  user: {token: t}
contexts:
- name: ctx
  context: {cluster: c, user: u}
current-context: ctx
`, cluster)
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	rc, err := loadConfig(path, "ctx")
	if err != nil {
		t.Fatal(err)
	}
	r, err := readyTLS(rc)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Security review of wave 9 part 1, M1: Ready says which CA the context trusts and whether TLS checking is loosened,
// so Landlens can tie a context of your own to the GKE cluster Google lists only by its CA, not its address alone.
func TestReadySaysWhomTheContextTrusts(t *testing.T) {
	// certificate-authority-data: the CA's fingerprint, nothing loosened.
	got := readyFor(t, fmt.Sprintf(`{server: "https://203.0.113.17", certificate-authority-data: %q}`, fakeClusterCA))
	if got != (ReadyTLS{CA: fakeClusterCAFP}) {
		t.Fatalf("data: %+v", got)
	}
	// The same CA from a file gives the same fingerprint.
	pemPath := filepath.Join(t.TempDir(), "ca.crt")
	raw, _ := base64Decode(fakeClusterCA)
	if err := os.WriteFile(pemPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readyFor(t, fmt.Sprintf(`{server: "https://203.0.113.17", certificate-authority: %q}`, pemPath)); got.CA != fakeClusterCAFP {
		t.Fatalf("file: %+v", got)
	}
	// Another CA, another fingerprint.
	other, err := newLoopbackCert(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got := readyFor(t, fmt.Sprintf(`{server: "https://203.0.113.17", certificate-authority-data: %q}`, base64Encode([]byte(other.CA)))); got.CA == fakeClusterCAFP || len(got.CA) != 64 {
		t.Fatalf("another CA: %+v", got)
	}
	// No CA (the system roots): "".
	if got := readyFor(t, `{server: "https://gke-0123.us-central1.gke.goog"}`); got != (ReadyTLS{}) {
		t.Fatalf("no CA: %+v", got)
	}
	// insecure-skip-tls-verify, tls-server-name and proxy-url are each reported.
	if got := readyFor(t, `{server: "https://203.0.113.17", insecure-skip-tls-verify: true}`); got != (ReadyTLS{Insecure: true}) {
		t.Fatalf("insecure: %+v", got)
	}
	if got := readyFor(t, fmt.Sprintf(`{server: "https://203.0.113.17", certificate-authority-data: %q, tls-server-name: kubernetes.default, proxy-url: "http://127.0.0.1:3128"}`, fakeClusterCA)); got != (ReadyTLS{CA: fakeClusterCAFP, ServerName: true, Proxy: true}) {
		t.Fatalf("server name and proxy: %+v", got)
	}
	// The line itself carries them.
	line, _ := json.Marshal(Ready{Listening: "127.0.0.1:1", Context: "ctx", Server: "https://203.0.113.17", TLS: ReadyTLS{CA: fakeClusterCAFP, Insecure: true}})
	want := `{"listening":"127.0.0.1:1","context":"ctx","server":"https://203.0.113.17","tls":{"ca":"` + fakeClusterCAFP + `","insecure":true,"serverName":false,"proxy":false}}`
	if string(line) != want {
		t.Fatalf("Ready line:\n%s\nwant\n%s", line, want)
	}
}

func base64Decode(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }
func base64Encode(b []byte) string          { return base64.StdEncoding.EncodeToString(b) }
