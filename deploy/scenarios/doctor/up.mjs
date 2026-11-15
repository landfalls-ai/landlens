// Starts the cluster doctor's broken scenarios in landlens-dev on OrbStack (wave 5, D69): the YAML files here, the
// crash loop one level up, and three throwaway self-signed TLS Secrets made now with openssl (expired, 3 days, 300
// days). No key or certificate is committed; the temp folder is removed. `--down` deletes everything labelled
// scenario=doctor (the crash loop stays: it is its own scenario). Only the orbstack context and objects in the
// landlens-dev namespace are touched; the namespace itself must exist (crashloop.yaml makes it).
// node deploy/scenarios/doctor/up.mjs [--down]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const kubectl = (args, input) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { input, encoding: "utf8" });

if (process.argv.includes("--down")) {
  kubectl(["delete", "deployments,secrets,persistentvolumeclaims", "-l", "scenario=doctor", "--ignore-not-found", "--wait=true"]);
  console.log("Doctor scenarios removed from landlens-dev.");
  process.exit(0);
}

// Checked before anything is applied (security review, wave 5 part 1, finding 11).
const version = execFileSync("openssl", ["version"], { encoding: "utf8" });
const [major, minor] = (/^OpenSSL (\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
if (!(major > 3 || (major === 3 && minor >= 4))) throw new Error(`The expired certificate needs OpenSSL 3.4 or later (-not_before/-not_after); this is ${version.trim()}.`);
kubectl(["get", "namespace", "landlens-dev"]); // fails here if it doesn't exist; this script makes no namespace

// The crash loop's file also declares the namespace (cluster-wide): only its namespaced documents are applied here.
const crashloop = readFileSync(join(here, "..", "crashloop.yaml"), "utf8").split(/^---$/m).filter((d) => !/^kind: Namespace$/m.test(d)).join("\n---\n");
kubectl(["apply", "-f", "-"], crashloop);
for (const f of readdirSync(here).filter((f) => f.endsWith(".yaml")).sort()) kubectl(["apply", "-f", join(here, f)]);

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, "").replace(/\.\d+Z$/, "Z");
const day = 86_400_000;
const now = Date.now();
const dir = mkdtempSync(join(tmpdir(), "landlens-doctor-"));
try {
  const certs = [
    { name: "shop-tls-expired", host: "old.shop.landlens.dev", dates: ["-not_before", stamp(now - 40 * day), "-not_after", stamp(now - 3 * day)] },
    { name: "shop-tls", host: "shop.landlens.dev", dates: ["-days", "3"] },
    { name: "shop-tls-ok", host: "ok.shop.landlens.dev", dates: ["-days", "300"] },
  ];
  for (const c of certs) {
    const crt = join(dir, `${c.name}.crt`);
    const key = join(dir, `${c.name}.key`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", crt,
      "-subj", `/CN=${c.host}`, "-addext", `subjectAltName=DNS:${c.host}`, ...c.dates], { stdio: "ignore" });
    kubectl(["delete", "secret", c.name, "--ignore-not-found"]);
    kubectl(["create", "secret", "tls", c.name, `--cert=${crt}`, `--key=${key}`]);
    kubectl(["label", "secret", c.name, "scenario=doctor", "--overwrite"]);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Doctor scenarios up in landlens-dev: give them 3 minutes to break (pending and not-ready wait 2 minutes).");
