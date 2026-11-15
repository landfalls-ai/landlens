// which(): the first executable file on a PATH, as Landlens finds gcloud and Claude Code (review of part 4, L3).
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { which } from "../src/env.js";

describe("which", () => {
  it("skips a folder and a file that can't run by that name, and finds the executable after them", () => {
    const root = mkdtempSync(join(tmpdir(), "landlens-which-"));
    const [dirs, plain, real] = ["a", "b", "c"].map((d) => join(root, d)) as [string, string, string];
    mkdirSync(join(dirs, "gcloud"), { recursive: true });
    mkdirSync(plain);
    writeFileSync(join(plain, "gcloud"), "not a program");
    chmodSync(join(plain, "gcloud"), 0o644);
    mkdirSync(real);
    writeFileSync(join(real, "gcloud"), "#!/bin/sh\n", { mode: 0o755 });
    expect(which("gcloud", [dirs, plain, real].join(delimiter))).toBe(join(real, "gcloud"));
    expect(which("gcloud", [dirs, plain].join(delimiter))).toBeUndefined();
  });
});
