// What a front-door token may do. The IDE's token may do what the user's RBAC allows; an agent session's token
// may only read, never Secrets, never exec/attach/port-forward/proxy, optionally only in a few namespaces.
// The cluster's own RBAC still applies after this check: the policy can only narrow it.

export type Verb =
  | "get" | "list" | "watch" | "create" | "update" | "patch" | "delete" | "deletecollection" | "connect";

export type ParsedRequest =
  | { kind: "nonResource"; path: string; verb: Verb }
  | {
      kind: "resource";
      group: string;
      version: string;
      namespace?: string;
      resource: string;
      name?: string;
      subresource?: string;
      verb: Verb;
    };

export type Policy = {
  /** "full": anything the user's RBAC allows. "read": get/list/watch only. */
  access: "full" | "read";
  /** Resources this token may never touch, as `resource` or `resource.group` (e.g. "secrets"). */
  deniedResources?: string[];
  /** If set, namespaced requests must be in one of these namespaces, and all-namespace reads are refused. */
  namespaces?: string[];
  /**
   * Scrub every response before it reaches the caller (redact.ts): JSON objects, lists, tables and watch events, and
   * plain-text logs. Anything the front door can't scrub (protobuf, compressed or other bodies) is refused.
   */
  redact?: boolean;
};

export type Decision = { allow: true } | { allow: false; reason: string };

const READ_VERBS: ReadonlySet<Verb> = new Set(["get", "list", "watch"]);
/** Subresources that open a channel into a container or service: never for a read-only token. */
const CONNECT_SUBRESOURCES = new Set(["exec", "attach", "portforward", "proxy"]);
/** Reviews a read-only client may create: they only ask the API server a question. */
const REVIEW_RESOURCES = new Set([
  "selfsubjectaccessreviews.authorization.k8s.io",
  "selfsubjectrulesreviews.authorization.k8s.io",
  "selfsubjectreviews.authentication.k8s.io",
]);

const isTrue = (v: string | null) => v === "true" || v === "1";

/**
 * Refuse paths whose meaning could differ between this parser and the API server: empty segments, dot segments,
 * percent-encoding, backslashes, fragments, spaces or control characters. The front door rejects these outright.
 */
