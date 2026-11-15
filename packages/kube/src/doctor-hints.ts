// Landlens's own first suggestion for a problem (wave 5, D63): static sentences with only names, numbers and image
// references filled in. Messages written by workloads (events, waiting and termination messages) are only tested
// with patterns here, never copied into a hint, so a hint can't carry text a workload chose.
import type { ProblemClass } from "@landlens/contracts";

export type HintInput = {
  class: ProblemClass;
  reason: string;
  name: string;
  exitCode?: number;
  signal?: number;
  /** Tested, never copied. */
  message?: string;
  image?: string;
  probe?: { type: string; how: string };
  limit?: string;
  available?: string;
  restarts?: number;
};
export type Hint = { cause: string; next: string[] };

/** A word Kubernetes or a controller uses as a reason; anything else is not repeated. */
const WORD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const word = (s: string | undefined, other: string) => (s && WORD.test(s) ? s : other);

export function hintFor(i: HintInput): Hint {
  const m = i.message ?? "";
  switch (i.class) {
    case "oom":
      return {
        cause: `The container used more than its memory limit${i.limit ? ` (${i.limit})` : " (it has none, so the node ran short)"} and was killed (OOMKilled).`,
        next: ["Compare its memory use with the limit on the Metrics tab", "Raise the limit, or find what grows (a leak, a large input, a cache without a bound)"],
      };
    case "crashloop":
      return { cause: exitCause(i.exitCode, i.signal), next: ["Read the previous run's log (Logs, Previous)", "Compare the container's env, args and mounted config with what the app needs", "Check what changed in its ConfigMaps, Secrets or image"] };
    case "image": {
      const ref = i.image ? ` ${i.image}` : " its image";
      if (i.reason === "InvalidImageName") return { cause: `The image reference${ref} isn't valid.`, next: ["Fix the image field: registry/name:tag"] };
      if (/not found|manifest unknown|does not exist|no such manifest/i.test(m)) return { cause: `The image or tag${ref} doesn't exist in the registry.`, next: ["Check the name and tag against the registry", "Check that the build pushed this tag"] };
      if (/unauthorized|denied|authenticat|forbidden|401|403/i.test(m)) return { cause: `The registry refuses to serve${ref} without credentials (imagePullSecrets).`, next: ["Add or fix imagePullSecrets on the pod or its ServiceAccount", "Check the pull secret's registry and expiry"] };
      if (/no such host|lookup|dial tcp|i\/o timeout|connection refused|context deadline|bad gateway|failed to do request|tls/i.test(m)) return { cause: `The node can't reach the registry for${ref}.`, next: ["Check the registry's host name", "Check the node's DNS and network to the registry"] };
      return { cause: `The node can't pull${ref}.`, next: ["Check the image name and tag", "Check imagePullSecrets if the registry is private"] };
    }
    case "config":
      return { cause: "The container refers to a ConfigMap, Secret or key that doesn't exist, so it can't be created.", next: ["Check env, envFrom and volume references against the namespace's ConfigMaps and Secrets", "Mark optional references `optional: true` if they may be missing"] };
    case "start":
      return { cause: "The runtime couldn't create or start the container: often a command that doesn't exist, a bad mount or a security setting.", next: ["Read the waiting message on the pod", "Check the command, mounts and securityContext"] };
    case "pending":
      if (i.reason === "Unschedulable") {
        if (/affinity|selector|didn't match/i.test(m)) return { cause: "No node has the labels this pod asks for (its node selector or affinity).", next: ["Compare the pod's nodeSelector and affinity with the nodes' labels", "Remove the selector, or label a node that should run it"] };
        if (/insufficient/i.test(m)) return { cause: "No node has room for its CPU or memory requests.", next: ["Lower the requests, or free or add capacity", "Check what the nodes have allocated"] };
        if (/taint/i.test(m)) return { cause: "The nodes have taints this pod doesn't tolerate.", next: ["Add a toleration, or schedule it on an untainted node"] };
        if (/persistentvolumeclaim|unbound|volume/i.test(m)) return { cause: "A volume claim it needs isn't bound.", next: ["Check the claim's status and storage class"] };
        return { cause: "The scheduler can't place it on any node.", next: ["Read its FailedScheduling events"] };
      }
      if (i.reason === "FailedMount" || i.reason === "FailedAttachVolume") return { cause: "A volume it mounts can't be set up: its ConfigMap, Secret or claim is missing or not ready.", next: ["Check that each volume's ConfigMap, Secret or claim exists in its namespace", "Read the pod's FailedMount events"] };
      if (i.reason === "FailedCreatePodSandBox") return { cause: "The node couldn't set up the pod's sandbox or network.", next: ["Check the node's network plugin and its events"] };
      return { cause: "The pod was accepted but hasn't started.", next: ["Read the pod's events", "Check its init containers"] };
    case "probe": {
      const how = i.probe?.how ? ` (${i.probe.how})` : "";
      if (i.probe?.type === "readiness") return { cause: `The readiness probe${how} fails, so the pod gets no traffic: its port, path or command doesn't match what the container serves.`, next: ["Compare the probe's port and path with what the container listens on", "Read the probe failures in the pod's events"] };
      if (i.probe?.type === "startup") return { cause: `The startup probe${how} fails, so the kubelet restarts the container before it is up.`, next: ["Check the probe against the app, or give it a longer failureThreshold"] };
      return { cause: `The liveness probe${how} fails, so the kubelet kills and restarts the container.`, next: ["Check what the probe checks exists in the container", "Read the probe failures in the pod's events"] };
    }
    case "notready":
      return { cause: "It runs but isn't ready: a readiness probe fails or a container is still starting.", next: ["Check its readiness probe and the containers' state"] };
    case "restarts":
      return { cause: `It restarted ${i.restarts ?? "several"} times in the last hour. ${exitCause(i.exitCode, i.signal)}`, next: ["Read the previous run's log", "Check the last exit code and the Metrics tab"] };
    case "unavailable":
      if (i.reason === "ProgressDeadlineExceeded") return { cause: "Its rollout stopped making progress.", next: ["Check the new ReplicaSet's pods and events", "Roll back if the new version is at fault"] };
      return { cause: `It has fewer available replicas than it wants (${i.available ?? "short"}).`, next: ["Check its pods' state and events"] };
    case "node":
      if (i.reason === "NotReady") return { cause: "The node's kubelet stopped reporting Ready: it may be down, cut off or out of resources.", next: ["Check the node's conditions and recent events"] };
      return { cause: `The node reports ${word(i.reason, "pressure")}; pods on it may be evicted.`, next: ["Check what uses the node's memory, disk or process IDs"] };
    case "warning":
      if (i.reason === "ProvisioningFailed") return { cause: "A volume claim can't be provisioned: its storage class doesn't exist or can't make the volume.", next: ["Check the claim's storageClassName against the cluster's storage classes"] };
      if (i.reason === "FailedMount") return { cause: "A volume can't be mounted: its ConfigMap, Secret or claim is missing.", next: ["Check the volume's source exists"] };
      if (i.reason === "FailedCreate") return { cause: "A controller can't create its pods (quota, admission or a bad template).", next: ["Read the controller's events"] };
      return { cause: `Kubernetes reported ${word(i.reason, "warning")} events for it in the last hour.`, next: ["Read the events in the drawer"] };
    case "cert":
      if (i.reason === "Unreadable") return { cause: "Its tls.crt isn't a certificate Landlens can read.", next: ["Check the Secret holds a PEM certificate in tls.crt"] };
      if (i.reason === "NotYetValid") return { cause: "The certificate isn't valid yet.", next: ["Check its notBefore and the clocks"] };
      return {
        cause: i.reason === "Expired" ? "The certificate has expired, so clients refuse it." : "The certificate expires soon.",
        next: ["Renew the certificate and update the Secret", "If cert-manager manages it, check its Certificate and the issuer"],
      };
  }
}

function exitCause(code?: number, signal?: number): string {
  if (code === undefined) return "The container keeps exiting; its previous log says why.";
  if (code === 137 || signal === 9) return "It was killed from outside (SIGKILL, exit 137): a failing liveness probe, the node, or memory.";
  if (code === 143 || signal === 15) return "It was stopped (SIGTERM, exit 143) and restarted.";
  if (code === 127) return "Its command was not found in the image (exit 127).";
  if (code === 126) return "Its command isn't executable (exit 126).";
  if (code === 0) return "Its main process ends successfully (exit 0), but a Deployment's container has to keep running.";
  return `The container exits with code ${code} right after starting: its previous log says why, often missing configuration or a bad argument.`;
}
