// Errors are fixed sentences (D88): from the status and Google's reason only, never Google's own text.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchProjects, searchResources } from "../src/assets.js";
import { httpError, networkError, rawGcpError, reasonsOf, SENTENCES } from "../src/errors.js";
import { listClusters } from "../src/gke.js";
import { FakeGcp } from "./fake-gcp.js";
import { clientFor } from "./helpers.js";

let fake: FakeGcp;
beforeAll(async () => void (fake = await new FakeGcp().start()));
afterAll(() => fake.stop());
beforeEach(() => fake.fail.clear());

const failWith = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    return e as Error & { status: number };
  }
  throw new Error("did not fail");
};

describe("each failure's sentence", () => {
  it("401: run gcloud auth login (after one retry with a new token)", async () => {
    fake.valid.clear();
    try {
      const e = await failWith(() => searchProjects(clientFor(fake).client));
      expect(e.message).toBe("Google didn't accept gcloud's sign-in. Run `gcloud auth login`.");
      expect(fake.hits("projects:search")).toHaveLength(2);
    } finally {
      fake.valid.add("ya29.FakeTokenForLandlensTestsOnly_0123456789abcdefghijklmnop");
    }
  });

  it("403 SERVICE_DISABLED names the API and the command, for Cloud Asset and Kubernetes Engine", async () => {
    fake.fail.set("payments-core", { status: 403, reason: "SERVICE_DISABLED" });
    expect((await failWith(() => searchResources(clientFor(fake).client, "payments-core"))).message)
      .toBe("The Cloud Asset API is off in payments-core. Turn it on: `gcloud services enable cloudasset.googleapis.com --project payments-core`.");
    expect((await failWith(() => listClusters(clientFor(fake).client, "payments-core"))).message)
      .toBe("The Kubernetes Engine API is off in payments-core. Turn it on: `gcloud services enable container.googleapis.com --project payments-core`.");
  });

  it("403 otherwise names the role, 429 says wait", async () => {
    fake.fail.set("ml-sandbox-42", { status: 403 });
    expect((await failWith(() => searchResources(clientFor(fake).client, "ml-sandbox-42"))).message).toBe("Your account can't list resources in ml-sandbox-42 (it needs Cloud Asset Viewer).");
    expect((await failWith(() => listClusters(clientFor(fake).client, "ml-sandbox-42"))).message).toBe("Your account can't list GKE clusters in ml-sandbox-42 (it needs Kubernetes Engine Cluster Viewer).");
    fake.fail.set("demo-shop", { status: 429 });
    expect((await failWith(() => searchResources(clientFor(fake).client, "demo-shop"))).message).toBe(SENTENCES.limited);
  });

  it("never passes Google's text on: a 403 body with a token-shaped string", async () => {
    const leak = "ya29.LeakedTokenInAnErrorBody_abcdefghijklmnop ghp_" + "A".repeat(36);
    fake.fail.set("demo-shop", { status: 403, message: `denied for ${leak}`, reason: `x ${leak}` });
    const e = await failWith(() => searchResources(clientFor(fake).client, "demo-shop"));
    expect(e.message).not.toContain("ya29");
    expect(e.message).not.toContain("ghp_");
    expect(rawGcpError(e)).not.toMatch(/ya29\.|ghp_A/);
  });

  it("network failures as sentences; the log line cuts bearers and Google tokens", () => {
    expect(networkError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })).message).toBe(SENTENCES.dns);
    expect(networkError(Object.assign(new Error("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify the first certificate" } })).message).toBe(SENTENCES.tls);
    expect(networkError(new DOMException("The operation was aborted due to timeout", "TimeoutError")).message).toBe(SENTENCES.timeout);
    expect(networkError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })).message).toBe(SENTENCES.unreachable);
    expect(rawGcpError(new Error("Authorization: Bearer ya29.abcdefghijklmnopqrstuvwxyz0123"))).not.toContain("ya29.abc");
    expect(rawGcpError(new Error("token ya29.abcdefghijklmnopqrstuvwxyz0123 in text"))).not.toContain("ya29.abc");
  });

  it("reads only well-formed reasons", () => {
    expect(reasonsOf({ error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }, { reason: "not a reason!" }], errors: [{ reason: "accessNotConfigured" }] } }))
      .toEqual(["PERMISSION_DENIED", "SERVICE_DISABLED", "accessNotConfigured"]);
    expect(httpError(500, undefined, "cloudasset", "demo-shop").message).toBe("Google answered HTTP 500.");
  });
});
