/** Lightweight UI state persistence (localStorage). Tab is intentionally not restored. */

// Type-only import (erased at build) — this module keeps its zero runtime deps.
import type { QuickSeenCommand } from "./types";

export type PersistedPanels = {
  gitOpen: boolean;
  backupOpen: boolean;
  watchOpen: boolean;
  mcpOpen: boolean;
  mediaOpen: boolean;
  controlOpen: boolean;
  tagsOpen: boolean;
};

const PANELS_KEY = "tdxlu.ui.panels";
const PANEL_RAIL_COLLAPSED_KEY = "tdxlu.ui.panelRailCollapsed";
const GIT_TAB_KEY = "tdxlu.ui.gitTab";
const COMPANION_DISMISSED_KEY = "tdxlu.ui.companionDismissed";
export const FACTORY_VERSION_KEY = "tdxlu.palette.factoryVersion";
export const PALETTE_EXPANDED_KEY = "tdxlu.palette.expanded";
export const TOOLBOX_OPEN_KEY = "tdxlu.toolbox.open";
/** Collapsed category names (default = all expanded). */
export const TOOLBOX_EXPANDED_KEY = "tdxlu.toolbox.collapsed";
export const TEMPLATE_VERSION_KEY = "tdxlu.templates.defaultVersion";

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadPanels(): PersistedPanels {
  const v = readJson<Partial<PersistedPanels>>(PANELS_KEY);
  return {
    gitOpen: !!v?.gitOpen,
    backupOpen: !!v?.backupOpen,
    watchOpen: !!v?.watchOpen,
    mcpOpen: !!v?.mcpOpen,
    mediaOpen: !!v?.mediaOpen,
    controlOpen: !!v?.controlOpen,
    tagsOpen: !!v?.tagsOpen,
  };
}

export function savePanels(panels: PersistedPanels) {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    /* ignore */
  }
}

export function loadPanelRailCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(PANEL_RAIL_COLLAPSED_KEY);
    return saved === null ? true : saved === "1";
  } catch {
    return true;
  }
}

