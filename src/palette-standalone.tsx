/** The page TouchDesigner's Palette Browser shows in its TDXLU / Patreon
 * tabs (docs/palette-tabs.md). Served by the launcher's control server and
 * rendered by a Web Render TOP the companion injects into the dialog, so it is
 * a NARROW column (≥300 px) driven by forwarded mouse/keyboard — no OS drag,
 * no native dialogs, no Tauri `invoke`. Every action is "place into THIS
 * session" (`?sid=`), which the launcher turns into the same `load_tox` the
 * desktop Palette tab runs.
 *
 * Routes: `toolbox` | `fns` | `commands` live under the TDXLU tab (TD's own
 * palette is one tab over, so no palette-folder view here), `patreon` under
 * the Patreon tab. The companion switches tabs through
 * `window.__tdxluRoute(route)` (never the hash — the bearer token rides
 * there, `#k=…`, exactly like the phone control page). */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  FnsCommandList,
  FnsCommandParam,
  FnsManifestInfo,
  FnsPackage,
  FnsStoreStatus,
  FnsToolCommand,
  PatreonCampaign,
  PatreonToxFile,
  PatreonToxPost,
  SessionWindow,
  ToolboxTool,
  ToolboxView,
} from "./types";
import { windowLabelParts } from "./SessionWindows";
import { PatreonTrustNotice } from "./patreonCopy";
import { SUPPORT_JOIN_URL, fnsListedTools, fnsTierLabel } from "./fnsCatalog";
import { alternativesLabel, alternativesTitle, canonicalToolName, packageLandsInPane, withInstance } from "./utils";
import "./App.css";
import "./palette.css";

document.documentElement.classList.add("standalone", "palette-page");

// --- bootstrap: token + session -------------------------------------------

// The token arrives once, in the hash. Keep it in sessionStorage so a reload
// (the companion's Reload pulse, a browser-process restart) still works even
// if the hash was touched in the meantime.
const TOKEN_KEY = "tdxlu-palette-token";
const token = (() => {
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("k") ?? "";
  try {
    if (fromHash) {
      window.sessionStorage.setItem(TOKEN_KEY, fromHash);
      return fromHash;
    }
    return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return fromHash;
  }
})();
const sessionId = new URLSearchParams(window.location.search).get("sid") ?? "";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      msg = j.error || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const post = <T,>(path: string, body: unknown) =>
  apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Open a web page in the user's own browser. This page renders offscreen in
 *  TouchDesigner's CEF, so a plain link would go nowhere — the launcher opens
 *  it (https only). */
const openUrl = (url: string) => post<{ ok: boolean }>("/api/palette/open_url", { url });

// --- types ---------------------------------------------------------------

type Route = "toolbox" | "fns" | "commands" | "session" | "patreon";
const TDXLU_ROUTES: Route[] = ["toolbox", "fns", "commands", "session"];
const ROUTE_LABELS: Record<Route, string> = {
  toolbox: "Toolbox",
  fns: "FNS",
  commands: "Commands",
  session: "Session",
  patreon: "Patreon",
};

/** This session's companion against the one the launcher hands out. */
type CompanionInfo = {
  session_version: string | null;
  available_version: string;
  update_available: boolean;
};

// Patreon view preferences survive reloads (sessionStorage would die with
// the browser process, which the companion restarts on every tab switch).
const HIDE_LOCKED_KEY = "tdxlu-palette-hide-locked";

type Catalog = {
  ok: boolean;
  theme: string;
  /** Package names the entitlement claim covers — the FNS shelf's Plus rail
   *  renders a gated package locked unless it is named here (absent from a
   *  launcher that predates the field: nothing is treated as covered). */
  products?: string[];
  patreon_enabled: boolean;
  patreon_connected: boolean;
  /** Dismissed the "a .tox runs its creator's code" banner. Shared with the
   *  launcher window through the `patreon_trust_ack` pref. */
  patreon_trust_ack: boolean;
  toolbox: ToolboxView;
  fns: FnsManifestInfo | null;
  fns_error?: string | null;
  fns_store: FnsStoreStatus | null;
  companion?: CompanionInfo | null;
};

/** What the launcher resolves to a local .tox before `load_tox`. */
type Source =
  // `campaign` is optional context, not part of resolving: "Add to Palette"
  // uses it to pick the per-creator destination folder.
  | { kind: "local"; path: string; campaign?: string }
  | { kind: "toolbox"; id: string }
  | { kind: "url"; url: string }
  | { kind: "fns"; name: string }
  | { kind: "patreon"; url: string; filename: string; campaign: string };

type PlaceResult = {
  ok: boolean;
  error?: string;
  resolved_path?: string;
  /** Set when the package went through FNS_Installer instead of the pane. */
  installed?: boolean;
  root?: string;
  bootstrapped?: boolean;
};

/** `/api/palette/pin_selected` — the inverse of ↳. */
type PinResult = {
  ok: boolean;
  error?: string;
  id?: string;
  path?: string;
  name?: string;
  comp?: string;
  selected?: number;
  already_pinned?: boolean;
};

/** The companion's `autosave_get` reply (the fields the bar shows). */
type AutosaveState = {
  ok: boolean;
  error?: string;
  active?: boolean;
  interval?: number;
  mode?: string;
  status?: string;
  last_save?: string;
  next_in?: number | string;
  modified?: number;
  project_saved?: boolean;
};

/** `/api/sessions/perf?td=` — TD-internal stats from the companion's Perform CHOP. */
type PerfTd = {
  ok?: boolean;
  fps?: number | null;
  cook_ms?: number | null;
  dropped?: number | null;
  gpu_mem_mb?: number | null;
  gpu_mem_total_mb?: number | null;
};
type PerfReply = { ok: boolean; enabled: boolean; td?: PerfTd | null };

/** `/api/palette/git` — the launcher's GitStatus, the fields the drawer shows. */
type GitInfo = {
  ok?: boolean;
  error?: string;
  is_repo: boolean;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  summary: string;
};

/** `/api/palette/backup` — destination + what a backup run would copy. */
type BackupInfo = {
  ok?: boolean;
  error?: string;
  remote_root: string;
  remote_exists: boolean;
  local_file_count: number;
  to_remote: number;
  skipped: number;
  filtered: number;
  summary: string;
  gitignore_active: boolean;
};
type BackupRun = {
  ok?: boolean;
  error?: string;
  copied_to_remote: number;
  bytes_copied: number;
  errors: string[];
  summary: string;
};

/** `collect_save {dry_run: true}` — what Collect & Save would copy. */
type CollectPlanFile = {
  src: string;
  dest: string;
  category: string;
  bytes: number;
  reuse?: boolean;
  pars: string[];
  frozen_pars?: { par: string; expr: string }[];
};
type CollectPlan = {
  ok?: boolean;
  error?: string;
  files?: CollectPlanFile[];
  normalize?: { op: string; par: string; from: string; to: string }[];
  skipped?: { op?: string; par?: string; value?: string; reason?: string }[];
  total_bytes?: number;
  freeze_count?: number;
};
/** `collect_status` — the chunked run's progress. */
type CollectStatus = {
  ok?: boolean;
  phase?: string;
  error?: string | null;
  total_files?: number;
  done_files?: number;
  total_bytes?: number;
  done_bytes?: number;
  rewrites?: number;
  failed?: number;
  frozen_count?: number;
};

/** `repoint_assets {dry_run: true}` — relative refs a folder move broke. */
type RepointFix = { ref: string; op: string; par: string; from: string; to: string; file: string; name: string };
type RepointPlan = {
  ok?: boolean;
  error?: string;
  count?: number;
  fixes?: RepointFix[];
  unresolved?: { op: string; par: string; value: string }[];
  skipped?: { op?: string; par?: string; value?: string; reason?: string }[];
  in_backup_folder?: boolean;
};
type RepointResult = { ok?: boolean; error?: string; count?: number; attempted?: number; errors?: string[] };

/** `media_list` — every media reference in the project. */
type MediaRef = {
  ref: string;
  op: string;
  par: string;
  name: string;
  category: string;
  exists: boolean;
  bytes: number | null;
  sequence?: boolean;
  /** Absolute path the reference resolves to (forward slashes). */
  file?: string | null;
};
type MediaInventory = {
  ok?: boolean;
  error?: string;
  refs?: MediaRef[];
  files?: MediaRef[];
  count?: number;
  missing?: number;
  total_bytes?: number;
};
/** `media_pick_replace` / `media_pick_status` — TD's own file browser. */
type PickStatus = {
  ok?: boolean;
  error?: string;
  phase?: "idle" | "picking" | "done" | "cancelled" | "error";
  ref?: string;
  value?: string;
  inside?: boolean;
};

/** `/api/palette/phone` — Phone Remote reachability, no side effects. */
type PhoneInfo = {
  ok?: boolean;
  error?: string;
  /** "fns_remote": the session's own package answered (its QR, its token);
   *  "launcher": the launcher's control server, the fallback until D5. */
  source?: "fns_remote" | "launcher";
  running: boolean;
  lan: boolean;
  setting_lan: boolean;
  url: string | null;
  client_url?: string | null;
  loopback_url?: string | null;
  paired?: string | null;
  client_touch?: boolean | null;
};

/** `/api/palette/phone` for THIS session: FNS_Remote first, launcher fallback. */
const phoneInfoPath = () =>
  `/api/palette/phone${sessionId ? `?sid=${encodeURIComponent(sessionId)}` : ""}`;
/** `control_schema` — the COMPANION's exposed set. No longer a phone surface:
 *  since D5 it reaches only the desktop Current tab and this drawer, and this
 *  drawer hides it entirely when FNS_Remote answers (the package owns the
 *  exposed set for a session that has it). A phone gets the package's page. */
type ControlTarget = { key: string; path: string; name: string; builtin?: boolean; pars: unknown[] };
type ControlSchema = { ok?: boolean; error?: string; targets?: ControlTarget[]; hash?: string };
type SelectionReply = { ok?: boolean; error?: string; owner?: string | null; ops?: string[]; comps?: string[] };

/** `/api/palette/oswindows` — the session's real OS windows. */
type OsWindowsReply = { ok?: boolean; error?: string; pid?: number; windows?: SessionWindow[] };
/** `windows` (companion) — only the sidecar layout block is used here. */
type WindowLayoutReply = {
  ok?: boolean;
  error?: string;
  layout?: { items?: { path: string; open?: boolean }[]; apply_on_load?: boolean } | null;
};

// --- Media previews -----------------------------------------------------------
//
// The launcher serves the REAL file (the same route family the desktop's
// `media://` protocol serves its own WebView); nothing is resized or written
// to disk — the browser renders and scales it. An <img>/<video> cannot send
// the bearer, so each file gets a short-lived ticket minted with it.

const PREVIEW_IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const PREVIEW_VIDEO = /\.(mp4|m4v|webm|mov|avi|ogv|mkv)$/i;
const PREVIEW_AUDIO = /\.(mp3|wav|m4a|flac|oga|opus|aac)$/i;
type PreviewKind = "image" | "video" | "audio" | null;

function previewKind(file?: string | null): PreviewKind {
  if (!file) return null;
  if (PREVIEW_IMAGE.test(file)) return "image";
  if (PREVIEW_VIDEO.test(file)) return "video";
  if (PREVIEW_AUDIO.test(file)) return "audio";
  return null;
}

/** path → ticket URL (null = the launcher will not preview this one). */
const previewTickets = new Map<string, string | null>();

/** Rows load their preview only once they are near the visible part of the
 *  list — a project with hundreds of media references must not decode them
 *  all at once.
 *
 *  Measured by hand on scroll, NOT with IntersectionObserver and not with
 *  `loading="lazy"`: neither fires in this renderer. A fully visible element
 *  inside the scrolling column, observed with that column as root, produced
 *  no callback at all — the page is rendered offscreen (the Web Render TOP
 *  is an OSR client), and compositor-driven visibility never runs. Scroll
 *  events do fire, so a rect test on scroll is the reliable equivalent. */
const pendingThumbs = new Map<Element, () => void>();
const THUMB_MARGIN = 300;
let thumbScrollBound = false;
let thumbCheckQueued = false;

function checkThumbs() {
  thumbCheckQueued = false;
  const root = document.querySelector(".pt-body");
  if (!root) return;
  const rr = root.getBoundingClientRect();
  for (const [el, load] of [...pendingThumbs]) {
    if (!el.isConnected) {
      pendingThumbs.delete(el);
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.bottom >= rr.top - THUMB_MARGIN && r.top <= rr.bottom + THUMB_MARGIN) {
      pendingThumbs.delete(el);
      load();
    }
  }
}

function queueThumbCheck() {
  if (thumbCheckQueued) return;
  thumbCheckQueued = true;
  // A timer, not requestAnimationFrame: rAF (like IntersectionObserver and
  // loading="lazy") is compositor-driven and does not run while the page is
  // not being painted — a backgrounded browser tab, or a Web Render TOP
  // whose tab is not the one showing. Timers run either way.
  window.setTimeout(checkThumbs, 16);
}

