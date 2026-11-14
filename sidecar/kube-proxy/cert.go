package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"time"
)

// LoopbackCert is a fresh certificate for 127.0.0.1, for Landlens's front door. kubectl and client-go only send
// credentials over TLS, so the front door serves TLS and the tool kubeconfig pins CA. Landlens asks for one per run
// and keeps it in memory.
//
// Two levels, because BoringSSL (Electron's Node) won't take a self-signed leaf as a trust anchor and a self-signed CA
// serving TLS would be a CA whose key sits in the server. So: a CA that signs exactly this leaf and is then thrown
// away (its key never leaves this function), and a leaf that can sign nothing. The CA is also name-constrained to
// localhost; not to 127.0.0.1, because BoringSSL rejects IP name constraints ("unsupported name constraint type").
type LoopbackCert struct {
	Cert string `json:"cert"`
	Key  string `json:"key"`
	CA   string `json:"ca"`
}

func newLoopbackCert(now time.Time) (LoopbackCert, error) {
	serial := func() (*big.Int, error) { return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127)) }
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return LoopbackCert{}, err
	}
	caSerial, err := serial()
	if err != nil {
		return LoopbackCert{}, err
	}
	caTmpl := &x509.Certificate{
		SerialNumber:                caSerial,
		Subject:                     pkix.Name{CommonName: "Landlens front door CA (this run)", Organization: []string{"Landlens"}},
		NotBefore:                   now.Add(-time.Minute),
		NotAfter:                    now.Add(30 * 24 * time.Hour),
		KeyUsage:                    x509.KeyUsageCertSign,
		BasicConstraintsValid:       true,
		IsCA:                        true,
		MaxPathLenZero:              true,
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         []string{"localhost"},
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return LoopbackCert{}, err
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		return LoopbackCert{}, err
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return LoopbackCert{}, err
	}
	leafSerial, err := serial()
	if err != nil {
		return LoopbackCert{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          leafSerial,
		Subject:               pkix.Name{CommonName: "Landlens front door", Organization: []string{"Landlens"}},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(30 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1)},
		DNSNames:              []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		return LoopbackCert{}, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return LoopbackCert{}, err
	}
	return LoopbackCert{
		Cert: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		Key:  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})),
		CA:   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})),
	}, nil
}

func printLoopbackCert(w io.Writer) error {
	c, err := newLoopbackCert(time.Now())
	if err != nil {
		return err
	}
	return json.NewEncoder(w).Encode(c)
}
