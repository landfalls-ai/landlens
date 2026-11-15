// Errors across the bridge (wave 6): contextBridge keeps only an Error's message, so the status rides in it as JSON.
// Before this, every `error.status` check in the page read undefined (the Overview's no-access notice never showed).
import { describe, expect, it } from "vitest";
import { toApiError } from "../src/renderer/src/apiError";

describe("errors from main in the page", () => {
  it("reads the status and the message back out of the bridge's message", () => {
    const e = toApiError(new Error(JSON.stringify({ status: 403, message: 'pods is forbidden: cannot list "pods"' })));
    expect(e.status).toBe(403);
    expect(e.message).toBe('pods is forbidden: cannot list "pods"');
  });

  it("finds it after Electron's own prefix too", () => {
    const e = toApiError(new Error(`Error invoking remote method 'cluster:health': Error: ${JSON.stringify({ status: 409, message: "a\\nb" })}`));
    expect([e.status, e.message]).toEqual([409, "a\\nb"]);
  });

  it("leaves anything else as it was, with no status", () => {
    expect(toApiError(new Error("plain")).status).toBeUndefined();
    expect(toApiError(new Error('{"status":"x","message":"m"}')).status).toBeUndefined();
    expect(toApiError("text").message).toBe("text");
    expect(toApiError(Object.assign(new Error("kept"), { status: 429 })).status).toBe(429);
  });
});
