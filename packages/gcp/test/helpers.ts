import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GcloudAuth, gcloudEnv } from "../src/auth.js";
import { GcpClient, endpointsFor } from "../src/client.js";
import { GCP_ACCOUNT, type FakeGcp } from "./fake-gcp.js";

/** The fake gcloud script's absolute path. */
export const FAKE_GCLOUD = resolve(__dirname, "fake-gcloud.sh");

/** A CLOUDSDK_CONFIG folder for the fake gcloud: files there change its answers and record its calls. */
export const sdkDir = () => mkdtempSync(join(tmpdir(), "landlens-gcloud-"));

/** A client against the fake, with the fake gcloud's token. */
export function clientFor(fake: FakeGcp, o: { dir?: string; fetch?: typeof fetch; maxBytes?: number; limitMs?: number } = {}) {
  const auth = new GcloudAuth({ gcloud: FAKE_GCLOUD, env: gcloudEnv({ HOME: process.env.HOME, PATH: process.env.PATH, ...(o.dir ? { CLOUDSDK_CONFIG: o.dir } : {}) }) });
  const client = new GcpClient({
    endpoints: endpointsFor(fake.origin),
    auth: { token: () => auth.token(GCP_ACCOUNT), drop: () => auth.drop() },
    ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.maxBytes ? { maxBytes: o.maxBytes } : {}), ...(o.limitMs ? { limitMs: o.limitMs } : {}),
  });
  return { auth, client };
}
