// Custom resources in the window (wave 4, part 4; D38–D41): a custom list's columns come from its CRD's printer
// columns, and any kind can be pinned under Agent.
import type { KubeObject } from "@landlens/contracts";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Column, NavItem } from "./kinds";
import { conditionCell, customColumns, printerColumn, printerColumns, type PrinterColumn } from "./printer";

export const CRD = { group: "apiextensions.k8s.io", version: "v1", resource: "customresourcedefinitions" } as const;

/** The definition behind a custom kind, read once per kind (undefined while loading or when you can't read it). */
export function useCrd(handle: string, item: NavItem | undefined): KubeObject | undefined {
  const name = item?.type.custom ? `${item.type.resource}.${item.type.group}` : undefined;
  const [crd, setCrd] = useState<{ name: string; o: KubeObject }>();
  useEffect(() => {
    if (!name) return;
    let live = true;
    api.invoke("resource:get", { handle, ref: { ...CRD, name } }).then(({ object }) => live && setCrd({ name, o: object }), () => live && setCrd(undefined));
    return () => {
      live = false;
    };
  }, [handle, name]);
  return name && crd?.name === name ? crd.o : undefined;
}

/**
 * A list's columns: a custom kind's printer columns (served version, priority 0) between Name/Namespace and Age,
 * with Status when any shown object has a Ready or Available condition (D40). Other kinds keep their own.
 */
export function useColumns(item: NavItem | undefined, crd: KubeObject | undefined, items: KubeObject[]): { columns: Column[]; printer: PrinterColumn[] } {
  const printer = useMemo(() => (item?.type.custom && crd ? printerColumns(crd, item.type.version) : []), [item, crd]);
  const withStatus = useMemo(() => !!item?.type.custom && items.some((o) => conditionCell(o)), [item, items]);
  const columns = useMemo(() => {
    if (!item) return [];
    if (!item.type.custom) return item.columns;
    return customColumns(item.columns, printer, withStatus);
  }, [item, printer, withStatus]);
  return { columns, printer };
}

/** A custom resource's printer columns as the drawer's facts: label and text, empty ones left out. */
export function printerFacts(o: KubeObject, cols: PrinterColumn[], now: number): { label: string; text: string; title?: string; num?: boolean }[] {
  return cols
    .filter((c) => !(c.type === "date" && c.jsonPath.replace(/\s/g, "") === ".metadata.creationTimestamp"))
    .map((c, i) => {
      const col = printerColumn(c, i);
      const cell = col.cell(o, now);
      return { label: c.name, text: cell.text, ...(cell.title ? { title: cell.title } : c.description ? { title: c.description } : {}), ...(col.num ? { num: true } : {}) };
    })
    .filter((f) => f.text);
}

const pinKey = (context: string) => `landlens.pins.${context}`;
const MAX_PINS = 20;

/** Kinds pinned under Agent (D39), per cluster context, in this window's storage. */
export function usePins(context: string): [string[], (key: string) => void] {
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(pinKey(context)) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[a-z0-9.-]*\/[a-z0-9-]+$/.test(x)).slice(0, MAX_PINS) : [];
    } catch {
      return [];
    }
  };
  const [pins, setPins] = useState<string[]>(read);
  useEffect(() => setPins(read()), [context]);
  const toggle = (key: string) =>
    setPins((p) => {
      const next = p.includes(key) ? p.filter((k) => k !== key) : [...p, key].slice(-MAX_PINS);
      localStorage.setItem(pinKey(context), JSON.stringify(next));
      return next;
    });
  return [pins, toggle];
}
