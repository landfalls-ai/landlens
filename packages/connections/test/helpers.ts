import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Crypto } from "../src/store.js";

/** A stand-in for safeStorage: reversible, and the plain text never appears in its output. */
export const fakeCrypto = (available = true): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(Buffer.from(s).toString("base64").split("").reverse().join("") + "#enc"),
  decryptString: (b) => Buffer.from(b.toString().replace(/#enc$/, "").split("").reverse().join(""), "base64").toString(),
});

export const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), "landlens-conn-")), name);

/** Dummy test fixtures, shaped like the real things. */
export const GH_TOKEN = `ghp_${"T".repeat(36)}`;
export const LIN_KEY = `lin_api_${"K".repeat(40)}`;
