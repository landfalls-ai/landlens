// Custom resources' columns (wave 4, part 4; D40): the CRD's printer columns, read with a JSONPath subset that
// never evaluates anything, between Name/Namespace and Age, and a Status from a Ready or Available condition.
import type { KubeObject } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { conditionCell, customColumns, parsePath, printerColumn, printerColumns, readPath } from "../src/renderer/src/printer";
import { buildNav } from "../src/renderer/src/kinds";

const cert = {
  apiVersion: "cert-manager.io/v1", kind: "Certificate",
  metadata: { name: "web", namespace: "shop", uid: "u1", creationTimestamp: "2026-11-15T00:00:00Z", labels: { "app.kubernetes.io/name": "web" } },
  spec: { secretName: "web-tls", dnsNames: ["a.example", "b.example"], replicas: 3 },
  status: {
    notAfter: "2027-01-01T00:00:00Z",
    conditions: [{ type: "Issuing", status: "False" }, { type: "Ready", status: "True", reason: "Ready", message: "up to date" }],
  },
} as unknown as KubeObject;

describe("the JSONPath subset", () => {
  it("reads dotted paths, brackets, indexes, wildcards and filters", () => {
    expect(readPath(cert, ".spec.secretName")).toEqual(["web-tls"]);
    expect(readPath(cert, "{.spec.secretName}")).toEqual(["web-tls"]);
    expect(readPath(cert, "$.spec.dnsNames[1]")).toEqual(["b.example"]);
    expect(readPath(cert, ".spec.dnsNames[-1]")).toEqual(["b.example"]);
    expect(readPath(cert, ".spec.dnsNames[*]")).toEqual(["a.example", "b.example"]);
    expect(readPath(cert, `.status.conditions[?(@.type=="Ready")].status`)).toEqual(["True"]);
    expect(readPath(cert, `.status.conditions[?(@.type != 'Ready')].type`)).toEqual(["Issuing"]);
    expect(readPath(cert, ".metadata.labels.app\\.kubernetes\\.io/name")).toEqual(["web"]);
    expect(readPath(cert, ".metadata.labels['app.kubernetes.io/name']")).toEqual(["web"]);
    expect(readPath(cert, ".spec.missing.deeper")).toEqual([]);
  });

  it("reads nothing it doesn't understand, and never a prototype", () => {
    for (const p of ["..spec", ".spec[0:2]", ".spec.dnsNames.length()", "", "x".repeat(600), ".spec[", `[?(@.a=~/x/)]`]) {
      expect(parsePath(p), p).toBeUndefined();
      expect(readPath(cert, p)).toEqual([]);
    }
    expect(readPath(cert, ".constructor")).toEqual([]);
    expect(readPath(cert, ".spec.__proto__")).toEqual([]);
    expect(readPath({ a: Array.from({ length: 500 }, (_, i) => i) }, ".a[*]")).toHaveLength(50);
  });
});

