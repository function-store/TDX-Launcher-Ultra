import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import ReactMarkdown from "react-markdown";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { check as checkAppUpdate, type Update as AppUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as autostartIsEnabled,
} from "@tauri-apps/plugin-autostart";
import { api } from "./api";
import { mediaSrc, normalizeFsPath, previewKind } from "./mediaSrc";
import BackupPanel from "./BackupPanel";
import ControlPanel from "./ControlPanel";
import GitPanel from "./GitPanel";
import WatchPanel from "./WatchPanel";
import McpPanel from "./McpPanel";
import MediaPanel from "./MediaPanel";
import PaletteTree from "./PaletteTree";
import ToolboxSection from "./ToolboxSection";
import ContextMenu, { type MenuEntry, type MenuState } from "./ContextMenu";
import { getOps, initOpsEvents, subscribeOps } from "./ops";
import PatreonPanel, { PatreonDetail, type PatreonDragFile } from "./PatreonPanel";
import { PatreonCookieNote, PatreonUnofficialNote } from "./patreonCopy";
import { FNS_ENABLED } from "./features";
import FnsPanel from "./FnsPanel";
import FnsToolboxSection from "./FnsToolboxSection";
import {
  bindingFor,
  buildAccelMap,
  displayAccel,
  EDITABLE_ACTIONS,
  formatAccel,
  type ActionId,
} from "./keybindings";
import ShortcutEditor from "./ShortcutEditor";
import {
  SessionInstanceList,
  SessionWindowList,
  WindowSwitcher,
  collectWindows,
  windowLabel,
  type WindowEntry,
} from "./SessionWindows";
import SplitHandle, { useListPaneHeight, useSidePaneWidth } from "./SplitHandle";
import {
  packageInstallSpec,
  packageMatchesQuery,
  type TdpRemotePackage,
} from "./tdpCatalog";
import type {
  AppConfig,
  AutosaveFields,
  AutosaveMode,
  AutosaveState,
  DiscoverResult,
  FnsToolCommand,
  FocusArea,
  ListItem,
  OpenProject,
  PaletteItem,
  PatreonCampaign,
  PatreonToxPost,
  PatreonSearchResult,
  PatreonPostDetail,
  PatreonZipExtract,
  GpuMonitorOption,
  ProjectFamily,
  ProjectMetaInfo,
  PaletteScanRoot,
  ProcPerf,
  RecentEntry,
  SessionWindow,
  TdPerfResult,
  TabId,
  ThemeId,
  ToolboxKind,
  ToolboxTool,
  ToolboxView,
  LicenseStatus,
  QuickCommandPreset,
  UtilityUpdateInfo,
  WindowAction,
  FnsPackage,
} from "./types";
import { DEFAULT_TEMPLATE, THEMES } from "./types";
import {
  forgetManualEntry,
  loadCompanionNudgeOff,
  saveCompanionNudgeOff,
  loadLastUpdateCheck,
  saveLastUpdateCheck,
  loadFactoryVersionKey,
  loadListSort,
  saveListSort,
  type ListSort,
  type ListSortField,
  loadManualEntries,
  loadPanelRailCollapsed,
  loadPanels,
  loadPatreonCampaignFilesOnly,
  loadPatreonCampaignSort,
  loadPatreonCampaignView,
  loadPatreonPostsFilesOnly,
  loadPatreonPostsHideLocked,
  loadTemplateDefaultVersion,
  loadTourSeen,
  loadWizardSeen,
  type PatreonCampaignSort,
  type PatreonCampaignView,
  rememberManualEntry,
  saveFactoryVersionKey,
  savePanelRailCollapsed,
  savePanels,
  loadDismissedCompanions,
  saveDismissedCompanions,
  companionDismissKey,
  savePatreonCampaignFilesOnly,
  takeLegacyQuickSeenCommands,
  savePatreonCampaignSort,
  savePatreonCampaignView,
  savePatreonPostsFilesOnly,
  savePatreonPostsHideLocked,
  saveTemplateDefaultVersion,
  saveTourSeen,
  saveWizardSeen,
} from "./uiPersist";
import TourOverlay from "./tour/TourOverlay";
import { buildTourSteps, type TourStep } from "./tour/tourSteps";
import { DEMO_SESSION_NAME, DEMO_VERSION_KEYS, demoItems, isDemoPath } from "./tour/demoData";
import { SUPPORT_JOIN_URL } from "./fnsCatalog";
import type { HintId } from "./hints/hints";
import { useHints } from "./hints/useHints";
import SetupWizard from "./wizard/SetupWizard";
import {
  basename,
  canonicalToolName,
  splitPresetTarget,
  withInstance,
  buildOpenItems,
  buildPaletteItems,
  buildPaletteTree,
  buildRecentItems,
  buildTemplateItems,
  dirname,
  displayBuildInfo,
  findMatchingVersionKey,
  formatBytes,
  formatDuration,
  formatUptime,
  formatWhen,
  isInBackupFolder,
  isToxPath,
  newestMainlineKey,
  normPath,
  plainSummary,
  resolveTemplateVersion,
  sanitizeFolderName,
  tagsMatch,
  TEMPLATE_VERSION_LATEST,
  mainlineVersionKeys,
  CLI_FALLBACK_ASK,
  CLI_FALLBACK_CLOSEST,
  CLI_FALLBACK_LATEST,
  CLI_FALLBACK_UNSET,
  resolveCliFallbackVersion,
  versionNumeric,
  packageLandsInPane,
} from "./utils";
import {
  buildSessionActions,
  type SessionAction,
  type SessionActionId,
} from "./sessionActions";
import type { MetaEntry, PaletteTreeFolder } from "./utils";

type Modal =
  | "settings"
  | "help"
  | "about"
  | "install"
  | "clear"
  | "remove"
  | "kill"
  | "relaunch"
  | "alreadyOpen"
  | "media"
  | "tdpPackage"
  | "toxSource"
  | "toolboxTool"
  | "toolboxCategory"
  | "appUpdate"
  | "utilityUpdate"
  | "collectConfirm"
  | "cmdPrompt"
  | "repointConfirm"
  | "autosave"
  | "safeMode"
  | "versions"
  | "cliFallback"
  | "membership"
  | "phone"
  | null;

/** One file the companion's collect_save dry-run plans to copy. */
type CollectPlanFile = {
  src: string;
  dest: string;
  category: string;
  bytes: number;
  reuse?: boolean;
  pars: string[];
  /** Expression-mode refs this file would freeze into constant paths. */
  frozen_pars?: { par: string; expr: string }[];
};

/** Dry-run plan returned by the companion's collect_save action. */
type CollectPlan = {
  files?: CollectPlanFile[];
  normalize?: { op: string; par: string; from: string; to: string }[];
  skipped?: { op?: string; par?: string; value?: string; reason?: string }[];
  counts?: Record<string, number>;
  count?: number;
  total_bytes?: number;
  freeze_count?: number;
};

/** Snapshot returned by the companion's collect_status action. */
type CollectStatusSnapshot = {
  ok?: boolean;
  phase?: string;
  error?: string | null;
  total_files?: number;
  done_files?: number;
  total_bytes?: number;
  done_bytes?: number;
  current?: string;
  rewrites?: number;
  results?: { ok?: boolean }[];
  /** Present in the compact post-save summary (results are live-only). */
  failed?: number;
  frozen_count?: number;
  /** Live-state only: originals of frozen expressions. */
  frozen?: { par: string; expr: string }[];
};

/** Autosave left the companion for the FNS package rail (D7). */
const AUTOSAVE_MOVED =
  "Autosave ships as the Autosave package — install it from the FNSTools tab";

/** One relative reference the companion's repoint_assets dry-run can re-root. */
type RepointFix = {
  /** '<op path>.<par>' — the identity the apply phase confirms against. */
  ref: string;
  op: string;
  par: string;
  from: string;
  to: string;
  /** Absolute path the rewrite resolves to (proven to exist at scan time). */
  file: string;
  name: string;
};

/** Dry-run plan returned by the companion's repoint_assets action. */
type RepointPlan = {
  ok?: boolean;
  error?: string;
  count?: number;
  fixes?: RepointFix[];
  /** Broken relative refs no folder level resolves — genuinely missing files. */
  unresolved?: { op: string; par: string; value: string; resolved?: string }[];
  skipped?: { op?: string; par?: string; value?: string; reason?: string }[];
  counts?: Record<string, number>;
  project_folder?: string;
  project_file?: string;
  in_backup_folder?: boolean;
};

/** Result of an applied repoint. Never saves — see TDXLURepoint. */
type RepointResult = {
  ok?: boolean;
  error?: string;
  saved?: boolean;
  count?: number;
  attempted?: number;
  errors?: string[];
  message?: string;
};

/** Draft for the Toolbox add/edit tool dialog. id=null → adding. */
type ToolboxToolDraft = {
  id: string | null;
  label: string;
  kind: ToolboxKind;
  source: string;
  category: string;
  notes: string;
};

/** Embody's GitHub repo. The tox cache resolves owner/repo to the latest
 *  release's .tox, which is the same asset embody-release.json names. */
const EMBODY_SOURCE = "dylanroscover/Embody";

const COUNTDOWN_SECS = 5; // matches original _update_countdown (hardcoded 5s)

/** What the toolbar search filters on each tab — each keeps its own query. */
const TAB_SEARCH_SCOPE: Record<TabId, string> = {
  recent: "recent files",
  current: "sessions",
  templates: "templates",
  palette: "palette",
  fns: "tools",
  patreon: "creators",
};

function applyTheme(theme: string | undefined | null) {
  const id = THEMES.some((t) => t.id === theme) ? (theme as ThemeId) : "classic";
  document.documentElement.setAttribute("data-theme", id);
}

/** Settings sidebar pages, in nav order. */
const SETTINGS_CATS = [
  { id: "general", label: "General" },
  { id: "hotkeys", label: "Keys" },
  { id: "quick", label: "Quick Launch" },
  { id: "library", label: "Library" },
  { id: "backup", label: "Backup" },
  { id: "accounts", label: "Accounts" },
  { id: "monitoring", label: "Monitoring" },
  { id: "advanced", label: "Advanced" },
] as const;

type SettingsCat = (typeof SETTINGS_CATS)[number]["id"];

/** "30s" / "10 min" - the companion's own wording for an interval in minutes. */
function formatAutosaveInterval(minutes: number): string {
  if (!Number.isFinite(minutes)) return "-";
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

/**
 * A companion older than 0.10.0 has no autosave verbs and answers "unknown
 * action" - name the fix instead of forwarding a message about an action the
 * user never typed.
 */
function autosaveErrorText(raw?: string | null): string {
  const text = String(raw ?? "failed");
  return /unknown (utility )?action/i.test(text)
    ? "This session's companion is older than v0.10.0 - update the utility to use autosave."
    : text;
}

/**
 * One entry per `<fieldset data-settings-section>` in the Settings modal.
 *
 * `cat` files the section under a sidebar page; `keywords` is the search index —
 * every control's label belongs here so a setting can be found by name without
 * knowing which page it lives on. `id` is the deep-link target: any callout that
 * sends the user to Settings passes it to `openSettings(id)` so they land on the
 * section instead of the top of a long scroll.
 */
const SETTINGS_SECTIONS: {
  id: string;
  cat: SettingsCat;
  title: string;
  keywords: string;
}[] = [
  {
    id: "general",
    cat: "general",
    title: "Lists & prompts",
    keywords: "max recent files list length history confirm before removing delete prompt",
  },
  {
    id: "updates",
    cat: "general",
    title: "Updates",
    keywords:
      "check for updates automatically daily once a day startup announce version skipped app companion utility tox release chip",
  },
  {
    id: "appearance",
    cat: "general",
    title: "Theme & view",
    keywords:
      "color theme dark classic ocean amber ember frost violet mono view mode gallery list thumbnails appearance look show hide fnstools tab",
  },
  {
    id: "tray",
    cat: "general",
    title: "Tray & login",
    keywords:
      "system tray icon close to tray minimize quit autostart start at login boot startup background",
  },
  {
    id: "opening",
    cat: "general",
    title: "When TDXLU opens",
    keywords:
      "startup start open first tab default tab recent files sessions templates palette fnstools patreon remember last used",
  },
  {
    id: "fileopen",
    cat: "general",
    title: "Opening a project from Finder or Explorer",
    keywords:
      "finder explorer file association double click open with toe countdown closest latest version not installed fallback nearest default build mismatch ask pin",
  },
  {
    id: "launch",
    cat: "general",
    title: "After launching a project",
    keywords:
      "switch to current tab after launch hide launcher to tray quit after launching project",
  },
  {
    id: "shortcuts",
    cat: "hotkeys",
    title: "In-app shortcuts",
    keywords: "keyboard shortcuts keybindings rebind accelerator keys tabs search help settings",
  },
  {
    id: "hotkeys",
    cat: "hotkeys",
    title: "Global hotkeys",
    keywords:
      "global hotkey system wide main window palette tab combo accelerator quick launch overlay summon alternate second binding",
  },
  {
    id: "quicklaunch",
    cat: "quick",
    title: "Quick Launch overlay",
    keywords:
      "quick launch overlay search box hotkey filter prefixes commands tools components folder tag tool commands curation hide show hidden registry palette",
  },
  {
    id: "palette",
    cat: "library",
    title: "Palette",
    keywords: "palette folders extra shared studio library tox factory user components",
  },
  {
    id: "packages",
    cat: "library",
    title: "Packages",
    keywords: "package index url pypi name filter prefix tdp uv install warehouse simple",
  },
  {
    id: "fns",
    cat: "library",
    title: "FNSTools",
    keywords: "fnstools fns functionstore function store tools bucket manifest base url store palette configurator installer",
  },
  {
    id: "backup",
    cat: "backup",
    title: "Backup",
    keywords:
      "backup root folder cloud remote path exclude include filters globs max file size mb onedrive dropbox google drive usb skip touchdesigner backup folders numbered saves",
  },
  {
    id: "github",
    cat: "accounts",
    title: "GitHub",
    keywords: "github token username personal access rate limit auth git releases api",
  },
  {
    id: "fnsplus",
    cat: "accounts",
    title: "FNSTools Plus",
    keywords:
      "fnstools plus membership function store patreon sign in login entitlement plus packages unlock license",
  },
  {
    id: "patreon",
    cat: "accounts",
    title: "Patreon",
    keywords:
      "patreon session cookie creators campaign download root folder tox login log out logout sign out disconnect switch account",
  },
  {
    id: "control",
    cat: "advanced",
    title: "Control panel server",
    keywords:
      "control panel server http port lan access phone remote qr token browser localhost network wifi",
  },
  {
    id: "heartbeat",
    cat: "monitoring",
    title: "Heartbeat",
    keywords:
      "heartbeat watchdog tcp port timeout launch grace max relaunches reboot after crashes screenshot stall",
  },
  {
    id: "performance",
    cat: "monitoring",
    title: "Performance",
    keywords: "performance stats cpu ram gpu memory fps cook time poll interval session monitor",
  },
  {
    id: "alerts",
    cat: "monitoring",
    title: "Heartbeat email alerts",
    keywords:
      "email alerts smtp host port security starttls gmail app password sender recipient stall relaunch gave up reboot test",
  },
  {
    id: "migrate",
    cat: "advanced",
    title: "Migrate settings",
    keywords:
      "export import settings migrate another machine transfer preferences keybindings toolbox json",
  },
  {
    id: "maintenance",
    cat: "advanced",
    title: "Maintenance",
    keywords: "clear missing files prune import templates from plus housekeeping repair",
  },
];

/** Settings search must not surface a section that is hidden. */
const VISIBLE_SETTINGS_SECTIONS = SETTINGS_SECTIONS.filter(
  (s) => FNS_ENABLED || s.id !== "fns",
);

const SETTINGS_SECTION_CAT: Record<string, SettingsCat> = Object.fromEntries(
  VISIBLE_SETTINGS_SECTIONS.map((s) => [s.id, s.cat]),
);

/** Sections matching a search box query — every word must hit the title or keywords. */
function matchSettingsSections(
  query: string,
  extraKeywords?: Partial<Record<string, string>>,
): Set<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return new Set(VISIBLE_SETTINGS_SECTIONS.map((s) => s.id));
  return new Set(
    VISIBLE_SETTINGS_SECTIONS.filter((s) => {
      // Static keywords plus per-section dynamic content — e.g. the Quick
      // Launch section matches on every seen command and preset name.
      const hay = `${s.title} ${s.keywords} ${extraKeywords?.[s.id] ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).map((s) => s.id),
  );
}

/** Previously-added sources. Click to reuse, × to forget. */
function RecentEntries({
  entries,
  disabled,
  onPick,
  onForget,
}: {
  entries: string[];
  disabled?: boolean;
  onPick: (value: string) => void;
  onForget: (value: string) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="recent-entries">
      <span className="recent-entries-label">Recent</span>
      {entries.map((entry) => (
        <span key={entry} className="recent-entry" title={entry}>
          <button type="button" disabled={disabled} onClick={() => onPick(entry)}>
            {entry}
          </button>
          <button
            type="button"
            className="recent-entry-forget"
            title="Forget this entry"
            aria-label={`Forget ${entry}`}
            disabled={disabled}
            onClick={() => onForget(entry)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * What a running session *is* — reported, not chosen.
 *
 * The Current tab used to offer a version picker here, but a running project's
 * version is already decided; the picker only ever fed Relaunch, and only as a
 * third-priority fallback. It lives in the Relaunch dialog now.
 */
/**
 * Envoy is Embody's optional MCP server, not part of TouchDesigner. The
 * backend reports a port for any project under a folder Embody configured,
 * so a project that never loads Embody still read "Envoy :9881 down", as if
 * something were broken. A session shows its Envoy only once Envoy has
 * answered for it since the launcher started; after that a "down" is news
 * (it stopped) and stays visible.
 */
function hideUnusedEnvoy(list: OpenProject[], seenUp: Set<string>): OpenProject[] {
  return list.map((p) => {
    const key = normPath(p.path);
    if (p.envoy_up === true) {
      seenUp.add(key);
      return p;
    }
    if (p.envoy_port == null || seenUp.has(key)) return p;
    return { ...p, envoy_port: null, envoy_up: null };
  });
}

function sessionFacts(item: ListItem): string[] {
  const facts: string[] = [];
  facts.push(
    item.openVersionKey
      ? versionNumeric(item.openVersionKey) + (item.openUsePlayer ? " (TouchPlayer)" : "")
      : "version unknown",
  );
  if (item.openPid != null) facts.push(`PID ${item.openPid}`);
  if (item.openEnvoyPort != null) {
    facts.push(`Envoy :${item.openEnvoyPort} ${item.openEnvoyUp ? "up" : "down"}`);
  }
  if (item.source === "stale") {
    // An ended row: say when it ended and how long it ran. Never "up" (it
    // isn't), and never an origin -- the list relabels every ended row
    // "stale", so "opened externally" would be claimed for launcher starts too.
    if (item.openEndedAt) facts.push(`ended ${formatWhen(item.openEndedAt)}`);
    if (item.openStartedAt && item.openEndedAt && item.openEndedAt > item.openStartedAt) {
      facts.push(`ran ${formatDuration(item.openEndedAt - item.openStartedAt)}`);
    }
    return facts;
  }
  facts.push(item.source === "launcher" ? "launched here" : "opened externally");
  if (item.openStartedAt) facts.push(`up ${formatUptime(item.openStartedAt)}`);
  return facts;
}

/** Latest perf sample for one running session, keyed by normalized path. */
interface SessionPerf {
  proc?: ProcPerf;
  td?: TdPerfResult;
}

/** Key sessions the same way everywhere: forward slashes, lowercased. */
function perfKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Compact one-glance readout for a session row/tile:
 * `60fps · 5.4ms · 12% · 1.3GB` (+ `▼N` amber when the latest sample dropped
 * frames — instantaneous, never a running total).
 */
function rowPerf(p: SessionPerf): { text: string; warn: boolean } {
  const parts: string[] = [];
  if (p.td?.fps != null) parts.push(`${Math.round(p.td.fps)}fps`);
  if (p.td?.cook_ms != null) parts.push(`${p.td.cook_ms.toFixed(1)}ms`);
  const warn = (p.td?.dropped ?? 0) > 0;
  if (warn) parts.push(`▼${Math.round(p.td!.dropped!)}`);
  if (p.proc) {
    parts.push(`${p.proc.cpu_pct.toFixed(0)}%`);
    parts.push(
      p.proc.mem_mb >= 1024
        ? `${(p.proc.mem_mb / 1024).toFixed(1)}GB`
        : `${p.proc.mem_mb}MB`,
    );
  }
  return { text: parts.join(" · "), warn };
}

/**
 * Full perf readout for the selected session's pane. TD-internal numbers (fps,
 * cook, drops, GPU) come from the companion's Perform CHOP; CPU/RAM from the
 * OS process. `dropped` is the instantaneous drops-since-last-frame value,
 * shown amber when the latest sample dropped anything — deliberately not a
 * running total, which only ever grows and reads as doom.
 */
function sessionPerfParts(
  proc: ProcPerf | null,
  td: TdPerfResult | null,
): { text: string; warn?: boolean }[] {
  const parts: { text: string; warn?: boolean }[] = [];
  if (td?.fps != null) parts.push({ text: `${td.fps.toFixed(1)} fps` });
  if (td?.cook_ms != null) parts.push({ text: `cook ${td.cook_ms.toFixed(1)} ms` });
  if (td?.dropped != null && td.dropped > 0) {
    parts.push({ text: `drops ${Math.round(td.dropped)}`, warn: true });
  }
  if (td?.gpu_mem_mb != null) {
    const total = td.gpu_mem_total_mb ? `/${Math.round(td.gpu_mem_total_mb)}` : "";
    parts.push({ text: `GPU ${Math.round(td.gpu_mem_mb)}${total} MB` });
  }
  if (proc) {
    parts.push({ text: `CPU ${proc.cpu_pct.toFixed(0)}%` });
    parts.push({ text: `RAM ${proc.mem_mb} MB` });
  }
  return parts;
}

/**
 * Gallery tile: the still by default, the project's preview clip on hover.
 *
 * Deliberately not autoplaying every tile — a grid of 60 decoding H.264 at once
 * costs real CPU and makes scrolling stutter, so the clip streams only while
 * the pointer is on it (`preload="none"` keeps mount cheap).
 */
function GalleryThumb({
  poster,
  videoPath,
  mediaVersion,
  placeholder,
}: {
  poster: string | null;
  videoPath: string | null;
  mediaVersion: number;
  placeholder: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  if (!videoPath) {
    return (
      <div className="gallery-thumb">
        {poster ? (
          <img src={poster} alt="" />
        ) : (
          <div className="gallery-placeholder">{placeholder}</div>
        )}
      </div>
    );
  }

  return (
    <div
      className="gallery-thumb has-video"
      onMouseEnter={() => {
        // play() rejects if the element is torn down mid-load — poster stays, no throw
        void videoRef.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (!v) return;
        v.pause();
        v.currentTime = 0;
      }}
    >
      <video
        ref={videoRef}
        src={mediaSrc(videoPath, "video", mediaVersion)}
        poster={poster ?? undefined}
        muted
        loop
        playsInline
        preload="none"
      />
      <span className="gallery-thumb-badge" aria-hidden="true">
        ▶
      </span>
    </div>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.2 6.5 9.6 4.5h4.8l1.4 2H19a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h3.2Z" />
      <circle cx="12" cy="12.8" r="3.5" />
    </svg>
  );
}

function VideoTapeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2.3" />
      <circle cx="15.5" cy="11" r="2.3" />
      <path d="M8 16h8" />
    </svg>
  );
}



/** Where "the tab it was left on" is remembered: a per-machine UI
 *  convenience, so localStorage rather than the synced config. */
const LAST_TAB_KEY = "tdxlu-last-tab";
const TAB_IDS: readonly TabId[] = ["recent", "current", "templates", "palette", "fns", "patreon"];

/** The tab to open on (Settings -> When TDXLU opens). Unknown values and a
 *  missing "last" read as Recent Files; a gated tab (FNSTools, Patreon) that
 *  is unavailable is bounced to Recent Files by the existing guard. */
/** Read once at load: the app starts on Recent Files before the startup
 *  preference is applied, and remembering THAT tab would overwrite the one
 *  the user actually left it on. */
const LAST_TAB_AT_LAUNCH: string | null = (() => {
  try {
    return localStorage.getItem(LAST_TAB_KEY);
  } catch {
    return null;
  }
})();

function startupTabFor(pref: string | undefined): TabId {
  if (pref === "last") {
    const v = LAST_TAB_AT_LAUNCH;
    return v && (TAB_IDS as readonly string[]).includes(v) ? (v as TabId) : "recent";
  }
  return pref && (TAB_IDS as readonly string[]).includes(pref) ? (pref as TabId) : "recent";
}

/** Where every "support / join" action lands: Function Store's Patreon join
 *  page (tiers), not the creator profile. */

export default function App() {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  /**
   * Latest config, readable from callbacks that outlive the render they were
   * created in. The startup update checks fire from a []-deps effect, so their
   * closure captures the FIRST render's config — still null at mount — and a
   * direct `config?.skipped_app_version` there would always miss.
   */
  const configRef = useRef<AppConfig | null>(null);
  const [version, setVersion] = useState("0.1.0");
  const [platform, setPlatform] = useState("windows");
  const [patreonEnabled, setPatreonEnabled] = useState(false);
  const [bundledUtilityVersion, setBundledUtilityVersion] = useState("");
  const [appUpdate, setAppUpdate] = useState<AppUpdate | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  /**
   * Function Store membership (Patreon through the FNSTools gate). The
   * launcher gates nothing on it: the claim's `products` decide which
   * FNSTools Plus packages unlock. null until the first status fetch lands.
   * Backend pushes transitions (claim renewals, watchdog re-syncs) via
   * "license-status".
   */
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [licenseBusy, setLicenseBusy] = useState<"patreon" | "recheck" | null>(null);
  const [licenseError, setLicenseError] = useState("");
  /** Bucket URL field stays read-only until deliberately unlocked. */
  const [fnsBaseEditing, setFnsBaseEditing] = useState(false);
  /** "Make the companion permanent" callout on a missing-companion session card. */
  const [companionNudgeOff, setCompanionNudgeOff] = useState(() => loadCompanionNudgeOff());
  // The "make it permanent" instructions collapse behind a toggle — right
  // after a launch the user's attention is on the TD window, not a manual.
  const [companionNudgeExpanded, setCompanionNudgeExpanded] = useState(false);
  /** Pending companion-TOX release — its own channel, independent of appUpdate. */
  const [utilityUpdate, setUtilityUpdate] = useState<UtilityUpdateInfo | null>(null);
  const [utilityUpdateBusy, setUtilityUpdateBusy] = useState(false);
  /** OS launch-at-login registration (null = not read yet / unavailable). */
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  /** Scan-root diagnostics, fetched only while the palette shows empty. */
  const [paletteScan, setPaletteScan] = useState<PaletteScanRoot[] | null>(null);
  const [tab, setTab] = useState<TabId>("recent");
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  /** Variant families of the current recents — one entry per logical project. */
  const [families, setFamilies] = useState<ProjectFamily[]>([]);
  /** Family shown in the versions drawer (key into `families`). */
  const [versionsFamilyKey, setVersionsFamilyKey] = useState<string | null>(null);
  /** Variant awaiting restore-as-head confirmation inside the drawer. */
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  /** Variant paths ticked for pruning inside the drawer. */
  const [pruneSel, setPruneSel] = useState<Set<string>>(new Set());
  const [pruneConfirm, setPruneConfirm] = useState(false);
  /** A restore/prune call is in flight — disables the drawer's actions. */
  const [variantsBusy, setVariantsBusy] = useState(false);
  const [openProjects, setOpenProjectsRaw] = useState<OpenProject[]>([]);
  /** Sessions whose Envoy has answered since the launcher started. */
  const envoySeenUpRef = useRef<Set<string>>(new Set());
  /** Every session list lands through here, so the Envoy rule (see
   *  hideUnusedEnvoy) holds for polls, kills, relaunches and dismissals alike. */
  const setOpenProjects = useCallback(
    (next: OpenProject[] | ((prev: OpenProject[]) => OpenProject[])) =>
      setOpenProjectsRaw((prev) =>
        hideUnusedEnvoy(typeof next === "function" ? next(prev) : next, envoySeenUpRef.current),
      ),
    [],
  );
  /** Session cards expanded to show capabilities and owned windows. */
  const [expandedSessionCards, setExpandedSessionCards] = useState<Set<string>>(new Set());
  /** The Sessions tab opened one card for you once this run; after that,
   *  which cards are open is entirely the user's call (see the effect). */
  const sessionCardsAutoOpenedRef = useRef(false);
  /** Current-tab rows whose OS-window list is expanded, keyed by project path. */
  const [expandedWindows, setExpandedWindows] = useState<Set<string>>(new Set());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [templates, setTemplates] = useState<string[]>([]);
  const [paletteItems, setPaletteItems] = useState<PaletteItem[]>([]);
  const [toolbox, setToolbox] = useState<ToolboxView | null>(null);
  const [toolboxBusyIds, setToolboxBusyIds] = useState<Set<string>>(new Set());
  const [toolboxToolDraft, setToolboxToolDraft] = useState<ToolboxToolDraft | null>(null);
  const [toolboxCatDraft, setToolboxCatDraft] = useState<{
    original: string | null;
    name: string;
  } | null>(null);
  /** "New category" text in the tool dialog — when non-empty it wins over the select. */
  const [toolboxNewCategory, setToolboxNewCategory] = useState("");
  /** Session chosen in the palette place-target bar (path); falls back to the first eligible. */
  const [placeTargetPath, setPlaceTargetPath] = useState<string | null>(null);
  const [defaultPaletteDir, setDefaultPaletteDir] = useState("");
  const [paletteExtraDraft, setPaletteExtraDraft] = useState("");
  const [packageIndexDraft, setPackageIndexDraft] = useState("");
  const [fnsBaseDraft, setFnsBaseDraft] = useState("");
  const [packagePrefixDraft, setPackagePrefixDraft] = useState("");
  const [factoryVersionKey, setFactoryVersionKey] = useState(loadFactoryVersionKey);
  const [templateDefaultVersion, setTemplateDefaultVersion] = useState(loadTemplateDefaultVersion);
  const [dragIconPath, setDragIconPath] = useState("");
  const [meta, setMeta] = useState<Record<string, MetaEntry>>({});
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [projectMetaByPath, setProjectMetaByPath] = useState<Record<string, ProjectMetaInfo>>({});
  // Monitors in TD's affinity-index order — empty off Windows, which is also
  // how the GPU-affinity menu knows to stay hidden.
  const [gpuMonitors, setGpuMonitors] = useState<GpuMonitorOption[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [tagsOpen, setTagsOpen] = useState(() => loadPanels().tagsOpen);
  const [gitOpen, setGitOpen] = useState(() => loadPanels().gitOpen);
  const [backupOpen, setBackupOpen] = useState(() => loadPanels().backupOpen);
  const [watchOpen, setWatchOpen] = useState(() => loadPanels().watchOpen);
  const [mcpOpen, setMcpOpen] = useState(() => loadPanels().mcpOpen);
  const [mediaOpen, setMediaOpen] = useState(() => loadPanels().mediaOpen);
  // "Companion not loaded" bars the user dismissed, keyed '<path>|<pid>'.
  const [companionDismissed, setCompanionDismissed] = useState<Set<string>>(
    () => new Set(loadDismissedCompanions()),
  );
  const [controlOpen, setControlOpen] = useState(() => loadPanels().controlOpen);
  const [panelRailCollapsed, setPanelRailCollapsed] = useState(loadPanelRailCollapsed);
  const [selectedMcpAvailable, setSelectedMcpAvailable] = useState(false);
  const [listPaneHeight, setListPaneHeight] = useListPaneHeight();
  const [sidePaneWidth, setSidePaneWidth] = useSidePaneWidth();
  /** Anchor for the header View menu (null = closed). */
  const [viewMenuAt, setViewMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** Anchor for the consolidated Help menu (null = closed). */
  const [helpMenuAt, setHelpMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** Settings → Quick Launch → Clear usage waits for a second click. */
  const [usageClearArmed, setUsageClearArmed] = useState(false);
  /** Companion Load ▾ anchor — entries rebuild per render, see companionLoadMenu. */
  const [loadMenuAt, setLoadMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [listSort, setListSort] = useState<ListSort>(loadListSort);
  const [githubUserDraft, setGithubUserDraft] = useState("");
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [githubVerifyMsg, setGithubVerifyMsg] = useState("");
  const [patreonCookieDraft, setPatreonCookieDraft] = useState("");
  const [patreonLoginWaiting, setPatreonLoginWaiting] = useState(false);
  const patreonPollRef = useRef<number | null>(null);
  const [globalHotkeyDraft, setGlobalHotkeyDraft] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<string | null>(null);
  const [globalHotkeyAltDraft, setGlobalHotkeyAltDraft] = useState("");
  const [hotkeyStatusQuickAlt, setHotkeyStatusQuickAlt] = useState<string | null>(null);
  const [globalHotkeyMainAltDraft, setGlobalHotkeyMainAltDraft] = useState("");
  const [hotkeyStatusMainAlt, setHotkeyStatusMainAlt] = useState<string | null>(null);
  /** Settings → Quick Launch: filter over the tool-command curation list. */
  const [quickCmdFilter, setQuickCmdFilter] = useState("");
  /** Settings → Quick Launch: the preset being authored (null = collapsed). */
  const [presetDraft, setPresetDraft] = useState<{
    target: string;
    label: string;
    values: Record<string, string>;
  } | null>(null);
  const [globalHotkeyMainDraft, setGlobalHotkeyMainDraft] = useState("");
  const [hotkeyStatusMain, setHotkeyStatusMain] = useState<string | null>(null);
  const [globalHotkeyPaletteDraft, setGlobalHotkeyPaletteDraft] = useState("");
  const [hotkeyStatusPalette, setHotkeyStatusPalette] = useState<string | null>(null);
  const [bundledUtilityTox, setBundledUtilityTox] = useState<string | null>(null);
  const [recordingAction, setRecordingAction] = useState<ActionId | null>(null);
  const recordingRef = useRef<ActionId | null>(null);
  recordingRef.current = recordingAction;
  const [smtpPasswordDraft, setSmtpPasswordDraft] = useState("");
  const [alertTestMsg, setAlertTestMsg] = useState("");
  const [backupRootDraft, setBackupRootDraft] = useState("");
  const [patreonDownloadRootDraft, setPatreonDownloadRootDraft] = useState("");
  const [cloudRootDraft, setCloudRootDraft] = useState("");
  const [backupExcludeDraft, setBackupExcludeDraft] = useState("");
  const [backupIncludeDraft, setBackupIncludeDraft] = useState("");
  const [backupMaxMbDraft, setBackupMaxMbDraft] = useState(0);
  const [mediaIndex, setMediaIndex] = useState(0);
  // Bumped after a capture so preview.png / preview.mp4 reload despite a stable path
  const [mediaVersion, setMediaVersion] = useState(0);
  const [discover, setDiscover] = useState<DiscoverResult>({ versions: [], players: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [activeManual, setActiveManual] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [buildInfo, setBuildInfo] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [usePlayer, setUsePlayer] = useState(false);
  const [focus, setFocus] = useState<FocusArea>("picker");
  // One query PER TAB. A single shared string meant a filter typed on Recent
  // silently hollowed out the Palette tree you switched to next — different
  // lists, different intent, so each tab keeps (and remembers) its own.
  const [searchByTab, setSearchByTab] = useState<Partial<Record<TabId, string>>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const search = searchByTab[tab] ?? "";
  const setSearch = useCallback(
    (value: string) => setSearchByTab((prev) => ({ ...prev, [tab]: value })),
    [tab],
  );
  /** Wipe every tab's filter — the tour spotlights lists across tabs. */
  const clearAllSearches = useCallback(() => setSearchByTab({}), []);
  const [modal, setModal] = useState<Modal>(null);
  // Companion autosave. Cached per session path so the bar's chip can show
  // "on / every 10 min" without a poll; every write refreshes the entry.
  const [autosaveByPath, setAutosaveByPath] = useState<Record<string, AutosaveState>>({});
  // Registry-announced tool commands per companion session (normalized .toe
  // path), from the `fns_commands` verb. The Current bar renders commands
  // targeting the `session` surface, the session context menu the
  // `context-menu` ones (registry ≥ 1.7.0) — capability injection: the
  // vanilla launcher renders whatever the session advertises, nothing more.
  const [sessionCommands, setSessionCommands] = useState<Record<string, FnsToolCommand[]>>({});
  // Argument prompt for a surfaced command with declared params
  // (modal === "cmdPrompt"). Values are strings — the registry coerces by
  // declared style TD-side, same contract as the quick palette.
  const [cmdPrompt, setCmdPrompt] = useState<{ item: ListItem; cmd: FnsToolCommand } | null>(
    null,
  );
  const [cmdPromptValues, setCmdPromptValues] = useState<Record<string, string>>({});
  const [autosaveTarget, setAutosaveTarget] = useState<ListItem | null>(null);
  const [autosaveIntervalDraft, setAutosaveIntervalDraft] = useState("");
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [autosaveBusy, setAutosaveBusy] = useState(false);
  const [collectPlan, setCollectPlan] = useState<CollectPlan | null>(null);
  const [collectTarget, setCollectTarget] = useState<ListItem | null>(null);
  const [collectFreezeExpr, setCollectFreezeExpr] = useState(true);
  // Sources unticked in the collect dialog (excluded from the apply).
  const [collectExcluded, setCollectExcluded] = useState<Set<string>>(new Set());
  // Bumped to cancel a superseded collect_status poll loop.
  const collectPollGen = useRef(0);
  const [repointPlan, setRepointPlan] = useState<RepointPlan | null>(null);
  const [repointTarget, setRepointTarget] = useState<ListItem | null>(null);
  // Refs unticked in the repoint dialog (excluded from the apply).
  const [repointExcluded, setRepointExcluded] = useState<Set<string>>(new Set());
  /** Paths already auto-scanned this run, so a backup is offered once, not
   *  every time the session poll re-reports it. */
  const repointOffered = useRef<Set<string>>(new Set());
  const [tourOpen, setTourOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  /** Tracked as state so tour cards can say "the setup wizard is next" only when it is. */
  const [wizardSeen, setWizardSeen] = useState(() => loadWizardSeen());
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState<{
    path: string;
    displayName: string;
    pid: number;
  } | null>(null);
  /** Project awaiting a yes to replace its existing CrashAutoSave copy. */
  const [safeModeTarget, setSafeModeTarget] = useState<{
    item: ListItem;
    path: string;
    modified: number | null;
  } | null>(null);
  const [persistToxCopy, setPersistToxCopy] = useState(false);
  /** Add-Embody download in flight — the button is a network round-trip. */
  const [embodyBusy, setEmbodyBusy] = useState(false);
  const [companionEnv, setCompanionEnv] = useState<{
    projectDir: string;
    hasContext: boolean;
    contextSource: string | null;
    venvPath: string | null;
    pythonPath: string | null;
    uvPath: string | null;
    uvAvailable: boolean;
    ready: boolean;
  } | null>(null);
  const [companionEnvPath, setCompanionEnvPath] = useState<string | null>(null);
  const [tdpTarget, setTdpTarget] = useState<ListItem | null>(null);
  const [tdpCustomSpec, setTdpCustomSpec] = useState("");
  // Hand-typed sources, remembered across sessions so "add" isn't a blank field
  const [toxSourceHistory, setToxSourceHistory] = useState<string[]>(() =>
    loadManualEntries("toxSource"),
  );
  const [tdpSpecHistory, setTdpSpecHistory] = useState<string[]>(() =>
    loadManualEntries("tdpSpec"),
  );
  const [toxSourceTarget, setToxSourceTarget] = useState<ListItem | null>(null);
  const [toxSourceDraft, setToxSourceDraft] = useState("");
  // Patreon import (optional, build-gated by patreonEnabled)
  const [patreonTarget, setPatreonTarget] = useState<ListItem | null>(null);
  const [patreonCampaigns, setPatreonCampaigns] = useState<PatreonCampaign[]>([]);
  const [patreonCampaign, setPatreonCampaign] = useState<PatreonCampaign | null>(null);
  const [patreonPosts, setPatreonPosts] = useState<PatreonToxPost[]>([]);
  const [patreonLoading, setPatreonLoading] = useState(false);
  const [patreonError, setPatreonError] = useState("");
  const [patreonBusyFile, setPatreonBusyFile] = useState<string | null>(null);
  const [patreonPostId, setPatreonPostId] = useState<string | null>(null);
  // Cross-creator name search over the cached listings + downloaded files.
  const [patreonCache, setPatreonCache] = useState<PatreonSearchResult | null>(null);
  const [patreonCacheSearching, setPatreonCacheSearching] = useState(false);
  const [patreonCampaignSort, setPatreonCampaignSort] = useState<PatreonCampaignSort>(() =>
    loadPatreonCampaignSort(),
  );
  const [patreonCampaignView, setPatreonCampaignView] = useState<PatreonCampaignView>(() =>
    loadPatreonCampaignView(),
  );
  const [patreonPostsFilesOnly, setPatreonPostsFilesOnly] = useState<boolean>(() =>
    loadPatreonPostsFilesOnly(),
  );
  const [patreonPostsHideLocked, setPatreonPostsHideLocked] = useState<boolean>(() =>
    loadPatreonPostsHideLocked(),
  );
  const [patreonCampaignFilesOnly, setPatreonCampaignFilesOnly] = useState<boolean>(() =>
    loadPatreonCampaignFilesOnly(),
  );
  // Two independent per-campaign date caches: "latest post" (any kind — one
  // cheap request, the default) and "latest upload" (file-bearing only — can
  // page through hundreds of posts, paid ONLY when the "TD files only"
  // creators filter is on). Which one is active is decided by
  // patreonCampaignFilesOnly; see requestPatreonCampaignDates below.
  const [patreonLatestPostByCampaign, setPatreonLatestPostByCampaign] = useState<
    Record<string, string | null>
  >({});
  const [patreonLastUploadByCampaign, setPatreonLastUploadByCampaign] = useState<
    Record<string, string | null>
  >({});
  const patreonLatestPostCache = useRef(new Map<string, string | null>());
  const patreonLatestPostInFlight = useRef(new Set<string>());
  const patreonLastUploadCache = useRef(new Map<string, string | null>());
  const patreonLastUploadInFlight = useRef(new Set<string>());
  // Full post bodies fetched on select — the list endpoint truncates content.
  const [patreonDetailCache, setPatreonDetailCache] = useState<
    Record<string, PatreonPostDetail>
  >({});
  const [patreonDetailLoading, setPatreonDetailLoading] = useState(false);
  // Zip extraction state, keyed by the zip file's own URL. Populated either
  // by a cheap disk-only status check (post reopened — prior extraction
  // found) or by an explicit Unzip click (download + extract).
  const [patreonZipExtractByUrl, setPatreonZipExtractByUrl] = useState<
    Record<string, PatreonZipExtract | undefined>
  >({});
  /** URLs already status-checked this session — skip redundant disk checks. */
  const patreonZipStatusChecked = useRef(new Set<string>());
  // Local disk path for a Patreon `.tox`, keyed by its file URL — set once a
  // file has been downloaded (or found already downloaded). An OS drag can't
  // wait on a network fetch, so this is what makes a row drag-ready.
  const [patreonLocalToxByUrl, setPatreonLocalToxByUrl] = useState<
    Record<string, string | undefined>
  >({});
  /** URLs already disk-checked this session — skip redundant lookups. */
  const patreonLocalToxChecked = useRef(new Set<string>());
  const [tdpBusy, setTdpBusy] = useState(false);
  const [tdpPackages, setTdpPackages] = useState<TdpRemotePackage[]>([]);
  const [tdpFromCache, setTdpFromCache] = useState(false);
  const [tdpCatalogLoading, setTdpCatalogLoading] = useState(false);
  const [tdpCatalogError, setTdpCatalogError] = useState("");
  const [tdpSearch, setTdpSearch] = useState("");
  const [tdpSelectedId, setTdpSelectedId] = useState<string | null>(null);
  const [tdpReadme, setTdpReadme] = useState("");
  const [tdpReadmeLoading, setTdpReadmeLoading] = useState(false);
  const [relaunchTarget, setRelaunchTarget] = useState<{
    path: string;
    displayName: string;
    pid: number | null;
    versionKey: string;
    usePlayer: boolean;
    /** The row's own file, when Relaunch retargeted to the family head
     *  (`relaunchPathFor`) — its ended record is superseded once we kill it. */
    fromPath?: string;
  } | null>(null);
  const [relaunchKillFirst, setRelaunchKillFirst] = useState(true);
  /** A launch held back because that .toe is already running — see `startLaunch`. */
  const [alreadyOpenTarget, setAlreadyOpenTarget] = useState<{
    path: string;
    displayName: string;
    versionKey: string;
    usePlayer: boolean;
    promote: boolean;
    pid: number | null;
    instances: number;
  } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [cliMode, setCliMode] = useState(false);
  const [readme, setReadme] = useState({ path: null as string | null, content: "", summary: "" });
  const [readmeEdit, setReadmeEdit] = useState(false);
  const [readmeDraft, setReadmeDraft] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [installerPath, setInstallerPath] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const activeOps = useSyncExternalStore(subscribeOps, getOps);
  useEffect(() => {
    const un = initOpsEvents();
    return () => {
      void un.then((f) => f());
    };
  }, []);
  const [maxRecentDraft, setMaxRecentDraft] = useState(100);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
  /** Settings export: carry machine-local paths too (off = portable subset). */
  const [exportIncludePaths, setExportIncludePaths] = useState(false);
  /** Settings sidebar: which page is showing, and the search box that overrides it. */
  const [settingsCat, setSettingsCat] = useState<SettingsCat>("general");
  const [settingsQuery, setSettingsQuery] = useState("");

  const searchRef = useRef<HTMLInputElement>(null);
  const selectedFileRef = useRef<HTMLElement | null>(null);
  const analysisId = useRef(0);
  const versionCache = useRef(new Map<string, string | null>());
  const countdownTimer = useRef<number | null>(null);
  /** Latched result of the one-shot pending-.toe read — see the bootstrap effect. */
  const cliToeRead = useRef<{ done: boolean; path: string | null }>({
    done: false,
    path: null,
  });
  const installPoll = useRef<number | null>(null);
  const iconsRef = useRef<Record<string, string>>({});
  /** Session paths whose preview metadata/icon has already been requested. */
  const sessionArtworkSeenRef = useRef<Set<string>>(new Set());
  const discoverRef = useRef(discover);
  const factoryVersionKeyRef = useRef(factoryVersionKey);
  const tabRef = useRef(tab);
  /** Last type-compatible selection per tab, so a palette .tox doesn't bleed into other tabs. */
  const selectionByTabRef = useRef<Partial<Record<TabId, string | null>>>({});
  const paletteDropFolderRef = useRef<string | null>(null);
  /** Toolbox drop target while dragging files: category name, '' = top level, null = not over the Toolbox. */
  const toolboxDropCategoryRef = useRef<string | null>(null);
  /** Same value as state, to drive the Toolbox drop highlight. */
  const [toolboxDropCat, setToolboxDropCat] = useState<string | null>(null);
  // True while we're dragging one of OUR palette items out (to TD). A drop of
  // that item back onto our own window must NOT be treated as an import.
  const draggingOutRef = useRef(false);

  const isMac = platform === "macos";
  /** A stored hotkey as its settings field shows it. The shipped defaults are
   *  written `CommandOrControl+…` (Cmd on macOS, Ctrl elsewhere), which nobody
   *  should have to read or type, so the field says Ctrl or Cmd instead. The
   *  fields compare against this form on blur, so an untouched default stays
   *  the portable CommandOrControl. */
  const hotkeyForField = (v?: string | null) =>
    (v ?? "").replace(/CommandOrControl|CmdOrCtrl/gi, isMac ? "Cmd" : "Ctrl");
  const mod = isMac ? "⌘" : "Ctrl";
  const trashName = isMac ? "Trash" : "Recycle Bin";

  // First-encounter tips. Held back while the tour, wizard or a modal owns the
  // screen — including while the tour drives tabs, which would otherwise fire
  // every tab hint at once.
  const { showHint, hintNode, resetHints, disableHints, hintsOff } = useHints({
    enabled: !tourOpen && !wizardOpen && !modal,
    mod,
    isMac,
  });

  /**
   * "Show tips again" — re-arms the first-encounter bubbles AND un-dismisses the
   * companion callout and the Patreon trust banner. Each of those promises this
   * exact control by name, so they have to be restored together or that promise
   * is a lie.
   */
  const restoreTips = useCallback(() => {
    resetHints();
    setCompanionNudgeOff(false);
    saveCompanionNudgeOff(false);
    // `updatePref` is a plain (non-memoised) function declared further down —
    // naming it in the deps would read it in the TDZ on the first render.
    void updatePref({ patreon_trust_ack: false });
  }, [resetHints]);

  // Tour targets live on the Recent tab — switch there before spotlighting.
  // A live search filter would hollow out the lists the tour spotlights (and
  // an emptied list swaps in demo rows over the user's real projects), so
  // clear it first.
  const startTour = useCallback(() => {
    setModal(null);
    clearAllSearches();
    setSearchOpen(false);
    setTab("recent");
    setTourOpen(true);
  }, [clearAllSearches]);

  /** Set below, once refreshOpen exists — the tour needs it before that point. */
  const refreshOpenRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * The tour drives the app: each step names the tab it belongs on and this
   * runs during the card's fade-out, so the pane is painted before the
   * spotlight measures it.
   */
  const onTourStep = useCallback((step: TourStep) => {
    if (!step.tab) return;
    setTab(step.tab);
    if (step.tab === "current") void refreshOpenRef.current?.();
  }, []);

  // A tab reached for the first time explains itself once. Recent is the
  // landing tab, so it has nothing to introduce.
  useEffect(() => {
    if (tab === "recent") return;
    showHint(`tab-${tab}` as const);
  }, [tab, showHint]);

  // Landing on a tab with no filter of its own collapses the box back to the
  // button — an open, empty input left over from the previous tab reads as
  // "this list is filtered" when it isn't.
  useEffect(() => {
    if (!(searchByTab[tab] ?? "")) setSearchOpen(false);
  }, [tab, searchByTab]);

  // The "Companion — not loaded" bar carries the drag handle that gets the TOX
  // into a live project. First time it shows up, say what it's for.
  useEffect(() => {
    if (tab !== "current" || !bundledUtilityTox || !selectedPath) return;
    const sel = openProjects.find((p) => p.path === selectedPath);
    // Strictly false, not nullish — null means the probe hasn't answered yet.
    // A silent companion is a frozen TD, not a missing companion.
    if (sel && sel.utility_available === false && sel.companion_silent_secs == null) {
      showHint("companion-missing");
    }
  }, [tab, selectedPath, openProjects, bundledUtilityTox, showHint]);

  // The setup wizard follows a *finished* tour. Skipping the tour is a "not
  // now" — chaining a second onboarding sequence onto that click punished the
  // opt-out; point at Help instead and let the wizard wait.
  const closeTour = useCallback((finished = true) => {
    saveTourSeen();
    setTourOpen(false);
    if (loadWizardSeen()) return;
    if (finished) setWizardOpen(true);
    else setStatusMsg("Skipped — the one-minute Setup Wizard is in Help whenever you're ready.");
  }, []);

  const startWizard = useCallback(() => {
    setModal(null);
    setWizardOpen(true);
  }, []);

  const closeWizard = useCallback(() => {
    saveWizardSeen();
    setWizardSeen(true);
    setWizardOpen(false);
    // Keep the legacy first-run flag in sync — the wizard covers file association.
    void api.updatePrefs({ has_prompted_file_assoc: true }).then(setConfig);
  }, []);

  useEffect(() => {
    iconsRef.current = icons;
  }, [icons]);

  // One-shot: hand the pre-0.11 localStorage command catalog to config, so a
  // machine that curated commands before the move keeps its history (and now
  // exports it).
  useEffect(() => {
    const legacy = takeLegacyQuickSeenCommands();
    if (!legacy.length) return;
    void api
      .mergeQuickSeenCommands(legacy)
      .then((added) => (added ? api.getConfig().then(setConfig) : undefined))
      .catch(() => {
        /* catalog is a convenience — never block startup on it */
      });
  }, []);

  useEffect(() => {
    discoverRef.current = discover;
  }, [discover]);

  useEffect(() => {
    factoryVersionKeyRef.current = factoryVersionKey;
  }, [factoryVersionKey]);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Diagnose an empty palette: which roots were checked and why they yielded
  // nothing (missing folder vs. macOS Documents-permission denial).
  useEffect(() => {
    if (tab !== "palette" || paletteItems.length > 0) {
      setPaletteScan(null);
      return;
    }
    const versions = discoverRef.current?.versions ?? [];
    const v = versions.find((x) => x.key === factoryVersionKeyRef.current);
    void api
      .paletteScanInfo(v?.install_path || v?.app_path || null)
      .then(setPaletteScan)
      .catch(() => setPaletteScan(null));
  }, [tab, paletteItems]);

  // Automatic update checks: at most once a day, and never while any
  // TouchDesigner session is running — a show machine gets no prompt (and no
  // check) mid-show. First try shortly after startup, then every half hour
  // until a day has passed and the machine is free. A hit lands in the header
  // Update chip; the dialog only opens if nothing else is (dev builds fail
  // silently). The utility check is staggered so that when both have news,
  // the app dialog is the one the user sees first.
  useEffect(() => {
    const tryAutoCheck = async () => {
      if (configRef.current?.auto_update_check === false) return;
      if (Date.now() - loadLastUpdateCheck() < 24 * 60 * 60 * 1000) return;
      const sessions = await api.openProjectsList().catch(() => null);
      if (!sessions || sessions.some((s) => s.alive)) return;
      saveLastUpdateCheck(Date.now());
      void runAppUpdateCheck(false);
      window.setTimeout(() => void runUtilityUpdateCheck(false), 2000);
    };
    const first = window.setTimeout(() => void tryAutoCheck(), 4000);
    const every = window.setInterval(() => void tryAutoCheck(), 30 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-tab selection memory. A .tox selection belongs to the palette tab
  // only; .toe / template selections belong to the other tabs. On tab switch,
  // a selection foreign to the new tab is swapped for that tab's remembered
  // one — so browsing the palette doesn't hijack what Current/Recent had.
  useEffect(() => {
    const foreign =
      tab === "palette"
        ? !!selectedPath && !isToxPath(selectedPath)
        : !!selectedPath && isToxPath(selectedPath);
    if (foreign) {
      // Restore before recording anything: this effect also runs the tracker.
      setSelectedPath(selectionByTabRef.current[tab] ?? null);
      return;
    }
    selectionByTabRef.current[tab] = selectedPath;
  }, [tab, selectedPath]);

  useEffect(() => {
    savePanels({ gitOpen, backupOpen, watchOpen, mcpOpen, mediaOpen, controlOpen, tagsOpen });
  }, [gitOpen, backupOpen, watchOpen, mcpOpen, mediaOpen, controlOpen, tagsOpen]);

  // Drop dismissals for sessions that are no longer running, then persist.
  // This is what keeps the store bounded AND makes PID reuse a non-issue: the
  // key is gone before the OS can hand that number to something else. A
  // relaunch therefore always gets its bar back, which is the point — a new
  // process is a new chance the companion was added.
  useEffect(() => {
    const live = new Set(
      openProjects
        .filter((p) => p.alive)
        .map((p) => companionDismissKey(p.path, p.pid)),
    );
    setCompanionDismissed((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k)));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [openProjects]);

  useEffect(() => {
    saveDismissedCompanions([...companionDismissed]);
  }, [companionDismissed]);

  useEffect(() => {
    applyTheme(config?.theme);
  }, [config?.theme]);

  // The webview's native context menu only makes sense in editable fields —
  // everywhere else the app's own context menus (or nothing) take over.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  const refreshLists = useCallback(async (cfg?: AppConfig, opts?: { rediscover?: boolean }) => {
    const c = cfg ?? (await api.getConfig());
    setConfig(c);
    setMaxRecentDraft(c.max_recent_files);

    const rediscover = opts?.rediscover ?? true;
    const [r, t, d] = await Promise.all([
      api.getRecents(true),
      api.getTemplates(),
      rediscover ? api.discoverVersions() : Promise.resolve(null),
    ]);
    setRecents(r);
    setTemplates(t);

    // Group recents into variant families (Name.toe / Name.N.toe / Backup /
    // crash autosaves). Failure degrades to ungrouped rows, never blocks.
    let fams: ProjectFamily[] = [];
    try {
      fams = await api.listProjectFamilies(
        r.map((x) => ({ path: x.path, last_opened: x.last_opened ?? null })),
      );
    } catch {
      /* ungrouped fallback */
    }
    setFamilies(fams);
    // Family heads can exist on disk without being in the recents (the user
    // only ever opened `.5`) — they still need meta/sidecar/icons, since the
    // collapsed card represents the family through the head's path.
    // Deduped on the RAW string, not normPath: `meta` / `projectMetaByPath` are
    // keyed by the exact path passed to the stat calls, and a collapsed row
    // carries `family.head`'s spelling. TD's registry recents use forward
    // slashes while a scanned head comes back backslashed, so a normalized
    // compare would drop the head as "already covered" and leave the row with
    // no size, date, tags or icon.
    const rRaw = new Set(r.map((x) => x.path));
    const familyHeads = fams
      .map((f) => f.head)
      .filter((h): h is string => !!h && !rRaw.has(h));

    const versions = d?.versions ?? discoverRef.current.versions;
    if (d) {
      setDiscover(d);
      discoverRef.current = d;
    }

    const withInstall = versions.filter((v) => v.install_path || v.app_path);
    const installKeys = withInstall.map((v) => v.key);
    let factoryKey = factoryVersionKeyRef.current;
    if (!factoryKey || !installKeys.includes(factoryKey)) {
      factoryKey =
        newestMainlineKey(installKeys) ||
        installKeys[installKeys.length - 1] ||
        "";
      factoryVersionKeyRef.current = factoryKey;
      setFactoryVersionKey(factoryKey);
      saveFactoryVersionKey(factoryKey);
    }
    const factoryVer = withInstall.find((v) => v.key === factoryKey);
    const factoryInstall = factoryVer?.install_path || factoryVer?.app_path || null;
    const pal = await api.getPaletteItems(factoryInstall);
    setPaletteItems(pal);

    const toePaths = [...r.map((x) => x.path), ...familyHeads, ...t];
    const toxPaths = pal.map((p) => p.path);
    const paths = [...toePaths, ...toxPaths];
    const metas = paths.length ? await api.getFilesMeta(paths) : [];
    const nextMeta: Record<string, MetaEntry> = {};
    paths.forEach((p, i) => {
      nextMeta[p] = {
        exists: metas[i]?.exists ?? false,
        mtime: metas[i]?.mtime ?? "",
        mtimeSecs: metas[i]?.mtime_secs ?? 0,
        bytes: metas[i]?.bytes ?? 0,
      };
    });
    setMeta(nextMeta);

    const pmetas = toePaths.length ? await api.getProjectsMeta(toePaths) : [];
    const byPath: Record<string, ProjectMetaInfo> = {};
    for (const pm of pmetas) byPath[pm.project_path] = pm;
    setProjectMetaByPath(byPath);
    setAllTags(toePaths.length ? await api.getAllTags(toePaths) : []);

    const nextIcons = { ...iconsRef.current };
    for (const pm of pmetas) {
      if (pm.hero_path) {
        try {
          nextIcons[pm.project_path] = mediaSrc(pm.hero_path, "image", pm.hero_mtime ?? undefined);
        } catch {
          /* ignore */
        }
      }
    }
    const needIcons =
      c.view_mode === "gallery" || c.show_icons
        ? toePaths.filter((p) => nextMeta[p]?.exists && !nextIcons[p]).slice(0, 60)
        : [];
    if (needIcons.length) {
      await Promise.all(
        needIcons.map(async (p) => {
          const url = await api.getIconDataUrl(p);
          if (url) nextIcons[p] = url;
        }),
      );
    }
    setIcons(nextIcons);
  }, []);

  // Tracks each live pid's last-seen path so an Increment and Save done
  // straight in TD (never touching the launcher) can still be noticed —
  // Recent has no poll of its own, unlike this 4s Current loop.
  const pathByPidRef = useRef<Record<number, string>>({});

  const refreshOpen = useCallback(async () => {
    try {
      const list = await api.openProjectsList();
      setOpenProjects(list);

      // Sessions opened outside the launcher may not exist in Recent, so the
      // normal library refresh never asks for their preview metadata. Prime
      // each live/ended session once and key the result by the exact path the
      // session card carries (while also preserving the backend's spelling).
      const artworkPaths = [...new Set(list.map((project) => project.path))].filter((path) => {
        const key = normPath(path);
        if (!path || sessionArtworkSeenRef.current.has(key)) return false;
        sessionArtworkSeenRef.current.add(key);
        return true;
      });
      if (artworkPaths.length) {
        void (async () => {
          try {
            const projectDetails = await api.getProjectsMeta(artworkPaths);
            const detailsByPath = new Map(
              projectDetails.map((info) => [normPath(info.project_path), info]),
            );
            setProjectMetaByPath((prev) => {
              const next = { ...prev };
              for (const path of artworkPaths) {
                const info = detailsByPath.get(normPath(path));
                if (!info) continue;
                next[path] = info;
                next[info.project_path] = info;
              }
              return next;
            });

            const loadedIcons: Record<string, string> = {};
            await Promise.all(
              artworkPaths.map(async (path) => {
                const info = detailsByPath.get(normPath(path));
                if (info?.hero_path) {
                  loadedIcons[path] = mediaSrc(info.hero_path, "image", info.hero_mtime ?? undefined);
                  return;
                }
                const icon = await api.getIconDataUrl(path).catch(() => null);
                if (icon) loadedIcons[path] = icon;
              }),
            );
            if (Object.keys(loadedIcons).length) {
              setIcons((prev) => ({ ...prev, ...loadedIcons }));
            }
          } catch {
            // A transient metadata failure should be retried by the next poll.
            for (const path of artworkPaths) sessionArtworkSeenRef.current.delete(normPath(path));
          }
        })();
      }

      const prev = pathByPidRef.current;
      const next: Record<number, string> = {};
      const renamed = new Map<string, string>();
      for (const p of list) {
        for (const inst of p.instances) {
          next[inst.pid] = p.path;
          const was = prev[inst.pid];
          if (was && was !== p.path) renamed.set(was, p.path);
        }
      }
      pathByPidRef.current = next;

      if (renamed.size) {
        // A renamed row is the SAME session under a new name, so anything
        // holding the old path has to move with it — otherwise saving in TD
        // silently deselects the row the user was working with.
        setSelectedPath((cur) => (cur ? renamed.get(cur) ?? cur : cur));
        setActiveManual((cur) => (cur ? renamed.get(cur) ?? cur : cur));
        const sel = selectionByTabRef.current;
        for (const key of Object.keys(sel) as TabId[]) {
          const was = sel[key];
          if (was) sel[key] = renamed.get(was) ?? was;
        }
        void refreshLists(undefined, { rediscover: false });
      }
    } catch {
      /* ignore — backend may be mid-reload */
    }
  }, [refreshLists]);
  refreshOpenRef.current = refreshOpen;

  useEffect(() => {
    // One poll in flight at a time. A busy TouchDesigner can make a round
    // take longer than 4s, and stacking them used to tie up every backend
    // worker so even Focus waited its turn.
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await refreshOpen();
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 4000);
    return () => clearInterval(id);
  }, [refreshOpen]);

  // --- Session performance (Current tab, optional) --------------------------
  // Poll process CPU/RAM + companion Perform CHOP stats for EVERY live session
  // — one batched sysinfo call for all PIDs, one bus round-trip per session
  // with the companion — only while the Current tab is showing and the perf
  // toggle is on. Toggle off = zero sampling, zero bus traffic, no UI.
  const perfEnabled = !!config?.perf_monitor_enabled;
  const perfPollSecs = config?.perf_poll_secs || 4;
  const [sessPerf, setSessPerf] = useState<Record<string, SessionPerf>>({});
  const perfTargets = useMemo(() => {
    if (tab !== "current" || !perfEnabled) return [];
    return openProjects
      .filter((p) => p.alive && (p.pid != null || p.utility_available))
      .map((p) => ({
        key: perfKey(p.path),
        pid: p.pid,
        utility: !!p.utility_available,
        path: p.path,
      }));
  }, [tab, perfEnabled, openProjects]);
  // The 4s openProjects refresh recreates the targets array every poll; keep
  // the sampling interval keyed to its CONTENT so the cadence isn't reset (and
  // pinned to 4s) unless a session actually appears/vanishes.
  const perfTargetsRef = useRef(perfTargets);
  perfTargetsRef.current = perfTargets;
  const perfTargetsKey = perfTargets
    .map((t) => `${t.key}:${t.pid ?? ""}:${t.utility ? 1 : 0}`)
    .join("|");

  useEffect(() => {
    setSessPerf({});
    if (!perfTargetsKey) return;
    let live = true;
    // Same rule as the sessions poll: never a second round while one waits.
    let busy = false;
    const sample = async () => {
      if (busy) return;
      busy = true;
      try {
        await sampleOnce();
      } finally {
        busy = false;
      }
    };
    const sampleOnce = async () => {
      const targets = perfTargetsRef.current;
      const pids = targets.filter((t) => t.pid != null).map((t) => t.pid as number);
      let procMap: Record<string, ProcPerf> = {};
      if (pids.length) {
        try {
          procMap = await api.sessionsPerf(pids);
        } catch {
          procMap = {};
        }
      }
      const tdPairs = await Promise.all(
        targets
          .filter((t) => t.utility)
          .map(async (t) => {
            try {
              const td = await api.sessionTdPerf(t.path);
              return [t.key, td?.ok ? td : undefined] as const;
            } catch {
              return [t.key, undefined] as const;
            }
          }),
      );
      if (!live) return;
      const tdMap = new Map(tdPairs);
      const next: Record<string, SessionPerf> = {};
      for (const t of targets) {
        const proc = t.pid != null ? procMap[String(t.pid)] : undefined;
        const td = tdMap.get(t.key);
        if (proc || td) next[t.key] = { proc, td };
      }
      setSessPerf(next);
    };
    void sample();
    const id = window.setInterval(() => void sample(), Math.max(2, perfPollSecs) * 1000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [perfTargetsKey, perfPollSecs]);

  // Gate toolbar MCP on per-project Embody/.mcp.json presence
  useEffect(() => {
    if (!selectedPath || selectedPath === DEFAULT_TEMPLATE || isToxPath(selectedPath)) {
      setSelectedMcpAvailable(false);
      return;
    }
    const fromOpen = openProjects.find(
      (p) => p.path.replace(/\\/g, "/").toLowerCase() === selectedPath.replace(/\\/g, "/").toLowerCase(),
    );
    if (fromOpen) {
      setSelectedMcpAvailable(!!fromOpen.mcp_available);
      return;
    }
    let cancelled = false;
    void api
      .mcpStatus(selectedPath)
      .then((s) => {
        if (!cancelled) setSelectedMcpAvailable(!!s.detected);
      })
      .catch(() => {
        if (!cancelled) setSelectedMcpAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, openProjects]);

  useEffect(() => {
    if (!selectedMcpAvailable && mcpOpen) setMcpOpen(false);
  }, [selectedMcpAvailable, mcpOpen]);

  // Keep file meta / project meta warm for open sessions (may not be in Recents)
  useEffect(() => {
    const paths = openProjects.map((p) => p.path).filter(Boolean);
    if (!paths.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const metas = await api.getFilesMeta(paths);
        if (cancelled) return;
        setMeta((prev) => {
          const next = { ...prev };
          paths.forEach((p, i) => {
            next[p] = {
              exists: metas[i]?.exists ?? true,
              mtime: metas[i]?.mtime ?? "",
              mtimeSecs: metas[i]?.mtime_secs ?? 0,
              bytes: metas[i]?.bytes ?? 0,
            };
          });
          return next;
        });
        const pmetas = await api.getProjectsMeta(paths);
        if (cancelled) return;
        setProjectMetaByPath((prev) => {
          const next = { ...prev };
          for (const pm of pmetas) next[pm.project_path] = pm;
          return next;
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openProjects]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Membership: initial status + backend-pushed transitions (claim renewals,
  // watchdog re-syncs). Failures leave `license` null — the membership chip
  // stays hidden rather than showing a wrong state.
  useEffect(() => {
    void api.licenseStatus().then(setLicense).catch(() => {});
    const un = listen<LicenseStatus>("license-status", (e) => setLicense(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Prefs written outside this window (the in-TD palette pinning a
  // favourite command): re-read, so Settings shows the truth.
  useEffect(() => {
    const un = listen("prefs-changed", () => {
      void api.getConfig().then(setConfig).catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // The FNSTools tab: built in (FNS_ENABLED) and not hidden by this user in
  // Settings. Hiding it leaves the Palette tab's FNS shelf in place.
  const fnsTabShown = FNS_ENABLED && config?.show_fns_tab !== false;

  // A hidden tab can't stay active (persisted tab state, or hidden just now).
  // The Patreon half lives where app info lands — see getAppInfo.
  useEffect(() => {
    if (!fnsTabShown && tab === "fns") setTab("recent");
  }, [tab, fnsTabShown]);

  // Actions delegated from the quick-launch overlay (it shows this window
  // first, then names the modal to open).
  useEffect(() => {
    const un = listen<{ id: string }>("quick-action", (e) => {
      if (e.payload?.id === "settings") setModal("settings");
      else if (e.payload?.id === "about") setModal("about");
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // The Palette global hotkey shows this window and asks for a specific tab.
  useEffect(() => {
    const un = listen<string>("main:open-tab", (e) => {
      if (e.payload === "palette") setTab("palette");
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  /**
   * File-open mode: select the `.toe` we were handed, focus the version list
   * and let the launch countdown take it from there.
   *
   * Used both at startup (argv of our own process) and when an already-running
   * instance is handed a file by Explorer — the second case never re-runs the
   * startup effect, so without this the window kept showing the previous
   * project.
   */
  const enterCliMode = useCallback(async (cli: string) => {
    setCliMode(true);
    setSelectedPath(cli);
    setActiveManual(cli);
    setFocus("versions");
    setTab("recent");
    // Warm meta for CLI file (may not be in recents yet)
    try {
      const m = await api.getFileMeta(cli);
      setMeta((prev) => ({
        ...prev,
        [cli]: { exists: m.exists, mtime: m.mtime, mtimeSecs: m.mtime_secs, bytes: m.bytes },
      }));
    } catch {
      /* ignore */
    }
  }, []);

  // Explorer "open with" on a .toe while we're already running: the second
  // process hands us its argv and exits, and this is where that arrives.
  useEffect(() => {
    const un = listen<string>("cli-toe-opened", (e) => {
      if (!e.payload) return;
      // Drain the backend slot. The hook fills it as well as emitting, to cover
      // a file arriving before this window has mounted; once the event has been
      // handled a leftover slot would re-open the same file on the next mount.
      void api.getCliToe();
      void enterCliMode(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [enterCliMode]);

  const licenseSignInPatreon = async () => {
    setLicenseBusy("patreon");
    setLicenseError("");
    try {
      // Resolves only after the browser round-trip completes (or times out).
      setLicense(await api.licensePatreonSignIn());
    } catch (e) {
      setLicenseError(String(e));
    } finally {
      setLicenseBusy(null);
    }
  };

  /** Forced re-check past the gate's cache — for "my pledge just landed".
      Consumes the answer's structure per docs/fns-gate.md §6: a dead grant
      routes to sign-in (never "check again"), an outage reads as staleness. */
  const licenseRecheck = async () => {
    setLicenseBusy("recheck");
    setLicenseError("");
    try {
      const r = await api.licenseRecheck();
      if (!r.connected) {
        setLicenseError(r.message || "The Patreon link on this install is no longer active — sign in again to reconnect.");
      } else if (r.stale) {
        setLicenseError("Patreon could not be reached — this is the last known answer, not a refusal. Try again in a little while.");
      }
      void api.licenseStatus().then(setLicense).catch(() => {});
    } catch (e) {
      setLicenseError(String(e));
    } finally {
      setLicenseBusy(null);
    }
  };

  useEffect(() => {
    (async () => {
      const info = await api.getAppInfo();
      setVersion(info.version);
      setPlatform(info.platform);
      setPatreonEnabled(!!info.patreon_enabled);
      // A build without Patreon can't stay on a persisted Patreon tab.
      if (!info.patreon_enabled) setTab((t) => (t === "patreon" ? "recent" : t));
      setBundledUtilityVersion(info.utility_version || "");
      void autostartIsEnabled().then(setAutostartEnabled).catch(() => {
        /* plugin unavailable (dev) — checkbox stays disabled */
      });
      void api.getBundledUtilityTox().then(setBundledUtilityTox);
      // A backend without the command resolves null rather than rejecting —
      // store [] so menu builders can rely on an array (a throw inside a menu
      // builder silently degrades the row menu to the pane menu).
      void api.listGpuMonitors().then((m) => setGpuMonitors(m ?? [])).catch(() => {
        /* no monitor list — GPU affinity menu stays hidden */
      });
      // The backend hands the pending .toe out exactly once. StrictMode
      // double-invokes this effect in dev, so latch the first answer — a second
      // read returns null and would drop us straight back out of CLI mode.
      if (!cliToeRead.current.done) {
        cliToeRead.current = { done: true, path: await api.getCliToe() };
      }
      const cli = cliToeRead.current.path;
      const cfg = await api.getConfig();
      setDefaultPaletteDir(await api.defaultPaletteDir());
      // Load the Toolbox; on first run this also pins the bundled utility TOX.
      void api.toolboxSeedBundled().then(setToolbox).catch(() => {
        /* toolbox optional — section stays hidden */
      });
      try {
        setDragIconPath(await api.getDragIconPath());
      } catch {
        /* drag preview optional */
      }
      await refreshLists(cfg);

      if (cli) {
        // File-open mode: analyze/select the .toe, focus versions, auto-countdown
        await enterCliMode(cli);
      } else {
        // Dashboard mode: the configured start tab, no countdown. Each tab
        // then picks its own selection (see the per-tab selection memory).
        setCliMode(false);
        setFocus("picker");
        const start = startupTabFor(cfg?.startup_tab);
        setTab(start);
        if (start === "recent") {
          const r = await api.getRecents(true);
          if (r[0]?.path) {
            setSelectedPath(r[0].path);
          }
        }
        // First-run sequence: the tour once ever, then the setup wizard —
        // chained in closeTour only when the tour was actually finished; a
        // skipped tour defers the wizard to the next start (here) or Help.
        // CLI mode skips both — the app is about to auto-launch.
        if (!loadTourSeen()) setTourOpen(true);
        else if (!loadWizardSeen()) setWizardOpen(true);
      }

      setReady(true);

      // Size + show only after UI data is ready (avoids white/small flash)
      try {
        const win = getCurrentWindow();
        const panels = loadPanels();
        const side =
          cfg.show_readme || panels.gitOpen || panels.backupOpen || panels.watchOpen || panels.mcpOpen || panels.mediaOpen || panels.controlOpen;
        const w = side ? 1100 : 720;
        await win.setSize(new LogicalSize(w, 720));
        if (info.autostart_launch && cfg.show_tray !== false) {
          // Login launch: stay in the tray; the tray icon / hotkey brings it up.
        } else {
          await win.show();
          await win.setFocus();
        }
      } catch (e) {
        console.error(e);
      }
    })().catch(async (e) => {
      setStatusMsg(String(e));
      setReady(true);
      try {
        await getCurrentWindow().show();
      } catch {
        /* ignore */
      }
    });
  }, [refreshLists]);

  useEffect(() => {
    const un = listen<{ progress: number }>("download-progress", (e) => {
      setDownloadProgress(e.payload.progress);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  /** Toolbox target (ref for the drop handler + state for the highlight). */
  const setToolboxDropTarget = (cat: string | null) => {
    toolboxDropCategoryRef.current = cat;
    setToolboxDropCat(cat);
  };

  /**
   * Resolve drop targets from a drag position (physical px from Tauri).
   * HTML5 dragover never fires for native drags on Windows — Tauri intercepts
   * them — so per-row targeting has to hit-test the reported position against
   * `data-toolbox-drop` / `data-palette-drop` DOM markers instead.
   */
  const updateDragTargets = (px: number, py: number) => {
    const scale = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(px / scale, py / scale);
    const tb = (el?.closest?.("[data-toolbox-drop]") ?? null) as HTMLElement | null;
    const cat = tb ? tb.getAttribute("data-toolbox-drop") : null;
    setToolboxDropTarget(cat);
    if (cat !== null) {
      paletteDropFolderRef.current = null;
      return;
    }
    const pal = (el?.closest?.("[data-palette-drop]") ?? null) as HTMLElement | null;
    paletteDropFolderRef.current = pal ? pal.getAttribute("data-palette-drop") : null;
  };

  // Drag-drop .toe (open) or .tox onto Palette (import into User Palette)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent(async (event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          if (tabRef.current === "palette") {
            const pos = event.payload.position;
            updateDragTargets(pos.x, pos.y);
          }
        } else if (event.payload.type === "drop") {
          // Recompute from the drop position — don't trust hover state alone.
          if (tabRef.current === "palette") {
            const pos = event.payload.position;
            updateDragTargets(pos.x, pos.y);
          }
          const toolboxCat = toolboxDropCategoryRef.current;
          setToolboxDropTarget(null);
          const paths = event.payload.paths;
          const toxes = paths.filter((p) => p.toLowerCase().endsWith(".tox"));
          // Drops of our own palette item being dragged out and released back
          // on the window are never re-imported — but released over the
          // Toolbox they ARE the "pin this" gesture.
          if (draggingOutRef.current) {
            draggingOutRef.current = false;
            paletteDropFolderRef.current = null;
            if (tabRef.current === "palette" && toolboxCat !== null && toxes.length) {
              void pinToxesToToolbox(toxes, toolboxCat);
            }
            return;
          }
          const toes = paths.filter((p) => p.toLowerCase().endsWith(".toe"));
          if (tabRef.current === "palette" && toxes.length) {
            // Over the Toolbox → pin as local tools; anywhere else on the
            // palette → copy into User Palette as before.
            if (toolboxCat !== null) {
              paletteDropFolderRef.current = null;
              void pinToxesToToolbox(toxes, toolboxCat);
              return;
            }
            const dest = paletteDropFolderRef.current ?? "";
            paletteDropFolderRef.current = null;
            void importToxFiles(toxes, dest);
            return;
          }
          if (toes[0]) {
            setSelectedPath(toes[0]);
            setActiveManual(toes[0]);
            setTab("recent");
          }
        } else if (event.payload.type === "leave") {
          paletteDropFolderRef.current = null;
          setToolboxDropTarget(null);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sessionRecents = useMemo(() => {
    // Match original: pin active_manual (CLI / browse) to top of recents
    if (!activeManual) return recents;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const target = norm(activeManual);
    const list = [...recents];
    const idx = list.findIndex((r) => norm(r.path) === target);
    if (idx > 0) {
      const [item] = list.splice(idx, 1);
      list.unshift(item);
    } else if (idx === -1 && meta[activeManual]?.exists !== false) {
      // Not injected once the file is gone: a deleted pin would otherwise
      // conjure a permanent missing row for a file nothing can open.
      list.unshift({
        path: activeManual,
        source: "launcher",
        last_opened: Date.now() / 1000,
      });
    }
    return list;
  }, [recents, activeManual, meta]);

  const recentItems = useMemo(
    () =>
      buildRecentItems(
        sessionRecents,
        meta,
        !!config?.collapse_versions,
        search,
        activeManual,
        families,
      ),
    [sessionRecents, meta, config?.collapse_versions, search, activeManual, families],
  );

  const versionsFamily = useMemo(
    () => families.find((f) => f.key === versionsFamilyKey) ?? null,
    [families, versionsFamilyKey],
  );

  const openItems = useMemo(
    () => buildOpenItems(openProjects, search),
    [openProjects, search],
  );

  /** Every OS window across every live session — drives the switcher entry point. */
  const totalSessionWindows = useMemo(
    () => collectWindows(openProjects).length,
    [openProjects],
  );

  const templateItems = useMemo(
    () => buildTemplateItems(templates, meta, search),
    [templates, meta, search],
  );

  const paletteListItems = useMemo(
    () => buildPaletteItems(paletteItems, meta, search),
    [paletteItems, meta, search],
  );

  const paletteTree = useMemo(() => {
    const tree = buildPaletteTree(paletteItems, meta, search);
    if (
      defaultPaletteDir &&
      !tree.some((r) => r.acceptImports)
    ) {
      return [
        {
          kind: "folder" as const,
          id: "User Palette",
          name: "User Palette",
          children: [],
          absRoot: defaultPaletteDir,
          relFolder: "",
          acceptImports: true,
        },
        ...tree,
      ];
    }
    return tree;
  }, [paletteItems, meta, search, defaultPaletteDir]);

  const items: ListItem[] = useMemo(() => {
    const base =
      tab === "recent"
        ? recentItems
        : tab === "current"
          ? openItems
          : tab === "templates"
            ? templateItems
            : paletteListItems;
    const filtered = base
      .filter((item) => {
        if (tab === "palette" || tab === "current") return true;
        if (!tagFilter.length || item.isDefault) return true;
        const tags = projectMetaByPath[item.path]?.meta.tags ?? [];
        return tagsMatch(tags, tagFilter);
      })
      .map((item) => ({
        ...item,
        tags: projectMetaByPath[item.path]?.meta.tags ?? [],
        heroUrl: icons[item.path] ?? null,
      }));

    // Sessions: live ones first, ended ones grouped after them whatever the
    // sort — the list draws an "Ended" divider at the boundary.
    const liveFirst = (list: ListItem[]) =>
      tab === "current"
        ? [
            ...list.filter((i) => i.source !== "stale"),
            ...list.filter((i) => i.source === "stale"),
          ]
        : list;

    if (listSort.field === "default" && !listSort.reverse) return liveFirst(filtered);

    const sorted = [...filtered];
    if (listSort.field !== "default") {
      sorted.sort((a, b) => {
        // "Default (new project)" is an action, not a file — always first.
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        switch (listSort.field) {
          case "name":
            return a.displayName.localeCompare(b.displayName, undefined, {
              sensitivity: "base",
              numeric: true,
            });
          case "date": {
            // Current-tab rows have no file mtime loaded; fall back to uptime.
            const at = meta[a.path]?.mtimeSecs ?? a.openStartedAt ?? 0;
            const bt = meta[b.path]?.mtimeSecs ?? b.openStartedAt ?? 0;
            return bt - at; // newest first
          }
          case "size":
            return (meta[b.path]?.bytes ?? 0) - (meta[a.path]?.bytes ?? 0); // biggest first
          default:
            return 0;
        }
      });
    }
    if (listSort.reverse) sorted.reverse();
    return liveFirst(sorted);
  }, [tab, recentItems, openItems, templateItems, paletteListItems, tagFilter, projectMetaByPath, icons, listSort, meta]);

  // --- Each tab keeps its own selection -------------------------------------
  // selectedPath is one value shared by every tab, so picking a recent project
  // and switching to Templates left the footer offering to launch that recent
  // file from the Templates tab. Each tab now remembers what was last selected
  // in it; a tab with nothing remembered picks its natural default (Templates:
  // the Default template, Recent Files: the newest project).
  const tabSelectionRef = useRef<Partial<Record<TabId, string>>>({});
  useEffect(() => {
    if (selectedPath) tabSelectionRef.current[tab] = selectedPath;
    // Deliberately not keyed on `tab`: a switch alone must not file the old
    // tab's selection under the new one.
  }, [selectedPath]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A selection that already belongs to this tab came WITH the switch (a
    // dropped .toe, a menu that selects and switches) -- keep it.
    if (selectedPath && items.some((i) => i.path === selectedPath)) return;
    const remembered = tabSelectionRef.current[tab];
    if (remembered && items.some((i) => i.path === remembered)) {
      setSelectedPath(remembered);
      return;
    }
    if (tab === "templates") {
      const def = items.find((i) => i.isDefault) ?? items[0];
      if (def) setSelectedPath(def.path);
    } else if (tab === "recent") {
      if (items[0]) setSelectedPath(items[0].path);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // "The tab it was left on" (Settings -> When TDXLU opens).
  useEffect(() => {
    try {
      localStorage.setItem(LAST_TAB_KEY, tab);
    } catch {
      /* private storage: the startup tab just won't be remembered */
    }
  }, [tab]);

  /**
   * What the list actually renders. A tour that spotlights an empty pane
   * teaches nothing — and on a fresh install every tab except Palette IS empty.
   * So while the tour is up, an empty list borrows stand-in rows. Real content
   * always wins, and the tour's backdrop makes the fakes unclickable.
   */
  const displayItems: ListItem[] = useMemo(
    () => (tourOpen && items.length === 0 ? demoItems(tab) : items),
    [tourOpen, items, tab],
  );

  // Built here, not up with the other tour state, because the demo-data notice
  // depends on which lists came back empty.
  const tourSteps = useMemo(
    () =>
      buildTourSteps({
        patreonEnabled,
        fnsTabShown,
        mod,
        isMac,
        hotkey: config?.global_hotkey,
        hotkeyMain: config?.global_hotkey_main,
        wizardFollows: !wizardSeen,
        bundledUtility: !!bundledUtilityTox,
        usesDemoData: !recentItems.length || !templateItems.length || !openItems.length,
      }),
    [
      patreonEnabled,
      fnsTabShown,
      mod,
      isMac,
      config?.global_hotkey,
      config?.global_hotkey_main,
      wizardSeen,
      bundledUtilityTox,
      recentItems.length,
      templateItems.length,
      openItems.length,
    ],
  );

  const isGallery = (config?.view_mode || "gallery") === "gallery";
  // On the Patreon tab the right stack hosts the post detail (video + text).
  const patreonDetailOpen = tab === "patreon" && !!patreonCampaign;
  const sideOpen =
    patreonDetailOpen ||
    (tab !== "patreon" && tab !== "fns" &&
      (!!config?.show_readme || gitOpen || backupOpen || watchOpen || mcpOpen ||
        ((controlOpen || mediaOpen) && tab === "current")));
  const patreonBasePost = patreonPosts.find((p) => p.id === patreonPostId) ?? null;
  // Overlay the on-demand full detail (content/embed/image) onto the list row.
  const patreonSelectedPost: PatreonToxPost | null = patreonBasePost
    ? (() => {
        const d = patreonDetailCache[patreonBasePost.id];
        return d
          ? {
              ...patreonBasePost,
              contentHtml: d.contentHtml ?? patreonBasePost.contentHtml,
              teaser: d.teaser ?? patreonBasePost.teaser,
              embedHtml: d.embedHtml ?? patreonBasePost.embedHtml,
              embedUrl: d.embedUrl ?? patreonBasePost.embedUrl,
              embedProvider: d.embedProvider ?? patreonBasePost.embedProvider,
              imageUrl: d.imageUrl ?? patreonBasePost.imageUrl,
              isVideo: d.isVideo,
              contentIsRich: d.contentIsRich,
            }
          : patreonBasePost;
      })()
    : null;

  const factoryVersionOptions = useMemo(() => {
    return discover.versions
      .filter((v) => v.install_path || v.app_path)
      .slice()
      .sort((a, b) =>
        versionNumeric(a.key).localeCompare(versionNumeric(b.key), undefined, {
          numeric: true,
        }),
      );
  }, [discover.versions]);

  const setFactoryVersion = (key: string) => {
    setFactoryVersionKey(key);
    factoryVersionKeyRef.current = key;
    saveFactoryVersionKey(key);
    void refreshLists(undefined, { rediscover: false });
  };

  const nameColCh = useMemo(() => {
    const longest = items.reduce((m, i) => {
      // Chips render inside the name cell — budget for them, or the name pays
      // for every badge with an ellipsis while the path column keeps its slack.
      let extra = 0;
      if ((i.familyCount ?? 0) >= 2) extra += 5;
      if (i.familyCrash) extra += 4;
      if ((i.openInstances?.length ?? 0) > 1) extra += 4;
      if (i.openMcpAvailable && i.openEnvoyPort != null) extra += 11;
      return Math.max(m, i.displayName.length + extra);
    }, 22);
    return Math.min(Math.max(longest + 1, 18), 48);
  }, [items]);

  // Keep the selected row in view when the selection moves (keyboard nav,
  // search filter, tab switch, load) — once per move. `items` is rebuilt
  // whenever lazy thumbnails or metadata land and every sessions refresh;
  // scrolling on each of those yanked the list back to the selection while
  // the user was scrolling elsewhere. `items` stays a dependency only so a
  // selection whose row hasn't rendered yet is still scrolled to once it does.
  const scrolledSelectionRef = useRef("");
  useEffect(() => {
    if (!selectedPath || !selectedFileRef.current) return;
    const key = `${tab}\n${selectedPath}\n${search}\n${focus}`;
    if (scrolledSelectionRef.current === key) return;
    scrolledSelectionRef.current = key;
    selectedFileRef.current.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedPath, items, tab, search, focus]);

  const versionKeys = useMemo(() => {
    const list = usePlayer ? discover.players : discover.versions;
    return list.map((v) => v.key);
  }, [discover, usePlayer]);

  /**
   * What the tour's stand-in version panel lists: the machine's real installs
   * when it has any, plausible ones when it has none.
   */
  const demoVersionKeys = versionKeys.length ? versionKeys : DEMO_VERSION_KEYS;

  const applyTemplateDefaultVersion = useCallback(() => {
    const resolved = resolveTemplateVersion(templateDefaultVersion, versionKeys);
    if (resolved) setSelectedVersion(resolved);
  }, [templateDefaultVersion, versionKeys]);

  const setTemplateVersionPref = (pref: string) => {
    setTemplateDefaultVersion(pref);
    saveTemplateDefaultVersion(pref);
    const resolved = resolveTemplateVersion(pref, versionKeys);
    if (resolved) setSelectedVersion(resolved);
  };

  const versionInstalled = useMemo(() => {
    if (!buildInfo) return true;
    if (selectedPath === DEFAULT_TEMPLATE) return versionKeys.length > 0;
    const target = versionNumeric(buildInfo);
    const list = usePlayer ? discover.players : discover.versions;
    return list.some((v) => versionNumeric(v.key) === target);
  }, [buildInfo, discover, usePlayer, selectedPath, versionKeys.length]);

  const applyBuildSelection = useCallback(
    (info: string | null, player: boolean) => {
      if (tab === "templates") {
        const keys = (player ? discover.players : discover.versions).map((v) => v.key);
        const resolved = resolveTemplateVersion(templateDefaultVersion, keys);
        if (resolved) setSelectedVersion(resolved);
        return;
      }
      if (!info) {
        const keys = (player ? discover.players : discover.versions).map((v) => v.key);
        const newest = newestMainlineKey(keys);
        if (newest) setSelectedVersion(newest);
        return;
      }
      const keys = (player ? discover.players : discover.versions).map((v) => v.key);
      setSelectedVersion(findMatchingVersionKey(info, keys, player));
    },
    [discover.players, discover.versions, tab, templateDefaultVersion],
  );

  // Analyze selected file (cached; TouchPlayer toggle does not re-inspect)
  useEffect(() => {
    if (!selectedPath || isToxPath(selectedPath)) {
      setBuildInfo(null);
      setAnalyzing(false);
      if (selectedPath === DEFAULT_TEMPLATE || (tab === "templates" && selectedPath)) {
        applyTemplateDefaultVersion();
      } else if (isToxPath(selectedPath) && versionKeys.length && !selectedVersion) {
        const newest = newestMainlineKey(versionKeys);
        if (newest) setSelectedVersion(newest);
      }
      return;
    }
    if (selectedPath === DEFAULT_TEMPLATE) {
      setBuildInfo(null);
      setAnalyzing(false);
      applyTemplateDefaultVersion();
      return;
    }
    if (tab === "templates") {
      // Templates: still inspect for info display; launch version from default dropdown
      if (meta[selectedPath] && !meta[selectedPath].exists) {
        setBuildInfo(null);
        setAnalyzing(false);
        applyTemplateDefaultVersion();
        return;
      }
      const cached = versionCache.current.get(selectedPath);
      if (cached !== undefined) {
        setBuildInfo(cached);
        setAnalyzing(false);
        applyTemplateDefaultVersion();
        return;
      }
      const id = ++analysisId.current;
      setAnalyzing(true);
      const t = window.setTimeout(async () => {
        try {
          const info = await api.inspectToe(selectedPath);
          if (analysisId.current !== id) return;
          versionCache.current.set(selectedPath, info);
          setBuildInfo(info);
          applyTemplateDefaultVersion();
        } finally {
          if (analysisId.current === id) setAnalyzing(false);
        }
      }, 40);
      return () => clearTimeout(t);
    }
    if (meta[selectedPath] && !meta[selectedPath].exists) {
      setBuildInfo(null);
      setAnalyzing(false);
      return;
    }

    // The session pane reports the running version, so clicking around the
    // Current tab no longer needs a toeexpand spawn per selection. Relaunch
    // still resolves a version on demand.
    if (tab === "current") {
      setAnalyzing(false);
      return;
    }

    const cached = versionCache.current.get(selectedPath);
    if (cached !== undefined) {
      setBuildInfo(cached);
      setAnalyzing(false);
      applyBuildSelection(cached, usePlayer);
      return;
    }

    const id = ++analysisId.current;
    setAnalyzing(true);
    const t = window.setTimeout(async () => {
      try {
        const info = await api.inspectToe(selectedPath);
        if (analysisId.current !== id) return;
        versionCache.current.set(selectedPath, info);
        setBuildInfo(info);
        applyBuildSelection(info, usePlayer);
      } finally {
        if (analysisId.current === id) setAnalyzing(false);
      }
    }, 40);
    return () => clearTimeout(t);
  }, [selectedPath, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remap selected version when TouchPlayer toggles — no toeexpand
  useEffect(() => {
    if (!selectedPath) return;
    if (tab === "templates" || selectedPath === DEFAULT_TEMPLATE) {
      applyTemplateDefaultVersion();
      return;
    }
    applyBuildSelection(buildInfo, usePlayer);
  }, [usePlayer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep template version in sync when installs list or preference changes
  useEffect(() => {
    if (tab !== "templates" && selectedPath !== DEFAULT_TEMPLATE) return;
    applyTemplateDefaultVersion();
  }, [tab, templateDefaultVersion, versionKeys, applyTemplateDefaultVersion, selectedPath]);

  // README
  useEffect(() => {
    if (!config?.show_readme || !selectedPath || selectedPath === DEFAULT_TEMPLATE || isToxPath(selectedPath)) {
      setReadme({ path: null, content: "", summary: "" });
      setReadmeEdit(false);
      return;
    }
    let cancelled = false;
    api.getReadme(selectedPath).then((r) => {
      if (cancelled) return;
      setReadme(r);
      setReadmeDraft(r.content);
      setReadmeEdit(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, config?.show_readme]);

  /**
   * The installed build the file-open countdown will substitute when the one
   * the project was saved with is missing, or null to not count down at all.
   *
   * The countdown otherwise refuses on a missing build: opening a `.toe` in a
   * different one can raise an upgrade prompt, or fail outright across a
   * release-year boundary, and a countdown that fires on its own shouldn't walk
   * into that uninvited. `cli_fallback_version` is how the user opts in and
   * says which build to use.
   */
  const cliFallbackVersion = useMemo(
    () =>
      cliMode && buildInfo && !versionInstalled
        ? resolveCliFallbackVersion(
            config?.cli_fallback_version ?? CLI_FALLBACK_UNSET,
            buildInfo,
            versionKeys,
            usePlayer,
          )
        : null,
    [cliMode, buildInfo, versionInstalled, config?.cli_fallback_version, versionKeys, usePlayer],
  );

  const cliVersionReady = versionInstalled || !!cliFallbackVersion;

  /**
   * The one-time "which build?" prompt: shown the first time a project arrives
   * from the file manager needing a build that isn't installed, when the user
   * has never answered the question (in the wizard or in Settings).
   *
   * Latched per file-open so dismissing it doesn't re-prompt on every render,
   * and skipped entirely with no installs at all — there would be nothing to
   * offer, and the existing download box already covers that case.
   */
  const cliFallbackAsked = useRef<string | null>(null);
  useEffect(() => {
    if (
      !cliMode ||
      !selectedPath ||
      !buildInfo ||
      versionInstalled ||
      analyzing ||
      !versionKeys.length ||
      (config?.cli_fallback_version ?? CLI_FALLBACK_UNSET) !== CLI_FALLBACK_UNSET ||
      cliFallbackAsked.current === selectedPath
    ) {
      return;
    }
    cliFallbackAsked.current = selectedPath;
    setModal("cliFallback");
  }, [cliMode, selectedPath, buildInfo, versionInstalled, analyzing, versionKeys.length, config?.cli_fallback_version]);

  /** Answer the prompt: remember the policy, and launch now unless it was "let me pick". */
  const answerCliFallback = async (preference: string, launchWith: string | null) => {
    setModal(null);
    await updatePref({ cli_fallback_version: preference });
    if (launchWith && selectedPath) {
      setSelectedVersion(launchWith);
      await runLaunch(selectedPath, launchWith, usePlayer, true);
    } else {
      setCliMode(false);
      setFocus("versions");
    }
  };

  /**
   * Point the selection at the substitute so the version list highlights what
   * is actually about to launch — `applyBuildSelection` picks the *closest*
   * build on its own, which is only right when that is also the preference.
   *
   * Any click or keypress cancels the countdown and drops us out of file-open
   * mode, so this can never fight a manual pick.
   */
  useEffect(() => {
    if (cliFallbackVersion && selectedVersion !== cliFallbackVersion) {
      setSelectedVersion(cliFallbackVersion);
    }
  }, [cliFallbackVersion, selectedVersion]);

  // Countdown for CLI mode
  useEffect(() => {
    if (!cliMode || !selectedPath || !buildInfo || !cliVersionReady || analyzing) {
      setCountdown(null);
      return;
    }
    setCountdown(COUNTDOWN_SECS);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = window.setInterval(() => {
      setCountdown((c) => {
        if (c === null) return null;
        if (c <= 1) {
          if (countdownTimer.current) clearInterval(countdownTimer.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => {
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [cliMode, selectedPath, buildInfo, cliVersionReady, analyzing]);

  useEffect(() => {
    if (countdown === 0 && selectedPath && selectedVersion) {
      void doLaunch(true);
    }
  }, [countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelCountdown = () => {
    setCountdown(null);
    setCliMode(false);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
  };

  /** The live session already running this exact `.toe`, if there is one. */
  const liveSessionFor = (path: string) =>
    openProjects.find((p) => p.alive && normPath(p.path) === normPath(path)) ?? null;

  const runLaunch = async (
    path: string,
    versionKey: string,
    player: boolean,
    promote: boolean,
  ) => {
    try {
      await api.launchProject(path, versionKey, player, promote);
      void refreshOpen();
      // Jump to the Current tab so the new session is front-and-center (the tab
      // state persists even if the window hid to tray).
      if (config?.switch_to_current_after_launch !== false) setTab("current");
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /**
   * Launch `path`, but stop first if that project is already running.
   *
   * TouchDesigner will happily open the same `.toe` twice, and the two
   * processes share the project's `.embody` and externalized files — so the
   * last save silently wins. Launching a second copy is sometimes what you
   * want; doing it by accident (an extra Enter, a countdown that fired while
   * you were elsewhere) is not. Ask rather than spawn.
   *
   * This guards only launches that go THROUGH the launcher. Opening the same
   * file from Explorer or an autostart service never reaches this code — which
   * is why the Current tab also reports duplicates after the fact.
   */
  /** Start TouchDesigner with its default startup file (Templates' Default
   *  entry) in the Templates tab's default version. Shared by the Ctrl+1
   *  action and a right-click on the big Launch button. Returns the version
   *  used, or null when no TouchDesigner is installed. */
  const launchDefaultStartup = (): string | null => {
    const keys = (usePlayer ? discover.players : discover.versions).map((v) => v.key);
    const version = resolveTemplateVersion(templateDefaultVersion, keys);
    if (!version) {
      setStatusMsg("No TouchDesigner installed to start");
      return null;
    }
    setStatusMsg(
      `Starting ${usePlayer ? "TouchPlayer" : "TouchDesigner"} ${versionNumeric(version)} with its default startup file`,
    );
    void api.launchProject(DEFAULT_TEMPLATE, version, usePlayer, false).catch((e) =>
      setStatusMsg(String(e)),
    );
    return version;
  };

  const startLaunch = async (
    path: string,
    versionKey: string,
    player: boolean,
    promote: boolean,
    displayName?: string,
  ) => {
    const open = liveSessionFor(path);
    if (open) {
      setAlreadyOpenTarget({
        path,
        displayName: displayName || open.display_name || basename(path),
        versionKey,
        usePlayer: player,
        promote,
        pid: open.pid,
        instances: open.instances?.length ?? 1,
      });
      setModal("alreadyOpen");
      return;
    }
    await runLaunch(path, versionKey, player, promote);
  };

  const doLaunch = async (promote = true) => {
    if (!selectedPath || !selectedVersion) return;
    cancelCountdown();
    await startLaunch(selectedPath, selectedVersion, usePlayer, promote);
  };

  const selectItem = (item: ListItem) => {
    cancelCountdown();
    // Tour stand-ins are display-only. The tour's backdrop already swallows
    // clicks; this is the belt to that suspender.
    if (isDemoPath(item.path)) return;
    if (item.missing) return;
    setSelectedPath(item.path);
    setFocus("picker");
    if (item.openVersionKey && versionKeys.includes(item.openVersionKey)) {
      setSelectedVersion(item.openVersionKey);
    }
    if (item.source === "process" || item.source === "launcher") {
      // Keep TouchPlayer toggle aligned when we know how it was launched
      const open = openProjects.find(
        (p) => p.path.replace(/\\/g, "/").toLowerCase() === item.path.replace(/\\/g, "/").toLowerCase(),
      );
      if (open) setUsePlayer(open.use_touchplayer);
    }
  };

  // Recent tab used to land with nothing selected — the whole detail half of
  // the window empty and the Launch button disabled. Select the most recent
  // project instead (double-click is still what launches).
  useEffect(() => {
    if (tab !== "recent" || selectedPath) return;
    const first = displayItems.find(
      (i) => !i.missing && !i.isDefault && !isToxPath(i.path) && !isDemoPath(i.path),
    );
    if (first) selectItem(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectItem is stable enough; run on list/tab changes only
  }, [tab, displayItems, selectedPath]);

  // Sessions are self-contained cards, so always keep one live card in focus
  // when the tab opens or the previously focused process disappears.
  useEffect(() => {
    if (tab !== "current" || displayItems.length === 0) return;
    const firstLook = !sessionCardsAutoOpenedRef.current;
    sessionCardsAutoOpenedRef.current = true;
    const focused = displayItems.find((i) => i.path === selectedPath);
    const next = focused ?? displayItems.find((i) => i.source !== "stale") ?? displayItems[0];
    if (!focused && !isDemoPath(next.path)) selectItem(next);
    setExpandedSessionCards((prev) => {
      const livePaths = new Set(displayItems.map((item) => item.path));
      const kept = new Set([...prev].filter((path) => livePaths.has(path)));
      // Open a card on the first look at the tab, or when the card that WAS
      // open belonged to a session that went away -- never because the user
      // closed the last open card. This runs on every session poll (the perf
      // readouts change the list each second or two), so "none open -> open
      // one" used to spring a just-collapsed card back open.
      const lostOpenCard = kept.size < prev.size;
      if (kept.size === 0 && (firstLook || lostOpenCard) && !isDemoPath(next.path)) {
        kept.add(next.path);
      }
      if (kept.size === prev.size && [...kept].every((path) => prev.has(path))) return prev;
      return kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectItem is intentionally not a dependency
  }, [tab, displayItems, selectedPath]);

  const focusOpenSession = async (pid: number | null | undefined) => {
    if (pid == null) {
      setStatusMsg("No PID for this session");
      return;
    }
    try {
      await api.openProjectFocus(pid);
      setStatusMsg(`Focused PID ${pid}`);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Re-read one session's windows. Cheaper than a full open-projects refresh
   *  (which shells out to a process scan), so window state can follow a click
   *  immediately instead of waiting for the next poll. */
  const refreshSessionWindows = async (pid: number, path: string) => {
    try {
      const windows = await api.sessionWindows(pid, path);
      setOpenProjects((prev) =>
        prev.map((p) => {
          // `pid` names a process, which on a twice-open project may not be the
          // one leading the row — update the instance that owns it and rebuild
          // the project's flattened window list from the instances.
          if (!(p.instances ?? []).some((i) => i.pid === pid)) return p;
          const instances = p.instances.map((i) => (i.pid === pid ? { ...i, windows } : i));
          return { ...p, instances, windows: instances.flatMap((i) => i.windows) };
        }),
      );
    } catch {
      /* the poll will catch up */
    }
  };

  /** Focus/minimize/restore one OS window of a session. */
  const runWindowAction = async (win: SessionWindow, action: WindowAction, path: string) => {
    try {
      await api.sessionWindowAction(win.id, action);
      const verb = action === "focus" ? "Focused" : action === "minimize" ? "Minimized" : "Restored";
      setStatusMsg(`${verb} ${windowLabel(win, basename(path))}`);
    } catch (e) {
      setStatusMsg(String(e));
    }
    void refreshSessionWindows(win.pid, path);
  };

  const runSessionWindows = async (
    pid: number | null | undefined,
    path: string,
    action: "raise" | "minimize",
  ) => {
    if (pid == null) {
      setStatusMsg("No PID for this session");
      return;
    }
    try {
      await api.sessionWindowsBulk(pid, action);
      setStatusMsg(action === "raise" ? "Brought all windows forward" : "Minimized all windows");
    } catch (e) {
      setStatusMsg(String(e));
    }
    void refreshSessionWindows(pid, path);
  };

  const focusWindowEntry = async (entry: WindowEntry) => {
    setSwitcherOpen(false);
    await runWindowAction(entry.win, "focus", entry.projectPath);
  };

  const toggleWindowList = (path: string) => {
    setExpandedWindows((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const revealOpenSession = async (path: string) => {
    try {
      await api.openPath(path);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Confirm-and-kill one process. `pid` overrides the row's primary — that's
   *  how the instance list kills the specific process you picked rather than
   *  whichever one happens to lead the row. */
  const killOpenSession = (item: ListItem, pid = item.openPid) => {
    if (pid == null) {
      setStatusMsg("No PID for this session");
      return;
    }
    setKillTarget({
      path: item.path,
      displayName: item.displayName || basename(item.path),
      pid,
    });
    setModal("kill");
  };

  const confirmKillOpenSession = async () => {
    if (!killTarget) return;
    const { pid } = killTarget;
    try {
      const list = await api.openProjectKill(pid);
      setOpenProjects(list);
      setStatusMsg(`Killed PID ${pid}`);
    } catch (e) {
      setStatusMsg(String(e));
      void refreshOpen();
    } finally {
      setKillTarget(null);
      setModal(null);
    }
  };

  const resolveOpenLaunch = async (
    item: ListItem,
  ): Promise<{ versionKey: string; usePlayer: boolean } | null> => {
    const usePlayerFlag = item.openUsePlayer ?? usePlayer;
    const keys = (usePlayerFlag ? discover.players : discover.versions).map((v) => v.key);
    if (item.openVersionKey && keys.includes(item.openVersionKey)) {
      return { versionKey: item.openVersionKey, usePlayer: usePlayerFlag };
    }
    if (selectedPath === item.path && selectedVersion && keys.includes(selectedVersion)) {
      return { versionKey: selectedVersion, usePlayer: usePlayerFlag };
    }
    try {
      const info = await api.inspectToe(item.path);
      const matched = info
        ? findMatchingVersionKey(info, keys, usePlayerFlag)
        : newestMainlineKey(keys);
      if (!matched) {
        setStatusMsg("No matching TD version installed");
        return null;
      }
      return { versionKey: matched, usePlayer: usePlayerFlag };
    } catch (e) {
      setStatusMsg(String(e));
      return null;
    }
  };

  /** The variant family a path belongs to (`Project.toe` plus its increments,
   *  backups and crash autosaves), when the recents scan grouped one. */
  const familyFor = (path: string): ProjectFamily | null =>
    families.find((f) => f.member_paths.includes(normPath(path))) ?? null;

  /** A Current-tab row's title with the Increment-and-Save churn split off:
   *  `TDXLPP.8.toe` reads as `TDXLPP` plus a `·8` chip. TD renames the file
   *  under a running session on every increment, so the digits are noise in a
   *  title — and the un-numbered file is the family's canonical head (see
   *  `variants.rs`), usually the one in git. The exact file stays one hover
   *  away, and Relaunch targets the head (`relaunchPathFor`). */
  const sessionTitle = (item: ListItem): { name: string; inc: number | null } => {
    const m = /^(.*?)(?:\.(\d+))?\.toe$/i.exec(basename(item.path));
    if (!m) return { name: item.displayName, inc: null };
    return {
      name: familyFor(item.path)?.display_name || m[1],
      inc: m[2] ? Number(m[2]) : null,
    };
  };

  /** What Relaunch actually opens for a session row: the family HEAD
   *  (`Project.toe`), not the increment the session happened to be running.
   *  The head is the canonical file — the launcher already counts increments
   *  as reclaimable copies. One exception: a head OLDER than the running file
   *  would reopen stale work, which is worse than a numbered title, so there
   *  the running file wins (1 s of slack for filesystem timestamp coarseness). */
  const relaunchPathFor = (item: ListItem): string => {
    const fam = familyFor(item.path);
    if (!fam?.head) return item.path;
    const head = fam.variants.find((v) => normPath(v.path) === normPath(fam.head!));
    if (!head) return item.path;
    const running = fam.variants.find((v) => normPath(v.path) === normPath(item.path));
    if (running && (head.modified ?? 0) + 1 < (running.modified ?? 0)) return item.path;
    return fam.head;
  };

  const askRelaunchOpenSession = async (item: ListItem) => {
    const launch = await resolveOpenLaunch(item);
    if (!launch) return;
    const path = relaunchPathFor(item);
    setRelaunchTarget({
      path,
      displayName: basename(path),
      pid: item.openPid ?? null,
      versionKey: launch.versionKey,
      usePlayer: launch.usePlayer,
      fromPath: normPath(path) === normPath(item.path) ? undefined : item.path,
    });
    setRelaunchKillFirst(item.openPid != null);
    setModal("relaunch");
  };

  const confirmRelaunchOpenSession = async () => {
    if (!relaunchTarget) return;
    const { path, pid, versionKey, usePlayer: player, fromPath } = relaunchTarget;
    try {
      const list = await api.openProjectRelaunch(
        path,
        versionKey,
        player,
        relaunchKillFirst && pid != null,
        pid,
      );
      setOpenProjects(list);
      // Retargeted to the family head AND the old process is gone: its row is
      // an ended record for an increment nobody has open — supersede it rather
      // than leaving two same-named rows, one live and one dead.
      if (fromPath && relaunchKillFirst && pid != null) {
        void dismissStaleSession(fromPath);
      }
      setSelectedPath(path);
      setSelectedVersion(versionKey);
      setUsePlayer(player);
      setStatusMsg(
        relaunchKillFirst && pid != null
          ? `Relaunched (killed PID ${pid})`
          : pid != null
            ? // Not a relaunch at all — the old process is still running.
              `Launched a second copy of ${basename(path)} — PID ${pid} is still running`
            : `Relaunched ${basename(path)}`,
      );
    } catch (e) {
      setStatusMsg(String(e));
      void refreshOpen();
    } finally {
      setRelaunchTarget(null);
      setModal(null);
    }
  };

  /** Relaunch a stale (ended) session directly — its process is already gone,
   *  so no kill-first and no confirm; it knows the build it ran. */
  const relaunchStaleSession = async (item: ListItem) => {
    const launch = await resolveOpenLaunch(item);
    if (!launch) return;
    // The canonical file, not the increment this session died on.
    const path = relaunchPathFor(item);
    try {
      const list = await api.openProjectRelaunch(
        path,
        launch.versionKey,
        launch.usePlayer,
        false,
        null,
      );
      setOpenProjects(list);
      setSelectedPath(path);
      setSelectedVersion(launch.versionKey);
      setUsePlayer(launch.usePlayer);
      setStatusMsg(`Relaunched ${basename(path)}`);
      // The ended row pointed at the increment — superseded by the live head.
      if (normPath(path) !== normPath(item.path)) {
        void dismissStaleSession(item.path);
      }
    } catch (e) {
      setStatusMsg(String(e));
      void refreshOpen();
    }
  };

  const dismissStaleSession = async (path: string) => {
    // Drop the row now. The command's reply rebuilds the whole list, which
    // re-runs the process scan (~0.5 s on Windows), and the row used to sit
    // there until that returned. Ended rows only: a live session sharing the
    // path must not vanish before the reply confirms it.
    const key = perfKey(path);
    setOpenProjects((prev) =>
      prev.filter((p) => p.alive || perfKey(p.path) !== key),
    );
    try {
      setOpenProjects(await api.openProjectDismiss(path));
    } catch (e) {
      setStatusMsg(String(e));
      void refreshOpen();
    }
  };

  const watchOpenSession = async (item: ListItem) => {
    const launch = await resolveOpenLaunch(item);
    if (!launch) return;
    selectItem({ ...item, openVersionKey: launch.versionKey });
    setSelectedVersion(launch.versionKey);
    setUsePlayer(launch.usePlayer);
    try {
      // Attach to the live PID — do NOT launch a second TD (that was killing sessions).
      await api.watchStart(
        item.path,
        launch.versionKey,
        launch.usePlayer,
        item.openPid ?? null,
      );
      setWatchOpen(true);
      setStatusMsg(
        item.openPid != null
          ? `Heartbeat watching pid ${item.openPid} — keep Utility Heartbeat Active`
          : `Heartbeat watching ${item.displayName || basename(item.path)}`,
      );
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const openMcpForSession = (item: ListItem) => {
    selectItem(item);
    setMcpOpen(true);
  };

  /** Media panel is a session inspector view — Current tab only. */
  const openMediaForSession = (item: ListItem) => {
    selectItem(item);
    setMediaOpen(true);
  };

  /** Run one companion verb and say how it went in the status line.
   *  Returns the utility's reply on success, `null` when it failed or never
   *  ran -- so a caller that adds its own message can leave a failure
   *  standing instead of overwriting it (that is how Ensure Python env used to
   *  report "ready" for a request that had failed). */
  const runUtilityAction = async (
    item: ListItem,
    action: string,
    payload?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> => {
    if (!item.openUtilityAvailable) {
      setStatusMsg("Utility not available in this TD session");
      return null;
    }
    selectItem(item);
    const labels: Record<string, string> = {
      save: "Save",
      pulse: "Thumbnail",
      record: "Preview video",
      load_tox: "Load tox",
      ensure_tdpyenv: "Ensure TDPyEnvManager",
      update_utility: "Update utility",
    };
    const label = labels[action] ?? action;
    try {
      setStatusMsg(`${label}…`);
      const result = await api.openProjectUtility(item.path, action, payload);
      const ok =
        result &&
        typeof result === "object" &&
        "ok" in result &&
        (result as { ok?: boolean }).ok === false
          ? false
          : true;
      if (!ok) {
        const err =
          result && typeof result === "object" && "error" in result
            ? String((result as { error?: string }).error)
            : "failed";
        setStatusMsg(`${label} failed: ${err}`);
        return null;
      }
      if (action === "save") {
        setStatusMsg("Project saved");
      } else if (action === "update_utility") {
        setStatusMsg(
          "Utility repointed — the session reloads it in place (custom parameter values kept)",
        );
      } else if (action === "pulse") {
        setStatusMsg("Thumbnail updated (project icon + preview.png)");
      } else if (action === "record") {
        setStatusMsg("Recording preview video…");
      } else if (action === "load_tox") {
        const loaded =
          result && typeof result === "object" && "loaded_path" in result
            ? String((result as { loaded_path?: string }).loaded_path ?? "")
            : "";
        const parent =
          result && typeof result === "object" && "parent" in result
            ? String((result as { parent?: string }).parent ?? "")
            : "";
        const resolved =
          result && typeof result === "object" && "resolved_from" in result
            ? String((result as { resolved_from?: string }).resolved_from ?? "")
            : "";
        const debug =
          result && typeof result === "object" && "debug" in result
            ? (result as { debug?: { panes?: unknown[]; resolved_parent?: string } }).debug
            : null;
        const panes = debug?.panes;
        if (panes && Array.isArray(panes)) {
          console.info("[load_tox debug]", debug);
        }
        const persisted =
          result && typeof result === "object" && "persisted_to" in result
            ? String((result as { persisted_to?: string }).persisted_to ?? "")
            : "";
        const paneSummary = Array.isArray(panes)
          ? panes
              .filter(
                (p): p is { is_networkeditor?: boolean; owner?: string; type?: string } =>
                  !!p && typeof p === "object",
              )
              .filter((p) => p.is_networkeditor)
              .map((p) => p.owner ?? "?")
              .join(", ")
          : "";
        setStatusMsg(
          [
            `Loaded ${loaded || "tox"}`,
            parent ? `parent=${parent}` : null,
            resolved ? `[${resolved}]` : null,
            paneSummary ? `NEs:[${paneSummary}]` : null,
            persisted ? "(saved to tox/)" : null,
          ]
            .filter(Boolean)
            .join(" "),
        );
      } else if (action === "ensure_tdpyenv") {
        const already =
          result &&
          typeof result === "object" &&
          "already" in result &&
          Boolean((result as { already?: boolean }).already);
        const p =
          result && typeof result === "object" && "path" in result
            ? String((result as { path?: string }).path ?? "")
            : "";
        setStatusMsg(
          already
            ? `TDPyEnvManager already at ${p}`
            : `Dropped TDPyEnvManager → ${p}`,
        );
      } else {
        setStatusMsg(`${label} ok`);
      }
      if (action === "pulse" || action === "record") {
        // Wait out the actual clip length (TD keeps writing until it stops),
        // not a fixed guess — Rec Seconds goes up to 30.
        const recSeconds =
          result && typeof result === "object" && "seconds" in result
            ? Number((result as { seconds?: number }).seconds) || 0
            : 0;
        const delay = action === "record" ? recSeconds * 1000 + 1500 : 800;
        window.setTimeout(() => {
          void api.getProjectMeta(item.path).then((info) => {
            setProjectMetaByPath((prev) => ({ ...prev, [item.path]: info }));
            // The still the card shows is the hero (preview.png when there is
            // one), keyed by its modified time, so a fresh one is a new URL.
            if (info.hero_path) {
              const url = mediaSrc(info.hero_path, "image", info.hero_mtime ?? undefined);
              setIcons((prev) => ({ ...prev, [item.path]: url }));
            } else {
              void api.getIconDataUrl(item.path).then((url) => {
                if (url) setIcons((prev) => ({ ...prev, [item.path]: url }));
              });
            }
            setMediaVersion((v) => v + 1);
          });
          // Recent shows the project under its own spelling (the head file,
          // other versions), so the session's path alone leaves those rows on
          // the old image: re-read the library too.
          void refreshLists(undefined, { rediscover: false });
        }, delay);
      }
      return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    } catch (e) {
      setStatusMsg(`${label} failed: ${String(e)}`);
      return null;
    }
  };

  // --- Registry-announced session commands (capability injection) ---------
  // The Current view is a CONSUMER: tools in the session register commands
  // targeting the `session` / `context-menu` surfaces (FNS_CommandRegistry
  // ≥ 1.7.0) and the launcher renders what it is told. Generic rendering
  // only here; blessed capabilities (`capability` ids) swap in rich UI where
  // the launcher recognises them. See docs/fns-plus-capabilities.md D2.

  const refreshSessionCommands = useCallback(async (path: string) => {
    try {
      const res = (await api.openProjectUtility(path, "fns_commands", null)) as {
        ok?: boolean;
        commands?: FnsToolCommand[];
      } | null;
      if (res && res.ok !== false && Array.isArray(res.commands)) {
        const commands = res.commands;
        setSessionCommands((prev) => ({ ...prev, [normPath(path)]: commands }));
      }
    } catch {
      // Old companion answers `unknown action` — treat as "no commands",
      // never as an error worth surfacing (same contract as the quick
      // palette's fetch).
      setSessionCommands((prev) =>
        normPath(path) in prev ? { ...prev, [normPath(path)]: [] } : prev,
      );
    }
  }, []);

  /** Effective visibility for a surfaced command: the user's quick-launch
   *  curation (keyed on the project-stable `tool#id` identity) beats the
   *  tool's declared `hidden` default, in either direction — ONE curation
   *  store for every surface. */
  const sessionCommandVisible = (c: FnsToolCommand) => {
    const identity = `${c.tool}#${c.id}`;
    if ((config?.quick_shown_commands ?? []).includes(identity)) return true;
    if ((config?.quick_hidden_commands ?? []).includes(identity)) return false;
    return !c.hidden;
  };

  /** Visible commands a session's tools target at SURFACE ("session" |
   *  "context-menu"). Commands without a `surface` field never appear here —
   *  absent means quick-launch only, exactly the pre-1.7.0 behaviour. */
  const surfaceCommands = (item: ListItem, surface: string) =>
    (sessionCommands[normPath(item.path)] ?? []).filter(
      (c) => (c.surface ?? []).includes(surface) && sessionCommandVisible(c),
    );

  /** Every command a session's tools registered under one blessed
   *  capability id — visible AND hidden (the hidden ones are the rich
   *  flow's verbs, e.g. fns.collect's apply/status). */
  const capabilityCommands = (item: ListItem, capability: string) =>
    (sessionCommands[normPath(item.path)] ?? []).filter((c) => c.capability === capability);

  /** The blessed fns.collect trio when the session advertises it; null
   *  means drive the legacy collect_save / collect_status verbs instead
   *  (old companion — the D7 deprecation window). */
  const collectCommandKeys = (item: ListItem) => {
    const cmds = capabilityCommands(item, "fns.collect");
    const byId = (id: string) => cmds.find((c) => c.id === id)?.key;
    const plan = byId("collect") ?? byId("plan");
    const apply = byId("apply");
    const status = byId("status");
    return plan && apply && status ? { plan, apply, status } : null;
  };

  /** The blessed fns.autosave trio when the session advertises it. Null means
   *  the FNS_Autosave package is not installed — there is no fallback: the
   *  companion's own autosave_* verbs were retired when D7 closed. */
  const autosaveCommandKeys = (item: ListItem) => {
    const cmds = capabilityCommands(item, "fns.autosave");
    const byId = (id: string) => cmds.find((c) => c.id === id)?.key;
    const get = byId("autosave_get") ?? byId("autosave");
    const set = byId("autosave_set");
    const now = byId("autosave_now");
    return get && set && now ? { get, set, now } : null;
  };

  /** Run one blessed-capability command. The registry relays the tool's
   *  reply dict merged over {ok, key, tool}, so callers read the same
   *  shape the legacy verb answered. kwargs ride as real JSON (lists and
   *  bools survive) — declared-param coercion only applies to prompts. */
  const runCapabilityCommand = (
    path: string,
    key: string,
    kwargs?: Record<string, unknown>,
  ) =>
    api.openProjectUtility(path, "fns_run_command", {
      key,
      ...(kwargs ? { kwargs } : {}),
    });

  /** Surface dispatch: blessed capabilities open the launcher's rich UI
   *  (docs/fns-plus-capabilities.md D6 — recognised id ⇒ rich modal,
   *  unknown ⇒ generic rendering); everything else runs generically. */
  const runSurfacedCommand = (item: ListItem, cmd: FnsToolCommand) => {
    if (cmd.capability === "fns.collect") {
      void collectSaveIntoSession(item);
      return;
    }
    if (cmd.capability === "fns.media-browser") {
      openMediaForSession(item);
      return;
    }
    if (cmd.capability === "fns.autosave") {
      openAutosaveForSession(item);
      return;
    }
    if (cmd.capability === "fns.mobile-control") {
      // FNS_Remote serves its own pairing page from inside TD; the
      // launcher just asks it to, then shows what came back.
      void runSessionCommand(item, cmd);
      return;
    }
    void runSessionCommand(item, cmd);
  };

  /** Seed the argument prompt: live `current` beats the static default, and
   *  a single-param command reuses its `state` value (the registry contract's
   *  prefill rules). Values stay strings — TD-side coercion owns types. */
  const seedCmdPromptValues = (cmd: FnsToolCommand) => {
    const vals: Record<string, string> = {};
    const params = cmd.params ?? [];
    for (const p of params) {
      const cur = p.current ?? (params.length === 1 ? cmd.state : undefined);
      const seed = cur !== undefined ? cur : p.default;
      if (seed !== undefined) {
        vals[p.name] = typeof seed === "boolean" ? (seed ? "on" : "off") : String(seed);
      }
    }
    return vals;
  };

  const runSessionCommand = async (
    item: ListItem,
    cmd: FnsToolCommand,
    kwargs?: Record<string, string>,
  ) => {
    if ((cmd.params?.length ?? 0) > 0 && !kwargs) {
      setCmdPromptValues(seedCmdPromptValues(cmd));
      setCmdPrompt({ item, cmd });
      setModal("cmdPrompt");
      return;
    }
    const cmdTitle = withInstance(cmd.label, cmd.instance);
    try {
      setStatusMsg(`${cmdTitle}…`);
      const res = (await api.openProjectUtility(item.path, "fns_run_command", {
        key: cmd.key,
        ...(kwargs && Object.keys(kwargs).length ? { kwargs } : {}),
      })) as { ok?: boolean; error?: string } | null;
      if (res && typeof res === "object" && res.ok === false) {
        setStatusMsg(`${cmdTitle} failed: ${res.error ?? "failed"}`);
      } else {
        setStatusMsg(`${cmdTitle} ✓ (${canonicalToolName(cmd.tool)})`);
      }
    } catch (e) {
      setStatusMsg(`${cmdTitle} failed: ${String(e)}`);
    } finally {
      // State chips are query-time values — refetch so ON/OFF and prefills
      // reflect what the command just changed.
      void refreshSessionCommands(item.path);
    }
  };

  // Blessed fns.media-browser keys for the selected session, by the legacy
  // verb name MediaPanel speaks — null routes the panel down the legacy
  // media_* verbs (old companion, D7 deprecation window).
  const mediaCommandKeys = useMemo(() => {
    if (!selectedPath) return null;
    const cmds = (sessionCommands[normPath(selectedPath)] ?? []).filter(
      (c) => c.capability === "fns.media-browser",
    );
    if (!cmds.length) return null;
    const byId = (id: string) => cmds.find((c) => c.id === id)?.key;
    const pairs: [string, string | undefined][] = [
      ["media_list", byId("list") ?? byId("media")],
      ["media_replace", byId("replace")],
      ["media_sync", byId("sync_timeline")],
      ["media_probe", byId("probe")],
      ["media_unreferenced", byId("unreferenced")],
    ];
    const out: Record<string, string> = {};
    for (const [verb, key] of pairs) if (key) out[verb] = key;
    return Object.keys(out).length ? out : null;
  }, [selectedPath, sessionCommands]);

  // Selected session's companion presence, folded to a single string so the
  // fetch effect fires on selection/companion changes — not every poll tick.
  const selUtilityPath =
    tab === "current" &&
    selectedPath &&
    items.find((i) => i.path === selectedPath)?.openUtilityAvailable
      ? selectedPath
      : null;
  useEffect(() => {
    if (selUtilityPath) void refreshSessionCommands(selUtilityPath);
  }, [selUtilityPath, refreshSessionCommands]);

  // A companion freshly appeared on the bus (launcher started after TD,
  // utility injected or reloaded) — the same wake the quick palette
  // prefetches on. Fetch so the Current bar lights up without a reselect.
  useEffect(() => {
    const un = listen<{ id?: string }>("utility-hello", (e) => {
      const id = e.payload?.id;
      if (id) void refreshSessionCommands(id);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refreshSessionCommands]);

  /** Read one session's autosave state into the cache. Null when the verb is
   *  missing (pre-0.10.0 companion) or the call failed - the reason lands in
   *  autosaveError for the modal to show.
   *
   *  `quiet` is the row-chip prefetch: it fills the cache and NOTHING else.
   *  autosaveError and the interval draft belong to whichever session the
   *  dialog is showing, so a background read of a different session must not
   *  touch them (it would retitle the error and overwrite what you were
   *  typing). */
  const refreshAutosave = async (
    item: ListItem,
    quiet = false,
  ): Promise<AutosaveState | null> => {
    if (!item.openUtilityAvailable) return null;
    try {
      const keys = autosaveCommandKeys(item);
      if (!keys) {
        if (!quiet) setAutosaveError(AUTOSAVE_MOVED);
        return null;
      }
      const state = (await runCapabilityCommand(item.path, keys.get)) as AutosaveState;
      if (!state || state.ok === false) {
        if (!quiet) setAutosaveError(autosaveErrorText(state?.error));
        return null;
      }
      if (!quiet) setAutosaveError(null);
      setAutosaveByPath((prev) => ({ ...prev, [item.path]: state }));
      if (!quiet) setAutosaveIntervalDraft(String(state.interval));
      return state;
    } catch (e) {
      if (!quiet) setAutosaveError(autosaveErrorText(String(e)));
      return null;
    }
  };

  const openAutosaveForSession = (item: ListItem) => {
    if (!item.openUtilityAvailable) {
      setStatusMsg("Utility not available in this TD session");
      return;
    }
    selectItem(item);
    setAutosaveTarget(item);
    setAutosaveError(null);
    setModal("autosave");
    void refreshAutosave(item);
  };

  /** Write settings through the companion; its reply IS the new state. */
  const applyAutosave = async (item: ListItem, fields: AutosaveFields) => {
    setAutosaveBusy(true);
    try {
      const keys = autosaveCommandKeys(item);
      if (!keys) {
        setAutosaveError(AUTOSAVE_MOVED);
        return;
      }
      const state = (await runCapabilityCommand(item.path, keys.set, {
        fields,
      })) as AutosaveState;
      if (!state || state.ok === false) {
        setAutosaveError(autosaveErrorText(state?.error));
        return;
      }
      setAutosaveError(null);
      setAutosaveByPath((prev) => ({ ...prev, [item.path]: state }));
      setAutosaveIntervalDraft(String(state.interval));
      if (fields.active !== undefined) {
        setStatusMsg(
          state.active
            ? `Autosave on - every ${formatAutosaveInterval(state.interval)}`
            : "Autosave off",
        );
      }
    } catch (e) {
      setAutosaveError(autosaveErrorText(String(e)));
    } finally {
      setAutosaveBusy(false);
    }
  };

  /** Commit the interval box - only when it parsed and actually changed. */
  const commitAutosaveInterval = (item: ListItem) => {
    const current = autosaveByPath[item.path];
    const minutes = Number(autosaveIntervalDraft);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setAutosaveIntervalDraft(String(current?.interval ?? 10));
      return;
    }
    if (current && Math.abs(minutes - current.interval) < 0.001) return;
    void applyAutosave(item, { interval: minutes });
  };

  /** Save this session now, in the autosave mode (skip toggles do not apply). */
  const runAutosaveNow = async (item: ListItem) => {
    setAutosaveBusy(true);
    try {
      const keys = autosaveCommandKeys(item);
      if (!keys) {
        setAutosaveError(AUTOSAVE_MOVED);
        return;
      }
      const res = (await runCapabilityCommand(item.path, keys.now)) as {
        ok?: boolean;
        error?: string;
        name?: string;
      };
      if (!res || res.ok === false) {
        setAutosaveError(autosaveErrorText(res?.error));
        setStatusMsg(`Save failed: ${res?.error ?? "failed"}`);
      } else {
        setStatusMsg(res.name ? `Saved ${res.name}` : "Project saved");
      }
    } catch (e) {
      setAutosaveError(autosaveErrorText(String(e)));
      setStatusMsg(String(e));
    } finally {
      setAutosaveBusy(false);
      await refreshAutosave(item);
    }
  };

  // Every session's row carries an autosave chip, so the state has to be known
  // for ALL of them, not just the selected one - "which of these shows is
  // protected?" is a question you ask while looking at the list, not after
  // clicking through it. One read per session, cached by path; writes refresh
  // their own entry, and the live readout only matters while the dialog is up.
  useEffect(() => {
    if (tab !== "current") return;
    for (const item of items) {
      if (!item.openUtilityAvailable || autosaveByPath[item.path]) continue;
      void refreshAutosave(item, true);
    }
  }, [tab, items]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Fetch the latest Embody release and load it into a running session.
   *
   * Composed from two shipped halves rather than a new install path: the tox
   * cache already resolves `owner/repo` to a release's `.tox` and downloads it
   * (on Rust's runtime, so TD's frame never blocks), and the companion already
   * has `load_tox`, which drops a local file into the session's network editor
   * pane. Nothing here runs Python in the session beyond that existing verb.
   */
  const addEmbodyToSession = async (item: ListItem) => {
    if (!item.openUtilityAvailable) {
      setStatusMsg("Utility not available in this TD session");
      return;
    }
    setEmbodyBusy(true);
    try {
      setStatusMsg("Fetching the latest Embody release…");
      const got = await api.cacheToxFromUrl(EMBODY_SOURCE);
      setStatusMsg(`Loading ${got.filename} into ${item.displayName}…`);
      const res = await api.openProjectUtility(item.path, "load_tox", {
        path: got.path,
        // Embody is infrastructure, not a project component — it does not
        // belong in {project}/tox/ alongside the artist's own .tox files.
        persist: false,
      });
      const r = (res ?? {}) as {
        ok?: boolean;
        error?: string;
        loaded_path?: string;
        parent?: string;
      };
      if (r.ok === false) {
        setStatusMsg(`Add Embody failed: ${r.error ?? "unknown error"}`);
        return;
      }
      setStatusMsg(
        `Added ${got.filename}${r.parent ? ` to ${r.parent}` : ""} — save the project to keep it`,
      );
      void refreshOpen();
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setEmbodyBusy(false);
    }
  };

  /** Companion: dry-run scan for external file refs, then confirm dialog. */
  const collectSaveIntoSession = async (item: ListItem) => {
    if (!item.openUtilityAvailable) {
      setStatusMsg("Utility not available in this TD session");
      return;
    }
    selectItem(item);
    try {
      setStatusMsg("Scanning for external files…");
      // Blessed rail first (fns.collect advertised), legacy verb otherwise.
      const keys = collectCommandKeys(item);
      if (!keys) {
        setStatusMsg(
          "Collect All & Save ships as the Collect package — install it from the FNSTools tab",
        );
        return;
      }
      const result = await runCapabilityCommand(item.path, keys.plan, { dry_run: true });
      const plan = (result ?? {}) as CollectPlan & { ok?: boolean; error?: string };
      if (plan.ok === false) {
        setStatusMsg(`Collect scan failed: ${plan.error ?? "failed"}`);
        return;
      }
      const nFiles = plan.files?.length ?? 0;
      const nNorm = plan.normalize?.length ?? 0;
      if (!nFiles && !nNorm) {
        const nSkip = plan.skipped?.length ?? 0;
        setStatusMsg(
          nSkip
            ? `Nothing collectable — ${nSkip} external ref(s) skipped (expressions / missing / sequences)`
            : "Nothing external to collect",
        );
        return;
      }
      setCollectPlan(plan);
      setCollectTarget(item);
      setCollectFreezeExpr(true);
      setCollectExcluded(new Set());
      setModal("collectConfirm");
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Apply phase: kick off the chunked collect in TD, then poll collect_status. */
  const confirmCollectSave = async () => {
    const item = collectTarget;
    const freeze = collectFreezeExpr;
    // Send exactly what the user confirmed: files that appear between the
    // dry-run and the apply are not silently swept in.
    const include = (collectPlan?.files ?? [])
      .filter((f) => !collectExcluded.has(f.src))
      .map((f) => f.src);
    setModal(null);
    setCollectPlan(null);
    setCollectTarget(null);
    if (!item) return;
    try {
      // Same rail the plan came over: blessed when advertised, legacy verb
      // otherwise. `include` and `expressions` ride as real JSON either way.
      const keys = collectCommandKeys(item);
      if (!keys) return;
      const started = (await runCapabilityCommand(item.path, keys.apply, {
        dry_run: false,
        expressions: freeze,
        include,
      })) as {
        ok?: boolean;
        error?: string;
        started?: boolean;
      } | null;
      if (started?.ok === false) {
        setStatusMsg(`Collect failed: ${started.error ?? "failed"}`);
        return;
      }
      if (!started?.started) {
        setStatusMsg("Nothing external to collect");
        return;
      }
      collectPollGen.current += 1;
      const gen = collectPollGen.current;
      const poll = async () => {
        if (gen !== collectPollGen.current) return;
        let status: CollectStatusSnapshot | null = null;
        try {
          status = (await runCapabilityCommand(
            item.path,
            keys.status,
          )) as CollectStatusSnapshot;
        } catch {
          status = null; // transient (TD busy saving) — keep polling
        }
        const phase = status?.phase ?? "";
        if (phase === "error") {
          setStatusMsg(`Collect failed: ${status?.error ?? "unknown error"}`);
          return;
        }
        if (phase === "done" || phase === "idle") {
          // "idle" = TD reloaded the utility right after the save wiped the
          // in-memory state and storage — the run itself is finished.
          const failed =
            status?.failed ??
            (status?.results ?? []).filter((r) => r && r.ok === false).length;
          const frozenCount = status?.frozen_count ?? status?.frozen?.length ?? 0;
          setStatusMsg(
            phase === "idle"
              ? "Collect finished, project saved"
              : [
                  `Collected ${status?.done_files ?? 0}/${status?.total_files ?? 0} file(s)`,
                  `${status?.rewrites ?? 0} ref(s) relinked`,
                  frozenCount ? `${frozenCount} expression(s) frozen` : null,
                  "project saved",
                  failed ? `${failed} failed` : null,
                ]
                  .filter(Boolean)
                  .join(", "),
          );
          return;
        }
        if (phase === "copying") {
          setStatusMsg(
            `Collecting… ${status?.done_files ?? 0}/${status?.total_files ?? 0} files (${formatBytes(
              status?.done_bytes ?? 0,
            )} / ${formatBytes(status?.total_bytes ?? 0)})`,
          );
        } else if (phase === "rewriting" || phase === "saving") {
          setStatusMsg(phase === "saving" ? "Collect: saving project…" : "Collect: relinking refs…");
        }
        window.setTimeout(() => void poll(), 1000);
      };
      setStatusMsg("Collecting…");
      window.setTimeout(() => void poll(), 800);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /**
   * Companion: scan for relative refs a change of project folder broke.
   *
   * `quiet` is the auto-offer path — it stays silent when there is nothing
   * to fix, because it fires on its own after a backup launches and a toast
   * on every clean backup would be noise.
   */
  const repointAssetsInSession = async (item: ListItem, quiet = false) => {
    if (!item.openUtilityAvailable) {
      if (!quiet) setStatusMsg("Utility not available in this TD session");
      return;
    }
    try {
      if (!quiet) setStatusMsg("Scanning for broken relative paths…");
      const plan = (await api.openProjectUtility(item.path, "repoint_assets", {
        dry_run: true,
      })) as RepointPlan;
      if (plan?.ok === false) {
        if (!quiet) setStatusMsg(`Repoint scan failed: ${plan.error ?? "failed"}`);
        return;
      }
      const fixes = plan?.fixes ?? [];
      if (!fixes.length) {
        if (!quiet) {
          const stuck = plan?.unresolved?.length ?? 0;
          setStatusMsg(
            stuck
              ? `No paths to re-root — ${stuck} broken ref(s) point at files that are missing everywhere`
              : "No broken relative paths in this session",
          );
        }
        return;
      }
      setRepointPlan(plan);
      setRepointTarget(item);
      setRepointExcluded(new Set());
      setModal("repointConfirm");
    } catch (e) {
      if (!quiet) setStatusMsg(String(e));
    }
  };

  /** Apply phase: re-root the confirmed refs. Fast and synchronous in TD
   *  (it assigns parameters, copies nothing), so there is nothing to poll. */
  const confirmRepointAssets = async () => {
    const item = repointTarget;
    const include = (repointPlan?.fixes ?? [])
      .filter((f) => !repointExcluded.has(f.ref))
      .map((f) => f.ref);
    setModal(null);
    setRepointPlan(null);
    setRepointTarget(null);
    if (!item || !include.length) return;
    try {
      const res = (await api.openProjectUtility(item.path, "repoint_assets", {
        include,
      })) as RepointResult;
      if (res?.ok === false) {
        setStatusMsg(`Repoint failed: ${res.error ?? "failed"}`);
        return;
      }
      const failed = res?.errors?.length ?? 0;
      setStatusMsg(
        [
          `Re-rooted ${res?.count ?? 0} of ${res?.attempted ?? include.length} path(s)`,
          failed ? `${failed} failed` : null,
          "not saved — save in TD to keep it",
        ]
          .filter(Boolean)
          .join(" · "),
      );
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /**
   * Offer to re-root assets as soon as a backup session comes up.
   *
   * A `.toe` launched from `Backup/` sits one level below the folder it was
   * saved from, so every project-relative reference misses and its media
   * loads empty. The scan is silent and only raises a dialog when there is
   * something to re-root — a clean backup says nothing. Each path is offered
   * once per live session, so declining stays declined, and relaunching the
   * same backup asks again.
   */
  useEffect(() => {
    for (const key of [...repointOffered.current]) {
      if (!openProjects.some((p) => p.alive && normPath(p.path) === key)) {
        repointOffered.current.delete(key);
      }
    }
    if (modal) return; // never stack this on top of another dialog
    const backup = openProjects.find(
      (p) =>
        p.alive &&
        isInBackupFolder(p.path) &&
        !repointOffered.current.has(normPath(p.path)),
    );
    if (!backup) return;
    if (!backup.utility_available) {
      // No companion to talk to, so there is no in-session fix. The standing
      // answer is the Duplicate that already exists: copied beside the
      // project, every relative path is correct again with nothing rewritten
      // — and unlike Restore as head it leaves the head alone.
      repointOffered.current.add(normPath(backup.path));
      setStatusMsg(
        `${backup.display_name} is running from Backup/ — relative asset paths ` +
          `resolve one level too deep. Without the companion, use "Duplicate as ` +
          `new version" to copy it beside the project, where they resolve.`,
      );
      return;
    }
    repointOffered.current.add(normPath(backup.path));
    void repointAssetsInSession(
      {
        path: backup.path,
        displayName: backup.display_name,
        missing: false,
        openUtilityAvailable: true,
      },
      true,
    );
  }, [openProjects, modal]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadToxIntoSession = async (item: ListItem) => {
    try {
      const files = await api.pickToxFiles(false);
      const tox = files[0];
      if (!tox) return;
      await runUtilityAction(item, "load_tox", {
        path: tox,
        persist: persistToxCopy,
      });
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const loadToxFromUrlIntoSession = (item: ListItem) => {
    setToxSourceTarget(item);
    setToxSourceDraft("");
    setModal("toxSource");
  };

  const submitToxSource = async (source: string) => {
    const trimmed = source.trim();
    const item = toxSourceTarget;
    if (!trimmed || !item) return;
    setModal(null);
    setToxSourceTarget(null);
    try {
      setStatusMsg("Caching tox…");
      const cached = await api.cacheToxFromUrl(trimmed);
      // Only remember sources that resolved — a typo shouldn't stick around
      setToxSourceHistory(rememberManualEntry("toxSource", trimmed));
      setStatusMsg(
        cached.fromCache
          ? `Cache hit: ${cached.filename}`
          : `Downloaded ${cached.filename}`,
      );
      await runUtilityAction(item, "load_tox", {
        path: cached.path,
        persist: persistToxCopy,
      });
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  // --- Patreon import (optional, build-gated; own tab) ----------------------

  const loadPatreonCampaigns = useCallback(async () => {
    setPatreonCampaign(null);
    setPatreonPosts([]);
    setPatreonError("");
    setPatreonLoading(true);
    // A refresh can mean "did anyone upload something new" — drop stale dates.
    patreonLatestPostCache.current.clear();
    patreonLatestPostInFlight.current.clear();
    setPatreonLatestPostByCampaign({});
    patreonLastUploadCache.current.clear();
    patreonLastUploadInFlight.current.clear();
    setPatreonLastUploadByCampaign({});
    try {
      setPatreonCampaigns(await api.patreonListCampaigns());
    } catch (e) {
      setPatreonError(String(e));
    } finally {
      setPatreonLoading(false);
    }
  }, []);

  /**
   * Resolve a pasted creator URL and pin it to the list. Adds in place rather
   * than reloading, so the panel doesn't lose its dates on every add; errors
   * propagate to the input's own inline message.
   */
  const addPatreonCreator = useCallback(async (url: string) => {
    const added = await api.patreonAddCreator(url);
    setPatreonCampaigns((prev) =>
      prev.some((c) => c.id === added.id)
        ? prev.map((c) => (c.id === added.id ? { ...c, ...added } : c))
        : [...prev, added],
    );
    setPatreonError("");
  }, []);

  const removePatreonCreator = useCallback(async (campaign: PatreonCampaign) => {
    try {
      await api.patreonRemoveCreator(campaign.id);
      setPatreonCampaigns((prev) => prev.filter((c) => c.id !== campaign.id));
    } catch (e) {
      setPatreonError(String(e));
    }
  }, []);

  /**
   * Lazily fetch + cache each supported creator's sort/filter date. Cheap
   * path (default): latest post of any kind, one request. Expensive path
   * (only while the creators "TD files only" filter is on): latest post
   * that actually carries a .tox/.toe/.zip, which can page through a
   * creator's whole recent history — see latest_upload_at in patreon.rs.
   */
  const requestPatreonCampaignDates = useCallback(() => {
    const cache = patreonCampaignFilesOnly ? patreonLastUploadCache : patreonLatestPostCache;
    const inFlight = patreonCampaignFilesOnly
      ? patreonLastUploadInFlight
      : patreonLatestPostInFlight;
    const setDates = patreonCampaignFilesOnly
      ? setPatreonLastUploadByCampaign
      : setPatreonLatestPostByCampaign;
    const fetchDate = patreonCampaignFilesOnly
      ? api.patreonCampaignLastUpload
      : api.patreonCampaignLatestPost;
    const missing = patreonCampaigns.filter(
      (c) => !cache.current.has(c.id) && !inFlight.current.has(c.id),
    );
    if (missing.length === 0) return;
    missing.forEach((c) => inFlight.current.add(c.id));
    void Promise.all(
      missing.map(async (c) => {
        let value: string | null = null;
        try {
          value = await fetchDate(c.id);
        } catch {
          value = null;
        } finally {
          inFlight.current.delete(c.id);
        }
        cache.current.set(c.id, value);
        setDates((prev) => ({ ...prev, [c.id]: value }));
      }),
    );
  }, [patreonCampaigns, patreonCampaignFilesOnly]);

  /**
   * Open a creator's post list. `focusPostId` (a cache-search hit) wins over
   * the usual "select the newest" — arriving from a search means the user
   * already named the post they wanted.
   */
  /**
   * Name-search the Patreon cache while the creator list is up. Purely local
   * (cached listings + the download folder), so it can run on every keystroke
   * — the debounce is only to avoid re-walking the download tree per letter.
   */
  useEffect(() => {
    const q = search.trim();
    const active = tab === "patreon" && !patreonCampaign && patreonEnabled;
    if (!active || !q) {
      // Always settle the spinner — opening a creator mid-search would
      // otherwise leave it spinning for the rest of the session. The hits
      // themselves survive a trip into a creator and back, so returning to
      // the list with the same query doesn't flash empty.
      setPatreonCacheSearching(false);
      if (!q) setPatreonCache(null);
      return;
    }
    let live = true;
    setPatreonCacheSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .patreonSearch(q)
        .then((r) => {
          if (live) setPatreonCache(r);
        })
        .catch(() => {
          // Local-only lookup; a failure means "no answer", not an error
          // worth interrupting a search-as-you-type with.
          if (live) setPatreonCache(null);
        })
        .finally(() => {
          if (live) setPatreonCacheSearching(false);
        });
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [tab, patreonCampaign, patreonEnabled, search]);

  const selectPatreonCampaign = async (campaign: PatreonCampaign, focusPostId?: string) => {
    setPatreonCampaign(campaign);
    setPatreonPosts([]);
    setPatreonPostId(null);
    setPatreonError("");
    setPatreonLoading(true);
    try {
      // The name rides along so the listing is filed under it in the search
      // index — that is what makes this creator findable by filename later.
      const posts = await api.patreonListToxPosts(campaign.id, campaign.name);
      setPatreonPosts(posts);
      if (focusPostId && posts.some((p) => p.id === focusPostId)) {
        setPatreonPostId(focusPostId);
        return;
      }
      // Auto-select the latest post so the detail pane isn't empty on
      // arrival — but only among posts the current filters would actually
      // show, so e.g. "Hide locked" can't be defeated by auto-selection
      // opening a locked post anyway. No match -> leave it unselected.
      const latest = posts
        .filter(
          (p) =>
            (!patreonPostsFilesOnly || p.toxFiles.length > 0) &&
            (!patreonPostsHideLocked || p.canView),
        )
        .reduce<PatreonToxPost | null>(
          (a, b) => (a && (a.publishedAt ?? "") >= (b.publishedAt ?? "") ? a : b),
          null,
        );
      setPatreonPostId(latest?.id ?? null);
    } catch (e) {
      setPatreonError(String(e));
    } finally {
      setPatreonLoading(false);
    }
  };

  /** Download a Patreon .tox and load it into the chosen running session. */
  const loadPatreonToxIntoSession = async (
    file: { name: string; url: string },
    target: ListItem,
  ) => {
    setPatreonBusyFile(file.url);
    try {
      setStatusMsg(`Downloading ${file.name}…`);
      const path = await api.patreonDownloadTox(file.url, file.name, patreonCampaign?.name ?? "");
      setStatusMsg(`Loading ${file.name} into ${target.displayName}…`);
      // Same companion path as "From URL…" — drops into the selected session
      await runUtilityAction(target, "load_tox", { path, persist: persistToxCopy });
    } catch (e) {
      setPatreonError(String(e));
      setStatusMsg(String(e));
    } finally {
      setPatreonBusyFile(null);
    }
  };

  /**
   * Download a Patreon .toe and surface it in Recent Files, selected, so the
   * user picks the TD version and launches through the normal flow.
   */
  const openPatreonToe = async (file: { name: string; url: string }) => {
    setPatreonBusyFile(file.url);
    try {
      setStatusMsg(`Downloading ${file.name}…`);
      const path = await api.patreonDownloadTox(file.url, file.name, patreonCampaign?.name ?? "");
      await api.addRecent(path);
      await refreshLists(undefined, { rediscover: false });
      setTab("recent");
      cancelCountdown();
      setSelectedPath(path);
      setFocus("versions");
      setStatusMsg(`${file.name} added to Recent Files — pick a TD version and launch`);
    } catch (e) {
      setPatreonError(String(e));
      setStatusMsg(String(e));
    } finally {
      setPatreonBusyFile(null);
    }
  };

  /**
   * Download + extract a Patreon `.zip` — TD can't load a zip directly, but
   * any `.tox`/`.toe` found inside surface as their own Load/Open rows
   * (patreonZipExtractByUrl), pointing at the already-local extracted path.
   * Idempotent on the Rust side, so a second click (e.g. after a stale
   * client cache) just replays the cached result instead of re-extracting.
   */
  const unzipPatreonFile = async (file: { name: string; url: string }) => {
    setPatreonBusyFile(file.url);
    try {
      setStatusMsg(`Unzipping ${file.name}…`);
      const result = await api.patreonExtractZip(file.url, file.name, patreonCampaign?.name ?? "");
      setPatreonZipExtractByUrl((prev) => ({ ...prev, [file.url]: result }));
      patreonZipStatusChecked.current.add(file.url);
      setStatusMsg(
        result.files.length > 0
          ? `${file.name} unzipped — ${result.files.length} .tox/.toe file(s) ready to load`
          : `${file.name} unzipped — no .tox/.toe found inside`,
      );
    } catch (e) {
      setPatreonError(String(e));
      setStatusMsg(String(e));
    } finally {
      setPatreonBusyFile(null);
    }
  };

  /** Reveal an already-extracted zip's folder — the button flips to this once unzipped. */
  const openExtractedFolder = async (dir: string) => {
    try {
      await api.openPath(dir);
    } catch (e) {
      setPatreonError(String(e));
      setStatusMsg(String(e));
    }
  };

  /** Load a `.tox` found inside an extracted zip — already local, no download step. */
  const loadLocalToxIntoSession = async (
    file: { name: string; path: string },
    target: ListItem,
  ) => {
    setPatreonBusyFile(file.path);
    try {
      setStatusMsg(`Loading ${file.name} into ${target.displayName}…`);
      await runUtilityAction(target, "load_tox", { path: file.path, persist: persistToxCopy });
    } catch (e) {
      setPatreonError(String(e));
      setStatusMsg(String(e));
    } finally {
      setPatreonBusyFile(null);
    }
  };

  /** Open a `.toe` found inside an extracted zip — already local, no download step. */
  const openLocalToe = async (file: { name: string; path: string }) => {
    setPatreonBusyFile(file.path);
    try {
      await api.addRecent(file.path);
      await refreshLists(undefined, { rediscover: false });
      setTab("recent");
      cancelCountdown();
      setSelectedPath(file.path);
      setFocus("versions");
      setStatusMsg(`${file.name} added to Recent Files — pick a TD version and launch`);
    } catch (e) {
      setPatreonError(String(e));
      setStatusMsg(String(e));
    } finally {
      setPatreonBusyFile(null);
    }
  };

  // Fetch a post's full body the first time it's selected (list is truncated).
  useEffect(() => {
    if (!patreonPostId || patreonDetailCache[patreonPostId]) return;
    let cancelled = false;
    setPatreonDetailLoading(true);
    void api
      .patreonPostDetail(patreonPostId)
      .then((detail) => {
        if (cancelled) return;
        setPatreonDetailCache((prev) => ({ ...prev, [patreonPostId]: detail }));
      })
      .catch((e) => {
        if (!cancelled) setStatusMsg(String(e));
      })
      .finally(() => {
        if (!cancelled) setPatreonDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patreonPostId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore "already unzipped" state for a reopened post — a disk-only
  // check (no network), so it's cheap to run on every post that has a zip.
  useEffect(() => {
    const zipFiles = patreonBasePost?.toxFiles.filter((f) => f.kind === "zip") ?? [];
    const toCheck = zipFiles.filter((f) => !patreonZipStatusChecked.current.has(f.url));
    if (toCheck.length === 0) return;
    toCheck.forEach((f) => patreonZipStatusChecked.current.add(f.url));
    const campaignName = patreonCampaign?.name ?? "";
    void Promise.all(
      toCheck.map(async (f) => {
        try {
          const result = await api.patreonZipExtractStatus(f.url, f.name, campaignName);
          if (result) setPatreonZipExtractByUrl((prev) => ({ ...prev, [f.url]: result }));
        } catch {
          // Silent — this is a background convenience check, not a user action.
        }
      }),
    );
  }, [patreonBasePost, patreonCampaign]);

  // Load campaigns the first time the Patreon tab is opened with a cookie set.
  useEffect(() => {
    if (
      tab === "patreon" &&
      patreonEnabled &&
      config?.patreon_session_cookie &&
      patreonCampaigns.length === 0 &&
      !patreonLoading &&
      !patreonError
    ) {
      void loadPatreonCampaigns();
    }
  }, [tab, patreonEnabled, config?.patreon_session_cookie]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grow the window so the Patreon detail pane has room, like the side panels.
  useEffect(() => {
    if (tab === "patreon" && patreonCampaign) void growForSidePanel();
  }, [tab, patreonCampaign]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshCompanionEnv = useCallback(async (toePath: string) => {
    try {
      const env = await api.tdpEnvStatus(toePath);
      setCompanionEnv(env);
      setCompanionEnvPath(toePath);
      return env;
    } catch (e) {
      setCompanionEnv(null);
      setCompanionEnvPath(toePath);
      setStatusMsg(`Env check failed: ${e}`);
      return null;
    }
  }, []);

  /** One click to a project Python env. The companion drops TD's own
   *  TDPyEnvManager if it is missing, switches it Active and presses its
   *  Create vEnv (utility >= 0.23.5, `ensure_pyenv`) -- the same thing as
   *  clicking those in TD, so Derivative's disclaimer still asks there first.
   *  The env is built on TD's ThreadManager; this follows the manager's own
   *  Status (`pyenv_status`) to the end instead of guessing from the folder.
   *  Resolves true when the env is ready. */
  const ensureProjectEnv = async (item: ListItem): Promise<boolean> => {
    if (!item.openUtilityAvailable) {
      setStatusMsg("Utility not available in this TD session");
      return false;
    }
    selectItem(item);
    setStatusMsg("Setting up the project's Python env…");
    let res: Record<string, unknown> | null = null;
    try {
      res = (await api.openProjectUtility(item.path, "ensure_pyenv", null)) as Record<string, unknown>;
    } catch (e) {
      setStatusMsg(`Python env setup failed: ${String(e)}`);
      return false;
    }
    if (res?.ok === false && /unknown action/i.test(String(res.error ?? ""))) {
      // An older utility can still drop the manager; creating stays a click in TD.
      const old = await runUtilityAction(item, "ensure_tdpyenv");
      if (old) {
        setStatusMsg(
          "Added TDPyEnvManager — click Create vEnv on it in TD, or update the utility " +
            "(0.23.5+) to have this done in one click",
        );
      }
      return false;
    }
    if (!res || res.ok === false) {
      setStatusMsg(`Python env setup failed: ${String(res?.error ?? "unknown error")}`);
      return false;
    }
    const ready = async (): Promise<boolean> => {
      const env = await refreshCompanionEnv(item.path);
      setStatusMsg(`Python env ready: ${String(env?.venvPath ?? res?.env_path ?? "")}`);
      return true;
    };
    if (res.env_ready === true) return ready();

    // Creating. TD shows Derivative's disclaimer first (modal) -- bring it up.
    if (item.openPid != null) void api.openProjectFocus(item.openPid).catch(() => {});
    setStatusMsg(
      "Creating the Python env in TouchDesigner — confirm Derivative's disclaimer there if it asks…",
    );
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      await new Promise((r) => window.setTimeout(r, 2000));
      let st: Record<string, unknown> | null = null;
      try {
        st = (await api.openProjectUtility(item.path, "pyenv_status", null)) as Record<string, unknown>;
      } catch {
        continue; // TD is busy (the disclaimer is modal) -- keep waiting
      }
      const state = String(st?.state ?? "");
      if (state === "ready") return ready();
      if (state === "error") {
        setStatusMsg(
          `TDPyEnvManager: ${String(st?.status ?? "error")} — see the component in TD for details`,
        );
        return false;
      }
      if (st?.active === false && Date.now() - started > 8000) {
        setStatusMsg("No Python env created — the TDPyEnvManager disclaimer was declined in TD");
        return false;
      }
    }
    setStatusMsg("Still no Python env after 3 minutes — check the TDPyEnvManager in TD");
    return false;
  };

  const loadTdpPypiCatalog = async (forceRefresh: boolean) => {
    setTdpCatalogLoading(true);
    setTdpCatalogError("");
    try {
      const cat = await api.tdpPypiCatalog(forceRefresh);
      setTdpPackages(cat.packages);
      setTdpFromCache(cat.fromCache);
      if (cat.packages.length) {
        setTdpSelectedId((prev) => prev ?? cat.packages[0].id);
      }
    } catch (e) {
      setTdpCatalogError(String(e));
    } finally {
      setTdpCatalogLoading(false);
    }
  };

  const openTdpPackagePicker = async (item: ListItem) => {
    try {
      setStatusMsg("Checking project vEnv…");
      let env = await refreshCompanionEnv(item.path);
      // refreshCompanionEnv already reported the failure — say it again here so
      // the line names the action the user actually took.
      if (!env) {
        setStatusMsg(`From package: could not read the Python env for ${basename(item.path)}`);
        return;
      }

      if (!env.venvPath) {
        // No project env yet: set one up in the same click, then carry on.
        if (!(await ensureProjectEnv(item))) return;
        const again = await refreshCompanionEnv(item.path);
        if (!again?.venvPath) return;
        env = again;
      }

      setTdpTarget(item);
      setTdpCustomSpec("");
      setTdpSearch("");
      setTdpReadme("");
      setTdpCatalogError("");
      setModal("tdpPackage");
      setStatusMsg(`vEnv ready: ${env.venvPath}`);
      void loadTdpPypiCatalog(false);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const installTdpIntoSession = async (
    item: ListItem,
    spec: string,
    moduleHint?: string,
  ) => {
    const trimmed = spec.trim();
    if (!trimmed) {
      setStatusMsg("Package spec empty");
      return;
    }
    setTdpBusy(true);
    try {
      setStatusMsg(`uv pip install ${trimmed}…`);
      // Only pass an explicit #module when the caller knows it (custom spec).
      // Catalog guesses are often wrong (e.g. tdp-TauCeti ≠ tdptauceti) — let Rust
      // discover ToxFile from the installed distribution.
      const installSpec =
        moduleHint && !trimmed.includes("#") && moduleHint.includes(".")
          ? `${trimmed}#${moduleHint}`
          : trimmed;
      const installed = await api.tdpInstallPackage(item.path, installSpec);
      // Remember what resolved, not what was typed — a failed spec isn't worth offering
      setTdpSpecHistory(rememberManualEntry("tdpSpec", trimmed));
      // Always trust backend-resolved module (package-scoped); never keep a bad hint.
      const module = installed.module;
      setStatusMsg(
        installed.alreadyInstalled
          ? `ToxFile ready: ${module}`
          : `Installed ${installed.spec} -> ${module}`,
      );
      await runUtilityAction(item, "load_tox", {
        path: installed.toxPath,
        persist: persistToxCopy,
        toxfile_module: module,
      });
      setModal(null);
      setTdpTarget(null);
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setTdpBusy(false);
    }
  };

  const filteredTdpPackages = useMemo(
    () => tdpPackages.filter((p) => packageMatchesQuery(p, tdpSearch)),
    [tdpPackages, tdpSearch],
  );

  const selectedTdpPackage = useMemo(
    () => tdpPackages.find((p) => p.id === tdpSelectedId) ?? null,
    [tdpPackages, tdpSelectedId],
  );

  useEffect(() => {
    if (modal !== "tdpPackage" || !selectedTdpPackage) return;
    let cancelled = false;
    setTdpReadmeLoading(true);
    setTdpReadme("");
    void api
      .tdpPypiReadme(selectedTdpPackage.name)
      .then((r) => {
        if (!cancelled) setTdpReadme(r.markdown || "");
      })
      .catch((e) => {
        if (!cancelled) setTdpReadme(`_Failed to load README: ${e}_`);
      })
      .finally(() => {
        if (!cancelled) setTdpReadmeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modal, selectedTdpPackage]);

  // Companion: keep project vEnv / uv readiness visible for the selected open project
  useEffect(() => {
    if (tab !== "current" || !selectedPath) {
      setCompanionEnv(null);
      setCompanionEnvPath(null);
      return;
    }
    const sel = items.find((i) => i.path === selectedPath);
    if (!sel?.openUtilityAvailable) {
      setCompanionEnv(null);
      setCompanionEnvPath(null);
      return;
    }
    void refreshCompanionEnv(selectedPath);
  }, [tab, selectedPath, items, refreshCompanionEnv]);

  /** OS-level file drag so .tox can be dropped into TouchDesigner networks. */
  const beginToxDrag = (path: string, e?: React.DragEvent) => {
    e?.preventDefault();
    if (!path || !isToxPath(path)) return;
    // Flag the outbound drag so a drop back onto our window isn't re-imported.
    draggingOutRef.current = true;
    void startDrag({
      item: [path],
      icon: dragIconPath || path,
      mode: "copy",
    })
      .catch((err) => setStatusMsg(String(err)))
      .finally(() => {
        // Clear after the drop event has had a chance to see the flag.
        setTimeout(() => {
          draggingOutRef.current = false;
        }, 100);
      });
  };

  /**
   * Cheap disk-only lookup of where a Patreon `.tox` already lives, cached in
   * `patreonLocalToxByUrl`. Fired on mousedown so the dragstart that follows
   * a few pixels later already knows the path and can drag with no delay.
   */
  const primePatreonToxDrag = (file: PatreonDragFile) => {
    const url = file.url;
    if (!url || file.path || patreonLocalToxChecked.current.has(url)) return;
    patreonLocalToxChecked.current.add(url);
    void api
      // A cache hit names its own creator: no creator is open to infer one
      // from, and the download folder is keyed by creator name.
      .patreonToxLocalPath(url, file.name, file.campaign ?? patreonCampaign?.name ?? "")
      .then((path) => {
        if (path) setPatreonLocalToxByUrl((prev) => ({ ...prev, [url]: path }));
      })
      .catch(() => {
        // Background convenience check — a failure just means "not primed".
        patreonLocalToxChecked.current.delete(url);
      });
  };

  /**
   * Drag a Patreon `.tox` straight into a TouchDesigner network.
   *
   * Two speeds, because an OS-level drag begins with the mouse button already
   * down and cannot wait on a download: a file already on disk (a zip member,
   * or a previous download) drags instantly, while a fresh one downloads first
   * and starts the drag the moment it lands — fast enough to still catch the
   * gesture for the sizes this is normally used on. Either way the file is
   * cached afterwards, so a drag that arrived too late works on the next try.
   */
  const beginPatreonToxDrag = async (file: PatreonDragFile, e?: React.DragEvent) => {
    e?.preventDefault();
    if (file.path) {
      beginToxDrag(file.path);
      return;
    }
    const url = file.url;
    if (!url) return;
    const known = patreonLocalToxByUrl[url];
    if (known) {
      beginToxDrag(known);
      return;
    }
    const campaignName = file.campaign ?? patreonCampaign?.name ?? "";
    let downloading = false;
    try {
      let path = await api.patreonToxLocalPath(url, file.name, campaignName);
      if (!path) {
        downloading = true;
        setPatreonBusyFile(url);
        setStatusMsg(`Downloading ${file.name} — the drag starts as soon as it lands…`);
        path = await api.patreonDownloadTox(url, file.name, campaignName);
      }
      patreonLocalToxChecked.current.add(url);
      setPatreonLocalToxByUrl((prev) => ({ ...prev, [url]: path! }));
      beginToxDrag(path);
      if (downloading) {
        setStatusMsg(`${file.name} downloaded — drag it into a TouchDesigner network`);
      }
    } catch (err) {
      setPatreonError(String(err));
      setStatusMsg(String(err));
    } finally {
      if (downloading) setPatreonBusyFile(null);
    }
  };

  /** Run a Toolbox mutation, adopt the fresh view, surface errors in the status bar. */
  const toolboxRun = async (fn: () => Promise<ToolboxView>, okMsg?: string) => {
    try {
      setToolbox(await fn());
      if (okMsg) setStatusMsg(okMsg);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Download a url tool's .tox into the cache so it becomes draggable. */
  const toolboxFetch = async (tool: ToolboxTool) => {
    setToolboxBusyIds((prev) => new Set(prev).add(tool.id));
    try {
      const next = await api.toolboxFetchTool(tool.id);
      setToolbox(next);
      const fetched = next.tools.find((t) => t.id === tool.id);
      setStatusMsg(
        fetched?.resolvedPath
          ? `Fetched ${tool.label} — drag it into TouchDesigner`
          : `Fetched ${tool.label}`,
      );
    } catch (e) {
      setStatusMsg(`Fetch failed for ${tool.label}: ${e}`);
    } finally {
      setToolboxBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(tool.id);
        return next;
      });
    }
  };

  const openToolboxAdd = (category: string, prefill?: Partial<ToolboxToolDraft>) => {
    setToolboxToolDraft({
      id: null,
      label: "",
      kind: "local",
      source: "",
      category,
      notes: "",
      ...prefill,
    });
    setToolboxNewCategory("");
    setModal("toolboxTool");
  };

  const openToolboxEdit = (tool: ToolboxTool) => {
    setToolboxToolDraft({
      id: tool.id,
      label: tool.label,
      kind: tool.kind,
      source: tool.source,
      category: tool.category,
      notes: tool.notes,
    });
    setToolboxNewCategory("");
    setModal("toolboxTool");
  };

  const submitToolboxTool = async () => {
    const raw = toolboxToolDraft;
    if (!raw || !raw.source.trim()) return;
    const d = toolboxNewCategory.trim()
      ? { ...raw, category: toolboxNewCategory.trim() }
      : raw;
    try {
      let next: ToolboxView;
      if (d.id) {
        next = await api.toolboxUpdateTool(d.id, {
          label: d.label,
          category: d.category,
          source: d.source,
          notes: d.notes,
        });
      } else {
        next = await api.toolboxAddTool(d.label, d.kind, d.source, d.category, d.notes);
      }
      setToolbox(next);
      setModal(null);
      setToolboxToolDraft(null);
      setStatusMsg(d.id ? "Tool updated" : "Added to Toolbox");
      // A url tool without a local copy is only half-pinned — fetch it now so
      // it's draggable immediately (failure just leaves the click-to-fetch row).
      if (d.kind === "url") {
        const source = d.source.trim();
        const added = d.id
          ? next.tools.find((t) => t.id === d.id)
          : [...next.tools].reverse().find((t) => t.kind === "url" && t.source === source);
        if (added && !added.resolvedPath) void toolboxFetch(added);
      }
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Query the build-time update endpoint; opens the update dialog on a hit. */
  const runAppUpdateCheck = async (manual: boolean) => {
    try {
      // Automatic checks are opt-out; a manual one always runs.
      if (!manual && configRef.current?.auto_update_check === false) return;
      if (manual) setStatusMsg("Checking for updates…");
      const upd = await checkAppUpdate();
      if (upd) {
        setAppUpdate(upd);
        // A skipped version stays quiet on startup only — an explicit "Check
        // for updates" must always show something, or the menu item looks
        // broken. A NEWER version prompts again, since the match is exact.
        if (!manual && upd.version === configRef.current?.skipped_app_version) {
          return;
        }
        // An automatic hit never covers a dialog the user has open — the
        // header Update chip carries it until they get to it.
        setModal((m) => (manual || m === null ? "appUpdate" : m));
      } else if (manual) {
        setStatusMsg(`Up to date (v${version})`);
      }
    } catch (e) {
      // Dev builds / offline: silent unless the user asked.
      if (manual) setStatusMsg(`Update check failed: ${e}`);
    }
  };

  const installAppUpdate = async () => {
    if (!appUpdate) return;
    setAppUpdateBusy(true);
    try {
      // Freemium: updates are never refused (the free tier ships in every
      // build), but this is the moment a paid license re-verifies live
      // ("authed once, or per update"). Failures only affect entitlement.
      setStatusMsg("Checking license…");
      await api.licenseVerifyUpdate(appUpdate.version).catch(() => {});
      setStatusMsg("Downloading update…");
      await appUpdate.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setStatusMsg(`Update failed: ${e}`);
      setAppUpdateBusy(false);
    }
  };

  /**
   * Poll the companion TOX's own release channel. Separate from the app
   * updater: a new utility ships without an app release, so this can find
   * something when the app is perfectly current (and vice versa).
   */
  const runUtilityUpdateCheck = async (manual: boolean) => {
    try {
      if (!manual && configRef.current?.auto_update_check === false) return;
      if (manual) setStatusMsg("Checking for utility updates…");
      const info = await api.checkUtilityUpdate();
      setUtilityUpdate(info.available ? info : null);
      // Same rule as the app check: skipping silences the quiet startup pass
      // for exactly that version, never a manual one.
      if (
        info.available &&
        !manual &&
        info.latestVersion === configRef.current?.skipped_utility_version
      ) {
        return;
      }
      if (info.available) {
        // The app dialog always outranks this one — both checks can fire at
        // once from About, in either order, and the app update is the bigger
        // ask. A quiet startup check additionally never steals focus from
        // whatever the user already has open; the offer waits in state and
        // About surfaces it.
        setModal((m) => {
          if (m === "appUpdate") return m;
          return manual || m === null ? "utilityUpdate" : m;
        });
      } else if (manual) {
        setStatusMsg(`Utility TOX is up to date (v${info.currentVersion})`);
      }
    } catch (e) {
      if (manual) setStatusMsg(`Utility update check failed: ${e}`);
    }
  };

  /**
   * Fetch the new TOX into the launcher's own store. This does NOT touch any
   * running session — the expanded session card's "Update companion" still does that,
   * and now offers the freshly downloaded version.
   */
  const installUtilityUpdate = async () => {
    const hadCopy = !!bundledUtilityTox;
    setUtilityUpdateBusy(true);
    try {
      setStatusMsg(hadCopy ? "Downloading utility TOX…" : "Downloading companion TOX…");
      const version = await api.installUtilityUpdate();
      setBundledUtilityVersion(version);
      void api.getBundledUtilityTox().then(setBundledUtilityTox);
      // The Toolbox pin was repointed at the new file server-side; re-read it
      // so the drag handle in this session serves the new version too.
      void api.getToolbox().then(setToolbox).catch(() => {
        /* toolbox optional */
      });
      setUtilityUpdate(null);
      setModal(null);
      setStatusMsg(
        hadCopy
          ? `Utility TOX updated to v${version} — use "Update utility" on a running session to apply it there`
          : `Companion TOX v${version} downloaded — Install to Palette to drag it into a project`,
      );
    } catch (e) {
      setStatusMsg(`Utility download failed: ${e}`);
    } finally {
      setUtilityUpdateBusy(false);
    }
  };

  /**
   * Update a running session's utility in place: refresh the palette copy of
   * the bundled TOX (stable path, overwritten to current), then have the
   * utility repoint its External .tox there and reload — custom parameter
   * values survive because the utility forces Reload Custom Parameters off.
   */
  const updateSessionUtility = async (item: ListItem) => {
    try {
      setStatusMsg("Updating utility — refreshing palette copy…");
      const dest = await api.installBundledUtility();
      await runUtilityAction(item, "update_utility", { path: dest });
      // The session reloads the utility ~0.5s after replying; re-poll for the
      // new version once it has had time to hello again.
      window.setTimeout(() => void refreshOpen(), 3000);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Load a .tox into a running session's network editor via the companion utility. */
  const placeToxInSession = async (project: OpenProject, toxPath: string) => {
    try {
      setStatusMsg(`Placing ${basename(toxPath)} in ${project.display_name}…`);
      const result = await api.openProjectUtility(project.path, "load_tox", {
        path: toxPath,
        persist: persistToxCopy,
      });
      const r = (result ?? {}) as {
        ok?: boolean;
        error?: string;
        loaded_path?: string;
        parent?: string;
      };
      if (r.ok === false) {
        setStatusMsg(`Place failed: ${r.error ?? "unknown error"}`);
        return;
      }
      setStatusMsg(
        `Placed ${basename(String(r.loaded_path ?? toxPath))} in ${project.display_name}${
          r.parent ? ` (${r.parent})` : ""
        }`,
      );
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /**
   * Land an FNS package from the shelf by its manifest `placement`: pane /
   * none drop into the pane like any tox; root / absent install through the
   * toolkit's FNS_Installer (minimal one-package selection, recorded, bootstrap
   * dropped first when the project has no toolkit root).
   */
  const placeFnsPackage = (toxPath: string, pkg: FnsPackage) => {
    if (packageLandsInPane(pkg)) {
      placeTox(toxPath);
      return;
    }
    const targets = openProjects.filter((p) => p.alive && p.utility_available);
    const target = targets.find((p) => p.path === placeTargetPath) ?? targets[0];
    if (!target) {
      setStatusMsg("No running session with the companion utility");
      return;
    }
    const label = canonicalToolName(pkg.name);
    setStatusMsg(`Installing ${label} through FNSTools in ${target.display_name}…`);
    void (async () => {
      try {
        const r = (await api.fnsPlace(target.path, pkg.name)) as {
          ok?: boolean;
          error?: string;
          root?: string;
          bootstrapped?: boolean;
        };
        if (r.ok === false) {
          setStatusMsg(`Install failed: ${r.error ?? "unknown error"}`);
          return;
        }
        setStatusMsg(
          r.bootstrapped
            ? `FNS bootstrap dropped into ${r.root ?? "the project"} — installing ${label}…`
            : `Installing ${label} in ${r.root ?? target.display_name}…`,
        );
      } catch (e) {
        setStatusMsg(String(e));
      }
    })();
  };

  /**
   * Place a .tox from a palette/Toolbox row into the session selected in the
   * place-target bar (first eligible session when none is chosen).
   */
  const placeTox = (toxPath: string) => {
    const targets = openProjects.filter((p) => p.alive && p.utility_available);
    const target = targets.find((p) => p.path === placeTargetPath) ?? targets[0];
    if (!target) {
      setStatusMsg("No running session with the companion utility");
      return;
    }
    void placeToxInSession(target, toxPath);
  };

  /** Env-manager status for one session's project — shared by the companion
   *  strip's chip and the Load ▾ menu so their wording can't drift. */
  const companionEnvStatus = (path: string) => {
    const env = companionEnvPath === path ? companionEnv : null;
    const envMissing = env != null && !env.venvPath;
    const ready = !!env?.ready;
    const label = !env ? "Env…" : ready ? "Env ready" : envMissing ? "No vEnv" : "Env?";
    // uv is optional: installs use it when the machine has it and fall back to
    // the env's own pip otherwise (tdp.rs install_with_env) -- say which.
    const installer = env?.uvAvailable ? `uv (${env.uvPath})` : "pip (uv not found; optional)";
    const title = !env
      ? "Checking project Python env…"
      : ready
        ? `vEnv: ${env.venvPath}\nInstalls with ${installer}`
        : envMissing
          ? "No Python env for this project yet — From package sets one up first"
          : "Python env status unknown";
    return { envMissing, ready, label, title };
  };

  /** Session card's Add to project ▾ menu. Rebuilt on every render (same pattern as
   *  the View menu) so the persist toggle's checkmark updates while open —
   *  a snapshot via openCtxMenu would show the stale state after a click. */
  const companionLoadMenu = (): MenuEntry[] => {
    const sel = items.find((i) => i.path === selectedPath);
    if (!sel) return [];
    const env = companionEnvStatus(sel.path);
    return [
      { type: "header", label: "Add to project" },
      {
        label: "Local .tox…",
        title: "Pick a local .tox — loads into the Network Editor pane (or /)",
        onSelect: () => void loadToxIntoSession(sel),
      },
      {
        label: "From URL / GitHub…",
        title: "Download a .tox URL or GitHub latest-release asset into tox_cache, then load",
        onSelect: () => loadToxFromUrlIntoSession(sel),
      },
      {
        // Never disabled: with no env it sets one up first (one click), and
        // uv is optional (pip fallback), so there is nothing left to wait on.
        label: "From package…",
        title: env.ready
          ? "Install into the project's Python env, resolve its ToxFile, load it"
          : env.title,
        hint: env.envMissing ? "sets up env" : undefined,
        onSelect: () => void openTdpPackagePicker(sel),
      },
      { type: "separator" },
      {
        label: "Also copy into {project}/tox/",
        title: "Keep a copy of every loaded .tox inside the project folder",
        checked: persistToxCopy,
        keepOpen: true,
        onSelect: () => setPersistToxCopy((v) => !v),
      },
    ];
  };

  /** Pin dropped .tox files as local Toolbox tools ('' = top level). */
  const pinToxesToToolbox = async (paths: string[], category: string) => {
    try {
      // Read the current view fresh — this runs from a window-level drop
      // listener whose closure may hold stale state.
      let view = await api.getToolbox();
      const have = new Set(
        view.tools
          .filter((t) => t.kind === "local")
          .map((t) => normalizeFsPath(t.source).toLowerCase()),
      );
      let added = 0;
      let skipped = 0;
      for (const p of paths) {
        const key = normalizeFsPath(p).toLowerCase();
        if (have.has(key)) {
          skipped += 1;
          continue;
        }
        view = await api.toolboxAddTool("", "local", p, category);
        have.add(key);
        added += 1;
      }
      setToolbox(view);
      const where = category ? `Toolbox / ${category}` : "Toolbox";
      const bits = [
        added ? `Pinned ${added} to ${where}` : null,
        skipped ? `${skipped} already pinned` : null,
      ].filter(Boolean);
      setStatusMsg(bits.join(" — ") || "Nothing to pin");
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Is this palette .tox already pinned as a local Toolbox tool? */
  const toolboxHasLocal = (path: string | null): boolean => {
    if (!path || !toolbox) return false;
    const norm = normalizeFsPath(path).toLowerCase();
    return toolbox.tools.some(
      (t) => t.kind === "local" && normalizeFsPath(t.source).toLowerCase() === norm,
    );
  };

  const importToxFiles = async (paths: string[], destFolderRel: string) => {
    const toxes = paths.filter((p) => isToxPath(p));
    if (!toxes.length) {
      setStatusMsg("Drop .tox files only");
      return;
    }
    try {
      const result = await api.importToxToPalette(toxes, destFolderRel || null);
      await refreshLists(undefined, { rediscover: false });
      const n = result.copied.length;
      const bits = [
        n ? `Added ${n} .tox to User Palette` : "No files copied",
        result.palette_data_updated ? "paletteData.json updated" : null,
        result.skipped.length ? `${result.skipped.length} skipped` : null,
      ].filter(Boolean);
      setStatusMsg(bits.join(" — "));
      if (result.copied[0]) {
        setSelectedPath(result.copied[0]);
        setFocus("picker");
      }
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /** Moves a User Palette .tox to the OS trash (recoverable) and rescans. */
  const removePaletteFile = async (path: string) => {
    if (!window.confirm(`Move "${basename(path)}" to the trash?`)) return;
    try {
      await api.removePaletteFile(path);
      await refreshLists(undefined, { rediscover: false });
      if (selectedPath === path) setSelectedPath(null);
      setStatusMsg(`Moved ${basename(path)} to trash`);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  // --- Context menus -------------------------------------------------------

  const revealLabel = isMac ? "Reveal in Finder" : "Reveal in Explorer";

  const openCtxMenu = (e: React.MouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (entries.length) setCtxMenu({ x: e.clientX, y: e.clientY, entries });
  };

  const copyText = (text: string, okMsg = "Copied") => {
    void navigator.clipboard.writeText(text).then(
      () => setStatusMsg(okMsg),
      () => setStatusMsg(text),
    );
  };

  /**
   * Launch straight from a context menu — resolves the TD version for the item
   * itself instead of relying on the selection-driven analysis flow, so it
   * works on rows that were never selected.
   */
  const launchItemFromMenu = async (item: ListItem, forcePlayer?: boolean) => {
    cancelCountdown();
    selectItem(item);
    const player = forcePlayer ?? usePlayer;
    const keys = (player ? discover.players : discover.versions).map((v) => v.key);
    let versionKey: string | null = null;
    if (item.isDefault || tab === "templates") {
      versionKey = resolveTemplateVersion(templateDefaultVersion, keys);
    } else {
      try {
        const cached = versionCache.current.get(item.path);
        const info = cached !== undefined ? cached : await api.inspectToe(item.path);
        if (cached === undefined) versionCache.current.set(item.path, info);
        versionKey = info
          ? findMatchingVersionKey(info, keys, player)
          : newestMainlineKey(keys);
      } catch (e) {
        setStatusMsg(String(e));
        return;
      }
    }
    if (!versionKey) {
      setStatusMsg("No matching TD version installed");
      return;
    }
    setSelectedVersion(versionKey);
    setUsePlayer(player);
    await startLaunch(item.path, versionKey, player, !item.isDefault, item.displayName);
  };

  // ---- Phone remote (one-tap LAN pairing + QR) ----

  /** URL the QR encodes + its rendered data-URI; null while starting/failed. */
  const [phoneUrl, setPhoneUrl] = useState<string | null>(null);
  const [phoneQr, setPhoneQr] = useState<string | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  /** Control server live on the LAN — lights the header Phone button. */
  const [phoneServing, setPhoneServing] = useState(false);

  const refreshPhoneStatus = useCallback(async () => {
    try {
      const s = await api.controlServerStatus();
      setPhoneServing(s.running && s.lan);
    } catch {
      /* status is cosmetic — never surface an error for it */
    }
  }, []);

  // The server also starts/stops outside the modal (Settings "open in
  // browser", LAN toggle, regenerate), so poll lazily besides the pushes.
  useEffect(() => {
    void refreshPhoneStatus();
    const id = window.setInterval(() => void refreshPhoneStatus(), 15000);
    return () => window.clearInterval(id);
  }, [refreshPhoneStatus]);

  const startPhoneRemote = useCallback(async () => {
    setPhoneErr(null);
    setPhoneUrl(null);
    setPhoneQr(null);
    try {
      // One link: D5 made this page the FLEET surface (it kills processes), so
      // it is author-only. A restricted link for a client is FNS_Remote's own
      // client link, per session -- see docs/fns-remote.md section 9.
      const url = await api.phoneRemoteStart();
      setPhoneUrl(url);
      setPhoneServing(true);
      // Bundled (no network/CDN): renders to an inline data URI.
      const { toDataURL } = await import("qrcode");
      setPhoneQr(await toDataURL(url, { width: 260, margin: 1 }));
    } catch (e) {
      setPhoneErr(String(e));
    }
  }, []);

  const openPhoneRemote = useCallback(() => {
    setModal("phone");
    void startPhoneRemote();
  }, [startPhoneRemote]);

  const regeneratePhoneToken = useCallback(async () => {
    try {
      await api.controlRegenerateToken();
      await startPhoneRemote();
      setStatusMsg("New pairing code — the previous link no longer works");
    } catch (e) {
      setPhoneErr(String(e));
    }
  }, [startPhoneRemote]);

  /** Re-apply the configured bind to a RUNNING server: ensure_started reads
   *  the saved port/LAN and stops + rebinds when they differ. Tokens stay
   *  valid, but a port change means paired devices re-scan the QR. */
  const rebindControlServer = useCallback(
    async (what: string) => {
      if (!phoneServing) return; // not running — new settings apply on next start
      try {
        await api.openControlServer();
        await refreshPhoneStatus();
        setStatusMsg(`Control server rebound (${what}) — re-scan the QR on devices`);
      } catch (e) {
        setStatusMsg(String(e));
      }
    },
    [phoneServing, refreshPhoneStatus],
  );

  /** Stop the LAN server — the phone loses its connection; the link is kept, so
   *  starting again reuses it. */
  const stopPhoneRemote = useCallback(async () => {
    try {
      await api.controlServerStop();
      setPhoneServing(false);
      setPhoneUrl(null);
      setPhoneQr(null);
      setStatusMsg("Phone Remote stopped — the server is no longer reachable");
    } catch (e) {
      setPhoneErr(String(e));
    }
  }, []);

  // ---- Project versions drawer (variant families) ----

  const openVersionsDrawer = (familyKey: string) => {
    setVersionsFamilyKey(familyKey);
    setRestoreTarget(null);
    setPruneSel(new Set());
    setPruneConfirm(false);
    setModal("versions");
  };

  const closeVersionsDrawer = () => {
    setModal(null);
    setVersionsFamilyKey(null);
    setRestoreTarget(null);
    setPruneSel(new Set());
    setPruneConfirm(false);
  };

  /** Launch one specific variant file — version detection runs on that file. */
  const launchVariant = async (path: string) => {
    closeVersionsDrawer();
    await launchItemFromMenu({ path, displayName: basename(path), missing: false });
  };

  /** Put a variant into the launcher's picker (pinned top row + version panel). */
  const selectVariantInLauncher = (path: string) => {
    closeVersionsDrawer();
    setActiveManual(path);
    setTab("recent");
    selectItem({ path, displayName: basename(path), missing: false });
  };

  /** Copy a project file into a new numbered variant beside it (Name.N.toe,
   *  never overwriting). Works from the file context menu on any project —
   *  no existing family required — or a row inside the versions drawer. */
  const duplicateVariant = async (path: string) => {
    setVariantsBusy(true);
    try {
      const v = await api.createVariant(path);
      setStatusMsg(`Created ${basename(v.path)}`);
      await refreshLists(undefined, { rediscover: false });
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setVariantsBusy(false);
    }
  };

  /**
   * Copy a project to `CrashAutoSave.<name>.toe` beside it and launch that.
   * TouchDesigner opens any file whose name starts with `CrashAutoSave` in
   * Safe Mode, where nothing cooks — the way into a project that crashes or
   * hangs on load, without touching the original.
   *
   * `overwrite` is the second pass, after the user okayed replacing a copy
   * that was already there (TD's own crash autosaves live under this name).
   */
  const runSafeModeCopy = async (item: ListItem, overwrite = false) => {
    setVariantsBusy(true);
    try {
      const res = await api.createSafeModeCopy(item.path, overwrite);
      if (res.needs_confirm) {
        setSafeModeTarget({ item, path: res.path, modified: res.existing_modified ?? null });
        setModal("safeMode");
        return;
      }
      setModal(null);
      setSafeModeTarget(null);
      setStatusMsg(
        `${res.replaced ? "Replaced" : "Created"} ${basename(res.path)} — launching in Safe Mode`,
      );
      await refreshLists(undefined, { rediscover: false });
      await launchItemFromMenu({ ...item, path: res.path, displayName: basename(res.path) });
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setVariantsBusy(false);
    }
  };

  const togglePruneSel = (path: string) => {
    setPruneSel((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setPruneConfirm(false);
  };

  const confirmRestoreVariant = async () => {
    if (!restoreTarget) return;
    setVariantsBusy(true);
    try {
      const res = await api.restoreVariantAsHead(restoreTarget);
      // Surface the restored head in launcher recents so the family card
      // leads with it from now on.
      try {
        await api.addRecent(res.head);
      } catch {
        /* cosmetic */
      }
      setStatusMsg(
        res.preserved_as
          ? `Restored ${basename(restoreTarget)} as ${basename(res.head)} — previous head preserved as ${basename(res.preserved_as)}`
          : `Restored ${basename(restoreTarget)} as ${basename(res.head)}`,
      );
      setRestoreTarget(null);
      await refreshLists(undefined, { rediscover: false });
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setVariantsBusy(false);
    }
  };

  const confirmPruneVariants = async () => {
    if (!pruneSel.size) return;
    setVariantsBusy(true);
    try {
      const count = pruneSel.size;
      const bytes = await api.trashVariants([...pruneSel]);
      setStatusMsg(
        `Moved ${count} file${count === 1 ? "" : "s"} to the ${trashName} (${formatBytes(bytes)})`,
      );
      setPruneSel(new Set());
      setPruneConfirm(false);
      await refreshLists(undefined, { rediscover: false });
    } catch (e) {
      setStatusMsg(String(e));
    } finally {
      setVariantsBusy(false);
    }
  };

  /** For family rows with grouping on, removal means the whole family's
   *  recents entries — otherwise the lone card resurfaces through another
   *  member on the next refresh. */
  const recentsPathsForRemoval = (path: string): string[] => {
    if (!config?.collapse_versions) return [path];
    const fam = families.find((f) => f.member_paths.includes(normPath(path)));
    if (!fam) return [path];
    const inRecents = recents
      .filter((r) => fam.member_paths.includes(normPath(r.path)))
      .map((r) => r.path);
    return Array.from(new Set([...inRecents, path]));
  };

  /** "Place in <session>" entries for a .tox — disabled row when nothing can host it. */
  const placeToxEntries = (toxPath: string): MenuEntry[] => {
    const targets = openProjects.filter((p) => p.alive && p.utility_available);
    if (targets.length === 0) {
      return [
        {
          label: "Place in session",
          disabled: true,
          title: "Needs a running session with the companion utility",
        },
      ];
    }
    if (targets.length === 1) {
      return [
        {
          label: `Place in ${targets[0].display_name}`,
          title: targets[0].path,
          onSelect: () => void placeToxInSession(targets[0], toxPath),
        },
      ];
    }
    return [
      {
        label: "Place in session",
        children: targets.map((t) => ({
          label: t.display_name,
          title: t.path,
          onSelect: () => void placeToxInSession(t, toxPath),
        })),
      },
    ];
  };

  /** Menu for any .tox row (palette tree/list, Toolbox tools with a local file). */
  /**
   * `removable` is true only for rows the Palette tree itself marked
   * `acceptImports` (i.e. living under the writable User Palette root) —
   * files from a factory install or an extra scanned folder aren't ours to
   * delete, so "Remove from Palette…" is omitted for those. Callers outside
   * the Palette tree (Recent/Templates/gallery rows, via fileItemMenu) never
   * pass it, so they never see the option either.
   */
  const toxFileMenu = (path: string, missing: boolean, removable = false): MenuEntry[] => {
    const entries: MenuEntry[] = [{ type: "header", label: basename(path) }];
    if (!missing) {
      entries.push(...placeToxEntries(path), { type: "separator" });
    }
    entries.push(
      { label: revealLabel, disabled: missing, onSelect: () => void api.openPath(path) },
      { label: "Copy path", onSelect: () => copyText(path, "Path copied") },
    );
    if (!missing) {
      entries.push(
        { type: "separator" },
        toolboxHasLocal(path)
          ? { label: "In Toolbox", disabled: true, hint: "★" }
          : {
              label: "Add to Toolbox…",
              onSelect: () =>
                openToolboxAdd("", {
                  kind: "local",
                  source: path,
                  label: basename(path).replace(/\.tox$/i, ""),
                }),
            },
      );
      if (removable) {
        entries.push({
          label: "Remove from Palette…",
          danger: true,
          onSelect: () => void removePaletteFile(path),
        });
      }
    }
    return entries;
  };

  /**
   * Menu for a Patreon `.tox` row — native (only a remote `url` so far) or
   * already-extracted (a local `path`). "Add to Toolbox…" reuses the same
   * pin flow as a palette `.tox` (openToolboxAdd, category defaulted to the
   * creator's name); "Add to Palette…" reuses the drag-drop import path
   * (importToxFiles), same per-creator subfolder convention as downloads.
   */
  const patreonToxMenu = (file: { name: string; url?: string; path?: string }): MenuEntry[] => {
    const category = (patreonCampaign?.name ?? "").trim();
    const label = file.name.replace(/\.tox$/i, "");
    const resolvePath = async (): Promise<string> => {
      if (file.path) return file.path;
      setStatusMsg(`Downloading ${file.name}…`);
      return api.patreonDownloadTox(file.url!, file.name, category);
    };
    const withPath = (action: (path: string) => void) => () => {
      void resolvePath()
        .then(action)
        .catch((e) => {
          setPatreonError(String(e));
          setStatusMsg(String(e));
        });
    };
    return [
      { type: "header", label: file.name },
      file.path && toolboxHasLocal(file.path)
        ? { label: "In Toolbox", disabled: true, hint: "★" }
        : {
            label: "Add to Toolbox…",
            onSelect: withPath((path) =>
              openToolboxAdd(category, { kind: "local", source: path, label }),
            ),
          },
      {
        label: "Add to Palette…",
        // Unlike the Toolbox category (just a label), this becomes a real
        // filesystem folder name — sanitize it so a creator name with a
        // '/' or Windows-illegal character can't split into nested folders
        // or fail dir creation outright.
        onSelect: withPath((path) => void importToxFiles([path], sanitizeFolderName(category))),
      },
    ];
  };

  /**
   * Drop leading, trailing and doubled separators — dropping conditional rows
   * otherwise leaves the dividers that framed them stranded.
   */
  const tidySeparators = (list: MenuEntry[]): MenuEntry[] => {
    const out: MenuEntry[] = [];
    for (const entry of list) {
      const isSep = entry.type === "separator";
      if (isSep && (!out.length || out[out.length - 1].type === "separator")) continue;
      out.push(entry);
    }
    while (out.length && out[out.length - 1].type === "separator") out.pop();
    return out;
  };

  const sessionActionModel = (item: ListItem): SessionAction[] =>
    buildSessionActions({
      alive: item.source !== "stale",
      hasPid: item.openPid != null,
      hasCompanion: item.openUtilityAvailable === true,
      hasEnvoy: !!item.openMcpAvailable,
      windowCount: item.openWindows?.length ?? 0,
    });

  /** Execute one canonical session verb. Menus and cards both call this. */
  const runDesktopSessionAction = (item: ListItem, id: SessionActionId) => {
    switch (id) {
      case "focus": void focusOpenSession(item.openPid); break;
      case "save": void runUtilityAction(item, "save"); break;
      case "snapshot": void runUtilityAction(item, "pulse"); break;
      case "record": void runUtilityAction(item, "record"); break;
      case "heartbeat": void watchOpenSession(item); break;
      case "relaunch":
        if (item.source === "stale") void relaunchStaleSession(item);
        else void askRelaunchOpenSession(item);
        break;
      case "kill": killOpenSession(item); break;
      case "dismiss": void dismissStaleSession(item.path); break;
      case "windows": toggleWindowList(item.path); break;
      case "reveal": void revealOpenSession(item.path); break;
      case "copy-path": copyText(item.path, "Path copied"); break;
      case "envoy": openMcpForSession(item); break;
      case "add-to-project": break; // needs the button anchor; handled by the card
    }
  };

  /** Menu for a running session (Current tab rows / gallery cards). */
  const sessionMenu = (item: ListItem): MenuEntry[] => {
    const model = sessionActionModel(item);
    const actionById = (id: SessionActionId) => model.find((a) => a.id === id);
    // Stale (ended) session: only relaunch / reveal / dismiss make sense.
    if (item.source === "stale") {
      return [
        { type: "header", label: `${item.displayName || basename(item.path)} — ended` },
        { label: actionById("relaunch")?.label ?? "Relaunch", onSelect: () => runDesktopSessionAction(item, "relaunch") },
        { label: revealLabel, onSelect: () => runDesktopSessionAction(item, "reveal") },
        { label: actionById("copy-path")?.label ?? "Copy path", onSelect: () => runDesktopSessionAction(item, "copy-path") },
        { type: "separator" },
        {
          label: `${actionById("dismiss")?.label ?? "Dismiss"} (remove from list)`,
          danger: true,
          onSelect: () => runDesktopSessionAction(item, "dismiss"),
        },
      ];
    }
    const entries: MenuEntry[] = [
      { type: "header", label: item.displayName || basename(item.path) },
      {
        label: `${actionById("focus")?.label ?? "Focus"} TD window`,
        disabled: actionById("focus")?.enabled === false,
        title: item.openPid != null ? `PID ${item.openPid}` : "No PID for this session",
        onSelect: () => runDesktopSessionAction(item, "focus"),
      },
    ];
    const windows = item.openWindows ?? [];
    if (windows.length) {
      {
        const children: MenuEntry[] = windows.map((win) => ({
          label: windowLabel(win, item.displayName),
          hint: win.monitor > 0 ? `Display ${win.monitor}` : undefined,
          title: win.title,
          checked: win.foreground,
          onSelect: () => void runWindowAction(win, "focus", item.path),
        }));
        if (windows.length > 1) {
          children.push(
            { type: "separator" },
            {
              label: "Bring all forward",
              onSelect: () => void runSessionWindows(item.openPid, item.path, "raise"),
            },
            {
              label: "Minimize all",
              onSelect: () => void runSessionWindows(item.openPid, item.path, "minimize"),
            },
          );
        }
        entries.push({
          label: `Windows (${windows.length})`,
          title: "Focus one specific window of this session",
          children,
        });
      }
    }
    entries.push(
      { label: revealLabel, onSelect: () => runDesktopSessionAction(item, "reveal") },
      { label: actionById("copy-path")?.label ?? "Copy path", onSelect: () => runDesktopSessionAction(item, "copy-path") },
      { type: "separator" },
    );
    // Only when the catalog offers it: Heartbeat needs the companion (see
    // sessionActions.ts -- without it the watchdog would kill a healthy session).
    const heartbeat = actionById("heartbeat");
    if (heartbeat) {
      entries.push({
        label: heartbeat.label,
        title: "Watch this session for crashes and restart it",
        onSelect: () => runDesktopSessionAction(item, "heartbeat"),
      });
    }
    entries.push(
      { label: actionById("relaunch")?.label ?? "Relaunch…", onSelect: () => runDesktopSessionAction(item, "relaunch") },
    );
    if (item.openMcpAvailable) {
      entries.push({ label: actionById("envoy")?.label ?? "Open Envoy panel", onSelect: () => runDesktopSessionAction(item, "envoy") });
    }
    if (item.openUtilityAvailable) {
      // The whole companion surface is free (docs/fns-plus-capabilities.md
      // D3): pro capability gates at Plus-package stocking, not here.
      const companion: MenuEntry[] = tidySeparators([
        { label: "Save project", onSelect: () => void runUtilityAction(item, "save") },
        {
          label: "Repoint assets…",
          onSelect: () => void repointAssetsInSession(item),
        },
        {
          label: actionById("snapshot")?.label ?? "Thumbnail",
          title: "Update the project icon and preview/preview.png",
          onSelect: () => void runUtilityAction(item, "pulse"),
        },
        {
          label: actionById("record")?.label ?? "Preview video",
          title: "Record preview/preview.mp4",
          onSelect: () => void runUtilityAction(item, "record"),
        },
        { type: "separator" },
        { label: "Load .tox…", onSelect: () => void loadToxIntoSession(item) },
        { label: "Load .tox from URL…", onSelect: () => loadToxFromUrlIntoSession(item) },
        { label: "Install package…", onSelect: () => void openTdpPackagePicker(item) },
        { type: "separator" },
        { label: "Set up Python env", onSelect: () => void ensureProjectEnv(item) },
      ]);
      if (bundledUtilityVersion && item.openUtilityVersion !== bundledUtilityVersion) {
        companion.push({
          label: `Update utility → v${bundledUtilityVersion}`,
          onSelect: () => void updateSessionUtility(item),
        });
      }
      entries.push({ type: "separator" }, { label: "Companion", children: companion });
      // Capability injection (registry ≥ 1.7.0): commands the session's
      // tools target at the `context-menu` surface. Flat rows with the
      // owning tool as the right-aligned hint; boolean state renders as the
      // check gutter. Same curation store as the quick palette.
      const ctxCmds = surfaceCommands(item, "context-menu");
      if (ctxCmds.length) {
        entries.push(
          { type: "separator" },
          ...ctxCmds.map(
            (c): MenuEntry => ({
              label: `${withInstance(c.label, c.instance)}${(c.params?.length ?? 0) > 0 ? "…" : ""}`,
              hint: c.builtin
                ? undefined
                : typeof c.state === "string"
                  ? `${canonicalToolName(c.tool)} · ${c.state}`
                  : canonicalToolName(c.tool),
              title: c.help || undefined,
              checked: typeof c.state === "boolean" ? c.state : undefined,
              onSelect: () => runSurfacedCommand(item, c),
            }),
          ),
        );
      }
    }
    entries.push(
      { type: "separator" },
      {
        label: item.openPid != null ? `Kill PID ${item.openPid}` : "Kill session",
        danger: true,
        disabled: item.openPid == null,
        onSelect: () => runDesktopSessionAction(item, "kill"),
      },
    );
    return entries;
  };

  /** Context menu for a row/card in Recent, Current, or Templates. */
  /**
   * Write a project's GPU affinity into its sidecar. Takes effect on the next
   * launch — the flags can only be handed to TD at process start.
   */
  const setGpuAffinityFor = async (path: string, monitor: number | null) => {
    try {
      const sidecar = await api.setProjectGpuAffinity(path, monitor);
      const info = await api.getProjectMeta(path);
      setProjectMetaByPath((prev) => ({ ...prev, [path]: info }));
      setStatusMsg(
        monitor === null
          ? `GPU affinity cleared → ${sidecar}`
          : `GPU affinity → monitor ${monitor} on next launch → ${sidecar}`,
      );
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /**
   * "GPU affinity" submenu — binds this project's TD process to a single
   * graphics card at launch (`-gpuformonitor` / `-gpubusid`), stored in the
   * sidecar so the binding travels with the project.
   *
   * Deliberately buried in the context menu: multi-GPU show machines need it,
   * everyone else should never trip over it. Returns null (no menu at all)
   * unless there is more than one display to choose between, or the sidecar
   * already carries an affinity that should stay visible and clearable.
   */
  const gpuAffinityMenu = (item: ListItem): MenuEntry[] | null => {
    if (platform !== "windows" || item.isDefault || item.missing) return null;
    const gpu = projectMetaByPath[item.path]?.meta.gpu ?? null;
    const busId = gpu?.bus_id?.trim() || null;
    const monitor = gpu?.monitor ?? null;
    const bound = monitor !== null || !!busId;
    if (gpuMonitors.length < 2 && !bound) return null;

    const entries: MenuEntry[] = [
      { type: "header", label: "Bind to one GPU — next launch" },
      {
        label: "Any GPU (default)",
        checked: !bound,
        title: "Let the system pick — TouchDesigner's normal behaviour",
        onSelect: () => void setGpuAffinityFor(item.path, null),
      },
      ...gpuMonitors.map(
        (m): MenuEntry => ({
          label: `Monitor ${m.index}${m.primary ? " (primary)" : ""}`,
          hint: `${m.width}×${m.height}`,
          checked: monitor === m.index,
          title:
            `Bind to the GPU driving this monitor (-gpuformonitor ${m.index}). ` +
            `TD counts monitors left→right, bottom→top — not the order Windows ` +
            `shows. Confirm in the Monitors DAT 'affinity' column.`,
          onSelect: () => void setGpuAffinityFor(item.path, m.index),
        }),
      ),
    ];
    if (busId) {
      entries.push({
        label: `Bus ID ${busId}`,
        checked: monitor === null,
        disabled: true,
        title:
          "Set by hand in the sidecar (gpu.bus_id) — pick a monitor or Any GPU to replace it",
      });
    }
    return entries;
  };

  const fileItemMenu = (item: ListItem): MenuEntry[] => {
    if (tab === "current") return sessionMenu(item);
    if (isToxPath(item.path)) return toxFileMenu(item.path, item.missing);
    if (item.isDefault) {
      return [
        { type: "header", label: item.displayName },
        {
          label: usePlayer ? "Launch TouchPlayer" : "Launch TouchDesigner",
          title: "Launch with default startup",
          onSelect: () => void launchItemFromMenu(item),
        },
      ];
    }
    const entries: MenuEntry[] = [
      { type: "header", label: item.displayName },
      {
        label: "Launch",
        disabled: item.missing,
        onSelect: () => void launchItemFromMenu(item),
      },
      {
        label: usePlayer ? "Launch with TouchDesigner" : "Launch with TouchPlayer",
        disabled: item.missing,
        onSelect: () => void launchItemFromMenu(item, !usePlayer),
      },
      ...(item.familyKey
        ? [
            {
              label: `Versions… (${item.familyCount ?? 0})`,
              title: "All copies of this project — increments, backups, crash autosaves",
              onSelect: () => openVersionsDrawer(item.familyKey!),
            } satisfies MenuEntry,
          ]
        : []),
      { type: "separator" },
      {
        label: revealLabel,
        disabled: item.missing,
        onSelect: () => void api.openPath(item.path),
      },
      { label: "Copy path", onSelect: () => copyText(item.path, "Path copied") },
      {
        label: "Duplicate as new version",
        title:
          "Copy this file into a numbered variant next to the project (Name.N.toe) — never overwrites",
        disabled: item.missing,
        onSelect: () => void duplicateVariant(item.path),
      },
      // Hidden on a file that already carries the prefix — it opens in Safe
      // Mode as it is, and a second prefix would just nest.
      ...(basename(item.path).toLowerCase().startsWith("crashautosave.")
        ? []
        : [
            {
              label: "Create and run CrashAutoSave",
              title:
                `Copy this project to CrashAutoSave.${basename(item.path)} and open THAT copy.
` +
                "TouchDesigner opens any file named CrashAutoSave* in Safe Mode, where " +
                "nothing cooks — the way into a project that crashes or hangs on load. " +
                "The original is only read.",
              disabled: item.missing,
              onSelect: () => void runSafeModeCopy(item),
            } satisfies MenuEntry,
          ]),
    ];
    const gpuMenu = gpuAffinityMenu(item);
    if (gpuMenu) {
      const gpu = projectMetaByPath[item.path]?.meta.gpu ?? null;
      const busId = gpu?.bus_id?.trim() || null;
      entries.push({
        label: "GPU affinity",
        hint:
          gpu?.monitor != null
            ? `Monitor ${gpu.monitor}`
            : busId
              ? busId
              : undefined,
        title:
          "Multi-GPU machines: bind this project's TouchDesigner process to one " +
          "graphics card at launch (TD 2022.20000+). Stored in the project sidecar.",
        children: gpuMenu,
      });
    }
    if (tab === "recent") {
      const isTemplate = templates.some(
        (t) =>
          t.replace(/\\/g, "/").toLowerCase() ===
          item.path.replace(/\\/g, "/").toLowerCase(),
      );
      entries.push(
        { type: "separator" },
        isTemplate
          ? { label: "In Templates", disabled: true, hint: "✓" }
          : {
              label: "Add to Templates",
              disabled: item.missing,
              onSelect: () =>
                void api.addTemplate(item.path).then(async () => {
                  await refreshLists(undefined, { rediscover: false });
                  setStatusMsg(`Added ${basename(item.path)} to Templates`);
                }),
            },
      );
    }
    if (tab === "templates") {
      entries.push(
        { type: "separator" },
        {
          label: "Move up",
          onSelect: () =>
            void api
              .moveTemplate(item.path, "up")
              .then(() => refreshLists(undefined, { rediscover: false })),
        },
        {
          label: "Move down",
          onSelect: () =>
            void api
              .moveTemplate(item.path, "down")
              .then(() => refreshLists(undefined, { rediscover: false })),
        },
      );
    }
    // TD-history entries can only be pruned on Windows (mirrors the × button).
    if (!(item.source === "td" && platform !== "windows")) {
      entries.push(
        { type: "separator" },
        {
          label: tab === "templates" ? "Remove from Templates" : "Remove from Recent",
          danger: true,
          onSelect: () => void onRemove(item.path),
        },
      );
    }
    return entries;
  };

  /** Menu for empty space in the file list / gallery. */
  const listPaneMenu = (): MenuEntry[] => {
    if (tab === "current") {
      return [{ label: "Refresh sessions", onSelect: () => void onBrowse() }];
    }
    return [
      {
        label: tab === "templates" ? "Add template (.toe)…" : "Browse for project…",
        onSelect: () => void onBrowse(),
      },
      {
        label: "Refresh",
        onSelect: () => void refreshLists(undefined, { rediscover: false }),
      },
    ];
  };

  /** Menu for a palette tree folder row. */
  const paletteFolderMenu = (node: PaletteTreeFolder): MenuEntry[] => {
    const abs = node.relFolder ? `${node.absRoot}/${node.relFolder}` : node.absRoot;
    const entries: MenuEntry[] = [{ type: "header", label: node.name }];
    if (node.acceptImports) {
      entries.push(
        {
          label: "Import .tox files here…",
          title: "Copy .tox files into this User Palette folder",
          onSelect: () =>
            void api.pickToxFiles(true).then((files) => {
              if (files.length) void importToxFiles(files, node.relFolder);
            }),
        },
        { type: "separator" },
      );
    }
    entries.push(
      { label: "Open folder", disabled: !abs, onSelect: () => void api.openPath(abs) },
      {
        label: "Copy folder path",
        disabled: !abs,
        onSelect: () => copyText(abs, "Path copied"),
      },
    );
    return entries;
  };

  /** Menu for a Toolbox tool row. */
  const toolboxToolMenu = (tool: ToolboxTool): MenuEntry[] => {
    const entries: MenuEntry[] = [
      { type: "header", label: tool.label || basename(tool.source) },
    ];
    const path = tool.resolvedPath;
    if (path && !tool.missing) {
      entries.push(...placeToxEntries(path), { type: "separator" });
    }
    if (tool.kind === "url") {
      entries.push({
        label: path ? "Re-fetch latest" : "Fetch .tox",
        disabled: toolboxBusyIds.has(tool.id),
        onSelect: () => void toolboxFetch(tool),
      });
    }
    if (path) {
      entries.push(
        {
          label: revealLabel,
          disabled: tool.missing,
          onSelect: () => void api.openPath(path),
        },
        { label: "Copy path", onSelect: () => copyText(path, "Path copied") },
      );
    }
    if (tool.kind !== "local") {
      entries.push({
        label: tool.kind === "package" ? "Copy package spec" : "Copy source URL",
        onSelect: () => copyText(tool.source, "Copied"),
      });
    }
    entries.push(
      { type: "separator" },
      {
        label: "Move up",
        onSelect: () => void toolboxRun(() => api.toolboxMoveTool(tool.id, "up")),
      },
      {
        label: "Move down",
        onSelect: () => void toolboxRun(() => api.toolboxMoveTool(tool.id, "down")),
      },
      { label: "Edit…", onSelect: () => openToolboxEdit(tool) },
      { type: "separator" },
      {
        label: "Unpin from Toolbox",
        danger: true,
        onSelect: () =>
          void toolboxRun(
            () => api.toolboxRemoveTool(tool.id),
            `Unpinned ${tool.label || "tool"}`,
          ),
      },
    );
    return entries;
  };

  /** Menu for a Toolbox category row. */
  const toolboxCategoryMenu = (cat: string): MenuEntry[] => [
    { type: "header", label: cat },
    { label: "Pin a tool here…", onSelect: () => openToolboxAdd(cat) },
    {
      label: "Rename…",
      onSelect: () => {
        setToolboxCatDraft({ original: cat, name: cat });
        setModal("toolboxCategory");
      },
    },
    { type: "separator" },
    {
      label: "Move up",
      onSelect: () => void toolboxRun(() => api.toolboxMoveCategory(cat, "up")),
    },
    {
      label: "Move down",
      onSelect: () => void toolboxRun(() => api.toolboxMoveCategory(cat, "down")),
    },
    { type: "separator" },
    {
      label: "Remove category",
      danger: true,
      title: "Tools inside move to the Toolbox top level",
      onSelect: () =>
        void toolboxRun(
          () => api.toolboxRemoveCategory(cat),
          `Removed "${cat}" — its tools moved to top level`,
        ),
    },
  ];

  /**
   * Append a glob to the backup exclude filters (Settings text). Resolves
   * false when an equivalent line is already present.
   */
  const addBackupExclude = async (pattern: string): Promise<boolean> => {
    const existing = config?.backup_exclude ?? "";
    const norm = (l: string) => l.trim().replace(/\\/g, "/").toLowerCase();
    const target = norm(pattern);
    if (
      existing
        .split(/\r?\n/)
        .map(norm)
        .some((l) => l === target)
    ) {
      return false;
    }
    const nextText = existing.trim() ? `${existing.replace(/\s+$/, "")}\n${pattern}` : pattern;
    const next = await api.updatePrefs({ backup_exclude: nextText });
    setConfig(next);
    // Keep the Settings draft honest if the dialog is opened later this session.
    setBackupExcludeDraft(next.backup_exclude || "");
    return true;
  };

  /** Menu for the Toolbox header / chrome. */
  const toolboxHeaderMenu = (): MenuEntry[] => [
    { type: "header", label: "Toolbox" },
    { label: "Pin a tool…", onSelect: () => openToolboxAdd("") },
    {
      label: "Add category…",
      onSelect: () => {
        setToolboxCatDraft({ original: null, name: "" });
        setModal("toolboxCategory");
      },
    },
  ];

  type PanelId =
    | "info" | "tags" | "git" | "backup" | "heartbeat" | "mcp"
    | "control" | "media";

  type PanelDef = {
    id: PanelId;
    label: string;
    icon: string;
    title: string;
    action?: ActionId;
    hint?: HintId;
    currentOnly?: boolean;
  };

  /** One definition feeds the contextual rail and the existing shortcuts. */
  const PANELS: PanelDef[] = [
    {
      id: "info",
      label: "Info",
      icon: "i",
      title: "Project README and details",
      action: "panel.info",
      hint: "tool-info",
    },
    {
      id: "git",
      label: "Git",
      icon: "⑂",
      title: "Changes, diffs, commits, branches, push and pull",
      action: "panel.git",
      hint: "tool-git",
    },
    {
      id: "backup",
      label: "Backup",
      icon: "↥",
      title: "Back up or sync the project folder",
      action: "panel.backup",
      hint: "tool-backup",
    },
    {
      id: "heartbeat",
      label: "Heartbeat",
      icon: "♥",
      title: "Watch this project and relaunch it after a stall",
      action: "panel.heartbeat",
      hint: "tool-watch",
    },
    {
      id: "control",
      label: "Control",
      icon: "◎",
      title: "Parameters exposed by the selected session",
      currentOnly: true,
    },
    {
      id: "media",
      label: "Media files",
      icon: "▣",
      title: "Files referenced by the selected session",
      currentOnly: true,
    },
    {
      id: "mcp",
      label: "Envoy",
      icon: "<>",
      title: "Embody and Envoy bridge status",
      action: "panel.mcp",
      hint: "tool-mcp",
    },
  ];

  const railPanels = tab === "patreon" || tab === "fns"
    ? []
    : PANELS.filter((panel) => {
        if (panel.id === "mcp") return selectedMcpAvailable;
        if (panel.currentOnly) return tab === "current";
        if (tab === "palette") return panel.id === "git" || panel.id === "backup";
        return true;
      });

  const panelOpen = (id: PanelId): boolean => {
    switch (id) {
      case "info": return !!config?.show_readme;
      case "tags": return tagsOpen;
      case "git": return gitOpen;
      case "backup": return backupOpen;
      case "heartbeat": return watchOpen;
      case "mcp": return mcpOpen;
      case "control": return controlOpen;
      case "media": return mediaOpen;
    }
  };

  const setPanelOpen = (id: PanelId, open: boolean) => {
    switch (id) {
      case "info":
        if (!!config?.show_readme !== open) void updatePref({ show_readme: open });
        break;
      case "tags": setTagsOpen(open); break;
      case "git": setGitOpen(open); break;
      case "backup": setBackupOpen(open); break;
      case "heartbeat": setWatchOpen(open); break;
      case "mcp": setMcpOpen(open); break;
      case "media": setMediaOpen(open); break;
      case "control": setControlOpen(open); break;
    }
  };

  /** Close every right-side panel except one. */
  const closeSidePanelsExcept = (keep?: PanelId) => {
    for (const panel of PANELS) {
      if (panel.id !== keep && panelOpen(panel.id)) {
        setPanelOpen(panel.id, false);
      }
    }
  };

  const openSidePanelCount = () =>
    railPanels.filter((panel) => panelOpen(panel.id)).length;

  /**
   * Left click / shortcuts are exclusive. Ctrl/Cmd-click is additive and is
   * capped at three visible panels so each section keeps a useful height.
   */
  const togglePanel = (id: PanelId, additive = false) => {
    if (id === "tags") {
      setTagsOpen((open) => !open);
      return;
    }
    const open = panelOpen(id);
    if (open) {
      setPanelOpen(id, false);
      return;
    }
    if (additive) {
      if (openSidePanelCount() >= 3) {
        setStatusMsg("Three panels are already open — close one before stacking another");
        return;
      }
    } else {
      closeSidePanelsExcept(id);
    }
    setPanelOpen(id, true);
  };

  const panelContextMenu = (panel: PanelDef): MenuEntry[] => {
    const open = panelOpen(panel.id);
    return [
      { type: "header", label: `${panel.label} panel` },
      ...(open
        ? [
            { label: "Close panel", onSelect: () => setPanelOpen(panel.id, false) } as MenuEntry,
            {
              label: "Keep only this panel",
              disabled: openSidePanelCount() <= 1,
              onSelect: () => closeSidePanelsExcept(panel.id),
            } as MenuEntry,
          ]
        : [
            { label: "Open only", onSelect: () => togglePanel(panel.id) } as MenuEntry,
            {
              label: "Open alongside",
              hint: "Ctrl/Cmd+click",
              disabled: openSidePanelCount() >= 3,
              title: "Stack this panel with the panels already open (maximum three)",
              onSelect: () => togglePanel(panel.id, true),
            } as MenuEntry,
          ]),
    ];
  };

  /** Configured accelerator for an action, formatted for this platform. */
  const accelHint = (id: ActionId | undefined): string | undefined => {
    if (!id) return undefined;
    const action = EDITABLE_ACTIONS.find((a) => a.id === id);
    if (!action) return undefined;
    const accel = bindingFor(action, config?.keybindings, isMac);
    return accel ? displayAccel(accel, isMac) : undefined;
  };

  /**
   * The Quick Launch overlay's OS-level hotkey, written the way the user sees
   * it in the tray menu. Falls back to the shipped default when unset, which is
   * also what the backend registers.
   */
  const quickHotkeyLabel = (config?.global_hotkey || "Alt+Shift+D").replace(
    /CommandOrControl|CmdOrCtrl/i,
    mod,
  );

  /** The overlay's five filter prefixes — user-editable single characters. */
  const qp = {
    commands: config?.quick_prefix_commands ?? ">",
    components: config?.quick_prefix_components ?? "=",
    category: config?.quick_prefix_category ?? "/",
    tag: config?.quick_prefix_tag ?? "#",
    tools: config?.quick_prefix_tools ?? "?",
  };

  /**
   * The header View menu: layout, list display, rail density, and theme. Built
   * on each render so checkmarks stay live while toggles are flipped in a run.
   */
  const viewMenu = (): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    const listTab = tab !== "palette" && tab !== "patreon" && tab !== "fns";

    if (listTab) {
      const setSortField = (field: ListSortField) => {
        const next = { ...listSort, field };
        setListSort(next);
        saveListSort(next);
      };
      const defaultOrderLabel =
        tab === "templates" ? "Manual order" : tab === "current" ? "Launch order" : "Recently used";
      const sortFields: { field: ListSortField; label: string }[] = [
        { field: "default", label: defaultOrderLabel },
        { field: "name", label: "Name" },
        { field: "date", label: "Date modified" },
        { field: "size", label: "Size" },
      ];
      entries.push(
        { type: "header", label: "Sort" },
        {
          label: "Sort by",
          hint: sortFields.find((s) => s.field === listSort.field)?.label,
          children: [
            ...sortFields.map<MenuEntry>((s) => ({
              label: s.label,
              checked: listSort.field === s.field,
              keepOpen: true,
              onSelect: () => setSortField(s.field),
            })),
            { type: "separator" },
            {
              label: "Reverse order",
              checked: listSort.reverse,
              keepOpen: true,
              onSelect: () => {
                const next = { ...listSort, reverse: !listSort.reverse };
                setListSort(next);
                saveListSort(next);
              },
            },
          ],
        },
        { type: "separator" },
        { type: "header", label: "Layout" },
        {
          label: tab === "current" ? "Cards" : "Gallery",
          checked: isGallery,
          keepOpen: true,
          onSelect: () => void updatePref({ view_mode: "gallery" }),
        },
        {
          label: tab === "current" ? "Compact" : "List",
          checked: !isGallery,
          keepOpen: true,
          onSelect: () => void updatePref({ view_mode: "list" }),
        },
        { type: "separator" },
        {
          label: "Show icons",
          hint: "C",
          checked: !!config?.show_icons,
          keepOpen: true,
          disabled: isGallery,
          title: isGallery
            ? "List view only — gallery tiles always show artwork"
            : "Show each project's icon in the list",
          onSelect: () => void updatePref({ show_icons: !config?.show_icons }),
        },
        {
          label: "Group project versions",
          hint: "V",
          checked: !!config?.collapse_versions,
          keepOpen: true,
          title:
            "One card per project — Name.N.toe increments, Backup copies and crash autosaves fold into it (the ⑂ badge opens them)",
          onSelect: () => void updatePref({ collapse_versions: !config?.collapse_versions }),
        },
      );
    }

    if (railPanels.length > 0) {
      entries.push(
        { type: "separator" },
        { type: "header", label: "Panel rail" },
        {
          label: "Show panel labels",
          checked: !panelRailCollapsed,
          keepOpen: true,
          title: "Expand the inspector dock to show text labels under its icons",
          onSelect: () => {
            const next = !panelRailCollapsed;
            setPanelRailCollapsed(next);
            savePanelRailCollapsed(next);
          },
        },
      );
    }

    entries.push(
      { type: "separator" },
      {
        label: "Theme",
        children: THEMES.map<MenuEntry>((t) => ({
          label: t.label,
          checked: (config?.theme || "classic") === t.id,
          keepOpen: true,
          onSelect: () => void updatePref({ theme: t.id }),
        })),
      },
      { type: "separator" },
      { label: "Settings…", hint: accelHint("settings"), onSelect: openSettings },
    );
    return entries;
  };

  /** The header's meta actions live in one place instead of four peer buttons. */
  const helpMenu = (): MenuEntry[] => [
    { label: "Help & shortcuts", onSelect: () => setModal("help") },
    { label: "Start Tour", onSelect: startTour },
    { label: "Setup Wizard", onSelect: startWizard },
    { type: "separator" },
    { label: "About & updates", onSelect: () => setModal("about") },
  ];

  /** Copy the bundled companion TOX into the user's Palette and open it there. */
  const installUtilityToPalette = async () => {
    if (!bundledUtilityTox) return;
    await importToxFiles([bundledUtilityTox], "");
    setModal(null);
    setTab("palette");
  };

  // Wizard variant: throws on failure (the wizard shows the error inline) and
  // leaves the wizard open instead of jumping to the Palette tab.
  const installUtilityForWizard = async () => {
    if (!bundledUtilityTox) return;
    await api.importToxToPalette([bundledUtilityTox], null);
    await refreshLists(undefined, { rediscover: false });
    setStatusMsg("Companion utility installed to User Palette");
  };

  const updatePref = async (patch: Partial<AppConfig>) => {
    const next = await api.updatePrefs(patch);
    setConfig(next);

    // Only reload icons when enabling them; collapse/readme are local UI
    if (patch.show_icons === true || patch.view_mode === "gallery") {
      void refreshLists(next, { rediscover: false });
    }
  };

  /** First video in a project's media folder, for the gallery tile's hover preview. */
  const galleryVideoFor = (path: string) =>
    projectMetaByPath[path]?.media?.find((m) => m.kind === "video")?.path ?? null;
  /** The cache key for a card's hover clip: its modified time when known (so
   *  a clip re-recorded from inside TD reloads too), else the capture counter. */
  const galleryVideoVersion = (path: string) =>
    projectMetaByPath[path]?.media?.find((m) => m.kind === "video")?.mtime ?? mediaVersion;

  const selectedMedia =
    selectedPath && selectedPath !== DEFAULT_TEMPLATE
      ? projectMetaByPath[selectedPath]?.media ?? []
      : [];
  const selectedMediaFolder =
    selectedPath && selectedPath !== DEFAULT_TEMPLATE
      ? projectMetaByPath[selectedPath]?.media_folder ?? null
      : null;

  const openMediaBrowser = (startIndex = 0) => {
    if (!selectedMedia.length) return;
    setMediaIndex(Math.max(0, Math.min(startIndex, selectedMedia.length - 1)));
    setModal("media");
  };

  // Shared by the launch pane and the session pane — previews are useful in both.
  const mediaStrip =
    selectedMedia.length > 0 || selectedMediaFolder ? (
      <div className="media-strip">
        <div className="media-strip-head">
          <span>
            Media{selectedMedia.length ? ` (${selectedMedia.length})` : ""}
            {selectedMediaFolder ? (
              <span className="media-folder-hint"> · {basename(selectedMediaFolder)}</span>
            ) : null}
          </span>
          <div className="media-strip-actions">
            {selectedMedia.length > 0 && (
              <button type="button" className="small" onClick={() => openMediaBrowser(0)}>
                Browse
              </button>
            )}
            {selectedMediaFolder && (
              <button
                type="button"
                className="small"
                onClick={() => void api.openPath(selectedMediaFolder)}
              >
                Folder
              </button>
            )}
          </div>
        </div>
        {selectedMedia.length > 0 && (
          <div className="media-thumbs">
            {selectedMedia.slice(0, 16).map((m, i) => (
              <button
                key={m.path}
                type="button"
                className="media-thumb"
                title={m.caption || basename(m.path)}
                onClick={() => openMediaBrowser(i)}
              >
                {m.kind === "video" ? (
                  <video
                    src={mediaSrc(m.path, "video", m.mtime ?? mediaVersion)}
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <img src={mediaSrc(m.path, "image", m.mtime ?? mediaVersion)} alt="" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    ) : null;

  const selectedProjectTags =
    selectedPath && selectedPath !== DEFAULT_TEMPLATE
      ? projectMetaByPath[selectedPath]?.meta.tags ?? []
      : [];
  const canEditTags =
    !!selectedPath &&
    selectedPath !== DEFAULT_TEMPLATE &&
    !isToxPath(selectedPath) &&
    !(meta[selectedPath] && !meta[selectedPath].exists);

  /** Running sessions the companion can place a .tox into. */
  /** Sessions actually running — the Current tab badge. Ended rows stay in the
   *  list so they can be relaunched, but they are not "current". */
  const liveSessionCount = openProjects.filter((p) => p.alive).length;
  const placeTargets = openProjects.filter((p) => p.alive && p.utility_available);
  /** Live sessions with NO companion. Nothing can be installed into these --
   *  fns_install goes over the companion bus, and the Envoy fallback answers
   *  "op.TDXLU shortcut not found" -- so the FNS tab lists them anyway and
   *  offers the utility drag instead of hiding them behind "no session". */
  const companionlessTargets = openProjects.filter((p) => p.alive && !p.utility_available);
  const placeTarget =
    placeTargets.find((p) => p.path === placeTargetPath) ?? placeTargets[0] ?? null;

  const selectedPalette = isToxPath(selectedPath)
    ? paletteItems.find((p) => p.path === selectedPath)
    : undefined;

  /** Shared folder context for Git + Backup: .toe project, or palette scan root (never Factory). */
  const folderContextPath = useMemo(() => {
    if (tab === "palette") {
      if (selectedPalette && selectedPalette.root_label !== "Factory") {
        return selectedPalette.root;
      }
      return defaultPaletteDir || null;
    }
    if (
      selectedPath &&
      selectedPath !== DEFAULT_TEMPLATE &&
      !isToxPath(selectedPath) &&
      !(meta[selectedPath] && !meta[selectedPath].exists)
    ) {
      return selectedPath;
    }
    return null;
  }, [tab, selectedPalette, defaultPaletteDir, selectedPath, meta]);

  const folderContextLabel = useMemo(() => {
    if (tab !== "palette") return null;
    if (selectedPalette && selectedPalette.root_label !== "Factory") {
      return selectedPalette.root_label;
    }
    return "User Palette";
  }, [tab, selectedPalette]);

  const canUseFolderTools = tab === "palette" ? !!folderContextPath : canEditTags;

  const stopPatreonLogin = useCallback((msg?: string) => {
    if (patreonPollRef.current) {
      clearInterval(patreonPollRef.current);
      patreonPollRef.current = null;
    }
    setPatreonLoginWaiting(false);
    if (msg) setStatusMsg(msg);
  }, []);

  const startPatreonLogin = async () => {
    try {
      await api.patreonOpenLogin();
      setPatreonLoginWaiting(true);
      setStatusMsg("Sign in to Patreon in the window that opened…");
      if (patreonPollRef.current) clearInterval(patreonPollRef.current);
      const started = Date.now();
      patreonPollRef.current = window.setInterval(async () => {
        if (Date.now() - started > 4 * 60 * 1000) {
          stopPatreonLogin("Patreon login timed out");
          return;
        }
        try {
          const r = await api.patreonTryCapture();
          if (r.startsWith("connected")) {
            stopPatreonLogin();
            const cfg = await api.getConfig();
            setConfig(cfg);
            setPatreonCookieDraft(cfg.patreon_session_cookie || "");
            // "connected|<account label>" — naming the account makes a login
            // into the wrong one obvious right away.
            const who = r.split("|")[1];
            setStatusMsg(
              who ? `Patreon connected as ${who} ✓` : "Patreon connected ✓",
            );
          } else if (r === "closed") {
            stopPatreonLogin("Patreon login cancelled");
          }
        } catch {
          /* transient — keep polling */
        }
      }, 2000);
    } catch (e) {
      setStatusMsg(String(e));
      setPatreonLoginWaiting(false);
    }
  };

  // Stop the Patreon login poll on unmount.
  useEffect(() => () => stopPatreonLogin(), [stopPatreonLogin]);

  /**
   * Disconnect the Patreon content session. The backend forgets the stored
   * cookie AND clears patreon.com out of our webview jar, so the next login is a
   * real sign-in rather than a silent return to the same account.
   *
   * Saved creators survive: they are bookmarks the user typed, not credentials.
   * The browsed campaign/post selection does not — it belongs to the session.
   */
  const logoutPatreon = async () => {
    if (
      !window.confirm(
        "Log out of Patreon?\n\nThe saved session is deleted and you'll need to log in " +
          "again to browse creators. Downloaded files and your creator list are kept.",
      )
    ) {
      return;
    }
    stopPatreonLogin();
    try {
      setConfig(await api.patreonLogout());
      setPatreonCookieDraft("");
      setPatreonCampaigns([]);
      setPatreonCampaign(null);
      setPatreonPostId(null);
      setStatusMsg("Logged out of Patreon");
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  /**
   * Which settings sections render right now: everything on the selected sidebar
   * page, or — while the search box has text — the matches across every page.
   * Non-matching sections stay mounted but `hidden`, so switching pages never
   * loses an in-progress edit in a draft field.
   */
  const settingsShown = useMemo(() => {
    // Searching for a specific tool command or preset by name should land on
    // the Quick Launch section even though those names aren't static keywords.
    const quickHay = [
      ...(config?.quick_seen_commands ?? []).map((c) => `${c.tool} ${c.label} ${c.id}`),
      ...(config?.quick_command_presets ?? []).map((p) => `${p.label} ${p.target}`),
    ].join(" ");
    const ids = settingsQuery.trim()
      ? matchSettingsSections(settingsQuery, { quicklaunch: quickHay })
      : new Set(VISIBLE_SETTINGS_SECTIONS.filter((s) => s.cat === settingsCat).map((s) => s.id));
    // Patreon is build-gated; don't count a section that will not render.
    if (!patreonEnabled) ids.delete("patreon");
    return ids;
  }, [settingsQuery, settingsCat, patreonEnabled, config]);

  /**
   * Open the Settings modal, optionally landing on one of its sections
   * (a `data-settings-section` value — see SETTINGS_SECTIONS, e.g. "github",
   * "backup", "heartbeat"). The section's sidebar page is selected first, so the
   * caller never has to know which page holds it.
   */
  const openSettings = (section?: string) => {
    setGithubUserDraft(config?.github_username || "");
    setGithubTokenDraft(config?.github_token || "");
    setPatreonCookieDraft(config?.patreon_session_cookie || "");
    setPatreonDownloadRootDraft(config?.patreon_download_root || "");
    setGlobalHotkeyDraft(hotkeyForField(config?.global_hotkey));
    void api.getHotkeyStatus().then(setHotkeyStatus);
    setGlobalHotkeyAltDraft(hotkeyForField(config?.global_hotkey_alt));
    void api.getHotkeyStatusQuickAlt().then(setHotkeyStatusQuickAlt);
    setGlobalHotkeyMainDraft(hotkeyForField(config?.global_hotkey_main));
    void api.getHotkeyStatusMain().then(setHotkeyStatusMain);
    setGlobalHotkeyMainAltDraft(hotkeyForField(config?.global_hotkey_main_alt));
    void api.getHotkeyStatusMainAlt().then(setHotkeyStatusMainAlt);
    setGlobalHotkeyPaletteDraft(hotkeyForField(config?.global_hotkey_palette));
    void api.getHotkeyStatusPalette().then(setHotkeyStatusPalette);
    setSmtpPasswordDraft(config?.alert_smtp_password || "");
    setAlertTestMsg("");
    setBackupRootDraft(config?.backup_root || "");
    setCloudRootDraft(config?.cloud_backup_root ?? "");
    setBackupExcludeDraft(config?.backup_exclude || "");
    setBackupIncludeDraft(config?.backup_include || "");
    setBackupMaxMbDraft(config?.backup_max_file_mb || 0);
    setPaletteExtraDraft(config?.palette_extra_folders || "");
    setPackageIndexDraft(config?.package_index_url || "");
    setPackagePrefixDraft(config?.package_index_prefix ?? "");
    setFnsBaseDraft(config?.fns_base_url || "");
    setGithubVerifyMsg("");
    setSettingsQuery("");
    // Guarded to strings because several onClick={openSettings} callers pass the
    // click event through as the first argument.
    const target = typeof section === "string" ? section : undefined;
    setSettingsCat(SETTINGS_SECTION_CAT[target ?? ""] ?? "general");
    setModal("settings");
    // Scroll the section into view once the page has rendered — only pages with
    // several sections need it, but it also flags which one the caller meant.
    // Instant scroll via scrollTop: smooth scrollIntoView silently no-ops in
    // some embedded webviews.
    if (target) {
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-settings-section="${target}"]`);
        const pane = el?.closest(".settings-pane");
        if (!el || !pane) return;
        pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
        el.classList.add("settings-jump-flash");
        setTimeout(() => el.classList.remove("settings-jump-flash"), 1400);
      }, 60);
    }
  };

  const growForSidePanel = async () => {
    try {
      const win = getCurrentWindow();
      const size = await win.outerSize();
      const scale = await win.scaleFactor();
      const logicalW = size.width / scale;
      if (logicalW < 1100) {
        const h = Math.max(size.height / scale, 700);
        await win.setSize(new LogicalSize(1200, h));
      }
    } catch {
      /* ignore */
    }
  };

  const normalizeTag = (raw: string) =>
    raw
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");

  const saveProjectTags = async (nextTags: string[]) => {
    if (!selectedPath || selectedPath === DEFAULT_TEMPLATE) return;
    const existing = projectMetaByPath[selectedPath]?.meta;
    // Spread, don't enumerate: the sidecar is co-owned with the companion TOX
    // (which writes the `windows` placement block) and future builds will add
    // keys. Listing fields by hand here would drop whatever this build has no
    // name for — the backend carries them through, so this must too.
    const metaPayload = {
      ...(existing ?? {}),
      version: existing?.version ?? 1,
      tags: nextTags,
      title: existing?.title ?? null,
      description: existing?.description ?? null,
      hero: existing?.hero ?? null,
      media_dir: existing?.media_dir ?? null,
      media: existing?.media ?? [],
      gpu: existing?.gpu ?? null,
    };
    try {
      await api.saveProjectMeta(selectedPath, metaPayload);
      const info = await api.getProjectMeta(selectedPath);
      setProjectMetaByPath((prev) => {
        const next = { ...prev, [selectedPath]: info };
        const set = new Set<string>();
        for (const m of Object.values(next)) {
          for (const t of m.meta.tags) {
            const n = t.trim();
            if (n) set.add(n);
          }
        }
        setAllTags([...set].sort((a, b) => a.localeCompare(b)));
        return next;
      });
      setStatusMsg(`Saved tags → ${info.sidecar_path ?? "sidecar"}`);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const addTagToSelected = async () => {
    const tag = normalizeTag(tagDraft);
    if (!tag || !canEditTags) return;
    const next = [...selectedProjectTags];
    if (!next.some((t) => t.toLowerCase() === tag.toLowerCase())) next.push(tag);
    setTagDraft("");
    await saveProjectTags(next);
  };

  const removeTagFromSelected = async (tag: string) => {
    if (!canEditTags) return;
    await saveProjectTags(selectedProjectTags.filter((t) => t !== tag));
  };

  const onBrowse = async () => {
    cancelCountdown();
    if (tab === "patreon") {
      void loadPatreonCampaigns();
      return;
    }
    if (tab === "current") {
      const list = await api.openProjectsList();
      setOpenProjects(list);
      setStatusMsg(
        list.length
          ? `${list.length} open project${list.length === 1 ? "" : "s"}`
          : "No TouchDesigner projects open",
      );
      return;
    }
    if (tab === "palette") {
      const folder = await api.pickFolder("Add palette folder");
      if (!folder) return;
      const lines = (config?.palette_extra_folders || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.some((l) => l.toLowerCase() === folder.toLowerCase())) {
        lines.push(folder);
      }
      const next = await api.updatePrefs({ palette_extra_folders: lines.join("\n") });
      setConfig(next);
      setPaletteExtraDraft(next.palette_extra_folders || "");
      await refreshLists(next, { rediscover: false });
      setStatusMsg(`Added palette folder: ${folder}`);
      return;
    }
    const files = await api.pickToeFiles(tab === "templates");
    if (!files.length) return;
    if (tab === "templates") {
      for (const f of files) await api.addTemplate(f);
      await refreshLists(undefined, { rediscover: false });
      setSelectedPath(files[0]);
    } else {
      setSelectedPath(files[0]);
      setActiveManual(files[0]);
      // warm meta for browsed file without full refresh
      void api.getFileMeta(files[0]).then((m) => {
        setMeta((prev) => ({
          ...prev,
          [files[0]]: {
            exists: m.exists,
            mtime: m.mtime,
            mtimeSecs: m.mtime_secs,
            bytes: m.bytes,
          },
        }));
      });
      void api.getProjectMeta(files[0]).then((info) => {
        setProjectMetaByPath((prev) => ({ ...prev, [files[0]]: info }));
      });
    }
  };

  const onRemove = async (path: string, force = false) => {
    if (tab === "palette") return;
    if (tab === "templates") {
      if (path === DEFAULT_TEMPLATE) return;
      await api.removeTemplate(path);
    } else {
      if (!force && config?.confirm_remove_from_list) {
        setRemoveTarget(path);
        setModal("remove");
        return;
      }
      // Family cards remove every member's recents entry — otherwise the
      // card just resurfaces through a sibling variant on the next refresh.
      for (const p of recentsPathsForRemoval(path)) {
        try {
          await api.removeRecent(p);
        } catch {
          /* td-history rows can be non-removable on some platforms */
        }
      }
    }
    await refreshLists(undefined, { rediscover: false });
    if (selectedPath === path) setSelectedPath(null);
  };

  const onDownload = async () => {
    if (!selectedPath || selectedPath === DEFAULT_TEMPLATE || !buildInfo) return;
    const display = displayBuildInfo(buildInfo, usePlayer);
    const url = await api.getDownloadUrl(display);
    if (!url) {
      setStatusMsg("Could not build download URL");
      return;
    }
    const sep = platform === "windows" ? "\\" : "/";
    const destPath = `${dirname(selectedPath)}${sep}${basename(url)}`;
    setInstallerPath(destPath);
    setDownloadProgress(0);
    try {
      await api.downloadTd(url, destPath);
      setDownloadProgress(1);
      setModal("install");
    } catch (e) {
      setStatusMsg(String(e));
      setDownloadProgress(null);
    }
  };

  const onInstall = async () => {
    if (!installerPath) return;
    setModal(null);
    await api.openInstaller(installerPath);
    if (buildInfo) {
      if (installPoll.current) clearInterval(installPoll.current);
      const started = Date.now();
      installPoll.current = window.setInterval(async () => {
        if (Date.now() - started > 600_000) {
          if (installPoll.current) clearInterval(installPoll.current);
          return;
        }
        const ok = await api.rediscoverAndCheck(buildInfo, usePlayer);
        if (ok) {
          if (installPoll.current) clearInterval(installPoll.current);
          const d = await api.discoverVersions();
          setDiscover(d);
          setStatusMsg(`${displayBuildInfo(buildInfo, usePlayer)} installed`);
          setDownloadProgress(null);
        }
      }, 3000);
    }
  };

  const accelMap = useMemo(
    () => buildAccelMap(config?.keybindings, patreonEnabled, isMac),
    [config?.keybindings, patreonEnabled, isMac],
  );
  const switcherAccel = useMemo(
    () =>
      Object.entries(accelMap).find(([, id]) => id === "windows.switcher")?.[0] ?? "",
    [accelMap],
  );
  const resetShortcut = (id: ActionId) => {
    const next = { ...(config?.keybindings ?? {}) };
    delete next[id];
    void updatePref({ keybindings: next });
  };
  const shortcutEditor = (
    <ShortcutEditor
      overrides={config?.keybindings}
      patreonEnabled={patreonEnabled}
      isMac={isMac}
      recording={recordingAction}
      onRecord={setRecordingAction}
      onReset={resetShortcut}
      onResetAll={() => void updatePref({ keybindings: {} })}
    />
  );

  // While recording a shortcut, capture the next chord (capture phase beats the
  // global handler) and save it as that action's binding.
  useEffect(() => {
    if (!recordingAction) return;
    const onRec = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingAction(null);
        return;
      }
      const accel = formatAccel(e);
      if (!accel) return; // bare modifier — keep waiting
      // Reassign: drop this accel from any other action so bindings stay unique.
      const next: Record<string, string> = {};
      for (const [id, a] of Object.entries(config?.keybindings ?? {})) {
        if (a !== accel && id !== recordingAction) next[id] = a;
      }
      next[recordingAction] = accel;
      void updatePref({ keybindings: next });
      setRecordingAction(null);
    };
    window.addEventListener("keydown", onRec, true);
    return () => window.removeEventListener("keydown", onRec, true);
  }, [recordingAction, config?.keybindings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The tour / setup wizard own the keyboard while open (Esc closes, arrows navigate)
      if (tourOpen || wizardOpen) return;
      // A shortcut is being recorded — the capture-phase listener handles it.
      if (recordingRef.current) return;

      const meta = isMac ? e.metaKey : e.ctrlKey;
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      const tabOrder: TabId[] = (
        patreonEnabled
          ? ["recent", "current", "templates", "palette", "fns", "patreon"]
          : ["recent", "current", "templates", "palette", "fns"]
      ).filter((t) => fnsTabShown || t !== "fns") as TabId[];
      const goTab = (t: TabId) => {
        setTab(t);
        if (t === "current") void refreshOpen();
      };
      const runAction = (id: ActionId) => {
        switch (id) {
          case "tab.recent": goTab("recent"); break;
          case "tab.current": goTab("current"); break;
          case "tab.templates": goTab("templates"); break;
          case "tab.palette": goTab("palette"); break;
          case "tab.patreon": if (patreonEnabled) goTab("patreon"); break;
          case "tab.fns": if (fnsTabShown) goTab("fns"); break;
          case "settings": openSettings(); break;
          case "help": setModal("help"); break;
          case "search":
            setSearchOpen(true);
            setTimeout(() => searchRef.current?.focus(), 0);
            break;
          case "windows.switcher":
            void refreshOpen();
            setSwitcherOpen(true);
            break;
          case "refresh": void onBrowse(); break;
          case "launch.default": {
            const v = launchDefaultStartup();
            if (v) {
              setSelectedPath(DEFAULT_TEMPLATE);
              setSelectedVersion(v);
              setTab("templates");
            }
            break;
          }
          case "toggle.versions":
            void updatePref({ collapse_versions: !config?.collapse_versions });
            break;
          case "toggle.icons":
            void updatePref({ show_icons: !config?.show_icons });
            break;
          case "toggle.readme":
            void updatePref({ show_readme: !config?.show_readme });
            break;
          case "toggle.touchplayer": setUsePlayer((p) => !p); break;
          case "reveal.folder":
            if (selectedPath && selectedPath !== DEFAULT_TEMPLATE) {
              void api.openPath(selectedPath);
            }
            break;
          case "readme.edit":
            if (config?.show_readme) setReadmeEdit(true);
            break;
          case "readme.save":
            if (readmeEdit && selectedPath) {
              void api.saveReadme(selectedPath, readmeDraft).then((p) => {
                setReadme((r) => ({ ...r, path: p, content: readmeDraft }));
                setReadmeEdit(false);
              });
            }
            break;
          case "panel.info": togglePanel("info"); break;
          case "panel.git": togglePanel("git"); break;
          case "panel.backup": togglePanel("backup"); break;
          case "panel.heartbeat": togglePanel("heartbeat"); break;
          case "panel.mcp": togglePanel("mcp"); break;
        }
      };

      if (e.key === "Escape") {
        if (switcherOpen) {
          setSwitcherOpen(false);
          return;
        }
        if (modal) {
          setModal(null);
          return;
        }
        if (searchOpen || search) {
          setSearch("");
          setSearchOpen(false);
          return;
        }
        if (readmeEdit) {
          setReadmeEdit(false);
          return;
        }
        void api.quitApp();
        return;
      }

      // A modal (Settings, Help, …) owns the keyboard: no launcher shortcuts,
      // and native editing (Ctrl+V paste, …) must reach its fields untouched.
      // The window switcher drives itself the same way (arrows, Enter).
      if (modal || switcherOpen) return;

      // Any deliberate keypress calls off a pending auto-launch — including one
      // that goes on to run a bound action, which is why this sits ABOVE the
      // accelerator lookup rather than below it.
      cancelCountdown();

      // Editable shortcuts, matched by accelerator. Several defaults are single
      // letters (V, C, E, R, F), so a modifier-less binding must not fire while
      // the user is typing — that key belongs to the text field. Function keys
      // are exempt: F1 can't be typed into anything.
      const accel = formatAccel(e);
      const boundAction = accel ? accelMap[accel] : undefined;
      const bareKeyBinding = !!accel && !accel.includes("+") && !/^F\d{1,2}$/.test(accel);
      if (boundAction && !(typing && bareKeyBinding)) {
        e.preventDefault();
        runAction(boundAction);
        return;
      }

      if (typing && !(searchOpen && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter"))) {
        return;
      }

      if (e.key === "Tab" && !meta) {
        e.preventDefault();
        const i = tabOrder.indexOf(tab);
        const step = e.shiftKey ? -1 : 1;
        const next = tabOrder[(i + step + tabOrder.length) % tabOrder.length];
        goTab(next ?? "recent");
        return;
      }

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setFocus((f) => (f === "picker" ? "versions" : "picker"));
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        void doLaunch(true);
        return;
      }

      // V / C / E / R / F, Ctrl+D and the README pair used to be hardcoded here.
      // They are EDITABLE_ACTIONS now and run through the accelerator lookup
      // above — see runAction. Ctrl+1–9 stays fixed: it is one binding per
      // template SLOT, not a single action to rebind.

      if (meta && e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key);
        const item = templateItems[idx - 1];
        if (item && !item.missing) {
          e.preventDefault();
          setTab("templates");
          setSelectedPath(item.path);
          setTimeout(() => void doLaunch(true), 50);
        }
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedPath && selectedPath !== DEFAULT_TEMPLATE) {
        if (tab === "palette" || isToxPath(selectedPath)) return;
        void onRemove(selectedPath);
        return;
      }

      if (meta && (e.key === "ArrowUp" || e.key === "ArrowDown") && tab === "templates" && selectedPath && selectedPath !== DEFAULT_TEMPLATE) {
        e.preventDefault();
        void api.moveTemplate(selectedPath, e.key === "ArrowUp" ? "up" : "down").then(() => refreshLists(undefined, { rediscover: false }));
        return;
      }

      // Letter nav is bare-key only. Unguarded, Ctrl+S (save muscle memory) and
      // Ctrl+W (close window) fell through to here and moved the selection.
      const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey;
      const navUp = e.key === "ArrowUp" || (plainKey && e.key.toLowerCase() === "w");
      const navDown = e.key === "ArrowDown" || (plainKey && e.key.toLowerCase() === "s");
      // The Patreon tab owns its arrows: PatreonPanel walks its posts in the
      // order it displays them, which this handler cannot see.
      if ((navUp || navDown) && tab !== "patreon") {
        e.preventDefault();
        if (focus === "versions") {
          const idx = Math.max(0, versionKeys.indexOf(selectedVersion ?? ""));
          const next = navUp
            ? Math.max(0, idx - 1)
            : Math.min(versionKeys.length - 1, idx + 1);
          setSelectedVersion(versionKeys[next] ?? null);
        } else {
          const visible = items.filter((i) => !i.missing);
          const idx = visible.findIndex((i) => i.path === selectedPath);
          const next = navUp
            ? Math.max(0, (idx < 0 ? 0 : idx) - 1)
            : Math.min(visible.length - 1, (idx < 0 ? -1 : idx) + 1);
          if (visible[next]) setSelectedPath(visible[next].path);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", cancelCountdown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", cancelCountdown);
    };
  });

  if (!ready || !config) {
    // Startup can fail *after* the catch sets `ready` (e.g. a backend command
    // rejects before the config lands), which used to leave a permanent,
    // silent "Loading…". Surface the reason instead of hanging mutely.
    return (
      <div className="app">
        <div className="empty">
          {ready && statusMsg ? (
            <>
              <div>TDX Launcher Ultra couldn&apos;t finish starting up.</div>
              <div className="hint" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                {statusMsg}
              </div>
            </>
          ) : (
            "Loading TDX Launcher Ultra…"
          )}
        </div>
      </div>
    );
  }

  /**
   * Row chip for an armed autosave timer. Only rendered when it is ON — a
   * chip on every row would be wallpaper, and the useful glance is "which of
   * these sessions is protected right now". Clicking opens the same dialog
   * the expanded session card's button does.
   */
  const autosaveChip = (item: ListItem) => {
    const a = autosaveByPath[item.path];
    if (tab !== "current" || !a?.active) return null;
    const last =
      a.last_save != null
        ? `
Last save ${new Date(a.last_save * 1000).toLocaleTimeString()}`
        : "";
    return (
      <button
        type="button"
        className="autosave-chip"
        title={`Autosave on — every ${formatAutosaveInterval(a.interval)}${last}${
          a.status ? `
${a.status}` : ""
        }`}
        onClick={(e) => {
          e.stopPropagation();
          openAutosaveForSession(item);
        }}
      >
        {"↻ "}
        {formatAutosaveInterval(a.interval)}
      </button>
    );
  };

  /**
   * Marks a tab whose list is filtered by a search of its own. Only shown for
   * INACTIVE tabs: on the active one the box itself is on screen, but from
   * elsewhere a filtered list would otherwise just look short.
   */
  const tabFilterMark = (t: TabId) => {
    const q = searchByTab[t] ?? "";
    if (!q || t === tab) return null;
    return (
      <span className="tab-filter-dot" title={`Filtered by “${q}”`} aria-label="filtered">
        ⌕
      </span>
    );
  };

  // The footer button follows the selected row's state on the Current tab:
  // an ended session relaunches, a live one goes through the already-open
  // dialog — say so up front instead of a misleading plain "Launch".
  const selectedItem = items.find((i) => i.path === selectedPath);
  const selectedStale = tab === "current" && selectedItem?.source === "stale";
  const selectedRunning =
    tab === "current" && selectedItem != null && selectedItem.source !== "stale";
  /** The big Launch button has nothing it can launch right now. */
  const launchBlocked =
    !selectedPath ||
    (!selectedVersion && !selectedStale) ||
    analyzing ||
    !!(meta[selectedPath] && !meta[selectedPath].exists && selectedPath !== DEFAULT_TEMPLATE);

  const launchLabel = (() => {
    if (countdown !== null && countdown > 0) {
      return cliFallbackVersion
        ? `${displayBuildInfo(buildInfo, usePlayer)} is not installed — opening with ${versionNumeric(cliFallbackVersion)} in ${countdown} seconds`
        : `Open with selected version in ${countdown} seconds`;
    }
    if (!selectedPath) return "Select a file to launch";
    if (analyzing) return "Analyzing file…";
    if (selectedStale)
      return `Relaunch ${basename(
        selectedItem ? relaunchPathFor(selectedItem) : selectedPath,
      )} — it ended earlier`;
    if (selectedRunning)
      return `${basename(selectedPath)} is running — focus or open a second copy…`;
    if (selectedPath === DEFAULT_TEMPLATE)
      return `Launch ${usePlayer ? "TouchPlayer" : "TouchDesigner"}`;
    if (isToxPath(selectedPath))
      return `Open ${basename(selectedPath)} with ${usePlayer ? "TouchPlayer" : "TD"}`;
    // Reflect the TouchPlayer toggle at the point of action — the checkbox
    // lives up in the detail header, easy to forget by the time you launch.
    return `Launch ${basename(selectedPath)}${usePlayer ? " with TouchPlayer" : ""}`;
  })();

  const toggleSessionCard = (path: string) => {
    setExpandedSessionCards((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderSessionActionButton = (item: ListItem, action: SessionAction) => {
    if (action.placement !== "primary") return null;
    if (action.id === "record") return null; // rendered with Thumbnail as one split capture control
    if (action.id === "snapshot") {
      const record = sessionActionModel(item).find((candidate) => candidate.id === "record");
      return (
        <div key="capture" className="session-capture-split" role="group" aria-label="Preview capture">
          <button
            type="button"
            className="small session-capture-button"
            disabled={!action.enabled}
            aria-label="Update thumbnail"
            title="Update thumbnail — capture preview/preview.png and the project icon"
            onClick={(e) => {
              e.stopPropagation();
              selectItem(item);
              runDesktopSessionAction(item, "snapshot");
            }}
          >
            <CameraIcon />
          </button>
          <button
            type="button"
            className="small session-capture-button"
            disabled={!record?.enabled}
            aria-label="Record preview video"
            title="Record preview video — create preview/preview.mp4"
            onClick={(e) => {
              e.stopPropagation();
              selectItem(item);
              runDesktopSessionAction(item, "record");
            }}
          >
            <VideoTapeIcon />
          </button>
        </div>
      );
    }
    if (action.id === "add-to-project") {
      return (
        <button
          key={action.id}
          type="button"
          className={`small ${loadMenuAt && selectedPath === item.path ? "tags-toggle-on" : ""}`}
          aria-haspopup="menu"
          aria-expanded={!!loadMenuAt && selectedPath === item.path}
          title="Add a local, remote, or packaged component to this project"
          onClick={(e) => {
            e.stopPropagation();
            selectItem(item);
            setLoadMenuAt({ x: e.clientX, y: e.clientY });
          }}
        >
          {action.label}
        </button>
      );
    }
    return (
      <button
        key={action.id}
        type="button"
        className={`small${action.id === "relaunch" && item.source === "stale" ? " primary" : ""}${
          action.danger ? " danger" : ""
        }`}
        disabled={!action.enabled}
        onClick={(e) => {
          e.stopPropagation();
          selectItem(item);
          runDesktopSessionAction(item, action.id);
        }}
      >
        {action.label}
      </button>
    );
  };

  const renderSessionCapabilities = (item: ListItem) => {
    const commands = surfaceCommands(item, "session");
    if (!commands.length) return null;
    const groups = new Map<string, FnsToolCommand[]>();
    for (const command of commands) {
      const name = command.builtin ? "TouchDesigner" : canonicalToolName(command.tool);
      groups.set(name, [...(groups.get(name) ?? []), command]);
    }
    return (
      <div className="session-capabilities">
        {[...groups.entries()].map(([name, group]) => (
          <div key={name} className="session-capability-group">
            <div className="session-capability-heading">{name}</div>
            {group.map((command) => (
              <div key={command.key} className="session-capability-row">
                <div className="session-capability-copy">
                  <strong>{withInstance(command.label, command.instance)}</strong>
                  {command.help && <span>{command.help}</span>}
                </div>
                {command.state !== undefined && (
                  <span
                    className={`companion-cmd-state${
                      command.state === true ? " on" : command.state === false ? " off" : ""
                    }`}
                  >
                    {command.state === true
                      ? "ON"
                      : command.state === false
                        ? "OFF"
                        : String(command.state)}
                  </span>
                )}
                <button
                  type="button"
                  className="small"
                  title={command.help || command.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectItem(item);
                    runSurfacedCommand(item, command);
                  }}
                >
                  {command.capability && ["fns.collect", "fns.media-browser", "fns.autosave"].includes(command.capability)
                    ? "Open"
                    : (command.params?.length ?? 0) > 0
                      ? "Set…"
                      : "Run"}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const renderMissingCompanion = (item: ListItem) => {
    if (!bundledUtilityTox || item.source === "stale") return null;
    const dismissKey = companionDismissKey(item.path, item.openPid);
    if (!tourOpen && companionDismissed.has(dismissKey)) return null;
    return (
      <div className="session-card-missing" data-hint="companion-missing">
        <div>
          <strong>No companion in this project.</strong>{" "}
          Drag the utility into its root network for Save, Thumbnail, Preview video, and tool rows.
        </div>
        <div className="session-card-missing-actions">
          <span
            className="companion-drag-tox draggable-tox"
            draggable
            onDragStart={(e) => beginToxDrag(bundledUtilityTox, e)}
            onMouseDown={(e) => {
              if (isMac && e.button === 0) {
                e.preventDefault();
                beginToxDrag(bundledUtilityTox);
              }
            }}
            title="Drag into the root network of this project in TouchDesigner"
          >
            ⠿ TDXLauncherUtility.tox
          </span>
          <button
            type="button"
            className="small"
            onClick={(e) => {
              e.stopPropagation();
              void api.openPath(bundledUtilityTox);
            }}
          >
            Reveal utility
          </button>
          {!companionNudgeOff && (
            <button
              type="button"
              className="small"
              onClick={(e) => {
                e.stopPropagation();
                setCompanionNudgeExpanded((value) => !value);
              }}
            >
              Set it up once {companionNudgeExpanded ? "▴" : "▾"}
            </button>
          )}
          {item.openPid != null && (
            <button
              type="button"
              className="small"
              onClick={(e) => {
                e.stopPropagation();
                setCompanionDismissed((prev) => new Set(prev).add(dismissKey));
              }}
            >
              Dismiss
            </button>
          )}
        </div>
        {companionNudgeExpanded && !companionNudgeOff && (
          <div className="session-card-setup">
            Put the utility in an empty project, save that project somewhere permanent, then choose
            it under TouchDesigner’s <strong>Startup File Mode → Custom File</strong>. Existing .toe
            files still need the utility added once.
          </div>
        )}
      </div>
    );
  };

  const renderSessionCard = (item: ListItem) => {
    const expanded = expandedSessionCards.has(item.path) || (tourOpen && isDemoPath(item.path));
    const actions = sessionActionModel(item);
    const live = item.source !== "stale";
    // Three states, one dot: running, running but its companion went silent
    // (the pulse runs on TD's main thread — TD has likely stopped responding),
    // and ended. Without a companion there is nothing to judge silence by.
    const silentSecs = live ? item.openSilentSecs ?? null : null;
    const state = !live ? "ended" : silentSecs != null ? "silent" : "live";
    const stateTitle =
      state === "ended"
        ? `Ended${item.openEndedAt ? ` ${formatWhen(item.openEndedAt)}` : ""} — relaunch or dismiss`
        : state === "silent"
          ? `Not responding — its companion has been silent for ${
              silentSecs! < 90 ? `${silentSecs} s` : `${Math.round(silentSecs! / 60)} min`
            }. TouchDesigner may be frozen, or busy with a long save.`
          : item.openUtilityAvailable
            ? "Running — companion answering"
            : "Running — no companion, so responsiveness isn't checked";
    const perf = sessPerf[perfKey(item.path)];
    const env = live && item.openUtilityAvailable ? companionEnvStatus(item.path) : null;
    return (
      <article
        key={item.path}
        ref={(element) => {
          if (item.path === selectedPath) selectedFileRef.current = element;
        }}
        tabIndex={0}
        className={`session-card${expanded ? " expanded" : ""}${live ? "" : " stale"}${
          state === "silent" ? " silent" : ""
        }${item.path === selectedPath ? " selected" : ""}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']")) return;
          selectItem(item);
          toggleSessionCard(item.path);
        }}
        onContextMenu={(e) => {
          selectItem(item);
          openCtxMenu(e, sessionMenu(item));
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          selectItem(item);
          toggleSessionCard(item.path);
        }}
      >
        <div className="session-card-head">
          <div className="session-card-thumb">
            <GalleryThumb
              poster={item.heroUrl ?? icons[item.path] ?? null}
              videoPath={galleryVideoFor(item.path)}
              mediaVersion={galleryVideoVersion(item.path)}
              placeholder="TD"
            />
          </div>
          <div className="session-card-title">
            <div className="session-card-name">
              <span
                className={`session-state-dot ${state}`}
                role="img"
                aria-label={stateTitle}
                title={stateTitle}
              />
              {(() => {
                const t = sessionTitle(item);
                return (
                  <>
                    <span className="session-card-name-text" title={item.path}>
                      {t.name}
                    </span>
                    {t.inc != null && (
                      <span
                        className="inc-chip"
                        title={
                          `Increment and Save ${t.inc} — this session is running ` +
                          `${basename(item.path)}. Relaunch opens the project's ` +
                          `canonical file.`
                        }
                      >
                        ·{t.inc}
                      </span>
                    )}
                  </>
                );
              })()}
              {!live && <span className="session-ended-chip">ended</span>}
              {state === "silent" && (
                <span className="session-silent-chip" title={stateTitle}>
                  not responding
                </span>
              )}
              {(item.openInstances?.length ?? 0) > 1 && (
                <span className="inst-chip">×{item.openInstances!.length}</span>
              )}
              {item.openMcpAvailable && item.openEnvoyPort != null && (
                <span className={`mcp-chip ${item.openEnvoyUp ? "up" : "down"}`}>
                  Envoy :{item.openEnvoyPort}
                </span>
              )}
              {live && autosaveChip(item)}
            </div>
            <div className="session-facts">
              {sessionFacts(item).map((fact) => <span key={fact}>{fact}</span>)}
            </div>
            {perfEnabled && perf && (
              <div className="session-facts session-perf">
                {sessionPerfParts(perf.proc ?? null, perf.td ?? null).map((part) => (
                  <span key={part.text} className={part.warn ? "perf-warn" : undefined}>
                    {part.text}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`session-card-expand${expanded ? " is-expanded" : ""}`}
            aria-label={expanded ? "Collapse session details" : "Expand session details"}
            aria-expanded={expanded}
            title={expanded ? "Hide session details" : "Show session details"}
            onClick={(e) => {
              e.stopPropagation();
              selectItem(item);
              toggleSessionCard(item.path);
            }}
          >
            <span className="session-card-expand-chevron" aria-hidden="true" />
          </button>
        </div>

        <div className="session-card-actions">
          {actions.map((action) => renderSessionActionButton(item, action))}
          <button
            type="button"
            className="small session-card-more"
            aria-label={`More actions for ${item.displayName}`}
            onClick={(e) => {
              e.stopPropagation();
              selectItem(item);
              openCtxMenu(e, sessionMenu(item));
            }}
          >
            ⋯
          </button>
        </div>

        {/* A silent companion means a frozen TD, not a missing companion —
            the "drag the utility in" nudge would be the wrong advice. */}
        {expanded && live && state !== "silent" && !item.openUtilityAvailable &&
          renderMissingCompanion(item)}
        {expanded && live && item.openUtilityAvailable && (
          <div className="session-card-details">
            <div className="session-card-companion-meta">
              <strong>Companion</strong>
              {env && (
                <span className={`companion-env-chip${env.ready ? " ok" : " bad"}`} title={env.title}>
                  {env.label}
                </span>
              )}
              {bundledUtilityVersion && item.openUtilityVersion !== bundledUtilityVersion && (
                <button
                  type="button"
                  className="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectItem(item);
                    void updateSessionUtility(item);
                  }}
                >
                  Update companion → v{bundledUtilityVersion}
                </button>
              )}
              {!item.openMcpAvailable && (
                <button
                  type="button"
                  className="small"
                  disabled={embodyBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectItem(item);
                    void addEmbodyToSession(item);
                  }}
                >
                  {embodyBusy ? "Adding Embody…" : "Add Embody"}
                </button>
              )}
              {/* Once the env is ready there is nothing left for it to do. */}
              {!env?.ready && (
                <button
                  type="button"
                  className={`small${env?.envMissing ? " companion-ensure-emphasis" : ""}`}
                  title="Create this project's Python env in one click: TouchDesigner's own TDPyEnvManager builds it (Derivative's disclaimer asks first)"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectItem(item);
                    void ensureProjectEnv(item);
                  }}
                >
                  Set up Python env
                </button>
              )}
            </div>
            {renderSessionCapabilities(item)}
            {(item.openInstances?.length ?? 0) > 1 ? (
              <SessionInstanceList
                instances={item.openInstances!}
                projectName={item.displayName}
                onAction={(win, action) => void runWindowAction(win, action, item.path)}
                onRaiseAll={(pid) => void runSessionWindows(pid, item.path, "raise")}
                onMinimizeAll={(pid) => void runSessionWindows(pid, item.path, "minimize")}
                onFocusInstance={(pid) => void focusOpenSession(pid)}
                onKillInstance={(pid) => killOpenSession(item, pid)}
              />
            ) : (item.openWindows?.length ?? 0) > 0 ? (
              <SessionWindowList
                variant="panel"
                windows={item.openWindows ?? []}
                projectName={item.displayName}
                onAction={(win, action) => void runWindowAction(win, action, item.path)}
                onRaiseAll={() => void runSessionWindows(item.openPid, item.path, "raise")}
                onMinimizeAll={() => void runSessionWindows(item.openPid, item.path, "minimize")}
              />
            ) : null}
          </div>
        )}
      </article>
    );
  };

  // The header Update chip: an update the user hasn't installed or skipped.
  const appUpdatePending = !!appUpdate && appUpdate.version !== config?.skipped_app_version;
  const utilityUpdatePending =
    !!utilityUpdate && utilityUpdate.latestVersion !== config?.skipped_utility_version;
  const updateChipTitle = [
    appUpdatePending ? `TDX Launcher Ultra v${appUpdate!.version} is available` : "",
    utilityUpdatePending ? `Companion TOX v${utilityUpdate!.latestVersion} is available` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="app" onClick={cancelCountdown}>
      <header className="header">
        <div className="brand">
          <h1>TDX Launcher Ultra</h1>
          <span
            className="byline"
            onClick={() => api.openUrl("https://functionstore.xyz")}
            title="Visit functionstore.xyz"
          >
            by Function Store
          </span>
        </div>
        <div className="header-actions" data-tour="header-actions">
          {(appUpdatePending || utilityUpdatePending) && (
            <button
              className="small update-chip"
              onClick={() => setModal(appUpdatePending ? "appUpdate" : "utilityUpdate")}
              title={updateChipTitle}
            >
              Update
            </button>
          )}
          {totalSessionWindows > 0 && (
            <button
              className="small window-switcher-chip"
              aria-label={`Open window switcher for ${totalSessionWindows} TouchDesigner windows`}
              title={`Search and focus any open TouchDesigner window${
                switcherAccel ? ` (${displayAccel(switcherAccel, isMac)})` : ""
              }`}
              onClick={() => {
                void refreshOpen();
                setSwitcherOpen(true);
              }}
            >
              <span aria-hidden="true">▭</span> {totalSessionWindows}
            </button>
          )}
          <button
            data-tour="phone"
            className={`small phone-btn ${phoneServing ? "tags-toggle-on" : ""}`}
            onClick={() => openPhoneRemote()}
            title={
              phoneServing
                ? "Phone Remote is live on your Wi-Fi — show the pairing QR"
                : "Pair a phone over Wi-Fi — a QR opens a touch remote for your sessions"
            }
          >
            📱 Phone
            {phoneServing && <span className="phone-live-dot" aria-label="serving" />}
          </button>
          {/* Header order, left to right: news (Update), live session tools
              (windows, Phone) | app chrome (View, Settings, Help) | Support,
              which is about Function Store rather than the app. */}
          <button
            className={`small header-group-start ${viewMenuAt ? "tags-toggle-on" : ""}`}
            data-ctx-menu-trigger
            aria-expanded={!!viewMenuAt}
            aria-haspopup="menu"
            onClick={(e) => {
              if (viewMenuAt) {
                setViewMenuAt(null);
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              setViewMenuAt({ x: r.left, y: r.bottom + 4 });
            }}
            title="View options — layout, panel rail, theme"
          >
            View
          </button>
          <button className="small" onClick={() => openSettings()}>
            Settings
          </button>
          <button
            className={`small ${helpMenuAt ? "tags-toggle-on" : ""}`}
            data-ctx-menu-trigger
            aria-haspopup="menu"
            aria-expanded={!!helpMenuAt}
            title="Help, tour, setup, and updates"
            onClick={(e) => {
              if (helpMenuAt) {
                setHelpMenuAt(null);
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              setHelpMenuAt({ x: r.left, y: r.bottom + 4 });
            }}
          >
            Help ▾
          </button>
          <button
            className="small header-group-start"
            onClick={() => void api.openUrl(SUPPORT_JOIN_URL)}
            title="Support Function Store on Patreon"
          >
            ♥ Support
          </button>
        </div>
      </header>

      <div className="tabs" data-tour="tabs">
        <button
          className={`tab ${tab === "recent" ? "active" : ""}`}
          onClick={() => setTab("recent")}
        >
          Recent Files
          {tabFilterMark("recent")}
        </button>
        <button
          className={`tab ${tab === "current" ? "active" : ""}`}
          data-hint="tab-current"
          onClick={() => {
            setTab("current");
            void refreshOpen();
          }}
          title="Projects currently open in TouchDesigner"
        >
          Sessions
          {liveSessionCount > 0 ? (
            <span className="tab-badge">{liveSessionCount}</span>
          ) : null}
          {tabFilterMark("current")}
        </button>
        <button
          className={`tab ${tab === "templates" ? "active" : ""}`}
          data-hint="tab-templates"
          onClick={() => setTab("templates")}
        >
          Templates
          {tabFilterMark("templates")}
        </button>
        <button
          className={`tab ${tab === "palette" ? "active" : ""}`}
          data-hint="tab-palette"
          onClick={() => setTab("palette")}
        >
          Palette
          {tabFilterMark("palette")}
        </button>
        {fnsTabShown && (
          <button
            className={`tab ${tab === "fns" ? "active" : ""}`}
            data-hint="tab-fns"
            onClick={() => setTab("fns")}
            title="FNSTools — catalog, installer, and tool settings"
          >
            FNSTools
          </button>
        )}
        {patreonEnabled && (
          <button
            className={`tab ${tab === "patreon" ? "active" : ""}`}
            data-hint="tab-patreon"
            onClick={() => setTab("patreon")}
            title="Import .tox components from Patreon creators you support"
          >
            Patreon
          </button>
        )}
      </div>

      <div className="toolbar" data-tour="toolbar">
        <div className="search-wrap" data-hint="search">
          {searchOpen || search ? (
            <input
              ref={searchRef}
              type="text"
              // Name the scope: the filter applies to THIS tab's list only.
              placeholder={`Search ${TAB_SEARCH_SCOPE[tab]}… (* ?)`}
              title={`Filters the ${TAB_SEARCH_SCOPE[tab]} list only — each tab keeps its own search`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onBlur={() => {
                if (!search) setSearchOpen(false);
              }}
            />
          ) : (
            <button
              className="small"
              title={`Filter the ${TAB_SEARCH_SCOPE[tab]} list (each tab keeps its own search)`}
              onClick={() => {
                setSearchOpen(true);
                showHint("search");
                setTimeout(() => searchRef.current?.focus(), 0);
              }}
            >
              Search…
            </button>
          )}
        </div>
        {tab !== "palette" && tab !== "patreon" && tab !== "fns" && (
          <button
            type="button"
            className={`small${tagsOpen || tagFilter.length > 0 ? " tags-toggle-on" : ""}`}
            data-hint="tool-tags"
            aria-pressed={tagsOpen}
            title="Filter and edit project tags"
            onClick={() => togglePanel("tags")}
          >
            Tags{tagFilter.length > 0 ? ` (${tagFilter.length})` : ""}
          </button>
        )}
        {tab === "current" ? (
          <span className="session-poll-status" title="Sessions refresh automatically">
            <span aria-hidden="true">●</span> live · updates automatically
          </span>
        ) : tab !== "fns" && tab !== "patreon" && (
        <button className="small" onClick={() => void onBrowse()}>
          {tab === "templates"
            ? "Add Templates…"
            : tab === "palette"
              ? "Add Folder…"
              : "Browse…"}
        </button>
        )}
        {tab === "palette" && factoryVersionOptions.length > 0 && (
          <label className="factory-version-label" title="Factory .tox from this TD install (Samples/Palette)">
            Factory
            <select
              className="factory-version-select"
              value={
                factoryVersionOptions.some((v) => v.key === factoryVersionKey)
                  ? factoryVersionKey
                  : factoryVersionOptions[factoryVersionOptions.length - 1]?.key || ""
              }
              onChange={(e) => setFactoryVersion(e.target.value)}
            >
              {factoryVersionOptions.map((v) => (
                <option key={v.key} value={v.key}>
                  {versionNumeric(v.key)}
                </option>
              ))}
            </select>
          </label>
        )}
        {tab === "templates" && versionKeys.length > 0 && (
          <label
            className="factory-version-label"
            data-tour="template-version"
            title="Default TD version for launching templates (Latest = newest non-branched)"
          >
            Version
            <select
              className="factory-version-select"
              value={
                templateDefaultVersion === TEMPLATE_VERSION_LATEST ||
                !versionKeys.includes(templateDefaultVersion)
                  ? TEMPLATE_VERSION_LATEST
                  : templateDefaultVersion
              }
              onChange={(e) => setTemplateVersionPref(e.target.value)}
            >
              <option value={TEMPLATE_VERSION_LATEST}>
                Latest
                {resolveTemplateVersion(TEMPLATE_VERSION_LATEST, versionKeys)
                  ? ` (${versionNumeric(resolveTemplateVersion(TEMPLATE_VERSION_LATEST, versionKeys)!)})`
                  : ""}
              </option>
              {versionKeys
                .slice()
                .reverse()
                .map((key) => (
                  <option key={key} value={key}>
                    {versionNumeric(key)}
                  </option>
                ))}
            </select>
          </label>
        )}
        {tab !== "palette" && tab !== "patreon" && tab !== "fns" && (
        <div className="view-toggle" role="group" aria-label="View mode">
          <button
            type="button"
            className={(config.view_mode || "gallery") === "gallery" ? "active" : ""}
            onClick={() => void updatePref({ view_mode: "gallery" })}
          >
            {tab === "current" ? "Cards" : "Gallery"}
          </button>
          <button
            type="button"
            className={config.view_mode === "list" ? "active" : ""}
            onClick={() => void updatePref({ view_mode: "list" })}
          >
            {tab === "current" ? "Compact" : "List"}
          </button>
        </div>
        )}
        <span className="spacer" />
        {tab === "recent" && (
          <button className="small" onClick={() => setModal("clear")}>
            Clear…
          </button>
        )}
      </div>

      {tagsOpen && tab !== "palette" && tab !== "patreon" && tab !== "fns" && (
      <div className="tag-panel">
        <div className="tag-row">
          <span className="tag-bar-label">Filter</span>
          {allTags.length === 0 ? (
            <span className="tag-hint">No tags yet — select a project and add some below</span>
          ) : (
            allTags.map((tag) => {
              const active = tagFilter.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${active ? "active" : ""}`}
                  onClick={() =>
                    setTagFilter((prev) =>
                      active ? prev.filter((t) => t !== tag) : [...prev, tag],
                    )
                  }
                >
                  {tag}
                </button>
              );
            })
          )}
          {tagFilter.length > 0 && (
            <button type="button" className="small ghost" onClick={() => setTagFilter([])}>
              Clear filter
            </button>
          )}
        </div>
        <div className="tag-row">
          <span className="tag-bar-label">Project</span>
          {!canEditTags ? (
            <span className="tag-hint">Select a project to edit its tags</span>
          ) : (
            <>
              {selectedProjectTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="tag-chip editable"
                  title="Remove tag"
                  onClick={() => void removeTagFromSelected(tag)}
                >
                  {tag}
                  <span className="tag-x">×</span>
                </button>
              ))}
              <form
                className="tag-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addTagToSelected();
                }}
              >
                <input
                  type="text"
                  value={tagDraft}
                  placeholder="Add tag (e.g. show/live)"
                  onChange={(e) => setTagDraft(e.target.value)}
                />
                <button type="submit" className="small" disabled={!normalizeTag(tagDraft)}>
                  Add
                </button>
              </form>
            </>
          )}
        </div>
      </div>
      )}

      <div className="workspace">
        <div className={`content${sideOpen ? " has-side-panel" : ""}`}>
        <div className="left-col">
          <div
            className="browser-pane"
            data-tour="files"
            style={
              tab === "current" || tab === "palette" || tab === "patreon" || tab === "fns"
                ? { flex: "1 1 auto", minHeight: 0 }
                : { height: listPaneHeight, flex: "0 0 auto" }
            }
          >
          {tab === "fns" ? (
            <FnsPanel
              search={search}
              targets={placeTargets}
              companionless={companionlessTargets}
              bundledUtilityTox={bundledUtilityTox}
              onDragUtility={beginToxDrag}
              isMac={isMac}
              products={license?.products ?? []}
              onPlusSignIn={
                license && license.provider !== "disabled" ? () => setModal("membership") : undefined
              }
              onStatus={setStatusMsg}
              onOpenUrl={(url) => void api.openUrl(url)}
              onOpenPath={(path) => void api.openPath(path)}
            />
          ) : tab === "patreon" ? (
            <PatreonPanel
              hasCookie={!!config?.patreon_session_cookie}
              trustAck={!!config?.patreon_trust_ack}
              onDismissTrust={() => void updatePref({ patreon_trust_ack: true })}
              loading={patreonLoading}
              error={patreonError}
              campaigns={patreonCampaigns}
              campaign={patreonCampaign}
              posts={patreonPosts}
              selectedPostId={patreonPostId}
              search={search}
              campaignSort={patreonCampaignSort}
              onCampaignSortChange={(k) => {
                setPatreonCampaignSort(k);
                savePatreonCampaignSort(k);
              }}
              campaignView={patreonCampaignView}
              onCampaignViewChange={(v) => {
                setPatreonCampaignView(v);
                savePatreonCampaignView(v);
              }}
              campaignDateByCampaign={
                patreonCampaignFilesOnly ? patreonLastUploadByCampaign : patreonLatestPostByCampaign
              }
              onRequestCampaignDates={requestPatreonCampaignDates}
              campaignFilesOnly={patreonCampaignFilesOnly}
              onCampaignFilesOnlyChange={(v) => {
                setPatreonCampaignFilesOnly(v);
                savePatreonCampaignFilesOnly(v);
              }}
              postsFilesOnly={patreonPostsFilesOnly}
              onPostsFilesOnlyChange={(v) => {
                setPatreonPostsFilesOnly(v);
                savePatreonPostsFilesOnly(v);
              }}
              postsHideLocked={patreonPostsHideLocked}
              onPostsHideLockedChange={(v) => {
                setPatreonPostsHideLocked(v);
                savePatreonPostsHideLocked(v);
              }}
              onReload={() => void loadPatreonCampaigns()}
              onSelectCampaign={(c) => void selectPatreonCampaign(c)}
              onBackToCampaigns={() => {
                setPatreonCampaign(null);
                setPatreonPosts([]);
                setPatreonPostId(null);
              }}
              onSelectPost={(id) => setPatreonPostId(id)}
              onDragTox={(file, e) => void beginPatreonToxDrag(file, e)}
              onPrimeDragTox={primePatreonToxDrag}
              onOpenToe={(file) => void openPatreonToe(file)}
              onOpenUrl={(url) => void api.openUrl(url)}
              onUnzip={(file) => void unzipPatreonFile(file)}
              onOpenSettings={openSettings}
              onAddCreator={addPatreonCreator}
              onRemoveCreator={(c) => void removePatreonCreator(c)}
              cacheHits={patreonCache?.hits ?? []}
              cacheSearching={patreonCacheSearching}
              cachedCreators={patreonCache?.cachedCreators ?? 0}
              onOpenHit={(hit) => {
                const c = patreonCampaigns.find((x) => x.id === hit.campaignId);
                if (c) void selectPatreonCampaign(c, hit.postId ?? undefined);
              }}
            />
          ) : tab === "palette" ? (
            <div className="palette-pane">
              {toolbox && (
                <ToolboxSection
                  view={toolbox}
                  search={search}
                  selectedPath={selectedPath}
                  selectedRef={selectedFileRef}
                  busyIds={toolboxBusyIds}
                  onSelect={(path) => {
                    cancelCountdown();
                    setSelectedPath(path);
                    setFocus("picker");
                  }}
                  onDragStart={(path, e) => beginToxDrag(path, e)}
                  onFetch={(tool) => void toolboxFetch(tool)}
                  onAddTool={(category) => openToolboxAdd(category)}
                  onEditTool={openToolboxEdit}
                  onMoveTool={(id, dir) => void toolboxRun(() => api.toolboxMoveTool(id, dir))}
                  onAddCategory={() => {
                    setToolboxCatDraft({ original: null, name: "" });
                    setModal("toolboxCategory");
                  }}
                  onEditCategory={(name) => {
                    setToolboxCatDraft({ original: name, name });
                    setModal("toolboxCategory");
                  }}
                  dropCategory={toolboxDropCat}
                  onDropTargetChange={setToolboxDropTarget}
                  onPlace={placeTarget ? placeTox : undefined}
                  placeTitle={placeTarget ? `Place in ${placeTarget.display_name}` : undefined}
                  onToolContextMenu={(tool, e) => {
                    if (tool.resolvedPath && !tool.missing) {
                      cancelCountdown();
                      setSelectedPath(tool.resolvedPath);
                      setFocus("picker");
                    }
                    openCtxMenu(e, toolboxToolMenu(tool));
                  }}
                  onCategoryContextMenu={(name, e) =>
                    openCtxMenu(e, toolboxCategoryMenu(name))
                  }
                  onHeaderContextMenu={(e) => openCtxMenu(e, toolboxHeaderMenu())}
                />
              )}
              {FNS_ENABLED && (
              <FnsToolboxSection
                search={search}
                selectedPath={selectedPath}
                selectedRef={selectedFileRef}
                products={license?.products ?? []}
                onSelect={(path) => {
                  cancelCountdown();
                  setSelectedPath(path);
                  setFocus("picker");
                }}
                onDragStart={(path, e) => beginToxDrag(path, e)}
                onPlace={placeTarget ? placeFnsPackage : undefined}
                placeTitle={placeTarget ? `Place in ${placeTarget.display_name}` : undefined}
                onStatus={setStatusMsg}
              />
              )}
              <PaletteTree
                roots={paletteTree}
                selectedPath={selectedPath}
                focusVersions={focus === "versions"}
                searchActive={!!search.trim()}
                selectedRef={selectedFileRef}
                onSelect={(path, missing) => {
                  if (missing) return;
                  cancelCountdown();
                  setSelectedPath(path);
                  setFocus("picker");
                }}
                onDragStart={(path, e) => beginToxDrag(path, e)}
                onDropTargetChange={(rel) => {
                  paletteDropFolderRef.current = rel;
                }}
                onPlace={placeTarget ? placeTox : undefined}
                placeTitle={placeTarget ? `Place in ${placeTarget.display_name}` : undefined}
                onFileContextMenu={(path, missing, acceptImports, e) => {
                  cancelCountdown();
                  if (!missing) {
                    setSelectedPath(path);
                    setFocus("picker");
                  }
                  openCtxMenu(e, toxFileMenu(path, missing, acceptImports));
                }}
                onFolderContextMenu={(node, e) => openCtxMenu(e, paletteFolderMenu(node))}
                emptyDetail={
                  paletteScan ? (
                    <div className="palette-scan-info">
                      {paletteScan.map((r) => (
                        <div key={`${r.label}:${r.path}`} className="palette-scan-row">
                          <span className="palette-scan-label">{r.label}</span>
                          <code title={r.path}>{r.path}</code>
                          <span
                            className={`palette-scan-status${
                              !r.exists || !r.readable ? " bad" : ""
                            }`}
                          >
                            {!r.exists
                              ? "folder missing"
                              : !r.readable
                                ? "no access — grant Documents permission in System Settings → Privacy & Security → Files & Folders"
                                : `${r.tox_count} .tox`}
                          </span>
                        </div>
                      ))}
                      <div className="palette-scan-hint">
                        Factory palette needs a TD version selected in the toolbar above.
                      </div>
                    </div>
                  ) : null
                }
              />
              <div className="patreon-target palette-place-bar" data-tour="palette-place">
                <label>Load .tox into</label>
                {placeTargets.length === 0 ? (
                  // The tour describes this bar, so show it doing its job.
                  tourOpen ? (
                    <span className="patreon-target-single">{DEMO_SESSION_NAME}</span>
                  ) : (
                    <span className="patreon-target-none">No session running</span>
                  )
                ) : placeTargets.length === 1 ? (
                  <span
                    className="patreon-target-single"
                    title={
                      openProjects.filter((p) => p.alive).length > 1
                        ? `${placeTargets[0].path}\nThe only running session with the companion utility loaded — the others can't receive a .tox until it's dropped into them.`
                        : placeTargets[0].path
                    }
                  >
                    {placeTargets[0].display_name}
                  </span>
                ) : (
                  <select
                    value={placeTarget?.path ?? ""}
                    title={placeTarget?.path}
                    onChange={(e) => setPlaceTargetPath(e.target.value)}
                  >
                    {placeTargets.map((p) => (
                      <option key={p.id} value={p.path}>
                        {p.display_name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="small primary"
                  disabled={!placeTarget || !isToxPath(selectedPath)}
                  title={
                    !placeTarget
                      ? "Needs a running session with the companion utility"
                      : !isToxPath(selectedPath)
                        ? "Select a component above first"
                        : `Load ${basename(selectedPath ?? "")} into ${placeTarget.display_name}`
                  }
                  onClick={() => {
                    if (selectedPath && isToxPath(selectedPath)) placeTox(selectedPath);
                  }}
                >
                  Load{isToxPath(selectedPath) ? ` ${basename(selectedPath ?? "")}` : ""}
                </button>
              </div>
            </div>
          ) : tab === "current" ? (
            <div
              className={`sessions-cards${isGallery ? "" : " compact"}`}
              onContextMenu={(e) => openCtxMenu(e, listPaneMenu())}
            >
              {displayItems.length === 0 ? (
                <div className="sessions-empty">
                  <strong>No TouchDesigner running.</strong>
                  <span>Launch a recent project, or open a .toe outside the launcher.</span>
                </div>
              ) : (
                displayItems.map((item, i) => {
                  // Items arrive live-first (see `items`); the first ended one
                  // opens the Ended group.
                  const firstEnded =
                    item.source === "stale" &&
                    (i === 0 || displayItems[i - 1].source !== "stale");
                  return (
                    <Fragment key={item.path}>
                      {firstEnded && i === 0 && (
                        <div className="sessions-none-live">Nothing running right now.</div>
                      )}
                      {firstEnded && (
                        <div className="sessions-group-head" role="separator">
                          Ended
                          <span>relaunch or dismiss</span>
                        </div>
                      )}
                      {renderSessionCard(item)}
                    </Fragment>
                  );
                })
              )}
            </div>
          ) : isGallery ? (
            <div
              className="panel gallery-grid"
              onContextMenu={(e) => openCtxMenu(e, listPaneMenu())}
            >
              {displayItems.length === 0 ? (
                <div className="empty">No files yet — Browse to add a project.</div>
              ) : (
                displayItems.map((item) => (
                  // Not a <button>: the tile nests real buttons (mcp-chip) and
                  // role="button" chips, and interactive content may not be a
                  // DOM descendant of a button.
                  <div
                    key={item.path}
                    role="button"
                    tabIndex={0}
                    draggable={isToxPath(item.path) && !item.missing}
                    ref={(el) => {
                      if (item.path === selectedPath) selectedFileRef.current = el;
                    }}
                    className={[
                      "gallery-card",
                      item.path === selectedPath ? "selected" : "",
                      item.path === selectedPath && focus === "versions" ? "focus-version" : "",
                      item.missing ? "missing" : "",
                      isToxPath(item.path) ? "draggable-tox" : "",
                      item.source === "stale" ? "session-stale" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => selectItem(item)}
                    onDoubleClick={() => {
                      if (!item.missing && !isToxPath(item.path)) void doLaunch(true);
                    }}
                    onDragStart={(e) => beginToxDrag(item.path, e)}
                    onContextMenu={(e) => {
                      selectItem(item);
                      openCtxMenu(e, fileItemMenu(item));
                    }}
                    title={
                      item.isDefault
                        ? "Launch TD with default startup"
                        : isToxPath(item.path)
                          ? `${item.path}\nDrag into a TouchDesigner network`
                          : item.path
                    }
                  >
                    <GalleryThumb
                      poster={item.heroUrl ?? icons[item.path] ?? null}
                      videoPath={galleryVideoFor(item.path)}
                      mediaVersion={galleryVideoVersion(item.path)}
                      placeholder={
                        item.isDefault ? "+" : isToxPath(item.path) ? "TOX" : "TD"
                      }
                    />
                    <div className="gallery-name">
                      {tab === "templates" && (() => {
                        // The Default entry occupies slot 1 — Ctrl+1 launches it.
                        const slot = templateItems.findIndex((t) => t.path === item.path) + 1;
                        return slot >= 1 && slot <= 9 ? (
                          <span
                            className="slot-chip"
                            title={`${mod}+${slot} launches this template from anywhere in the app`}
                          >
                            {slot}
                          </span>
                        ) : null;
                      })()}
                      <span className="gallery-name-text">{item.displayName}</span>
                      {(item.familyCount ?? 0) >= 2 && (
                        <span
                          role="button"
                          className="family-chip"
                          title={`${item.familyCount} versions of this project — increments, backups, crash autosaves`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.familyKey) openVersionsDrawer(item.familyKey);
                          }}
                        >
                          ⑂ {item.familyCount}
                        </span>
                      )}
                      {item.familyCrash && (
                        <span
                          role="button"
                          className="family-chip crash"
                          title="A crash autosave newer than the project head exists — open versions"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.familyKey) openVersionsDrawer(item.familyKey);
                          }}
                        >
                          ⚠
                        </span>
                      )}
                      {(item.openInstances?.length ?? 0) > 1 && (
                        <span
                          className="inst-chip"
                          title={`The same project file is open in ${
                            item.openInstances!.length
                          } TouchDesigner processes. They share this project's files, so the last save wins — select the session to focus or kill each one.`}
                        >
                          ×{item.openInstances!.length}
                        </span>
                      )}
                      {item.openMcpAvailable && item.openEnvoyPort != null && (
                        <button
                          type="button"
                          className={`mcp-chip ${item.openEnvoyUp ? "up" : "down"}`}
                          title={
                            item.openEnvoyUp
                              ? `Envoy up on :${item.openEnvoyPort} — open MCP`
                              : `Envoy port :${item.openEnvoyPort} not responding — open MCP`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            openMcpForSession(item);
                          }}
                        >
                          MCP
                        </button>
                      )}
                      {autosaveChip(item)}
                    </div>
                    {/* Passive hint, not the launch target: Launch always fires
                        the head — this only points at where the user last was. */}
                    {item.familyLastOpened && (
                      <div
                        className="gallery-open-meta family-hint"
                        title={`You last opened ${basename(item.familyLastOpened)} — click for all versions`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (item.familyKey) openVersionsDrawer(item.familyKey);
                        }}
                      >
                        last opened {basename(item.familyLastOpened)}
                      </div>
                    )}
                    {/* Session actions live in the session panel now — five ghost
                        buttons on top of a hover-playing clip was too much. */}
                    {!!item.tags?.length && (
                      <div className="gallery-tags">
                        {item.tags.slice(0, 3).map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : (
          <div
            className={`panel file-list ${config.show_icons ? "with-icons" : ""}`}
            style={{ ["--name-ch" as string]: String(nameColCh) }}
            onContextMenu={(e) => openCtxMenu(e, listPaneMenu())}
          >
            {displayItems.length === 0 ? (
              <div className="empty">No files yet — Browse to add a project.</div>
            ) : (
              displayItems.map((item) => {
                const canRemove =
                  !item.isDefault &&
                  !(item.source === "td" && platform !== "windows");
                return (
                  <Fragment key={item.path}>
                  <div
                    draggable={isToxPath(item.path) && !item.missing}
                    ref={(el) => {
                      if (item.path === selectedPath) selectedFileRef.current = el;
                    }}
                    className={[
                      "file-row",
                      item.path === selectedPath ? "selected" : "",
                      item.path === selectedPath && focus === "versions" ? "focus-version" : "",
                      item.missing ? "missing" : "",
                      isToxPath(item.path) ? "draggable-tox" : "",
                      item.source === "active"
                        ? "source-active"
                        : item.source === "td" || item.source === "process"
                          ? "source-td"
                          : item.source === "launcher"
                            ? "source-launcher"
                            : "",
                      item.source === "stale" ? "session-stale" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => selectItem(item)}
                    onDoubleClick={() => {
                      if (!item.missing && !isToxPath(item.path)) void doLaunch(true);
                    }}
                    onDragStart={(e) => beginToxDrag(item.path, e)}
                    onContextMenu={(e) => {
                      selectItem(item);
                      openCtxMenu(e, fileItemMenu(item));
                    }}
                    title={
                      item.isDefault
                        ? "Launch TD with default startup"
                        : isToxPath(item.path)
                          ? `${item.path}\nDrag into a TouchDesigner network`
                          : item.path
                    }
                  >
                    {config.show_icons && (
                      item.heroUrl ?? icons[item.path] ? (
                        <img className="icon" src={item.heroUrl ?? icons[item.path]} alt="" />
                      ) : (
                        <div className="icon placeholder">TD</div>
                      )
                    )}
                    <span className="col-name">
                      {tab === "templates" && (() => {
                        // Anchor for the fixed Ctrl+1–9 bindings — same filtered
                        // list the shortcut indexes, so the number always matches
                        // (the Default entry occupies slot 1).
                        const slot = templateItems.findIndex((t) => t.path === item.path) + 1;
                        return slot >= 1 && slot <= 9 ? (
                          <span
                            className="slot-chip"
                            title={`${mod}+${slot} launches this template from anywhere in the app`}
                          >
                            {slot}
                          </span>
                        ) : null;
                      })()}
                      <span className="col-name-text">
                        {item.displayName}
                        {item.missing ? " (missing)" : ""}
                      </span>
                      {(item.familyCount ?? 0) >= 2 && (
                        <span
                          role="button"
                          className="family-chip"
                          title={`${item.familyCount} versions of this project — increments, backups, crash autosaves${
                            item.familyLastOpened
                              ? `\nYou last opened ${basename(item.familyLastOpened)}`
                              : ""
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.familyKey) openVersionsDrawer(item.familyKey);
                          }}
                        >
                          ⑂ {item.familyCount}
                        </span>
                      )}
                      {item.familyCrash && (
                        <span
                          role="button"
                          className="family-chip crash"
                          title="A crash autosave newer than the project head exists — open versions"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.familyKey) openVersionsDrawer(item.familyKey);
                          }}
                        >
                          ⚠
                        </span>
                      )}
                      {!item.isDefault && tab === "templates" && (
                        <>
                          <button
                            className="ghost small"
                            title="Move up"
                            onClick={() =>
                              void api
                                .moveTemplate(item.path, "up")
                                .then(() => refreshLists(undefined, { rediscover: false }))
                            }
                          >
                            ▲
                          </button>
                          <button
                            className="ghost small"
                            title="Move down"
                            onClick={() =>
                              void api
                                .moveTemplate(item.path, "down")
                                .then(() => refreshLists(undefined, { rediscover: false }))
                            }
                          >
                            ▼
                          </button>
                        </>
                      )}
                      {canRemove && (
                        <button
                          className="ghost small"
                          title="Remove"
                          onClick={() => void onRemove(item.path)}
                        >
                          ×
                        </button>
                      )}
                    </span>
                    <span className="col-size">
                      {item.isDefault || item.missing
                        ? ""
                        : formatBytes(meta[item.path]?.bytes)}
                    </span>
                    <span className="col-date">
                      {item.isDefault ? "" : item.missing ? "" : item.mtime || ""}
                    </span>
                    <span className="col-path">
                      {item.isDefault
                        ? "Opens TD with default startup"
                        : item.path}
                    </span>
                  </div>
                  </Fragment>
                );
              })
            )}
          </div>
          )}
          </div>


          {tab !== "current" && tab !== "palette" && tab !== "patreon" && tab !== "fns" && (
            <>
          <SplitHandle
            axis="y"
            title="Drag to resize file list"
            onDelta={(d) => setListPaneHeight((h) => h + d)}
          />

          <div className="version-pane" data-tour="versions">
          <div className={`panel version-panel ${usePlayer ? "player" : ""}`}>
            {!selectedPath ? (
              // The tour spotlights this pane, so give it something to show
              // instead of the "pick a file" hint. Display only — the tour's
              // backdrop means none of it is reachable.
              tourOpen ? (
                <>
                  <div className="version-header">
                    <div>
                      <div className="file-label">AuroraSet.toe</div>
                      <div className="req">
                        Requires {demoVersionKeys[1] ?? demoVersionKeys[0] ?? "2025.30060"}
                      </div>
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={false} readOnly />
                      Use TouchPlayer
                    </label>
                  </div>
                  <VersionList
                    keys={demoVersionKeys}
                    selected={demoVersionKeys[1] ?? demoVersionKeys[0] ?? null}
                    best={demoVersionKeys[1] ?? demoVersionKeys[0] ?? null}
                    focus="versions"
                    onSelect={() => {}}
                  />
                </>
              ) : (
                <div className="hint">Select a file above to see version info</div>
              )
            ) : selectedPath === DEFAULT_TEMPLATE ? (
              <>
                <div className="version-header">
                  <span className="req">
                    Launch {usePlayer ? "TouchPlayer" : "TouchDesigner"} with default startup
                  </span>
                  <label className="check">
                    <input type="checkbox" checked={usePlayer} onChange={(e) => setUsePlayer(e.target.checked)} />
                    Use TouchPlayer
                  </label>
                </div>
                <VersionList
                  keys={versionKeys}
                  selected={selectedVersion}
                  focus={focus}
                  onSelect={setSelectedVersion}
                />
              </>
            ) : isToxPath(selectedPath) ? (
              <>
                <div className="version-header">
                  <div>
                    <div className="file-label">Palette: {basename(selectedPath)}</div>
                    <div className="req">
                      {selectedPalette
                        ? `${selectedPalette.root_label}${
                            selectedPalette.folder ? ` / ${selectedPalette.folder}` : ""
                          }`
                        : "Component (.tox)"}
                    </div>
                    <div className="tag-hint" style={{ marginTop: 6 }}>
                      Drag this component into a TouchDesigner network. Reveal / copy path as
                      fallbacks.
                    </div>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={usePlayer}
                      onChange={(e) => setUsePlayer(e.target.checked)}
                    />
                    Use TouchPlayer
                  </label>
                </div>
                <div className="media-strip-actions" style={{ padding: "0 8px 8px", gap: 6, display: "flex" }}>
                  <button
                    type="button"
                    className="small"
                    onClick={() => selectedPath && void api.openPath(selectedPath)}
                  >
                    Reveal
                  </button>
                  <button
                    type="button"
                    className="small"
                    onClick={() => {
                      if (!selectedPath) return;
                      void navigator.clipboard.writeText(selectedPath).then(
                        () => setStatusMsg("Path copied"),
                        () => setStatusMsg(selectedPath),
                      );
                    }}
                  >
                    Copy path
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={toolboxHasLocal(selectedPath)}
                    title={
                      toolboxHasLocal(selectedPath)
                        ? "Already pinned in the Toolbox"
                        : "Pin this component in the palette Toolbox"
                    }
                    onClick={() => {
                      if (!selectedPath) return;
                      openToolboxAdd("", {
                        kind: "local",
                        source: selectedPath,
                        label: basename(selectedPath).replace(/\.tox$/i, ""),
                      });
                    }}
                  >
                    {toolboxHasLocal(selectedPath) ? "★ In Toolbox" : "☆ Add to Toolbox"}
                  </button>
                </div>
                <VersionList
                  keys={versionKeys}
                  selected={selectedVersion}
                  focus={focus}
                  onSelect={setSelectedVersion}
                />
              </>
            ) : analyzing ? (
              <div className="hint">Loading build info…</div>
            ) : (
              <>
                <div className="version-header">
                  <div>
                    <div className="file-label">File: {basename(selectedPath)}</div>
                    {buildInfo ? (
                      <div className={`req ${!versionInstalled ? "missing" : ""}`}>
                        Required: {displayBuildInfo(buildInfo, usePlayer)}
                        {!versionInstalled ? " (NOT INSTALLED)" : ""}
                      </div>
                    ) : (
                      <div className="req">Could not detect required TD version — pick manually:</div>
                    )}
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={usePlayer} onChange={(e) => setUsePlayer(e.target.checked)} />
                    Use TouchPlayer
                  </label>
                </div>

                {mediaStrip}

                {!versionInstalled && buildInfo && (
                  <div className="download-box">
                    <div>Download {displayBuildInfo(buildInfo, usePlayer)} from Derivative</div>
                    {downloadProgress !== null && (
                      <div className="progress">
                        <span style={{ width: `${Math.round(downloadProgress * 100)}%` }} />
                      </div>
                    )}
                    <button onClick={() => void onDownload()} disabled={downloadProgress !== null && downloadProgress < 1}>
                      {downloadProgress !== null && downloadProgress < 1
                        ? `Downloading ${Math.round(downloadProgress * 100)}%`
                        : "Download"}
                    </button>
                  </div>
                )}

                <VersionList
                  keys={versionKeys}
                  selected={selectedVersion}
                  focus={focus}
                  best={buildInfo}
                  layoutKey={versionInstalled ? "ok" : "missing"}
                  onSelect={setSelectedVersion}
                />
              </>
            )}
          </div>
          </div>
            </>
          )}
        </div>

        {sideOpen && (
          <>
            <SplitHandle
              axis="x"
              title="Drag to resize side panel"
              onDelta={(d) => setSidePaneWidth((w) => w - d)}
            />
            <div className="right-stack" style={{ width: sidePaneWidth }}>
              {tab === "patreon" ? (
                <PatreonDetail
                  post={patreonSelectedPost}
                  loading={patreonDetailLoading}
                  debug={
                    patreonPostId ? patreonDetailCache[patreonPostId]?.debug ?? null : null
                  }
                  sessions={openItems}
                  target={patreonTarget ?? openItems[0] ?? null}
                  busyFileUrl={patreonBusyFile}
                  zipExtractByUrl={patreonZipExtractByUrl}
                  onSelectTarget={(item) => setPatreonTarget(item)}
                  onLoad={(file, t) => void loadPatreonToxIntoSession(file, t)}
                  onOpenToe={(file) => void openPatreonToe(file)}
                  onUnzip={(file) => void unzipPatreonFile(file)}
                  onOpenExtractedFolder={(dir) => void openExtractedFolder(dir)}
                  onLoadLocal={(file, t) => void loadLocalToxIntoSession(file, t)}
                  onOpenLocalToe={(file) => void openLocalToe(file)}
                  onFileMenu={(file, e) => openCtxMenu(e, patreonToxMenu(file))}
                  onDragTox={(file, e) => void beginPatreonToxDrag(file, e)}
                  onPrimeDragTox={primePatreonToxDrag}
                  localToxByUrl={patreonLocalToxByUrl}
                  onOpenUrl={(url) => void api.openUrl(url)}
                />
              ) : (
                <>
              {config.show_readme && (
                <div className="right-col">
                  <div className="readme-header">
                    <strong>Project Info</strong>
                    {selectedPath && selectedPath !== DEFAULT_TEMPLATE && (
                      <button className="small" onClick={() => setReadmeEdit((v) => !v)}>
                        {readmeEdit ? "View" : "Edit"}
                      </button>
                    )}
                  </div>
                  <div className="readme-status">
                    {!selectedPath || selectedPath === DEFAULT_TEMPLATE
                      ? "Select a file…"
                      : readme.path
                        ? basename(readme.path)
                        : "No README.md — edit to create one"}
                    {readme.summary ? ` — ${plainSummary(readme.summary)}` : ""}
                  </div>
                  <div
                    className={`readme-body ${readmeEdit ? "is-editing" : "is-viewing"}`}
                    onDoubleClick={() =>
                      selectedPath &&
                      selectedPath !== DEFAULT_TEMPLATE &&
                      !readmeEdit &&
                      setReadmeEdit(true)
                    }
                  >
                    {readmeEdit ? (
                      <textarea
                        value={readmeDraft}
                        onChange={(e) => setReadmeDraft(e.target.value)}
                        spellCheck={false}
                      />
                    ) : readme.content ? (
                      <div className="markdown">
                        <ReactMarkdown>{readme.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="hint">Double-click or press Edit to add a README</span>
                    )}
                  </div>
                  <div className="readme-footer">
                    <button
                      className="small"
                      disabled={!readmeEdit || !selectedPath}
                      onClick={() => {
                        if (!selectedPath) return;
                        void api.saveReadme(selectedPath, readmeDraft).then((p) => {
                          setReadme((r) => ({ ...r, path: p, content: readmeDraft }));
                          setReadmeEdit(false);
                        });
                      }}
                    >
                      Save
                    </button>
                    <button
                      className="small"
                      disabled={!readme.content}
                      onClick={() => {
                        void api.writeTempHtml(readme.content).then((p) => api.openUrl(`file:///${p.replace(/\\/g, "/")}`));
                      }}
                    >
                      View
                    </button>
                  </div>
                </div>
              )}

              {gitOpen && (
                <GitPanel
                  projectPath={folderContextPath}
                  canUse={canUseFolderTools}
                  contextLabel={folderContextLabel}
                  githubUser={config.github_username || ""}
                  hasToken={!!config.github_token}
                  onStatusMsg={setStatusMsg}
                  onOpenSettings={openSettings}
                  onOpenMenu={openCtxMenu}
                />
              )}

              {backupOpen && (
                <BackupPanel
                  projectPath={folderContextPath}
                  canUse={canUseFolderTools}
                  contextLabel={folderContextLabel}
                  backupRoot={config.backup_root || ""}
                  cloudBackupRoot={config.cloud_backup_root ?? "TDXLU-Backups"}
                  onStatusMsg={setStatusMsg}
                  onOpenSettings={openSettings}
                  onBackupRootChange={(root) => {
                    void updatePref({ backup_root: root });
                  }}
                  excludeGlobs={config.backup_exclude || ""}
                  onAddExclude={addBackupExclude}
                  onOpenMenu={openCtxMenu}
                  respectGitignore={!!config.backup_respect_gitignore}
                  onRespectGitignoreChange={(v) =>
                    void updatePref({ backup_respect_gitignore: v })
                  }
                />
              )}

              {watchOpen && (
                <WatchPanel
                  projectPath={selectedPath}
                  versionKey={selectedVersion}
                  usePlayer={usePlayer}
                  canUse={canEditTags && !!selectedVersion}
                  tcpPort={config.watch_tcp_port || 11999}
                  onStatusMsg={setStatusMsg}
                  onOpenSettings={openSettings}
                />
              )}

              {controlOpen && tab === "current" && (
                <ControlPanel
                  projectPath={selectedPath}
                  canUse={
                    !!selectedPath &&
                    !!items.find((i) => i.path === selectedPath)?.openUtilityAvailable
                  }
                  onStatusMsg={setStatusMsg}
                  onOpenBrowser={() => {
                    void api
                      .openControlServer()
                      .then((url) =>
                        api
                          .openUrl(url)
                          .then(() => setStatusMsg(`Control page: ${url.split("#")[0]}`)),
                      )
                      .catch((e) => setStatusMsg(String(e)));
                  }}
                  onPhoneRemote={openPhoneRemote}
                />
              )}

              {mediaOpen && tab === "current" && (
                <MediaPanel
                  sessionPath={selectedPath}
                  canUse={
                    !!openProjects.find((p) => p.path === selectedPath)
                      ?.utility_available
                  }
                  onStatusMsg={setStatusMsg}
                  commandKeys={mediaCommandKeys}
                />
              )}

              {mcpOpen && (
                <McpPanel
                  projectPath={selectedPath}
                  versionKey={selectedVersion}
                  usePlayer={usePlayer}
                  canUse={!!selectedPath && selectedPath !== DEFAULT_TEMPLATE}
                  onStatusMsg={setStatusMsg}
                  onLaunchToe={(toePath) => {
                    void (async () => {
                      if (!selectedVersion) return;
                      try {
                        if (toePath !== selectedPath) setSelectedPath(toePath);
                        await api.launchProject(
                          toePath,
                          selectedVersion,
                          usePlayer,
                          true,
                        );
                      } catch (e) {
                        setStatusMsg(String(e));
                      }
                    })();
                  }}
                />
              )}
                </>
              )}
            </div>
          </>
        )}
        </div>

      {railPanels.length > 0 && (
        <aside
          className={`panel-rail ${panelRailCollapsed ? "is-collapsed" : ""}`}
          data-tour="tools"
          role="toolbar"
          aria-label="Project inspector dock"
          aria-orientation="vertical"
        >
          {railPanels.map((panel) => {
            const open = panelOpen(panel.id);
            const active = open || (panel.id === "tags" && tagFilter.length > 0);
            const shortcut = accelHint(panel.action);
            return (
              <button
                key={panel.id}
                type="button"
                className={`panel-rail-button ${active ? "active" : ""}`}
                data-hint={panel.hint}
                aria-label={`${panel.label} panel`}
                aria-pressed={open}
                title={`${panel.title}${
                  shortcut ? ` (${shortcut})` : ""
                } — Ctrl/Cmd-click stacks; right-click for options`}
                onClick={(e) => {
                  if (!open && panel.hint) showHint(panel.hint);
                  togglePanel(panel.id, e.ctrlKey || e.metaKey);
                }}
                onContextMenu={(e) => openCtxMenu(e, panelContextMenu(panel))}
              >
                <span className="panel-rail-icon" aria-hidden="true">
                  {panel.icon}
                </span>
                {!panelRailCollapsed && (
                  <span className="panel-rail-label">{panel.label}</span>
                )}
                {panelRailCollapsed && (
                  <span className="panel-rail-tooltip" aria-hidden="true">
                    {panel.label}
                  </span>
                )}
              </button>
            );
          })}
        </aside>
      )}
      </div>

      {tab !== "patreon" && tab !== "palette" && tab !== "fns" && (
        <div className="footer">
          <button
            className={`primary launch${selectedStale ? " launch-stale" : selectedRunning ? " launch-running" : ""}`}
            title="Right-click: start TouchDesigner with its default startup file"
            data-tour="launch"
            // aria-disabled, not disabled: a disabled button receives no mouse
            // events at all, and the right-click below must work with nothing
            // launchable selected too. onClick enforces the block instead.
            aria-disabled={launchBlocked}
            onContextMenu={(e) => {
              // Right-click starts a fresh TouchDesigner with its default
              // startup file, whatever is selected (Templates' Default entry,
              // and Ctrl+1).
              e.preventDefault();
              launchDefaultStartup();
            }}
            onClick={() => {
              if (launchBlocked) return;
              // Ended session: relaunch directly (it knows its build) instead
              // of routing through the fresh-launch analysis flow.
              if (selectedStale && selectedItem) void relaunchStaleSession(selectedItem);
              else void doLaunch(true);
            }}
          >
            {launchLabel}
          </button>
        </div>
      )}

      {statusMsg && (
        <div className="hint" onClick={() => setStatusMsg("")}>
          {statusMsg}
        </div>
      )}

      {activeOps.length > 0 && (
        <div className="op-tray">
          {activeOps.map((op) => (
            <div key={op.id} className="op-chip" title={op.detail || op.label}>
              <span className="op-spinner" aria-hidden />
              <span className="op-chip-text">
                <span className="op-chip-label">{op.label}</span>
                {op.detail && <span className="op-chip-detail">{op.detail}</span>}
              </span>
              <span className={`op-bar${op.fraction === null ? " indeterminate" : ""}`}>
                <span
                  className="op-bar-fill"
                  style={
                    op.fraction === null
                      ? undefined
                      : { width: `${Math.round(op.fraction * 100)}%` }
                  }
                />
              </span>
            </div>
          ))}
        </div>
      )}

      {modal === "settings" && (
        <Modal
          title="Settings"
          className="modal-settings"
          wide
          onClose={() => setModal(null)}
          footer={
            <div className="actions">
              <button
                className="primary"
                onClick={async () => {
                  const prefs: Partial<AppConfig> = {
                    max_recent_files: maxRecentDraft,
                    patreon_download_root: patreonDownloadRootDraft.trim(),
                    backup_root: backupRootDraft.trim(),
                    cloud_backup_root: cloudRootDraft,
                    backup_exclude: backupExcludeDraft,
                    backup_include: backupIncludeDraft,
                    backup_max_file_mb: backupMaxMbDraft,
                    palette_extra_folders: paletteExtraDraft,
                  };
                  if (githubUserDraft.trim() || githubTokenDraft.trim()) {
                    prefs.github_username = githubUserDraft.trim() || config.github_username;
                    if (githubTokenDraft.trim()) prefs.github_token = githubTokenDraft.trim();
                  }
                  if (smtpPasswordDraft.trim()) {
                    prefs.alert_smtp_password = smtpPasswordDraft.trim();
                  }
                  await updatePref(prefs);
                  setModal(null);
                }}
              >
                Save
              </button>
            </div>
          }
        >
          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Settings sections">
              <input
                type="search"
                className="settings-search"
                placeholder="Search settings…"
                value={settingsQuery}
                autoFocus
                onChange={(e) => setSettingsQuery(e.target.value)}
              />
              {SETTINGS_CATS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={
                    "settings-nav-item" +
                    (!settingsQuery.trim() && settingsCat === c.id ? " active" : "")
                  }
                  onClick={() => {
                    setSettingsQuery("");
                    setSettingsCat(c.id);
                  }}
                >
                  {c.label}
                </button>
              ))}
            </nav>
            <div className="settings-pane">
              {settingsQuery.trim() && (
                <p className="help-tip settings-results">
                  {settingsShown.size
                    ? `${settingsShown.size} section${settingsShown.size === 1 ? "" : "s"} match “${settingsQuery.trim()}”`
                    : `Nothing matches “${settingsQuery.trim()}”. Try a control's name — “token”, “glob”, “hotkey”, “smtp”.`}
                </p>
              )}
              <fieldset
                className="settings-group"
                data-settings-section="appearance"
                hidden={!settingsShown.has("appearance")}
              >
                <legend>Theme &amp; view</legend>
                <div className="field">
                  <label>Color theme</label>
                  <select
                    value={config.theme || "classic"}
                    onChange={(e) => void updatePref({ theme: e.target.value })}
                  >
                    {THEMES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>View mode</label>
                  <div className="view-toggle" role="group" aria-label="View mode">
                    <button
                      type="button"
                      className={(config.view_mode || "gallery") === "gallery" ? "active" : ""}
                      onClick={() => void updatePref({ view_mode: "gallery" })}
                    >
                      Gallery
                    </button>
                    <button
                      type="button"
                      className={config.view_mode === "list" ? "active" : ""}
                      onClick={() => void updatePref({ view_mode: "list" })}
                    >
                      List
                    </button>
                  </div>
                </div>
                {FNS_ENABLED && (
                  <label
                    className="check"
                    title="The Palette tab's FNSTools shelf stays either way"
                  >
                    <input
                      type="checkbox"
                      checked={config.show_fns_tab !== false}
                      onChange={(e) => void updatePref({ show_fns_tab: e.target.checked })}
                    />
                    Show the FNSTools tab
                  </label>
                )}
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="tray"
                hidden={!settingsShown.has("tray")}
              >
                <legend>Tray &amp; login</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.show_tray !== false}
                    onChange={(e) => void updatePref({ show_tray: e.target.checked })}
                  />
                  Show system tray icon (restart to apply
                  <button
                    type="button"
                    className="linkish"
                    onClick={(e) => {
                      e.preventDefault();
                      void api.restartApp();
                    }}
                  >
                    restart now
                  </button>
                  )
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.close_to_tray !== false}
                    onChange={(e) => void updatePref({ close_to_tray: e.target.checked })}
                    disabled={config.show_tray === false}
                  />
                  Close window to tray instead of quitting
                </label>
                <label
                  className="check"
                  title={
                    autostartEnabled === null
                      ? "Autostart registration unavailable in this build"
                      : "Register TDXLU with the OS to launch when you log in. It starts minimized to the tray (when the tray icon is enabled)."
                  }
                >
                  <input
                    type="checkbox"
                    checked={!!autostartEnabled}
                    disabled={autostartEnabled === null}
                    onChange={async (e) => {
                      try {
                        if (e.target.checked) await enableAutostart();
                        else await disableAutostart();
                        const on = await autostartIsEnabled();
                        setAutostartEnabled(on);
                        setStatusMsg(on ? "TDXLU will start at login" : "Start at login disabled");
                      } catch (err) {
                        setStatusMsg(`Autostart: ${err}`);
                      }
                    }}
                  />
                  Start TDXLU when you log in
                  {config.show_tray !== false ? " (minimized to tray)" : ""}
                </label>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="opening"
                hidden={!settingsShown.has("opening")}
              >
                <legend>When TDXLU opens</legend>
                <div className="field">
                  <label>Start on</label>
                  <select
                    value={config.startup_tab ?? "recent"}
                    onChange={(e) => void updatePref({ startup_tab: e.target.value })}
                  >
                    <option value="recent">Recent Files</option>
                    <option value="current">Sessions</option>
                    <option value="templates">Templates</option>
                    <option value="palette">Palette</option>
                    {fnsTabShown && <option value="fns">FNSTools</option>}
                    {patreonEnabled && <option value="patreon">Patreon</option>}
                    <option value="last">The tab it was left on</option>
                  </select>
                  <span className="help-tip">
                    Only when the app opens by itself. Opening a .toe from Finder or Explorer
                    still goes straight to launching it.
                  </span>
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="fileopen"
                hidden={!settingsShown.has("fileopen")}
              >
                <legend>Opening a project from {isMac ? "Finder" : "Explorer"}</legend>
                <div className="field">
                  <label>When the project&rsquo;s TD build isn&rsquo;t installed</label>
                  <select
                    value={config.cli_fallback_version || CLI_FALLBACK_UNSET}
                    onChange={(e) => void updatePref({ cli_fallback_version: e.target.value })}
                  >
                    <option value={CLI_FALLBACK_UNSET}>
                      Decide the next time it happens
                    </option>
                    <option value={CLI_FALLBACK_LATEST}>
                      Open with the latest build
                      {newestMainlineKey(versionKeys)
                        ? ` (${versionNumeric(newestMainlineKey(versionKeys)!)})`
                        : ""}
                    </option>
                    <option value={CLI_FALLBACK_CLOSEST}>Open with the closest build</option>
                    <option value={CLI_FALLBACK_ASK}>Always let me pick — no auto-launch</option>
                    {mainlineVersionKeys(versionKeys)
                      .slice()
                      .reverse()
                      .map((key) => (
                        <option key={key} value={key}>
                          Always open with {versionNumeric(key)}
                        </option>
                      ))}
                  </select>
                </div>
                <p className="help-tip">
                  Only affects the 5-second countdown when a project arrives from{" "}
                  {isMac ? "Finder" : "Explorer"} — the Launch button always lets you pick.
                  Left undecided, the first project that needs a missing build asks once
                  and remembers the answer.
                  A build the file wasn&rsquo;t saved with may prompt to upgrade it, and one
                  from an earlier release year cannot open it at all, which is why
                  &ldquo;closest&rdquo; prefers a newer build over an older one.
                </p>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="launch"
                hidden={!settingsShown.has("launch")}
              >
                <legend>After launching a project</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.switch_to_current_after_launch !== false}
                    onChange={(e) =>
                      void updatePref({ switch_to_current_after_launch: e.target.checked })
                    }
                  />
                  Switch to Sessions tab after launching a project
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!config.hide_after_launch}
                    disabled={!!config.quit_after_launch}
                    onChange={(e) => void updatePref({ hide_after_launch: e.target.checked })}
                  />
                  Hide launcher to tray after launching a project
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!config.quit_after_launch}
                    onChange={(e) => void updatePref({ quit_after_launch: e.target.checked })}
                  />
                  Quit after launching a project
                </label>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="updates"
                hidden={!settingsShown.has("updates")}
              >
                <legend>Updates</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.auto_update_check !== false}
                    onChange={(e) => void updatePref({ auto_update_check: e.target.checked })}
                  />
                  Check for updates automatically, once a day
                </label>
                <div className="field" style={{ marginLeft: 24 }}>
                  <span className="help-tip">
                    Never while a TouchDesigner session is running. A found update waits in the
                    header&rsquo;s <strong>Update</strong> chip. Use{" "}
                    <strong>About → Check for updates</strong> when you want to look; a manual
                    check always runs, and always shows a version you skipped.
                  </span>
                  {(config.skipped_app_version || config.skipped_utility_version) && (
                    <div className="field">
                      <span className="help-tip">Skipped — not announced automatically:</span>
                      {config.skipped_app_version && (
                        <span className="help-tip">
                          App v{config.skipped_app_version}{" "}
                          <button
                            type="button"
                            className="linkish"
                            onClick={() => void updatePref({ skipped_app_version: "" })}
                          >
                            (announce it again)
                          </button>
                        </span>
                      )}
                      {config.skipped_utility_version && (
                        <span className="help-tip">
                          Companion TOX v{config.skipped_utility_version}{" "}
                          <button
                            type="button"
                            className="linkish"
                            onClick={() => void updatePref({ skipped_utility_version: "" })}
                          >
                            (announce it again)
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="hotkeys"
                hidden={!settingsShown.has("hotkeys")}
              >
                <legend>Global hotkeys</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!config.global_hotkey_main_enabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      // Live — registers/unregisters immediately, no restart.
                      setConfig((c) => (c ? { ...c, global_hotkey_main_enabled: enabled } : c));
                      void api.setHotkeyEnabledMain(enabled).then(setHotkeyStatusMain);
                    }}
                  />
                  Global hotkey to show/hide the launcher window (also toggleable from the tray)
                </label>
                <div className="field" style={{ marginLeft: 24 }}>
                  <span className="help-tip">
                    The main way in from anywhere — brings up this window over whatever you&apos;re
                    doing, TD fullscreen included.
                  </span>
                  <input
                    type="text"
                    value={globalHotkeyMainDraft}
                    placeholder="Ctrl+Alt+D"
                    disabled={!config.global_hotkey_main_enabled}
                    onChange={(e) => setGlobalHotkeyMainDraft(e.target.value)}
                    onBlur={() => {
                      const v = globalHotkeyMainDraft.trim();
                      if (v !== hotkeyForField(config.global_hotkey_main)) {
                        void updatePref({ global_hotkey_main: v }).then(() =>
                          api.getHotkeyStatusMain().then(setHotkeyStatusMain),
                        );
                      }
                    }}
                  />
                  <span className="help-tip">
                    Type it however you like — <code>Ctrl</code> or <code>Control</code>,{" "}
                    <code>Cmd</code> or <code>Command</code>, <code>Alt</code>/<code>Option</code>,{" "}
                    <code>Shift</code>, <code>Win</code>/<code>Super</code>. Case and spacing don't
                    matter, so <code>ctrl alt d</code> is the same as <code>Ctrl+Alt+D</code>. Shown
                    in the tray menu. A new combo binds immediately.
                  </span>
                  {hotkeyStatusMain && config.global_hotkey_main_enabled && (
                    <span className="help-tip" style={{ color: "#ff8a8a" }}>
                      ⚠ {hotkeyStatusMain}
                    </span>
                  )}
                  <input
                    type="text"
                    value={globalHotkeyMainAltDraft}
                    placeholder="Alternate combo (optional)"
                    disabled={!config.global_hotkey_main_enabled}
                    onChange={(e) => setGlobalHotkeyMainAltDraft(e.target.value)}
                    onBlur={() => {
                      const v = globalHotkeyMainAltDraft.trim();
                      if (v !== hotkeyForField(config.global_hotkey_main_alt)) {
                        void updatePref({ global_hotkey_main_alt: v }).then(() =>
                          api.getHotkeyStatusMainAlt().then(setHotkeyStatusMainAlt),
                        );
                      }
                    }}
                  />
                  <span className="help-tip">
                    Second binding for the same action — leave empty for none.
                  </span>
                  {hotkeyStatusMainAlt && config.global_hotkey_main_enabled && (
                    <span className="help-tip" style={{ color: "#ff8a8a" }}>
                      ⚠ {hotkeyStatusMainAlt}
                    </span>
                  )}
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.global_hotkey_enabled !== false}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setConfig((c) => (c ? { ...c, global_hotkey_enabled: enabled } : c));
                      void api.setHotkeyEnabled(enabled).then(setHotkeyStatus);
                    }}
                  />
                  Separate global hotkey to open the Quick Launch overlay
                </label>
                <div className="field" style={{ marginLeft: 24 }}>
                  <input
                    type="text"
                    value={globalHotkeyDraft}
                    placeholder="Alt+Shift+D"
                    disabled={config.global_hotkey_enabled === false}
                    onChange={(e) => setGlobalHotkeyDraft(e.target.value)}
                    onBlur={() => {
                      const v = globalHotkeyDraft.trim();
                      if (v !== hotkeyForField(config.global_hotkey)) {
                        void updatePref({ global_hotkey: v }).then(() =>
                          api.getHotkeyStatus().then(setHotkeyStatus),
                        );
                      }
                    }}
                  />
                  <span className="help-tip">
                    Independent of the launcher-window hotkey above — the overlay for when you
                    want to type a name instead of browsing. Shown in the tray menu. A new combo binds immediately.
                  </span>
                  {hotkeyStatus && config.global_hotkey_enabled !== false && (
                    <span className="help-tip" style={{ color: "#ff8a8a" }}>
                      ⚠ {hotkeyStatus}
                    </span>
                  )}
                  <input
                    type="text"
                    value={globalHotkeyAltDraft}
                    placeholder="Alternate combo (optional)"
                    disabled={config.global_hotkey_enabled === false}
                    onChange={(e) => setGlobalHotkeyAltDraft(e.target.value)}
                    onBlur={() => {
                      const v = globalHotkeyAltDraft.trim();
                      if (v !== hotkeyForField(config.global_hotkey_alt)) {
                        void updatePref({ global_hotkey_alt: v }).then(() =>
                          api.getHotkeyStatusQuickAlt().then(setHotkeyStatusQuickAlt),
                        );
                      }
                    }}
                  />
                  <span className="help-tip">
                    Second binding for the same overlay — leave empty for none.
                  </span>
                  {hotkeyStatusQuickAlt && config.global_hotkey_enabled !== false && (
                    <span className="help-tip" style={{ color: "#ff8a8a" }}>
                      ⚠ {hotkeyStatusQuickAlt}
                    </span>
                  )}
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.hotkey_skip_fullscreen !== false}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setConfig((c) => (c ? { ...c, hotkey_skip_fullscreen: on } : c));
                      void updatePref({ hotkey_skip_fullscreen: on });
                    }}
                  />
                  Pass these hotkeys through while a game or fullscreen app is in front
                </label>
                <span className="help-tip" style={{ marginLeft: 24 }}>
                  Stops the overlay stealing focus out of a game, a fullscreen video or a
                  presentation. A merely maximized window does not count — this asks Windows
                  the same question it asks before showing a notification. TouchDesigner is
                  exempt either way: Perform Mode is fullscreen too, and that is exactly when
                  you want the hotkey. On Windows, the launcher temporarily releases its native
                  hotkey registrations so the fullscreen app receives the combos normally.
                </span>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!config.global_hotkey_palette_enabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setConfig((c) => (c ? { ...c, global_hotkey_palette_enabled: enabled } : c));
                      void api.setHotkeyEnabledPalette(enabled).then(setHotkeyStatusPalette);
                    }}
                  />
                  Separate global hotkey to open the main window on the Palette tab
                </label>
                <div className="field" style={{ marginLeft: 24 }}>
                  <input
                    type="text"
                    value={globalHotkeyPaletteDraft}
                    placeholder="e.g. Ctrl+Alt+P"
                    disabled={!config.global_hotkey_palette_enabled}
                    onChange={(e) => setGlobalHotkeyPaletteDraft(e.target.value)}
                    onBlur={() => {
                      const v = globalHotkeyPaletteDraft.trim();
                      if (v !== hotkeyForField(config.global_hotkey_palette)) {
                        void updatePref({ global_hotkey_palette: v }).then(() =>
                          api.getHotkeyStatusPalette().then(setHotkeyStatusPalette),
                        );
                      }
                    }}
                  />
                  <span className="help-tip">
                    Shows the main window jumped straight to the Palette tab — for reaching a
                    component without the search overlay. Shown in the tray menu. A new combo binds immediately.
                  </span>
                  {hotkeyStatusPalette && config.global_hotkey_palette_enabled && (
                    <span className="help-tip" style={{ color: "#ff8a8a" }}>
                      ⚠ {hotkeyStatusPalette}
                    </span>
                  )}
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="quicklaunch"
                hidden={!settingsShown.has("quicklaunch")}
              >
                <legend>Quick Launch</legend>
                <div className="field">
                  <span className="help-tip">
                    A small search box over everything: type a project, running session, palette /
                    Toolbox / Patreon component or action — Enter launches, focuses or places it;
                    drag a .tox row straight into TD. The hotkey that summons it lives under Keys.
                  </span>
                  <div className="field quick-prefixes">
                    <span className="help-tip">Filter prefixes (one character each):</span>
                    {(
                      [
                        ["quick_prefix_commands", "commands", ">"],
                        ["quick_prefix_tools", "tools", "?"],
                        ["quick_prefix_components", "components", "="],
                        ["quick_prefix_category", "folder", "/"],
                        ["quick_prefix_tag", "tag", "#"],
                      ] as const
                    ).map(([key, label, fallback]) => (
                      <label key={key} className="quick-prefix-field">
                        {label}
                        <input
                          type="text"
                          maxLength={1}
                          value={config[key] ?? fallback}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            if (v) void updatePref({ [key]: v });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="field quick-usage">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={config.quick_rank_by_usage !== false}
                        onChange={(e) => void updatePref({ quick_rank_by_usage: e.target.checked })}
                      />
                      Rank by usage
                    </label>
                    <span className="help-tip">
                      Commands you run often rise in the bare <code>&gt;</code> and{" "}
                      <code>?</code> lists and win ties when you type — never over a better match
                      or a favourite. Shared with FNSTools' command palette inside TouchDesigner:
                      a run in either place counts in both. Runs are recorded even while this is
                      off, so turning it on later finds your history.
                    </span>
                    <button
                      type="button"
                      className={`small${usageClearArmed ? " danger" : ""}`}
                      title="Forget the launcher's own run history. FNSTools' history is separate and still counts."
                      onClick={() => {
                        if (!usageClearArmed) {
                          setUsageClearArmed(true);
                          window.setTimeout(() => setUsageClearArmed(false), 4000);
                          return;
                        }
                        setUsageClearArmed(false);
                        api.commandUsageClear().then(
                          () =>
                            setStatusMsg(
                              "Cleared the launcher's usage history — FNSTools' still counts",
                            ),
                          (e) => setStatusMsg(`Could not clear usage: ${e}`),
                        );
                      }}
                    >
                      {usageClearArmed ? "Click again to clear" : "Clear usage"}
                    </button>
                  </div>
                  {(() => {
                    // Tool-command curation: every command this machine has
                    // ever seen OR imported — history, not a live listing, so
                    // a command is curatable with no session running and an
                    // imported one can be hidden before it first registers
                    // here. Checkbox state = effective visibility; toggling
                    // stores a sparse override of the command's own default.
                    const seen = config.quick_seen_commands ?? [];
                    if (!seen.length) {
                      // Always render the section — an invisible setting is a
                      // setting nobody finds. The catalog fills on the first
                      // palette fetch from a companion new enough to answer
                      // fns_commands (utility ≥ 0.11.0).
                      return (
                        <div className="field quick-command-curation">
                          <span className="help-tip">
                            Tool commands: none seen yet — open the Quick Launch
                            once with a session running the companion utility
                            (≥ 0.11.0), and every command its tools register
                            becomes curatable here. Importing settings from
                            another machine fills this list too.
                          </span>
                        </div>
                      );
                    }
                    const hiddenList = config.quick_hidden_commands ?? [];
                    const shownList = config.quick_shown_commands ?? [];
                    const favList = config.quick_favorite_commands ?? [];
                    // Favourites are independent of visibility: a pinned
                    // command that is hidden simply stays hidden.
                    const toggleFav = (c: (typeof seen)[number]) => {
                      const next = favList.includes(c.identity)
                        ? favList.filter((i) => i !== c.identity)
                        : [...favList, c.identity];
                      void updatePref({ quick_favorite_commands: next });
                    };
                    const visibleNow = (c: (typeof seen)[number]) =>
                      shownList.includes(c.identity)
                        ? true
                        : hiddenList.includes(c.identity)
                          ? false
                          : !c.hidden;
                    const toggle = (c: (typeof seen)[number]) => {
                      // Store only the deviation from the command's default.
                      const next = !visibleNow(c);
                      const hidden = hiddenList.filter((i) => i !== c.identity);
                      const shown = shownList.filter((i) => i !== c.identity);
                      if (next && c.hidden) shown.push(c.identity);
                      if (!next && !c.hidden) hidden.push(c.identity);
                      void updatePref({
                        quick_hidden_commands: hidden,
                        quick_shown_commands: shown,
                      });
                    };
                    /** Set a whole tool's commands at once — same sparse-
                     *  override bookkeeping as toggle, in one prefs write. */
                    const setAll = (cmds: typeof seen, makeVisible: boolean) => {
                      let hidden = [...hiddenList];
                      let shown = [...shownList];
                      for (const c of cmds) {
                        hidden = hidden.filter((i) => i !== c.identity);
                        shown = shown.filter((i) => i !== c.identity);
                        if (makeVisible && c.hidden) shown.push(c.identity);
                        if (!makeVisible && !c.hidden) hidden.push(c.identity);
                      }
                      void updatePref({
                        quick_hidden_commands: hidden,
                        quick_shown_commands: shown,
                      });
                    };
                    const filter = quickCmdFilter.trim().toLowerCase();
                    const filtered = seen.filter(
                      (c) =>
                        !filter ||
                        `${c.tool} ${c.label} ${c.id} ${c.help ?? ""}`
                          .toLowerCase()
                          .includes(filter),
                    );
                    const byTool = new Map<string, typeof seen>();
                    for (const c of [...filtered].sort(
                      (a, b) =>
                        a.tool.localeCompare(b.tool, undefined, { sensitivity: "base" }) ||
                        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
                    )) {
                      const displayTool = canonicalToolName(c.tool);
                      byTool.set(displayTool, [...(byTool.get(displayTool) ?? []), c]);
                    }
                    const hiddenCount = seen.filter((c) => !visibleNow(c)).length;
                    return (
                      <div className="field quick-command-curation">
                        <span className="help-tip">
                          Tool commands — what the palette surfaces. {seen.length} known
                          {hiddenCount ? `, ${hiddenCount} hidden` : ""}
                          {favList.length ? `, ${favList.length} ★` : ""}. Click a row to
                          toggle it; ★ pins a favourite first in the quick-launch and in
                          TD's palette Commands tab (Ctrl+D in the quick-launch does the
                          same).
                        </span>
                        {seen.length > 0 && (
                          <input
                            type="text"
                            className="qc-filter"
                            placeholder="Filter commands…"
                            value={quickCmdFilter}
                            onChange={(e) => setQuickCmdFilter(e.target.value)}
                          />
                        )}
                        {!filtered.length && (
                          <span className="help-tip">No commands match the filter.</span>
                        )}
                        {[...byTool.entries()].map(([tool, cmds]) => {
                          const allVisible = cmds.every(visibleNow);
                          return (
                            <div className="qc-group" key={tool}>
                              <div className="qc-group-head">
                                <span className="qc-tool">{tool}</span>
                                <button
                                  type="button"
                                  className="qc-mini"
                                  onClick={() => setAll(cmds, !allVisible)}
                                >
                                  {allVisible ? "hide all" : "show all"}
                                </button>
                              </div>
                              {cmds.map((c) => {
                                const on = visibleNow(c);
                                return (
                                  <div
                                    key={c.identity}
                                    className={`qc-row${on ? "" : " off"}`}
                                    title={c.identity}
                                    onClick={() => toggle(c)}
                                  >
                                    <div className="qc-main">
                                      <span className="qc-label">
                                        {c.label}
                                        {c.param_count ? (
                                          <span className="qc-args">
                                            {" "}
                                            takes {c.param_count} arg
                                            {c.param_count > 1 ? "s" : ""}
                                          </span>
                                        ) : null}
                                        {c.hidden ? (
                                          <span className="qc-flag"> hidden by tool</span>
                                        ) : null}
                                      </span>
                                      {c.help ? (
                                        <span className="qc-help">{c.help}</span>
                                      ) : null}
                                    </div>
                                    <span
                                      className={`qc-star${favList.includes(c.identity) ? " on" : ""}`}
                                      title={
                                        favList.includes(c.identity)
                                          ? "Favourite — click to unpin"
                                          : "Pin as a favourite"
                                      }
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        toggleFav(c);
                                      }}
                                    >
                                      {favList.includes(c.identity) ? "★" : "☆"}
                                    </span>
                                    <span className={`qc-pill${on ? " on" : ""}`}>
                                      {on ? "shown" : "hidden"}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  {(() => {
                    // User-authored presets: a name over a tool command with
                    // the arguments baked in. The editor's fields come from
                    // the seen-commands catalog's stored param specs.
                    const presets = config.quick_command_presets ?? [];
                    const seen = config.quick_seen_commands ?? [];
                    const byIdentity = new Map(seen.map((c) => [c.identity, c]));
                    const savePresets = (next: QuickCommandPreset[]) =>
                      void updatePref({ quick_command_presets: next });
                    // A target may pin one copy of a multi-instance tool
                    // (`tool#id@instance`); the catalog is keyed on `tool#id`.
                    const draftSplit = presetDraft ? splitPresetTarget(presetDraft.target) : undefined;
                    const draftCmd = draftSplit ? byIdentity.get(draftSplit.identity) : undefined;
                    return (
                      <div className="field quick-command-presets">
                        <span className="help-tip">
                          Presets — your own palette entries: a name over a tool command
                          with the arguments baked in.
                        </span>
                        {presets.map((p, i) => {
                          const pinned = splitPresetTarget(p.target);
                          const cmd = byIdentity.get(pinned.identity);
                          const kw = Object.entries(p.kwargs ?? {});
                          return (
                            <div className="qc-row" key={`${p.target}:${i}`} title={p.target}>
                              <div className="qc-main">
                                <span className="qc-label">{p.label}</span>
                                <span className="qc-help">
                                  {cmd ? withInstance(cmd.label, pinned.instance) : p.target}
                                  {kw.length
                                    ? ` · ${kw.map(([k, v]) => `${k} ${v}`).join(" · ")}`
                                    : ""}
                                  {!cmd ? " — not seen in any session yet" : ""}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="qc-mini"
                                onClick={() => savePresets(presets.filter((_, j) => j !== i))}
                              >
                                remove
                              </button>
                            </div>
                          );
                        })}
                        {!presetDraft ? (
                          <button
                            type="button"
                            className="qc-mini qc-add"
                            disabled={!seen.length}
                            onClick={() =>
                              setPresetDraft({
                                target: seen[0]?.identity ?? "",
                                label: "",
                                values: {},
                              })
                            }
                          >
                            + add preset{seen.length ? "" : " (no commands seen yet)"}
                          </button>
                        ) : (
                          <div className="qc-preset-form">
                            <select
                              value={draftSplit?.identity ?? ""}
                              onChange={(e) =>
                                setPresetDraft({
                                  ...presetDraft,
                                  target: e.target.value,
                                  values: {},
                                })
                              }
                            >
                              {seen.map((c) => (
                                <option key={c.identity} value={c.identity}>
                                  {canonicalToolName(c.tool)} — {c.label}
                                </option>
                              ))}
                            </select>
                            {(draftCmd?.instances?.length ?? 0) > 0 && (
                              // Multi-instance tool: run on every copy, or pin
                              // one. The label is project data, so a pinned
                              // preset is dormant where that copy is absent.
                              <select
                                value={draftSplit?.instance ?? ""}
                                onChange={(e) =>
                                  setPresetDraft({
                                    ...presetDraft,
                                    target: e.target.value
                                      ? `${draftSplit?.identity ?? ""}@${e.target.value}`
                                      : (draftSplit?.identity ?? ""),
                                  })
                                }
                              >
                                <option value="">every copy</option>
                                {(draftCmd?.instances ?? []).map((inst) => (
                                  <option key={inst} value={inst}>
                                    only {inst}
                                  </option>
                                ))}
                              </select>
                            )}
                            <input
                              type="text"
                              placeholder="Preset name (shown in the palette)"
                              value={presetDraft.label}
                              onChange={(e) =>
                                setPresetDraft({ ...presetDraft, label: e.target.value })
                              }
                            />
                            {(draftCmd?.params ?? []).map((p) => {
                              const val = presetDraft.values[p.name] ?? "";
                              const set = (v: string) =>
                                setPresetDraft({
                                  ...presetDraft,
                                  values: { ...presetDraft.values, [p.name]: v },
                                });
                              const def =
                                p.default != null
                                  ? String(
                                      p.style === "toggle"
                                        ? p.default
                                          ? "on"
                                          : "off"
                                        : p.default,
                                    )
                                  : "";
                              return (
                                <label key={p.name} className="qc-preset-field">
                                  {p.label || p.name}
                                  {p.style === "menu" || p.style === "toggle" ? (
                                    <select value={val} onChange={(e) => set(e.target.value)}>
                                      <option value="">
                                        (default{def ? ` ${def}` : ""})
                                      </option>
                                      {(p.style === "menu" ? (p.menu ?? []) : ["on", "off"]).map(
                                        (m) => (
                                          <option key={m} value={m}>
                                            {m}
                                          </option>
                                        ),
                                      )}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      placeholder={def ? `default ${def}` : (p.style ?? "str")}
                                      value={val}
                                      onChange={(e) => set(e.target.value)}
                                    />
                                  )}
                                </label>
                              );
                            })}
                            <div className="qc-preset-actions">
                              <button
                                type="button"
                                className="qc-mini"
                                onClick={() => {
                                  const label = presetDraft.label.trim();
                                  if (!label || !presetDraft.target) return;
                                  const kwargs: Record<string, string> = {};
                                  for (const [k, v] of Object.entries(presetDraft.values)) {
                                    if (v.trim()) kwargs[k] = v.trim();
                                  }
                                  savePresets([
                                    ...presets,
                                    { label, target: presetDraft.target, kwargs },
                                  ]);
                                  setPresetDraft(null);
                                }}
                              >
                                save preset
                              </button>
                              <button
                                type="button"
                                className="qc-mini"
                                onClick={() => setPresetDraft(null)}
                              >
                                cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="shortcuts"
                hidden={!settingsShown.has("shortcuts")}
              >
                <legend>In-app shortcuts</legend>
                <p className="help-tip">
                  In-app keyboard shortcuts. Click a binding, then press the keys to change it (Esc
                  cancels). Assigning a combo removes it from any other action.
                </p>
                {shortcutEditor}
                {/* This list is only the REBINDABLE actions. Without saying so it
                    reads as the complete set, and the fixed ones (Ctrl+D, Ctrl+1-9,
                    the overlay, the switcher) look missing. */}
                <p className="help-tip">
                  <strong>Reset</strong> restores one default, <strong>Reset all</strong> the
                  lot. Single-letter bindings only fire when you aren&apos;t typing in a field.
                  What stays fixed: list navigation, {mod}+1–9 for template slots, and the keys
                  inside the Quick Launch overlay and the window switcher —{" "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => setModal("help")}
                  >
                    Help lists those
                  </button>
                  . Hotkeys that reach the app from outside it are under{" "}
                  <strong>Keys → Global hotkeys</strong>.
                </p>
              </fieldset>
              {FNS_ENABLED && license && license.provider !== "disabled" && (
                <fieldset
                  className="settings-group"
                  data-settings-section="fnsplus"
                  hidden={!settingsShown.has("fnsplus")}
                >
                  <legend>FNSTools Plus</legend>
                  <p className="help-tip">
                    The launcher is free in full. A Function Store membership only unlocks the
                    FNSTools <strong>Plus</strong> packages, for installing them from the FNSTools
                    tab here. FNSTools inside TouchDesigner has its own sign-in as well.
                  </p>
                  <div className="field">
                    <span>
                      {license.entitled
                        ? "Signed in — Plus packages unlocked"
                        : "Not signed in — Plus packages show locked"}
                    </span>
                    <button className="small" onClick={() => setModal("membership")}>
                      {license.entitled ? "Membership…" : "Sign in…"}
                    </button>
                  </div>
                </fieldset>
              )}
              <fieldset
                className="settings-group"
                data-settings-section="github"
                hidden={!settingsShown.has("github")}
              >
                <legend>GitHub</legend>
                <p className="help-tip">
                  Optional. Push/pull already use your installed Git and its credentials (Git Credential
                  Manager, <code>gh auth</code>, OS keychain, etc.). Set a PAT here only if you want the
                  app to override HTTPS auth for github.com.{" "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => void api.openUrl("https://github.com/settings/tokens")}
                  >
                    Create a token
                  </button>
                </p>
                <div className="field">
                  <label>Username</label>
                  <input
                    type="text"
                    value={githubUserDraft}
                    placeholder={config.github_username || "your-github-username"}
                    onChange={(e) => setGithubUserDraft(e.target.value)}
                    onFocus={() => {
                      if (!githubUserDraft) setGithubUserDraft(config.github_username || "");
                    }}
                  />
                </div>
                <div className="field">
                  <label>Personal access token</label>
                  <input
                    type="password"
                    value={githubTokenDraft}
                    placeholder={config.github_token ? "•••••••• (saved)" : "ghp_…"}
                    onChange={(e) => setGithubTokenDraft(e.target.value)}
                    onFocus={() => {
                      if (!githubTokenDraft) setGithubTokenDraft(config.github_token || "");
                    }}
                    autoComplete="off"
                  />
                </div>
                {githubVerifyMsg && <p className="help-tip">{githubVerifyMsg}</p>}
                <div className="actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={async () => {
                      const token = githubTokenDraft.trim() || config.github_token || "";
                      if (!token) {
                        setGithubVerifyMsg("Enter a token first");
                        return;
                      }
                      try {
                        const user = await api.verifyGithubToken(token);
                        setGithubVerifyMsg(`Signed in as ${user.login}`);
                        setGithubUserDraft(user.login);
                        await updatePref({
                          github_username: user.login,
                          github_token: token,
                        });
                      } catch (e) {
                        setGithubVerifyMsg(String(e));
                      }
                    }}
                  >
                    Verify &amp; save
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setGithubUserDraft("");
                      setGithubTokenDraft("");
                      setGithubVerifyMsg("Cleared");
                      await updatePref({ github_username: "", github_token: "" });
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </fieldset>
              {patreonEnabled && (
                <fieldset
                  className="settings-group"
                  data-settings-section="patreon"
                  hidden={!settingsShown.has("patreon")}
                >
                  <legend>Patreon</legend>
                  <p className="help-tip">
                    Optional. Lets the <strong>Patreon</strong> tab list <code>.tox</code> components
                    from creators you support and load them into a running project. Log in below (a
                    Patreon window opens and we capture your session), or paste the{" "}
                    <code>session_id</code> cookie manually.
                  </p>
                  <PatreonUnofficialNote className="help-tip patreon-disclaimer" />
                  <PatreonCookieNote className="help-tip patreon-disclaimer" />
                  <p className="help-tip patreon-disclaimer">
                    A component is a program: placing one runs its creator's code on this machine.
                    Only place components from creators you trust.
                  </p>
                  <div className="actions" style={{ marginTop: 0, marginBottom: 8 }}>
                    {patreonLoginWaiting ? (
                      <>
                        <span className="help-tip">Waiting for Patreon login…</span>
                        <button type="button" onClick={() => stopPatreonLogin("Login cancelled")}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="primary" onClick={() => void startPatreonLogin()}>
                        {config.patreon_session_cookie ? "Re-login with Patreon" : "Log in with Patreon"}
                      </button>
                    )}
                    {config.patreon_session_cookie && !patreonLoginWaiting && (
                      <>
                        <span className="help-tip" style={{ color: "var(--accent)" }}>
                          ✓ connected
                        </span>
                        <button type="button" className="ghost danger" onClick={() => void logoutPatreon()}>
                          Log out
                        </button>
                      </>
                    )}
                  </div>
                  {config.patreon_session_cookie && (
                    <p className="help-tip" style={{ marginTop: 0 }}>
                      <strong>Log out</strong> deletes the saved session and signs the
                      built-in login window out of patreon.com — use it before logging in as a
                      different account, otherwise the next login silently reuses this one.
                      Downloaded files and your creator list are kept.
                    </p>
                  )}
                  <p className="help-tip">
                    <strong>Log in with Patreon</strong> works with a Patreon{" "}
                    <strong>email &amp; password</strong> only. <strong>Google and Apple sign-in
                    won&apos;t work here</strong> — those providers refuse to sign in inside an
                    embedded window. If your account uses one of them, paste the cookie by hand
                    instead: sign in to patreon.com in your normal browser, then{" "}
                    <em>DevTools → Application → Cookies → https://www.patreon.com →{" "}
                    <code>session_id</code></em>, and copy the <em>Value</em> column into the box
                    below. Either route ends at the same place — <strong>✓ connected</strong> above
                    means a cookie is saved, not that it is still valid; if the tab starts erroring,
                    the session expired and you log in again.
                  </p>
                  <div className="field">
                    <label>session_id cookie (manual)</label>
                    <input
                      type="password"
                      value={patreonCookieDraft}
                      placeholder={config.patreon_session_cookie ? "•••••••• (saved)" : "session_id value"}
                      onChange={(e) => setPatreonCookieDraft(e.target.value)}
                      onFocus={() => {
                        if (!patreonCookieDraft)
                          setPatreonCookieDraft(config.patreon_session_cookie || "");
                      }}
                      autoComplete="off"
                    />
                  </div>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={async () => {
                        await updatePref({ patreon_session_cookie: patreonCookieDraft.trim() });
                        setStatusMsg("Patreon cookie saved");
                      }}
                    >
                      Save
                    </button>
                  </div>
                  <div className="field">
                    <label>Download folder</label>
                    <p className="help-tip" style={{ marginTop: 0 }}>
                      Where <code>.tox</code>/<code>.toe</code>/<code>.zip</code> downloads land —
                      always grouped into a per-creator subfolder. Empty ={" "}
                      <code>Documents/TDXLU/Patreon Downloads</code>.
                    </p>
                    <div className="backup-override-row">
                      <input
                        type="text"
                        value={patreonDownloadRootDraft}
                        placeholder={config.patreon_download_root || "Documents/TDXLU/Patreon Downloads"}
                        onChange={(e) => setPatreonDownloadRootDraft(e.target.value)}
                        onFocus={() => {
                          if (!patreonDownloadRootDraft)
                            setPatreonDownloadRootDraft(config.patreon_download_root || "");
                        }}
                      />
                      <button
                        type="button"
                        className="small"
                        onClick={async () => {
                          const folder = await api.pickFolder("Choose Patreon download folder");
                          if (folder) setPatreonDownloadRootDraft(folder);
                        }}
                      >
                        Browse…
                      </button>
                    </div>
                  </div>
                </fieldset>
              )}
              <fieldset
                className="settings-group"
                data-settings-section="backup"
                hidden={!settingsShown.has("backup")}
              >
                <legend>Backup</legend>
                <p className="help-tip">
                  Project folders copy into{" "}
                  <code>backup_root / project_folder_name</code>. Point this at a USB drive or a folder
                  already synced by OneDrive / Google Drive / Dropbox.
                </p>
                <div className="field">
                  <label>Backup root folder</label>
                  <div className="backup-override-row">
                    <input
                      type="text"
                      value={backupRootDraft}
                      placeholder={config.backup_root || "D:\\Backups\\TD or …\\OneDrive\\TDXLU"}
                      onChange={(e) => setBackupRootDraft(e.target.value)}
                      onFocus={() => {
                        if (!backupRootDraft) setBackupRootDraft(config.backup_root || "");
                      }}
                    />
                    <button
                      type="button"
                      className="small"
                      onClick={async () => {
                        const folder = await api.pickFolder("Choose backup root folder");
                        if (folder) setBackupRootDraft(folder);
                      }}
                    >
                      Browse…
                    </button>
                  </div>
                </div>
                <div className="field">
                  <label>Cloud backup root (folder on connected cloud remotes)</label>
                  <input
                    type="text"
                    value={cloudRootDraft}
                    placeholder="TDXLU-Backups (empty = top of the remote)"
                    onChange={(e) => setCloudRootDraft(e.target.value)}
                  />
                  <p className="help-tip">
                    Cloud destinations back up into{" "}
                    <code>{(cloudRootDraft.trim() ? cloudRootDraft.trim().replace(/^\/+|\/+$/g, "") + "/" : "") + "…"}</code>{" "}
                    on the remote, where <code>…</code> is the name of the folder the project lives in
                    (same convention as folder backups). The per-project “Remote path” field in the
                    Backup panel overrides this.
                  </p>
                </div>
                <div className="field">
                  <label>Exclude filters (one glob per line)</label>
                  <textarea
                    className="backup-filter-area"
                    rows={6}
                    value={backupExcludeDraft}
                    placeholder={".git/\n*.tmp\nCrashAutoSave*/"}
                    spellCheck={false}
                    onChange={(e) => setBackupExcludeDraft(e.target.value)}
                    onFocus={() => {
                      if (!backupExcludeDraft) setBackupExcludeDraft(config.backup_exclude || "");
                    }}
                  />
                </div>
                <div className="field">
                  <label>Include filters (optional — empty = all non-excluded)</label>
                  <textarea
                    className="backup-filter-area"
                    rows={3}
                    value={backupIncludeDraft}
                    placeholder={"*.toe\n*.tdxlu.json\npreview/**"}
                    spellCheck={false}
                    onChange={(e) => setBackupIncludeDraft(e.target.value)}
                    onFocus={() => {
                      if (!backupIncludeDraft) setBackupIncludeDraft(config.backup_include || "");
                    }}
                  />
                </div>
                <div className="field">
                  <label>Max file size (MB, 0 = unlimited)</label>
                  <input
                    type="number"
                    min={0}
                    value={backupMaxMbDraft}
                    onChange={(e) => setBackupMaxMbDraft(Number(e.target.value) || 0)}
                  />
                </div>
                <label
                  className="check"
                  title="Leaves out every folder named Backup — TouchDesigner's numbered saves. Off by default: some people work straight out of those saves."
                >
                  <input
                    type="checkbox"
                    checked={!!config.backup_skip_td_backups}
                    onChange={(e) => void updatePref({ backup_skip_td_backups: e.target.checked })}
                  />
                  Skip TouchDesigner&rsquo;s <code>Backup/</code> folders
                </label>
                <p className="help-tip">
                  Globs: <code>*</code> one path segment, <code>**</code> anywhere, <code>?</code> one
                  char. Trailing <code>/</code> = whole folder. Lines starting with <code>#</code> are
                  comments.
                </p>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="palette"
                hidden={!settingsShown.has("palette")}
              >
                <legend>Palette</legend>
                <p className="help-tip">
                  Always scans the user palette at{" "}
                  <code>{defaultPaletteDir || "%USERPROFILE%\\Documents\\Derivative\\Palette"}</code>
                  , plus the shipped Factory palette from the selected TD install (
                  <code>Samples/Palette</code>). Add more folders below (one per line) for studio /
                  shared libraries.
                </p>
                <div className="field">
                  <label>Extra palette folders</label>
                  <textarea
                    rows={4}
                    value={paletteExtraDraft}
                    onChange={(e) => setPaletteExtraDraft(e.target.value)}
                    placeholder={"D:\\Shared\\TD_Palette\nC:\\Libs\\tox"}
                  />
                </div>
                <div className="actions" style={{ marginTop: 0 }}>
                  <button
                    type="button"
                    className="small"
                    onClick={async () => {
                      const folder = await api.pickFolder("Add palette folder");
                      if (!folder) return;
                      const lines = paletteExtraDraft
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                      if (!lines.some((l) => l.toLowerCase() === folder.toLowerCase())) {
                        lines.push(folder);
                      }
                      setPaletteExtraDraft(lines.join("\n"));
                    }}
                  >
                    Add folder…
                  </button>
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="packages"
                hidden={!settingsShown.has("packages")}
              >
                <legend>Packages</legend>
                <p className="help-tip">
                  The package index behind <strong>From package…</strong> (browse + install). Any
                  Warehouse/PyPI-compatible index works — it must serve the <code>/simple/</code>{" "}
                  listing and <code>/pypi/&lt;name&gt;/json</code> metadata; <code>uv</code> installs
                  resolve from <code>&lt;index&gt;/simple/</code>. Defaults to PyPI.
                </p>
                <div className="field">
                  <label>Index URL</label>
                  <input
                    type="text"
                    value={packageIndexDraft}
                    placeholder="https://pypi.org"
                    onChange={(e) => setPackageIndexDraft(e.target.value)}
                    onBlur={() => {
                      const v = packageIndexDraft.trim().replace(/\/+$/, "");
                      if (v !== (config.package_index_url ?? "")) {
                        setPackageIndexDraft(v);
                        void updatePref({ package_index_url: v });
                      }
                    }}
                  />
                  <span className="help-tip">
                    Base URL only (no trailing <code>/simple/</code>).
                    {config.package_index_url && config.package_index_url !== "https://pypi.org" && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => {
                            setPackageIndexDraft("https://pypi.org");
                            void updatePref({ package_index_url: "https://pypi.org" });
                          }}
                        >
                          Reset to PyPI
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <div className="field">
                  <label>Name filter</label>
                  <input
                    type="text"
                    value={packagePrefixDraft}
                    placeholder="tdp-"
                    onChange={(e) => setPackagePrefixDraft(e.target.value)}
                    onBlur={() => {
                      const v = packagePrefixDraft.trim();
                      if (v !== (config.package_index_prefix ?? "")) {
                        setPackagePrefixDraft(v);
                        void updatePref({ package_index_prefix: v });
                      }
                    }}
                  />
                  <span className="help-tip">
                    Only list packages whose name starts with this. On a big shared index (PyPI) keep it
                    (<code>tdp-</code>) so you see TD packages, not everything. On a small/curated index,
                    clear it to list all. Changing index or filter refetches.
                  </span>
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="fns"
                hidden={!FNS_ENABLED || !settingsShown.has("fns")}
              >
                <legend>FNSTools</legend>
                <p className="help-tip">
                  The release bucket behind the <strong>FNSTools</strong> tab —{" "}
                  <code>&lt;base&gt;/manifest.json</code> is the rolling catalog and downloads
                  land in the FNS palette store, where the toolkit's own installer and updater
                  read them.
                </p>
                <div className="field">
                  <label>Bucket URL</label>
                  {/* Read-only until deliberately unlocked: this is
                      infrastructure, not a preference — a mistyped or stale
                      value here silently kills every FNS fetch. */}
                  {fnsBaseEditing ? (
                    <input
                      type="text"
                      autoFocus
                      value={fnsBaseDraft}
                      placeholder="https://storage.functionstore.tools/fnstools"
                      onChange={(e) => setFnsBaseDraft(e.target.value)}
                      onBlur={() => {
                        setFnsBaseEditing(false);
                        const v = fnsBaseDraft.trim().replace(/\/+$/, "");
                        if (v !== (config.fns_base_url ?? "")) {
                          setFnsBaseDraft(v);
                          void updatePref({ fns_base_url: v });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          setFnsBaseDraft(config.fns_base_url ?? "");
                          setFnsBaseEditing(false);
                        }
                      }}
                    />
                  ) : (
                    <div className="actions" style={{ alignItems: "center", gap: 8 }}>
                      <code style={{ userSelect: "all" }}>
                        {config.fns_base_url || "official bucket"}
                      </code>
                      <button
                        type="button"
                        className="small"
                        onClick={() => {
                          setFnsBaseDraft(config.fns_base_url ?? "");
                          setFnsBaseEditing(true);
                        }}
                      >
                        Change…
                      </button>
                    </div>
                  )}
                  <span className="help-tip">
                    Advanced — points every FNS fetch somewhere else. Empty resets to the
                    official bucket; a mirror or staging bucket works as long as it serves
                    the same manifest + artifact layout.
                  </span>
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="control"
                hidden={!settingsShown.has("control")}
              >
                <legend>Control panel server</legend>
                <p className="help-tip">
                  Serves the Phone Remote&rsquo;s fleet page (the header&rsquo;s 📱 Phone) and the
                  palette tabs inside TouchDesigner. Localhost-only unless LAN access is on; every
                  request needs the token embedded in the opened URL, which stays valid until you
                  regenerate it.
                </p>
                <div className="field">
                  <label>HTTP port</label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={config.control_server_port || 11997}
                    onChange={(e) =>
                      void updatePref({ control_server_port: Number(e.target.value) || 11997 })
                    }
                    onBlur={() =>
                      void rebindControlServer(`port ${config.control_server_port || 11997}`)
                    }
                  />
                  {phoneServing && (
                    <span className="help-tip">Server is running — leaving this field rebinds it to the new port.</span>
                  )}
                </div>
                <div className="field">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!config.control_server_lan}
                      onChange={(e) => {
                        const lan = e.target.checked;
                        // Persist first, THEN rebind — the server reads the saved value.
                        void updatePref({ control_server_lan: lan }).then(() =>
                          rebindControlServer(lan ? "LAN on" : "LAN off"),
                        );
                      }}
                    />{" "}
                    Allow LAN access (other devices on your network can open the panel)
                  </label>
                </div>
                <div className="field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.palette_tabs_enabled !== false}
                      onChange={(e) => void updatePref({ palette_tabs_enabled: e.target.checked })}
                    />{" "}
                    Palette tabs in TouchDesigner (TDXLU + Patreon tabs in the Palette Browser)
                  </label>
                  <span className="help-tip">
                    Every session running the companion (v0.21.0+) gets a loopback link to this
                    server and shows your Toolbox, FNS shelf, palette folders and Patreon
                    components as extra tabs in TD's own Palette Browser — one click places a
                    component into that session. Localhost only; no LAN needed.
                  </span>
                </div>
                <div className="field">
                  <button type="button" className="small" onClick={openPhoneRemote}>
                    📱 Set up Phone Remote…
                  </button>
                  {phoneServing && (
                    <button
                      type="button"
                      className="small ghost danger"
                      title="Stop the control server — no device can reach the panel until you start it again"
                      onClick={() => void stopPhoneRemote()}
                    >
                      Stop server
                    </button>
                  )}
                  <span className="help-tip">
                    Turns on LAN access and shows a QR to scan — open the control panel on your
                    phone (same Wi-Fi). The pairing survives restarts; “Regenerate” in that
                    dialog invalidates any shared link.
                    {phoneServing ? " The server is running now." : ""}
                  </span>
                </div>
                <p className="help-tip">
                  Port and LAN changes rebind the running server live (paired devices need a
                  re-scan after a port change — the token itself stays valid).
                </p>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="heartbeat"
                hidden={!settingsShown.has("heartbeat")}
              >
                <legend>Heartbeat</legend>
                <p className="help-tip">
                  Tray watchdog listens for heartbeats from <code>utility/heartbeat</code> (future Utility
                  TOX). Missed heartbeats → log, screenshot, kill, relaunch.
                </p>
                <div className="field">
                  <label>TCP port</label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={config.watch_tcp_port || 11999}
                    onChange={(e) =>
                      void updatePref({ watch_tcp_port: Number(e.target.value) || 11999 })
                    }
                  />
                </div>
                <div className="field">
                  <label>Heartbeat timeout (seconds)</label>
                  <input
                    type="number"
                    min={5}
                    value={config.watch_timeout_secs || 60}
                    onChange={(e) =>
                      void updatePref({ watch_timeout_secs: Number(e.target.value) || 60 })
                    }
                  />
                </div>
                <div className="field">
                  <label>Launch grace (seconds)</label>
                  <input
                    type="number"
                    min={5}
                    value={config.watch_launch_grace_secs || 45}
                    onChange={(e) =>
                      void updatePref({ watch_launch_grace_secs: Number(e.target.value) || 45 })
                    }
                  />
                </div>
                <div className="field">
                  <label>Max relaunches</label>
                  <input
                    type="number"
                    min={0}
                    value={config.watch_max_restarts ?? 5}
                    onChange={(e) =>
                      void updatePref({ watch_max_restarts: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div className="field">
                  <label>Reboot after N crashes (0 = never)</label>
                  <input
                    type="number"
                    min={0}
                    value={config.watch_reboot_after_crashes || 0}
                    onChange={(e) =>
                      void updatePref({
                        watch_reboot_after_crashes: Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.watch_screenshot_on_crash !== false}
                    onChange={(e) =>
                      void updatePref({ watch_screenshot_on_crash: e.target.checked })
                    }
                  />
                  Screenshot on stall / crash
                </label>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="performance"
                hidden={!settingsShown.has("performance")}
              >
                <legend>Performance</legend>
                <p className="help-tip">
                  Live stats for the selected running session in the Sessions tab: process
                  CPU / RAM for any session, plus fps / cook time / GPU memory when the
                  companion utility is loaded. Off = no sampling, no traffic.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.perf_monitor_enabled === true}
                    onChange={(e) =>
                      void updatePref({ perf_monitor_enabled: e.target.checked })
                    }
                  />
                  Show session performance stats
                </label>
                <div className="field">
                  <label>Poll interval (seconds)</label>
                  <input
                    type="number"
                    min={2}
                    max={60}
                    value={config.perf_poll_secs || 4}
                    onChange={(e) =>
                      void updatePref({ perf_poll_secs: Number(e.target.value) || 4 })
                    }
                  />
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="alerts"
                hidden={!settingsShown.has("alerts")}
              >
                <legend>Heartbeat email alerts</legend>
                <p className="help-tip">
                  SMTP email on stall / relaunch / gave up / reboot. Gmail: use an{" "}
                  <em>app password</em>, host <code>smtp.gmail.com</code>, port{" "}
                  <code>587</code>, security STARTTLS. Restart an active heartbeat watch after changing
                  settings.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!config.alert_email_enabled}
                    onChange={(e) => void updatePref({ alert_email_enabled: e.target.checked })}
                  />
                  Enable email alerts
                </label>
                <div className="field">
                  <label>To</label>
                  <input
                    type="email"
                    value={config.alert_email_to || ""}
                    onChange={(e) => void updatePref({ alert_email_to: e.target.value })}
                    placeholder="you@example.com"
                  />
                </div>
                <div className="field">
                  <label>From</label>
                  <input
                    type="email"
                    value={config.alert_email_from || ""}
                    onChange={(e) => void updatePref({ alert_email_from: e.target.value })}
                    placeholder="tdxlu@example.com"
                  />
                </div>
                <div className="field">
                  <label>SMTP host</label>
                  <input
                    value={config.alert_smtp_host || ""}
                    onChange={(e) => void updatePref({ alert_smtp_host: e.target.value })}
                    placeholder="smtp.gmail.com"
                  />
                </div>
                <div className="field">
                  <label>SMTP port</label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={config.alert_smtp_port || 587}
                    onChange={(e) =>
                      void updatePref({ alert_smtp_port: Number(e.target.value) || 587 })
                    }
                  />
                </div>
                <div className="field">
                  <label>Security</label>
                  <select
                    value={config.alert_smtp_security || "starttls"}
                    onChange={(e) => void updatePref({ alert_smtp_security: e.target.value })}
                  >
                    <option value="starttls">STARTTLS (587)</option>
                    <option value="tls">TLS / SSL (465)</option>
                    <option value="none">None (not recommended)</option>
                  </select>
                </div>
                <div className="field">
                  <label>SMTP username</label>
                  <input
                    value={config.alert_smtp_username || ""}
                    onChange={(e) => void updatePref({ alert_smtp_username: e.target.value })}
                    placeholder="usually your email"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label>SMTP password</label>
                  <input
                    type="password"
                    value={smtpPasswordDraft}
                    onChange={(e) => setSmtpPasswordDraft(e.target.value)}
                    onFocus={() => {
                      if (!smtpPasswordDraft)
                        setSmtpPasswordDraft(config.alert_smtp_password || "");
                    }}
                    placeholder={config.alert_smtp_password ? "•••••••• (saved)" : "app password"}
                    autoComplete="new-password"
                  />
                </div>
                <div className="field">
                  <label>Cooldownoldown (seconds between same event)</label>
                  <input
                    type="number"
                    min={0}
                    value={config.alert_cooldown_secs ?? 300}
                    onChange={(e) =>
                      void updatePref({ alert_cooldown_secs: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.alert_on_stall !== false}
                    onChange={(e) => void updatePref({ alert_on_stall: e.target.checked })}
                  />
                  On stall
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.alert_on_relaunch !== false}
                    onChange={(e) => void updatePref({ alert_on_relaunch: e.target.checked })}
                  />
                  On relaunch
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.alert_on_gave_up !== false}
                    onChange={(e) => void updatePref({ alert_on_gave_up: e.target.checked })}
                  />
                  On gave up / launch failed
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.alert_on_reboot !== false}
                    onChange={(e) => void updatePref({ alert_on_reboot: e.target.checked })}
                  />
                  On reboot
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.alert_attach_screenshot !== false}
                    onChange={(e) =>
                      void updatePref({ alert_attach_screenshot: e.target.checked })
                    }
                  />
                  Attach screenshot when available
                </label>
                <div className="actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="small"
                    onClick={async () => {
                      try {
                        if (smtpPasswordDraft.trim()) {
                          await updatePref({ alert_smtp_password: smtpPasswordDraft.trim() });
                        }
                        const msg = await api.alertTestEmail();
                        setAlertTestMsg(msg);
                      } catch (e) {
                        setAlertTestMsg(String(e));
                      }
                    }}
                  >
                    Send test email
                  </button>
                  {alertTestMsg && <span className="tag-hint">{alertTestMsg}</span>}
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="general"
                hidden={!settingsShown.has("general")}
              >
                <legend>Lists &amp; prompts</legend>
                <div className="field">
                  <label>Max recent files (5–200)</label>
                  <input
                    type="number"
                    min={5}
                    max={200}
                    value={maxRecentDraft}
                    onChange={(e) => setMaxRecentDraft(Number(e.target.value))}
                  />
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={config.confirm_remove_from_list}
                    onChange={(e) => void updatePref({ confirm_remove_from_list: e.target.checked })}
                  />
                  Confirm before removing from list
                </label>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="migrate"
                hidden={!settingsShown.has("migrate")}
              >
                <legend>Migrate settings</legend>
                <p className="tag-hint">
                  Carry preferences, backup filters, keybindings, the Toolbox and your known
                  tool commands (with their hide/show curation and presets) to another machine.
                  Passwords, tokens and cookies are never written to the file — re-enter those
                  after importing. Importing merges: anything not in the file is left alone, and
                  imported commands become curatable here before they ever register on this
                  machine.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={exportIncludePaths}
                    onChange={(e) => setExportIncludePaths(e.target.checked)}
                  />
                  Include machine paths (backup root, palette folders)
                </label>
                <div className="actions">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const dest = await api.exportSettings(exportIncludePaths);
                        if (dest) setStatusMsg(`Settings exported → ${dest}`);
                      } catch (e) {
                        setStatusMsg(String(e));
                      }
                    }}
                  >
                    Export settings…
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const r = await api.importSettings();
                        if (!r) return;
                        setConfig(r.config);
                        // Re-seed the open dialog's drafts from the merged config.
                        setMaxRecentDraft(r.config.max_recent_files);
                        setPatreonDownloadRootDraft(r.config.patreon_download_root || "");
                        setBackupRootDraft(r.config.backup_root || "");
                        setCloudRootDraft(r.config.cloud_backup_root ?? "");
                        setBackupExcludeDraft(r.config.backup_exclude || "");
                        setBackupIncludeDraft(r.config.backup_include || "");
                        setBackupMaxMbDraft(r.config.backup_max_file_mb || 0);
                        setPaletteExtraDraft(r.config.palette_extra_folders || "");
                        setGithubUserDraft(r.config.github_username || "");
                        setGlobalHotkeyDraft(hotkeyForField(r.config.global_hotkey));
                        setGlobalHotkeyMainDraft(hotkeyForField(r.config.global_hotkey_main));
                        setGlobalHotkeyPaletteDraft(hotkeyForField(r.config.global_hotkey_palette));
                        void api.getToolbox().then(setToolbox).catch(() => {
                          /* toolbox optional */
                        });
                        await refreshLists(r.config, { rediscover: false });
                        setStatusMsg(
                          `Imported ${r.prefs_applied} setting(s)` +
                            (r.tools_added ? `, ${r.tools_added} tool(s)` : "") +
                            (r.categories_added ? `, ${r.categories_added} category(ies)` : "") +
                            (r.commands_added ? `, ${r.commands_added} known command(s)` : ""),
                        );
                      } catch (e) {
                        setStatusMsg(String(e));
                      }
                    }}
                  >
                    Import settings…
                  </button>
                </div>
              </fieldset>
              <fieldset
                className="settings-group"
                data-settings-section="maintenance"
                hidden={!settingsShown.has("maintenance")}
              >
                <legend>Maintenance</legend>
                <p className="tag-hint">
                  Housekeeping for the file list and the bundled templates. Neither touches
                  anything on disk outside TDXLU's own lists.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    onClick={async () => {
                      const n = await api.clearMissing();
                      await refreshLists(undefined, { rediscover: false });
                      setStatusMsg(`Removed ${n} missing entries`);
                    }}
                  >
                    Clear missing files
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const r = await api.importPlusTemplates();
                        await refreshLists(undefined, { rediscover: false });
                        setStatusMsg(
                          r.imported
                            ? `Imported ${r.imported} template(s) from Plus (${r.total} total)`
                            : `No new templates (already have ${r.total})`,
                        );
                      } catch (e) {
                        setStatusMsg(String(e));
                      }
                    }}
                  >
                    Import templates from Plus
                  </button>
                </div>
              </fieldset>
            </div>
          </div>
        </Modal>
      )}

      {modal === "help" && (
        <Modal title="Help" onClose={() => setModal(null)} wide>
          <h3 className="help-section">Keyboard Shortcuts</h3>
          <table className="help-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  cat: "Navigation",
                  bindings: [
                    ["Tab / Shift+Tab", "Next / previous tab"],
                    ["Up / W", "Select previous file"],
                    ["Down / S", "Select next file"],
                    ["Space", "Toggle focus: File List / Versions"],
                    ["Enter", "Launch selected project"],
                    // Esc is a cascade, not a quit key — saying "Quit" flat out
                    // reads as "don't press this".
                    ["Esc", "Close switcher / modal / search / README edit — quits when nothing is open"],
                  ],
                },
                {
                  cat: "Search",
                  bindings: [
                    ["* / ?", "Wildcards (* any, ? one char)"],
                    ["Esc", "Clear search and close"],
                    ["Enter", "Close search (keep filter)"],
                    ["Up / Down", "Navigate filtered list"],
                  ],
                },
                {
                  cat: "File Management",
                  bindings: [
                    ["Del / Backspace", "Remove selected file"],
                    [`${mod}+Up/Down`, "Reorder templates"],
                  ],
                },
                {
                  cat: "Launching",
                  bindings: [
                    // Ctrl+1-9 is one binding per template SLOT, so it stays
                    // fixed while the rest of the launch keys became editable.
                    [`${mod}+1–9`, "Launch template by position"],
                    ["Any key", "Cancel the auto-launch countdown"],
                  ],
                },
                {
                  // The overlay is a separate window with its own key handling,
                  // and none of it was documented anywhere but the tour.
                  cat: `Quick Launch overlay (${quickHotkeyLabel})`,
                  bindings: [
                    ["Up / Down", "Move through results"],
                    ["Enter", "Run the selected row — launch, focus or place"],
                    [`${mod}+Enter`, "Launch in TouchPlayer instead"],
                    ["Enter (again)", "Confirm a destructive command (kill, relaunch)"],
                    ["Enter (nothing typed)", "Open the TDXLU window"],
                    [
                      `${qp.commands} / ${qp.tools} / ${qp.components} / ${qp.category} / ${qp.tag}`,
                      "Filter: commands / tool commands / components / folder / tag",
                    ],
                    ["Esc", "Cancel a pending confirm, else close the overlay"],
                  ],
                },
                {
                  cat: `Window switcher (${accelHint("windows.switcher") || "unbound"})`,
                  bindings: [
                    ["Up / Down", "Move through windows"],
                    ["Tab / Shift+Tab", "Same, from the keyboard home row"],
                    ["Enter", "Focus the selected window"],
                    ["Esc", "Close the switcher"],
                  ],
                },
              ].flatMap(({ cat, bindings }) => [
                <tr key={`cat-${cat}`} className="help-cat">
                  <td colSpan={2}>{cat}</td>
                </tr>,
                ...bindings.map(([key, action]) => (
                  <tr key={`${cat}-${key}`}>
                    <td>
                      <span className="kbd">{key}</span>
                    </td>
                    <td>{action}</td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>

          <h3 className="help-section">Customizable shortcuts</h3>
          <p className="help-tip">
            Click a binding and press the keys to change it (Esc cancels); assigning a combo
            takes it off whatever held it. <strong>Reset</strong> puts one back,{" "}
            <strong>Reset all to defaults</strong> puts all of them back. The table above is the
            fixed set — list navigation and the two overlays drive themselves.
          </p>
          <p className="help-tip">
            Single-letter bindings only fire when you aren&apos;t typing in a field, so{" "}
            <span className="kbd">V</span> still types a V into search.
          </p>
          {shortcutEditor}
          <p className="help-tip">
            {isMac
              ? "On macOS, the companion utility TOX is needed to sync recent files from TouchDesigner."
              : "Recent files are read directly from the Windows Registry — no setup needed."}
          </p>
          <p className="help-tip">
            Use the TouchPlayer checkbox in the version panel to launch projects in TouchPlayer instead.
          </p>

          <h3 className="help-section">
            Companion Utility TOX {isMac ? "(recommended)" : "(optional)"}
          </h3>
          <p className="help-tip">
            {isMac
              ? "Syncs recent files from TouchDesigner and auto-generates project icons from /perform."
              : "Auto-generates project icons from /perform when you save. Not needed for recent files."}
          </p>
          <p className="help-tip">
            {bundledUtilityTox ? (
              <>
                <code>TDXLauncherUtility.tox</code> ships with this app.{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => void installUtilityToPalette()}
                >
                  Install it to your Palette
                </button>{" "}
                to drag it into any project, or{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => void api.openPath(bundledUtilityTox)}
                >
                  reveal the file
                </button>
                . Each project needs it once — or put it in TouchDesigner&apos;s startup file
                and everything you build from scratch has it already.
              </>
            ) : (
              <>
                Download{" "}
                <button
                  type="button"
                  className="linkish"
                  disabled={utilityUpdateBusy}
                  onClick={() => void installUtilityUpdate()}
                >
                  the companion TOX
                </button>{" "}
                and drag it into each project&apos;s root network — or into TouchDesigner&apos;s
                startup file, so new projects have it already.
              </>
            )}
          </p>

          <p className="help-tip">
            {hintsOff ? (
              <>
                First-encounter tips are <strong>off</strong>.{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    restoreTips();
                    setStatusMsg("Tips turned back on");
                    setModal(null);
                  }}
                >
                  Turn them back on
                </button>{" "}
                to see them again from the start.
              </>
            ) : (
              <>
                Short tips pop up the first time you open a tab or a side panel, once each.{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    restoreTips();
                    setStatusMsg("First-run tips re-armed");
                    setModal(null);
                  }}
                >
                  Show them again
                </button>{" "}
                to replay them, or{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    disableHints();
                    setStatusMsg("Tips turned off");
                  }}
                >
                  turn them off
                </button>{" "}
                for good.
              </>
            )}
          </p>

          <div className="actions">
            <button onClick={startTour}>Start Tour</button>
            <button onClick={startWizard}>Setup Wizard</button>
            {bundledUtilityTox ? (
              <button onClick={() => void installUtilityToPalette()}>
                Install Utility to Palette
              </button>
            ) : (
              <button disabled={utilityUpdateBusy} onClick={() => void installUtilityUpdate()}>
                {utilityUpdateBusy ? "Downloading…" : "Download Utility TOX"}
              </button>
            )}
            <button className="primary" onClick={() => setModal(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {modal === "about" && (
        <Modal title="About" onClose={() => setModal(null)}>
          <p>
            <strong>TDX Launcher Ultra</strong> v{version}
          </p>
          <p>
            A project dashboard for TouchDesigner — launch .toe files with the correct build,
            browse recents & templates, edit README docs.
          </p>
          <p>
            Based on TD Launcher by EnviralDesign. Maintained by Function Store.
          </p>
          <p className="hint">
            Utility TOX: v{bundledUtilityVersion || "?"}
            {utilityUpdate ? (
              <>
                {" — "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setModal("utilityUpdate")}
                >
                  v{utilityUpdate.latestVersion} available
                </button>
              </>
            ) : null}
          </p>
          {FNS_ENABLED && license && license.provider !== "disabled" && (
            <p className="hint">
              Membership:{" "}
              {license.provider === "patreon"
                ? license.entitled
                  ? "Patreon, active"
                  : "Patreon, no active membership"
                : license.provider === "gumroad"
                  ? "Function Store account" /* adopted from the machine
                       session (fns-gate.md §5) — the toolkit minted it via a
                       licence key */
                  : "not signed in"}
              {(license.provider === "patreon" ||
                license.provider === "gumroad") && (
                <>
                  {" — "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      void api.licenseSignOut().then(setLicense);
                      setModal(null);
                    }}
                  >
                    Sign out
                  </button>
                </>
              )}
            </p>
          )}
          <div className="actions">
            {/* Not the repo: it's private, so a GitHub link is a dead end for users. */}
            <button onClick={() => api.openUrl("https://launcher.functionstore.tools")}>Website</button>
            <button
              onClick={() => {
                // Two independent channels — a manual check should poll both.
                void runAppUpdateCheck(true);
                void runUtilityUpdateCheck(true);
              }}
            >
              Check for updates
            </button>
            <button className="primary" onClick={() => setModal(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {modal === "clear" && (
        <Modal title="Clear Recent Files" onClose={() => setModal(null)}>
          <p>
            Clear all Recent Files history? This removes launcher-opened and synced TouchDesigner
            history from the list (not your files on disk).
          </p>
          <div className="actions">
            <button onClick={() => setModal(null)}>Cancel</button>
            <button
              className="primary"
              onClick={async () => {
                await api.clearRecents();
                await refreshLists(undefined, { rediscover: false });
                setSelectedPath(null);
                setModal(null);
              }}
            >
              Clear History
            </button>
          </div>
        </Modal>
      )}

      {modal === "remove" && removeTarget && (
        <Modal title="Remove from List" onClose={() => setModal(null)}>
          <p>
            Remove <strong>{basename(removeTarget)}</strong> from this list? This only removes it
            from TDX Launcher Ultra, not from your file system.
          </p>
          <div className="actions">
            <button onClick={() => setModal(null)}>Cancel</button>
            <button
              onClick={async () => {
                await updatePref({ confirm_remove_from_list: false });
                await onRemove(removeTarget, true);
                setModal(null);
              }}
            >
              Remove &amp; Don&apos;t Ask
            </button>
            <button
              className="primary"
              onClick={async () => {
                await onRemove(removeTarget, true);
                setModal(null);
              }}
            >
              Remove
            </button>
          </div>
        </Modal>
      )}

      {modal === "toxSource" && toxSourceTarget && (
        <Modal
          title="Load .tox from URL or GitHub"
          onClose={() => {
            setToxSourceTarget(null);
            setModal(null);
          }}
        >
          <div className="field">
            <label>Tox URL or GitHub owner/repo</label>
            <input
              autoFocus
              value={toxSourceDraft}
              placeholder="https://…/Foo.tox or org/repo#Asset.tox"
              onChange={(e) => setToxSourceDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && toxSourceDraft.trim()) {
                  void submitToxSource(toxSourceDraft);
                }
              }}
            />
            <RecentEntries
              entries={toxSourceHistory}
              onPick={setToxSourceDraft}
              onForget={(v) => setToxSourceHistory(forgetManualEntry("toxSource", v))}
            />
          </div>
          <p className="hint">
            Downloads into tox_cache, then loads into {toxSourceTarget.displayName}. GitHub sources
            resolve to the latest release asset.
          </p>
          <div className="actions">
            <button
              onClick={() => {
                setToxSourceTarget(null);
                setModal(null);
              }}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={!toxSourceDraft.trim()}
              onClick={() => void submitToxSource(toxSourceDraft)}
            >
              Load
            </button>
          </div>
        </Modal>
      )}

      {modal === "toolboxTool" && toolboxToolDraft && (
        <Modal
          title={toolboxToolDraft.id ? "Edit Toolbox Tool" : "Pin a Tool"}
          onClose={() => {
            setToolboxToolDraft(null);
            setModal(null);
          }}
        >
          {!toolboxToolDraft.id && (
            <div className="field">
              <label>Source type</label>
              <div className="toolbox-kind-picker">
                {(
                  [
                    ["local", "Local .tox"],
                    ["url", "URL / GitHub"],
                    ["package", "Package"],
                  ] as [ToolboxKind, string][]
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    className={`small${toolboxToolDraft.kind === kind ? " primary" : ""}`}
                    onClick={() =>
                      setToolboxToolDraft({ ...toolboxToolDraft, kind, source: "" })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <label>
              {toolboxToolDraft.kind === "local"
                ? "Path to .tox"
                : toolboxToolDraft.kind === "url"
                  ? "Tox URL or GitHub owner/repo"
                  : "Package spec"}
            </label>
            <div className="toolbox-source-row">
              <input
                autoFocus={!toolboxToolDraft.id}
                value={toolboxToolDraft.source}
                placeholder={
                  toolboxToolDraft.kind === "local"
                    ? "C:/…/MyTool.tox"
                    : toolboxToolDraft.kind === "url"
                      ? "https://…/Foo.tox or org/repo#Asset.tox"
                      : "tdp-mytool or git+https://…"
                }
                onChange={(e) =>
                  setToolboxToolDraft({ ...toolboxToolDraft, source: e.target.value })
                }
              />
              {toolboxToolDraft.kind === "local" && (
                <button
                  type="button"
                  className="small"
                  onClick={async () => {
                    const picked = await api.pickToxFiles(false);
                    if (picked[0]) {
                      setToolboxToolDraft((d) =>
                        d
                          ? {
                              ...d,
                              source: picked[0],
                              label: d.label || basename(picked[0]).replace(/\.tox$/i, ""),
                            }
                          : d,
                      );
                    }
                  }}
                >
                  Browse…
                </button>
              )}
            </div>
          </div>
          <div className="field">
            <label>Label</label>
            <input
              value={toolboxToolDraft.label}
              placeholder="Display name (from source if empty)"
              onChange={(e) =>
                setToolboxToolDraft({ ...toolboxToolDraft, label: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label>Category</label>
            <div className="toolbox-source-row">
              <select
                value={toolboxNewCategory.trim() ? "" : toolboxToolDraft.category}
                disabled={!!toolboxNewCategory.trim()}
                onChange={(e) =>
                  setToolboxToolDraft({ ...toolboxToolDraft, category: e.target.value })
                }
              >
                <option value="">Toolbox (top level)</option>
                {(toolbox?.categories ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                value={toolboxNewCategory}
                placeholder="…or new category"
                onChange={(e) => setToolboxNewCategory(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label>Notes (optional)</label>
            <input
              value={toolboxToolDraft.notes}
              placeholder="What / when to use it"
              onChange={(e) =>
                setToolboxToolDraft({ ...toolboxToolDraft, notes: e.target.value })
              }
            />
          </div>
          {toolboxToolDraft.kind === "url" && (
            <p className="hint">
              Fetched into tox_cache on save so it's draggable right away. GitHub sources resolve
              to the latest release asset — use ⟳ on the row later to update.
            </p>
          )}
          {toolboxToolDraft.kind === "package" && (
            <p className="hint">
              Package tools store the spec for reuse. Install into a running project via
              Sessions → Companion → Load ▾ → From package (packages live in each project's .venv).
            </p>
          )}
          <div className="actions">
            {toolboxToolDraft.id && (
              <button
                className="ghost danger"
                style={{ marginRight: "auto" }}
                onClick={async () => {
                  const id = toolboxToolDraft.id;
                  if (!id) return;
                  await toolboxRun(() => api.toolboxRemoveTool(id), "Removed from Toolbox");
                  setToolboxToolDraft(null);
                  setModal(null);
                }}
              >
                Remove
              </button>
            )}
            <button
              onClick={() => {
                setToolboxToolDraft(null);
                setModal(null);
              }}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={!toolboxToolDraft.source.trim()}
              onClick={() => void submitToolboxTool()}
            >
              {toolboxToolDraft.id ? "Save" : "Pin Tool"}
            </button>
          </div>
        </Modal>
      )}

      {modal === "appUpdate" && appUpdate && (
        <Modal
          title="Update Available"
          onClose={() => {
            if (!appUpdateBusy) setModal(null);
          }}
        >
          <p>
            TDX Launcher Ultra <strong>v{appUpdate.version}</strong> is available — you have v
            {version}.
          </p>
          {appUpdate.body ? (
            <div className="hint update-notes markdown">
              <ReactMarkdown>{appUpdate.body}</ReactMarkdown>
            </div>
          ) : null}
          <p className="hint">
            The update downloads in the background and the app relaunches when it's ready.
          </p>
          <div className="actions">
            <button disabled={appUpdateBusy} onClick={() => setModal(null)}>
              Later
            </button>
            <button
              disabled={appUpdateBusy}
              title="Stop announcing this version on startup. A newer one will still prompt, and Check for updates always shows it."
              onClick={() => {
                void updatePref({ skipped_app_version: appUpdate.version });
                setModal(null);
                setStatusMsg(`Skipped v${appUpdate.version} — you'll be told about the next one`);
              }}
            >
              Skip this version
            </button>
            <button
              className="primary"
              disabled={appUpdateBusy}
              onClick={() => void installAppUpdate()}
            >
              {appUpdateBusy ? "Downloading…" : "Install & Relaunch"}
            </button>
          </div>
        </Modal>
      )}

      {modal === "utilityUpdate" && utilityUpdate && (
        <Modal
          title={utilityUpdate.installed ? "Utility Update Available" : "Companion TOX Available"}
          onClose={() => {
            if (!utilityUpdateBusy) setModal(null);
          }}
        >
          <p>
            Companion TOX <strong>v{utilityUpdate.latestVersion}</strong>{" "}
            {utilityUpdate.installed ? (
              <>is available — you have v{utilityUpdate.currentVersion}.</>
            ) : (
              <>is available — this build doesn't ship one.</>
            )}
          </p>
          {utilityUpdate.notes ? (
            <div className="hint update-notes markdown">
              <ReactMarkdown>{utilityUpdate.notes}</ReactMarkdown>
            </div>
          ) : null}
          <p className="hint">
            This updates the launcher's copy only — the app itself is untouched and does not
            restart. To apply it to a project that's already open, use{" "}
            <strong>Update utility</strong> on that session afterwards.
          </p>
          <div className="actions">
            <button disabled={utilityUpdateBusy} onClick={() => setModal(null)}>
              Later
            </button>
            <button
              disabled={utilityUpdateBusy}
              title="Stop announcing this version on startup. A newer one will still prompt, and Check for updates always shows it."
              onClick={() => {
                void updatePref({ skipped_utility_version: utilityUpdate.latestVersion });
                setModal(null);
                setStatusMsg(
                  `Skipped utility v${utilityUpdate.latestVersion} — you'll be told about the next one`,
                );
              }}
            >
              Skip this version
            </button>
            <button
              className="primary"
              disabled={utilityUpdateBusy}
              onClick={() => void installUtilityUpdate()}
            >
              {utilityUpdateBusy ? "Downloading…" : `Download v${utilityUpdate.latestVersion}`}
            </button>
          </div>
        </Modal>
      )}

      {modal === "toolboxCategory" && toolboxCatDraft && (
        <Modal
          title={toolboxCatDraft.original ? "Edit Category" : "Add Category"}
          onClose={() => {
            setToolboxCatDraft(null);
            setModal(null);
          }}
        >
          <div className="field">
            <label>Category name</label>
            <input
              autoFocus
              value={toolboxCatDraft.name}
              placeholder="e.g. Generators, Utils, Show Control"
              onChange={(e) =>
                setToolboxCatDraft({ ...toolboxCatDraft, name: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && toolboxCatDraft.name.trim()) {
                  const { original, name } = toolboxCatDraft;
                  void toolboxRun(() =>
                    original
                      ? api.toolboxRenameCategory(original, name)
                      : api.toolboxAddCategory(name),
                  );
                  setToolboxCatDraft(null);
                  setModal(null);
                }
              }}
            />
          </div>
          {toolboxCatDraft.original && (
            <div className="field">
              <label>Order</label>
              <div className="toolbox-source-row">
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    const name = toolboxCatDraft.original;
                    if (name) void toolboxRun(() => api.toolboxMoveCategory(name, "up"));
                  }}
                >
                  ▲ Move up
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    const name = toolboxCatDraft.original;
                    if (name) void toolboxRun(() => api.toolboxMoveCategory(name, "down"));
                  }}
                >
                  ▼ Move down
                </button>
              </div>
            </div>
          )}
          {toolboxCatDraft.original && (
            <p className="hint">Removing a category keeps its tools — they move to the Toolbox top level.</p>
          )}
          <div className="actions">
            {toolboxCatDraft.original && (
              <button
                className="ghost danger"
                style={{ marginRight: "auto" }}
                onClick={async () => {
                  const name = toolboxCatDraft.original;
                  if (!name) return;
                  await toolboxRun(() => api.toolboxRemoveCategory(name), "Category removed");
                  setToolboxCatDraft(null);
                  setModal(null);
                }}
              >
                Remove
              </button>
            )}
            <button
              onClick={() => {
                setToolboxCatDraft(null);
                setModal(null);
              }}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={!toolboxCatDraft.name.trim()}
              onClick={() => {
                const { original, name } = toolboxCatDraft;
                void toolboxRun(() =>
                  original
                    ? api.toolboxRenameCategory(original, name)
                    : api.toolboxAddCategory(name),
                );
                setToolboxCatDraft(null);
                setModal(null);
              }}
            >
              {toolboxCatDraft.original ? "Save" : "Add Category"}
            </button>
          </div>
        </Modal>
      )}

      {modal === "tdpPackage" && tdpTarget && (
        <Modal
          wide
          className="modal-tdp"
          title="From package"
          onClose={() => {
            if (tdpBusy) return;
            setTdpTarget(null);
            setModal(null);
          }}
        >
          <p className="hint tdp-package-intro">
            {config?.package_index_prefix ? (
              <>
                Packages matching <code>{config.package_index_prefix}*</code> on your package index.
              </>
            ) : (
              <>Packages on your package index.</>
            )}{" "}
            Install into the project vEnv, then load <code>ToxFile</code>. Target:{" "}
            <strong>{tdpTarget.displayName}</strong>
            {tdpFromCache ? " · cached" : ""}
          </p>
          <div className="tdp-browser">
            <div className="tdp-browser-list">
              <div className="tdp-browser-toolbar">
                <input
                  value={tdpSearch}
                  disabled={tdpCatalogLoading}
                  onChange={(e) => setTdpSearch(e.target.value)}
                  placeholder="Search name, tags, summary…"
                />
                <button
                  type="button"
                  className="small"
                  disabled={tdpCatalogLoading || tdpBusy}
                  onClick={() => void loadTdpPypiCatalog(true)}
                  title="Refresh the package index"
                >
                  Refresh
                </button>
              </div>
              <div className="tdp-browser-scroll">
                {tdpCatalogLoading && <div className="hint">Loading package index…</div>}
                {tdpCatalogError && <div className="hint">{tdpCatalogError}</div>}
                {!tdpCatalogLoading && !tdpCatalogError && filteredTdpPackages.length === 0 && (
                  <div className="hint">
                    No packages matched. Use the custom spec below (git+ still works).
                  </div>
                )}
                {filteredTdpPackages.map((pkg) => (
                  <button
                    key={pkg.id}
                    type="button"
                    className={`tdp-browser-row${tdpSelectedId === pkg.id ? " selected" : ""}`}
                    disabled={tdpBusy}
                    onClick={() => setTdpSelectedId(pkg.id)}
                  >
                    <span className="tdp-browser-name">
                      {canonicalToolName(pkg.name)}
                      {pkg.version ? <em> {pkg.version}</em> : null}
                    </span>
                    <span className="tdp-browser-summary">{pkg.summary || "No summary"}</span>
                    {pkg.tags.length > 0 && (
                      <span className="tdp-browser-tags">
                        {pkg.tags.slice(0, 6).map((t) => (
                          <span key={t} className="tdp-tag">
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="tdp-browser-detail">
              {selectedTdpPackage ? (
                <>
                  <div className="tdp-browser-detail-head">
                    <strong>{selectedTdpPackage.name}</strong>
                    <span className="hint">{selectedTdpPackage.spec}</span>
                  </div>
                  <div className="tdp-browser-readme">
                    {tdpReadmeLoading ? (
                      <div className="hint">Loading README…</div>
                    ) : (
                      <ReactMarkdown>{tdpReadme || "_No README._"}</ReactMarkdown>
                    )}
                  </div>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={tdpBusy}
                      onClick={() =>
                        void installTdpIntoSession(
                          tdpTarget,
                          packageInstallSpec(selectedTdpPackage),
                        )
                      }
                    >
                      {tdpBusy ? "Installing…" : "Install & load"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="hint tdp-browser-empty">Select a package to preview its README</div>
              )}
            </div>
          </div>
          <div className="tdp-package-footer">
            <div className="field">
              <label>Custom uv / git / package spec</label>
              <input
                value={tdpCustomSpec}
                disabled={tdpBusy}
                onChange={(e) => setTdpCustomSpec(e.target.value)}
                placeholder="package-name or git+https://…#module.path"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tdpCustomSpec.trim() && !tdpBusy) {
                    void installTdpIntoSession(tdpTarget, tdpCustomSpec.trim());
                  }
                }}
              />
              <RecentEntries
                entries={tdpSpecHistory}
                disabled={tdpBusy}
                onPick={setTdpCustomSpec}
                onForget={(v) => setTdpSpecHistory(forgetManualEntry("tdpSpec", v))}
              />
            </div>
            <div className="actions">
              <button
                disabled={tdpBusy}
                onClick={() => {
                  setTdpTarget(null);
                  setModal(null);
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={tdpBusy || !tdpCustomSpec.trim()}
                onClick={() => void installTdpIntoSession(tdpTarget, tdpCustomSpec.trim())}
              >
                {tdpBusy ? "Installing…" : "Install custom"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modal === "autosave" &&
        autosaveTarget &&
        (() => {
          const target = autosaveTarget;
          const state = autosaveByPath[target.path] ?? null;
          const close = () => {
            setAutosaveTarget(null);
            setModal(null);
          };
          return (
            <Modal title="Autosave" onClose={close}>
              <p className="hint">
                The FNS_Autosave package saves <strong>{target.displayName}</strong> from
                inside TouchDesigner, on its own timer. A save stalls the frame while the .toe is
                written, so pick an interval that suits the rig - and mind the two skips below
                for a show.
              </p>
              {autosaveError && <p className="hint warn">{autosaveError}</p>}
              {state && (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={state.active}
                      disabled={autosaveBusy}
                      onChange={(e) => void applyAutosave(target, { active: e.target.checked })}
                    />
                    Save automatically
                  </label>
                  <div className="field">
                    <label>Interval (minutes)</label>
                    <input
                      type="number"
                      min={0.5}
                      max={1440}
                      step={0.5}
                      value={autosaveIntervalDraft}
                      disabled={autosaveBusy}
                      onChange={(e) => setAutosaveIntervalDraft(e.target.value)}
                      onBlur={() => commitAutosaveInterval(target)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitAutosaveInterval(target);
                      }}
                    />
                  </div>
                  <div className="field">
                    <label>Save mode</label>
                    <select
                      value={state.mode}
                      disabled={autosaveBusy}
                      onChange={(e) =>
                        void applyAutosave(target, { mode: e.target.value as AutosaveMode })
                      }
                    >
                      <option value="td">TouchDesigner Save (follows its preferences)</option>
                      <option value="overwrite">Overwrite the open .toe</option>
                    </select>
                    <p className="hint">
                      {state.mode === "overwrite"
                        ? "Every save lands back in the .toe already open, whatever TD's Increment Filename preference says."
                        : "Plain TD Save: with Increment Filename on it writes a new numbered .toe each time, and Copy to Backup Folder still applies."}
                    </p>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={state.only_modified}
                      disabled={autosaveBusy}
                      onChange={(e) =>
                        void applyAutosave(target, { only_modified: e.target.checked })
                      }
                    />
                    Only save when something changed
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={state.skip_perform}
                      disabled={autosaveBusy}
                      onChange={(e) =>
                        void applyAutosave(target, { skip_perform: e.target.checked })
                      }
                    />
                    Skip while the project is in Perform Mode
                  </label>
                  {state.project_saved === false ? (
                    <p className="hint warn">
                      This project has never been saved to disk, so there is nothing to save
                      into. Save it once in TouchDesigner first.
                    </p>
                  ) : (
                    <p className="hint">
                      {state.status || "Off"}
                      {state.active && state.next_in != null
                        ? ` - next in ${Math.round(state.next_in)}s`
                        : ""}
                    </p>
                  )}
                </>
              )}
              <div className="actions">
                <button
                  type="button"
                  disabled={!state || autosaveBusy}
                  title="Save this session now, in the mode above"
                  onClick={() => void runAutosaveNow(target)}
                >
                  Save now
                </button>
                <button type="button" className="primary" onClick={close}>
                  Done
                </button>
              </div>
            </Modal>
          );
        })()}

      {modal === "cmdPrompt" &&
        cmdPrompt &&
        (() => {
          // Generic argument prompt for a surfaced registry command — the
          // launcher collects the declared params and ships them as strings;
          // the registry coerces + validates by style TD-side (its contract).
          const { item, cmd } = cmdPrompt;
          const params = cmd.params ?? [];
          const missing = params.filter(
            (p) => p.required && !(cmdPromptValues[p.name] ?? "").trim(),
          );
          const close = () => {
            setCmdPrompt(null);
            setModal(null);
          };
          const runNow = () => {
            const kwargs: Record<string, string> = {};
            for (const p of params) {
              const v = cmdPromptValues[p.name];
              if (v !== undefined && v !== "") kwargs[p.name] = v;
            }
            close();
            void runSessionCommand(item, cmd, kwargs);
          };
          const setVal = (name: string, v: string) =>
            setCmdPromptValues((prev) => ({ ...prev, [name]: v }));
          return (
            <Modal
              title={`${withInstance(cmd.label, cmd.instance)} — ${canonicalToolName(cmd.tool)}`}
              onClose={close}
              footer={
                <>
                  <button type="button" onClick={close}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={missing.length > 0}
                    title={
                      missing.length
                        ? `Required: ${missing.map((p) => p.label || p.name).join(", ")}`
                        : undefined
                    }
                    onClick={runNow}
                  >
                    Run
                  </button>
                </>
              }
            >
              {cmd.help && <p className="hint">{cmd.help}</p>}
              <div className="cmd-prompt-params">
                {params.map((p) => (
                  <label key={p.name} className="cmd-prompt-row" title={p.help || undefined}>
                    <span className="cmd-prompt-label">
                      {p.label || p.name}
                      {p.required ? " *" : ""}
                    </span>
                    {p.style === "toggle" ? (
                      <input
                        type="checkbox"
                        checked={(cmdPromptValues[p.name] ?? "off") === "on"}
                        onChange={(e) => setVal(p.name, e.target.checked ? "on" : "off")}
                      />
                    ) : p.style === "menu" ? (
                      <select
                        value={cmdPromptValues[p.name] ?? ""}
                        onChange={(e) => setVal(p.name, e.target.value)}
                      >
                        {(cmdPromptValues[p.name] ?? "") === "" && <option value="" />}
                        {(p.menu ?? []).map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        inputMode={
                          p.style === "int" || p.style === "float" ? "decimal" : undefined
                        }
                        value={cmdPromptValues[p.name] ?? ""}
                        placeholder={p.default !== undefined ? String(p.default) : undefined}
                        onChange={(e) => setVal(p.name, e.target.value)}
                      />
                    )}
                  </label>
                ))}
              </div>
            </Modal>
          );
        })()}

      {modal === "collectConfirm" &&
        collectTarget &&
        collectPlan &&
        (() => {
          const allFiles = collectPlan.files ?? [];
          const selected = allFiles.filter((f) => !collectExcluded.has(f.src));
          const selectedBytes = selected
            .filter((f) => !f.reuse)
            .reduce((sum, f) => sum + f.bytes, 0);
          const selectedFreeze = selected.reduce(
            (sum, f) => sum + (f.frozen_pars?.length ?? 0),
            0,
          );
          const nothingToDo =
            selected.length === 0 && (collectPlan.normalize?.length ?? 0) === 0;
          const close = () => {
            setCollectPlan(null);
            setCollectTarget(null);
            setModal(null);
          };
          return (
            <Modal title="Collect All & Save" onClose={close}>
              <p>
                Copy <strong>{selected.length}</strong>
                {selected.length !== allFiles.length ? ` of ${allFiles.length}` : ""}{" "}
                external file(s) ({formatBytes(selectedBytes)}) into{" "}
                <code>collected/</code> next to{" "}
                <strong>{collectTarget.displayName}</strong>, relink the references
                relative, then save the project. Untick a row to leave that file (and
                its references) untouched.
              </p>
              {(collectPlan.normalize?.length ?? 0) > 0 && (
                <p className="hint">
                  Also relinks {collectPlan.normalize?.length} absolute reference(s)
                  already inside the project folder (no copy needed).
                </p>
              )}
              <div className="collect-plan-list">
                {["video", "audio", "image", "geometry", "other"]
                  .map((cat) => ({
                    cat,
                    files: allFiles.filter((f) => (f.category || "other") === cat),
                  }))
                  .filter((g) => g.files.length > 0)
                  .map(({ cat, files }) => {
                    const groupSelected = files.filter(
                      (f) => !collectExcluded.has(f.src),
                    );
                    const allOn = groupSelected.length === files.length;
                    const someOn = groupSelected.length > 0 && !allOn;
                    const groupBytes = groupSelected
                      .filter((f) => !f.reuse)
                      .reduce((sum, f) => sum + f.bytes, 0);
                    const toggleGroup = (on: boolean) => {
                      setCollectExcluded((prev) => {
                        const next = new Set(prev);
                        for (const f of files) {
                          if (on) next.delete(f.src);
                          else next.add(f.src);
                        }
                        return next;
                      });
                    };
                    return (
                      <div key={cat}>
                        <label
                          className="collect-plan-group"
                          title={`Toggle all ${cat} files`}
                        >
                          <input
                            type="checkbox"
                            checked={allOn}
                            ref={(el) => {
                              if (el) el.indeterminate = someOn;
                            }}
                            onChange={(e) => toggleGroup(e.target.checked)}
                          />
                          <span className="collect-plan-group-name">{cat}</span>
                          <span className="collect-plan-size">
                            {groupSelected.length}/{files.length} ·{" "}
                            {formatBytes(groupBytes)}
                          </span>
                        </label>
                        {files.map((f) => {
                          const frozen = f.frozen_pars ?? [];
                          const users = [
                            ...f.pars,
                            ...frozen.map((fp) => `${fp.par} (expr: ${fp.expr})`),
                          ];
                          const checked = !collectExcluded.has(f.src);
                          return (
                            <label
                              key={f.dest}
                              className={`collect-plan-row${checked ? "" : " collect-plan-off"}`}
                              title={`${f.src}\n→ ${f.dest}\nUsed by: ${users.join(", ")}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setCollectExcluded((prev) => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.delete(f.src);
                                    else next.add(f.src);
                                    return next;
                                  });
                                }}
                              />
                              <span className="collect-plan-name">
                                {f.src.split("/").pop()}
                              </span>
                              {frozen.length > 0 && (
                                <span
                                  className="collect-plan-expr"
                                  title="Referenced from a Python expression — collecting freezes it to a constant relative path"
                                >
                                  expr
                                </span>
                              )}
                              <span className="collect-plan-dest">→ {f.dest}</span>
                              <span className="collect-plan-size">
                                {f.reuse ? "already collected" : formatBytes(f.bytes)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
              </div>
              {selectedFreeze > 0 && (
                <label
                  className="companion-persist"
                  title="Expression refs are collected by baking the evaluated file into a constant relative path — the authored expression is replaced (originals are recorded in the run results). Untick to leave expression-driven parameters untouched; files referenced only by expressions are then not copied."
                >
                  <input
                    type="checkbox"
                    checked={collectFreezeExpr}
                    onChange={(e) => setCollectFreezeExpr(e.target.checked)}
                  />
                  Freeze {selectedFreeze} expression reference(s) into constant paths
                </label>
              )}
              {(collectPlan.skipped?.length ?? 0) > 0 && (
                <p className="hint">
                  {collectPlan.skipped?.length} ref(s) left untouched: bind/export-driven,
                  missing on disk, or sequence patterns.
                </p>
              )}
              <p className="hint">Original files are copied, never moved or deleted.</p>
              <div className="actions">
                <button onClick={close}>Cancel</button>
                <button
                  className="primary"
                  disabled={nothingToDo}
                  title={nothingToDo ? "Nothing selected" : undefined}
                  onClick={() => void confirmCollectSave()}
                >
                  Collect &amp; save
                </button>
              </div>
            </Modal>
          );
        })()}

      {modal === "repointConfirm" &&
        repointTarget &&
        repointPlan &&
        (() => {
          const fixes = repointPlan.fixes ?? [];
          const selected = fixes.filter((f) => !repointExcluded.has(f.ref));
          const stuck = repointPlan.unresolved?.length ?? 0;
          const close = () => {
            setRepointPlan(null);
            setRepointTarget(null);
            setModal(null);
          };
          const toggle = (ref: string) =>
            setRepointExcluded((prev) => {
              const next = new Set(prev);
              if (next.has(ref)) next.delete(ref);
              else next.add(ref);
              return next;
            });
          return (
            <Modal title="Repoint assets" onClose={close}>
              <p>
                {repointPlan.in_backup_folder ? (
                  <>
                    <strong>{repointTarget.displayName}</strong> is running from its{" "}
                    <code>Backup/</code> folder, one level below the project it was
                    saved from — so its relative asset paths point at the wrong
                    place.
                  </>
                ) : (
                  <>
                    <strong>{repointTarget.displayName}</strong> has relative asset
                    paths that do not resolve from its current folder.
                  </>
                )}{" "}
                Re-point <strong>{selected.length}</strong>
                {selected.length !== fixes.length ? ` of ${fixes.length}` : ""}{" "}
                reference(s) at the folder that actually holds the files.
              </p>
              <div className="collect-plan-list">
                {fixes.map((f) => {
                  const checked = !repointExcluded.has(f.ref);
                  return (
                    <label
                      key={f.ref}
                      className={`collect-plan-row${checked ? "" : " collect-plan-off"}`}
                      title={`${f.op}.${f.par}\n${f.from}  →  ${f.to}\nResolves to: ${f.file}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(f.ref)}
                      />
                      <span className="collect-plan-name">{f.name}</span>
                      <span className="collect-plan-dest">{f.to}</span>
                    </label>
                  );
                })}
              </div>
              {stuck > 0 && (
                <p className="hint">
                  {stuck} other broken ref(s) point at files missing from every
                  folder level — those need the file back, not a re-point.
                </p>
              )}
              {(repointPlan.skipped?.length ?? 0) > 0 && (
                <p className="hint">
                  {repointPlan.skipped?.length} ref(s) left untouched:
                  expression- or bind-driven, where re-rooting would detach live
                  wiring.
                </p>
              )}
              <p className="hint">
                Applies to the running session only — the <code>.toe</code> on disk
                is not modified. Save in TD to keep it. Leaving it unsaved is
                usually right for a backup you are only inspecting: these paths
                are correct while it sits in <code>Backup/</code>, and would break
                again if the file is later copied back beside the project.
              </p>
              <div className="actions">
                <button onClick={close}>Not now</button>
                <button
                  className="primary"
                  disabled={selected.length === 0}
                  title={selected.length === 0 ? "Nothing selected" : undefined}
                  onClick={() => void confirmRepointAssets()}
                >
                  Repoint {selected.length} path(s)
                </button>
              </div>
            </Modal>
          );
        })()}

      {modal === "versions" && versionsFamily && (() => {
        const fam = versionsFamily;
        const sections: { id: string; label: string; hint?: string; rows: typeof fam.variants }[] = [
          { id: "head", label: "Head", rows: fam.variants.filter((v) => v.kind === "head") },
          {
            id: "increment",
            label: "Increments",
            hint: "TD's incremental saves next to the project",
            rows: fam.variants.filter((v) => v.kind === "increment"),
          },
          {
            id: "backup",
            label: "Backups",
            hint: "Copies TD retained in the Backup folder",
            rows: fam.variants.filter((v) => v.kind === "backup"),
          },
          {
            id: "crash",
            label: "Crash autosave",
            hint: "Saved when a session died — TD opens these in safe mode",
            rows: fam.variants.filter((v) => v.kind === "crash"),
          },
        ].filter((s) => s.rows.length > 0);
        const selBytes = fam.variants
          .filter((v) => pruneSel.has(v.path))
          .reduce((sum, v) => sum + v.size, 0);
        const copyCount = fam.variants.filter((v) => v.kind !== "head").length;
        const familySessionOpen = openProjects.some(
          (p) => p.alive && fam.member_paths.includes(normPath(p.path)),
        );
        const restoreRow = restoreTarget
          ? fam.variants.find((v) => v.path === restoreTarget) ?? null
          : null;
        // Mirrors max_ordinal in variants.rs: every numbered file counts,
        // crash autosaves included.
        const nextOrdinal = Math.max(0, ...fam.variants.map((v) => v.ordinal ?? 0)) + 1;
        return (
          <Modal
            title={`${fam.display_name} — versions`}
            wide
            className="modal-versions"
            onClose={closeVersionsDrawer}
            footer={
              restoreRow ? (
                <div className="versions-confirm">
                  <p>
                    Make <strong>{basename(restoreRow.path)}</strong> the project head?
                    {fam.head ? (
                      <>
                        {" "}
                        The current <strong>{basename(fam.head)}</strong> is preserved first as{" "}
                        <strong>{`${fam.display_name}.${nextOrdinal}.toe`}</strong> — nothing is
                        overwritten or deleted.
                      </>
                    ) : (
                      <> It becomes {`${fam.display_name}.toe`} (no current head exists).</>
                    )}
                  </p>
                  {familySessionOpen && (
                    <p className="hint warn">
                      A TouchDesigner session of this project is running — save or close it first,
                      or it may re-save the old head over the restore.
                    </p>
                  )}
                  <div className="actions">
                    <button disabled={variantsBusy} onClick={() => setRestoreTarget(null)}>
                      Cancel
                    </button>
                    <button
                      className="primary"
                      disabled={variantsBusy}
                      onClick={() => void confirmRestoreVariant()}
                    >
                      {variantsBusy ? "Restoring…" : "Restore as head"}
                    </button>
                  </div>
                </div>
              ) : pruneConfirm ? (
                <div className="versions-confirm">
                  <p>
                    Move <strong>{pruneSel.size}</strong> file{pruneSel.size === 1 ? "" : "s"} (
                    {formatBytes(selBytes)}) to the {trashName}? They stay recoverable there.
                  </p>
                  <div className="actions">
                    <button disabled={variantsBusy} onClick={() => setPruneConfirm(false)}>
                      Cancel
                    </button>
                    <button
                      className="primary danger"
                      disabled={variantsBusy}
                      onClick={() => void confirmPruneVariants()}
                    >
                      {variantsBusy ? "Moving…" : `Move to ${trashName}`}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="versions-footer">
                  <span className="hint">
                    {copyCount} version cop{copyCount === 1 ? "y" : "ies"} ·{" "}
                    {formatBytes(fam.reclaimable_bytes)} reclaimable
                  </span>
                  <div className="actions">
                    <button
                      disabled={pruneSel.size === 0 || variantsBusy}
                      title={
                        pruneSel.size
                          ? `Move the ${pruneSel.size} ticked file${pruneSel.size === 1 ? "" : "s"} to the ${trashName}`
                          : "Tick versions on the left to prune them"
                      }
                      onClick={() => setPruneConfirm(true)}
                    >
                      {pruneSel.size
                        ? `Recycle ${pruneSel.size} (${formatBytes(selBytes)})`
                        : "Recycle…"}
                    </button>
                    <button onClick={closeVersionsDrawer}>Close</button>
                  </div>
                </div>
              )
            }
          >
            <p className="hint versions-intro">
              Every copy of this project on disk. <strong>Launch</strong> opens a specific file;
              the card's Launch always fires the head. <strong>Restore</strong> makes a copy the
              new head, preserving the current one.
            </p>
            {sections.map((s) => (
              <div key={s.id} className="versions-section">
                <div className="versions-section-head">
                  <span>{s.label}</span>
                  {s.hint && <span className="hint">{s.hint}</span>}
                </div>
                {s.rows.map((v) => {
                  const isLastOpened =
                    !!fam.last_opened_variant &&
                    normPath(fam.last_opened_variant) === normPath(v.path);
                  return (
                    <div
                      key={v.path}
                      className={[
                        "variant-row",
                        v.kind,
                        pruneSel.has(v.path) ? "ticked" : "",
                        restoreTarget === v.path ? "restoring" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {v.kind !== "head" ? (
                        <input
                          type="checkbox"
                          checked={pruneSel.has(v.path)}
                          title={`Tick to include in Recycle (${trashName})`}
                          onChange={() => togglePruneSel(v.path)}
                        />
                      ) : (
                        <span className="variant-tick-spacer" />
                      )}
                      <span className="variant-name" title={v.path}>
                        {basename(v.path)}
                        {v.kind === "head" && <span className="variant-flag head">head</span>}
                        {isLastOpened && (
                          <span className="variant-flag">last opened</span>
                        )}
                      </span>
                      <span className="variant-when">{formatWhen(v.modified)}</span>
                      <span className="variant-size">{formatBytes(v.size)}</span>
                      <span className="variant-actions">
                        <button
                          className="ghost small"
                          title={`Launch ${basename(v.path)} — TD build detected from this file`}
                          onClick={() => void launchVariant(v.path)}
                        >
                          Launch
                        </button>
                        <button
                          className="ghost small"
                          title="Select in the launcher — inspect its TD build, pick a version"
                          onClick={() => selectVariantInLauncher(v.path)}
                        >
                          Select
                        </button>
                        <button
                          className="ghost small"
                          title={revealLabel}
                          onClick={() => void api.openPath(v.path)}
                        >
                          Reveal
                        </button>
                        <button
                          className="ghost small"
                          disabled={variantsBusy}
                          title={`Copy ${basename(v.path)} into a new numbered version — never overwrites`}
                          onClick={() => void duplicateVariant(v.path)}
                        >
                          Duplicate
                        </button>
                        {v.kind !== "head" && (
                          <button
                            className="ghost small"
                            title={`Make this the project head (${fam.display_name}.toe), preserving the current head`}
                            onClick={() => {
                              setPruneConfirm(false);
                              setRestoreTarget(v.path);
                            }}
                          >
                            Restore…
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </Modal>
        );
      })()}

      {modal === "phone" && (
        <Modal
          title="📱 Phone Remote"
          onClose={() => {
            setModal(null);
            setPhoneUrl(null);
            setPhoneQr(null);
            setPhoneErr(null);
          }}
        >
          {phoneErr ? (
            <>
              <p className="hint warn">Couldn't start the phone remote: {phoneErr}</p>
              <div className="actions">
                <button onClick={() => void startPhoneRemote()}>Retry</button>
              </div>
            </>
          ) : !phoneQr ? (
            <p className="hint">Starting…</p>
          ) : (
            <>
              <p>
                Scan with your phone&apos;s camera to open the <strong>fleet
                page</strong>: every running session, with launch, focus,
                relaunch and kill. Your phone must be on the{" "}
                <strong>same Wi-Fi</strong> as this computer.
              </p>
              <p className="hint">
                A session&apos;s own controls — exposed parameters, touch, save
                — come from the FNS_Remote package inside it, and the fleet page
                links straight to them. That is also where a restricted link to
                hand a client lives.
              </p>
              <div className="phone-qr">
                <img src={phoneQr} alt="Phone remote pairing QR code" width={260} height={260} />
              </div>
              {phoneUrl && (
                <div className="phone-url">
                  <code>{phoneUrl.split("#")[0]}</code>
                  <button
                    className="small ghost"
                    onClick={() =>
                      copyText(phoneUrl, "Pairing link copied")
                    }
                  >
                    Copy link
                  </button>
                </div>
              )}
              <p className="hint">
                Add it to your phone's home screen for one-tap access — the pairing stays valid
                across restarts. Windows may ask to allow TDXLU through the firewall the first
                time; allow it on private networks.
              </p>
              <div className="actions">
                <button
                  className="ghost danger"
                  title="Stop the server — the phone loses its connection. The link is kept, so starting again reuses it."
                  onClick={() => void stopPhoneRemote().then(() => setModal(null))}
                >
                  Stop server
                </button>
                <button
                  className="ghost"
                  title="Invalidate every shared link and generate a new code"
                  onClick={() => void regeneratePhoneToken()}
                >
                  Regenerate code
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    setModal(null);
                    setPhoneUrl(null);
                    setPhoneQr(null);
                  }}
                >
                  Done
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {modal === "kill" && killTarget && (
        <Modal
          title="Force-quit TouchDesigner"
          onClose={() => {
            setKillTarget(null);
            setModal(null);
          }}
        >
          <p>
            Kill <strong>{killTarget.displayName}</strong> (PID {killTarget.pid})?
          </p>
          <p className="hint">Unsaved work in that session will be lost.</p>
          <div className="actions">
            <button
              onClick={() => {
                setKillTarget(null);
                setModal(null);
              }}
            >
              Cancel
            </button>
            <button className="primary danger" onClick={() => void confirmKillOpenSession()}>
              Kill process
            </button>
          </div>
        </Modal>
      )}

      {modal === "safeMode" && safeModeTarget && (
        <Modal
          title="A CrashAutoSave copy already exists"
          onClose={() => {
            setSafeModeTarget(null);
            setModal(null);
          }}
        >
          <p>
            <strong>{basename(safeModeTarget.path)}</strong> is already there
            {safeModeTarget.modified
              ? `, saved ${new Date(safeModeTarget.modified * 1000).toLocaleString()}`
              : ""}
            .
          </p>
          <p className="hint">
            TouchDesigner writes its own crash autosaves under this name — if that file came
            from a real crash, replacing it loses the only copy of that work. Your project
            itself is untouched either way.
          </p>
          <div className="actions">
            <button
              onClick={() => {
                setSafeModeTarget(null);
                setModal(null);
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                const p = safeModeTarget.path;
                setSafeModeTarget(null);
                setModal(null);
                void api.openPath(p);
              }}
            >
              Reveal it
            </button>
            <button
              className="primary danger"
              disabled={variantsBusy}
              onClick={() => void runSafeModeCopy(safeModeTarget.item, true)}
            >
              Replace and run
            </button>
          </div>
        </Modal>
      )}

      {modal === "cliFallback" && buildInfo && selectedPath && (() => {
        const latest = newestMainlineKey(versionKeys);
        const closest = findMatchingVersionKey(buildInfo, versionKeys, usePlayer);
        const closestIsDistinct = closest && versionKeys.includes(closest) && closest !== latest;
        return (
          <Modal
            title={`${displayBuildInfo(buildInfo, usePlayer)} isn't installed`}
            onClose={() => setModal(null)}
          >
            <p>
              <strong>{basename(selectedPath)}</strong> was saved with{" "}
              {displayBuildInfo(buildInfo, usePlayer)}, which isn&rsquo;t on this machine.
              Which build should the launcher use when this happens?
            </p>
            <p className="hint">
              Opening a project in a build it wasn&rsquo;t saved with may offer to upgrade
              the file. Your answer is remembered — change it any time in{" "}
              <strong>Settings → General</strong>.
            </p>
            <div className="actions">
              <button onClick={() => void answerCliFallback(CLI_FALLBACK_ASK, null)}>
                Always let me pick
              </button>
              {closestIsDistinct && (
                <button
                  className="ghost"
                  title="The nearest installed build to the one this project wants"
                  onClick={() => void answerCliFallback(CLI_FALLBACK_CLOSEST, closest)}
                >
                  Closest ({versionNumeric(closest!)})
                </button>
              )}
              {latest && (
                <button
                  className="primary"
                  onClick={() => void answerCliFallback(CLI_FALLBACK_LATEST, latest)}
                >
                  Latest ({versionNumeric(latest)})
                </button>
              )}
            </div>
          </Modal>
        );
      })()}
      {modal === "alreadyOpen" && alreadyOpenTarget && (
        <Modal
          title="Already open"
          onClose={() => {
            setAlreadyOpenTarget(null);
            setModal(null);
          }}
        >
          <p>
            <strong>{alreadyOpenTarget.displayName}</strong> is already running
            {alreadyOpenTarget.instances > 1
              ? ` in ${alreadyOpenTarget.instances} TouchDesigner processes`
              : alreadyOpenTarget.pid != null
                ? ` (PID ${alreadyOpenTarget.pid})`
                : ""}
            .
          </p>
          <p className="hint">
            Opening it again gives you a second TouchDesigner process on the same file. Both
            read and write this project&apos;s <strong>externalized files</strong>, so
            whichever one you save from last wins — the other session&apos;s work is
            overwritten without warning.
          </p>
          <div className="actions">
            <button
              onClick={() => {
                setAlreadyOpenTarget(null);
                setModal(null);
              }}
            >
              Cancel
            </button>
            <button
              className="ghost danger"
              title="Open a second TouchDesigner process on this same project file"
              onClick={() => {
                const t = alreadyOpenTarget;
                setAlreadyOpenTarget(null);
                setModal(null);
                void runLaunch(t.path, t.versionKey, t.usePlayer, t.promote);
              }}
            >
              Open a second copy
            </button>
            <button
              className="primary"
              disabled={alreadyOpenTarget.pid == null}
              title={
                alreadyOpenTarget.pid != null
                  ? `Bring PID ${alreadyOpenTarget.pid} to the front`
                  : "No PID for the running session"
              }
              onClick={() => {
                const pid = alreadyOpenTarget.pid;
                setAlreadyOpenTarget(null);
                setModal(null);
                void focusOpenSession(pid);
              }}
            >
              Focus the running one
            </button>
          </div>
        </Modal>
      )}

      {modal === "relaunch" && relaunchTarget && (
        <Modal
          title="Relaunch project"
          onClose={() => {
            setRelaunchTarget(null);
            setModal(null);
          }}
        >
          <p>
            Relaunch <strong>{relaunchTarget.displayName}</strong>
            {relaunchTarget.usePlayer ? " with TouchPlayer" : ""}:
          </p>
          {/* The only place a version choice actually changes what happens. */}
          <label className="relaunch-version">
            <span>Version</span>
            <select
              value={relaunchTarget.versionKey}
              onChange={(e) =>
                setRelaunchTarget((t) => (t ? { ...t, versionKey: e.target.value } : t))
              }
            >
              {(relaunchTarget.usePlayer ? discover.players : discover.versions).map((v) => (
                <option key={v.key} value={v.key}>
                  {versionNumeric(v.key)}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row" style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
            <input
              type="checkbox"
              checked={relaunchKillFirst && relaunchTarget.pid != null}
              disabled={relaunchTarget.pid == null}
              onChange={(e) => setRelaunchKillFirst(e.target.checked)}
            />
            <span>
              Kill existing process first
              {relaunchTarget.pid != null ? ` (PID ${relaunchTarget.pid})` : " (no PID)"}
            </span>
          </label>
          <p className="hint">
            {relaunchKillFirst && relaunchTarget.pid != null
              ? "Unsaved work in the current session will be lost."
              : relaunchTarget.pid != null
                ? `This leaves PID ${relaunchTarget.pid} running: you get a second TouchDesigner process on the same project file, and both write its externalized files — the last save wins.`
                : "A second TouchDesigner instance may open alongside the existing one."}
          </p>
          <div className="actions">
            <button
              onClick={() => {
                setRelaunchTarget(null);
                setModal(null);
              }}
            >
              Cancel
            </button>
            <button className="primary" onClick={() => void confirmRelaunchOpenSession()}>
              Relaunch
            </button>
          </div>
        </Modal>
      )}

      {modal === "install" && (
        <Modal title="Download Complete" onClose={() => setModal(null)}>
          <p>Ready to install {displayBuildInfo(buildInfo, usePlayer)}</p>
          <p className="hint">{installerPath && basename(installerPath)}</p>
          <div className="actions">
            <button onClick={() => setModal(null)}>Later</button>
            <button className="primary" onClick={() => void onInstall()}>
              Install
            </button>
          </div>
        </Modal>
      )}

      {modal === "media" && selectedMedia.length > 0 && (
        <Modal title={`Media (${mediaIndex + 1}/${selectedMedia.length})`} onClose={() => setModal(null)} wide>
          <div className="media-viewer">
            <div className="media-viewer-main">
              {selectedMedia[mediaIndex]?.kind === "video" ? (
                <video
                  key={`${selectedMedia[mediaIndex].path}:${mediaVersion}`}
                  src={mediaSrc(selectedMedia[mediaIndex].path, "video", selectedMedia[mediaIndex].mtime ?? mediaVersion)}
                  controls
                  playsInline
                  autoPlay
                />
              ) : (
                <img
                  key={`${selectedMedia[mediaIndex].path}:${mediaVersion}`}
                  src={mediaSrc(selectedMedia[mediaIndex].path, "image", selectedMedia[mediaIndex].mtime ?? mediaVersion)}
                  alt={selectedMedia[mediaIndex].caption || ""}
                />
              )}
            </div>
            <div className="media-viewer-caption">
              {selectedMedia[mediaIndex].caption || basename(selectedMedia[mediaIndex].path)}
            </div>
            <div className="media-viewer-nav">
              <button
                type="button"
                disabled={mediaIndex <= 0}
                onClick={() => setMediaIndex((i) => Math.max(0, i - 1))}
              >
                ← Prev
              </button>
              <button
                type="button"
                onClick={() => void api.openPath(selectedMedia[mediaIndex].path)}
              >
                Open file
              </button>
              {selectedMediaFolder && (
                <button type="button" onClick={() => void api.openPath(selectedMediaFolder)}>
                  Open folder
                </button>
              )}
              <button
                type="button"
                disabled={mediaIndex >= selectedMedia.length - 1}
                onClick={() => setMediaIndex((i) => Math.min(selectedMedia.length - 1, i + 1))}
              >
                Next →
              </button>
            </div>
            <div className="media-thumbs media-thumbs-modal">
              {selectedMedia.map((m, i) => (
                <button
                  key={m.path}
                  type="button"
                  className={`media-thumb ${i === mediaIndex ? "active" : ""}`}
                  onClick={() => setMediaIndex(i)}
                >
                  {m.kind === "video" ? (
                    <video
                      src={mediaSrc(m.path, "video", m.mtime ?? mediaVersion)}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <img src={mediaSrc(m.path, "image", m.mtime ?? mediaVersion)} alt="" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {switcherOpen && (
        <WindowSwitcher
          projects={openProjects}
          onFocus={(entry) => void focusWindowEntry(entry)}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      {/* Built inline so checkmarks track state while the menu stays open. */}
      <ContextMenu
        menu={viewMenuAt ? { ...viewMenuAt, entries: viewMenu() } : null}
        onClose={() => setViewMenuAt(null)}
      />
      <ContextMenu
        menu={helpMenuAt ? { ...helpMenuAt, entries: helpMenu() } : null}
        onClose={() => setHelpMenuAt(null)}
      />
      {/* Companion Load ▾ — inline for the same reason: the persist toggle's
          checkmark must update while the menu is open. */}
      <ContextMenu
        menu={loadMenuAt ? { ...loadMenuAt, entries: companionLoadMenu() } : null}
        onClose={() => setLoadMenuAt(null)}
      />

      {tourOpen && (
        <TourOverlay
          steps={tourSteps}
          onClose={closeTour}
          onStepEnter={onTourStep}
          onSupport={() => void api.openUrl(SUPPORT_JOIN_URL)}
          theme={THEMES.some((t) => t.id === config.theme) ? (config.theme as ThemeId) : "classic"}
          onThemeChange={(t) => void updatePref({ theme: t })}
        />
      )}

      {hintNode}

      {wizardOpen && !tourOpen && (
        <SetupWizard
          isMac={isMac}
          config={config}
          updatePref={updatePref}
          versionKeys={versionKeys}
          patreonEnabled={patreonEnabled}
          bundledUtility={!!bundledUtilityTox}
          onInstallUtility={installUtilityForWizard}
          onDownloadUtility={() => void installUtilityUpdate()}
          autostartEnabled={autostartEnabled}
          onToggleAutostart={async (on) => {
            try {
              if (on) await enableAutostart();
              else await disableAutostart();
              const cur = await autostartIsEnabled();
              setAutostartEnabled(cur);
              setStatusMsg(cur ? "TDXLU will start at login" : "Start at login disabled");
            } catch (err) {
              setStatusMsg(`Autostart: ${err}`);
            }
          }}
          hotkeyStatus={hotkeyStatus}
          onToggleHotkey={(enabled) => {
            // Live — registers/unregisters immediately, no restart.
            setConfig((c) => (c ? { ...c, global_hotkey_enabled: enabled } : c));
            void api.setHotkeyEnabled(enabled).then(setHotkeyStatus);
          }}
          hotkeyStatusMain={hotkeyStatusMain}
          onToggleHotkeyMain={(enabled) => {
            setConfig((c) => (c ? { ...c, global_hotkey_main_enabled: enabled } : c));
            void api.setHotkeyEnabledMain(enabled).then(setHotkeyStatusMain);
          }}
          onOpenSettings={(section) => {
            closeWizard();
            openSettings(section);
          }}
          onClose={closeWizard}
        />
      )}

      {/* Membership modal — the launcher is free in full; a Function Store
          Patreon membership unlocks the FNSTools Plus packages. Activation is
          once per machine, then offline until the claim's own expiry; only
          update installs re-verify. */}
      {modal === "membership" && license && (
        <Modal
          title="FNSTools Plus"
          onClose={() => setModal(null)}
          footer={
            <div className="upgrade-footer">
              {licenseError && <p className="license-gate-error">{licenseError}</p>}
              {!license.entitled && (
                <div className="actions">
                  <button
                    className="primary"
                    disabled={licenseBusy !== null}
                    onClick={() => void licenseSignInPatreon()}
                  >
                    {licenseBusy === "patreon"
                      ? "Waiting for browser…"
                      : "Sign in with Patreon"}
                  </button>
                  {/* Signed in but not (or no longer) a member: a forced
                      re-check catches a pledge that just landed without a
                      second sign-in. */}
                  {(license.blockReason === "no_entitlement" ||
                    license.blockReason === "reauth_required") && (
                    <button
                      disabled={licenseBusy !== null}
                      onClick={() => void licenseRecheck()}
                    >
                      {licenseBusy === "recheck" ? "Checking…" : "Check again"}
                    </button>
                  )}
                </div>
              )}
              <div className="actions">
                {/* Members go to the creator page; everyone else to joining. */}
                <button
                  type="button"
                  onClick={() =>
                    api.openUrl(
                      license.entitled ? "https://www.patreon.com/function_store" : SUPPORT_JOIN_URL,
                    )
                  }
                >
                  {license.entitled ? "View on Patreon" : "Join on Patreon"}
                </button>
                <button className="primary" onClick={() => setModal(null)}>
                  Close
                </button>
              </div>
            </div>
          }
        >
          {license.blockReason === "reauth_required" ? (
            <p>
              Your membership needs a fresh check — <strong>Check again</strong> below (or
              a fresh Patreon sign-in) confirms it's still active.
            </p>
          ) : license.provider === "gumroad" ? (
            <p>
              Signed in with a Function Store account from FNSTools on this machine. The
              Plus packages it includes are unlocked in the <strong>FNSTools</strong> tab.
            </p>
          ) : license.entitled ? (
            <p>
              Membership is <strong>active</strong> via Patreon. The Plus packages your
              tier includes are unlocked in the <strong>FNSTools</strong> tab.
            </p>
          ) : license.blockReason === "no_entitlement" ? (
            <p>
              You're signed in, but this account has no active Function Store membership.
              If your pledge just landed, <strong>Check again</strong> below asks Patreon
              directly — no need to sign in twice.
            </p>
          ) : (
            <p>
              A Function Store Patreon membership unlocks the{" "}
              <strong>FNSTools Plus</strong> packages — see them in the FNSTools tab with
              the <strong>Plus</strong> filter.
            </p>
          )}
          <p className="hint">
            Everything in the launcher itself is free, with no account. Signing in happens
            once per machine and needs an internet connection; after that, membership is
            re-checked only when installing updates.
          </p>
        </Modal>
      )}
    </div>
  );
}

function scrollSelectedIntoList(el: HTMLElement) {
  const parent = el.parentElement;
  if (!parent) return;
  const pRect = parent.getBoundingClientRect();
  const cRect = el.getBoundingClientRect();
  if (cRect.top < pRect.top) {
    parent.scrollTop -= pRect.top - cRect.top;
  } else if (cRect.bottom > pRect.bottom) {
    parent.scrollTop += cRect.bottom - pRect.bottom;
  }
}

function VersionList({
  keys,
  selected,
  focus,
  best,
  layoutKey,
  onSelect,
}: {
  keys: string[];
  selected: string | null;
  focus: FocusArea;
  best?: string | null;
  /** Changes when download box appears/disappears so we re-scroll after layout. */
  layoutKey?: string;
  onSelect: (k: string) => void;
}) {
  const selectedRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!selected || !selectedRef.current) return;
    const el = selectedRef.current;
    scrollSelectedIntoList(el);
    // Download box / flex height can settle a frame later
    const id = requestAnimationFrame(() => scrollSelectedIntoList(el));
    return () => cancelAnimationFrame(id);
  }, [selected, keys, focus, layoutKey]);

  if (!keys.length) return <div className="hint">No versions found!</div>;
  const bestNum = best?.replace(/^Touch(Designer|Player)\./, "");
  return (
    <div className="version-list">
      {keys.map((k) => {
        const num = k.replace(/^Touch(Designer|Player)\./, "");
        const isSelected = k === selected;
        return (
          <div
            key={k}
            ref={isSelected ? selectedRef : undefined}
            className={[
              "version-item",
              isSelected ? "selected" : "",
              isSelected && focus === "versions" ? "focus-version" : "",
              bestNum && num === bestNum ? "best" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onSelect(k)}
          >
            {k}
          </div>
        );
      })}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide,
  className,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  /** Pinned below the scrolling body — for actions that must stay reachable (Save, …). */
  footer?: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={["modal", wide ? "modal-wide" : "", footer ? "modal-has-footer" : "", className]
          .filter(Boolean)
          .join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {footer ? <div className="modal-body">{children}</div> : children}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
