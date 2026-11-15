// What keeps an agent session inside Landlens's fence, passed to Claude Code through `_meta.claudeCode.options` on
// session/new (the adapter hands these to the Claude Agent SDK as query options).
//
// 1. Nothing of yours runs beside it: no settings files, plugins, hooks or MCP servers of your own (they would run
//    outside the sandbox), only Landlens's MCP gateway (its cluster tools, and the remote servers you turned on for
//    the cluster, proxied and logged in main), and only the built-in tools in AGENT_TOOLS (no web tools).
// 2. Its KUBECONFIG names only the front door, with the session's read-only token in an environment variable.
// 3. Its Bash runs in Claude Code's sandbox: it can read nothing in your home folder but the session's own folder and
//    the tool folders on PATH, nor any kubeconfig of yours; it can't run unsandboxed, can write only to the session
//    folder (not its kubeconfig), and can connect to one local port: the front door's. (The sandbox opens exactly one
//    loopback port for an external proxy; naming the front door as both the HTTP and the SOCKS proxy is how kubectl
//    reaches it, and why anything else that tries the network reaches only the front door, which refuses it.)
// 4. Its file tools can't read outside the session folder at all (blockReadsOutsideWorkingDirectories).
// 5. Permission rules refuse the obvious ways to write with kubectl or Helm and let Landlens's read-only cluster tools,
//    and proxied tools that say they only read, run without a prompt; any other MCP tool asks. The kubectl rules
//    match command prefixes only, so they are a courtesy, not the control.
// The front door then refuses writes, Secrets and exec for that token, and scrubs what it returns, whatever gets through.

/** The MCP server name Landlens registers its cluster tools under (kube-mcp's MCP_SERVER_NAME). */
const MCP_SERVER = "landlens-kube";

/** Folders and files holding credentials the agent must never read, relative to your home folder. */
export const CREDENTIAL_PATHS = [
  ".kube", ".aws", ".azure", ".config/gcloud", ".config/gh", ".config/helm", ".docker", ".orbstack", ".ssh", ".gnupg",
  ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".terraform.d", ".vault-token", ".talos", ".minikube", ".kind",
];

/** kubectl subcommands that change a cluster or open a channel into it. */
export const KUBECTL_WRITES = [
  "apply", "create", "delete", "edit", "patch", "replace", "scale", "autoscale", "rollout restart", "rollout undo",
  "rollout pause", "rollout resume", "set", "label", "annotate", "taint", "cordon", "uncordon", "drain", "expose", "run",
  "exec", "attach", "cp", "port-forward", "proxy", "debug", "certificate", "auth reconcile",
];

/** The built-in tools a session has: read and search its folder, run its shell, keep a plan. No web, no edits. */
export const AGENT_TOOLS = ["Bash", "Read", "Grep", "Glob", "TodoWrite", "ExitPlanMode"];
/** Named again as disallowed, in case a tool list is ever widened. */
export const AGENT_DISALLOWED = ["WebFetch", "WebSearch", "Edit", "Write", "NotebookEdit"];
/** Anthropic credentials Claude Code needs and its shell must not see. */
export const HIDDEN_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

export type FenceInput = {
  /** Your home folder. */
  home: string;
  /** The session's own working folder. */
  cwd: string;
  /** The tool kubeconfig in that folder (front door only). */
  kubeconfig: string;
  /** The session's read-only front-door token. */
  token: string;
  /** PATH for the agent's shell, so it finds kubectl. */
  path: string;
  /** The front door's port on 127.0.0.1: the one local port the sandbox lets the agent's shell reach. */
  frontDoorPort: number;
  /** Your kubeconfig files ($KUBECONFIG), wherever they are; ~/.kube/config is covered by the home folder. */
  userKubeconfigs?: string[];
  /** Proxied MCP tools that only read (`mcp__<server>__<tool>`), from the gateway. */
  mcpAllow?: string[];
  /**
   * A plugin Landlens built in the session folder holding only the skills you chose (skills.ts): loaded by path, so
   * it needs none of your settings, and it holds no hooks or MCP servers. With it the session gets the Skill tool.
   */
  skillsPlugin?: string;
};

/** A proxied tool rule: one named tool on one remote server, never a whole server, never Landlens's own names. */
const MCP_RULE = /^mcp__(?!landlens)[a-z][a-z0-9-]{0,30}[a-z0-9]__[A-Za-z0-9_-]{1,64}$/;

