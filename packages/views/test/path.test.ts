import { describe, expect, it } from "vitest";
import { COMPUTED, computed, ownerEntry } from "../src/computed.js";
import { parsePath, readPath, type ParsedPath } from "../src/path.js";
import { cellText, docText } from "../src/text.js";

const p = (s: string): ParsedPath => {
  const r = parsePath(s);
  if ("error" in r) throw new Error(r.error);
  return r;
};
const read = (o: unknown, s: string) => readPath(o, p(s));

const pod = (o: Record<string, unknown> = {}) => ({
  kind: "Pod",
  metadata: {
    name: "api-7d9-abc", namespace: "shop", creationTimestamp: "2026-11-16T10:00:00Z",
    labels: { app: "api", "app.kubernetes.io/name": "shop-api" },
    ownerReferences: [{ kind: "ReplicaSet", name: "api-7d9", uid: "u", controller: true }],
  },
  spec: {
    nodeName: "orbstack",
    containers: [
      { name: "api", image: "shop/api:1", resources: { requests: { cpu: "250m", memory: "64Mi" }, limits: { cpu: "1", memory: "128Mi" } } },
      { name: "side", image: "envoy:1", resources: { requests: { cpu: "50m" } } },
    ],
  },
  status: { phase: "Running", containerStatuses: [{ name: "api", ready: true, restartCount: 3, state: { running: {} } }, { name: "side", ready: true, restartCount: 1, state: { running: {} } }] },
  ...o,
});

