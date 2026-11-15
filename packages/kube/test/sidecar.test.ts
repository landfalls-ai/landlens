import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startSidecar, withoutLandlensSecrets } from "../src/sidecar.js";

const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");

describe("startSidecar", () => {
  it("hands the secret over stdin, never in the environment another process can read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-sidecar-"));
    const kubeconfig = join(dir, "config");
    writeFileSync(kubeconfig, [
      "apiVersion: v1", "kind: Config", "current-context: t",
      "clusters: [{name: t, cluster: {server: 'https://127.0.0.1:1'}}]",
      "users: [{name: t, user: {token: dummy}}]",
      "contexts: [{name: t, context: {cluster: t, user: t}}]",
    ].join("\n"));
    const sc = await startSidecar({ binary: SIDECAR, context: "t", kubeconfig });
    try {
      const ps = execFileSync("ps", ["eww", "-o", "command=", "-p", String(sc.pid)], { encoding: "utf8" });
      expect(ps).toContain("landlens-kube-proxy");
      expect(ps).not.toContain(sc.secret);
      const ok = await fetch(sc.url + "/_landlens/health", { headers: { "X-Landlens-Sidecar": sc.secret } });
      expect(ok.status).toBe(200);
      const refused = await fetch(sc.url + "/_landlens/health");
      expect(refused.status).toBe(401);
    } finally {
      await sc.stop();
    }
  });

  it("sets the variables it is given over Landlens's environment, minus Landlens's secrets (a GKE cluster's PATH)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-sidecar-"));
    const kubeconfig = join(dir, "config");
    writeFileSync(kubeconfig, [
      "apiVersion: v1", "kind: Config", "current-context: t",
      "clusters: [{name: t, cluster: {server: 'https://127.0.0.1:1'}}]",
      "users: [{name: t, user: {token: dummy}}]",
      "contexts: [{name: t, context: {cluster: t, user: t}}]",
    ].join("\n"));
    const sc = await startSidecar({ binary: SIDECAR, context: "t", kubeconfig, env: { LANDLENS_GKE_MARK: "login-path-here", LANDLENS_TOKEN: "f".repeat(64) } });
    try {
      const ps = execFileSync("ps", ["eww", "-o", "command=", "-p", String(sc.pid)], { encoding: "utf8" });
      expect(ps).toContain("LANDLENS_GKE_MARK=login-path-here");
      expect(ps).not.toContain("f".repeat(64));
    } finally {
      await sc.stop();
    }
  });

  it("L6 (review of part 5): a GKE cluster's sidecar gets only the environment it is given, and --refuse-local", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-sidecar-"));
    const kubeconfig = join(dir, "config");
    writeFileSync(kubeconfig, [
      "apiVersion: v1", "kind: Config", "current-context: t",
      "clusters: [{name: t, cluster: {server: 'https://127.0.0.1:1'}}]",
      "users: [{name: t, user: {token: dummy}}]",
      "contexts: [{name: t, context: {cluster: t, user: t}}]",
    ].join("\n"));
    process.env.LANDLENS_NOT_FOR_GCLOUD = "landlens-own-variable";
    const sc = await startSidecar({ binary: SIDECAR, context: "t", kubeconfig, envOnly: true, refuseLocal: true, env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANDLENS_GKE_MARK: "allowlisted" } });
    try {
      const ps = execFileSync("ps", ["eww", "-o", "command=", "-p", String(sc.pid)], { encoding: "utf8" });
      expect(ps).toContain("LANDLENS_GKE_MARK=allowlisted");
      expect(ps).toContain("--refuse-local");
      expect(ps).not.toContain("landlens-own-variable");
    } finally {
      delete process.env.LANDLENS_NOT_FOR_GCLOUD;
      await sc.stop();
    }
  });

  it("keeps Landlens's own secrets out of child environments", () => {
    expect(withoutLandlensSecrets({ PATH: "/bin", LANDLENS_TOKEN: "t", LANDLENS_SIDECAR_SECRET: "s" })).toEqual({ PATH: "/bin" });
  });
});