function observePreview(el: Element, onVisible: () => void) {
  pendingThumbs.set(el, onVisible);
  if (!thumbScrollBound) {
    document.querySelector(".pt-body")?.addEventListener("scroll", queueThumbCheck, { passive: true });
    window.addEventListener("resize", queueThumbCheck);
    thumbScrollBound = true;
  }
  queueThumbCheck();
  return () => {
    pendingThumbs.delete(el);
  };
}

const CATEGORY_GLYPH: Record<string, string> = {
  movie: "▶",
  image: "▣",
  audio: "♪",
  font: "A",
  data: "▤",
  tox: "◻",
};

/** A row's preview: the file itself, small. Falls back to a category glyph
 *  when the type has no preview, the file is missing, or the browser cannot
 *  decode it (TD's CEF has no proprietary codecs — an H.264 .mov shows the
 *  glyph, a .webm plays). */
function Thumb({
  file,
  category,
  missing,
}: {
  file?: string | null;
  category?: string;
  missing?: boolean;
}) {
  const kind = missing ? null : previewKind(file);
  const [url, setUrl] = useState<string | null>(() => (file ? previewTickets.get(file) ?? null : null));
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!file || !kind || kind === "audio" || url) return;
    let stopped = false;
    const load = () => {
      const cached = previewTickets.get(file);
      if (cached !== undefined) {
        if (!stopped) setUrl(cached);
        return;
      }
      void post<{ ok?: boolean; url?: string }>("/api/palette/media/ticket", { path: file })
        .then((r) => {
          const u = r.ok === false ? null : (r.url ?? null);
          previewTickets.set(file, u);
          if (!stopped) setUrl(u);
        })
        .catch(() => {
          previewTickets.set(file, null);
          if (!stopped) setUrl(null);
        });
    };
    // Placeholder first, real file once the row is (nearly) on screen.
    const el = box.current;
    const stop = el ? observePreview(el, load) : (load(), () => {});
    return () => {
      stopped = true;
      stop();
    };
  }, [file, kind, url]);

  // A ticket outlives its TTL if the drawer stayed open: drop it and re-mint.
  const onError = () => {
    if (file && previewTickets.has(file) && !failed) {
      previewTickets.delete(file);
      setUrl(null);
      setFailed(true);
      return;
    }
    setFailed(true);
  };

  if (url && kind === "image" && !failed) {
    // No loading="lazy": a row below the fold would never load at all, and
    // these files come off the local disk through the launcher anyway.
    return <img className="pt-thumb" src={url} alt="" onError={onError} />;
  }
  if (url && kind === "video" && !failed) {
    return (
      <video className="pt-thumb" src={url} preload="metadata" muted playsInline onError={onError} />
    );
  }
  return (
    <span ref={box} className={`pt-thumb glyph${missing ? " missing" : ""}`} aria-hidden>
      {missing ? "✕" : CATEGORY_GLYPH[category ?? ""] ?? (kind === "audio" ? "♪" : "◻")}
    </span>
  );
}

const fmtMB = (bytes: number | null | undefined) =>
  typeof bytes === "number" ? `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : "–";

/** Short `parent/op.par` for a ref — the column is 300 px wide. */
const shortRef = (opPath: string, par: string) => {
  const parts = opPath.split("/").filter(Boolean);
  return `${parts.slice(-2).join("/")}.${par}`;
};

/** Run one FNS_CommandRegistry command in THIS session, by its stable
 *  `<owner COMP path>#<id>` key. This is the capability rail: what a tool
 *  announced, as opposed to a verb the companion itself implements. */
const commandRun = <T,>(key: string, kwargs?: Record<string, unknown>) =>
  post<T>("/api/palette/run", {
    path: sessionId,
    key,
    ...(kwargs ? { kwargs } : {}),
  });

/** Resolve a capability's commands in THIS session, mapping the ids this page
 *  wants onto their run keys. Null means the capability is not advertised —
 *  the package owning it is not installed — which callers must say out loud
 *  rather than fail quietly, since that is how the retired verbs went
 *  unnoticed. Each entry lists the ids to accept, first match wins. */
const capabilityKeys = async (
  capability: string,
  want: Record<string, string[]>,
): Promise<Record<string, string> | null> => {
  if (!sessionId) return null;
  // all=1: capability commands are usually registered hidden, and the
  // curated list would report an installed package as missing.
  const r = await apiFetch<FnsCommandList>(
    `/api/palette/commands?sid=${encodeURIComponent(sessionId)}&all=1`,
  );
  const cmds = (r.commands ?? []).filter((c) => c.capability === capability);
  if (!cmds.length) return null;
  const out: Record<string, string> = {};
  for (const [name, ids] of Object.entries(want)) {
    const key = ids.map((id) => cmds.find((c) => c.id === id)?.key).find(Boolean);
    if (key) out[name] = key;
  }
  return Object.keys(out).length ? out : null;
};

/** One of the free Companion-bar verbs, run in THIS session. */
const sessionCall = <T,>(action: string, payload?: unknown) =>
  post<T>("/api/palette/session", {
    path: sessionId,
    action,
    ...(payload ? { payload } : {}),
  });

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function matches(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const h = hay.toLowerCase();
  return q.split(/\s+/).every((t) => h.includes(t));
}

// --- app -----------------------------------------------------------------

