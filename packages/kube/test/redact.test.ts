import { describe, expect, it } from "vitest";
import { capResult, KEY_LINES, keyState, LineScrubber, MAX_STRING, redactObject, redactPart, redactText, scrubBatch, scrubCut, scrubLine, scrubLines } from "../src/redact.js";

describe("redactObject", () => {
  const deployment = {
    kind: "Deployment",
    metadata: {
      name: "api",
      managedFields: [{ manager: "kubectl" }],
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": '{"env":[{"name":"DB_PASSWORD","value":"hunter2"}]}',
        "deployment.kubernetes.io/revision": "7",
        "example.com/huge": "x".repeat(2000),
      },
    },
    spec: {
      template: {
        spec: {
          initContainers: [{ name: "init", env: [{ name: "A", value: "init-secret" }] }],
          containers: [{
            name: "api",
            image: "registry.example.com/api:1.2",
            env: [
              { name: "DB_PASSWORD", value: "hunter2" },
              { name: "FROM_SECRET", valueFrom: { secretKeyRef: { name: "db", key: "password" } } },
            ],
            args: ["--dsn=postgres://app:s3cr3tpass@db:5432/app"],
          }],
        },
      },
    },
  };

  it("keeps what debugging needs and drops what it doesn't", () => {
    const r = redactObject(deployment) as any;
    expect(r.metadata.managedFields).toBeUndefined();
    expect(r.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]).toBeUndefined();
    expect(r.metadata.annotations["deployment.kubernetes.io/revision"]).toBe("7");
    expect(r.metadata.annotations["example.com/huge"]).toBe("<2000 characters omitted>");
    const c = r.spec.template.spec.containers[0];
    expect(c.image).toBe("registry.example.com/api:1.2");
    expect(c.env[0]).toEqual({ name: "DB_PASSWORD", value: "<redacted>" });
    expect(c.env[1].valueFrom.secretKeyRef).toEqual({ name: "db", key: "password" }); // a reference, not a value
    expect(r.spec.template.spec.initContainers[0].env[0].value).toBe("<redacted>");
    expect(c.args[0]).toBe("--dsn=postgres://app:<redacted>@db:5432/app");
    expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cr3tpass|init-secret/);
  });

  it("does not modify its input", () => {
    redactObject(deployment);
    expect(deployment.spec.template.spec.containers[0]!.env[0]!.value).toBe("hunter2");
  });

  it("never passes Secret data, even if one gets here", () => {
    const r = redactObject({ kind: "Secret", metadata: { name: "s" }, data: { pw: "aHVudGVyMg==" }, stringData: { t: "x" } }) as any;
    expect(r.data).toEqual({ pw: "<redacted>" });
    expect(r.stringData).toEqual({ t: "<redacted>" });
  });

  it("caps long strings", () => {
    const r = redactObject({ kind: "ConfigMap", metadata: { name: "c" }, data: { big: "y".repeat(MAX_STRING + 10) } }) as any;
    expect(r.data.big).toMatch(/… \(10 more characters\)$/);
  });
});

describe("redactText", () => {
  it.each([
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "<redacted auth header>"],
    ["token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlc2lnbmF0dXJl", "<redacted jwt>"],
    ["key AKIAABCDEFGHIJKLMNOP", "<redacted aws key id>"],
    ["ghp_" + "a".repeat(36), "<redacted github token>"],
    ["token gho_" + "b".repeat(20), "<redacted github token>"],
    ["github_pat_11ABCDEFG0" + "c".repeat(30), "<redacted github token>"],
    ["key lin_api_" + "d".repeat(40), "<redacted linear key>"],
    ["lin_oauth_" + "e".repeat(32), "<redacted linear key>"],
    ["gcloud printed ya29.a0AfB_" + "g".repeat(40), "<redacted google token>"],
    ["maps key AIzaSyA" + "b".repeat(32), "<redacted google api key>"],
    ["refresh 1//0g" + "c".repeat(60), "<redacted google refresh token>"],
    ["oauth GOCSPX-" + "d".repeat(28), "<redacted google client secret>"],
    // The Land family's keys (wave 7): Landflow's, its MCP token, Landfall's API key, Clickland's.
    ["landflow lf_" + "F".repeat(43), "<redacted land family key>"],
    ["mcp lf_mcp_" + "m".repeat(40), "<redacted land family key>"],
    ["landfall lf_key_" + "k".repeat(32), "<redacted land family key>"],
    ["clickland ck_" + "R".repeat(32), "<redacted clickland key>"],
    ["password=correcthorse", "password=<redacted>"],
    ['"client_secret": "abcdef123456"', '"client_secret": "<redacted>"'],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "<redacted private key>"],
  ])("%s", (input, want) => {
    expect(redactText(input)).toContain(want);
  });

  it("cuts a GitHub token with text glued to its end, and Linear's refresh tokens (Fable's L5)", () => {
    const gh = "ghp_" + "a".repeat(36);
    expect(redactText(`${gh}_tail`)).not.toContain(gh);
    const refresh = "lin_refresh_" + "f".repeat(32);
    expect(redactText(`refresh ${refresh}`)).toBe("refresh <redacted linear key>");
  });

  it("leaves ordinary log lines alone", () => {
    const line = "2026-11-14T10:00:00Z ERROR connection refused to db:5432 (attempt 3)";
    expect(redactText(line)).toBe(line);
  });

  it("leaves words that merely contain ck_ or lf_ alone", () => {
    const line = "lock_manager_acquired_for_shard_12345 and self_test_passed_in_the_first_run";
    expect(redactText(line)).toBe(line);
  });
});

