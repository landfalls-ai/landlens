// Which Prometheus you chose per kubeconfig context (docs/metrics.md#prometheus), in userData/prometheus.json, mode
// 0600. A found Prometheus is only offered until you choose it: anyone who can make a Service with Prometheus's labels
// could pose as one (security review, wave 4 part 4, finding 4).
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const KEY = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\/[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const MAX = 200;

export class PrometheusChoices {
  constructor(private readonly path: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8"));
      if (!s || typeof s !== "object" || Array.isArray(s)) return {};
      return Object.fromEntries(Object.entries(s).filter(([k, v]) => k !== "__proto__" && k.length <= 253 && typeof v === "string" && KEY.test(v)).slice(0, MAX)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  chosen(context: string): string | undefined {
    const v = this.read()[context];
    return typeof v === "string" ? v : undefined;
  }

  set(context: string, service: string | null) {
    const all = this.read();
    if (service === null) delete all[context];
    else {
      if (!KEY.test(service)) throw Object.assign(new Error("not a Service"), { status: 400 });
      all[context] = service;
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