export function savePanelRailCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(PANEL_RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function loadGitTab(): "changes" | "history" {
  try {
    const v = localStorage.getItem(GIT_TAB_KEY);
    return v === "history" ? "history" : "changes";
  } catch {
    return "changes";
  }
}

export function saveGitTab(tab: "changes" | "history") {
  try {
    localStorage.setItem(GIT_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

/** Sort order for the Git changes / Backup plan file lists. */
export type FileSort = "name" | "size-desc" | "size-asc";

const FILE_SORTS: FileSort[] = ["name", "size-desc", "size-asc"];

export function loadFileSort(key: string): FileSort {
  try {
    const v = localStorage.getItem(`tdxlu.ui.sort.${key}`) as FileSort | null;
    return v && FILE_SORTS.includes(v) ? v : "name";
  } catch {
    return "name";
  }
}

export function saveFileSort(key: string, sort: FileSort) {
  try {
    localStorage.setItem(`tdxlu.ui.sort.${key}`, sort);
  } catch {
    /* ignore */
  }
}

/**
 * Main file-list ordering. "default" keeps each tab's natural order —
 * recency on Recent, the user's manual order on Templates.
 */
export type ListSortField = "default" | "name" | "date" | "size";
export type ListSort = { field: ListSortField; reverse: boolean };

const LIST_SORT_KEY = "tdxlu.ui.listSort";
const LIST_SORT_FIELDS: ListSortField[] = ["default", "name", "date", "size"];

export function loadListSort(): ListSort {
  const v = readJson<ListSort>(LIST_SORT_KEY);
  if (!v || !LIST_SORT_FIELDS.includes(v.field)) return { field: "default", reverse: false };
  return { field: v.field, reverse: !!v.reverse };
}

export function saveListSort(sort: ListSort) {
  try {
    localStorage.setItem(LIST_SORT_KEY, JSON.stringify(sort));
  } catch {
    /* ignore */
  }
}

export function loadFactoryVersionKey(): string {
  try {
    return localStorage.getItem(FACTORY_VERSION_KEY) || "";
  } catch {
    return "";
  }
}

export function saveFactoryVersionKey(key: string) {
  try {
    if (key) localStorage.setItem(FACTORY_VERSION_KEY, key);
    else localStorage.removeItem(FACTORY_VERSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Things the user typed by hand — a tox URL / GitHub repo, a pip spec — kept so
 * the next "add" starts from what they already used instead of a blank field.
 */
export type ManualEntryKind = "toxSource" | "tdpSpec";

const MANUAL_ENTRIES_KEY = "tdxlu.ui.manualEntries";
const MANUAL_ENTRIES_MAX = 12;

type ManualEntryStore = Partial<Record<ManualEntryKind, string[]>>;

export function loadManualEntries(kind: ManualEntryKind): string[] {
  const all = readJson<ManualEntryStore>(MANUAL_ENTRIES_KEY);
  const list = all?.[kind];
  return Array.isArray(list) ? list.filter((v) => typeof v === "string" && v.trim()) : [];
}

function writeManualEntries(kind: ManualEntryKind, list: string[]): string[] {
  try {
    const all = readJson<ManualEntryStore>(MANUAL_ENTRIES_KEY) ?? {};
    all[kind] = list;
    localStorage.setItem(MANUAL_ENTRIES_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return list;
}

/** Most-recent-first, deduped case-insensitively, capped. Returns the new list. */
export function rememberManualEntry(kind: ManualEntryKind, value: string): string[] {
  const entry = value.trim();
  if (!entry) return loadManualEntries(kind);
  const lower = entry.toLowerCase();
  const next = [entry, ...loadManualEntries(kind).filter((v) => v.toLowerCase() !== lower)].slice(
    0,
    MANUAL_ENTRIES_MAX,
  );
  return writeManualEntries(kind, next);
}

export function forgetManualEntry(kind: ManualEntryKind, value: string): string[] {
  const lower = value.trim().toLowerCase();
  return writeManualEntries(
    kind,
    loadManualEntries(kind).filter((v) => v.toLowerCase() !== lower),
  );
}

const TOUR_SEEN_KEY = "tdxlu.ui.tourSeen";

/** Whether the first-run tour has already been shown (or skipped). */
export function loadTourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    return true; // storage broken — never nag with the tour
  }
}

export function saveTourSeen() {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

const HINTS_SEEN_KEY = "tdxlu.ui.hintsSeen";

/**
 * First-encounter hints ("coach marks") that have already been shown. One id
 * per hint; a hint is retired the moment it's displayed, never re-armed unless
 * the user asks for them again from Help.
 */
export function loadHintsSeen(): Set<string> {
  const v = readJson<string[]>(HINTS_SEEN_KEY);
  return new Set(Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);
}

export function saveHintsSeen(seen: Set<string>) {
  try {
    localStorage.setItem(HINTS_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    /* ignore */
  }
}

export function clearHintsSeen() {
  try {
    localStorage.removeItem(HINTS_SEEN_KEY);
  } catch {
    /* ignore */
  }
}

const HINTS_OFF_KEY = "tdxlu.ui.hintsDisabled";

/** User turned first-encounter hints off for good. Separate from "seen" so
 *  re-enabling doesn't resurrect every hint they already read. */
export function loadHintsDisabled(): boolean {
  try {
    return localStorage.getItem(HINTS_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHintsDisabled(off: boolean) {
  try {
    if (off) localStorage.setItem(HINTS_OFF_KEY, "1");
    else localStorage.removeItem(HINTS_OFF_KEY);
  } catch {
    /* ignore */
  }
}

const QUICK_HISTORY_KEY = "tdxlu.ui.quickHistory";
const QUICK_HISTORY_MAX = 50;

/** Quick-launch query history, most recent first (Alt+↑/↓ cycles it). */
export function loadQuickHistory(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_HISTORY_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Push one executed query: move-to-front dedup, capped. Returns the list. */
export function pushQuickHistory(query: string): string[] {
  const q = query.trim();
  const rest = loadQuickHistory().filter((s) => s !== q);
  const next = q ? [q, ...rest].slice(0, QUICK_HISTORY_MAX) : rest;
  try {
    localStorage.setItem(QUICK_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

const QUICK_SEEN_COMMANDS_KEY = "tdxlu.ui.quickSeenCommands";

/** Drain the pre-0.11 localStorage command catalog into the config-side
 *  shape and forget the key. The catalog lives in config now (it travels
 *  with a settings export and both windows read one truth); this hands the
 *  old per-webview history over once, on whichever window loads first. */
export function takeLegacyQuickSeenCommands(): QuickSeenCommand[] {
  try {
    const raw = localStorage.getItem(QUICK_SEEN_COMMANDS_KEY);
    if (!raw) return [];
    localStorage.removeItem(QUICK_SEEN_COMMANDS_KEY);
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((c) => !!c && typeof c.identity === "string" && typeof c.tool === "string")
      .map((c) => ({
        identity: c.identity,
        tool: c.tool,
        id: String(c.id ?? ""),
        label: String(c.label ?? ""),
        help: c.help || undefined,
        hidden: c.hidden || undefined,
        param_count: c.paramCount || undefined,
        params: Array.isArray(c.params) && c.params.length ? c.params : undefined,
        // Was milliseconds; the config catalog counts unix seconds.
        last_seen: typeof c.lastSeen === "number" ? c.lastSeen / 1000 : 0,
      }));
  } catch {
    return [];
  }
}

const LAST_UPDATE_CHECK_KEY = "tdxlu.updates.lastAutoCheck";

/** Epoch ms of the last automatic update check (0 = never). Automatic checks
 *  run at most once a day; a manual "Check for updates" ignores this. */
export function loadLastUpdateCheck(): number {
  try {
    return Number(localStorage.getItem(LAST_UPDATE_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function saveLastUpdateCheck(at: number) {
  try {
    localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(at));
  } catch {
    /* ignore */
  }
}

const COMPANION_NUDGE_KEY = "tdxlu.ui.companionNudgeOff";

/** Whether the user dismissed the "make the companion permanent" callout that
 *  rides the expanded card of a session without the TOX loaded.
 *
 *  Unlike a src/hints bubble this is NOT one-shot — the bar only appears for a
 *  session that is actually missing the companion, and until the user says
 *  otherwise that is worth nudging about every time. Default false = shown. */
export function loadCompanionNudgeOff(): boolean {
  try {
    return localStorage.getItem(COMPANION_NUDGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCompanionNudgeOff(off: boolean) {
  try {
    if (off) localStorage.setItem(COMPANION_NUDGE_KEY, "1");
    else localStorage.removeItem(COMPANION_NUDGE_KEY);
  } catch {
    /* ignore */
  }
}

const WIZARD_SEEN_KEY = "tdxlu.ui.wizardSeen";

/** Whether the post-install setup wizard has already been completed (or skipped). */
export function loadWizardSeen(): boolean {
  try {
    return localStorage.getItem(WIZARD_SEEN_KEY) === "1";
  } catch {
    return true; // storage broken — never nag with the wizard
  }
}

export function saveWizardSeen() {
  try {
    localStorage.setItem(WIZARD_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

export type PatreonCampaignView = "grid" | "list";
export type PatreonCampaignSort = "name" | "latest";

const PATREON_CAMPAIGN_VIEW_KEY = "tdxlu.patreon.campaignView";
const PATREON_CAMPAIGN_SORT_KEY = "tdxlu.patreon.campaignSort";

export function loadPatreonCampaignView(): PatreonCampaignView {
  try {
    return localStorage.getItem(PATREON_CAMPAIGN_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function savePatreonCampaignView(view: PatreonCampaignView) {
  try {
    localStorage.setItem(PATREON_CAMPAIGN_VIEW_KEY, view);
  } catch {
    /* ignore */
  }
}

export function loadPatreonCampaignSort(): PatreonCampaignSort {
  try {
    return localStorage.getItem(PATREON_CAMPAIGN_SORT_KEY) === "latest" ? "latest" : "name";
  } catch {
    return "name";
  }
}

export function savePatreonCampaignSort(sort: PatreonCampaignSort) {
  try {
    localStorage.setItem(PATREON_CAMPAIGN_SORT_KEY, sort);
  } catch {
    /* ignore */
  }
}

const PATREON_POSTS_FILES_ONLY_KEY = "tdxlu.patreon.postsFilesOnly";
const PATREON_CAMPAIGN_FILES_ONLY_KEY = "tdxlu.patreon.campaignFilesOnly";

/** Posts-list filter: hide posts with no .tox/.toe/.zip attachment. Default: shown. */
export function loadPatreonPostsFilesOnly(): boolean {
  try {
    return localStorage.getItem(PATREON_POSTS_FILES_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePatreonPostsFilesOnly(filesOnly: boolean) {
  try {
    localStorage.setItem(PATREON_POSTS_FILES_ONLY_KEY, filesOnly ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/**
 * Creators-list filter: hide creators with no known .tox/.toe/.zip post, and
 * switch the "Latest" sort from cheapest-available (any post) to the
 * expensive file-aware lookup. Default: off (cheap path, all creators shown).
 */
export function loadPatreonCampaignFilesOnly(): boolean {
  try {
    return localStorage.getItem(PATREON_CAMPAIGN_FILES_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePatreonCampaignFilesOnly(filesOnly: boolean) {
  try {
    localStorage.setItem(PATREON_CAMPAIGN_FILES_ONLY_KEY, filesOnly ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const PATREON_POSTS_HIDE_LOCKED_KEY = "tdxlu.patreon.postsHideLocked";

/** Posts-list filter: hide posts the user's tier can't view. Default: shown (including locked). */
export function loadPatreonPostsHideLocked(): boolean {
  try {
    return localStorage.getItem(PATREON_POSTS_HIDE_LOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePatreonPostsHideLocked(hideLocked: boolean) {
  try {
    localStorage.setItem(PATREON_POSTS_HIDE_LOCKED_KEY, hideLocked ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function loadTemplateDefaultVersion(): string {
  try {
    return localStorage.getItem(TEMPLATE_VERSION_KEY) || "latest";
  } catch {
    return "latest";
  }
}

export function saveTemplateDefaultVersion(key: string) {
  try {
    localStorage.setItem(TEMPLATE_VERSION_KEY, key || "latest");
  } catch {
    /* ignore */
  }
}

/**
 * Sessions whose "companion not loaded" bar the user dismissed, keyed
 * `<toe path>|<pid>`.
 *
 * Keyed by PID so the bar returns the moment the project is relaunched — a
 * new process is a new chance that the companion was added. Entries for
 * processes that are no longer running are pruned on load (see
 * pruneDismissedCompanions), which also makes PID reuse harmless: the old
 * key is gone before the number can come round again.
 */
export function loadDismissedCompanions(): string[] {
  const v = readJson<string[]>(COMPANION_DISMISSED_KEY);
  return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
}

export function saveDismissedCompanions(keys: string[]) {
  try {
    localStorage.setItem(COMPANION_DISMISSED_KEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}

/** Stable identity for one running session's dismissal. */
export function companionDismissKey(path: string, pid: number | null | undefined): string {
  return `${path}|${pid ?? "?"}`;
}
