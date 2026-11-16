// Errors are fixed sentences (D88): from the status and Google's reason only, never Google's own text.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchProjects, searchResources } from "../src/assets.js";
import { httpError, networkError, rawGcpError, reasonsOf, SENTENCES } from "../src/errors.js";
import { listClusters } from "../src/gke.js";
import { gkeAdvice } from "../src/recommender.js";
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

describe("Cloud Monitoring and the recommender (wave 9, D175)", () => {
  const shop = { project: "demo-shop", number: "482913570214", location: "us-central1", name: "shop-prod" };

  it("a disabled API names it and its command; a denied read names the role", async () => {
    fake.fail.set("demo-shop", { status: 403, reason: "SERVICE_DISABLED", api: "recommender" });
    expect((await failWith(() => gkeAdvice(clientFor(fake).client, shop))).message)
      .toBe("The Recommender API is off in demo-shop. Turn it on: `gcloud services enable recommender.googleapis.com --project demo-shop`.");
    fake.fail.set("demo-shop", { status: 403, api: "recommender" });
    expect((await failWith(() => gkeAdvice(clientFor(fake).client, shop))).message)
      .toBe("Your account can't read GKE recommendations in demo-shop (it needs GKE Diagnosis Recommender Viewer).");
    expect(httpError(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }, "monitoring", "demo-shop").message)
      .toBe("The Cloud Monitoring API is off in demo-shop. Turn it on: `gcloud services enable monitoring.googleapis.com --project demo-shop`.");
    expect(httpError(403, { error: { status: "PERMISSION_DENIED" } }, "monitoring", "demo-shop").message)
      .toBe("Your account can't read Cloud Monitoring in demo-shop (it needs Monitoring Viewer).");
  });

  it("a refused PromQL query is one fixed sentence; neither it nor the log line holds the echoed query", () => {
    const marker = "MARKER_9f3c ya29.EchoedTokenShape_abcdefghijklmnop";
    const body = { status: "error", errorType: "bad_data", error: `invalid parameter "query": 1:1: parse error near ${marker} sum by (project_id) (x{cluster_name="shop-prod"})` };
    for (const status of [400, 422]) {
      const e = httpError(status, body, "monitoring", "demo-shop");
      expect(e.message).toBe("Cloud Monitoring didn't accept Landlens's query.");
      expect(e.message).toBe(SENTENCES.query);
      expect(rawGcpError(e)).toContain("bad_data");
      expect(rawGcpError(e)).not.toMatch(/MARKER|ya29|cluster_name|parse error/);
    }
    // Only the PromQL API's 400 is that sentence; another API's is still "answered HTTP 400".
    expect(httpError(400, body, "recommender", "demo-shop").message).toBe("Google answered HTTP 400.");
  });

  it("errorType reaches the log only in its shape", () => {
    expect(reasonsOf({ status: "error", errorType: "bad_data", error: "x" })).toEqual(["bad_data"]);
    expect(reasonsOf({ status: "error", errorType: "Bad Data ya29.abcdefghijklmnop", error: "x" })).toEqual([]);
    expect(reasonsOf({ status: "error", errorType: "a".repeat(33) })).toEqual([]);
    expect(reasonsOf({ status: "success", errorType: "bad_data" })).toEqual([]);
  });
});

describe("Fable's security review of part 4, fixed", () => {
  it("L1: an error's status reaches the log only in Google's shape, so one that echoes a token is dropped", () => {
    expect(reasonsOf({ error: { status: "PERMISSION_DENIED" } })).toEqual(["PERMISSION_DENIED"]);
    const token = "eyJhbGciOiJSUzI1NiJ9.federatedTokenShape_0123456789abcdef";
    expect(reasonsOf({ error: { status: `UNAUTHENTICATED ${token}` } })).toEqual([]);
    expect(rawGcpError(httpError(401, { error: { status: `UNAUTHENTICATED ${token}` } }, "cloudasset", "demo-shop"))).not.toContain(token);
  });
});
