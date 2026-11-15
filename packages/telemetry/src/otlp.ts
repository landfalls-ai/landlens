// OTLP/HTTP JSON for Landlens's own telemetry (wave 7 D128), hand-written: the three payloads are small and fixed, and
// no OpenTelemetry SDK runs in main, so no auto-instrumentation can record a URL, a header or a body. The JSON is the
// protobuf mapping the OTLP spec defines for /v1/traces, /v1/metrics and /v1/logs: ids as hex, times and 64-bit
// integers as decimal strings, attributes as { key, value: { stringValue | intValue | doubleValue | boolValue } }.
// Records come only from records.ts; the resource only from `resourceOf`.
import type { TelemetryAttrs, TelemetryRecord, TelemetryValue } from "@landlens/contracts";
import { teamName, versionText } from "./records.js";

export type KeyValue = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } };

/** What every record is sent under (D129): Landlens, its version, the OS family and the team. No host, user or path. */
export type Resource = { version: string; os: "darwin" | "linux" | "windows" | "other"; team?: string };

export function resourceOf(r: { version: unknown; platform: unknown; team?: unknown }): Resource {
  const os = r.platform === "darwin" ? "darwin" : r.platform === "linux" ? "linux" : r.platform === "win32" ? "windows" : "other";
  const team = teamName(r.team);
  return { version: versionText(r.version) ?? "0.0.0", os, ...(team ? { team } : {}) };
}

const value = (v: TelemetryValue): KeyValue["value"] =>
  typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };

export const kv = (a: TelemetryAttrs): KeyValue[] =>
  (Object.entries(a) as [string, TelemetryValue | undefined][]).filter((e): e is [string, TelemetryValue] => e[1] !== undefined).map(([key, v]) => ({ key, value: value(v) }));

const resourceKv = (r: Resource): KeyValue[] => [
  { key: "service.name", value: { stringValue: "landlens" } },
  { key: "service.namespace", value: { stringValue: "land" } },
  { key: "service.version", value: { stringValue: r.version } },
  { key: "os.type", value: { stringValue: r.os } },
  ...(r.team ? [{ key: "team.id", value: { stringValue: r.team } }] : []),
];

/** Milliseconds as OTLP's nanoseconds, a decimal string. */
export const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

const SCOPE = (r: Resource) => ({ name: "landlens", version: r.version });
const SEVERITY_NUMBER = { info: 9, warn: 13, error: 17 } as const;

/** The three bodies for a batch of records; a signal with no record has no body. */
export function otlpBodies(records: readonly TelemetryRecord[], r: Resource): { traces?: unknown; metrics?: unknown; logs?: unknown } {
  const spans = records.filter((x): x is Extract<TelemetryRecord, { signal: "span" }> => x.signal === "span");
  const metrics = records.filter((x): x is Extract<TelemetryRecord, { signal: "metric" }> => x.signal === "metric");
  const logs = records.filter((x): x is Extract<TelemetryRecord, { signal: "log" }> => x.signal === "log");
  const resource = { attributes: resourceKv(r) };
  const out: { traces?: unknown; metrics?: unknown; logs?: unknown } = {};
  if (spans.length) {
    out.traces = {
      resourceSpans: [{
        resource,
        scopeSpans: [{
          scope: SCOPE(r),
          spans: spans.map((s) => ({
            traceId: s.traceId,
            spanId: s.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name,
            kind: 1,
            startTimeUnixNano: nanos(s.at),
            endTimeUnixNano: nanos(s.end),
            attributes: kv(s.attrs),
            status: { code: s.error ? 2 : 1 },
          })),
        }],
      }],
    };
  }
  if (metrics.length) {
    const byName = new Map<string, Extract<TelemetryRecord, { signal: "metric" }>[]>();
    for (const m of metrics) byName.set(`${m.kind} ${m.name}`, [...(byName.get(`${m.kind} ${m.name}`) ?? []), m]);
    out.metrics = {
      resourceMetrics: [{
        resource,
        scopeMetrics: [{
          scope: SCOPE(r),
          metrics: [...byName.values()].map((points) => {
            const first = points[0]!;
            const dataPoints = points.map((p) => ({
              attributes: kv(p.attrs),
              ...(p.kind === "sum" ? { startTimeUnixNano: nanos(p.start) } : {}),
              timeUnixNano: nanos(p.at),
              asInt: String(p.value),
            }));
            return first.kind === "sum"
              ? { name: first.name, unit: "1", sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints } }
              : { name: first.name, unit: "1", gauge: { dataPoints } };
          }),
        }],
      }],
    };
  }
  if (logs.length) {
    out.logs = {
      resourceLogs: [{
        resource,
        scopeLogs: [{
          scope: SCOPE(r),
          logRecords: logs.map((l) => ({
            timeUnixNano: nanos(l.at),
            observedTimeUnixNano: nanos(l.at),
            severityNumber: SEVERITY_NUMBER[l.severity],
            severityText: l.severity.toUpperCase(),
            body: { stringValue: l.name },
            attributes: kv(l.attrs),
          })),
        }],
      }],
    };
  }
  return out;
}
