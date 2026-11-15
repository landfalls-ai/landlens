// A loopback server that plays Google Cloud's three APIs for tests (spec D97). No test reaches Google: the app's
// LANDLENS_GCP_ENDPOINT points every API origin here, and it records every request (the bearer, X-Goog-User-Project),
// so a test can say where the token went.
//
//   Resource Manager  GET /v3/projects:search                         five active projects and one being deleted
//   Cloud Asset       GET /v1/projects/<id>:searchAllResources        pageSize, pageToken, readMask, query, assetTypes
//   Kubernetes Engine GET /v1/projects/<id>/locations/-/clusters
//
// demo-shop is a small, realistic shop (Compute, GKE, Cloud SQL, buckets, Pub/Sub, service accounts, Cloud Run, …);
// orbit-analytics has 1,200 resources (paging), archive-vault 6,000 (the 5,000 cut). Switches: `fail` per project
// (401, 403 SERVICE_DISABLED, 403, 429 …), `slowMs`, `redirect`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const GCP_TOKEN = "ya29.FakeTokenForLandlensTestsOnly_0123456789abcdefghijklmnop";
export const GCP_ACCOUNT = "person@example.com";

export type Recorded = { method: string; path: string; query: Record<string, string>; authorization?: string; userProject?: string };
export type Failure = { status: number; reason?: string; message?: string; api?: "cloudasset" | "container" | "cloudresourcemanager" };
type Asset = { name: string; assetType: string; displayName?: string; location?: string; state?: string; createTime?: string; updateTime?: string; parentFullResourceName?: string; labels?: Record<string, string>; resource?: unknown };

export const PROJECTS = [
  { projectId: "demo-shop", displayName: "Demo Shop", number: "482913570214", state: "ACTIVE" },
  { projectId: "orbit-analytics", displayName: "Orbit Analytics", number: "730284615592", state: "ACTIVE" },
  { projectId: "archive-vault", displayName: "Archive Vault", number: "915520038471", state: "ACTIVE" },
  { projectId: "payments-core", displayName: "Payments Core", number: "268401937752", state: "ACTIVE" },
  { projectId: "ml-sandbox-42", displayName: "ML Sandbox", number: "604118293305", state: "ACTIVE" },
  { projectId: "old-prototype", displayName: "Old prototype", number: "118204937110", state: "DELETE_REQUESTED" },
];

