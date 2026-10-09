import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import { withOp } from "./ops";
import { SUPPORT_JOIN_URL, fnsListedTools, fnsTierLabel } from "./fnsCatalog";
import { alternativesLabel, alternativesTitle, canonicalToolName } from "./utils";
import type {
  FnsInstallReply,
  FnsManifest,
  FnsPackage,
  FnsSessionStatus,
  FnsStoreStatus,
  FnsUiPar,
  FnsUiSetReply,
  FnsUiState,
  OpenProject,
  FnsConfigScope,
  FnsUiTool,
} from "./types";

/**
 * FNS tab — store, installer and global configurator for the FNSTools
 * toolkit (design record: docs/fns-integration.md).
 *
 * Store view: the rolling release manifest rendered by category; pick tools,
 * stock the palette store (sha256-verified downloads in Rust), and drive the
 * toolkit's own FNS_Installer in a running session over the companion bus
 * (`fns_install` / `fns_status`). The installer treats manifest tools
 * present-but-unselected as REMOVALS — the picker edits project state — so
 * the confirm step lists both directions explicitly.
 *
 * Settings view: the global per-tool configuration. Live sessions serve it
 * through the toolkit's ConfigRegistry settings server (full par metadata,
 * validated writes); with no session the raw config JSON is edited directly
 * and tools re-apply it on their next load.
 */

const CORE_CATEGORY = "Core";
type AccessFilter = "all" | "free" | "plus";

function isPlusPackage(p: FnsPackage): boolean {
  return !!p.access && p.access.toLowerCase() !== "free";
}