function App() {
  const [route, setRoute] = useState<Route>(() => {
    const m = /^#\/(\w+)/.exec(window.location.hash);
    const r = m?.[1] as Route | undefined;
    return r && (TDXLU_ROUTES.includes(r) || r === "patreon") ? r : "toolbox";
  });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<{ text: string; warn?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped by the ⟳ button so views with their own fetch (Commands) reload too.
  const [refreshTick, setRefreshTick] = useState(0);
  const [updating, setUpdating] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const say = useCallback((text: string, warn = false) => {
    setToast({ text, warn });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), warn ? 6000 : 2500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const q = sessionId ? `?sid=${encodeURIComponent(sessionId)}` : "";
      const c = await apiFetch<Catalog>(`/api/palette/catalog${q}`);
      setCatalog(c);
      if (c.theme) document.documentElement.dataset.theme = c.theme;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
    void load();
  }, [load]);

  // The desktop's "Update utility" for this session: the launcher refreshes
  // its palette copy of the TOX and the companion repoints + reloads in
  // place. It hellos again afterwards (and gets this page re-pushed), so the
  // notice clears itself on the next catalog load.
  const updateCompanion = useCallback(async () => {
    if (!sessionId) return;
    setUpdating(true);
    try {
      const r = await post<{ ok?: boolean; error?: string; version?: string }>(
        "/api/palette/update_companion",
        { path: sessionId },
      );
      if (r.ok === false) throw new Error(r.error || "update failed");
      say(`Companion ${r.version ?? ""} sent — the session reloads it in place`.replace("  ", " "));
      window.setTimeout(() => void load(), 5000);
    } catch (e) {
      say(`Update: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setUpdating(false);
    }
  }, [say, load]);

  useEffect(() => {
    void load();
  }, [load]);

  // The companion's tab switch. "toolbox" means "the TDXLU tab" — keep
  // whichever TDXLU sub-tab the user was on rather than snapping back.
  useEffect(() => {
    const w = window as unknown as { __tdxluRoute?: (r: string) => void };
    w.__tdxluRoute = (r: string) => {
      setRoute((cur) => {
        if (r === "patreon") return "patreon";
        if (r === "toolbox" && TDXLU_ROUTES.includes(cur)) return cur;
        return (TDXLU_ROUTES as string[]).includes(r) ? (r as Route) : "toolbox";
      });
    };
    const onHash = () => {
      const m = /^#\/(\w+)/.exec(window.location.hash);
      if (m) w.__tdxluRoute?.(m[1]);
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      delete w.__tdxluRoute;
    };
  }, []);

  const place = useCallback(
    async (source: Source, label: string) => {
      if (!sessionId) {
        say("No session id in this page's URL — reconnect from the launcher", true);
        return;
      }
      const key = JSON.stringify(source);
      setBusy(key);
      try {
        const r = await post<PlaceResult>("/api/palette/place", { path: sessionId, source });
        if (r.ok === false) throw new Error(r.error || "place failed");
        if (r.installed) {
          say(
            r.bootstrapped
              ? `FNS bootstrap dropped into ${r.root ?? "the project"} — installing ${label}`
              : `Installing ${label} through FNSTools${r.root ? ` in ${r.root}` : ""}`,
          );
        } else {
          say(`Placed ${label}`);
        }
      } catch (e) {
        say(`${label}: ${e instanceof Error ? e.message : String(e)}`, true);
      } finally {
        setBusy(null);
      }
    },
    [say],
  );

  const fetchOnly = useCallback(
    async (source: Source, label: string) => {
      const key = JSON.stringify(source);
      setBusy(key);
      try {
        await post<{ ok: boolean; path: string }>("/api/palette/fetch", { source });
        say(`Fetched ${label}`);
        void load();
      } catch (e) {
        say(`${label}: ${e instanceof Error ? e.message : String(e)}`, true);
      } finally {
        setBusy(null);
      }
    },
    [say, load],
  );

  // The inverse of ↳: the session saves its selected COMP as a .tox into the
  // user palette's "TDXLU Toolbox" folder and the launcher pins it.
  const pinSelected = useCallback(
    async (category: string) => {
      if (!sessionId) {
        say("No session id in this page's URL — reconnect from the launcher", true);
        return;
      }
      setBusy("pin");
      try {
        const r = await post<PinResult>("/api/palette/pin_selected", { path: sessionId, category });
        if (r.ok === false) throw new Error(r.error || "pin failed");
        say(
          r.already_pinned
            ? `${r.name} was already pinned`
            : `Pinned ${r.name}${r.selected && r.selected > 1 ? ` (first of ${r.selected} selected)` : ""}`,
        );
        void load();
      } catch (e) {
        say(`Pin: ${e instanceof Error ? e.message : String(e)}`, true);
      } finally {
        setBusy(null);
      }
    },
    [say, load],
  );

  const isBusy = (source: Source) => busy === JSON.stringify(source);
  const sessionLabel = sessionId ? basename(sessionId) : "no session";
  const companion = catalog?.companion ?? null;
  const showUpdate = route !== "patreon" && !!companion?.update_available && !!sessionId;

  return (
    <div className="pt-root">
      <header className="pt-head">
        {route === "patreon" ? (
          <div className="pt-title">Patreon</div>
        ) : (
          <div className="pt-subtabs" role="tablist">
            {TDXLU_ROUTES.map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={route === r}
                className={route === r ? "on" : ""}
                onClick={() => setRoute(r)}
              >
                {ROUTE_LABELS[r]}
              </button>
            ))}
          </div>
        )}
        <div className="pt-searchrow">
          <input
            type="search"
            className="pt-search"
            placeholder={
              route === "patreon"
                ? "Filter creators / posts"
                : route === "commands"
                  ? "Filter commands"
                  : route === "session"
                    ? "Filter session tools"
                    : "Filter"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="pt-icon" title="Refresh" onClick={refresh}>
            ⟳
          </button>
        </div>
      </header>

      {showUpdate && companion && (
        <div className="pt-notice" role="status">
          <span className="pt-noticetext">
            Companion {companion.available_version} available
            {companion.session_version ? ` · this session runs ${companion.session_version}` : ""}
          </span>
          <button
            type="button"
            className="pt-place"
            title="Repoint this session's companion to the launcher's current TOX and reload it in place (custom parameter values are kept)"
            disabled={updating}
            onClick={() => void updateCompanion()}
          >
            {updating ? "…" : "Update"}
          </button>
        </div>
      )}

      <main className="pt-body">
        {error && (
          <div className="pt-error">
            {error}
            {!token && <div>No token in this page's URL — reconnect from the launcher.</div>}
          </div>
        )}
        {loading && !catalog && <div className="pt-muted">Loading…</div>}
        {catalog && route === "commands" && (
          <CommandsView search={search} say={say} refreshTick={refreshTick} />
        )}
        {catalog && route === "session" && (
          <SessionPanel search={search} say={say} refreshTick={refreshTick} />
        )}
        {catalog && route === "toolbox" && (
          <ToolboxList
            view={catalog.toolbox}
            search={search}
            isBusy={isBusy}
            onPlace={place}
            onFetch={fetchOnly}
            onPin={pinSelected}
            pinning={busy === "pin"}
          />
        )}
        {catalog && route === "fns" && (
          <FnsShelf
            info={catalog.fns}
            error={catalog.fns_error ?? null}
            store={catalog.fns_store}
            search={search}
            products={catalog.products ?? []}
            isBusy={isBusy}
            onPlace={place}
            onFetch={fetchOnly}
            say={say}
          />
        )}
        {catalog && route === "patreon" && (
          <PatreonView
            enabled={catalog.patreon_enabled}
            connected={catalog.patreon_connected}
            trustAck={catalog.patreon_trust_ack}
            search={search}
            isBusy={isBusy}
            onPlace={place}
            say={say}
          />
        )}
      </main>

      <SessionBar say={say} active={route !== "patreon"} />
      <footer className="pt-foot">
        <span className="pt-session" title={sessionId || undefined}>
          ↳ {sessionLabel}
        </span>
        {toast && <span className={toast.warn ? "pt-toast warn" : "pt-toast"}>{toast.text}</span>}
      </footer>
    </div>
  );
}

// --- Toolbox ---------------------------------------------------------------

function ToolboxList({
  view,
  search,
  isBusy,
  onPlace,
  onFetch,
  onPin,
  pinning,
}: {
  view: ToolboxView;
  search: string;
  isBusy: (s: Source) => boolean;
  onPlace: (s: Source, label: string) => void;
  onFetch: (s: Source, label: string) => void;
  onPin: (category: string) => void;
  pinning: boolean;
}) {
  const [pinCategory, setPinCategory] = useState("");
  const pinRow = (
    <div className="pt-pinrow" title="Save the COMP selected in the session's Network Editor as a .tox and pin it here">
      <select
        value={pinCategory}
        onChange={(e) => setPinCategory(e.target.value)}
        title="Toolbox category for the pinned component"
      >
        <option value="">(no category)</option>
        {view.categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <button type="button" className="pt-place pt-pin" disabled={pinning} onClick={() => onPin(pinCategory)}>
        {pinning ? "…" : "⇱ Pin selected COMP"}
      </button>
    </div>
  );
  const groups = useMemo(() => {
    const tools = view.tools.filter((t) => matches(`${t.label} ${t.source} ${t.category}`, search));
    const byCat = new Map<string, ToolboxTool[]>();
    for (const t of tools) {
      const cat = t.category || "";
      byCat.set(cat, [...(byCat.get(cat) ?? []), t]);
    }
    const order = ["", ...view.categories.filter((c) => byCat.has(c))];
    for (const c of byCat.keys()) if (!order.includes(c)) order.push(c);
    return order.filter((c) => byCat.has(c)).map((c) => ({ name: c, tools: byCat.get(c)! }));
  }, [view, search]);

  if (view.tools.length === 0) {
    return (
      <div className="pt-list">
        {pinRow}
        <div className="pt-muted">
          Your Toolbox is empty. Pin the COMP selected in the network above, or add tools in
          the launcher's Palette tab (＋ Tool), and they show up here.
        </div>
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="pt-list">
        {pinRow}
        <div className="pt-muted">Nothing matches “{search}”.</div>
      </div>
    );
  }

  return (
    <div className="pt-list">
      {pinRow}
      {groups.map((g) => (
        <section key={g.name || "__top"} className="pt-group">
          {g.name && <h3 className="pt-cat">{g.name}</h3>}
          {g.tools.map((t) => {
            const source: Source = { kind: "toolbox", id: t.id };
            const unfetched = t.kind === "url" && !t.resolvedPath;
            const disabled = t.missing || t.kind === "package";
            const title = t.missing
              ? "This tool's file is missing on disk"
              : t.kind === "package"
                ? "Package tools install from the launcher's Sessions card (Add to project…)"
                : unfetched
                  ? "Not fetched yet — click to download, then place"
                  : `Place ${t.label} into this session`;
            return (
              <div key={t.id} className={disabled ? "pt-row dim" : "pt-row"} title={t.notes || undefined}>
                <span className="pt-name">{t.label}</span>
                <span className={`pt-kind pt-kind-${t.kind}`}>{t.kind}</span>
                {unfetched && (
                  <button
                    type="button"
                    className="pt-mini"
                    title="Fetch into the tox cache without placing"
                    disabled={isBusy(source)}
                    onClick={() => onFetch(source, t.label)}
                  >
                    ☁
                  </button>
                )}
                <button
                  type="button"
                  className="pt-place"
                  title={title}
                  disabled={disabled || isBusy(source)}
                  onClick={() => onPlace(source, t.label)}
                >
                  {isBusy(source) ? "…" : "↳"}
                </button>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// --- FNS shelf --------------------------------------------------------------

/** Which rows the FNS shelf shows by access tier — the desktop FNSTools tab's
 *  All / Free / Plus toggle. Remembered in localStorage: the companion
 *  restarts this browser on every tab switch, so component state would not
 *  survive leaving the tab. */
type AccessFilter = "all" | "free" | "plus";
const FNS_ACCESS_KEY = "tdxlu-palette-fns-access";

function FnsShelf({
  info,
  error,
  store,
  search,
  products,
  isBusy,
  onPlace,
  onFetch,
  say,
}: {
  info: FnsManifestInfo | null;
  error: string | null;
  store: FnsStoreStatus | null;
  search: string;
  /** Package names the entitlement claim covers (the Plus rail). */
  products: string[];
  isBusy: (s: Source) => boolean;
  onPlace: (s: Source, label: string) => void;
  onFetch: (s: Source, label: string) => void;
  say: (text: string, warn?: boolean) => void;
}) {
  const [access, setAccess] = useState<AccessFilter>(() => {
    try {
      const v = localStorage.getItem(FNS_ACCESS_KEY);
      return v === "free" || v === "plus" ? v : "all";
    } catch {
      return "all";
    }
  });
  const pickAccess = (a: AccessFilter) => {
    setAccess(a);
    try {
      localStorage.setItem(FNS_ACCESS_KEY, a);
    } catch {
      /* private storage — the filter just won't be remembered */
    }
  };

  /** A gated package's tier label, or null for a free one (fnsCatalog). */
  const tierOf = useCallback((p: FnsPackage): string | null => fnsTierLabel(info?.manifest, p), [info]);
  const supportUrl = SUPPORT_JOIN_URL;

  const { groups, counts } = useMemo(() => {
    if (!info) return { groups: [], counts: { all: 0, free: 0, plus: 0 } };
    const present = new Map<string, boolean>();
    for (const a of store?.artifacts ?? []) {
      present.set(a.name.replace(/\.tox$/i, ""), a.present && a.shaOk !== false);
    }
    // The FNSTools tab's rule (fnsCatalog): no retired names, and no
    // unreleased previews unless the claim names them.
    const searched = fnsListedTools(info.manifest, products).filter((p) =>
      matches(`${p.name} ${p.category} ${p.description}`, search),
    );
    const plus = searched.filter((p) => tierOf(p) !== null).length;
    const pkgs = searched.filter((p) =>
      access === "plus" ? tierOf(p) !== null : access === "free" ? tierOf(p) === null : true,
    );
    const cats = info.manifest.categories ?? [];
    const byCat = new Map<string, FnsPackage[]>();
    for (const p of pkgs) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p]);
    const order = [...cats.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => !cats.includes(c))];
    return {
      counts: { all: searched.length, free: searched.length - plus, plus },
      groups: order.map((c) => ({
        name: c,
        glyph: info.manifest.category_meta?.[c]?.glyph ?? "",
        packages: byCat.get(c)!.map((p) => ({ pkg: p, cached: present.get(p.name) === true })),
      })),
    };
  }, [info, store, search, access, tierOf, products]);

  if (!info) {
    return (
      <div className="pt-muted">
        FNSTools manifest unavailable{error ? ` — ${error}` : ""}. Open the launcher's FNSTools
        tab once to cache it.
      </div>
    );
  }

  const openSupport = (tier: string) => {
    if (!supportUrl) {
      say(`Unlocks at the ${tier} tier`);
      return;
    }
    openUrl(supportUrl).then(
      () => say(`Opened the ${tier} tier page in your browser`),
      (e) => say(`Could not open ${supportUrl}: ${e instanceof Error ? e.message : String(e)}`, true),
    );
  };

  return (
    <div className="pt-list">
      <div className="pt-muted small">
        FNSTools {info.manifest.release} · ◆ in the store, ◇ downloads on click · ↳ places in
        the pane, ⊕ installs through FNSTools
      </div>
      <div className="pt-access" role="group" aria-label="Filter tools by access tier">
        {(["all", "free", "plus"] as const).map((a) => (
          <button
            key={a}
            type="button"
            className={access === a ? "active" : ""}
            aria-pressed={access === a}
            title={
              a === "all"
                ? "Show every tool"
                : a === "free"
                  ? "Hide the Patreon-gated (Plus) tools"
                  : "Show only the Patreon-gated (Plus) tools"
            }
            onClick={() => pickAccess(a)}
          >
            {a === "all" ? "All" : a === "free" ? "Free" : "Plus"}{" "}
            <span className="pt-access-count">{counts[a]}</span>
          </button>
        ))}
      </div>
      {groups.length === 0 && (
        <div className="pt-muted">
          {search.trim() ? `Nothing matches “${search}”` : "Nothing here"}
          {access !== "all" ? ` in ${access === "plus" ? "Plus" : "Free"}` : ""}.
        </div>
      )}
      {groups.map((g) => (
        <section key={g.name} className="pt-group">
          <h3 className="pt-cat">
            {g.glyph ? `${g.glyph} ` : ""}
            {g.name}
          </h3>
          {g.packages.map(({ pkg, cached }) => {
            const source: Source = { kind: "fns", name: pkg.name };
            const inPane = packageLandsInPane(pkg);
            const altLabel = alternativesLabel(pkg);
            // Plus rail, the desktop shelf's rule (fns-gate.md §4.2): a gated
            // package the claim doesn't name is locked for FETCHING only — a
            // copy already in the store stays placeable.
            const tier = tierOf(pkg);
            const locked = !!tier && !products.includes(pkg.name);
            const blocked = locked && !cached;
            return (
              <div
                key={pkg.name}
                className={`pt-row${tier ? " pt-plus" : ""}${blocked ? " locked" : ""}`}
                title={
                  blocked
                    ? `${pkg.description}\n\nUnlocks at the ${tier} tier${supportUrl ? ` — ${supportUrl}` : ""}`
                    : pkg.description
                }
              >
                <span className="pt-dot">{cached ? "◆" : "◇"}</span>
                <span className="pt-name">
                  {canonicalToolName(pkg.name)}
                  {altLabel && (
                    <span className="pt-alt" title={alternativesTitle(pkg)}>
                      {" "}
                      · {altLabel}
                    </span>
                  )}
                </span>
                {tier && (
                  <span
                    className={`pt-tier${locked ? "" : " owned"}`}
                    title={locked ? `Unlocks at the ${tier} tier` : `Included with your ${tier} tier`}
                  >
                    {locked ? "✦" : "✓"} {tier}
                  </span>
                )}
                <span className="pt-ver">{pkg.version}</span>
                {blocked ? (
                  <button
                    type="button"
                    className="pt-place"
                    title={`Unlocks at the ${tier} tier${supportUrl ? ` — open ${supportUrl}` : ""}`}
                    onClick={() => openSupport(tier!)}
                  >
                    ✦
                  </button>
                ) : (
                  <>
                    {!cached && (
                      <button
                        type="button"
                        className="pt-mini"
                        title="Download into the FNS palette store without placing"
                        disabled={isBusy(source)}
                        onClick={() => onFetch(source, pkg.name)}
                      >
                        ☁
                      </button>
                    )}
                    <button
                      type="button"
                      className="pt-place"
                      title={
                        inPane
                          ? `Place ${canonicalToolName(pkg.name)} into this pane${cached ? "" : " (downloads first)"}`
                          : `Install ${canonicalToolName(pkg.name)} through FNSTools — arrives where the toolkit puts it, recorded for updates${cached ? "" : " (downloads first)"}`
                      }
                      disabled={isBusy(source)}
                      onClick={() => onPlace(source, pkg.name)}
                    >
                      {isBusy(source) ? "…" : inPane ? "↳" : "⊕"}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// --- Cached-component search ------------------------------------------------

/** One hit from the launcher's cached-.tox index — see `patreon_index.rs`.
 *  `url` is absent for a file only the disk knows about (unpacked from a zip,
 *  or downloaded before the index existed); `localPath` is absent for one that
 *  still has to be downloaded. */
type SearchHit = {
  name: string;
  kind: string;
  url: string | null;
  localPath: string | null;
  campaignId: string | null;
  campaignName: string;
  postId: string | null;
  postTitle: string | null;
  publishedAt: string | null;
  canView: boolean;
  fromZip: string | null;
};

type SearchResult = {
  hits: SearchHit[];
  cachedCreators: number;
  newestAt: number;
  truncated: boolean;
};

/** The source a hit resolves through: its Patreon download url when there is
 *  one, otherwise the local file itself. Either way the creator name rides
 *  along, so "Add to Palette" files it in the same per-creator folder. */
function hitSource(h: SearchHit): Source {
  return h.url
    ? { kind: "patreon", url: h.url, filename: h.name, campaign: h.campaignName }
    : { kind: "local", path: h.localPath ?? "", campaign: h.campaignName };
}

// --- Context menu ----------------------------------------------------------

type MenuItem = { label: string; onSelect?: () => void; disabled?: boolean };
type MenuState = { x: number; y: number; title: string; items: MenuItem[] } | null;

/** A right-click menu sized for this panel, which is only ~314px wide: it is
 *  clamped into the viewport rather than left to run off an edge, where TD's
 *  Palette Browser would simply clip it.
 *
 *  Right-click reaches this page at all because the container's Panel Execute
 *  DAT forwards `rselect` to the Web Render TOP. CEF renders offscreen, so its
 *  own context menu never appears - this one is the only menu the user sees. */
function ContextMenu({ menu, close }: { menu: MenuState; close: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    // Measure after paint, then clamp. Parked off-screen for that first frame
    // so a menu near an edge never flashes in the wrong place.
    const el = ref.current;
    const w = el?.offsetWidth ?? 160;
    const h = el?.offsetHeight ?? 80;
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - w - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - h - 4)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Capture phase: a click anywhere dismisses, including on the row beneath.
    const onDown = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onDown, true);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="pt-menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="pt-menu-title" title={menu.title}>
        {menu.title}
      </div>
      {menu.items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="pt-menu-item"
          disabled={it.disabled}
          onClick={() => {
            close();
            it.onSelect?.();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// --- Patreon ----------------------------------------------------------------

function PatreonView({
  enabled,
  connected,
  trustAck,
  search,
  isBusy,
  onPlace,
  say,
}: {
  enabled: boolean;
  connected: boolean;
  /** Already dismissed the trust banner — here or in the launcher window. */
  trustAck: boolean;
  search: string;
  isBusy: (s: Source) => boolean;
  onPlace: (s: Source, label: string) => void;
  say: (text: string, warn?: boolean) => void;
}) {
  const [campaigns, setCampaigns] = useState<PatreonCampaign[] | null>(null);
  const [campaign, setCampaign] = useState<PatreonCampaign | null>(null);
  const [posts, setPosts] = useState<PatreonToxPost[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  // Mirrors `patreon_trust_ack` so the banner goes away on click; the pref is
  // what makes it stay gone — here and in the launcher window.
  const [trustDismissed, setTrustDismissed] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [hideLocked, setHideLocked] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(HIDE_LOCKED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleHideLocked = (next: boolean) => {
    setHideLocked(next);
    try {
      window.localStorage.setItem(HIDE_LOCKED_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const [menu, setMenu] = useState<MenuState>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Searching from the creator list searches every creator ever listed plus
  // everything already downloaded — a filename is what people remember, and
  // it rarely comes with the creator's name attached.
  const [cache, setCache] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const q = search.trim();
  // This tab places components into a running session, so it shows .tox only —
  // the same bar the post list applies. A .toe is a project and a .zip is an
  // archive; neither is something `load_tox` can accept.
  const hits = (cache?.hits ?? []).filter((h) => h.kind === "tox");
  const shownCampaigns = (campaigns ?? []).filter((c) => matches(c.name, search));
  useEffect(() => {
    if (!enabled || !connected || campaign || !q) {
      setCache(null);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      apiFetch<{ result: SearchResult }>(`/api/patreon/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (live) setCache(r.result);
        })
        .catch(() => {
          // Local lookup only — no answer is not worth an error toast.
          if (live) setCache(null);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [enabled, connected, campaign, q]);

  /** Copy the post's .tox straight into the user's TD palette - the tab one
   *  over - instead of into the session. Lands in the same per-creator folder
   *  the desktop's right-click "Add to Palette..." uses. */
  const addToPalette = (src: Source, name: string) => {
    say("Adding " + name + " to palette\u2026");
    // The session id rides along so the companion can reload TD's palette
    // tree; without it the .tox lands on disk but stays invisible until
    // TouchDesigner restarts.
    post<{ ok?: boolean; already?: boolean; dest_dir?: string; refreshed?: boolean }>(
      "/api/palette/palette_add",
      { source: src, path: sessionId },
    )
      .then((r) => {
        const where = (r.dest_dir ?? "").split(/[\\/]/).filter(Boolean).pop();
        const folder = where ? " (" + where + ")" : "";
        if (r.already) {
          say(name + " is already in the palette" + folder);
        } else {
          say(
            name + " \u2192 palette" + folder +
              (r.refreshed ? " \u2014 it's in the Palette tab now" : " \u2014 refresh TD's Palette tab to see it"),
          );
        }
      })
      .catch((e) => say(String(e), true));
  };

  useEffect(() => {
    if (!enabled || !connected || campaigns) return;
    setLoading(true);
    apiFetch<{ campaigns: PatreonCampaign[] }>("/api/patreon/campaigns")
      .then((r) => setCampaigns(r.campaigns))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [enabled, connected, campaigns]);

  const openCampaign = (c: PatreonCampaign) => {
    setCampaign(c);
    setPosts(null);
    setErr("");
    setLoading(true);
    // The name only rides along to file this listing under it in the search
    // index; that is what makes this creator findable by filename later.
    apiFetch<{ posts: PatreonToxPost[] }>(
      `/api/patreon/posts?campaign=${encodeURIComponent(c.id)}&name=${encodeURIComponent(c.name)}`,
    )
      .then((r) => setPosts(r.posts))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  };

  if (!enabled) return <div className="pt-muted">This launcher build has no Patreon import.</div>;
  if (!connected) {
    return (
      <div className="pt-muted">
        Connect Patreon in the launcher (Settings → Patreon) to browse creators' .tox files here.
        It uses your own Patreon login against Patreon's private web API — unofficial, and only
        what your account can already see.
      </div>
    );
  }

  const fileSource = (f: PatreonToxFile): Source => ({
    kind: "patreon",
    url: f.url,
    filename: f.name,
    campaign: campaign?.name ?? "Patreon",
  });

  // Only posts that actually carry a placeable .tox — this tab exists to
  // drop components into the session, not to read the feed.
  const shownPosts = (posts ?? []).filter(
    (p) =>
      p.toxFiles.some((f) => f.kind === "tox") &&
      (!hideLocked || p.canView) &&
      // The name on the .tox, not just the post title: creators rarely repeat
      // the filename in "New patron component!".
      matches(`${p.title} ${p.toxFiles.map((f) => f.name).join(" ")}`, search),
  );
  /** A post in the user's own browser — the only place a locked one can be
   *  read (or unlocked), and handy for any post. The desktop Patreon tab does
   *  the same on a locked row's click. */
  const openPost = (post: PatreonToxPost) =>
    openUrl(post.url).then(
      () => say("Opened the post on Patreon in your browser"),
      (e) => say(`Could not open the post: ${e instanceof Error ? e.message : String(e)}`, true),
    );

  const lockedHidden = (posts ?? []).filter(
    (p) => p.toxFiles.some((f) => f.kind === "tox") && !p.canView,
  ).length;

  return (
    <div className="pt-list">
      {/* Sticky: stays put while the list scrolls, so the way back is always one click away. */}
      <div className="pt-crumbs pt-sticky">
        <button
          type="button"
          className="pt-link"
          disabled={!campaign}
          onClick={() => {
            setCampaign(null);
            setPosts(null);
            setErr("");
          }}
        >
          Creators
        </button>
        {campaign && (
          <>
            <span>›</span>
            <span className="pt-crumb">{campaign.name}</span>
            <label
              className="pt-check"
              title={
                lockedHidden
                  ? `${lockedHidden} post${lockedHidden === 1 ? "" : "s"} your tier can't view`
                  : "Hide posts your tier can't view"
              }
            >
              <input
                type="checkbox"
                checked={hideLocked}
                onChange={(e) => toggleHideLocked(e.target.checked)}
              />
              Hide locked
            </label>
          </>
        )}
      </div>
      {!trustAck && !trustDismissed && (
        <PatreonTrustNotice
          variant="palette"
          busy={trustBusy}
          onDismiss={() => {
            setTrustBusy(true);
            post<{ ok: boolean }>("/api/palette/patreon_ack", { ack: true })
              .then(() => setTrustDismissed(true))
              .catch((e) => {
                setTrustBusy(false);
                say(String(e instanceof Error ? e.message : e), true);
              });
          }}
        />
      )}
      {err && <div className="pt-error">{err}</div>}
      {loading && <div className="pt-muted">Loading…</div>}
      {/* Cached components first: a filename search should answer with the
          component, not with a creator to go dig through. */}
      {!campaign && q && (
        <>
          <div className="pt-sectionhead">
            <span>Components</span>
            <span className="pt-sectioncount">{searching ? "…" : hits.length}</span>
          </div>
          {hits.length > 0
            ? hits.map((h) => {
                const src = hitSource(h);
                const busy = isBusy(src);
                const usable = h.canView || !!h.localPath;
                return (
                  <div
                    key={`${h.campaignName}/${h.localPath ?? h.url ?? h.name}`}
                    className={usable ? "pt-row pt-hit" : "pt-row pt-hit locked"}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        title: h.name,
                        items: [
                          {
                            label: "Add to Palette",
                            disabled: !usable,
                            onSelect: () => addToPalette(src, h.name),
                          },
                          {
                            label: "Place in this session",
                            disabled: !usable || busy,
                            onSelect: () => onPlace(src, h.name),
                          },
                        ],
                      });
                    }}
                  >
                    <span className="pt-hittext">
                      <span className="pt-name" title={h.localPath ?? h.name}>
                        {h.name}
                      </span>
                      <span className="pt-hitwhere">
                        {h.campaignName}
                        {h.postTitle ? " · " + h.postTitle : ""}
                      </span>
                    </span>
                    {h.localPath && (
                      <span className="pt-kind" title="Already downloaded">
                        disk
                      </span>
                    )}
                    <button
                      type="button"
                      className="pt-place"
                      title={usable ? `Place ${h.name} in this session` : "Your tier can't view this"}
                      disabled={!usable || busy}
                      onClick={() => onPlace(src, h.name)}
                    >
                      {busy ? "…" : "↳"}
                    </button>
                  </div>
                );
              })
            : !searching && (
                <div className="pt-muted">
                  {/* Downloads are always searched, so never claim nothing was
                      looked at — say what would widen the net instead. */}
                  {cache && cache.cachedCreators === 0
                    ? `No downloaded component matches “${q}”. Open a creator once and everything they post becomes searchable here too.`
                    : `No cached component matches “${q}”.`}
                </div>
              )}
          {shownCampaigns.length > 0 && (
            <div className="pt-sectionhead">
              <span>Creators</span>
              <span className="pt-sectioncount">{shownCampaigns.length}</span>
            </div>
          )}
        </>
      )}
      {!campaign &&
        campaigns &&
        shownCampaigns
          .map((c) => (
            <button key={c.id} type="button" className="pt-row pt-rowbtn" onClick={() => openCampaign(c)}>
              {c.avatarUrl ? (
                <img src={c.avatarUrl} alt="" className="pt-avatar" />
              ) : (
                <span className="pt-avatar blank">{c.name.slice(0, 1).toUpperCase()}</span>
              )}
              <span className="pt-name">{c.name}</span>
              {c.isOwn && <span className="pt-kind">you</span>}
            </button>
          ))}
      {campaign &&
        posts &&
        shownPosts.map((p) => {
            const files = p.toxFiles.filter((f) => f.kind === "tox");
            return (
              <section key={p.id} className={p.canView ? "pt-post" : "pt-post locked"}>
                <div className="pt-posttitle" title={p.publishedAt ?? undefined}>
                  {!p.canView && <span title="Your tier can't view this">🔒 </span>}
                  {p.title}
                  {!p.canView && p.url && (
                    <button
                      type="button"
                      className="pt-mini pt-openpost"
                      title="Your tier can't view this post — open it on Patreon in your browser"
                      onClick={() => void openPost(p)}
                    >
                      Open on Patreon ↗
                    </button>
                  )}
                </div>
                {files.map((f) => (
                  <div
                    key={f.url}
                    className="pt-row"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const src = fileSource(f);
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        title: f.name,
                        items: [
                          {
                            label: "Add to Palette",
                            disabled: !p.canView,
                            onSelect: () => addToPalette(src, f.name),
                          },
                          {
                            label: "Place in this session",
                            disabled: !p.canView || isBusy(src),
                            onSelect: () => onPlace(src, f.name),
                          },
                          {
                            label: "Open post on Patreon",
                            disabled: !p.url,
                            onSelect: () => void openPost(p),
                          },
                        ],
                      });
                    }}
                  >
                    <span className="pt-name" title={f.name}>
                      {f.name}
                    </span>
                    <button
                      type="button"
                      className="pt-place"
                      title={
                        p.canView
                          ? `Download and place ${f.name}`
                          : "Your tier can't view this — Open on Patreon ↗ above"
                      }
                      disabled={!p.canView || isBusy(fileSource(f))}
                      onClick={() => onPlace(fileSource(f), f.name)}
                    >
                      {isBusy(fileSource(f)) ? "…" : "↳"}
                    </button>
                  </div>
                ))}
              </section>
            );
          })}
      {campaign && posts && shownPosts.length === 0 && !loading && (
        <div className="pt-muted">
          {posts.length === 0
            ? "No posts found for this creator."
            : search.trim()
              ? `No .tox posts match “${search.trim()}”.`
              : hideLocked && lockedHidden > 0
                ? `Only locked .tox posts here (${lockedHidden} hidden).`
                : "This creator has no posts with a .tox attached."}
        </div>
      )}
      <ContextMenu menu={menu} close={closeMenu} />
    </div>
  );
}

