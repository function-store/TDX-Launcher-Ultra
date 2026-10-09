import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { withOp } from "./ops";
import { SUPPORT_JOIN_URL, fnsListedTools, fnsTierLabel } from "./fnsCatalog";
import { alternativesLabel, alternativesTitle, canonicalToolName, packageLandsInPane } from "./utils";
import type { FnsManifest, FnsPackage, FnsStoreStatus } from "./types";

const OPEN_KEY = "tdxlu.fnsShelf.open";
const COLLAPSED_KEY = "tdxlu.fnsShelf.collapsed";

/**
 * "FNSTools" shelf in the Palette tab — every FNSTools package as a
 * standalone component (since v3.0.1 each one resolves through its own
 * global shortcut, so a single dropped .tox works without the toolkit
 * root). A VIRTUAL section fed by manifest + palette-store state: rows
 * never enter the user's own Toolbox config, so nothing can drift.
 *
 * Present in the store → drag out / ↳ place, like any palette .tox.
 * Absent → ⤓ downloads it (sha256-verified) into the store first.
 */

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* fresh */
  }
  return new Set();
}

interface Props {
  search: string;
  selectedPath: string | null;
  selectedRef: React.MutableRefObject<HTMLElement | null>;
  /** Package names the entitlement claim covers — Plus (`access`-gated)
   *  rows not in it render locked (already-stocked copies stay usable:
   *  the store is theirs). */
  products?: string[];
  onSelect: (path: string) => void;
  onDragStart: (path: string, e: React.DragEvent) => void;
  /** Place (pane/none) or install (root/absent) one package into the place
   *  target — the caller reads `pkg.placement` to pick the route. */
  onPlace?: (path: string, pkg: FnsPackage) => void;
  placeTitle?: string;
  onStatus: (msg: string) => void;
}