/** A small deterministic random, so the data is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const day = (n: number) => new Date(Date.UTC(2026, 0, 5) + n * 86_400_000).toISOString().replace(".000Z", "Z");

function demoShop(): Asset[] {
  const P = "demo-shop";
  const out: Asset[] = [];
  const add = (a: Asset) => out.push({ parentFullResourceName: `//cloudresourcemanager.googleapis.com/projects/${P}`, ...a });
  const env = (e: string) => ({ env: e, team: "shop", "managed-by": "terraform" });
  add({ name: `//cloudresourcemanager.googleapis.com/projects/${P}`, assetType: "cloudresourcemanager.googleapis.com/Project", displayName: "Demo Shop", location: "global", state: "ACTIVE", createTime: day(0), parentFullResourceName: "//cloudresourcemanager.googleapis.com/folders/310998001", resource: { projectNumber: "482913570214", projectId: P, lifecycleState: "ACTIVE", name: "Demo Shop" } });
  const vms: [string, string, string, string, string][] = [
    ["web-frontend-1", "us-central1-a", "e2-standard-4", "RUNNING", "prod"],
    ["web-frontend-2", "us-central1-b", "e2-standard-4", "RUNNING", "prod"],
    ["checkout-worker-1", "us-central1-a", "n2-standard-8", "RUNNING", "prod"],
    ["search-indexer", "us-central1-c", "n2-highmem-4", "RUNNING", "prod"],
    ["bastion", "us-central1-a", "e2-micro", "RUNNING", "ops"],
    ["staging-web-1", "europe-west1-b", "e2-standard-2", "RUNNING", "staging"],
    ["staging-worker-1", "europe-west1-b", "e2-standard-2", "TERMINATED", "staging"],
    ["load-test-runner", "us-east1-b", "c2-standard-16", "TERMINATED", "dev"],
    ["legacy-cron", "us-central1-f", "n1-standard-1", "STOPPING", "prod"],
  ];
  vms.forEach(([n, z, mt, st, e], i) => {
    add({
      name: `//compute.googleapis.com/projects/${P}/zones/${z}/instances/${n}`, assetType: "compute.googleapis.com/Instance", displayName: n, location: z, state: st,
      createTime: day(10 + i * 7), updateTime: day(200 + i), labels: env(e),
      resource: {
        id: String(7023411000000000000 + i * 7919), name: n, kind: "compute#instance", status: st, zone: `https://www.googleapis.com/compute/v1/projects/${P}/zones/${z}`,
        machineType: `https://www.googleapis.com/compute/v1/projects/${P}/zones/${z}/machineTypes/${mt}`, cpuPlatform: "Intel Cascade Lake",
        networkInterfaces: [{ name: "nic0", network: `https://www.googleapis.com/compute/v1/projects/${P}/global/networks/shop-vpc`, networkIP: `10.10.${i}.${10 + i}` }],
        disks: [{ boot: true, deviceName: n, diskSizeGb: "50", mode: "READ_WRITE", type: "PERSISTENT" }],
        metadata: { items: [{ key: "startup-script", value: "#!/bin/bash\nexport DB_PASSWORD=s3cr3t-Example-Only\nsystemctl start shop" }, { key: "enable-oslogin", value: "TRUE" }] },
        serviceAccounts: [{ email: `web-frontend@${P}.iam.gserviceaccount.com`, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }],
        labels: env(e), creationTimestamp: day(10 + i * 7), scheduling: { automaticRestart: true, onHostMaintenance: "MIGRATE" },
      },
    });
    add({ name: `//compute.googleapis.com/projects/${P}/zones/${z}/disks/${n}`, assetType: "compute.googleapis.com/Disk", displayName: n, location: z, state: "READY", createTime: day(10 + i * 7), labels: env(e), resource: { name: n, sizeGb: "50", type: "pd-balanced", status: "READY" } });
  });
  add({ name: `//compute.googleapis.com/projects/${P}/global/networks/shop-vpc`, assetType: "compute.googleapis.com/Network", displayName: "shop-vpc", location: "global", createTime: day(1), resource: { name: "shop-vpc", autoCreateSubnetworks: false, routingConfig: { routingMode: "REGIONAL" } } });
  for (const [r, cidr] of [["us-central1", "10.10.0.0/20"], ["europe-west1", "10.20.0.0/20"], ["us-east1", "10.30.0.0/20"]]) {
    add({ name: `//compute.googleapis.com/projects/${P}/regions/${r}/subnetworks/shop-${r}`, assetType: "compute.googleapis.com/Subnetwork", displayName: `shop-${r}`, location: r, createTime: day(2), resource: { name: `shop-${r}`, ipCidrRange: cidr, privateIpGoogleAccess: true } });
  }
  for (const f of ["allow-iap-ssh", "allow-health-checks", "allow-internal", "deny-all-egress-ops"]) {
    add({ name: `//compute.googleapis.com/projects/${P}/global/firewalls/${f}`, assetType: "compute.googleapis.com/Firewall", displayName: f, location: "global", createTime: day(3), resource: { name: f, direction: "INGRESS", priority: 1000 } });
  }
  add({ name: `//compute.googleapis.com/projects/${P}/global/addresses/shop-lb-ip`, assetType: "compute.googleapis.com/GlobalAddress", displayName: "shop-lb-ip", location: "global", state: "IN_USE", createTime: day(4), resource: { address: "34.120.18.77", status: "IN_USE" } });
  add({ name: `//compute.googleapis.com/projects/${P}/global/forwardingRules/shop-https`, assetType: "compute.googleapis.com/GlobalForwardingRule", displayName: "shop-https", location: "global", createTime: day(4), resource: { IPAddress: "34.120.18.77", portRange: "443-443", loadBalancingScheme: "EXTERNAL_MANAGED" } });
  for (const [c, loc, st] of [["shop-prod", "us-central1", "RUNNING"], ["shop-staging", "europe-west1-b", "RUNNING"], ["batch-jobs", "us-east1", "RECONCILING"]] as const) {
    add({
      name: `//container.googleapis.com/projects/${P}/locations/${loc}/clusters/${c}`, assetType: "container.googleapis.com/Cluster", displayName: c, location: loc, state: st, createTime: day(20), updateTime: day(310), labels: env(c === "shop-prod" ? "prod" : "staging"),
      resource: { name: c, location: loc, status: st, currentMasterVersion: "1.33.4-gke.1172000", currentNodeCount: c === "shop-prod" ? 6 : 3, releaseChannel: { channel: "REGULAR" }, network: "shop-vpc", privateClusterConfig: { enablePrivateNodes: true }, workloadIdentityConfig: { workloadPool: `${P}.svc.id.goog` } },
    });
    add({ name: `//container.googleapis.com/projects/${P}/locations/${loc}/clusters/${c}/nodePools/default-pool`, assetType: "container.googleapis.com/NodePool", displayName: "default-pool", location: loc, state: st, createTime: day(20), resource: { name: "default-pool", config: { machineType: "e2-standard-4", diskSizeGb: 100 }, autoscaling: { enabled: true, minNodeCount: 1, maxNodeCount: 6 } } });
  }
  for (const [db, ver, st, region] of [["orders-db", "POSTGRES_16", "RUNNABLE", "us-central1"], ["catalog-db", "POSTGRES_16", "RUNNABLE", "us-central1"], ["analytics-replica", "POSTGRES_16", "RUNNABLE", "us-east1"], ["legacy-mysql", "MYSQL_8_0", "SUSPENDED", "us-central1"]]) {
    add({ name: `//cloudsql.googleapis.com/projects/${P}/instances/${db}`, assetType: "sqladmin.googleapis.com/Instance", displayName: db, location: region, state: st, createTime: day(30), labels: env("prod"), resource: { name: db, databaseVersion: ver, state: st, region, settings: { tier: "db-custom-4-16384", availabilityType: "REGIONAL", backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true } } } });
  }
  for (const [b, loc] of [["demo-shop-assets", "US"], ["demo-shop-backups", "US-CENTRAL1"], ["demo-shop-terraform-state", "US"], ["demo-shop-logs-archive", "EU"], ["demo-shop-uploads", "US"]] as const) {
    add({ name: `//storage.googleapis.com/${b}`, assetType: "storage.googleapis.com/Bucket", displayName: b, location: loc.toLowerCase(), createTime: day(5), labels: env("prod"), resource: { name: b, location: loc, storageClass: "STANDARD", iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }, versioning: { enabled: b.includes("state") } } });
  }
  for (const t of ["orders", "payments", "inventory-updates", "email-outbox"]) {
    add({ name: `//pubsub.googleapis.com/projects/${P}/topics/${t}`, assetType: "pubsub.googleapis.com/Topic", displayName: t, location: "global", createTime: day(40), resource: { name: `projects/${P}/topics/${t}`, messageRetentionDuration: "604800s" } });
    add({ name: `//pubsub.googleapis.com/projects/${P}/subscriptions/${t}-worker`, assetType: "pubsub.googleapis.com/Subscription", displayName: `${t}-worker`, location: "global", state: "ACTIVE", createTime: day(40), resource: { name: `projects/${P}/subscriptions/${t}-worker`, topic: `projects/${P}/topics/${t}`, ackDeadlineSeconds: 60 } });
  }
  [["web-frontend", "Web frontend"], ["checkout-worker", "Checkout worker"], ["ci-deployer", "CI deployer (GitHub Actions)"], ["sql-proxy", "Cloud SQL proxy"], ["backup-runner", "Nightly backups"]].forEach(([sa, dn], i) => {
    add({ name: `//iam.googleapis.com/projects/${P}/serviceAccounts/10${4820135 + i * 113}9283746${i}`, assetType: "iam.googleapis.com/ServiceAccount", displayName: dn, location: "global", createTime: day(6 + i), resource: { email: `${sa}@${P}.iam.gserviceaccount.com`, displayName: dn, disabled: false } });
  });
  for (const [s, st] of [["checkout-api", "ACTIVE"], ["image-resizer", "ACTIVE"], ["webhooks", "ACTIVE"]]) {
    add({ name: `//run.googleapis.com/projects/${P}/locations/us-central1/services/${s}`, assetType: "run.googleapis.com/Service", displayName: s, location: "us-central1", state: st, createTime: day(90), labels: env("prod"), resource: { apiVersion: "serving.knative.dev/v1", kind: "Service", metadata: { name: s }, spec: { template: { spec: { containers: [{ image: `us-docker.pkg.dev/${P}/shop/${s}:1.8.2`, env: [{ name: "STRIPE_KEY", value: "example-not-a-real-key" }] }] } } } } });
  }
  for (const s of ["stripe-api-key", "sendgrid-token", "orders-db-password"]) {
    add({ name: `//secretmanager.googleapis.com/projects/${P}/secrets/${s}`, assetType: "secretmanager.googleapis.com/Secret", displayName: s, location: "global", createTime: day(50), resource: { name: `projects/${P}/secrets/${s}`, replication: { automatic: {} } } });
  }
  for (const d of ["shop_events", "finance_reporting"]) {
    add({ name: `//bigquery.googleapis.com/projects/${P}/datasets/${d}`, assetType: "bigquery.googleapis.com/Dataset", displayName: d, location: "US", createTime: day(60), resource: { datasetReference: { datasetId: d, projectId: P }, location: "US" } });
    for (const t of ["orders", "sessions"]) add({ name: `//bigquery.googleapis.com/projects/${P}/datasets/${d}/tables/${t}`, assetType: "bigquery.googleapis.com/Table", displayName: t, location: "US", createTime: day(61), resource: { tableReference: { tableId: t }, numRows: "1832291" } });
  }
  add({ name: `//artifactregistry.googleapis.com/projects/${P}/locations/us/repositories/shop`, assetType: "artifactregistry.googleapis.com/Repository", displayName: "shop", location: "us", createTime: day(8), resource: { format: "DOCKER", mode: "STANDARD_REPOSITORY" } });
  add({ name: `//dns.googleapis.com/projects/${P}/managedZones/shop-example-com`, assetType: "dns.googleapis.com/ManagedZone", displayName: "shop-example-com", location: "global", createTime: day(9), resource: { dnsName: "shop.example.com.", visibility: "public" } });
  add({ name: `//cloudkms.googleapis.com/projects/${P}/locations/us/keyRings/shop`, assetType: "cloudkms.googleapis.com/KeyRing", displayName: "shop", location: "us", createTime: day(9), resource: {} });
  add({ name: `//cloudkms.googleapis.com/projects/${P}/locations/us/keyRings/shop/cryptoKeys/sql-cmek`, assetType: "cloudkms.googleapis.com/CryptoKey", displayName: "sql-cmek", location: "us", createTime: day(9), resource: { purpose: "ENCRYPT_DECRYPT", rotationPeriod: "7776000s" } });
  return out;
}

/** A big project of `n` resources across common types, for paging and the cut. */
function many(P: string, n: number, seed: number): Asset[] {
  const r = rng(seed);
  const kinds: [string, (i: number) => string, string[]][] = [
    ["compute.googleapis.com/Instance", (i) => `//compute.googleapis.com/projects/${P}/zones/us-central1-a/instances/worker-${i}`, ["RUNNING", "TERMINATED"]],
    ["compute.googleapis.com/Disk", (i) => `//compute.googleapis.com/projects/${P}/zones/us-central1-a/disks/data-${i}`, ["READY"]],
    ["storage.googleapis.com/Bucket", (i) => `//storage.googleapis.com/${P}-shard-${i}`, [""]],
    ["pubsub.googleapis.com/Topic", (i) => `//pubsub.googleapis.com/projects/${P}/topics/events-${i}`, [""]],
    ["bigquery.googleapis.com/Table", (i) => `//bigquery.googleapis.com/projects/${P}/datasets/raw/tables/t_${i}`, [""]],
    ["iam.googleapis.com/ServiceAccount", (i) => `//iam.googleapis.com/projects/${P}/serviceAccounts/${100000000 + i}`, [""]],
  ];
  return Array.from({ length: n }, (_, i) => {
    const [type, name, states] = kinds[Math.floor(r() * kinds.length)]!;
    const st = states[Math.floor(r() * states.length)]!;
    const nm = name(i);
    return { name: nm, assetType: type, displayName: nm.split("/").at(-1), location: "us-central1", ...(st ? { state: st } : {}), createTime: day(Math.floor(r() * 300)), resource: { name: nm.split("/").at(-1), index: i } };
  });
}

