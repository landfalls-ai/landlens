// Cloud Monitoring (wave 9, D179): PromQL over HTTP, query_range only, GET only. The query is one Landlens built from
// fixed text and checked names (packages/metrics' cloud-monitoring.ts); this file never takes one from the page or the
// agent. The answer is handed back as Google sent it: the caller filters it to the cluster (a project's PromQL answers
// for its whole metrics scope, D181) before anything of it is drawn. A refused query's error echoes the query, so it is
// a fixed sentence here and its text goes nowhere (D175). `packages/metrics` never sees this client or the token: main
// hands it a function.
import { checkProject } from "./assets.js";
import type { GcpClient } from "./client.js";
import { GcpError } from "./errors.js";

/** A GET's URL must stay short; D180's queries are well under this. */
export const PROM_QUERY_MAX = 6_000;
/** A PromQL call's own time limit (D179); the size cap is the client's 8 MB. */
export const PROM_LIMIT_MS = 10_000;

/**
 * One range query on `project`'s PromQL endpoint, as that project (X-Goog-User-Project). `fromMs` and `toMs` are
 * epoch milliseconds; `stepS` seconds. A query that is empty or too long, or a range that isn't one, is refused before
 * any request.
 */
export async function promRange(client: GcpClient, project: string, query: string, fromMs: number, toMs: number, stepS: number): Promise<unknown> {
  checkProject(project);
  if (typeof query !== "string" || !query || query.length > PROM_QUERY_MAX) throw new GcpError(400, "Landlens's query for Cloud Monitoring was too long.", `query of ${String(query?.length)} characters`);
  if (![fromMs, toMs, stepS].every((n) => typeof n === "number" && Number.isFinite(n)) || stepS < 1 || toMs < fromMs) {
    throw new GcpError(400, "Landlens's query for Cloud Monitoring had no time range.", "bad range");
  }
  return client.get(
    "monitoring",
    `/v1/projects/${project}/location/global/prometheus/api/v1/query_range`,
    { query, start: String(fromMs / 1000), end: String(toMs / 1000), step: String(stepS) },
    project,
    { limitMs: PROM_LIMIT_MS },
  );
}
