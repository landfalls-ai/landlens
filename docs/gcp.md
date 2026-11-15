# Google Cloud

Landlens browses the resources of the Google Cloud projects you choose, read-only, as you: it borrows gcloud's own
sign-in and stores no Google credential. Wave 6 part 4, built 15 November 2026 (the spec's D85–D90, D92 and the fake
of D97). Part 5, not yet built, adds GKE clusters to the catalog (D91), read-only Google Cloud tools for Claude
(D93) and **Ask Claude** in the drawer (D94). The security rules are in
[security.md](security.md#connections-and-google-cloud); GitHub and Linear are in [connections.md](connections.md).

## Signing in: gcloud's, not Landlens's

Landlens finds `gcloud` on your login shell's PATH (`which("gcloud", await loginPath())`, the helpers the agent host
uses to find Claude Code) and runs two commands, with `execFile` at that absolute path, a 10 s limit, and only `HOME`,
`PATH` (the login PATH) and `CLOUDSDK_*` in its environment, so none of Landlens's own variables reach it:

- `gcloud config get-value account`: the account, which must look like an email (at most 254 characters). None means
  signed out.
- `gcloud auth print-access-token --account=<account>`: an access token for your user account (not Application
  Default Credentials, which need a quota project and a second sign-in), accepted only if it matches
  `^[A-Za-z0-9._-]{20,4096}$`. Main keeps it in memory for 5 minutes, asks once when several reads want it at the same
  moment, and drops it on any 401 (then asks gcloud again once for that request).

Landlens never runs `gcloud auth login` itself: the page tells you to. The token never reaches the renderer, the
agent, a file or a log line: it is added to requests in main, the log's raw errors cut every bearer and `ya29.` token
(and the exact token held), and the page gets only the account, the chosen ids and sentences.

The states (`GcpStatus.state`), each a `.notice` with its one next step on the page and on the card:

| State | What you see |
|---|---|
| `off-dev` | "Off in development builds": an unpackaged Landlens with no override (below) |
| `missing` | "Install the Google Cloud CLI, then run `gcloud auth login`.", with **Install guide**, **Copy** and **Check again** |
| `signed-out` | "gcloud isn't signed in. Run `gcloud auth login`.", with **Copy** and **Check again** |
| `ready` | the account; then "Choose the projects to browse" until you have chosen some |

The account is asked of gcloud once a minute at most; **Check again** asks at once.

## What is kept

