import { describe, expect, it } from "vitest";
import { execPath, exitOf } from "../src/exec.js";
import { logPath, MAX_LINE, splitLine } from "../src/logs.js";

describe("pod shells", () => {
  it("put each command word in its own parameter, with a terminal", () => {
    expect(execPath({ namespace: "a b", pod: "p", container: "c", command: ["sh", "-c", "echo hi"] }))
      .toBe("/api/v1/namespaces/a%20b/pods/p/exec?container=c&stdin=true&stdout=true&stderr=true&tty=true&command=sh&command=-c&command=echo+hi");
  });

  it("read the exit from the Status on channel 3", () => {
    expect(exitOf('{"metadata":{},"status":"Success"}')).toEqual({ ended: "exit", code: 0 });
    expect(exitOf('{"status":"Failure","message":"command terminated with non-zero exit code: error executing command [sh], exit code 3","reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"3"}]}}'))
      .toMatchObject({ ended: "exit", code: 3 });
    expect(exitOf('{"status":"Failure","message":"exec: \\"bash\\": executable file not found in $PATH"}')).toEqual({ ended: "exit", message: 'exec: "bash": executable file not found in $PATH' });
    expect(exitOf("not json")).toEqual({ ended: "exit", message: "not json" });
  });
});

describe("logs", () => {
  it("follow with timestamps, or read the previous run once, or start after a time", () => {
    expect(logPath({ namespace: "n", pod: "p", container: "c" })).toBe("/api/v1/namespaces/n/pods/p/log?container=c&timestamps=true&follow=true&tailLines=1000");
    expect(logPath({ namespace: "n", pod: "p", container: "c", previous: true, tailLines: 50_000 })).toBe("/api/v1/namespaces/n/pods/p/log?container=c&timestamps=true&previous=true&tailLines=10000");
    expect(logPath({ namespace: "n", pod: "p", container: "c", sinceTime: "2026-11-15T10:00:00Z" })).toBe("/api/v1/namespaces/n/pods/p/log?container=c&timestamps=true&follow=true&sinceTime=2026-11-15T10%3A00%3A00Z");
  });

  it("split the timestamp from the text, and cut a huge line", () => {
    expect(splitLine("2026-11-15T10:00:00.123456789Z hello world")).toEqual({ ts: "2026-11-15T10:00:00.123456789Z", text: "hello world" });
    expect(splitLine("no timestamp here")).toEqual({ ts: "", text: "no timestamp here" });
    const long = splitLine(`2026-11-15T10:00:00Z ${"x".repeat(MAX_LINE + 10)}`);
    expect(long.text.endsWith("… (10 more characters)")).toBe(true);
  });
});
