// What view_context tells Claude about writing a view (D205): the source and block catalog with its limits, as text.
// Fixed: nothing from the cluster is in it (main adds the cluster's facts above it, from checked names).
import { COMPUTED } from "./computed.js";
import { VIEW_LIMITS as L } from "./limits.js";
import { VIEW_SCHEMA } from "./schema.js";

export const VIEW_CATALOG = `How to write a view document (schema ${VIEW_SCHEMA}):
{ "schema": ${VIEW_SCHEMA}, "title": "…", "params"?: [...], "sources": { "<id>": Source }, "blocks": [Block, ...] }
Ids are lowercase: a letter, then letters, digits or -, at most 31. Field names: a lowercase letter, then letters, digits or _.

Sources (at most ${L.sources}; Landlens reads each one live with this view's own read-only access; never Secrets):
- {"kind":"kube.list","resource":"pods","group"?:"apps","version"?:"v1","namespace"?:"*"|"<ns>"|{"param":"<name>"},"labelSelector"?,"fieldSelector"?,"fields"?:{"<field>":"<path>"},"pipe"?:[Step]}
  Without fields a row has name, namespace, kind, age, status. A path reads the object: metadata.labels["app.kubernetes.io/name"], spec.containers[*].image, status.containerStatuses[0].restartCount; or a computed name: ${COMPUTED.join(", ")}.
- {"kind":"kube.events","namespace"?,"warningsOnly"?:true,"sinceMinutes"?:60,"fields"?,"pipe"?}: type, reason, object, message, count, last, namespace.
- {"kind":"kube.logs","namespace":"<ns>","pod"?:"<name>"|"workload"?:{"kind":"Deployment","name":"…"},"container"?,"tailLines"?:200,"previous"?:false} (a pod or a workload; at most ${L.logsSources}; shown only by a logs block).
- {"kind":"kube.top","of":"pods"|"nodes","namespace"?}: name, namespace, cpu (cores), memory (bytes). Needs metrics-server.
- {"kind":"metrics.series","scope":"cluster"|"namespace"|"node"|"deployment"|"statefulset"|"daemonset"|"pod","namespace"?,"name"?,"range":"1h"|"6h"|"24h"}: usage over time.
- {"kind":"doctor.problems","namespace"?}: Landlens's own check: kind, namespace, name, tone, class, reason, title, detail.
- {"kind":"helm.releases","namespace"?}: name, namespace, chart, chartVersion, appVersion, status, revision, updated.
Pipe steps (at most ${L.steps}, each an object with one key): filter [{field, op: eq|ne|gt|gte|lt|lte|contains|startsWith|endsWith|in|exists, value}], sort [{field, dir}], limit n, group {by: [fields], agg: {out: {fn: count|sum|avg|min|max|first|countDistinct, field}}}, join {with: "<source>", on: {left, right} | {selector, labels}, take: {out: field} | agg}, derive {out: {fn: ratio|percent|diff|sum, of: [a, b]}}, rename {from: to}, pick [fields].
A source delivers at most ${L.rows.toLocaleString("en-US")} rows; past it the rest are cut and the view says so.

Params (at most 6), each picked by the person: {"name","type":"namespace"|"choice"|"text","label"?,"default"?,"options"?} and used as {"param":"<name>"} in a namespace or a filter value.

Blocks (at most ${L.blocks}; each may take "span": 1|2|3|4|6|12 of a 12-column grid and a "title"):
- {"type":"table","source","columns":[{"field","header"?,"format"?:"text"|"number"|"age"|"bytes"|"cpu"|"percent"|"status"|"ref"|"mono","width"?,"toneField"?}]}
- {"type":"stat","source","field","label","format"?,"toneField"?} · {"type":"chart","source","kind":"line"|"area"|"bar","x"?,"y":[fields],"unit"?}
- {"type":"list","source","primary","secondary"?,"max"?} · {"type":"logs","source"} · {"type":"problems","source"} · {"type":"text","markdown"}
- {"type":"app","id","uses":["<source>", …],"html","css"?,"js"?,"fill"?:true,"minHeight"?}: your own HTML, CSS and JavaScript in a sandbox with no network (at most ${L.appBlocks} a view, ${L.appChars.toLocaleString("en-US")} characters each). Write a fragment, not a document (no <html>, <head>, <meta>, <link>, <iframe>, <form>…). Your script gets one object, view: view.onData("<source>", d => …) gets the source's data now and on every change (d.state, d.rows, d.total, d.truncated, d.message); view.data(source); view.params; view.el(tag, attrs, ...children) builds DOM with text; view.openObject(row._ref) opens a row's object in Landlens; view.format.age/bytes/cpu. Build with view.el and text; never innerHTML with data. A block reads only the sources in its uses.

The document is at most ${L.documentChars.toLocaleString("en-US")} characters as JSON. render_view shows a new document; patch_view changes the shown one with JSON Patch ops (add, remove, replace, move; at most ${L.patchOps}) and its base must be the shown version.`;