export function sessionOptions(i: FenceInput) {
  const home = i.home.replace(/\/+$/, "");
  const credentials = CREDENTIAL_PATHS.map((p) => `${home}/${p}`);
  const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  // Tool folders on PATH under your home (nvm's node, ~/.local/bin) stay readable, unless they hold credentials
  // (~/.orbstack/bin): kubectl is found in the next PATH folder instead.
  const path = i.path.split(":").filter((d) => d && !credentials.some((c) => inside(d, c)));
  const toolDirs = path.filter((d) => inside(d, home));
  const kubeconfigs = (i.userKubeconfigs ?? []).filter((k) => k.startsWith("/"));
  return {
    // Nothing of yours loads: settings, CLAUDE.md, hooks, plugins, skills and MCP servers from ~/.claude or a project.
    // Skills you chose come in Landlens's own plugin, by path.
    settingSources: [] as string[],
    strictMcpConfig: true,
    tools: i.skillsPlugin && inside(i.skillsPlugin, i.cwd) ? [...AGENT_TOOLS, "Skill"] : AGENT_TOOLS,
    ...(i.skillsPlugin && inside(i.skillsPlugin, i.cwd) ? { plugins: [{ type: "local" as const, path: i.skillsPlugin }] } : {}),
    disallowedTools: AGENT_DISALLOWED,
    env: {
      KUBECONFIG: i.kubeconfig,
      KUBECACHEDIR: `${i.cwd}/kube-cache`,
      LANDLENS_TOKEN: i.token,
      PATH: path.join(":"),
      // Helm and friends follow KUBECONFIG; make sure nothing falls back to an in-cluster or cached config.
      KUBERNETES_SERVICE_HOST: "",
      KUBERNETES_SERVICE_PORT: "",
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true, // reads inside the sandbox run without a prompt; the fence holds regardless
      allowUnsandboxedCommands: false, // no dangerouslyDisableSandbox escape
      filesystem: {
        // Other terminals' devices too: the shell could otherwise open a local terminal's pty and race it for the keys
        // you type (security review, wave 4 part 1, finding 11; writing to one is already refused).
        denyRead: [home, ...credentials, ...kubeconfigs, "/dev/ttys*"],
        allowRead: [i.cwd, ...toolDirs],
        allowWrite: [i.cwd],
        // The skills plugin is Landlens's, built before the session starts: the agent can read it, not change it.
        denyWrite: [i.kubeconfig, `${i.cwd}/.landlens`],
      },
      network: { httpProxyPort: i.frontDoorPort, socksProxyPort: i.frontDoorPort, allowLocalBinding: false, strictAllowlist: true },
      credentials: { envVars: HIDDEN_ENV.map((name) => ({ name, mode: "deny" as const })) },
    },
    settings: {
      permissions: {
        // Landlens's own cluster tools are read-only and go through the front door: no prompt for each one. A proxied
        // tool runs without one only if its server says it only reads; the rest ask, and the dock shows the ask.
        allow: [`mcp__${MCP_SERVER}`, ...(i.mcpAllow ?? []).filter((r) => MCP_RULE.test(r))],
        deny: [
          ...CREDENTIAL_PATHS.flatMap((p) => [`Read(~/${p})`, `Read(~/${p}/**)`, `Edit(~/${p}/**)`]),
          ...kubeconfigs.map((k) => `Read(/${k})`),
          `Edit(/${i.kubeconfig})`,
          `Edit(/${i.cwd}/.landlens/**)`,
          ...KUBECTL_WRITES.map((v) => `Bash(kubectl ${v}:*)`),
          "Bash(kubectl --kubeconfig:*)", "Bash(kubectl --context:*)", "Bash(kubectl --token:*)", "Bash(kubectl --as:*)",
          "Bash(helm install:*)", "Bash(helm upgrade:*)", "Bash(helm uninstall:*)", "Bash(helm rollback:*)",
        ],
        blockReadsOutsideWorkingDirectories: true,
        disableBypassPermissionsMode: "disable",
      },
    },
    allowDangerouslySkipPermissions: false,
  };
}

export type SessionOptions = ReturnType<typeof sessionOptions>;
