// The blank Views page's example chips (wave 10 part 4, D224): six fixed asks, each shown only when this cluster has
// what it needs. No cluster's name, namespace or object goes into a chip: they are the same words on every cluster, and
// a click fills the composer without sending.
export type ExampleInputs = {
  /** A usage source answers for this cluster (Clickland, Prometheus or Landlens's sampler). */
  metrics: boolean;
  /** The doctor's problems now (undefined while it hasn't read). */
  problems?: number;
  /** "Claude can read" Google Cloud is on, with a project chosen. */
  gcpReads: boolean;
};
export type Example = { id: string; text: string; label: string };

export function viewExamples(i: ExampleInputs): Example[] {
  const out: Example[] = [
    { id: "restarts", text: "Pods that restarted today, worst first", label: "Pods that restarted today, worst first" },
  ];
  if (i.metrics) out.push({ id: "usage", text: "CPU and memory by namespace", label: "CPU and memory by namespace" });
  if (i.problems && i.problems > 0) {
    const n = Math.min(i.problems, 999);
    out.push({ id: "wrong", text: "Everything wrong right now, grouped by owner", label: `Everything wrong right now, grouped by owner (${n} ${n === 1 ? "problem" : "problems"})` });
  }
  out.push({ id: "images", text: "Deployments and their images", label: "Deployments and their images" });
  out.push({ id: "warnings", text: "Warning events in the last hour", label: "Warning events in the last hour" });
  if (i.gcpReads) out.push({ id: "sql", text: "Cloud SQL instances and their state", label: "Cloud SQL instances and their state" });
  return out;
}
