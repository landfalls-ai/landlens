// Where the agent's tools come from. A Mac app started from the Dock gets a bare PATH (/usr/bin:/bin:…), so Landlens
// asks your login shell once for the PATH you use in a terminal: that is where kubectl and node live.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

let cached: Promise<string> | undefined;

/** Your login shell's PATH, with common tool folders appended. */
export function loginPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  cached ??= new Promise<string>((resolve) => {
    const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : "/bin/zsh";
    // -i -l: read the same files a terminal does; print only PATH, between markers, so rc-file noise is ignored.
    execFile(shell, ["-ilc", 'printf "__LANDLENS__%s__LANDLENS__" "$PATH"'], { timeout: 5000, env: { HOME: env.HOME ?? "", USER: env.USER ?? "", SHELL: shell, TERM: "dumb" } },
      (err, stdout) => {
        const m = /__LANDLENS__(.*?)__LANDLENS__/s.exec(stdout ?? "");
        const fromShell = !err && m ? m[1]!.split(delimiter) : [];
        resolve(uniq([...fromShell, ...(env.PATH ?? "").split(delimiter), ...FALLBACK_DIRS]).join(delimiter));
      });
  });
  return cached;
}

/** The first executable called `name` on `path`. */
export function which(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** claude-agent-acp's entry script, resolved from this package's own dependencies. */
export function claudeAdapterEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json")), "dist", "index.js");
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Variables Claude Code itself needs: who you are, where things are, locale, and how it reaches Anthropic. */
const AGENT_ENV = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "__CF_USER_TEXT_ENCODING",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  // Where your Claude Code keeps its login and which backend it uses. Not the variables a Claude Code session sets
  // for its own children (CLAUDECODE, CLAUDE_CODE_SESSION_ID, its messaging socket and token): Landlens started from
  // a Claude Code terminal must not hand that session's handles to the agent.
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
]);
const AGENT_ENV_PREFIXES = ["LC_", "ANTHROPIC_"];

/**
 * The environment for the Claude Code process: an allowlist, not Landlens's own environment. Claude Code hands its
 * environment to the agent's shell, so anything else here (cloud keys, tokens, KUBECONFIG) would be readable with `env`.
 * The Anthropic credentials it needs are hidden from the shell by the sandbox (fence.ts).
 */
export function agentEnv(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (AGENT_ENV.has(k) || AGENT_ENV_PREFIXES.some((p) => k.startsWith(p)))) out[k] = v;
  }
  return { ...out, ...extra };
}
