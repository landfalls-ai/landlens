// A capped read (security review, wave 4 part 4, findings 4 and 10): refused once the body passes the cap while it
// streams in, so a Service anyone made can't send main gigabytes.
import { describe, expect, it } from "vitest";
import { KubeClient } from "../src/client.js";

const streaming = (chunks: number, size: number) => async () =>
  new Response(new ReadableStream({
    pull(c) {
      if (chunks-- <= 0) return c.close();
      c.enqueue(new Uint8Array(size).fill(0x20));
    },
  }), { status: 200 });

describe("capped JSON reads", () => {
  it("reads a small answer and says its size", async () => {
    const c = new KubeClient({ url: "http://x", secret: "s" }, (async () => new Response('{"a":1}')) as typeof fetch);
    expect(await c.jsonText("/p", { maxBytes: 100 })).toEqual({ value: { a: 1 }, bytes: 7 });
  });

  it("refuses an answer past the cap before it has all arrived", async () => {
    const c = new KubeClient({ url: "http://x", secret: "s" }, streaming(1000, 1024 * 1024) as unknown as typeof fetch);
    await expect(c.jsonCapped("/p", { maxBytes: 8 * 1024 * 1024, timeoutMs: 5000 })).rejects.toMatchObject({ status: 413 });
  });
});