export default function FnsToolboxSection({
  search,
  selectedPath,
  selectedRef,
  products,
  onSelect,
  onDragStart,
  onPlace,
  placeTitle,
  onStatus,
}: Props) {
  const [open, setOpen] = useState(readOpen);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [manifest, setManifest] = useState<FnsManifest | null>(null);
  const [store, setStore] = useState<FnsStoreStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const searchActive = !!search.trim();
  const sectionOpen = open || searchActive;

  const load = useCallback(async () => {
    try {
      const info = await api.fnsManifest(false);
      setManifest(info.manifest);
      setStore(await api.fnsStoreStatus());
    } catch {
      // No cached manifest yet — the section stays a pointer to the FNS tab.
      setManifest(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (sectionOpen && !loaded) void load();
  }, [sectionOpen, loaded, load]);

  const toggleOpen = () => {
    setOpen((prev) => {
      try {
        localStorage.setItem(OPEN_KEY, prev ? "0" : "1");
      } catch {
        /* nicety */
      }
      return !prev;
    });
  };

  const toggleCategory = (name: string) => {
    if (searchActive) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* nicety */
      }
      return next;
    });
  };

  const storePath = (name: string) =>
    store ? `${store.storeDir}/${name}.tox` : null;

  const artifactState = (name: string) =>
    store?.artifacts.find((a) => a.name === name);

  const fetchOne = async (name: string) => {
    setBusy((prev) => new Set(prev).add(name));
    try {
      const status = await withOp("fns-store", "FNS store", () =>
        api.fnsSyncStore([name], false),
      );
      setStore(status);
      onStatus(`${name}.tox stocked in the FNS store`);
    } catch (e) {
      onStatus(`FNS download failed: ${e}`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  // The FNSTools tab's rule (fnsCatalog): no retired names, and no
  // unreleased previews unless the claim names them.
  const tools = manifest ? fnsListedTools(manifest, products ?? []) : [];
  const q = search.trim().toLowerCase();
  const matches = (p: FnsPackage) =>
    !q ||
    q
      .split(/\s+/)
      .every((t) => `${p.name} ${p.category} ${p.description ?? ""}`.toLowerCase().includes(t));
  const visible = tools.filter(matches);
  const categories = [
    ...new Set([
      ...(manifest?.categories ?? []).filter((c) => c !== "Core"),
      ...visible.map((p) => p.category),
    ]),
  ].filter((c) => visible.some((p) => p.category === c));
  if (searchActive && visible.length === 0) return null;
  const meta = manifest?.category_meta ?? {};

  return (
    <div className="toolbox-section fns-shelf" role="tree" aria-label="FNSTools">
      <div className="toolbox-header">
        <button type="button" className="toolbox-title" onClick={toggleOpen}>
          <span className="palette-twist" aria-hidden>
            {sectionOpen ? "▾" : "▸"}
          </span>
          <span className="toolbox-star" aria-hidden>
            ◈
          </span>
          <span>FNSTools</span>
          {manifest && <span className="palette-folder-count">{tools.length}</span>}
        </button>
        {sectionOpen && (
          <span className="toolbox-header-actions">
            <button
              type="button"
              className="toolbox-mini"
              title="Reload catalog + store state"
              onClick={() => void load()}
            >
              ⟳
            </button>
          </span>
        )}
      </div>
      {sectionOpen && loaded && !manifest && (
        <div className="fns-shelf-hint">
          No FNS catalog yet — open the <b>FNSTools</b> tab once (needs network) and
          the shelf fills in.
        </div>
      )}
      {sectionOpen &&
        manifest &&
        categories.map((cat) => {
          const inCat = visible.filter((p) => p.category === cat);
          const catOpen = searchActive || !collapsed.has(cat);
          return (
            <div key={cat}>
              <div
                role="treeitem"
                className="palette-file-row fns-shelf-cat"
                onClick={() => toggleCategory(cat)}
              >
                <span className="palette-twist" aria-hidden>
                  {catOpen ? "▾" : "▸"}
                </span>
                <span className="palette-file-icon" aria-hidden>
                  {meta[cat]?.glyph ?? "▸"}
                </span>
                <span className="palette-file-name">{cat}</span>
                <span className="palette-folder-count">{inCat.length}</span>
              </div>
              {catOpen &&
                inCat.map((p) => {
                  const art = artifactState(p.name);
                  const inPane = packageLandsInPane(p);
                  const altLabel = alternativesLabel(p);
                  const present = !!art?.present;
                  const stale = art?.shaOk === false;
                  const path = storePath(p.name);
                  const selected = !!path && path === selectedPath;
                  const isBusy = busy.has(p.name);
                  // Plus rail: gated row the claim doesn't cover. What's
                  // already in the store stays draggable/placeable; only
                  // FETCHING is locked (gated at stocking, fns-gate.md §4.2).
                  const tier = fnsTierLabel(manifest, p);
                  const locked = !!tier && !(products ?? []).includes(p.name);
                  const supportUrl = SUPPORT_JOIN_URL;
                  return (
                    <div
                      key={p.name}
                      role="treeitem"
                      draggable={present}
                      ref={(el) => {
                        if (selected) selectedRef.current = el;
                      }}
                      className={[
                        "palette-file-row",
                        "toolbox-tool-row",
                        tier ? "fns-shelf-plus" : "",
                        selected ? "selected" : "",
                        present ? "draggable-tox" : "missing",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ paddingLeft: 22 }}
                      title={`${p.description}${stale ? " (store copy is stale — re-download)" : ""}${
                        locked && !present
                          ? `\n\nUnlocks at the ${tier} tier${supportUrl ? ` — ${supportUrl}` : ""}`
                          : ""
                      }`}
                      onClick={() => {
                        if (present && path) onSelect(path);
                        else if (locked) {
                          onStatus(`${canonicalToolName(p.name)} unlocks at the ${tier} tier`);
                        } else if (!isBusy) void fetchOne(p.name);
                      }}
                      onDragStart={(e) => {
                        if (present && path) onDragStart(path, e);
                      }}
                    >
                      <span className="palette-twist spacer" aria-hidden />
                      <span className="palette-file-icon" aria-hidden>
                        {isBusy ? "…" : present ? (stale ? "◑" : "◆") : "◇"}
                      </span>
                      <span className="palette-file-name">
                        {canonicalToolName(p.name)}
                        {tier && (
                          <span
                            className={`fns-tier-badge${locked ? "" : " owned"}`}
                          >
                            {locked ? `✦ ${tier}` : `✓ ${tier}`}
                          </span>
                        )}
                        {!present && !isBusy && !locked && (
                          <span className="toolbox-fetch-hint"> — click to fetch</span>
                        )}
                        {altLabel && (
                          <span className="fns-alt-hint" title={alternativesTitle(p)}>
                            {" "}
                            · {altLabel}
                          </span>
                        )}
                      </span>
                      <span
                        className="toolbox-row-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {onPlace && present && path && (
                          <button
                            type="button"
                            className="toolbox-mini"
                            title={
                              inPane
                                ? placeTitle ?? "Place in a running session"
                                : `Install through FNSTools${
                                    placeTitle ? ` — ${placeTitle.replace(/^Place in /, "into ")}` : ""
                                  } (arrives where the toolkit puts it, recorded for updates)`
                            }
                            onClick={() => onPlace(path, p)}
                          >
                            {inPane ? "↳" : "⊕"}
                          </button>
                        )}
                        {locked ? (
                          <button
                            type="button"
                            className="toolbox-mini"
                            title={`Unlocks at the ${tier} tier${
                              supportUrl ? ` — open ${supportUrl}` : ""
                            }`}
                            onClick={() => {
                              void api.openUrl(supportUrl);
                            }}
                          >
                            ✦
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="toolbox-mini"
                            title={
                              present
                                ? stale
                                  ? "Store copy is stale — re-download"
                                  : "Re-download from the release bucket"
                                : "Download into the FNS palette store"
                            }
                            disabled={isBusy}
                            onClick={() => void fetchOne(p.name)}
                          >
                            ⤓
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}
    </div>
  );
}
