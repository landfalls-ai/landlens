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

// LoopbackCert is a fresh self-signed certificate for 127.0.0.1, for Landlens's front door. kubectl and client-go
// only send credentials over TLS, so the front door serves TLS and the tool kubeconfig pins this certificate.
// Landlens asks for one per run and keeps it in memory.
type LoopbackCert struct {
	Cert string `json:"cert"`
	Key  string `json:"key"`
}

func newLoopbackCert(now time.Time) (LoopbackCert, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return LoopbackCert{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return LoopbackCert{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Landlens front door", Organization: []string{"Landlens"}},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(30 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true, // self-signed: it is its own trust anchor in the kubeconfig
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1)},
		DNSNames:              []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
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
	}, nil
}

func printLoopbackCert(w io.Writer) error {
	c, err := newLoopbackCert(time.Now())
	if err != nil {
		return err
	}
	return json.NewEncoder(w).Encode(c)
}