/** Case-insensitive all-terms match over a package's searchable text. */
function matchPackage(p: FnsPackage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${p.name} ${p.category} ${p.description ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

/**
 * The website's paste rail, ported: ONE Textport line that reproduces the
 * selection in a bare project. Embeds only the picked names — release, URLs
 * and hashes resolve from the ROLLING manifest at paste time, so a copied
 * script stays valid across releases (same contract as the FNS configurator
 * page; keep the two in step).
 */
/** The packages the store lists: tools, minus anything the manifest itself
 *  calls retired. A stale cache can carry a retired name under `packages`
 *  (FNS_Media survived its 3.0.14 rename that way) and it would otherwise
 *  render as an ordinary locked row. */

function textportScript(manifest: FnsManifest, baseUrl: string, picked: string[]): string {
  // The CONFIGURED base, not the manifest's own base_url field: a cached
  // manifest can predate a host migration, and a paste script pointing at
  // the host the cache remembers is a dead script (seen live 2026-08-30
  // with storage.functionstr.com). The manifest field is only the fallback.
  const rolling = `${String(baseUrl || manifest.base_url || "").replace(/\/+$/, "")}/manifest.json`;
  const sel = JSON.stringify([...picked].sort());
  return [
    "import requests, hashlib, os, json, tempfile",
    "H = {'User-Agent': 'FNSTools-Install'}",
    `SEL = ${sel}`,
    `m = requests.get('${rolling}', headers=H, timeout=30).json()`,
    "idx = {p['name']: p for p in m['packages']}",
    "miss = [t for t in SEL if t not in idx]",
    "assert not miss, 'not in release %s: %s' % (m['release'], ', '.join(miss))",
    "rail = m.get('rails', {}).get('FNSTools.tox')",
    "assert rail, 'release %s publishes no bootstrap' % m['release']",
    "names = m['core'] + SEL",
    "blobs = {t: requests.get(idx[t]['artifact']['url'], headers=H, timeout=120).content for t in names}",
    "boot = requests.get(rail['url'], headers=H, timeout=120).content",
    "bad = [t for t in names if hashlib.sha256(blobs[t]).hexdigest() != idx[t]['artifact']['sha256']] + ([] if hashlib.sha256(boot).hexdigest() == rail['sha256'] else ['FNSTools.tox'])",
    "assert not bad, 'checksum mismatch: %s' % ', '.join(bad)",
    "st = os.path.join(app.userPaletteFolder, 'FNSTools', 'store')",
    "os.makedirs(st, exist_ok=True)",
    "_ = [open(os.path.join(st, t + '.tox'), 'wb').write(blobs[t]) for t in names]",
    "_ = open(os.path.join(st, 'manifest.json'), 'w').write(json.dumps(m, indent=1))",
    "sp = os.path.join(app.userPaletteFolder, 'FNSTools', 'selection.json').replace(chr(92), '/')",
    "_ = open(sp, 'w').write(json.dumps({'schema': 1, 'toolkit': m['toolkit']['name'], 'core': m['core'], 'tools': SEL, 'install': names}, indent=1))",
    "f = os.path.join(tempfile.gettempdir(), 'FNSTools.tox')",
    "_ = open(f, 'wb').write(boot)",
    "pn = ui.panes.current",
    "pn = pn if pn.type == PaneType.NETWORKEDITOR else next(x for x in ui.panes if x.type == PaneType.NETWORKEDITOR)",
    "root = pn.owner.loadTox(f)",
    "r_ = run(\"i = op('%s/FNS_Installer'); i.par.Selectionfile = '%s'; i.par.Install.pulse()\" % (root.path, sp), delayFrames=90)",
    "print('FNSTools', m['release'], '--', len(names), 'packages verified; installing into', root.path)",
  ].join("; ");
}

/** Store presence dot for one package. */
function storeDot(status: FnsStoreStatus | null, name: string) {
  const a = status?.artifacts.find((x) => x.name === name);
  if (!a || !a.present) return null;
  if (a.shaOk === false) {
    return (
      <span className="fns-dot stale" title="In store, but stale — will re-download">
        ●
      </span>
    );
  }
  return (
    <span className="fns-dot ok" title="In the palette store">
      ●
    </span>
  );
}

interface Props {
  search: string;
  /** Live sessions that CAN be installed into (companion present). */
  targets: OpenProject[];
  /** Live sessions with no companion. Listed in the same picker so a project
   *  the user is looking at is never silently absent -- but selecting one
   *  swaps Install for the utility drag, because fns_install has no path
   *  into a session without op.TDXLU. */
  companionless: OpenProject[];
  /** Path to the companion .tox we ship, for the drag chip (null until read). */
  bundledUtilityTox: string | null;
  onDragUtility: (path: string, e?: React.DragEvent) => void;
  /** macOS starts the outbound drag from mousedown, not dragstart. */
  isMac: boolean;
  /** Package names the entitlement claim covers (LicenseStatus.products) —
   *  decides how Plus (`access`-gated) rows render. The gate re-enforces at
   *  download time regardless (fail-closed). */
  products: string[];
  /** Open the launcher's FNSTools Plus sign-in. Absent when the build has no
   *  licensing -- then there is nothing to sign in to here. */
  onPlusSignIn?: () => void;
  onStatus: (msg: string) => void;
  onOpenUrl: (url: string) => void;
  onOpenPath: (path: string) => void;
}

export default function FnsPanel({
  search,
  targets,
  companionless,
  bundledUtilityTox,
  onDragUtility,
  isMac,
  products,
  onPlusSignIn,
  onStatus,
  onOpenUrl,
  onOpenPath,
}: Props) {
  const [view, setView] = useState<"store" | "settings">("store");
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  const [manifest, setManifest] = useState<FnsManifest | null>(null);
  const [manifestSource, setManifestSource] = useState<string>("");
  /** The CONFIGURED bucket base the backend fetched with — survives a stale
      cache whose own base_url predates a host migration. */
  const [manifestBase, setManifestBase] = useState<string>("");
  const [store, setStore] = useState<FnsStoreStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [targetPath, setTargetPath] = useState<string>("");
  const [session, setSession] = useState<FnsSessionStatus | null>(null);
  const [sessionErr, setSessionErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [actionsMenuAt, setActionsMenuAt] = useState<{ x: number; y: number } | null>(null);
  const pollTimer = useRef<number | null>(null);

  // Installable sessions first, so the default target is always one that can
  // actually take an install; a companionless session is only ever selected
  // deliberately.
  const allTargets = useMemo(
    () => [...targets, ...companionless],
    [targets, companionless],
  );
  const target = useMemo(
    () => allTargets.find((t) => t.path === targetPath) ?? allTargets[0] ?? null,
    [allTargets, targetPath],
  );
  /** The selected session cannot be installed into at all. Not the same as
   *  `sessionErr` (an old companion that did not answer fns_status): there is
   *  no companion to answer, so the remedy is the drag, not a retry. */
  const targetNeedsCompanion = !!target && !target.utility_available;

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const info = await api.fnsManifest(refresh);
        setManifest(info.manifest);
        setManifestSource(info.source);
        setManifestBase(info.baseUrl);
        setStore(await api.fnsStoreStatus());
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Fetch on open. With refresh=false the Rust side serves whatever manifest
  // is on disk and never asks the bucket, so a new toolkit release stayed
  // invisible until someone pressed Refresh -- a retired package even rendered
  // as a locked row from a pre-3.0.14 cache. refresh=true still falls back to
  // the cache when offline, so nothing is lost.
  useEffect(() => {
    void load(true);
  }, [load]);

  // What the target session already has — drives pre-selection + the
  // add/remove plan. Companion ≥0.9.0 (or Envoy fallback) required; older
  // ones answer "unknown action", shown as a soft hint, not an error wall.
  const refreshSession = useCallback(async () => {
    if (!target || !target.utility_available) {
      setSession(null);
      setSessionErr(null);
      return;
    }
    try {
      const res = (await api.openProjectUtility(
        target.path,
        "fns_status",
        null,
      )) as FnsSessionStatus;
      if (res && res.ok === false) {
        setSession(null);
        setSessionErr(res.error ?? "fns_status failed");
        return;
      }
      setSession(res);
      setSessionErr(null);
    } catch (e) {
      setSession(null);
      setSessionErr(String(e));
    }
  }, [target]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // Pre-check what's installed whenever a session status arrives, so
  // "Install" edits from the project's real state instead of from zero.
  const sessionTools = useMemo(() => {
    if (!session?.present || !manifest) return null;
    // Every tool the session carries, hidden previews included: an install
    // removes what isn't picked, so a preview someone already has must stay
    // picked even though no row shows it.
    const toolNames = new Set(fnsListedTools(manifest, session.packages?.map((p) => p.name) ?? []).map((p) => p.name));
    return new Set(
      (session.packages ?? []).map((p) => p.name).filter((n) => toolNames.has(n)),
    );
  }, [session, manifest]);

  const preselected = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionTools || !target) return;
    if (preselected.current === target.path) return;
    preselected.current = target.path;
    setPicked(new Set(sessionTools));
  }, [sessionTools, target]);

  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    },
    [],
  );

  const togglePick = (name: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setConfirming(false);
  };

  /** Pick or unpick a batch of rows at once — Select all / none and the
   *  category checkboxes. Like the rows themselves, this only edits the
   *  pending plan: nothing installs or goes away until Apply, which shows
   *  the +adds / −removes first. */
  const setPickedMany = (names: string[], on: boolean) => {
    if (names.length === 0) return;
    setPicked((prev) => {
      const next = new Set(prev);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });
    setConfirming(false);
  };

  /** Packages the session carries under a name the toolkit RETIRED — the
   *  v3.2.0 `FNS_` prefix pass retired 31 names at once.
   *
   *  Measured on the toolkit side (2026-09-11) and confirmed as deliberate:
   *  a rename is a retirement plus a new package, with no migration. Their
   *  installer draws removal candidates from the manifest's package names, so
   *  an old name can never BE a removal candidate, and its install check asks
   *  for the new name and finds nothing. So installing puts the new package
   *  BESIDE the old one. Worse, their updater skips any child the store does
   *  not publish, so the orphan gets no update row and no warning, ever.
   *
   *  None of that is visible from the manifest alone — `retired` is a flat
   *  list with no old-to-new map — so this cannot say what replaced what. It
   *  says what it can prove: this is still here, and nothing maintains it. */
  const retiredInstalled = useMemo(() => {
    if (!manifest || !session?.packages) return [];
    const retired = new Set(manifest.retired ?? []);
    return session.packages
      .map((p) => p.name)
      .filter((n) => retired.has(n))
      .sort();
  }, [manifest, session]);

  const core = useMemo(() => manifest?.core ?? [], [manifest]);
  const tools = useMemo(
    () => (manifest ? fnsListedTools(manifest, products) : []),
    [manifest, products],
  );

  // --- Plus rail (access-gated packages) ----------------------------------
  // Tier labels come from the manifest's routes projection — never
  // hardcoded (fns-gate.md's rule). A gated package the claim doesn't name
  // renders locked with "unlocks at the <label> tier" + the support link;
  // one the claim names picks and stocks like any free row (the Rust sync
  // brings a download token).
  const supportUrl = SUPPORT_JOIN_URL;
  const packageLocked = (p: FnsPackage) =>
    !!fnsTierLabel(manifest, p) && !products.includes(p.name);

  /** A LAUNCHER CAPABILITY: the package declares a command on one of this
   *  app's surfaces, so installing it makes something appear in the Sessions
   *  view. Every one of them is also a complete TouchDesigner tool that works
   *  with the launcher closed — the badge says "this lights up here too",
   *  never "this needs the launcher". */
  const isCapability = (p: FnsPackage) =>
    !!p.launcher && Array.isArray(p.launcher.capabilities) &&
    p.launcher.capabilities.length > 0;
  const categories = useMemo(() => {
    const listed = (manifest?.categories ?? []).filter((c) => c !== CORE_CATEGORY);
    const seen = new Set(listed);
    for (const t of tools) {
      if (t.category && t.category !== CORE_CATEGORY && !seen.has(t.category)) {
        listed.push(t.category);
        seen.add(t.category);
      }
    }
    return listed;
  }, [manifest, tools]);

  const searchedTools = useMemo(
    () => tools.filter((t) => matchPackage(t, search)),
    [tools, search],
  );
  const plusToolCount = useMemo(
    () => searchedTools.filter(isPlusPackage).length,
    [searchedTools],
  );
  const visibleTools = useMemo(
    () => searchedTools.filter((t) => {
      if (accessFilter === "plus") return isPlusPackage(t);
      if (accessFilter === "free") return !isPlusPackage(t);
      return true;
    }),
    [searchedTools, accessFilter],
  );
  /** What Select all / none act on: every row currently shown — the search
   *  and the Free/Plus filter both apply, so "Plus + Select all" picks every
   *  gated tool. Locked Plus rows are skipped, exactly as their disabled
   *  checkboxes are: a bulk action can't do what a hand can't. */
  const pickableVisible = visibleTools.filter((t) => !packageLocked(t)).map((t) => t.name);
  const allVisiblePicked =
    pickableVisible.length > 0 && pickableVisible.every((n) => picked.has(n));
  const noneVisiblePicked = pickableVisible.every((n) => !picked.has(n));

  const plan = useMemo(() => {
    const installed = sessionTools ?? new Set<string>();
    const adds = [...picked].filter((n) => !installed.has(n)).sort();
    const removes = [...installed].filter((n) => !picked.has(n)).sort();
    return { adds, removes };
  }, [picked, sessionTools]);

  const versionByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of session?.packages ?? []) m.set(p.name, p.version);
    return m;
  }, [session]);

  const syncSelection = useCallback(async () => {
    const names = [...core, ...picked];
    const status = await withOp("fns-store", "FNS store", () =>
      api.fnsSyncStore(names, true),
    );
    setStore(status);
    return status;
  }, [core, picked]);

  const downloadSelection = async () => {
    setBusy("download");
    setError(null);
    try {
      await syncSelection();
      onStatus(`FNS store stocked (${core.length + picked.size} packages + bootstrap)`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshStore = async () => {
    setBusy("refresh");
    setError(null);
    try {
      const status = await withOp("fns-store", "FNS store", () =>
        api.fnsSyncStore(null, true),
      );
      setStore(status);
      const m = await api.fnsManifest(false);
      setManifest(m.manifest);
      setManifestSource(m.source);
      setManifestBase(m.baseUrl);
      onStatus("FNS store refreshed — every artifact current");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Poll fns_status until the package set settles (or give up quietly). */
  const pollInstall = useCallback(
    (deadline: number) => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      pollTimer.current = window.setTimeout(() => {
        void (async () => {
          await refreshSession();
          if (Date.now() < deadline) pollInstall(deadline);
          else setInstalling(null);
        })();
      }, 3000);
    },
    [refreshSession],
  );

  useEffect(() => {
    if (!installing || !session) return;
    const want = new Set([...picked]);
    const have = sessionTools ?? new Set<string>();
    const settled =
      want.size === have.size && [...want].every((n) => have.has(n));
    if (settled) {
      setInstalling(null);
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      onStatus(`FNS install finished — ${session.packages?.length ?? 0} packages in ${session.root ?? "project"}`);
    }
  }, [session, sessionTools, installing, picked, onStatus]);

  const installIntoTarget = async () => {
    if (!target || !manifest) return;
    setBusy("install");
    setConfirming(false);
    setError(null);
    try {
      const status = await syncSelection();
      const selPath = await api.fnsWriteSelection([...picked]);
      // Store rail first, bundled copy as the cold-start fallback. A store
      // that has ever synced carries a fresher rail than we shipped with, so
      // it always wins; the bundle only rescues a machine that has never
      // synced, where there would otherwise be no installer AND no updater.
      const bootstrap = await api.fnsBootstrapPath();
      if (!bootstrap) {
        setError(
          "No FNSTools bootstrap available — refresh the store once while online.",
        );
        return;
      }
      const res = (await api.openProjectUtility(target.path, "fns_install", {
        selection: selPath,
        bootstrap,
      })) as FnsInstallReply;
      if (!res || res.ok === false) {
        setError(res?.error ?? "fns_install failed");
        return;
      }
      setInstalling(target.path);
      onStatus(
        res.bootstrapped
          ? `FNS bootstrap dropped into ${res.root} — installing ${core.length + picked.size} packages…`
          : `FNS install started in ${res.root}…`,
      );
      pollInstall(Date.now() + 120_000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const copyScript = async () => {
    if (!manifest) return;
    const text = textportScript(manifest, manifestBase, [...picked]);
    try {
      await navigator.clipboard.writeText(text);
      onStatus(
        "Install script copied — paste into a TouchDesigner Textport (Dialogs ▸ Textport and DATs)",
      );
    } catch {
      onStatus("Could not reach the clipboard");
    }
  };

  const release = manifest?.release ?? "";
  const meta = manifest?.category_meta ?? {};
  const actionMenuEntries: MenuEntry[] = [
    {
      label: busy === "download" ? "Downloading…" : "Download selection for offline use",
      hint: "no session",
      disabled: busy !== null,
      title: "Download core, the selected tools, and the bootstrap into the palette store",
      onSelect: () => void downloadSelection(),
    },
    {
      label: busy === "refresh" ? "Mirroring…" : "Mirror the whole release",
      hint: manifest ? `${tools.length + manifest.core.length} packages` : undefined,
      disabled: busy !== null,
      title: "Download every package in this release into the palette store",
      onSelect: () => void refreshStore(),
    },
    { type: "separator" },
    {
      label: "Copy Textport install script",
      title: "Copy one line that installs core and the current selection from a TouchDesigner Textport",
      onSelect: () => void copyScript(),
    },
    {
      label: "Open store folder",
      disabled: !store,
      title: store?.storeDir ?? "The store folder is not available yet",
      onSelect: () => {
        if (store) onOpenPath(store.storeDir);
      },
    },
  ];

  return (
    <div className="fns-pane panel">
      <div className="fns-toolbar">
        <strong>FNSTools</strong>
        {release && (
          <span className="fns-release" title={`Manifest ${manifestSource === "cache" ? "from local cache (offline?)" : "fresh from the bucket"}`}>
            {release}
            {manifestSource === "cache" ? " (cached)" : ""}
          </span>
        )}
        <button
          className="small"
          disabled={loading}
          onClick={() => void load(true)}
          title="Refresh catalog"
          aria-label="Refresh catalog"
        >
          {loading ? "…" : "⟳"}
        </button>
        {manifest?.notes && (
          <button className="small" onClick={() => setNotesOpen((v) => !v)}>
            {notesOpen ? "Hide notes" : "Release notes"}
          </button>
        )}
        <span className="spacer" />
        <div className="view-toggle" role="group" aria-label="FNS view">
          <button
            className={view === "store" ? "active" : ""}
            onClick={() => setView("store")}
          >
            Catalog
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            Tool settings
          </button>
        </div>
      </div>

      {error && <div className="fns-error">{error}</div>}
      {notesOpen && manifest?.notes && (
        <pre className="fns-notes">{manifest.notes}</pre>
      )}

      {!manifest && !loading && !error && (
        <div className="empty">No FNSTools catalog yet — refresh once while online.</div>
      )}

      {manifest && view === "store" && (
        <>
          <div className="fns-catalog-filter">
            <span className="fns-pitch">Show</span>
            <div className="view-toggle" role="group" aria-label="Filter tools by access tier">
              {(["all", "free", "plus"] as const).map((filter) => {
                const count = filter === "all"
                  ? searchedTools.length
                  : filter === "plus"
                    ? plusToolCount
                    : searchedTools.length - plusToolCount;
                const label = filter === "all" ? "All" : filter === "free" ? "Free" : "Plus";
                const title =
                  filter === "all"
                    ? "Show every tool"
                    : filter === "free"
                      ? "Hide the Patreon-gated (Plus) tools"
                      : "Show only the Patreon-gated (Plus) tools";
                return (
                  <button
                    key={filter}
                    type="button"
                    className={accessFilter === filter ? "active" : ""}
                    aria-pressed={accessFilter === filter}
                    title={title}
                    onClick={() => setAccessFilter(filter)}
                  >
                    {label} <span className="fns-filter-count">{count}</span>
                  </button>
                );
              })}
            </div>
            {/* Sign-in lives where the gated packages are, and only while
                some of them are locked for you -- never as a header badge:
                the launcher itself has no Plus features. */}
            {onPlusSignIn && searchedTools.some(packageLocked) && (
              <button
                type="button"
                className="small link fns-plus-signin"
                title="Function Store members get the Plus packages here — sign in with Patreon. FNSTools inside TouchDesigner has its own sign-in too."
                onClick={onPlusSignIn}
              >
                Sign in for Plus…
              </button>
            )}
            <span className="fns-pitch fns-select-label">Select</span>
            <div className="view-toggle" role="group" aria-label="Select the tools shown">
              <button
                type="button"
                disabled={pickableVisible.length === 0 || allVisiblePicked}
                title={
                  `Tick every tool shown (${pickableVisible.length}) — the search and ` +
                  `the Free/Plus filter both apply. Nothing installs until Apply.`
                }
                onClick={() => setPickedMany(pickableVisible, true)}
              >
                All
              </button>
              <button
                type="button"
                disabled={noneVisiblePicked}
                title={
                  "Untick every tool shown. Installed ones become removals — " +
                  "Apply lists them before anything goes."
                }
                onClick={() => setPickedMany(pickableVisible, false)}
              >
                None
              </button>
            </div>
          </div>
          <div className="fns-list">
            <div className="fns-cat">
              <div className="fns-cat-head" title="Installed with every selection — not optional">
                <span className="fns-glyph">{meta[CORE_CATEGORY]?.glyph ?? "◈"}</span>
                <strong>Core</strong>
                <span className="fns-pitch">
                  {meta[CORE_CATEGORY]?.pitch ?? "Installed as a unit."}
                </span>
                <span className="fns-core-names">
                  {core.join(" · ")}
                </span>
              </div>
            </div>
            {categories.map((cat) => {
              const inCat = visibleTools.filter((t) => t.category === cat);
              if ((search.trim() || accessFilter !== "all") && inCat.length === 0) return null;
              // Same rule as Select all, scoped to this category's shown rows.
              const catPickable = inCat.filter((t) => !packageLocked(t)).map((t) => t.name);
              const catAll = catPickable.length > 0 && catPickable.every((n) => picked.has(n));
              const catSome = !catAll && catPickable.some((n) => picked.has(n));
              return (
                <div className="fns-cat" key={cat}>
                  <div className="fns-cat-head">
                    <input
                      type="checkbox"
                      className="fns-cat-check"
                      checked={catAll}
                      disabled={catPickable.length === 0}
                      ref={(el) => {
                        if (el) el.indeterminate = catSome;
                      }}
                      aria-label={`Select every ${cat} tool shown`}
                      title={
                        catPickable.length === 0
                          ? "Nothing here can be picked — every tool shown is locked"
                          : catAll
                            ? `Untick the ${catPickable.length} ${cat} tool${catPickable.length === 1 ? "" : "s"} shown`
                            : `Tick the ${catPickable.length} ${cat} tool${catPickable.length === 1 ? "" : "s"} shown`
                      }
                      onChange={() => setPickedMany(catPickable, !catAll)}
                    />
                    <span className="fns-glyph">{meta[cat]?.glyph ?? ""}</span>
                    <strong>{cat}</strong>
                    {meta[cat]?.pitch && <span className="fns-pitch">{meta[cat].pitch}</span>}
                  </div>
                  {inCat.map((p) => {
                    const installedVersion = versionByName.get(p.name);
                    const updateAvailable =
                      !!installedVersion &&
                      !!p.version &&
                      installedVersion !== p.version;
                    const tier = fnsTierLabel(manifest, p);
                    const locked = packageLocked(p);
                    return (
                      <label
                        className={`fns-row${tier ? " fns-plus-row" : ""}${
                          picked.has(p.name) ? " is-picked" : ""
                        }${locked ? " fns-row-locked" : ""}`}
                        key={p.name}
                        title={
                          locked
                            ? `${p.description}\n\nUnlocks at the ${tier} tier${
                                supportUrl ? ` — ${supportUrl}` : ""
                              }`
                            : p.description
                        }
                      >
                        <input
                          type="checkbox"
                          checked={picked.has(p.name)}
                          disabled={locked}
                          onChange={() => togglePick(p.name)}
                        />
                        <span className="fns-name">{canonicalToolName(p.name)}</span>
                        {isCapability(p) && (
                          <span
                            className="fns-cap-badge"
                            title={
                              "Launcher capability — installing this adds it to the " +
                              "Sessions view for any session that has it. It is also a " +
                              "full TouchDesigner tool on its own, with the launcher closed."
                            }
                          >
                            capability
                          </span>
                        )}
                        {tier && (
                          <button
                            type="button"
                            className={`fns-tier-badge${locked ? "" : " owned"}`}
                            title={
                              locked
                                ? `Unlocks at the ${tier} tier — open ${supportUrl}`
                                : `Included with your ${tier} tier`
                            }
                            onClick={(e) => {
                              e.preventDefault();
                              if (locked) onOpenUrl(supportUrl);
                            }}
                          >
                            {locked ? `✦ ${tier}` : `✓ ${tier}`}
                          </button>
                        )}
                        <span className="fns-ver" title={
                          installedVersion
                            ? updateAvailable
                              ? `Installed ${installedVersion} → ${p.version} in this release`
                              : `Installed (${installedVersion})`
                            : `Release version ${p.version}`
                        }>
                          {installedVersion
                            ? updateAvailable
                              ? `${installedVersion} → ${p.version}`
                              : `✓ ${installedVersion}`
                            : p.version}
                        </span>
                        {storeDot(store, p.name)}
                        <span className="fns-desc">
                          {p.description}
                          {alternativesLabel(p) && (
                            <span className="fns-alt-hint" title={alternativesTitle(p)}>
                              {" "}
                              · {alternativesLabel(p)}
                            </span>
                          )}
                        </span>
                        {p.help_url && (
                          <button
                            type="button"
                            className="toolbox-mini"
                            title={`Docs — ${p.help_url}`}
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenUrl(p.help_url!);
                            }}
                          >
                            ?
                          </button>
                        )}
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="fns-footer">
            <span className="fns-count">
              {picked.size} tool{picked.size === 1 ? "" : "s"} + core
              {sessionTools
                ? ` · ${sessionTools.size} installed in ${target?.display_name}`
                : ""}
              {sessionTools && (plan.adds.length > 0 || plan.removes.length > 0)
                ? ` · +${plan.adds.length} −${plan.removes.length}`
                : ""}
            </span>
            {allTargets.length > 0 ? (
              <>
                <label>into</label>
                {allTargets.length === 1 ? (
                  <span className="patreon-target-single" title={allTargets[0].path}>
                    {allTargets[0].display_name}
                  </span>
                ) : (
                  <select
                    value={target?.path ?? ""}
                    title={target?.path}
                    onChange={(e) => {
                      setTargetPath(e.target.value);
                      setConfirming(false);
                    }}
                  >
                    {targets.map((p) => (
                      <option key={p.id} value={p.path}>
                        {p.display_name}
                      </option>
                    ))}
                    {companionless.length > 0 && (
                      <optgroup label="Needs the companion">
                        {companionless.map((p) => (
                          <option key={p.id} value={p.path}>
                            {p.display_name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
                {targetNeedsCompanion ? (
                  <span className="fns-needs-companion" data-hint="companion-missing">
                    <span className="fns-needs-companion-why">
                      No companion in this project — nothing can be installed into it.
                    </span>
                    {bundledUtilityTox ? (
                      <>
                        <span
                          className="companion-drag-tox draggable-tox"
                          draggable
                          onDragStart={(e) => onDragUtility(bundledUtilityTox, e)}
                          onMouseDown={(e) => {
                            if (isMac && e.button === 0) {
                              e.preventDefault();
                              onDragUtility(bundledUtilityTox);
                            }
                          }}
                          title="Drag into the root network of this project in TouchDesigner, then install"
                        >
                          ⠿ TDXLauncherUtility.tox
                        </span>
                        <button
                          type="button"
                          className="small"
                          onClick={() => onOpenPath(bundledUtilityTox)}
                        >
                          Reveal
                        </button>
                      </>
                    ) : (
                      <span className="fns-pitch">companion .tox not found in this build</span>
                    )}
                  </span>
                ) : !confirming ? (
                  <button
                    className="small primary"
                    disabled={busy !== null || installing !== null}
                    title={
                      sessionErr
                        ? `Session didn't answer fns_status (${sessionErr}) — install still possible; the plan just can't show removals`
                        : "Stock the store, then run the toolkit's installer in the session"
                    }
                    onClick={() => setConfirming(true)}
                  >
                    {installing
                      ? "Installing…"
                      : busy === "install"
                        ? "Starting…"
                        : `Install into ${target?.display_name ?? "session"}`}
                  </button>
                ) : (
                  <span className="fns-confirm">
                    {plan.adds.length > 0 && (
                      <span className="fns-adds" title={plan.adds.join(", ")}>
                        +{plan.adds.length}
                      </span>
                    )}
                    {plan.removes.length > 0 && (
                      <span
                        className="fns-removes"
                        title={`Will be REMOVED from the project: ${plan.removes.join(", ")}`}
                      >
                        −{plan.removes.length}
                      </span>
                    )}
                    {plan.adds.length === 0 && plan.removes.length === 0 && (
                      <span className="fns-pitch">re-install current set</span>
                    )}
                    {retiredInstalled.length > 0 && (
                      <span
                        className="fns-removes"
                        title={`Renamed by the toolkit and left in place: ${retiredInstalled.join(
                          ", ",
                        )}. Installing adds the new package beside each one; the old copy stays and is no longer updated. Remove it by hand once the new one works.`}
                      >
                        !{retiredInstalled.length} stale
                      </span>
                    )}
                    <button
                      className="small primary"
                      disabled={busy !== null}
                      onClick={() => void installIntoTarget()}
                    >
                      Confirm
                    </button>
                    <button className="small" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </span>
                )}
                {retiredInstalled.length > 0 && (
                  <span className="fns-needs-companion" data-hint="fns-renamed">
                    <span className="fns-needs-companion-why">
                      {retiredInstalled.join(", ")}{" "}
                      {retiredInstalled.length === 1 ? "was" : "were"} renamed by the
                      toolkit. Installing adds the new package alongside;{" "}
                      {retiredInstalled.length === 1 ? "the old copy" : "the old copies"}{" "}
                      stay in the project and no longer receive updates. Remove{" "}
                      {retiredInstalled.length === 1 ? "it" : "them"} by hand once the
                      new one works.
                    </span>
                  </span>
                )}
              </>
            ) : (
              <span className="fns-pitch">no session</span>
            )}
            <span className="spacer" />
            <button
              className="small"
              data-ctx-menu-trigger
              aria-haspopup="menu"
              aria-expanded={!!actionsMenuAt}
              title="More download and store actions"
              onClick={(e) => {
                if (actionsMenuAt) {
                  setActionsMenuAt(null);
                  return;
                }
                const r = e.currentTarget.getBoundingClientRect();
                setActionsMenuAt({ x: r.right, y: r.bottom + 4 });
              }}
            >
              ⋯
            </button>
          </div>
        </>
      )}

      {manifest && view === "settings" && (
        <FnsSettings
          target={target}
          liveTargets={targets}
          fnsLive={!!session?.config_registry}
          onStatus={onStatus}
          search={search}
        />
      )}
      <ContextMenu
        menu={actionsMenuAt ? { ...actionsMenuAt, entries: actionMenuEntries } : null}
        onClose={() => setActionsMenuAt(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings view

function FnsSettings({
  target,
  liveTargets,
  fnsLive,
  onStatus,
  search,
}: {
  target: OpenProject | null;
  /** Every live session with a companion -- probed before an OFFLINE write,
   *  because any of them running in global scope overwrites the file's
   *  sections on its next save. */
  liveTargets: OpenProject[];
  fnsLive: boolean;
  onStatus: (msg: string) => void;
  search: string;
}) {
  const [mode, setMode] = useState<"idle" | "live" | "offline">("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<FnsUiState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyPar, setBusyPar] = useState<string | null>(null);
  const [offlineDoc, setOfflineDoc] = useState<{
    path: string;
    exists: boolean;
    parsed: Record<string, unknown> | null;
    raw: string;
  } | null>(null);
  const [offlineDirty, setOfflineDirty] = useState(false);
  const [scopeBusy, setScopeBusy] = useState(false);
  /** The push/adopt choice is open -- flipping TO global must say what
   *  happens to the machine-wide file, and the registry refuses without it. */
  const [scopeConfirm, setScopeConfirm] = useState(false);
  /** Live global-scope sessions that would overwrite an offline write. */
  const [clobberWarn, setClobberWarn] = useState<string[] | null>(null);

  /** One switch for the whole toolkit: `project` flips quietly (the .toe
   *  becomes the store, nothing moves); `global` needs push (this project's
   *  settings overwrite the file) or adopt (the file's settings land here). */
  const flipScope = async (value: FnsConfigScope, mode?: "push" | "adopt") => {
    if (!url) return;
    setScopeBusy(true);
    setScopeConfirm(false);
    try {
      const res = await api.fnsSettingsScope(url, value, mode);
      if (!res.ok) {
        setErr(res.why ?? "scope change rejected");
        return;
      }
      setErr(null);
      onStatus(`Config scope: ${res.scope ?? value}${mode ? ` (${mode})` : ""}`);
      // adopt just changed the values on screen; a re-read is right either way
      setState(await api.fnsSettingsState(url));
    } catch (e) {
      setErr(String(e));
    } finally {
      setScopeBusy(false);
    }
  };

  /** Which live sessions are in global scope right now. Each one's next
   *  save replaces its tools' sections in the file wholesale, so an offline
   *  edit made while one is open is a write into a window that closes on
   *  that project's next Ctrl+S. A session that cannot answer cannot clobber. */
  const globalScopeSessions = async (): Promise<string[]> => {
    const hits: string[] = [];
    await Promise.all(
      liveTargets.map(async (t) => {
        try {
          const res = (await api.openProjectUtility(t.path, "fns_settings_url", {
            ensure: true,
          })) as { ok?: boolean; url?: string };
          if (!res?.ok || !res.url) return;
          const st = await api.fnsSettingsState(res.url);
          if (st.scope === "global") hits.push(t.display_name);
        } catch {
          /* no console in that session -> it is not writing the file */
        }
      }),
    );
    return hits;
  };

  const connectLive = useCallback(async (): Promise<boolean> => {
    if (!target) return false;
    setErr(null);
    try {
      const res = (await api.openProjectUtility(target.path, "fns_settings_url", {
        ensure: true,
      })) as { ok?: boolean; url?: string; error?: string };
      if (!res?.ok || !res.url) {
        setErr(res?.error ?? "settings server unavailable");
        return false;
      }
      setUrl(res.url);
      setState(await api.fnsSettingsState(res.url));
      setMode("live");
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    }
  }, [target]);

  const openOffline = useCallback(async () => {
    setErr(null);
    try {
      const doc = await api.fnsConfigRead();
      let parsed: Record<string, unknown> | null = null;
      if (doc.exists && doc.content.trim()) {
        try {
          parsed = JSON.parse(doc.content) as Record<string, unknown>;
        } catch (e) {
          setErr(`config JSON does not parse: ${e}`);
        }
      }
      setOfflineDoc({ path: doc.path, exists: doc.exists, parsed, raw: doc.content });
      setOfflineDirty(false);
      setMode("offline");
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    // Prefer the live surface when the target project carries the toolkit;
    // any failure there (old companion, server refused) falls back to the
    // offline editor rather than sitting on "Connecting…" forever.
    if (mode !== "idle") return;
    if (fnsLive && target) {
      void connectLive().then((ok) => {
        if (!ok) void openOffline();
      });
    } else {
      void openOffline();
    }
  }, [mode, fnsLive, target, connectLive, openOffline]);

  const setLivePar = async (tool: string, par: string, value: unknown) => {
    if (!url) return;
    setBusyPar(`${tool}.${par}`);
    try {
      const res: FnsUiSetReply = await api.fnsSettingsSet(url, tool, par, value);
      if (!res.ok) {
        setErr(`${tool}.${par}: ${res.why ?? "refused"}`);
      } else {
        setErr(null);
        setState(await api.fnsSettingsState(url));
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyPar(null);
    }
  };

  // ---- offline editing over the parsed config -------------------------
  const offlineTools = useMemo(() => {
    const t = offlineDoc?.parsed?.["tools"];
    return t && typeof t === "object" ? (t as Record<string, unknown>) : null;
  }, [offlineDoc]);

  const setOfflineVal = (tool: string, par: string, value: unknown) => {
    setOfflineDoc((prev) => {
      if (!prev?.parsed) return prev;
      const clone = JSON.parse(JSON.stringify(prev.parsed)) as Record<string, unknown>;
      const tools = clone["tools"] as Record<string, Record<string, unknown>>;
      const pars = tools[tool]?.["pars"] as Record<string, Record<string, unknown>>;
      if (pars?.[par]) {
        pars[par]["val"] = value;
        pars[par]["eval"] = value;
      }
      return { ...prev, parsed: clone };
    });
    setOfflineDirty(true);
  };

  const saveOffline = async (force = false) => {
    if (!offlineDoc?.parsed) return;
    if (!force) {
      const hits = await globalScopeSessions();
      if (hits.length > 0) {
        setClobberWarn(hits);
        return;
      }
    }
    setClobberWarn(null);
    try {
      await api.fnsConfigWrite(JSON.stringify(offlineDoc.parsed, null, 1));
      setOfflineDirty(false);
      onStatus(
        "FNS config saved — global-scope projects apply it at their next load; project-scope ones never read it",
      );
    } catch (e) {
      setErr(String(e));
    }
  };

  if (mode === "idle") {
    return <div className="empty">Connecting…</div>;
  }

  if (mode === "live" && state) {
    // Same fields the toolkit's own settings page searches: the tool's
    // canonical and public names, and every par's label, name and help --
    // plus page and menu labels, which are on the wire too. A tool matched
    // by NAME shows all its pars; otherwise only the pars that matched.
    const q = search.trim().toLowerCase();
    const parMatch = (g: FnsUiPar) =>
      g.label.toLowerCase().includes(q) ||
      g.name.toLowerCase().includes(q) ||
      (g.help ?? "").toLowerCase().includes(q) ||
      (g.page ?? "").toLowerCase().includes(q) ||
      (g.menuLabels ?? []).some((m) => m.toLowerCase().includes(q));
    const toolLabel = (t: FnsUiTool) => t.label ?? canonicalToolName(t.name);
    const toolNameMatch = (t: FnsUiTool) =>
      t.name.toLowerCase().includes(q) || toolLabel(t).toLowerCase().includes(q);
    const shown = state.tools
      .map((t) => {
        if (!q || toolNameMatch(t)) return { tool: t, pars: t.pars };
        const pars = t.pars.filter(parMatch);
        return pars.length ? { tool: t, pars } : null;
      })
      .filter((x): x is { tool: FnsUiTool; pars: FnsUiPar[] } => x !== null);
    const scope = state.scope;
    const scopeTitle =
      scope === "project"
        ? "Project scope: settings live in this .toe; the machine-wide config file is never read or written."
        : scope === "global"
          ? "Global scope: settings roam through the machine-wide config file; this project's saves overwrite the shared sections, last writer wins."
          : "Scope unknown -- an older ConfigRegistry that does not report it.";
    return (
      <div className="fns-list fns-settings">
        <div className="fns-settings-head">
          <span className={`fns-scope-badge ${scope ?? "unknown"}`} title={scopeTitle}>
            {scope ?? "scope ?"}
          </span>
          <span className="fns-pitch">
            {scope === "project"
              ? `Live in ${target?.display_name} — settings stay in this .toe; nothing here reaches the shared file.`
              : scope === "global"
                ? `Live in ${target?.display_name} — saves roam to every global-scope project on this machine.`
                : `Live — served by the toolkit in ${target?.display_name}.`}
          </span>
          <span className="spacer" />
          {scope === "global" && (
            <button
              className="small"
              disabled={scopeBusy}
              title="Keep this project's settings in its .toe and stop it adopting or overwriting the shared file. Nothing moves."
              onClick={() => void flipScope("project")}
            >
              {scopeBusy ? "…" : "Switch to project"}
            </button>
          )}
          {scope === "project" && !scopeConfirm && (
            <button
              className="small"
              disabled={scopeBusy}
              title="Roam this project's settings through the machine-wide file. You choose what happens to the file first."
              onClick={() => setScopeConfirm(true)}
            >
              {scopeBusy ? "…" : "Switch to global…"}
            </button>
          )}
          <button className="small" onClick={() => void connectLive()}>
            Reload
          </button>
          {url && (
            <button
              className="small"
              title={`${url} — the same page TD serves`}
              onClick={() => void api.openUrl(url)}
            >
              Open in browser
            </button>
          )}
        </div>
        {scopeConfirm && (
          <div className="fns-confirm fns-scope-confirm">
            <span>
              Global scope roams settings through the machine-wide config file.
              <strong> Push</strong> overwrites that file with this project's current settings;
              <strong> Adopt</strong> applies the file's existing settings onto this project.
            </span>
            <button className="small primary" disabled={scopeBusy} onClick={() => void flipScope("global", "push")}>
              Push to global
            </button>
            <button className="small" disabled={scopeBusy} onClick={() => void flipScope("global", "adopt")}>
              Adopt global
            </button>
            <button className="small" onClick={() => setScopeConfirm(false)}>
              Cancel
            </button>
          </div>
        )}
        {err && <div className="fns-error">{err}</div>}
        {shown.map(({ tool, pars }) => (
          <div className="fns-cat" key={tool.name}>
            <div className="fns-cat-head">
              <strong>{toolLabel(tool)}</strong>
              {tool.version && <span className="fns-ver">{tool.version}</span>}
              <span className="fns-pitch">{tool.path}</span>
            </div>
            {pars.map((par) => (
              <LiveParRow
                key={par.name}
                par={par}
                busy={busyPar !== null && busyPar.startsWith(`${tool.name}.`)}
                onSet={(name, value) => void setLivePar(tool.name, name, value)}
              />
            ))}
          </div>
        ))}
        {shown.length === 0 && (
          <div className="empty">{q ? "No matches." : "No registered tools expose settings."}</div>
        )}
      </div>
    );
  }

  // Offline mode (also the fallback when live failed).
  return (
    <div className="fns-list fns-settings">
      <div className="fns-settings-head">
        <span className="fns-pitch">
          Offline — editing the machine-wide config file. Global-scope projects
          apply it at their next load; a project set to project scope never
          reads it.{" "}
          {offlineTools && fileHasSchema(offlineTools)
            ? "Controls, labels and help come from the schema the toolkit writes beside each value."
            : "This file carries values only, so rows are guessed from the value type — go live for real controls and help."}
        </span>
        <span className="spacer" />
        {fnsLive && target && (
          <button className="small" onClick={() => void connectLive()}>
            Go live
          </button>
        )}
        <button className="small" onClick={() => void openOffline()}>
          Reload
        </button>
        <button
          className="small primary"
          disabled={!offlineDirty || !offlineDoc?.parsed}
          onClick={() => void saveOffline()}
        >
          Save
        </button>
      </div>
      {err && <div className="fns-error">{err}</div>}
      {clobberWarn && (
        <div className="fns-confirm fns-scope-confirm">
          <span>
            <strong>{clobberWarn.join(", ")}</strong>{" "}
            {clobberWarn.length === 1 ? "is" : "are"} open in global scope — the next
            save there overwrites these sections. Edit that project live instead, or
            save anyway.
          </span>
          <button className="small primary" onClick={() => void saveOffline(true)}>
            Save anyway
          </button>
          <button className="small" onClick={() => setClobberWarn(null)}>
            Cancel
          </button>
        </div>
      )}
      {!offlineTools && (
        <div className="empty">
          {offlineDoc?.exists
            ? "Config file has no tools section."
            : "No FNS config file yet — it appears once the toolkit runs in TouchDesigner."}
          {offlineDoc?.path && <div className="fns-pitch">{offlineDoc.path}</div>}
        </div>
      )}
      {offlineTools &&
        search.trim() &&
        !Object.entries(offlineTools).some(([name, entry]) => offlineToolVisible(name, entry, search)) && (
          <div className="empty">No matches.</div>
        )}
      {offlineTools &&
        Object.entries(offlineTools)
          .filter(([name, entry]) => offlineToolVisible(name, entry, search))
          .map(([name, entry]) => {
            const pars =
              entry && typeof entry === "object"
                ? ((entry as Record<string, unknown>)["pars"] as
                    | Record<string, Record<string, unknown>>
                    | undefined)
                : undefined;
            if (!pars) return null;
            const q = search.trim().toLowerCase();
            const nameHit =
              !q || name.toLowerCase().includes(q) || canonicalToolName(name).toLowerCase().includes(q);
            const rows = offlineRows(pars).filter((r) => nameHit || offlineRowMatch(r, q));
            if (rows.length === 0) return null;
            return (
              <div className="fns-cat" key={name}>
                <div className="fns-cat-head">
                  <strong>{canonicalToolName(name)}</strong>
                </div>
                {rows.map((row) => (
                  <OfflineParRow
                    key={row.key}
                    row={row}
                    onSet={(pname, v) => setOfflineVal(name, pname, v)}
                  />
                ))}
              </div>
            );
          })}
    </div>
  );
}

/** One `pars` record in the roaming config file. Values are always there;
 *  everything after `eval` is the schema FNSTools writes beside them since
 *  backlog 24 -- every field optional, because files written before that are
 *  still schema 1 and still valid. `min`/`max` appear only when the par is
 *  clamped: absent means unbounded, not zero. */
interface FileParRecord {
  mode?: string;
  val?: unknown;
  eval?: unknown;
  expr?: string;
  bindExpr?: string;
  label?: string;
  style?: string;
  page?: string;
  order?: number;
  help?: string;
  menuNames?: string[];
  menuLabels?: string[];
  min?: number;
  max?: number;
  /** Set on each component of a multi-par group (an RGB, a float3). */
  group?: string;
  groupLabel?: string;
}

/** One row the offline editor draws: a par, or a whole multi-par group
 *  folded back together the way the live page shows it. */
interface OfflineRow {
  key: string;
  label: string;
  help?: string;
  page?: string;
  style?: string;
  order: number;
  menuNames?: string[];
  menuLabels?: string[];
  min?: number;
  max?: number;
  parts: { name: string; rec: FileParRecord }[];
}

/** Fold a tool's file records into rows. Component pars carry `group`; the
 *  first one seen names the row (the file writes label/menus on the first
 *  par of a group). `Cf*` are the sync hatches, never value rows. Order by
 *  the file's `order` when present, else the file's own order. */
function offlineRows(pars: Record<string, unknown>): OfflineRow[] {
  const rows: OfflineRow[] = [];
  const byGroup = new Map<string, OfflineRow>();
  let seq = 0;
  for (const [name, raw] of Object.entries(pars)) {
    if (name.startsWith("Cf") || !raw || typeof raw !== "object") continue;
    const rec = raw as FileParRecord;
    const order = typeof rec.order === "number" ? rec.order : 1e6 + seq;
    seq += 1;
    if (rec.group) {
      const g = byGroup.get(rec.group);
      if (g) {
        g.parts.push({ name, rec });
        continue;
      }
      const row: OfflineRow = {
        key: rec.group,
        label: rec.groupLabel ?? rec.label ?? rec.group,
        help: rec.help,
        page: rec.page,
        style: rec.style,
        order,
        menuNames: rec.menuNames,
        menuLabels: rec.menuLabels,
        min: rec.min,
        max: rec.max,
        parts: [{ name, rec }],
      };
      byGroup.set(rec.group, row);
      rows.push(row);
      continue;
    }
    rows.push({
      key: name,
      label: rec.label ?? name,
      help: rec.help,
      page: rec.page,
      style: rec.style,
      order,
      menuNames: rec.menuNames,
      menuLabels: rec.menuLabels,
      min: rec.min,
      max: rec.max,
      parts: [{ name, rec }],
    });
  }
  return rows.sort((a, b) => a.order - b.order);
}

/** Does any record in this file carry schema? Decides the header sentence. */
function fileHasSchema(tools: Record<string, unknown>): boolean {
  for (const entry of Object.values(tools)) {
    const pars = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["pars"] : null;
    if (!pars || typeof pars !== "object") continue;
    for (const rec of Object.values(pars as Record<string, unknown>)) {
      if (rec && typeof rec === "object" && "style" in (rec as object)) return true;
    }
  }
  return false;
}

/** One live par row: control chosen from the registry's metadata. */
function LiveParRow({
  par,
  busy,
  onSet,
}: {
  par: FnsUiPar;
  busy: boolean;
  onSet: (name: string, value: unknown) => void;
}) {
  const single = par.pars.length === 1 ? par.pars[0] : null;
  return (
    <div className="fns-row fns-par-row" title={par.help || par.name}>
      <span className="fns-name">{par.label}</span>
      <span className="fns-par-controls">
        {par.pars.map((c) => {
          const disabled = busy || c.readonly;
          const title = c.readonly ? `${c.mode} mode — shown, not editable` : c.name;
          if (par.style === "Toggle") {
            return (
              <input
                key={c.name}
                type="checkbox"
                checked={!!c.val}
                disabled={disabled}
                title={title}
                onChange={(e) => onSet(c.name, e.target.checked)}
              />
            );
          }
          if ((par.style === "Menu" || par.style === "StrMenu") && single) {
            const names = par.menuNames ?? [];
            const labels = par.menuLabels ?? names;
            return (
              <select
                key={c.name}
                value={String(c.val ?? "")}
                disabled={disabled}
                title={title}
                onChange={(e) => onSet(c.name, e.target.value)}
              >
                {names.map((n, i) => (
                  <option key={n} value={n}>
                    {labels[i] ?? n}
                  </option>
                ))}
                {par.style === "StrMenu" &&
                  !names.includes(String(c.val ?? "")) && (
                    <option value={String(c.val ?? "")}>{String(c.val ?? "")}</option>
                  )}
              </select>
            );
          }
          if (typeof c.val === "number") {
            return (
              <input
                key={c.name}
                type="number"
                className="fns-num"
                defaultValue={c.val}
                min={par.min}
                max={par.max}
                step={par.style === "Int" ? 1 : "any"}
                disabled={disabled}
                title={title}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v) && v !== c.val) onSet(c.name, v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            );
          }
          return (
            <input
              key={c.name}
              type="text"
              className="fns-text"
              defaultValue={String(c.val ?? "")}
              disabled={disabled}
              title={title}
              onBlur={(e) => {
                if (e.target.value !== String(c.val ?? "")) onSet(c.name, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          );
        })}
      </span>
    </div>
  );
}

/** One offline par row: type inferred from the stored value; only
 *  CONSTANT-mode entries are writable (a bind's value lives elsewhere). */
const offlineRowMatch = (r: OfflineRow, q: string) =>
  r.label.toLowerCase().includes(q) ||
  r.parts.some((p) => p.name.toLowerCase().includes(q)) ||
  (r.help ?? "").toLowerCase().includes(q) ||
  (r.page ?? "").toLowerCase().includes(q) ||
  (r.menuLabels ?? []).some((m) => m.toLowerCase().includes(q));

/** Offline visibility of a tool section: its name, or any of its rows. */
function offlineToolVisible(name: string, entry: unknown, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q || name.toLowerCase().includes(q) || canonicalToolName(name).toLowerCase().includes(q)) return true;
  const pars =
    entry && typeof entry === "object"
      ? ((entry as Record<string, unknown>)["pars"] as Record<string, unknown> | undefined)
      : undefined;
  return !!pars && offlineRows(pars).some((r) => offlineRowMatch(r, q));
}

/** One offline row. With schema in the file the control matches the live
 *  page (toggle, menu, bounded number, text); without it, the value's type
 *  decides -- the same fallback the pre-schema editor always used. Every
 *  component of a group gets its own control on the one row. */
function OfflineParRow({
  row,
  onSet,
}: {
  row: OfflineRow;
  onSet: (parName: string, value: unknown) => void;
}) {
  const style = row.style;
  const title = row.help ? `${row.parts.map((p) => p.name).join(" ")} — ${row.help}` : row.parts.map((p) => p.name).join(" ");
  return (
    <div className="fns-row fns-par-row" title={title}>
      <span className="fns-name">{row.label}</span>
      <span className="fns-par-controls">
        {row.parts.map(({ name, rec }) => {
          const mode = String(rec.mode ?? "CONSTANT");
          const editable = mode === "CONSTANT";
          const val = rec.val;
          const ctlTitle = editable ? name : `${name}: ${mode.toLowerCase()} mode — edit in TD (or the bind master)`;
          const isToggle = style === "Toggle" || (!style && typeof val === "boolean");
          const isMenu = (style === "Menu" || style === "StrMenu") && !!row.menuNames?.length;
          // Int/Float by declaration; RGB, XYZ, UV and the rest by the value
          // itself -- a numeric component is a number whatever its group style.
          const isNumber =
            !isToggle && !isMenu && (style === "Int" || style === "Float" || typeof val === "number");
          if (isToggle) {
            return (
              <input
                key={name}
                type="checkbox"
                checked={!!val}
                disabled={!editable}
                title={ctlTitle}
                onChange={(e) => onSet(name, e.target.checked)}
              />
            );
          }
          if (isMenu) {
            return (
              <select
                key={name}
                className="fns-menu"
                value={String(val ?? "")}
                disabled={!editable}
                title={ctlTitle}
                onChange={(e) => onSet(name, e.target.value)}
              >
                {row.menuNames!.map((mn, i) => (
                  <option key={mn} value={mn}>
                    {row.menuLabels?.[i] ?? mn}
                  </option>
                ))}
              </select>
            );
          }
          if (isNumber) {
            return (
              <input
                key={name}
                type="number"
                className="fns-num"
                defaultValue={typeof val === "number" ? val : Number(val ?? 0)}
                step={style === "Int" ? 1 : "any"}
                min={row.min}
                max={row.max}
                disabled={!editable}
                title={ctlTitle}
                onBlur={(e) => {
                  const v = style === "Int" ? Math.round(Number(e.target.value)) : Number(e.target.value);
                  if (!Number.isNaN(v) && v !== val) onSet(name, v);
                }}
              />
            );
          }
          return (
            <input
              key={name}
              type="text"
              className="fns-text"
              defaultValue={String(val ?? "")}
              disabled={!editable}
              title={ctlTitle}
              onBlur={(e) => {
                if (e.target.value !== String(val ?? "")) onSet(name, e.target.value);
              }}
            />
          );
        })}
      </span>
      {row.parts.some((p) => String(p.rec.mode ?? "CONSTANT") !== "CONSTANT") && (
        <span className="fns-pitch">
          {Array.from(new Set(row.parts.map((p) => String(p.rec.mode ?? "CONSTANT").toLowerCase()).filter((m) => m !== "constant"))).join(" · ")}
        </span>
      )}
    </div>
  );
}
