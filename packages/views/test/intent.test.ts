// D219 (wave 10 part 3): what a custom block may ask Landlens for. Every intent and verb in the allowlist parses to its
// targets; everything else (delete and drain, an unknown intent or verb, an extra or missing segment, a bad escape, a
// name that isn't a Kubernetes name once decoded, a select past 50) is refused.
import { FRAME_VERBS } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { LOG_KINDS, parseIntent, SELECT_MAX } from "../src/intent";

describe("parseIntent", () => {
  it("parses each intent in the allowlist", () => {
    expect(parseIntent("landlens://object/Pod/landlens-dev/api-1")).toEqual({ kind: "object", targets: [{ kind: "Pod", namespace: "landlens-dev", name: "api-1" }] });
    expect(parseIntent("landlens://object/Node/_/orbstack")).toEqual({ kind: "object", targets: [{ kind: "Node", name: "orbstack" }] });
    expect(parseIntent("landlens://logs/Deployment/landlens-dev/api")).toEqual({ kind: "logs", targets: [{ kind: "Deployment", namespace: "landlens-dev", name: "api" }] });
    expect(parseIntent("landlens://ask/ConfigMap/landlens-dev/cfg")).toEqual({ kind: "ask", targets: [{ kind: "ConfigMap", namespace: "landlens-dev", name: "cfg" }] });
    expect(parseIntent("landlens://select/Pod/landlens-dev/a/landlens-dev/b/landlens-dev/a")).toEqual({
      kind: "select", targets: [{ kind: "Pod", namespace: "landlens-dev", name: "a" }, { kind: "Pod", namespace: "landlens-dev", name: "b" }],
    });
  });

  it("parses every non-destructive verb, and no other", () => {
    for (const v of FRAME_VERBS) expect(parseIntent(`landlens://action/${v}/Deployment/landlens-dev/api`)).toMatchObject({ kind: "action", verb: v });
    expect([...FRAME_VERBS].sort()).toEqual(["cordon", "restart", "resume", "scale", "suspend", "trigger", "uncordon"]);
    for (const v of ["delete", "drain", "Delete", "evict", "apply", "patch", "exec", "", "restart%20"]) {
      expect(parseIntent(`landlens://action/${v}/Deployment/landlens-dev/api`)).toBeUndefined();
    }
  });

  it("refuses an unknown intent, a wrong shape and anything outside landlens://", () => {
    for (const url of [
      "landlens://delete/Pod/landlens-dev/api",
      "landlens://drain/Node/_/orbstack",
      "landlens://view/0123456789abcdef",
      "landlens://open/Pod/landlens-dev/api",
      "landlens://object/Pod/landlens-dev/api/extra",
      "landlens://object/Pod/landlens-dev",
      "landlens://action/restart/Deployment/landlens-dev",
      "landlens://action/restart/Deployment/landlens-dev/api/x",
      "landlens://object//landlens-dev/api",
      "landlens://object/1Pod/landlens-dev/api",
      "landlens://object/Pod/Landlens-Dev/api",
      "landlens://object/Pod/landlens-dev/API",
      "landlens://object/Pod/landlens-dev/a%2Fb",
      "landlens://object/Pod/landlens-dev/%E0%A4%A",
      "landlens://object/Pod/landlens-dev/a b",
      "landlens://object/Pod/landlens-dev/a?b=1",
      "landlens://object/Pod/landlens-dev/a#b",
      "landlens://object/Pod/landlens-dev/-a",
      "landlens://object/Pod/landlens-dev/a.",
      "LANDLENS://object/Pod/landlens-dev/api",
      "https://example.com",
      "javascript:alert(1)",
      "landlens://select/Pod",
      "landlens://select/Pod/landlens-dev",
      "landlens://select/Pod/landlens-dev/a/landlens-dev",
      `landlens://object/Pod/landlens-dev/${"a".repeat(2_000)}`,
    ]) {
      expect(parseIntent(url), url).toBeUndefined();
    }
    expect(parseIntent(42)).toBeUndefined();
    expect(parseIntent(undefined)).toBeUndefined();
  });

  it("opens logs only for kinds that have them", () => {
    for (const k of LOG_KINDS) expect(parseIntent(`landlens://logs/${k}/landlens-dev/x`)?.kind).toBe("logs");
    for (const k of ["ConfigMap", "Service", "Node", "CronJob", "Secret"]) expect(parseIntent(`landlens://logs/${k}/landlens-dev/x`)).toBeUndefined();
  });

  it("decodes a name's colon, as the runtime encodes it", () => {
    expect(parseIntent("landlens://object/ClusterRole/_/system%3Aaggregate-to-view")).toEqual({ kind: "object", targets: [{ kind: "ClusterRole", name: "system:aggregate-to-view" }] });
  });

  it("takes at most 50 objects in a select, at the limit and one past it", () => {
    const pairs = (n: number) => Array.from({ length: n }, (_, i) => `landlens-dev/p-${i}`).join("/");
    expect(parseIntent(`landlens://select/Pod/${pairs(SELECT_MAX)}`)?.targets).toHaveLength(SELECT_MAX);
    expect(parseIntent(`landlens://select/Pod/${pairs(SELECT_MAX + 1)}`)).toBeUndefined();
    expect(parseIntent("landlens://select/Pod/landlens-dev/ok/landlens-dev/NOT-OK")).toBeUndefined();
  });
});
