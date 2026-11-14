// Proves the fuse settings take: clone the Electron.app (APFS clone, instant), harden it, read the wire back.
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hardenFuses, LANDLENS_FUSES } from "./fuses.mjs";

const require = createRequire(import.meta.url);
const electronBin = require("electron");
const app = resolve(dirname(electronBin), "../..");
const dir = mkdtempSync(join(tmpdir(), "landlens-fuses-"));
const copy = join(dir, "Electron.app");
execFileSync("cp", ["-Rc", app, copy]);
try {
  await hardenFuses(copy);
  const wire = await getCurrentFuseWire(copy);
  const want = (v) => (v ? 49 : 48); // '1' / '0'
  const bad = Object.entries(LANDLENS_FUSES)
    .filter(([k]) => k !== "version")
    .filter(([k, v]) => wire[k] !== want(v))
    .map(([k]) => FuseV1Options[k]);
  if (bad.length) throw new Error(`fuses not applied: ${bad.join(", ")}`);
  console.log(`fuses ok on ${copy}`);
  if (process.argv.includes("--keep")) console.log(copy);
  else rmSync(dir, { recursive: true, force: true });
} catch (err) {
  rmSync(dir, { recursive: true, force: true });
  throw err;
}
