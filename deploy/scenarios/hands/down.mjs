// Removes wave 8's scenario from landlens-dev on OrbStack: everything labelled scenario=hands, and any Job a Trigger
// left (owned by hands-report, so deleting the CronJob takes them too). Only the orbstack context and the
// landlens-dev namespace are touched.
// node deploy/scenarios/hands/down.mjs
import { execFileSync } from "node:child_process";

const kubectl = (args) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });
kubectl(["delete", "deployments,statefulsets,daemonsets,pods,cronjobs,jobs,poddisruptionbudgets,configmaps,secrets", "-l", "scenario=hands", "--ignore-not-found", "--wait=true"]);
console.log("Hands scenario removed from landlens-dev.");