// --- Commands (FNS_CommandRegistry) -----------------------------------------

type RunResult = { ok?: boolean; error?: string };

/** Toggle values cross the wire as "on"/"off" (the registry coerces by the
 *  declared style); everything else as the typed string. */
function paramInitial(p: FnsCommandParam, cmd: FnsToolCommand): string {
  // Live `current` first, then the single-param `state` reuse, then the
  // static default — the same seeding the quick-launch prompt does.
  const live = p.current ?? (cmd.params?.length === 1 ? cmd.state : undefined);
  const v = live ?? p.default;
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}

function stateChip(state: boolean | string | undefined) {
  if (state === undefined) return null;
  if (typeof state === "boolean") {
    return <span className={state ? "pt-chip on" : "pt-chip off"}>{state ? "ON" : "OFF"}</span>;
  }
  return <span className="pt-chip">{state}</span>;
}

function CommandsView({
  search,
  say,
  refreshTick,
}: {
  search: string;
  say: (text: string, warn?: boolean) => void;
  refreshTick: number;
}) {
  const [list, setList] = useState<FnsToolCommand[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setErr("No session id in this page's URL — reconnect from the launcher.");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const r = await apiFetch<FnsCommandList>(
        `/api/palette/commands?sid=${encodeURIComponent(sessionId)}`,
      );
      setList(r.commands ?? []);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const groups = useMemo(() => {
    const shown = (list ?? []).filter((c) =>
      matches(`${c.label} ${c.help ?? ""} ${c.tool} ${c.instance ?? ""}`, search),
    );
    // Favourites first (the user's own shortlist, across tools), then the
    // tools (in registry order), TD's built-ins last. A favourite moves INTO
    // that group rather than appearing twice.
    const out: { name: string; commands: FnsToolCommand[]; mixed?: boolean }[] = [];
    const favs = shown.filter((c) => c.favorite);
    if (favs.length) out.push({ name: "★ Favourites", commands: favs, mixed: true });
    const byTool = new Map<string, FnsToolCommand[]>();
    for (const c of shown) {
      if (c.favorite) continue;
      const g = c.builtin ? "TouchDesigner" : canonicalToolName(c.tool);
      byTool.set(g, [...(byTool.get(g) ?? []), c]);
    }
    const names = [...byTool.keys()].filter((n) => n !== "TouchDesigner");
    if (byTool.has("TouchDesigner")) names.push("TouchDesigner");
    for (const n of names) out.push({ name: n, commands: byTool.get(n)! });
    return out;
  }, [list, search]);

  // Pin / unpin: the launcher config is the one source of truth (the
  // quick-launch and Settings read the same list); patch locally first so
  // the row and the Favourites group move at once, revert if the write fails.
  const toggleFavorite = useCallback(
    async (cmd: FnsToolCommand) => {
      const identity = `${cmd.tool}#${cmd.id}`;
      const next = !cmd.favorite;
      const patch = (value: boolean) =>
        setList((l) =>
          (l ?? []).map((c) => (c.tool === cmd.tool && c.id === cmd.id ? { ...c, favorite: value } : c)),
        );
      patch(next);
      try {
        const r = await post<{ ok?: boolean; error?: string }>("/api/palette/favorite", {
          identity,
          favorite: next,
        });
        if (r.ok === false) throw new Error(r.error || "failed");
        say(next ? `★ ${cmd.label} pinned` : `${cmd.label} unpinned`);
      } catch (e) {
        patch(!next);
        say(`${cmd.label}: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
    [say],
  );

  const run = useCallback(
    async (cmd: FnsToolCommand, kwargs?: Record<string, string>) => {
      setRunning(cmd.key);
      try {
        const r = await post<RunResult>("/api/palette/run", {
          path: sessionId,
          key: cmd.key,
          ...(kwargs && Object.keys(kwargs).length ? { kwargs } : {}),
        });
        if (r.ok === false) throw new Error(r.error || "failed");
        say(`Ran ${withInstance(cmd.label, cmd.instance)}`);
        setOpen(null);
        // State chips are evaluated at listing time — re-list after a run.
        window.setTimeout(() => void load(), 300);
      } catch (e) {
        say(`${withInstance(cmd.label, cmd.instance)}: ${e instanceof Error ? e.message : String(e)}`, true);
      } finally {
        setRunning(null);
      }
    },
    [say, load],
  );

  const openParams = (cmd: FnsToolCommand, rowKey: string) => {
    if (open === rowKey) {
      setOpen(null);
      return;
    }
    const seed: Record<string, string> = {};
    for (const p of cmd.params ?? []) seed[`${cmd.key}:${p.name}`] = paramInitial(p, cmd);
    setValues((v) => ({ ...v, ...seed }));
    setOpen(rowKey);
  };

  const submitParams = (cmd: FnsToolCommand) => {
    const kwargs: Record<string, string> = {};
    for (const p of cmd.params ?? []) {
      const v = (values[`${cmd.key}:${p.name}`] ?? "").trim();
      // Empty = use the default / omit; a missing REQUIRED param is refused
      // registry-side with a param-named error, so no second validator here.
      if (v) kwargs[p.name] = v;
    }
    void run(cmd, kwargs);
  };

  if (err) return <div className="pt-error">{err}</div>;
  if (list === null) return <div className="pt-muted">{loading ? "Loading…" : ""}</div>;
  if (list.length === 0) {
    return (
      <div className="pt-muted">
        No tool commands in this session. Tools announce them to the session command registry (companion ≥
        0.11.0); the same list drives the launcher's quick-launch “?” prefix.
      </div>
    );
  }
  if (groups.length === 0) return <div className="pt-muted">Nothing matches “{search}”.</div>;

  return (
    <div className="pt-list">
      {groups.map((g) => (
        <section key={g.name} className="pt-group">
          <h3 className="pt-cat">{g.name}</h3>
          {g.commands.map((cmd) => {
            const hasParams = (cmd.params?.length ?? 0) > 0;
            // A favourite renders twice (its group and its tool's); the
            // open-form state is per rendering, not per command.
            const rowKey = `${g.name}:${cmd.key}`;
            const isOpen = open === rowKey;
            const busy = running === cmd.key;
            return (
              <div key={rowKey} className="pt-cmd">
                <div className="pt-row" title={cmd.help || undefined}>
                  <button
                    type="button"
                    className={`pt-star${cmd.favorite ? " on" : ""}`}
                    title={
                      cmd.favorite
                        ? "Favourite — click to unpin (also in the launcher's quick-launch)"
                        : "Pin as a favourite: first here and in the launcher's quick-launch"
                    }
                    onClick={() => void toggleFavorite(cmd)}
                  >
                    {cmd.favorite ? "★" : "☆"}
                  </button>
                  <span className="pt-name">
                    {withInstance(cmd.label, cmd.instance)}
                    {g.mixed && <span className="pt-tool"> · {cmd.builtin ? "TD" : canonicalToolName(cmd.tool)}</span>}
                  </span>
                  {stateChip(cmd.state)}
                  {hasParams && (
                    <span className="pt-kind" title="Asks for arguments before running">
                      {cmd.params!.length} arg{cmd.params!.length === 1 ? "" : "s"}
                    </span>
                  )}
                  <button
                    type="button"
                    className="pt-place"
                    title={hasParams ? "Set arguments and run" : `Run ${withInstance(cmd.label, cmd.instance)} in this session`}
                    disabled={busy}
                    onClick={() => (hasParams ? openParams(cmd, rowKey) : void run(cmd))}
                  >
                    {busy ? "…" : hasParams ? (isOpen ? "▾" : "▸") : "▶"}
                  </button>
                </div>
                {cmd.help && <div className="pt-help">{cmd.help}</div>}
                {isOpen && hasParams && (
                  <form
                    className="pt-params"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitParams(cmd);
                    }}
                  >
                    {cmd.params!.map((p) => {
                      const k = `${cmd.key}:${p.name}`;
                      const v = values[k] ?? "";
                      const set = (next: string) => setValues((all) => ({ ...all, [k]: next }));
                      const label = `${p.label || p.name}${p.required ? " *" : ""}`;
                      return (
                        <label key={p.name} className="pt-param" title={p.help || undefined}>
                          <span>{label}</span>
                          {p.style === "toggle" ? (
                            <input
                              type="checkbox"
                              checked={v === "on" || v === "1" || v === "true"}
                              onChange={(e) => set(e.target.checked ? "on" : "off")}
                            />
                          ) : p.style === "menu" ? (
                            <select value={v} onChange={(e) => set(e.target.value)}>
                              {!p.required && <option value="">(default)</option>}
                              {(p.menu ?? []).map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={p.style === "int" || p.style === "float" ? "number" : "text"}
                              step={p.style === "float" ? "any" : p.style === "int" ? 1 : undefined}
                              value={v}
                              placeholder={p.help || ""}
                              onChange={(e) => set(e.target.value)}
                            />
                          )}
                        </label>
                      );
                    })}
                    <div className="pt-paramrow">
                      <button type="submit" className="pt-place" disabled={busy}>
                        {busy ? "…" : "Run"}
                      </button>
                      <button type="button" className="pt-mini" onClick={() => setOpen(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// --- Session bar ---------------------------------------------------------------

const fmt = (v: number | null | undefined, digits = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "–";

/** The expanded session card's free verbs where you work: Save · Thumbnail · Preview video ·
 *  Autosave, plus an ambient health line (fps · cook · drops · GPU) while the
 *  launcher's Performance monitor setting is on. */
function SessionBar({ say, active }: { say: (text: string, warn?: boolean) => void; active: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState | null>(null);
  const [asKeys, setAsKeys] = useState<{ get: string; set: string } | null>(null);
  const [perf, setPerf] = useState<PerfTd | null>(null);
  const [perfEnabled, setPerfEnabled] = useState(true);
  const [dropsRising, setDropsRising] = useState(false);
  const lastDropped = useRef<number | null>(null);

  /** Autosave belongs to the FNS_Autosave package now, not the companion:
   *  the old `autosave_get` / `autosave_set` verbs were retired when the
   *  capability moved out. Find the blessed `fns.autosave` pair in the
   *  session's registry and read state through that. Nothing found means the
   *  package is not installed — the chip says so instead of failing quietly,
   *  which is how this survived the move unnoticed. */
  const refreshAutosave = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await apiFetch<FnsCommandList>(
        `/api/palette/commands?sid=${encodeURIComponent(sessionId)}&all=1`,
      );
      const cmds = (r.commands ?? []).filter((c) => c.capability === "fns.autosave");
      const byId = (id: string) => cmds.find((c) => c.id === id)?.key;
      const get = byId("autosave_get") ?? byId("autosave");
      const set = byId("autosave_set");
      if (!get || !set) {
        setAsKeys(null);
        setAutosave(null);
        return;
      }
      setAsKeys({ get, set });
      const s = await commandRun<AutosaveState>(get);
      if (s.ok !== false) setAutosave(s);
    } catch {
      /* no registry in this session — the chip stays generic */
    }
  }, []);

  /** Toggle through the capability's own set command. */
  const toggleAutosave = async () => {
    if (!asKeys) return;
    const turnOn = !autosave?.active;
    setBusy("autosave");
    try {
      const r = await commandRun<{ ok?: boolean; error?: string }>(asKeys.set, {
        active: turnOn,
      });
      if (r.ok === false) throw new Error(r.error || "failed");
      say(`Autosave ${turnOn ? "on" : "off"}`);
      void refreshAutosave();
    } catch (e) {
      say(`Autosave: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (active) void refreshAutosave();
  }, [active, refreshAutosave]);

  // Ambient health: poll while a launcher tab is showing. The launcher's
  // Settings toggle owns whether anything samples at all.
  useEffect(() => {
    if (!active || !sessionId || !perfEnabled) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await apiFetch<PerfReply>(`/api/sessions/perf?td=${encodeURIComponent(sessionId)}`);
        if (stopped) return;
        if (!r.enabled) {
          setPerfEnabled(false);
          return;
        }
        const td = r.td && r.td.ok !== false ? r.td : null;
        if (td && typeof td.dropped === "number") {
          setDropsRising(lastDropped.current != null && td.dropped > lastDropped.current);
          lastDropped.current = td.dropped;
        }
        setPerf(td);
      } catch {
        /* transient — keep the last line */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [active, perfEnabled]);

  const run = async (action: string, label: string, payload?: unknown) => {
    if (!sessionId) {
      say("No session id in this page's URL — reconnect from the launcher", true);
      return;
    }
    setBusy(action);
    try {
      const r = await sessionCall<{ ok?: boolean; error?: string; seconds?: number }>(action, payload);
      if (r.ok === false) throw new Error(r.error || "failed");
      say(
        action === "save"
          ? "Project saved"
          : action === "pulse"
            ? "Thumbnail updated (project icon + preview)"
            : action === "record"
              ? `Recording a ${r.seconds ?? ""}s preview…`.replace(" s ", " ")
              : `${label} done`,
      );
      if (action === "save") void refreshAutosave();
    } catch (e) {
      say(`${label}: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  if (!active) return null;
  const asOn = !!autosave?.active;
  const asLabel = autosave
    ? asOn
      ? `Autosave ${autosave.interval ?? ""}m`.replace(" m", "")
      : "Autosave off"
    : "Autosave";
  // One-shot verbs only; everything with its own panel lives in the Session
  // sub-tab, where it gets the whole column instead of a strip above the bar.
  return (
    <div className="pt-bar">
      <button
        type="button"
        className="pt-barbtn"
        disabled={busy !== null}
        title="Save the project in this session"
        onClick={() => void run("save", "Save")}
      >
        {busy === "save" ? "…" : "Save"}
      </button>
      <button
        type="button"
        className="pt-barbtn"
        disabled={busy !== null}
        title="Capture the project icon + preview image"
        onClick={() => void run("pulse", "Thumbnail")}
      >
        {busy === "pulse" ? "…" : "Thumbnail"}
      </button>
      <button
        type="button"
        className="pt-barbtn"
        disabled={busy !== null}
        title="Record a short preview video (length: the companion's Record page)"
        onClick={() => void run("record", "Preview video")}
      >
        {busy === "record" ? "…" : "Preview video"}
      </button>
      <button
        type="button"
        className={`pt-barbtn pt-as${asOn ? " on" : ""}`}
        disabled={busy !== null || !asKeys}
        title={
          asKeys && autosave
            ? `${autosave.status || (asOn ? "Autosave armed" : "Autosave off")}${
                autosave.last_save ? ` · last ${autosave.last_save}` : ""
              } — click to turn ${asOn ? "off" : "on"}`
            : "Autosave — install Autosave from the launcher's FNSTools tab"
        }
        onClick={() => void toggleAutosave()}
      >
        {busy === "autosave" ? "…" : asLabel}
      </button>
      {perf && (
        <span
          className={`pt-perf${dropsRising ? " warn" : ""}`}
          title="fps · cook ms · dropped frames · GPU memory used / total (Settings → Monitoring → Performance)"
        >
          {fmt(perf.fps)} fps · {fmt(perf.cook_ms, 1)} ms · {fmt(perf.dropped)} drop ·{" "}
          {fmt(perf.gpu_mem_mb)}/{fmt(perf.gpu_mem_total_mb)} MB
        </span>
      )}
    </div>
  );
}

// --- Session sub-tab ----------------------------------------------------------

type SessionTool = "collect" | "media" | "git" | "backup" | "phone" | "windows";
const SESSION_TOOLS: { key: SessionTool; label: string; glyph: string; hint: string }[] = [
  { key: "collect", label: "Collect & Save", glyph: "⇣", hint: "Copy every external file into collected/, relink, save" },
  { key: "media", label: "Media", glyph: "▣", hint: "What the project references, what is missing, re-root moved paths" },
  { key: "git", label: "Git", glyph: "⎇", hint: "Branch, changes, save & commit" },
  { key: "backup", label: "Backup", glyph: "⧉", hint: "Copy the project folder to the backup folder" },
  { key: "phone", label: "Phone Remote", glyph: "📱", hint: "The link as a QR, and what the phone's Control page exposes" },
  { key: "windows", label: "Windows", glyph: "▭", hint: "The session's windows: focus, minimize, layout" },
];

/** The session's tools as a list with live one-line summaries; each one
 *  takes over the whole column (crumb bar to come back), the same
 *  navigation the Patreon tab uses for creators → posts. */
function SessionPanel({
  search,
  say,
  refreshTick,
}: {
  search: string;
  say: (text: string, warn?: boolean) => void;
  refreshTick: number;
}) {
  const [view, setView] = useState<SessionTool | null>(null);
  const [sum, setSum] = useState<Partial<Record<SessionTool, string>>>({});

  // Overview summaries: the cheap reads only. Collect and Media scan the
  // project's files, so they scan when opened, not on every overview.
  useEffect(() => {
    if (view || !sessionId) return;
    let stopped = false;
    const q = encodeURIComponent(sessionId);
    const set = (k: SessionTool, v: string) => {
      if (!stopped) setSum((s) => ({ ...s, [k]: v }));
    };
    const fail = (k: SessionTool) => (e: unknown) => set(k, e instanceof Error ? e.message : String(e));
    void apiFetch<GitInfo>(`/api/palette/git?sid=${q}`)
      .then((g) => {
        const n = g.staged + g.unstaged + g.untracked;
        set(
          "git",
          !g.is_repo
            ? "not a repository"
            : `${g.branch ?? "HEAD"} · ${n ? `${n} change${n === 1 ? "" : "s"}` : "clean"}${g.ahead ? ` · ↑${g.ahead}` : ""}${
                g.behind ? ` · ↓${g.behind}` : ""
              }`,
        );
      })
      .catch(fail("git"));
    void apiFetch<PhoneInfo>(phoneInfoPath())
      .then((p) => set("phone", p.url ? "on the LAN — scan to connect" : p.running ? "loopback only" : "off"))
      .catch(fail("phone"));
    void apiFetch<OsWindowsReply>(`/api/palette/oswindows?sid=${q}`)
      .then((w) => {
        const ws = w.windows ?? [];
        const min = ws.filter((x) => x.minimized).length;
        set("windows", `${ws.length} window${ws.length === 1 ? "" : "s"}${min ? ` · ${min} minimized` : ""}`);
      })
      .catch(fail("windows"));
    void apiFetch<BackupInfo>(`/api/palette/backup?sid=${q}`)
      .then((b) => set("backup", b.to_remote ? `${b.to_remote} file${b.to_remote === 1 ? "" : "s"} to copy` : "up to date"))
      .catch(fail("backup"));
    return () => {
      stopped = true;
    };
  }, [view, refreshTick]);

  if (view) {
    const tool = SESSION_TOOLS.find((t) => t.key === view)!;
    const back = () => setView(null);
    return (
      <div className="pt-list">
        <div className="pt-crumbs pt-sticky">
          <button type="button" className="pt-link" onClick={back}>
            Session
          </button>
          <span>›</span>
          <span className="pt-crumb">{tool.label}</span>
        </div>
        <div className="pt-panel">
          {view === "collect" && <CollectDrawer say={say} onClose={back} />}
          {view === "media" && <MediaDrawer say={say} onClose={back} />}
          {view === "git" && <GitDrawer say={say} onClose={back} />}
          {view === "backup" && <BackupDrawer say={say} onClose={back} />}
          {view === "phone" && <PhoneDrawer say={say} onClose={back} />}
          {view === "windows" && <WindowsDrawer say={say} onClose={back} />}
        </div>
      </div>
    );
  }

  const rows = SESSION_TOOLS.filter((t) => matches(`${t.label} ${t.hint}`, search));
  if (!sessionId) return <div className="pt-muted">No session id in this page's URL — reconnect from the launcher.</div>;
  if (!rows.length) return <div className="pt-muted">Nothing matches “{search}”.</div>;
  return (
    <div className="pt-list">
      {rows.map((t) => (
        <button key={t.key} type="button" className="pt-row pt-rowbtn pt-sessionrow" title={t.hint} onClick={() => setView(t.key)}>
          <span className="pt-glyph">{t.glyph}</span>
          <span className="pt-text">
            <span className="pt-name">{t.label}</span>
            <span className="pt-sum">{sum[t.key] ?? (t.key === "collect" || t.key === "media" ? "scans when opened" : "…")}</span>
          </span>
          <span className="pt-chev">›</span>
        </button>
      ))}
    </div>
  );
}

// --- Git quick-commit drawer -----------------------------------------------

function GitDrawer({ say, onClose }: { say: (text: string, warn?: boolean) => void; onClose: () => void }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [err, setErr] = useState("");
  const [message, setMessage] = useState("");
  const [saveFirst, setSaveFirst] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setErr("");
    try {
      setInfo(await apiFetch<GitInfo>(`/api/palette/git?sid=${encodeURIComponent(sessionId)}`));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const commit = async () => {
    const msg = message.trim();
    if (!msg) {
      say("Write a commit message first", true);
      return;
    }
    setBusy(true);
    try {
      const r = await post<GitInfo>("/api/palette/git/commit", {
        path: sessionId,
        message: msg,
        save: saveFirst,
      });
      if (r.ok === false) throw new Error(r.error || "commit failed");
      say(`Committed on ${r.branch ?? "HEAD"}${saveFirst ? " (project saved first)" : ""}`);
      setMessage("");
      setInfo(r);
    } catch (e) {
      say(`Commit: ${e instanceof Error ? e.message : String(e)}`, true);
      void load();
    } finally {
      setBusy(false);
    }
  };

  const changes = info ? info.staged + info.unstaged + info.untracked : 0;
  return (
    <div className="pt-drawer">
      <div className="pt-drawerhead">
        <span className="pt-name">
          {err
            ? err
            : !info
              ? "Git…"
              : !info.is_repo
                ? "Not a git repository (create one in the launcher's Git panel)"
                : `${info.branch ?? "HEAD"} · ${changes ? `${changes} change${changes === 1 ? "" : "s"}` : "clean"}${
                    info.ahead ? ` · ↑${info.ahead}` : ""
                  }${info.behind ? ` · ↓${info.behind}` : ""}`}
        </span>
        <button type="button" className="pt-mini" title="Refresh" onClick={() => void load()}>
          ⟳
        </button>
        <button type="button" className="pt-mini" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {info?.is_repo && (
        <form
          className="pt-drawerrow"
          onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }}
        >
          <input
            type="text"
            value={message}
            placeholder="Commit message"
            onChange={(e) => setMessage(e.target.value)}
          />
          <label className="pt-check" title="Save the project in the session before committing">
            <input type="checkbox" checked={saveFirst} onChange={(e) => setSaveFirst(e.target.checked)} />
            save first
          </label>
          <button type="submit" className="pt-place pt-pin" disabled={busy || !message.trim()}>
            {busy ? "…" : "Commit all"}
          </button>
        </form>
      )}
    </div>
  );
}

// --- Collect & Save drawer ---------------------------------------------------

function CollectDrawer({ say, onClose }: { say: (text: string, warn?: boolean) => void; onClose: () => void }) {
  const [plan, setPlan] = useState<CollectPlan | null>(null);
  const [err, setErr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [freeze, setFreeze] = useState(true);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [showFiles, setShowFiles] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<CollectStatus | null>(null);
  const [keys, setKeys] = useState<Record<string, string> | null>(null);
  const pollGen = useRef(0);

  const scan = useCallback(async () => {
    if (!sessionId) return;
    setErr("");
    setScanning(true);
    try {
      const k = await capabilityKeys("fns.collect", {
        plan: ["collect", "plan"],
        apply: ["apply"],
        status: ["status"],
      });
      if (!k?.plan || !k.apply || !k.status) {
        setKeys(null);
        throw new Error(
          "Collect ships as the Collect package — install it from the launcher's FNSTools tab",
        );
      }
      setKeys(k);
      const p = (await commandRun<CollectPlan>(k.plan, { dry_run: true })) ?? ({} as CollectPlan);
      if (p.ok === false) throw new Error(p.error || "scan failed");
      setPlan(p);
      setExcluded(new Set());
    } catch (e) {
      setPlan(null);
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => {
    void scan();
    return () => {
      pollGen.current += 1; // a closed drawer stops polling
    };
  }, [scan]);

  const files = plan?.files ?? [];
  const included = files.filter((f) => !excluded.has(f.src));
  const toCopy = included.filter((f) => !f.reuse);
  const reuse = included.length - toCopy.length;
  const bytes = toCopy.reduce((n, f) => n + (f.bytes || 0), 0);
  const frozen = included.reduce((n, f) => n + (f.frozen_pars?.length ?? 0), 0);
  const normalize = plan?.normalize?.length ?? 0;
  const skipped = plan?.skipped?.length ?? 0;

  const run = async () => {
    const include = included.map((f) => f.src);
    if (!include.length && !normalize) {
      say("Nothing selected to collect", true);
      return;
    }
    setRunning(true);
    setStatus(null);
    try {
      if (!keys) throw new Error("Collect is not installed in this session");
      const started = await commandRun<{ ok?: boolean; error?: string; started?: boolean }>(keys.apply, {
        dry_run: false,
        expressions: freeze,
        include,
      });
      if (started.ok === false) throw new Error(started.error || "collect failed");
      if (!started.started) {
        say("Nothing external to collect");
        setRunning(false);
        return;
      }
      const gen = ++pollGen.current;
      const poll = async () => {
        if (gen !== pollGen.current) return;
        let s: CollectStatus | null = null;
        try {
          s = await commandRun<CollectStatus>(keys.status);
        } catch {
          s = null; // TD busy saving — keep polling
        }
        if (s) setStatus(s);
        const phase = s?.phase ?? "";
        if (phase === "error") {
          say(`Collect failed: ${s?.error ?? "unknown error"}`, true);
          setRunning(false);
          return;
        }
        if (phase === "done" || phase === "idle") {
          const failed = s?.failed ?? 0;
          const fz = s?.frozen_count ?? 0;
          say(
            phase === "idle"
              ? "Collect finished, project saved"
              : [
                  `Collected ${s?.done_files ?? 0}/${s?.total_files ?? 0} files`,
                  `${s?.rewrites ?? 0} refs relinked`,
                  fz ? `${fz} expressions frozen` : null,
                  "project saved",
                  failed ? `${failed} failed` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
            failed > 0,
          );
          setRunning(false);
          setStatus(null);
          void scan();
          return;
        }
        window.setTimeout(() => void poll(), 1000);
      };
      window.setTimeout(() => void poll(), 800);
    } catch (e) {
      say(`Collect: ${e instanceof Error ? e.message : String(e)}`, true);
      setRunning(false);
    }
  };

  const head = err
    ? err
    : running
      ? status?.phase === "copying"
        ? `Collecting ${status.done_files ?? 0}/${status.total_files ?? 0} · ${fmtMB(status.done_bytes)} / ${fmtMB(status.total_bytes)}`
        : status?.phase === "rewriting"
          ? "Relinking references…"
          : status?.phase === "saving"
            ? "Saving project…"
            : "Collecting…"
      : scanning && !plan
        ? "Scanning for external files…"
        : !plan
          ? "Collect"
          : !files.length && !normalize
            ? skipped
              ? `Nothing to collect · ${skipped} ref${skipped === 1 ? "" : "s"} skipped`
              : "Nothing external to collect"
            : [
                `${included.length}/${files.length} file${files.length === 1 ? "" : "s"}`,
                toCopy.length ? `${fmtMB(bytes)} to copy` : null,
                reuse ? `${reuse} already collected` : null,
                normalize ? `${normalize} path${normalize === 1 ? "" : "s"} to normalise` : null,
                skipped ? `${skipped} skipped` : null,
              ]
                .filter(Boolean)
                .join(" · ");

  return (
    <div className="pt-drawer">
      <div className="pt-drawerhead">
        <span className="pt-name" title={head}>
          {head}
        </span>
        {files.length > 0 && !running && (
          <button type="button" className="pt-mini" title="Show the files" onClick={() => setShowFiles((v) => !v)}>
            {showFiles ? "▾" : "▸"}
          </button>
        )}
        <button type="button" className="pt-mini" title="Rescan" disabled={running} onClick={() => void scan()}>
          ⟳
        </button>
        <button type="button" className="pt-mini" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {showFiles && !running && files.length > 0 && (
        <div className="pt-drawerlist">
          {files.map((f) => (
            <label key={f.src} className="pt-drawerfile" title={`${f.src}\n→ ${f.dest}`}>
              <input
                type="checkbox"
                checked={!excluded.has(f.src)}
                onChange={(e) =>
                  setExcluded((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.delete(f.src);
                    else n.add(f.src);
                    return n;
                  })
                }
              />
              <Thumb file={f.src} category={f.category} />
              <span className="pt-text">
                <span className="pt-name">{basename(f.src)}</span>
                <span className="pt-sum">{f.category}</span>
              </span>
              <span className="pt-kind">{f.reuse ? "have" : fmtMB(f.bytes)}</span>
            </label>
          ))}
        </div>
      )}
      {plan && (files.length > 0 || normalize > 0) && (
        <div className="pt-drawerrow">
          <label
            className="pt-check"
            title={
              frozen
                ? `${frozen} expression-driven path${frozen === 1 ? "" : "s"} would be frozen into the collected constant path`
                : "No expression-driven paths among the selected files"
            }
          >
            <input type="checkbox" checked={freeze} disabled={running} onChange={(e) => setFreeze(e.target.checked)} />
            freeze expressions{frozen ? ` (${frozen})` : ""}
          </label>
          <button
            type="button"
            className="pt-place pt-pin"
            disabled={running || (!included.length && !normalize)}
            title="Copy the selected files into collected/, relink every reference, save the project"
            onClick={() => void run()}
          >
            {running ? "…" : "Collect & save"}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Media drawer -------------------------------------------------------------

function MediaDrawer({ say, onClose }: { say: (text: string, warn?: boolean) => void; onClose: () => void }) {
  const [inv, setInv] = useState<MediaInventory | null>(null);
  const [plan, setPlan] = useState<RepointPlan | null>(null);
  const [err, setErr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<"fixes" | "missing" | null>(null);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<Record<string, string> | null>(null);

  const scan = useCallback(async () => {
    if (!sessionId) return;
    setErr("");
    setScanning(true);
    try {
      // The inventory is FNS_MediaBrowser's; re-rooting is still the
      // companion's own verb. Two rails in one scan, deliberately: the panel
      // stays useful for re-rooting when the package is absent.
      const k = await capabilityKeys("fns.media-browser", {
        list: ["list", "media"],
        pick_replace: ["pick_replace"],
        pick_status: ["pick_status"],
      });
      setKeys(k);
      const [i, p] = await Promise.all([
        k?.list ? commandRun<MediaInventory>(k.list).catch(() => null) : Promise.resolve(null),
        sessionCall<RepointPlan>("repoint_assets", { dry_run: true }),
      ]);
      if (p.ok === false) throw new Error(p.error || "scan failed");
      setInv(i && i.ok !== false ? i : null);
      setPlan(p);
      setExcluded(new Set());
    } catch (e) {
      setPlan(null);
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => {
    void scan();
  }, [scan]);

  const refs = inv?.refs ?? inv?.files ?? [];
  const missingRefs = refs.filter((r) => !r.exists && !r.sequence);
  const missing = inv?.missing ?? missingRefs.length;
  const fixes = plan?.fixes ?? [];
  const included = fixes.filter((f) => !excluded.has(f.ref));
  const unresolved = plan?.unresolved?.length ?? 0;

  // Click a media row -> TD's own file browser opens over TouchDesigner and
  // the reference is pointed at what you pick. The verb returns before the
  // dialog does (it is modal), so the outcome is polled.
  const replace = async (r: MediaRef) => {
    setBusy(true);
    try {
      if (!keys?.pick_replace || !keys.pick_status) {
        throw new Error(
          "Replace ships as the MediaBrowser package — install it from the launcher's FNSTools tab",
        );
      }
      const started = await commandRun<PickStatus & { started?: boolean }>(keys.pick_replace, {
        ref: r.ref,
      });
      if (started.ok === false) throw new Error(started.error || "cannot replace this one");
      say(`Pick a file for ${r.name} in TouchDesigner…`);
      const deadline = Date.now() + 120_000;
      const poll = async (): Promise<void> => {
        if (Date.now() > deadline) return;
        await new Promise((res) => window.setTimeout(res, 700));
        let s: PickStatus | null = null;
        try {
          s = await commandRun<PickStatus>(keys.pick_status);
        } catch {
          return poll(); // TD busy with the modal — keep waiting
        }
        if (s?.phase === "picking") return poll();
        if (s?.phase === "done") {
          say(`${r.name} → ${s.value ?? "new file"}${s.inside ? "" : " (outside the project)"} · not saved`);
          void scan();
        } else if (s?.phase === "error") {
          say(`Replace: ${s.error ?? "failed"}`, true);
        } else if (s?.phase === "cancelled") {
          say("Replace cancelled");
        }
      };
      await poll();
    } catch (e) {
      say(`Replace: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const reroot = async () => {
    const include = included.map((f) => f.ref);
    if (!include.length) return;
    setBusy(true);
    try {
      const r = await sessionCall<RepointResult>("repoint_assets", { include });
      if (r.ok === false) throw new Error(r.error || "repoint failed");
      const failed = r.errors?.length ?? 0;
      say(
        `Re-rooted ${r.count ?? 0} of ${r.attempted ?? include.length} path${include.length === 1 ? "" : "s"}${
          failed ? ` · ${failed} failed` : ""
        } · not saved — Save keeps it`,
        failed > 0,
      );
      void scan();
    } catch (e) {
      say(`Re-root: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const head = err
    ? err
    : scanning && !plan
      ? "Scanning media…"
      : !plan
        ? "Media"
        : [
            inv ? `${inv.count ?? refs.length} media ref${(inv.count ?? refs.length) === 1 ? "" : "s"}` : null,
            !keys ? "media list needs MediaBrowser" : null,
            missing ? `${missing} missing` : inv ? "all present" : null,
            fixes.length ? `${fixes.length} re-rootable` : null,
            unresolved ? `${unresolved} missing everywhere` : null,
            plan.in_backup_folder ? "opened from a backup folder" : null,
          ]
            .filter(Boolean)
            .join(" · ") || "No media references";

  return (
    <div className="pt-drawer">
      <div className="pt-drawerhead">
        <span className="pt-name" title={head}>
          {head}
        </span>
        {fixes.length > 0 && (
          <button
            type="button"
            className="pt-mini"
            title="Paths a folder move broke that a parent folder still resolves"
            onClick={() => setShow(show === "fixes" ? null : "fixes")}
          >
            {show === "fixes" ? "▾ fix" : `▸ fix ${fixes.length}`}
          </button>
        )}
        {missingRefs.length > 0 && (
          <button
            type="button"
            className={`pt-mini${show === "missing" ? " on" : ""}`}
            title="Show only the references whose file does not exist"
            onClick={() => setShow(show === "missing" ? null : "missing")}
          >
            missing
          </button>
        )}
        <button type="button" className="pt-mini" title="Rescan" disabled={busy} onClick={() => void scan()}>
          ⟳
        </button>
        <button type="button" className="pt-mini" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {show === "fixes" && fixes.length > 0 && (
        <div className="pt-drawerlist">
          {fixes.map((f) => (
            <label key={f.ref} className="pt-drawerfile" title={`${f.op}.${f.par}\n${f.from}\n→ ${f.to}`}>
              <input
                type="checkbox"
                checked={!excluded.has(f.ref)}
                onChange={(e) =>
                  setExcluded((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.delete(f.ref);
                    else n.add(f.ref);
                    return n;
                  })
                }
              />
              <span className="pt-name">{shortRef(f.op, f.par)}</span>
              <span className="pt-kind">{f.name}</span>
            </label>
          ))}
        </div>
      )}
      {refs.length > 0 && (
        <div className="pt-drawerlist">
          {(show === "missing" ? missingRefs : refs).map((r) => (
            <button
              key={r.ref}
              type="button"
              className={`pt-drawerfile pt-mediarow pt-rowbtn${r.exists ? "" : " missing"}`}
              disabled={busy}
              title={`${r.op}.${r.par}\n${r.file ?? ""}\n\nClick to replace this file (opens TouchDesigner's file browser)`}
              onClick={() => void replace(r)}
            >
              <Thumb file={r.file} category={r.category} missing={!r.exists && !r.sequence} />
              <span className="pt-text">
                <span className="pt-name">{r.name}</span>
                <span className="pt-sum">{shortRef(r.op, r.par)}</span>
              </span>
              <span className="pt-kind">
                {!r.exists && !r.sequence ? "missing" : r.sequence ? "sequence" : fmtMB(r.bytes)}
              </span>
            </button>
          ))}
        </div>
      )}
      {fixes.length > 0 && (
        <div className="pt-drawerrow">
          <span className="pt-muted small" style={{ flex: "1 1 auto", padding: 0 }}>
            Re-rooting rewrites the parameters only — Save afterwards to keep it.
          </span>
          <button
            type="button"
            className="pt-place pt-pin"
            disabled={busy || !included.length}
            title="Rewrite the selected relative paths so they resolve from this project folder"
            onClick={() => void reroot()}
          >
            {busy ? "…" : `Re-root ${included.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Phone Remote drawer -------------------------------------------------------

function PhoneDrawer({ say, onClose }: { say: (text: string, warn?: boolean) => void; onClose: () => void }) {
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(true);
  // Which of the package's two links the QR shows: the full page, or the
  // client page (exposed controls only). Only FNS_Remote has a client link.
  const [link, setLink] = useState<"author" | "client">("author");
  const [schema, setSchema] = useState<ControlSchema | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const fromPackage = info?.source === "fns_remote";
  const shownUrl = info ? (link === "client" && info.client_url ? info.client_url : info.url) : null;

  const load = useCallback(async () => {
    setErr("");
    try {
      setInfo(await apiFetch<PhoneInfo>(phoneInfoPath()));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
    if (sessionId) {
      try {
        const s = await sessionCall<ControlSchema>("control_schema");
        setSchema(s.ok === false ? { targets: [], error: s.error } : s);
      } catch (e) {
        setSchema({ targets: [], error: String(e instanceof Error ? e.message : e) });
      }
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Same renderer the desktop's Phone button uses; lazy so the page bundle
  // stays small for everyone who never opens this drawer.
  useEffect(() => {
    let cancelled = false;
    if (!shownUrl) {
      setQr(null);
      return;
    }
    void import("qrcode").then(({ toDataURL }) =>
      toDataURL(shownUrl, { width: 220, margin: 1 }).then((d) => {
        if (!cancelled) setQr(d);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [shownUrl]);

  const enable = async () => {
    setBusy("enable");
    try {
      const r = await post<{ ok?: boolean; error?: string; url?: string; source?: string }>(
        "/api/palette/phone/enable",
        sessionId ? { path: sessionId } : {},
      );
      if (r.ok === false) throw new Error(r.error || "could not start");
      say(
        r.source === "fns_remote"
          ? "FNS_Remote's pairing window is open in TouchDesigner"
          : "Phone Remote is on the LAN — scan the code",
      );
      await load();
    } catch (e) {
      say(`Phone Remote: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  const exposeSelected = async () => {
    setBusy("expose");
    try {
      const sel = await sessionCall<SelectionReply>("selection");
      const comp = sel.comps?.[0];
      if (!comp) throw new Error("select a COMP in a Network Editor first");
      const r = await sessionCall<{ ok?: boolean; error?: string; key?: string; already?: boolean }>("control_add", {
        comp,
      });
      if (r.ok === false) throw new Error(r.error || "expose failed");
      say(r.already ? `${basename(comp)} is already exposed` : `Exposed ${basename(comp)} on the phone`);
      await load();
    } catch (e) {
      say(`Expose: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (t: ControlTarget) => {
    setBusy(t.key);
    try {
      const r = await sessionCall<{ ok?: boolean; error?: string }>("control_remove", { key: t.key });
      if (r.ok === false) throw new Error(r.error || "remove failed");
      say(`${t.name} no longer exposed`);
      await load();
    } catch (e) {
      say(`Remove: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  const targets = schema?.targets ?? [];
  const head = err
    ? err
    : !info
      ? "Phone Remote…"
      : fromPackage
        ? info.url
          ? "FNS_Remote on the LAN"
          : info.running
            ? "FNS_Remote serving on this machine only"
            : "FNS_Remote is off"
        : info.url
          ? `Phone Remote on the LAN · ${targets.length} exposed`
          : info.running
            ? "Control server running on loopback only"
            : "Phone Remote is off";

  return (
    <div className="pt-drawer">
      <div className="pt-drawerhead">
        <span className="pt-name" title={info?.url || head}>
          {head}
        </span>
        {info?.url && info.client_url && (
          <button
            type="button"
            className="pt-mini"
            title={
              link === "client"
                ? "Showing the client link (exposed controls only) — switch to the full page"
                : "Showing the full page — switch to the client link (exposed controls only)"
            }
            onClick={() => setLink((v) => (v === "client" ? "author" : "client"))}
          >
            {link === "client" ? "client" : "full"}
          </button>
        )}
        {info?.url && (
          <button type="button" className="pt-mini" title="Show / hide the QR code" onClick={() => setShowQr((v) => !v)}>
            {showQr ? "▾" : "▸"} QR
          </button>
        )}
        <button type="button" className="pt-mini" title="Refresh" onClick={() => void load()}>
          ⟳
        </button>
        <button type="button" className="pt-mini" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {info && !info.url && (
        <div className="pt-drawerrow">
          <span className="pt-muted small" style={{ flex: "1 1 auto", padding: 0 }}>
            {fromPackage
              ? "Opens FNS_Remote's pairing window in TouchDesigner; turn on LAN there to scan from a phone."
              : "Binds the launcher's control server to your LAN (same as the desktop's Phone button)."}
          </span>
          <button
            type="button"
            className="pt-place pt-pin"
            disabled={busy !== null}
            onClick={() => void enable()}
          >
            {busy === "enable" ? "…" : fromPackage ? "Open pairing…" : "Turn on"}
          </button>
        </div>
      )}
      {shownUrl && showQr && qr && (
        <div className="pt-qr" title={shownUrl}>
          <img src={qr} alt="Phone Remote QR code" />
          <span className="pt-muted small">{shownUrl.replace(/#.*$/, "")}</span>
        </div>
      )}
      {fromPackage && (
        <div className="pt-muted small">
          Exposed COMPs are managed on the phone page itself (FNS_Remote).
        </div>
      )}
      {schema && !fromPackage && (
        <>
          {schema.error && <div className="pt-muted small">{schema.error}</div>}
          {targets.length > 0 && (
            <div className="pt-drawerlist">
              {targets.map((t) => (
                <div key={t.key} className="pt-drawerfile" title={t.path}>
                  <span className="pt-name">{t.name}</span>
                  <span className="pt-kind">
                    {t.pars.length} par{t.pars.length === 1 ? "" : "s"}
                    {t.builtin ? " · built-in" : ""}
                  </span>
                  {!t.builtin && (
                    <button
                      type="button"
                      className="pt-mini"
                      title="Stop exposing this COMP"
                      disabled={busy !== null}
                      onClick={() => void remove(t)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="pt-drawerrow">
            <span className="pt-muted small" style={{ flex: "1 1 auto", padding: 0 }}>
              {targets.length ? "" : "Nothing exposed yet — select a COMP and expose it."}
            </span>
            <button
              type="button"
              className="pt-place pt-pin"
              disabled={busy !== null}
              title="Put the COMP selected in the Network Editor on the phone's Control page"
              onClick={() => void exposeSelected()}
            >
              {busy === "expose" ? "…" : "📱 Expose selected COMP"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- Windows drawer ------------------------------------------------------------

/** The desktop's Windows feature, in the palette: the session's real OS
 *  windows (main, torn-off panes labelled by what they show, perform) with
 *  focus / minimize / restore and raise-all / minimize-all, plus the
 *  companion's sidecar window layout (save / apply / clear). */
function WindowsDrawer({ say, onClose }: { say: (text: string, warn?: boolean) => void; onClose: () => void }) {
  const [os, setOs] = useState<OsWindowsReply | null>(null);
  const [layout, setLayout] = useState<WindowLayoutReply | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [armClear, setArmClear] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setErr("");
    try {
      const [w, l] = await Promise.all([
        apiFetch<OsWindowsReply>(`/api/palette/oswindows?sid=${encodeURIComponent(sessionId)}`),
        sessionCall<WindowLayoutReply>("windows").catch(() => null),
      ]);
      if (w.ok === false) throw new Error(w.error || "window scan failed");
      setOs(w);
      setLayout(l && l.ok !== false ? l : null);
    } catch (e) {
      setOs(null);
      setErr(String(e instanceof Error ? e.message : e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // One OS window, or the whole session — the launcher does the OS call.
  const osAct = async (key: string, label: string, body: { id?: number; pid?: number; action: string }) => {
    setBusy(key);
    try {
      const r = await post<{ ok?: boolean; error?: string }>("/api/palette/oswindows/action", body);
      if (r.ok === false) throw new Error(r.error || "failed");
      say(label);
      // Foreground / minimized flags settle a beat after the OS call.
      window.setTimeout(() => void load(), 400);
    } catch (e) {
      say(`${label}: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  // Companion layout verbs (sidecar `windows` block).
  const act = async (key: string, label: string, action: string, payload?: unknown, after?: (r: Record<string, unknown>) => string) => {
    setBusy(key);
    try {
      const r = await sessionCall<Record<string, unknown> & { ok?: boolean; error?: string }>(action, payload);
      if (r.ok === false) throw new Error(r.error || "failed");
      say(after ? after(r) : `${label} done`);
      await load();
    } catch (e) {
      say(`${label}: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  const windows = os?.windows ?? [];
  const pid = os?.pid;
  const minimized = windows.filter((w) => w.minimized).length;
  const layoutItems = layout?.layout?.items?.length ?? 0;
  const sessionName = sessionId ? basename(sessionId) : "";
  const head = err
    ? err
    : !os
      ? "Windows…"
      : `${windows.length} window${windows.length === 1 ? "" : "s"}${minimized ? ` · ${minimized} minimized` : ""} · ${
          layoutItems ? `layout saved (${layoutItems})` : "no saved layout"
        }`;

  return (
    <div className="pt-drawer">
      <div className="pt-drawerhead">
        <span className="pt-name" title={head}>
          {head}
        </span>
        {pid != null && windows.length > 1 && (
          <>
            <button
              type="button"
              className="pt-mini"
              title="Bring every window of this session forward"
              disabled={busy !== null}
              onClick={() => void osAct("raise", "Brought all windows forward", { pid, action: "raise" })}
            >
              ⇈
            </button>
            <button
              type="button"
              className="pt-mini"
              title="Minimize every window of this session"
              disabled={busy !== null}
              onClick={() => void osAct("minall", "Minimized all windows", { pid, action: "minimize" })}
            >
              ⇊
            </button>
          </>
        )}
        <button type="button" className="pt-mini" title="Refresh" onClick={() => void load()}>
          ⟳
        </button>
        <button type="button" className="pt-mini" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {windows.length > 0 && (
        <div className="pt-drawerlist">
          {windows.map((w) => {
            const parts = windowLabelParts(w, sessionName);
            const key = String(w.id);
            return (
              <div
                key={key}
                className="pt-drawerfile"
                title={`${w.pane_owner ? `${w.pane_owner}\n` : ""}${w.title}\n${w.width}×${w.height}${
                  w.monitor ? ` · display ${w.monitor}${w.monitor_primary ? " (primary)" : ""}` : ""
                }`}
              >
                <span className={`pt-dot${w.foreground ? "" : " off"}`} title={w.foreground ? "Foreground window" : ""}>
                  {w.foreground ? "●" : w.minimized ? "▁" : "○"}
                </span>
                <button
                  type="button"
                  className="pt-link pt-name"
                  style={{ textAlign: "left", minWidth: 0 }}
                  title="Focus this window"
                  disabled={busy !== null}
                  onClick={() => void osAct(key, `Focused ${parts.primary}`, { id: w.id, action: "focus" })}
                >
                  {parts.primary}
                  {parts.kind ? <span className="pt-tool"> · {parts.kind}</span> : null}
                  {w.owned ? <span className="pt-tool"> · dialog</span> : null}
                </button>
                {w.monitor > 1 && <span className="pt-kind">#{w.monitor}</span>}
                <button
                  type="button"
                  className="pt-mini"
                  title={w.minimized ? "Restore this window" : "Minimize this window"}
                  disabled={busy !== null}
                  onClick={() =>
                    void osAct(`${key}:m`, `${w.minimized ? "Restored" : "Minimized"} ${parts.primary}`, {
                      id: w.id,
                      action: w.minimized ? "restore" : "minimize",
                    })
                  }
                >
                  {busy === `${key}:m` ? "…" : w.minimized ? "▲" : "▼"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {os && (
        <div className="pt-drawerrow">
          <span className="pt-muted small" style={{ padding: 0 }}>
            Layout
          </span>
          <button
            type="button"
            className="pt-barbtn"
            disabled={busy !== null}
            title="Capture the project's Window COMP placement + open state into the sidecar (applied on load)"
            onClick={() => void act("save", "Save layout", "window_save", {}, (r) => `Layout saved (${r.saved ?? "?"} windows)`)}
          >
            {busy === "save" ? "…" : "Save"}
          </button>
          <button
            type="button"
            className="pt-barbtn"
            disabled={busy !== null || !layoutItems}
            title="Place and open/close the windows as the saved layout says"
            onClick={() =>
              void act("apply", "Apply layout", "window_apply", {}, (r) =>
                `Layout applied (${r.applied ?? layoutItems} windows${r.missing ? ", some missing" : ""})`,
              )
            }
          >
            {busy === "apply" ? "…" : "Apply"}
          </button>
          <button
            type="button"
            className={`pt-barbtn${armClear ? " on" : ""}`}
            disabled={busy !== null || !layoutItems}
            title={armClear ? "Click again to remove the saved layout" : "Remove the saved layout from the sidecar"}
            onClick={() => {
              if (!armClear) {
                setArmClear(true);
                window.setTimeout(() => setArmClear(false), 3000);
                return;
              }
              setArmClear(false);
              void act("clear", "Clear layout", "window_clear", {}, () => "Saved layout removed");
            }}
          >
            {busy === "clear" ? "…" : armClear ? "sure?" : "Clear"}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Backup drawer --------------------------------------------------------------

function BackupDrawer({ say, onClose }: { say: (text: string, warn?: boolean) => void; onClose: () => void }) {
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setErr("");
    try {
      setInfo(await apiFetch<BackupInfo>(`/api/palette/backup?sid=${encodeURIComponent(sessionId)}`));
    } catch (e) {
      setInfo(null);
      setErr(String(e instanceof Error ? e.message : e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await post<BackupRun>("/api/palette/backup/run", { path: sessionId });
      if (r.ok === false) throw new Error(r.error || "backup failed");
      const mb = r.bytes_copied / (1024 * 1024);
      say(
        r.errors?.length
          ? `Backup: ${r.copied_to_remote} copied, ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}`
          : `Backed up ${r.copied_to_remote} file${r.copied_to_remote === 1 ? "" : "s"} (${mb.toFixed(1)} MB)`,
        !!r.errors?.length,
      );
      void load();
    } catch (e) {
      say(`Backup: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-drawer">
      <div className="pt-drawerhead">
        <span className="pt-name" title={info?.remote_root || undefined}>
          {err
            ? err
            : !info
              ? "Backup…"
              : `→ ${basename(info.remote_root)} · ${
                  info.to_remote
                    ? `${info.to_remote} file${info.to_remote === 1 ? "" : "s"} to copy`
                    : "up to date"
                }${info.filtered ? ` · ${info.filtered} filtered` : ""}`}
        </span>
        <button type="button" className="pt-mini" title="Refresh" onClick={() => void load()}>
          ⟳
        </button>
        <button type="button" className="pt-mini" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {info && (
        <div className="pt-drawerrow">
          <span className="pt-muted small" style={{ flex: "1 1 auto", padding: 0 }}>
            {info.remote_root}
            {info.gitignore_active ? " · .gitignore respected" : ""}
          </span>
          <button
            type="button"
            className="pt-place pt-pin"
            disabled={busy || !info.to_remote}
            title="Copy the project folder's new and changed files to the backup folder (never the other way)"
            onClick={() => void run()}
          >
            {busy ? "…" : "Back up now"}
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