function smallProject(P: string): Asset[] {
  return [
    { name: `//compute.googleapis.com/projects/${P}/zones/us-west1-a/instances/notebook-1`, assetType: "compute.googleapis.com/Instance", displayName: "notebook-1", location: "us-west1-a", state: "RUNNING", createTime: day(100), resource: { name: "notebook-1", status: "RUNNING" } },
    { name: `//storage.googleapis.com/${P}-datasets`, assetType: "storage.googleapis.com/Bucket", displayName: `${P}-datasets`, location: "us", createTime: day(101), resource: { name: `${P}-datasets` } },
    { name: `//iam.googleapis.com/projects/${P}/serviceAccounts/2049`, assetType: "iam.googleapis.com/ServiceAccount", displayName: "Training jobs", location: "global", createTime: day(102), resource: { email: `trainer@${P}.iam.gserviceaccount.com` } },
  ];
}

// The addresses are documentation ranges (RFC 5737): nothing real answers there, and no test connects to them.
const CLUSTERS: Record<string, unknown[]> = {
  "demo-shop": [
    { name: "shop-prod", location: "us-central1", status: "RUNNING", currentMasterVersion: "1.33.4-gke.1172000", endpoint: "203.0.113.17", masterAuth: { clusterCaCertificate: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t" } },
    { name: "shop-staging", location: "europe-west1-b", status: "RUNNING", currentMasterVersion: "1.32.9-gke.1051000", endpoint: "198.51.100.90", masterAuth: { clusterCaCertificate: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t" } },
    { name: "batch-jobs", location: "us-east1", status: "RECONCILING", currentMasterVersion: "1.33.4-gke.1172000", endpoint: "", controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: "gke-0a1b2c3d4e-batch.us-east1.gke.goog" } } },
  ],
};

export class FakeGcp {
  readonly requests: Recorded[] = [];
  readonly valid = new Set([GCP_TOKEN]);
  /** A failure per project id ("*projects" for projects:search), optionally only for one API. */
  readonly fail = new Map<string, Failure>();
  slowMs = 0;
  /** Answer every request with a 307 to this address. */
  redirect?: string;
  /** GKE clusters per project, in place of the built-in ones (the GKE e2e points one at OrbStack). */
  readonly clusters = new Map<string, unknown[]>();
  /** Projects to a page in projects:search (paging). */
  projectsPageSize = 500;
  private readonly data = new Map<string, Asset[]>([
    ["demo-shop", demoShop()],
    ["orbit-analytics", many("orbit-analytics", 1200, 7)],
    ["archive-vault", many("archive-vault", 6000, 11)],
    ["payments-core", smallProject("payments-core")],
    ["ml-sandbox-42", smallProject("ml-sandbox-42")],
  ]);
  private server!: Server;
  origin = "";

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => res.writeHead(500).end()));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  assets(project: string): Asset[] {
    return this.data.get(project) ?? [];
  }
  /** Requests that reached a path containing `part`. */
  hits(part: string) {
    return this.requests.filter((r) => r.path.includes(part));
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private failure(res: ServerResponse, f: Failure) {
    const status = f.status === 429 ? "RESOURCE_EXHAUSTED" : f.status === 401 ? "UNAUTHENTICATED" : f.status === 403 ? "PERMISSION_DENIED" : "UNKNOWN";
    this.send(res, f.status, {
      error: {
        code: f.status, status,
        message: f.message ?? `Request failed (${status}).`,
        details: f.reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: f.reason, domain: "googleapis.com", metadata: { service: `${f.api ?? "cloudasset"}.googleapis.com` } }] : [],
      },
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.origin);
    const auth = req.headers.authorization;
    const userProject = req.headers["x-goog-user-project"];
    this.requests.push({ method: req.method ?? "", path: url.pathname, query: Object.fromEntries(url.searchParams), ...(auth ? { authorization: auth } : {}), ...(typeof userProject === "string" ? { userProject } : {}) });
    if (this.slowMs) await new Promise((r) => setTimeout(r, this.slowMs));
    if (this.redirect) return res.writeHead(307, { Location: this.redirect }).end();
    if (req.method !== "GET") return this.send(res, 405, { error: { code: 405 } });
    const bearer = /^Bearer (.+)$/.exec(auth ?? "")?.[1];
    if (!bearer || !this.valid.has(bearer)) return this.failure(res, { status: 401 });

    if (url.pathname === "/v3/projects:search") {
      const f = this.fail.get("*projects");
      if (f) return this.failure(res, { api: "cloudresourcemanager", ...f });
      const from = Number(url.searchParams.get("pageToken") || 0);
      const size = Math.min(Number(url.searchParams.get("pageSize") || 50), this.projectsPageSize);
      const page = PROJECTS.slice(from, from + size).map((p) => ({ name: `projects/${p.number}`, parent: "folders/310998001", projectId: p.projectId, state: p.state, displayName: p.displayName, createTime: day(0), etag: "W/\"x\"" }));
      return this.send(res, 200, { projects: page, ...(from + size < PROJECTS.length ? { nextPageToken: String(from + size) } : {}) });
    }
    const asset = /^\/v1\/projects\/([^/:]+):searchAllResources$/.exec(url.pathname);
    if (asset) return this.search(res, asset[1]!, url.searchParams);
    const gke = /^\/v1\/projects\/([^/]+)\/locations\/-\/clusters$/.exec(url.pathname);
    if (gke) {
      const f = this.fail.get(gke[1]!);
      if (f && (!f.api || f.api === "container")) return this.failure(res, { api: "container", ...f });
      return this.send(res, 200, { clusters: this.clusters.get(gke[1]!) ?? CLUSTERS[gke[1]!] ?? [] });
    }
    this.send(res, 404, { error: { code: 404, status: "NOT_FOUND", message: "Not found" } });
  }

  private search(res: ServerResponse, project: string, q: URLSearchParams) {
    const f = this.fail.get(project);
    if (f && (!f.api || f.api === "cloudasset")) return this.failure(res, { api: "cloudasset", ...f });
    if (!this.data.has(project)) return this.failure(res, { status: 403, message: `The caller does not have permission on projects/${project}` });
    let list = this.assets(project);
    const types = q.get("assetTypes");
    if (types) list = list.filter((a) => types.split(",").includes(a.assetType));
    const query = q.get("query");
    if (query) {
      const exact = /^name="(.+)"$/.exec(query);
      const field = /^(state|location|assetType)[:=](.+)$/.exec(query);
      list = exact ? list.filter((a) => a.name === exact[1])
        : field ? list.filter((a) => String(a[field[1] as "state"] ?? "").toLowerCase().includes(field[2]!.toLowerCase()))
        : list.filter((a) => `${a.name} ${a.displayName ?? ""} ${Object.values(a.labels ?? {}).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
    }
    const mask = new Set((q.get("readMask") ?? "name,assetType,displayName,location,state,labels").split(","));
    const size = Math.min(Number(q.get("pageSize") || 100), 500);
    const from = Number(q.get("pageToken") || 0);
    const results = list.slice(from, from + size).map((a) => {
      const out: Record<string, unknown> = {};
      for (const k of ["name", "assetType", "displayName", "location", "state", "createTime", "updateTime", "parentFullResourceName", "labels"] as const) {
        if (mask.has(k) && a[k] !== undefined) out[k] = a[k];
      }
      out.project = `projects/${PROJECTS.find((p) => p.projectId === project)?.number ?? "0"}`;
      if (mask.has("versionedResources") && a.resource !== undefined) out.versionedResources = [{ version: "v1", resource: a.resource }];
      return out;
    });
    this.send(res, 200, { results, ...(from + size < list.length ? { nextPageToken: String(from + size) } : {}) });
  }
}