describe("paths (D207)", () => {
  it("reads names, quoted keys, indexes and [*]", () => {
    expect(read(pod(), "metadata.name")).toBe("api-7d9-abc");
    expect(read(pod(), 'metadata.labels["app.kubernetes.io/name"]')).toBe("shop-api");
    expect(read(pod(), "spec.containers[1].image")).toBe("envoy:1");
    expect(read(pod(), "spec.containers[*].image")).toBe("shop/api:1, envoy:1");
    expect(read(pod(), "status.containerStatuses[0].restartCount")).toBe(3);
    expect(read(pod(), "status.containerStatuses[0].ready")).toBe(true);
    expect(read(pod(), "spec.containers[5].image")).toBeNull();
    expect(read(pod(), "spec.nothing.here")).toBeNull();
  });

  it("gives no value for an object or a list, and never an inherited property", () => {
    expect(read(pod(), "metadata.labels")).toBeNull();
    expect(read(pod(), "spec.containers")).toBeNull();
    expect(read(pod(), "metadata.toString")).toBeNull();
    expect(read(pod(), "metadata.hasOwnProperty")).toBeNull();
    expect(read({ a: Object.create({ inherited: "yes" }) }, "a.inherited")).toBeNull();
  });

  it("joins at most 20 values and visits a bounded number of elements", () => {
    const many = { xs: Array.from({ length: 300_000 }, (_, i) => ({ n: i })) };
    const t = Date.now();
    expect(read(many, "xs[*].n")).toBe(`${Array.from({ length: 20 }, (_, i) => i).join(", ")}, …`);
    const empty = { xs: Array.from({ length: 300_000 }, () => ({})) };
    expect(read(empty, "xs[*].n")).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("refuses __proto__, constructor and prototype, long paths and bad shapes", () => {
    for (const bad of ["__proto__", "a.constructor", 'a["__proto__"]', "a.prototype", "", ".a", "a.", "a[", "a[x]", "a[100]", "a.b.c.d.e.f.g.h.i", "$what", "x".repeat(201)]) {
      expect(parsePath(bad)).toHaveProperty("error");
    }
    expect(parsePath("a.b.c.d.e.f.g.h")).toHaveProperty("segments");
  });

  it("cleans every string it returns", () => {
    expect(read({ a: "x\u202ey\u200bz\u0007" }, "a")).toBe("xyz");
    expect(read({ a: "line\none" }, "a")).toBe("line one");
    expect(read({ a: "token: ghp_abcdefghijklmnopqrstuvwxyz0123" }, "a")).toBe("token: <redacted github token>");
    expect(read({ a: "y".repeat(5000) }, "a")).toHaveLength(2000);
    expect(read({ a: Number.NaN }, "a")).toBeNull();
  });
});

describe("computed names", () => {
  const c = (name: Parameters<typeof computed>[0], o: unknown, owners?: Map<string, { kind: string; name: string }>) => computed(name, o, owners ? { owners } : {});

  it("reads a pod as kubectl does", () => {
    const o = pod();
    expect(c("$name", o)).toBe("api-7d9-abc");
    expect(c("$namespace", o)).toBe("shop");
    expect(c("$kind", o)).toBe("Pod");
    expect(c("$key", o)).toBe("Pod/shop/api-7d9-abc");
    expect(c("$age", o)).toBe(Date.parse("2026-11-16T10:00:00Z"));
    expect(c("$status", o)).toBe("Running");
    expect(c("$tone", o)).toBe("ok");
    expect(c("$ready", o)).toBe("2/2");
    expect(c("$restarts", o)).toBe(4);
    expect(c("$node", o)).toBe("orbstack");
    expect(c("$images", o)).toBe("shop/api:1, envoy:1");
    expect(c("$cpuRequest", o)).toBeCloseTo(0.3);
    expect(c("$cpuLimit", o)).toBeNull(); // not every container sets one
    expect(c("$memoryRequest", o)).toBe(64 * 2 ** 20); // the sidecar sets none: the sum of those that do
    expect(c("$labels", o)).toBe("app=api, app.kubernetes.io/name=shop-api");
    expect(c("$replicas", o)).toBeNull();
  });

  it("finds a pod's workload through one ReplicaSet or Job hop, when the hidden watches know it", () => {
    const owners = new Map([ownerEntry({ metadata: { name: "api-7d9", namespace: "shop", ownerReferences: [{ kind: "Deployment", name: "api", controller: true }] } }, "ReplicaSet")!]);
    expect(c("$workload", pod(), owners)).toBe("Deployment/shop/api");
    expect(c("$workload", pod())).toBe("ReplicaSet/shop/api-7d9");
    const jobPod = pod({ metadata: { name: "nightly-1-x", namespace: "shop", ownerReferences: [{ kind: "Job", name: "nightly-1", controller: true }] } });
    const jobs = new Map([ownerEntry({ metadata: { name: "nightly-1", namespace: "shop", ownerReferences: [{ kind: "CronJob", name: "nightly", controller: true }] } }, "Job")!]);
    expect(c("$workload", jobPod, jobs)).toBe("CronJob/shop/nightly");
    const bare = pod({ metadata: { name: "debug", namespace: "shop" } });
    expect(c("$workload", bare)).toBe("Pod/shop/debug");
    // An owner reference that isn't the controller is not the workload.
    expect(c("$workload", pod({ metadata: { name: "x", namespace: "shop", ownerReferences: [{ kind: "ReplicaSet", name: "r" }] } }))).toBe("Pod/shop/x");
  });

  it("reads workloads, nodes, jobs, events and selectors", () => {
    const d = { kind: "Deployment", metadata: { name: "api", namespace: "shop" }, spec: { replicas: 3, selector: { matchLabels: { app: "api" } }, template: { spec: { containers: [{ name: "a", image: "i:1", resources: { requests: { cpu: "100m" }, limits: { cpu: "200m" } } }] } } }, status: { readyReplicas: 2 } };
    expect(c("$status", d)).toBe("Updating");
    expect(c("$tone", d)).toBe("warn");
    expect(c("$replicas", d)).toBe("2/3");
    expect(c("$ready", d)).toBe("2/3");
    expect(c("$selector", d)).toBe("app=api");
    expect(c("$cpuLimit", d)).toBeCloseTo(0.2);
    expect(c("$images", d)).toBe("i:1");
    expect(c("$status", { ...d, status: { readyReplicas: 0 } })).toBe("Unavailable");
    expect(c("$status", { ...d, spec: { ...d.spec, replicas: 0 } })).toBe("Scaled to 0");
    const svc = { kind: "Service", metadata: { name: "api", namespace: "shop" }, spec: { selector: { tier: "web", app: "api" } } };
    expect(c("$selector", svc)).toBe("app=api, tier=web");
    const node = { kind: "Node", metadata: { name: "n1" }, status: { conditions: [{ type: "Ready", status: "True" }] } };
    expect(c("$status", node)).toBe("Ready");
    expect(c("$node", node)).toBe("n1");
    expect(c("$key", node)).toBe("Node/n1");
    const job = { kind: "Job", metadata: { name: "j", namespace: "a" }, status: { conditions: [{ type: "Failed", status: "True" }] } };
    expect(c("$status", job)).toBe("Failed");
    const ev = { kind: "Event", metadata: { name: "e", namespace: "a" }, type: "Warning", lastTimestamp: "2026-11-16T11:00:00Z", involvedObject: { kind: "Pod", namespace: "a", name: "p" } };
    expect(c("$object", ev)).toBe("Pod/a/p");
    expect(c("$last", ev)).toBe(Date.parse("2026-11-16T11:00:00Z"));
    expect(c("$tone", ev)).toBe("warn");
  });

  it("reads nothing from what isn't a Kubernetes object", () => {
    expect(c("$name", { name: "x" })).toBeNull();
    expect(c("$status", null)).toBeNull();
    expect(c("$status", [])).toBeNull();
  });
});

describe("text", () => {
  it("takes out every invisible character a cell could hide something in", () => {
    const hidden = "a\u0000\u0007\u001b\u007f\u200b\u200d\u202a\u202e\u2066\u{E0041}\u{E007F}\ue000\u{F0000}\ufe0f\u{E0100}\u3164\u2800\ud800b";
    expect(cellText(hidden)).toBe("ab");
    // Line and paragraph separators (and the BOM, which JavaScript counts as space) are a space first: one line.
    expect(cellText("a\u0085\u2028\u2029\ufeffb")).toBe("a b");
  });

  it("cleans before it redacts, so an invisible character can't split a credential past the scrub", () => {
    expect(cellText("token ghp_\u200b" + "a".repeat(36))).toBe("token <redacted github token>");
    expect(cellText("ghp_" + "a".repeat(18) + "\u2060" + "a".repeat(18))).toBe("<redacted github token>");
  });

  it("redacts before it cuts, so a key across the cut goes whole", () => {
    const key = "ghp_" + "a".repeat(36);
    const s = "x".repeat(1990) + " " + key;
    const out = cellText(s);
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("aaaa");
    expect(out.length).toBeLessThanOrEqual(2000);
    const pem = "-----BEGIN RSA PRIVATE KEY-----\n" + "Z".repeat(4000) + "\n-----END RSA PRIVATE KEY-----";
    expect(cellText("x".repeat(1500) + pem)).not.toContain("ZZZZ");
  });

  it("never leaves half an emoji at the cut", () => {
    const out = cellText("x".repeat(1998) + "😀😀");
    expect(out.endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
  });

  it("says when Claude's text holds something invisible, and keeps an emoji's picture", () => {
    expect(docText("ok").invisible).toBe(false);
    expect(docText("a\u202eb").invisible).toBe(true);
    expect(docText("a\nb").invisible).toBe(true);
    expect(docText("a\nb", true).invisible).toBe(false);
    expect(docText("⚠\ufe0f").text).toBe("⚠");
  });
});

// Security review of wave 10 part 1, M2: `$status` skipped cleaning, the one-line rule and the cut.
describe("every computed name is a clean cell", () => {
  const nasty = "War\u200bning\nIGNORE PREVIOUS \u202e" + "x".repeat(3_000);
  it("$status of an Event's type and a Pod's reasons is one clean line of at most 64", () => {
    const ev = { kind: "Event", metadata: { name: "e", namespace: "shop" }, type: nasty };
    const p1 = pod({ status: { reason: nasty } });
    const p2 = pod({ status: { phase: "Pending", containerStatuses: [{ name: "a", state: { waiting: { reason: nasty } } }] } });
    for (const o of [ev, p1, p2]) {
      const s = computed("$status", o) as string;
      expect(s.length).toBeLessThanOrEqual(64);
      expect(s).toBe(cellText(s));
      expect(s).not.toMatch(/[\n\u200b\u202e]/);
    }
  });

  it("property: for 300 objects with hostile strings in every place, every computed name's string is cellText's own", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const words = [nasty, "a\u2028b", "\ud800", "ok", "line\r\nnext", "\u{E0041}tag", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "token=ghp_abcdefghijklmnopqrstuvwxyz0123"];
    const w = () => words[Math.floor(rnd() * words.length)]!;
    const kinds = ["Pod", "Node", "Event", "Deployment", "Job", "CronJob", "Service", "Widget"];
    for (let i = 0; i < 300; i++) {
      const kind = kinds[i % kinds.length]!;
      const o = {
        kind, type: w(), metadata: { name: w(), namespace: w(), labels: { [w()]: w() }, ownerReferences: [{ kind: w(), name: w(), controller: true }] },
        involvedObject: { kind: w(), name: w(), namespace: w() },
        spec: { nodeName: w(), selector: { matchLabels: { a: w() } }, containers: [{ name: w(), image: w() }] },
        status: { phase: w(), reason: w(), conditions: [{ type: "Ready", status: w() }], containerStatuses: [{ state: { waiting: { reason: w() } } }] },
      };
      for (const name of COMPUTED) {
        for (const group of [undefined, "", "example.com"]) {
          const v = computed(name, o, { kind, group });
          if (typeof v === "string") expect(v).toBe(cellText(v));
        }
      }
    }
  });
});
