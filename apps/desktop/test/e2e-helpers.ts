// Shared steps for the e2e tests (the built app, Playwright).
import type { Page } from "playwright-core";

/**
 * Choose exactly one namespace, or "" for all of them, in the toolbar's namespace popover (wave 8 part 3, D158): its
 * filter, then Only on that namespace's row (or All namespaces). Both choose and close the popover.
 */
export async function chooseNamespace(page: Page, ns: string): Promise<void> {
  await page.getByRole("button", { name: /^Namespaces: / }).click();
  const pop = page.getByRole("dialog", { name: "Namespaces" });
  await pop.waitFor();
  if (!ns) await pop.getByRole("checkbox", { name: "All namespaces" }).click();
  else {
    await pop.getByRole("searchbox", { name: "Filter namespaces" }).fill(ns);
    await pop.getByRole("button", { name: `Only ${ns}`, exact: true }).click();
  }
  await pop.waitFor({ state: "detached" });
}

/** The namespaces the toolbar's button says are chosen ("All namespaces", a name, or "3 namespaces"). */
export async function chosenNamespaces(page: Page): Promise<string> {
  return ((await page.getByRole("button", { name: /^Namespaces: / }).getAttribute("aria-label")) ?? "").replace(/^Namespaces: /, "");
}
