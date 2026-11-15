import type { ResourceType } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { markCustom } from "../src/discovery.js";

const t = (group: string, resource: string): ResourceType => ({ group, version: "v1", resource, kind: resource, namespaced: true, verbs: ["list"] });

describe("custom kinds", () => {
  const types = [t("", "pods"), t("apps", "deployments"), t("cert-manager.io", "certificates"), t("gateway.networking.k8s.io", "gateways"), t("flowcontrol.apiserver.k8s.io", "flowschemas")];
  it("are the ones a CRD defines", () => {
    const out = markCustom(types, new Set(["certificates.cert-manager.io", "gateways.gateway.networking.k8s.io"]));
    expect(out.filter((x) => x.custom).map((x) => x.resource)).toEqual(["certificates", "gateways"]);
  });
  it("without the CRD list, are the groups outside Kubernetes's own", () => {
    expect(markCustom(types, undefined).filter((x) => x.custom).map((x) => x.resource)).toEqual(["certificates"]);
  });
});
