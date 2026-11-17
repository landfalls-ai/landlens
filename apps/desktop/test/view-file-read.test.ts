// The import's file read (wave 10 part 4, D217; security review of part 4, M1): only a regular file, never past the
// limit, never its own size allocated, never blocked on a pipe. Each case here hung main or grew it without bound before.
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_NOTES, VIEW_LIMITS } from "@landlens/views";
import { afterAll, describe, expect, it } from "vitest";
import { READ_NOTES, readImport } from "../src/main/view-file-read";

const dir = mkdtempSync(join(tmpdir(), "landlens-import-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const timed = async <T>(f: () => Promise<T>) => {
  const t = performance.now();
  const r = await f();
  return { r, ms: performance.now() - t };
};

describe("readImport (M1)", () => {
  it("reads a regular file whole, up to the limit", async () => {
    const p = join(dir, "ok.landlens-view.json");
    writeFileSync(p, "x".repeat(VIEW_LIMITS.importBytes));
    const r = await readImport(p);
    expect(r).toBeInstanceOf(Uint8Array);
    expect((r as Uint8Array).byteLength).toBe(VIEW_LIMITS.importBytes);
  });

  it("refuses a symbolic link to /dev/zero at once, without reading it", async () => {
    const p = join(dir, "zero.landlens-view.json");
    symlinkSync("/dev/zero", p);
    const { r, ms } = await timed(() => readImport(p));
    expect(r).toEqual({ refused: READ_NOTES.notFile });
    expect(ms).toBeLessThan(100);
    // A link to a regular file is refused too: the file the person picked is the one read, or none.
    const real = join(dir, "real.json");
    writeFileSync(real, "{}");
    const link = join(dir, "link.landlens-view.json");
    symlinkSync(real, link);
    expect(await readImport(link)).toEqual({ refused: READ_NOTES.notFile });
  });

  it("refuses a device picked directly, and a folder", async () => {
    expect(await readImport("/dev/zero")).toEqual({ refused: READ_NOTES.notFile });
    expect(await readImport(dir)).toEqual({ refused: READ_NOTES.notFile });
  });

  it("refuses a named pipe without waiting for a writer", async () => {
    const p = join(dir, "pipe.landlens-view.json");
    execFileSync("mkfifo", [p]);
    const { r, ms } = await timed(() => readImport(p));
    expect(r).toEqual({ refused: READ_NOTES.notFile });
    expect(ms).toBeLessThan(500);
  });

  it("refuses a 2 GB sparse file by its size, without allocating it", async () => {
    const p = join(dir, "sparse.landlens-view.json");
    const fd = openSync(p, "w");
    ftruncateSync(fd, 2 ** 31);
    closeSync(fd);
    const rss = process.memoryUsage().rss;
    const { r, ms } = await timed(() => readImport(p));
    expect(r).toEqual({ refused: FILE_NOTES.tooBig(2 ** 31) });
    expect(ms).toBeLessThan(500);
    expect(process.memoryUsage().rss - rss).toBeLessThan(64 * 1024 * 1024);
  });

  it("never reads past the limit, whatever the file's size said", async () => {
    const p = join(dir, "big.landlens-view.json");
    writeFileSync(p, "y".repeat(100));
    // A file that is larger than the limit given (as one that grew since its size was read would be).
    expect(await readImport(p, 50)).toEqual({ refused: FILE_NOTES.tooBig(100) });
    expect(await readImport(join(dir, "missing.json"))).toEqual({ refused: READ_NOTES.unreadable });
  });
});