export function isCanonicalPath(rawPath: string): boolean {
  if (/[\x00-\x20\x7f#]/.test(rawPath)) return false;
  const path = rawPath.split("?")[0] ?? "";
  if (!path.startsWith("/")) return false;
  if (path.includes("//") || path.includes("\\")) return false;
  // Kubernetes names never need percent-encoding, so any in the path is refused.
  if (path.includes("%")) return false;
  return !path.split("/").some((s) => s === "." || s === "..");
}

/** Parse a Kubernetes API path (as sent to the API server) into what it touches and the verb. */
export function parseRequest(method: string, rawPath: string): ParsedRequest {
  const url = new URL(rawPath, "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const m = method.toUpperCase();
  const watchParam = isTrue(url.searchParams.get("watch"));

  let i = 0;
  let group = "";
  let version: string | undefined;
  if (parts[0] === "api" && parts.length >= 2) {
    version = parts[1];
    i = 2;
  } else if (parts[0] === "apis" && parts.length >= 3) {
    group = parts[1]!;
    version = parts[2];
    i = 3;
  }
  if (version === undefined || parts.length <= i) {
    return { kind: "nonResource", path: url.pathname, verb: nonResourceVerb(m) };
  }

  let watchPrefix = false;
  if (parts[i] === "watch") {
    watchPrefix = true; // deprecated /watch/ paths
    i++;
  }
  let namespace: string | undefined;
  if (parts[i] === "namespaces" && parts.length > i + 2) {
    namespace = parts[i + 1];
    i += 2;
  }
  const resource = parts[i];
  if (!resource) return { kind: "nonResource", path: url.pathname, verb: nonResourceVerb(m) };
  // GET /api/v1/namespaces/foo has too few parts for the namespace prefix above, so it lands here as the
  // namespace "foo" itself.
  const name = parts[i + 1];
  let subresource = parts[i + 2];
  if (parts.length > i + 3) subresource = parts.slice(i + 2).join("/"); // e.g. proxy/some/path

  const verb = resourceVerb(m, name, subresource, watchParam || watchPrefix);
  return { kind: "resource", group, version, namespace, resource, name, subresource, verb };
}

function nonResourceVerb(m: string): Verb {
  switch (m) {
    case "GET": case "HEAD": case "OPTIONS": return "get";
    case "POST": return "create";
    case "PUT": return "update";
    case "PATCH": return "patch";
    case "DELETE": return "delete";
    default: return "connect";
  }
}

function resourceVerb(m: string, name: string | undefined, sub: string | undefined, watch: boolean): Verb {
  const top = sub?.split("/")[0];
  if (top && CONNECT_SUBRESOURCES.has(top)) return "connect";
  switch (m) {
    case "GET": case "HEAD":
      if (watch) return "watch";
      return name ? "get" : "list";
    case "POST": return "create";
    case "PUT": return "update";
    case "PATCH": return "patch";
    case "DELETE": return name ? "delete" : "deletecollection";
    default: return "connect";
  }
}

export const key = (resource: string, group: string) => (group ? `${resource}.${group}` : resource);

/**
 * Non-resource paths a read-only token may GET: version, discovery, OpenAPI and health. Not /metrics, /logs (node
 * log files), /debug or anything else the API server or an aggregated API might serve.
 */
export function isReadableNonResource(path: string): boolean {
  if (["/version", "/api", "/apis", "/healthz", "/livez", "/readyz"].includes(path)) return true;
  if (/^\/(healthz|livez|readyz)\/[a-z0-9-]+$/.test(path)) return true;
  if (/^\/openapi\/v[23](\/.*)?$/.test(path)) return true;
  // Discovery under /api and /apis (/api/v1, /apis/apps, /apis/apps/v1) parses as non-resource.
  return /^\/apis?(\/[a-z0-9.-]+){1,2}$/.test(path);
}

/**
 * Whether a kind is namespaced, from the cluster's discovery: `true`, `false`, or `undefined` when not known.
 * Keys are `resource` or `resource.group`.
 */
export type ScopeOf = (key: string) => boolean | undefined;

/** Decide whether a token with this policy may make this request. */
export function authorize(policy: Policy, req: ParsedRequest, scopeOf: ScopeOf = () => undefined): Decision {
  if (req.kind === "nonResource") {
    if (policy.access === "full") return { allow: true };
    if (req.verb === "get" && isReadableNonResource(req.path)) return { allow: true };
    return { allow: false, reason: `read-only token: ${req.verb} on ${req.path} is not allowed` };
  }
  const k = key(req.resource, req.group);
  const top = req.subresource?.split("/")[0];

  if (policy.deniedResources?.some((d) => d === k || d === req.resource && !req.group)) {
    return { allow: false, reason: `this token may not access ${k}` };
  }
  if (policy.access === "read") {
    if (req.verb === "create" && REVIEW_RESOURCES.has(k)) return { allow: true };
    if (top && CONNECT_SUBRESOURCES.has(top)) {
      return { allow: false, reason: `read-only token: ${top} into ${k} is not allowed` };
    }
    if (!READ_VERBS.has(req.verb)) {
      return { allow: false, reason: `read-only token: ${req.verb} ${k} is not allowed; ask in Landlens to make changes` };
    }
  }
  if (policy.namespaces) {
    const clusterScopedRead = req.namespace === undefined && READ_VERBS.has(req.verb);
    if (req.namespace !== undefined && !policy.namespaces.includes(req.namespace)) {
      return { allow: false, reason: `this token is limited to namespaces ${policy.namespaces.join(", ")}` };
    }
    // Reading the namespaces themselves, or cluster-scoped kinds, is fine; listing a namespaced kind across all
    // namespaces is not. Scope comes from the cluster's discovery, else the built-in kinds; unknown is refused.
    if (clusterScopedRead) {
      const namespaced = scopeOf(k) ?? (CLUSTER_SCOPED_CORE.has(k) ? false : true);
      if (namespaced) {
        return { allow: false, reason: `this token is limited to namespaces ${policy.namespaces.join(", ")}` };
      }
    }
  }
  return { allow: true };
}

/** Built-in cluster-scoped kinds, for when discovery hasn't run; anything else counts as namespaced. */
const CLUSTER_SCOPED_CORE = new Set([
  "namespaces", "nodes", "persistentvolumes", "componentstatuses",
  "storageclasses.storage.k8s.io", "csidrivers.storage.k8s.io", "csinodes.storage.k8s.io", "volumeattachments.storage.k8s.io",
  "clusterroles.rbac.authorization.k8s.io", "clusterrolebindings.rbac.authorization.k8s.io",
  "customresourcedefinitions.apiextensions.k8s.io", "apiservices.apiregistration.k8s.io",
  "priorityclasses.scheduling.k8s.io", "runtimeclasses.node.k8s.io", "ingressclasses.networking.k8s.io",
  "mutatingwebhookconfigurations.admissionregistration.k8s.io", "validatingwebhookconfigurations.admissionregistration.k8s.io",
  "certificatesigningrequests.certificates.k8s.io", "flowschemas.flowcontrol.apiserver.k8s.io",
  "prioritylevelconfigurations.flowcontrol.apiserver.k8s.io",
]);

/** The policy every agent session gets. */
export const agentReadOnlyPolicy = (namespaces?: string[]): Policy => ({
  access: "read",
  deniedResources: ["secrets"],
  redact: true,
  ...(namespaces?.length ? { namespaces } : {}),
});