`userData/gcp.json` (mode 0600, written through a temp file and a rename) holds the project ids you chose (at most 20)
and `agentRead` (for part 5's tools; nothing sets it yet). Nothing else: no token, account or resource. In memory,
main keeps the project list for 5 minutes and each project's resources for 60 s, and **Read again** reads at once.

## What Landlens asks Google

Only GETs, to three origins (`packages/gcp/src/client.ts`), each with `Authorization: Bearer <token>`,
`redirect: "error"`, a 15 s limit and a streamed cap of 8 MB a page. Requests about a project carry
`X-Goog-User-Project: <that project>`, so they are billed to it rather than to gcloud's own client project, which has
most APIs off; the project search carries none.

| What | Call | Limits |
|---|---|---|
| Projects | `cloudresourcemanager.googleapis.com/v3/projects:search`, `pageSize=500` | only `ACTIVE`; at most 2,000; cached 5 minutes |
| A project's resources | `cloudasset.googleapis.com/v1/projects/<id>:searchAllResources`, `pageSize=500`, `readMask=name,assetType,displayName,location,state,createTime,updateTime,parentFullResourceName,labels` | at most 10 pages (5,000 resources), then cut; cached 60 s; one read of a project at a time, two projects at once |
| A query | the same call with your text as `query` | the same limits; at most 10 queries kept, 60 s each |
| One resource | the same call with `query=name="<name>"`, `pageSize=1`, `readMask` plus `versionedResources` | the JSON shown is cut at 256 KB |
| GKE clusters | `container.googleapis.com/v1/projects/<id>/locations/-/clusters` | at most 200 a project; listed in main for part 5, not shown yet |

Cloud Asset has no count call for a search, so the types and their counts are made in main from the cached pages: one
read of a project gives its types, counts and every page of its rows. Main reads only the projects you chose: any
other is refused before a request leaves ("Choose <project> on the Google Cloud page first.").

Names are checked before they go into a path or a query (`packages/contracts`): a project id
`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`; an asset type `<host>/<Kind>`; a resource name starting `//`, at most 1,000
characters, with no `"`, `\` or control character; a query one line of at most 500 characters, sent as it is (it is
a read, as you). What comes back is cut too: every string to 300 characters with control and format characters
removed, at most 20 labels a resource.

The search fields and `versionedResources` were checked against Google's documentation and the fake only.
`versionedResources` holds the resource's own JSON for the common types; where Google returns none, the JSON tab says
so and the summary still shows the search fields.

## Errors are fixed sentences

From the HTTP status and the error's `status` and `reason` only (`packages/gcp/src/errors.ts`), never Google's text,
which can echo anything. The raw error (the status and reasons) goes to main's log with credentials cut.

| Answer | Sentence |
|---|---|
| 401 | Google didn't accept gcloud's sign-in. Run `gcloud auth login`. |
| 403 `SERVICE_DISABLED` | The Cloud Asset API is off in <project>. Turn it on: `gcloud services enable cloudasset.googleapis.com --project <project>`. (and the same for Kubernetes Engine and Cloud Resource Manager) |
| 403 otherwise | Your account can't list resources in <project> (it needs Cloud Asset Viewer). / …can't list GKE clusters in <project> (it needs Kubernetes Engine Cluster Viewer). |
| 429 | Google is limiting requests. Try again in a minute. |
| 404 | Google found nothing for <project> (404). |
| no answer | Google didn't answer in time. / Google's address doesn't resolve. Check your network. / Google's TLS certificate wasn't accepted. / Couldn't reach Google. |
| other | Google redirected; Landlens doesn't follow redirects. / Google's answer was larger than Landlens reads (8 MB). / Google's answer wasn't what Landlens expected. |

A project that fails shows its sentence in the Types column; the other projects still load.

## The page

**Google Cloud** in the sidebar's **Cloud** section (after Pinned, `Cloud` icon), in ⌘K, and on Welcome ("Google
Cloud — every resource of your projects, read-only"), where it works with no cluster connected and a **Clusters**
button goes back (`GcpPage.tsx`, `gcp.css`).

- **Projects** (240 px): the chosen ones with their names, a filter, and **Choose projects…**, a checklist of every
  active project your account can see (with its own filter; at most 20).
- **Types** (260 px): **All** and the project's asset types grouped by service (Compute Engine, Kubernetes Engine,
  Cloud Storage, Cloud SQL, Cloud Run, IAM, Pub/Sub, BigQuery, …, by the type's host), each with its count; "Counted
  from the first 5,000." when cut; **Read again**.
- **Resources**: the list table (name, type, location, state, created; the type column goes when a type is picked), a
  filter over the rows already read, and Enter sends the text as a Cloud Asset query instead (a chip shows it, with
  a button to clear it). "Showing the first 5,000." when cut. 1,200 resources come in pages of 500, read once.
- A row opens the drawer: the name, a type chip, the location and state; **Copy name**; tabs **Summary** (full name,
  type, service, location, state, created and updated, parent, labels) and **JSON** (the resource's own JSON,
  read-only, in the YAML editor's well). Esc closes it.
- Narrower main panes keep the table usable: under 1,100 px the projects become a select above the types; under
  720 px (a small window with the drawer open) the types become a select too, grouped by service.
- ⌘K: "Google Cloud" opens the page; once a project is read, its resources are a "Google Cloud" group, by name, from
  the rows already read (no new read).
- On the Connections page, a **Google Cloud** card after GitHub and Linear: the state, the account, the chosen
  projects as chips, **Choose projects…** and **Open Google Cloud**.

## Development and tests

An unpackaged build has Google Cloud off unless one of these is set (a packaged app reads none of them):

| Variable | What |
|---|---|
| `LANDLENS_GCP_ENDPOINT` | `http://127.0.0.1:<port>`: all three Google origins become this loopback fake; anything else is ignored |
| `LANDLENS_GCLOUD` | an absolute path to the gcloud to run (the tests' fake); otherwise gcloud is looked up on the login PATH |
| `LANDLENS_GCP_REAL=1` | lets an unpackaged build reach the real Google Cloud with your gcloud. Only the person sets this, to try their own project; no test, script or agent does |

The fakes, in `packages/gcp/test`:

- `fake-gcp.ts`: one loopback server for the three APIs. Five active projects (demo-shop with 73 resources over 23
  types, orbit-analytics with 1,200, archive-vault with 6,000, payments-core, ml-sandbox-42) and one being deleted;
  `query`, `assetTypes`, `name=` and `versionedResources`; GKE clusters; switches for 401, 403 `SERVICE_DISABLED`,
  403, 429, a slow answer and a redirect. It records every request (the bearer, `X-Goog-User-Project`).
- `fake-gcloud.sh`: prints a fixed account and token; files in its `CLOUDSDK_CONFIG` folder change the account
  (empty: signed out), the token or make it fail, and it records each call and its environment.

```bash
pnpm --filter @landlens/gcp test                         # auth, assets, errors against the fakes
(cd apps/desktop && npx vitest run test/gcp-service.test.ts)   # GcpService in main
pnpm -s build && (cd apps/desktop && LANDLENS_INTEGRATION=orbstack npx vitest run test/gcp.e2e.test.ts)
```

The e2e needs no cluster for most of it (Welcome); its last case connects OrbStack for the sidebar, ⌘K and a
1024×700 window. With `LANDLENS_SHOTS=<folder>` it saves `g4-*` screenshots in dark and light.

## Left for you to check

- Real Google Cloud, which no test reaches: with `LANDLENS_GCP_REAL=1` and your own gcloud, that the project search,
  the resource search and `versionedResources` answer as the docs and the fake say, and that a disabled API and a
  missing role give their sentences.
- That your account's projects bill the requests as expected (`X-Goog-User-Project` needs
  `serviceusage.services.use` in the project).