describe("printer columns", () => {
  const crd = {
    metadata: { name: "certificates.cert-manager.io" },
    spec: { versions: [
      { name: "v1alpha1", additionalPrinterColumns: [{ name: "Old", type: "string", jsonPath: ".x" }] },
      { name: "v1", additionalPrinterColumns: [
        { name: "Ready", type: "string", jsonPath: `.status.conditions[?(@.type=="Ready")].status` },
        { name: "Secret", type: "string", jsonPath: ".spec.secretName" },
        { name: "Issuer", type: "string", jsonPath: ".spec.issuerRef.name", priority: 1 },
        { name: "Replicas", type: "integer", jsonPath: ".spec.replicas" },
        { name: "Expires", type: "date", jsonPath: ".status.notAfter" },
        { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
      ] },
    ] },
  } as unknown as KubeObject;

  it("takes the served version's priority-0 columns, and draws dates, numbers and booleans", () => {
    const cols = printerColumns(crd, "v1");
    expect(cols.map((c) => c.name)).toEqual(["Ready", "Secret", "Replicas", "Expires", "Age"]);
    const now = Date.parse("2026-11-15T01:00:00Z");
    expect(printerColumn(cols[2]!, 2)).toMatchObject({ num: true });
    expect(printerColumn(cols[2]!, 2).cell(cert, now)).toEqual({ text: "3", sort: 3 });
    expect(printerColumn(cols[3]!, 3)).toMatchObject({ kind: "age" });
    expect(printerColumn(cols[3]!, 3).cell(cert, now).title).toBe("2027-01-01T00:00:00Z");
    const bool = printerColumn({ name: "Suspended", type: "boolean", jsonPath: ".spec.suspend" }, 9);
    expect(bool.cell({ ...cert, spec: { suspend: true } } as KubeObject, now)).toEqual({ text: "true", tone: "ok" });
    expect(bool.cell(cert, now)).toEqual({ text: "" });
    const long = printerColumn({ name: "Big", type: "string", jsonPath: ".spec.big" }, 1);
    expect(long.cell({ ...cert, spec: { big: "x".repeat(400) } } as KubeObject, now).text).toHaveLength(301);
  });

  it("goes between Name/Namespace and Age, without the CRD's own Age, and adds Status unless it has one (D40)", () => {
    const base = buildNav([{ group: "cert-manager.io", version: "v1", resource: "certificates", kind: "Certificate", namespaced: true, verbs: ["list", "watch"], custom: true }])[0]!.columns;
    const cols = printerColumns(crd, "v1");
    expect(customColumns(base, cols, true).map((c) => c.label)).toEqual(["Name", "Namespace", "Ready", "Secret", "Replicas", "Expires", "Age"]);
    const noReady = cols.filter((c) => c.name !== "Ready");
    expect(customColumns(base, noReady, true).map((c) => c.label)).toEqual(["Name", "Namespace", "Secret", "Replicas", "Expires", "Status", "Age"]);
    expect(customColumns(base, noReady, false).map((c) => c.label)).not.toContain("Status");
  });

  it("shows Ready the pod way: quiet when True, the reason when False, muted when Unknown", () => {
    expect(conditionCell(cert)).toEqual({ text: "Ready", tone: "ok", title: "up to date" });
    const failing = { ...cert, status: { conditions: [{ type: "Ready", status: "False", reason: "IssuerNotFound" }] } } as unknown as KubeObject;
    expect(conditionCell(failing)).toEqual({ text: "IssuerNotFound", tone: "bad" });
    const unknown = { ...cert, status: { conditions: [{ type: "Available", status: "Unknown" }] } } as unknown as KubeObject;
    expect(conditionCell(unknown)).toEqual({ text: "Unknown", tone: "muted" });
    expect(conditionCell({ ...cert, status: {} } as KubeObject)).toBeUndefined();
  });

  it("survives the shapes anyone who can create the object may give it (security review, part 4, findings 7–8)", () => {
    const huge = { apiVersion: "x/v1", kind: "W", metadata: { name: "w", uid: "u" }, spec: { items: Array.from({ length: 300_000 }, (_, i) => i) } } as unknown as KubeObject;
    expect(readPath(huge, ".spec.items[*]")).toHaveLength(50);
    for (const conditions of ["x", {}, [null], [1, "a"], [{ type: "Ready", status: "False", reason: { not: "text" } }]]) {
      const o = { apiVersion: "x/v1", kind: "W", metadata: { name: "w", uid: "u" }, status: { conditions } } as unknown as KubeObject;
      const c = conditionCell(o);
      if (c) expect(typeof c.text).toBe("string");
    }
    const long = { apiVersion: "x/v1", kind: "W", metadata: { name: "w", uid: "u" }, spec: { n: "9".repeat(5000), at: `2026-11-15T00:00:00Z${"x".repeat(5000)}` } } as unknown as KubeObject;
    expect(printerColumn({ name: "N", type: "integer", jsonPath: ".spec.n" }, 0).cell(long, 0).text.length).toBeLessThanOrEqual(301);
  });
});
