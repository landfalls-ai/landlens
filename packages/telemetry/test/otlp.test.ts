// OTLP/HTTP JSON as the collector reads it (the protobuf JSON mapping): checked against a fixture written by hand from
// the OTLP spec, and against the GenAI attribute names Clickland's Agents pages read (clickland libs/query/src/agents.ts:
// gen_ai.operation.name, gen_ai.agent.name, gen_ai.conversation.id, gen_ai.usage.*, gen_ai.tool.name, team.id).
import { describe, expect, it } from "vitest";
import { event, gauge, otlpBodies, resourceOf, sum, toolSpan, turnSpan } from "../src/index";

const T = "0123456789abcdef0123456789abcdef";
const S1 = "0123456789abcdef";
const S2 = "fedcba9876543210";

describe("OTLP/HTTP JSON", () => {
  const resource = resourceOf({ version: "0.1.0", platform: "darwin", team: "platform" });

  it("writes a turn and its tool call as one trace, as the fixture", () => {
    const turn = turnSpan({ traceId: T, spanId: S1, start: 1_700_000_000_000, end: 1_700_000_002_500, conversation: "sess-1", model: "claude-opus-5-5", usage: { input: 120, output: 30 }, cost: 0.5, stop: "end_turn", mode: "default", ask: "none", names: false })!;
    const tool = toolSpan({ traceId: T, spanId: S2, parent: S1, start: 1_700_000_000_100, end: 1_700_000_000_200, server: "landlens-kube", tool: "get_logs", status: "ok", gate: "auto", who: "agent" })!;
    expect(otlpBodies([turn, tool], resource)).toEqual({
      traces: {
        resourceSpans: [{
          resource: { attributes: [
            { key: "service.name", value: { stringValue: "landlens" } },
            { key: "service.namespace", value: { stringValue: "land" } },
            { key: "service.version", value: { stringValue: "0.1.0" } },
            { key: "os.type", value: { stringValue: "darwin" } },
            { key: "team.id", value: { stringValue: "platform" } },
          ] },
          scopeSpans: [{
            scope: { name: "landlens", version: "0.1.0" },
            spans: [
              {
                traceId: T, spanId: S1, name: "invoke_agent landlens-claude", kind: 1,
                startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000002500000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
                  { key: "gen_ai.agent.name", value: { stringValue: "landlens-claude" } },
                  { key: "gen_ai.conversation.id", value: { stringValue: "sess-1" } },
                  { key: "gen_ai.request.model", value: { stringValue: "claude-opus-5-5" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "30" } },
                  { key: "gen_ai.usage.cost", value: { doubleValue: 0.5 } },
                  { key: "gen_ai.response.finish_reasons", value: { stringValue: "end_turn" } },
                  { key: "landlens.mode", value: { stringValue: "default" } },
                  { key: "landlens.ask", value: { stringValue: "none" } },
                ],
                status: { code: 1 },
              },
              {
                traceId: T, spanId: S2, parentSpanId: S1, name: "execute_tool landlens-kube.get_logs", kind: 1,
                startTimeUnixNano: "1700000000100000000", endTimeUnixNano: "1700000000200000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
                  { key: "gen_ai.tool.name", value: { stringValue: "get_logs" } },
                  { key: "landlens.server", value: { stringValue: "landlens-kube" } },
                  { key: "landlens.status", value: { stringValue: "ok" } },
                  { key: "landlens.gate", value: { stringValue: "auto" } },
                  { key: "landlens.who", value: { stringValue: "agent" } },
                ],
                status: { code: 1 },
              },
            ],
          }],
        }],
      },
    });
  });

  it("writes sums as delta counters, gauges as gauges, events as log records", () => {
    const b = otlpBodies([
      sum("landlens.tool.calls", 3, { server: "clickland", status: "ok" }, 1_000, 61_000)!,
      sum("landlens.tool.calls", 1, { server: "landlens-kube", status: "refused" }, 1_000, 61_000)!,
      gauge("landlens.clusters.connected", 2, {}, 61_000, true)!,
      event("sidecar.exited", "warn", 1, 5_000)!,
    ], resourceOf({ version: "0.1.0", platform: "linux" })) as { metrics: any; logs: any };
    const metrics = b.metrics.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toEqual({
      name: "landlens.tool.calls", unit: "1",
      sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [
        { attributes: [{ key: "landlens.server", value: { stringValue: "clickland" } }, { key: "landlens.status", value: { stringValue: "ok" } }], startTimeUnixNano: "1000000000", timeUnixNano: "61000000000", asInt: "3" },
        { attributes: [{ key: "landlens.server", value: { stringValue: "landlens-kube" } }, { key: "landlens.status", value: { stringValue: "refused" } }], startTimeUnixNano: "1000000000", timeUnixNano: "61000000000", asInt: "1" },
      ] },
    });
    expect(metrics[1]).toEqual({ name: "landlens.clusters.connected", unit: "1", gauge: { dataPoints: [{ attributes: [], timeUnixNano: "61000000000", asInt: "2" }] } });
    expect(b.logs.resourceLogs[0].scopeLogs[0].logRecords).toEqual([{
      timeUnixNano: "5000000000", observedTimeUnixNano: "5000000000", severityNumber: 13, severityText: "WARN",
      body: { stringValue: "sidecar.exited" },
      attributes: [{ key: "landlens.event", value: { stringValue: "sidecar.exited" } }, { key: "landlens.count", value: { intValue: "1" } }],
    }]);
  });

  it("names no host, user or path in the resource", () => {
    const r = resourceOf({ version: "/Users/alice/app", platform: "darwin", team: "Alice Smith" });
    expect(r).toEqual({ version: "0.0.0", os: "darwin" });
  });
});
