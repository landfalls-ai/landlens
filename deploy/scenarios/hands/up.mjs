// Starts wave 8's scenario in landlens-dev on OrbStack (D169): hands.yaml, plus two Secrets made now. hands-secret
// holds a marker value (LLMARK-…, 40 characters, random per run) that the Secret tests search for, a username and 16
// random bytes; hands-tls is a throwaway self-signed pair made with openssl in a 0700 temp folder that is removed (no
// key or certificate is committed). Only the orbstack context and the landlens-dev namespace are touched; the
// namespace must exist (deploy/scenarios/crashloop.yaml or workbench.yaml makes it). Re-running replaces the Secrets.
// node deploy/scenarios/hands/up.mjs        (node deploy/scenarios/hands/down.mjs removes everything)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const kubectl = (args, input) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { input, encoding: "utf8" });

kubectl(["get", "namespace", "landlens-dev"]); // fails here if it doesn't exist; this script makes no namespace
kubectl(["apply", "-f", join(here, "hands.yaml")]);

const marker = `LLMARK-${randomBytes(24).toString("hex")}`.slice(0, 40);
kubectl(["delete", "secret", "hands-secret", "hands-tls", "--ignore-not-found"]);
const dir = mkdtempSync(join(tmpdir(), "landlens-hands-"));
try {
  const blob = join(dir, "blob");
  writeFileSync(blob, randomBytes(16), { mode: 0o600 });
  kubectl(["create", "secret", "generic", "hands-secret", "--from-literal=username=hands", `--from-literal=password=${marker}`, `--from-file=blob=${blob}`]);
  const crt = join(dir, "tls.crt");
  const key = join(dir, "tls.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", crt,
    "-subj", "/CN=hands.landlens.dev", "-addext", "subjectAltName=DNS:hands.landlens.dev", "-days", "90"], { stdio: "ignore" });
  kubectl(["create", "secret", "tls", "hands-tls", `--cert=${crt}`, `--key=${key}`]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
kubectl(["label", "secret", "hands-secret", "hands-tls", "scenario=hands", "--overwrite"]);
kubectl(["rollout", "status", "deploy/hands-web", "--timeout=120s"]);
console.log("Hands scenario up in landlens-dev.");
