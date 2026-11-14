// Clickland's address and API key, kept in userData/clickland.json. The key is encrypted with Electron's safeStorage
// (the macOS Keychain holds the encryption key) and is read only here, in main: no channel ever returns it. The key
// belongs to the origin it was saved with: saving another origin without typing the key again drops it.
import type { ClicklandSettings } from "@landlens/contracts";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const DEFAULT_CLICKLAND_URL = "http://127.0.0.1:4710";

const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

/** The part of Electron's safeStorage this needs (a fake in tests). */
export type Crypto = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

type Stored = { url?: string; key?: string; clusters?: Record<string, string> };

export class ClicklandSettingsStore {
  constructor(private readonly path: string, private readonly crypto: Crypto) {}

  private read(): Stored {
    if (!existsSync(this.path)) return {};
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8"));
      return s && typeof s === "object" ? s : {};
    } catch {
      return {};
    }
  }

  private write(s: Stored) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  /** What the renderer may know: the address, whether a key is stored, and the cluster name for a context. */
  view(context?: string): ClicklandSettings {
    const s = this.read();
    return {
      url: s.url ?? DEFAULT_CLICKLAND_URL,
      hasKey: !!s.key,
      canStore: this.crypto.isEncryptionAvailable(),
      ...(context ? { cluster: s.clusters?.[context] ?? context } : {}),
    };
  }

  /** Main only: the address and the decrypted key, if one is stored and decrypts. */
  config(): { url: string; key: string } | undefined {
    const s = this.read();
    if (!s.key || !this.crypto.isEncryptionAvailable()) return undefined;
    try {
      return { url: s.url ?? DEFAULT_CLICKLAND_URL, key: this.crypto.decryptString(Buffer.from(s.key, "base64")) };
    } catch {
      return undefined;
    }
  }

  clusterName(context: string): string {
    return this.read().clusters?.[context] ?? context;
  }

  set(input: { url: string; key?: string; cluster?: { context: string; name: string } }, context?: string): ClicklandSettings {
    const s = this.read();
    const moved = origin(input.url) !== origin(s.url ?? DEFAULT_CLICKLAND_URL);
    s.url = input.url;
    if (input.key === undefined && moved) delete s.key; // a stored key never follows the address to another origin
    if (input.key !== undefined) {
      if (!this.crypto.isEncryptionAvailable()) throw Object.assign(new Error("This machine can't encrypt the key (safeStorage is unavailable), so Landlens won't store it."), { status: 409 });
      s.key = this.crypto.encryptString(input.key).toString("base64");
    }
    if (input.cluster) {
      const clusters = { ...(s.clusters ?? {}) };
      if (input.cluster.name === input.cluster.context) delete clusters[input.cluster.context];
      else clusters[input.cluster.context] = input.cluster.name;
      s.clusters = clusters;
    }
    this.write(s);
    return this.view(context ?? input.cluster?.context);
  }

  /** Main only: the origin the stored key was saved for. */
  keyOrigin(): string | undefined {
    const s = this.read();
    return s.key ? origin(s.url ?? DEFAULT_CLICKLAND_URL) : undefined;
  }

  /** Forget the key (the address and cluster names stay). */
  clear(): ClicklandSettings {
    const { key: _drop, ...rest } = this.read();
    this.write(rest);
    return this.view();
  }
}
