// -- FNSTools catalog rules shared by every surface that lists packages -------
// The FNSTools tab, the Toolbox section and the palette page inside
// TouchDesigner all read the same release manifest. These are the rules they
// must agree on, so they live in one place.

import type { FnsManifest, FnsPackage } from "./types";

/** Where every "unlocks at the … tier" link sends people: Function Store's
 *  Patreon join page, which lists the tiers. The manifest's own
 *  `toolkit.support_url` is the creator's page, one click further away. */
export const SUPPORT_JOIN_URL = "https://www.patreon.com/function_store/join";

/** An unreleased package (FNSTools docs/PreviewPackages.md): it ships in the
 *  release so the creator can test it, but only the creator's account may
 *  see or install it. The manifest marks it `preview: true` and publishes it
 *  under the pseudo tier `access: "preview"`, which no membership carries. */
export function isFnsPreview(p: FnsPackage): boolean {
  return p.preview === true || p.access?.toLowerCase() === "preview";
}

/** The pickable tools a surface may show: tools only, without the names the
 *  toolkit retired (a stale cached manifest can still carry one), and without
 *  previews unless the entitlement claim names them. The toolkit's own picker
 *  applies the same rule "before any list is built". */
export function fnsListedTools(manifest: FnsManifest, products: readonly string[]): FnsPackage[] {
  const retired = new Set(manifest.retired ?? []);
  return manifest.packages.filter(
    (p) =>
      p.kind === "tool" &&
      !retired.has(p.name) &&
      (!isFnsPreview(p) || products.includes(p.name)),
  );
}

/** The tier label a gated package shows ("Base", "Pro"), or null for a free
 *  one. Labels come from the manifest's tier ladder, never hardcoded. */
export function fnsTierLabel(manifest: FnsManifest | null | undefined, p: FnsPackage): string | null {
  if (!p.access || p.access.toLowerCase() === "free") return null;
  if (isFnsPreview(p)) return "Preview";
  return (manifest?.toolkit?.tiers ?? []).find((t) => t.id === p.access)?.label ?? "Plus";
}