describe("capResult", () => {
  it("says what was cut and how to narrow it", () => {
    expect(capResult("abcdef", 3)).toMatch(/^abc\n… truncated \(3 more characters\)/);
  });
});

describe("redactObject on lists", () => {
  it("scrubs every item's metadata and Secret values in a SecretList", () => {
    const r = redactObject({
      kind: "List",
      items: [{ kind: "ConfigMap", metadata: { name: "c", managedFields: [{}], annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" } } }],
    }) as any;
    expect(r.items[0].metadata).toEqual({ name: "c", annotations: {} });
    const s = redactObject({ kind: "SecretList", items: [{ metadata: { name: "s" }, data: { k: "c2VjcmV0" } }] }) as any;
    expect(s.items[0].data).toEqual({ k: "<redacted>" });
  });

  it("caps a string once, however many times it is scrubbed", () => {
    const once = redactObject({ v: "x".repeat(MAX_STRING + 100) });
    expect(redactObject(once)).toEqual(once);
  });
});

// Security review of wave 7 part 3, M1 and L9: text that is a piece of something longer, and text cut to fit.
describe("redactPart and scrubCut", () => {
  const KEY = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA".repeat(100)}\n-----END RSA PRIVATE KEY-----`;

  it("takes a key's head with no end to the end, and an end with no head from the start", () => {
    expect(redactPart("cfg -----BEGIN PRIVATE KEY-----\nMIIEabc")).toEqual({ text: "cfg <redacted private key>", opened: true });
    expect(redactPart("MIIEabc\n-----END PRIVATE KEY----- done")).toEqual({ text: "<redacted private key> done", opened: false });
    expect(redactPart(`a ${KEY} b`)).toEqual({ text: "a <redacted private key> b", opened: false });
  });

  it("scrubs past the cut, then cuts: a key or a token across the cut is taken whole", () => {
    const k = scrubCut(`${"x".repeat(7000)}${KEY}${"y".repeat(5000)}`, 8192);
    expect(k.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(k.text).not.toContain("BEGIN");
    expect(k.cut).toBe(true);
    expect(k.text.length).toBeLessThanOrEqual(8192);
    const t = scrubCut(`${"x".repeat(8169)} ghp_${"a".repeat(36)} more`, 8192);
    expect(t.text).not.toContain("ghp_");
    const jwt = scrubCut(`${"x".repeat(8150)} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl`, 8192);
    expect(jwt.text).not.toContain("eyJ");
    const url = scrubCut(`${"x".repeat(8170)} postgres://app:hunter2hunter2@db:5432/app`, 8192);
    expect(url.text).not.toContain("hunter2");
  });

  it("grows its window when the scrub shortens the text, so half a secret never slides under the cut", () => {
    // Three keys (each ~1,660 characters, replaced by 22) before the cut, then a token the first window (8,192 + 4,096)
    // splits: scrubbed, the window is shorter than the cut, so its half token would land in what is kept.
    const lead = `${KEY}${KEY}${KEY}`;
    const s = `${lead}${"x".repeat(8192 + 4096 - 10 - lead.length - 1)} ghp_${"b".repeat(36)}`;
    const out = scrubCut(s, 8192);
    expect(out.text).not.toContain("ghp_");
    expect(out.text).not.toContain("bbbbbbbbbbbbbbbbbbbb");
  });

  it("from the end: scrubbed whole, then its last characters kept", () => {
    const lines = ["start", "-----BEGIN RSA PRIVATE KEY-----", "MIIEsecretsecretsecretsecret", "c2Vjb25kIGxpbmU=", "-----END RSA PRIVATE KEY-----", "z".repeat(50)].join("\n");
    const out = scrubCut(lines, 60, true);
    expect(out.text).not.toContain("MIIE");
    expect(out.text).not.toContain("c2Vjb25k");
    expect(out.text).not.toContain("END RSA");
    expect(out.cut).toBe(true);
  });
});

// Security review of wave 10 part 1, M1: a private key logged one line at a time.
describe("scrubLine: a stream read line by line", () => {
  const PEM = ["-----BEGIN EC PRIVATE KEY-----", "MHcCAQEEIBsecretsecretsecretsecret", "oAoGCCqGSM49AwEHoUQDQgAEsecret", "-----END EC PRIVATE KEY-----"];
  it("redacts every line from a key's BEGIN to its END, keeps a timestamp, and reads text after the END", () => {
    const st = keyState();
    const out = ["before", ...PEM.slice(0, 3), `${PEM[3]} after token=ghp_abcdefghijklmnopqrstuvwxyz0123`, "next"].map((l) => scrubLine(l, st));
    expect(out).toEqual(["before", "<redacted private key>", "<redacted private key>", "<redacted private key>", "<redacted private key> after token=<redacted github token>", "next"]);
    expect(st.open).toBe(false);
    const ts = keyState();
    expect(["2026-11-16T10:00:00Z " + PEM[0], "2026-11-16T10:00:01Z " + PEM[1]].map((l) => scrubLine(l, ts))).toEqual(["2026-11-16T10:00:00Z <redacted private key>", "2026-11-16T10:00:01Z <redacted private key>"]);
  });
  it("a BEGIN with no END hides at most KEY_LINES lines", () => {
    const st = keyState();
    scrubLine(PEM[0]!, st);
    for (let i = 0; i < KEY_LINES; i++) expect(scrubLine(`line ${i}`, st)).toBe("<redacted private key>");
    expect(scrubLine("back to the log", st)).toBe("back to the log");
    expect(st.open).toBe(false);
  });
  it("scrubLines: a whole text, a key left open at its end taken to the end", () => {
    expect(scrubLines(["a", ...PEM.slice(0, 3)].join("\n"))).toBe(["a", "<redacted private key>", "<redacted private key>", "<redacted private key>"].join("\n"));
    expect(scrubLines(["a", ...PEM, "b"].join("\n"))).toBe("a\n<redacted private key>\nb");
  });
  it("scrubBatch: a read that began inside a key takes the base64 lines before its END back, and no further", () => {
    const R = "<redacted private key>";
    expect(scrubBatch(["hello world", PEM[1]!, PEM[2]!, PEM[3]!, "after"], keyState())).toEqual(["hello world", R, R, R, "after"]);
    const ts = "2026-11-16T10:00:00Z ";
    expect(scrubBatch([ts + PEM[2]!, ts + PEM[3]!, ts + "tick"], keyState())).toEqual([ts + R, ts + R, ts + "tick"]);
    // An END after a whole key is no lead-in: nothing before the key is touched.
    expect(scrubBatch(["Zm9v", ...PEM], keyState())).toEqual(["Zm9v", R, R, R, R]);
  });
  it("LineScrubber: a stream that begins inside a key, a line a chunk, holds its leading base64 lines until the END", () => {
    const R = "<redacted private key>";
    const sc = new LineScrubber();
    expect(sc.push([PEM[1]!])).toEqual([]);
    expect(sc.push([PEM[2]!])).toEqual([]);
    expect(sc.push([PEM[3]!])).toEqual([R, R, R]);
    expect(sc.push(["tick"])).toEqual(["tick"]);
    // From then on nothing is held: a lone base64 line goes out at once.
    expect(sc.push(["Zm9vYmFy"])).toEqual(["Zm9vYmFy"]);
    // Leading base64 lines that aren't a key's are released by the first other line.
    const ok = new LineScrubber();
    expect(ok.push(["abc123abc123abc123"])).toEqual([]);
    expect(ok.push(["hello world"])).toEqual(["abc123abc123abc123", "hello world"]);
    // A short word (base64's letters too) starts no run.
    expect(new LineScrubber().push(["starting"])).toEqual(["starting"]);
    // A stream that ends while they are held: taken as a key's.
    const cut = new LineScrubber();
    cut.push([PEM[1]!]);
    expect(cut.end()).toEqual([R]);
  });
});
