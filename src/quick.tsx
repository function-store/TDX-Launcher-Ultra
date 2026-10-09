// Quick-launch overlay — a Raycast-style command palette in its own frameless
// always-on-top window (label "quick", built in lib.rs setup). The global
// hotkey summons it; one input fuzzy-searches projects, sessions, toolbox /
// palette / Patreon components, templates and commands. `>` filters to
// commands only; `?` filters to tool-announced commands (FNS_CommandRegistry
// in live sessions). The summon carries the foreground TD pid captured before
// the overlay stole focus, so the session it was summoned over ranks first
// and receives ambiguous actions; a tool command offered by several sessions
// that focus can't disambiguate descends into a session picker on Enter.
// Enter acts on the selected row (destructive verbs arm and need a second
// Enter) — with nothing typed and no row picked it raises the main launcher
// window. Esc backs out of the picker / a pending confirm, else dismisses.

import { Fragment, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emitTo } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { api } from "./api";
import {
  basename,
  canonicalToolName,
  findMatchingVersionKey,
  fuzzyScore,
  isToxPath,
  mainlineVersionKeys,
  newestMainlineKey,
  normPath,
  resolveTemplateVersion,
  splitPresetTarget,
  withInstance,
} from "./utils";
import { buildSessionActions, QUICK_SESSION_ACTION_IDS } from "./sessionActions";
import {
  loadQuickHistory,
  loadTemplateDefaultVersion,
  takeLegacyQuickSeenCommands,
  pushQuickHistory,
} from "./uiPersist";
import type {
  AppConfig,
  CachedPatreonTox,
  DiscoverResult,
  FnsCommandList,
  FnsCommandParam,
  FnsToolCommand,
  OpenProject,
  PaletteItem,
  ProjectFamily,
  RecentEntry,
  SessionWindow,
  ToolboxView,
} from "./types";
import { DEFAULT_TEMPLATE } from "./types";
import "./App.css";
import "./quick.css";

/** Tauri runtime present? False in a plain browser tab (and the web demo's
 *  shims), where OS-window calls must be skipped instead of thrown. */
const hasTauri = "__TAURI_INTERNALS__" in window;

type EntryType = "project" | "session" | "tox" | "template" | "verb" | "action" | "window" | "toolcmd";

/** One session a merged tool command can run in. `state` is that session's
 *  live value for the command (registry ≥ 1.6.0) — per-session, since the
 *  same toggle can be on in one project and off in another. */
type QuickCmdTarget = {
  path: string;
  pid: number | null;
  name: string;
  state?: boolean | string;
};

type QuickEntry = {
  id: string;
  type: EntryType;
  /** Right-edge kind label: project / session / toolbox / palette / patreon / template / command. */
  badge: string;
  title: string;
  subtitle: string;
  /** Name-weight haystack: the title plus invisible keywords. */
  searchText: string;
  /** Where it lives — palette folder, Toolbox category, Patreon creator,
   *  "Templates". Matched at near-name weight; `/x` tokens filter on it. */
  category?: string;
  /** Project tags. Matched at near-name weight; `#x` tokens filter on it. */
  tags?: string[];
  /** Secondary sort: newer first within equal scores. */
  recency: number;
  path?: string;
  pid?: number | null;
  draggable?: boolean;
  /** Session verb: which action to run. */
  verb?: "focus" | "save" | "snapshot" | "record" | "relaunch" | "kill";
  /** Tool command (type "toolcmd"): registry key executed via fns_run_command. */
  cmdKey?: string;
  /** Tool command: project-stable `tool#id` — the curation / favourites key. */
  identity?: string;
  /** Tool command: which copy of a multi-instance tool the row runs on
   *  (registry >= 1.11.0). Already folded into `title`; kept for display. */
  instance?: string;
  /** User favourite: pinned first in the bare lists, nudged on typed queries.
   *  Toggled with Ctrl+D or the row's star; shared with Settings and the
   *  in-TD palette's Commands tab through `quick_favorite_commands`. */
  favorite?: boolean;
  /** Where a successful run is recorded in the shared `command-usage.json`:
   *  the command's `tool#id` (a preset's TARGET identity). Set whatever the
   *  rank toggle says — recording always runs. */
  usageKey?: string;
  /** Ranking bonus from that file (0..8, summed across FNSTools and the
   *  launcher), only while "Rank by usage" is on. A tie-breaker: tiers are
   *  1000 apart, a favourite is +12. See command_usage.rs. */
  usage?: number;
  /** Tool command: every session offering this command. With `path` unset
   *  the target is ambiguous and Enter opens the session picker; with it
   *  set, ArrowRight still opens the picker to override the resolved
   *  target when there is more than one candidate. */
  targets?: QuickCmdTarget[];
  /** Tool command: declared user-suppliable arguments — Enter prompts for
   *  them (the arg flow) before running. */
  params?: FnsCommandParam[];
  /** Option row inside the arg flow (menu/toggle param): the value Enter
   *  submits for the current parameter. */
  argValue?: string;
  /** Inline argument values typed after the command in the query
   *  ("? rec 1"), mapped to the declared params in order. Enter runs
   *  directly when the remaining params are satisfied by defaults,
   *  else the arg prompt continues from the first missing one. */
  inlineArgs?: string[];
  /** Preset row: the baked values by param name. Combined with inline
   *  args (positional overlay wins) and shown pre-filled in the chips. */
  presetKwargs?: Record<string, string>;
  /** Built-in TD/system command: badged COMMAND, lives in the `>` listing
   *  (after tool commands) and stays out of the `?` tools listing. */
  builtin?: boolean;
  /** Tool command: live state chipped after the title — ON/OFF for booleans,
   *  the value for numbers/strings. The resolved session's value; unresolved
   *  rows only chip when every candidate session agrees. */
  state?: boolean | string;
  /** Belongs to the session the palette was summoned over — ranks first. */
  focused?: boolean;
  /** Needs a second Enter (armed state) before executing. */
  destructive?: boolean;
  /** Session rows: the OS windows this session owns, for the ArrowRight
   *  drill-in. Enter on the session still focuses the whole session. */
  windows?: SessionWindow[];
  /** Window rows: the OS handle to act on. */
  winId?: number;
  /**
   * Listed under the commands prefix (`>`) even though it isn't a verb or an
   * app action — "New default project" launches a path like a template, but
   * reads as something you DO, so it belongs in the command list too.
   */
  isCommand?: boolean;
};

/** A param's default, rendered the way the arg flow accepts it back. */
function paramDefaultLabel(p: FnsCommandParam): string {
  if (p.default == null) return "";
  if (p.style === "toggle") return p.default ? "on" : "off";
  return String(p.default);
}

/** A param's live current value, rendered the way the arg flow accepts it
 *  back: the param's own `current` (registry ≥ 1.6.0), else — for a
 *  single-param command declaring `state` — the command state (they are
 *  almost always the same value; explicit `current` wins). "" when neither
 *  is declared. */
function paramCurrentLabel(p: FnsCommandParam, entry: QuickEntry): string {
  const v =
    p.current !== undefined
      ? p.current
      : entry.params?.length === 1 && entry.state !== undefined
        ? entry.state
        : undefined;
  if (v === undefined) return "";
  return typeof v === "boolean" ? (v ? "on" : "off") : v;
}

/** What a typed-param prompt opens holding — the live value, so setting is
 *  nudge-and-enter instead of blind typing. Menu/toggle params pick from
 *  option rows (the current one is marked there), so they never seed the
 *  input: a seeded query would filter the other options away. */
function paramPrefill(p: FnsCommandParam, entry: QuickEntry): string {
  if (p.style === "menu" || p.style === "toggle") return "";
  return paramCurrentLabel(p, entry);
}

/** The state a merged row chips: the resolved session's, else the value all
 *  candidate sessions agree on — a conflicted merge shows no chip rather
 *  than a wrong one. */
function mergedState(
  targets: QuickCmdTarget[],
  resolved: QuickCmdTarget | undefined,
): boolean | string | undefined {
  if (resolved) return resolved.state;
  const vals = [...new Set(targets.map((t) => t.state))];
  return vals.length === 1 ? vals[0] : undefined;
}

/** What history stores for an executed entry: NOT the literal input — a
 *  partial word ("? to") replays to whatever ranks first, not necessarily
 *  what was run — but a canonical query that deterministically re-selects
 *  the executed entry: its list's prefix + the full title, plus any inline
 *  arg values that rode along. Toggling from a partial query then recalls
 *  as one exact, repeatable entry. */
function canonicalHistoryQuery(entry: QuickEntry, px: QuickPrefixes): string {
  const title = entry.title.trim();
  const inline = entry.inlineArgs?.length ? ` ${entry.inlineArgs.join(" ")}` : "";
  if (entry.type === "toolcmd")
    return `${entry.builtin ? px.commands : px.tools} ${title}${inline}`;
  if (entry.type === "verb" || entry.type === "action" || entry.isCommand)
    return `${px.commands} ${title}`;
  if (entry.type === "tox") return `${px.components} ${title}`;
  return title;
}

/** The five filter prefixes, user-customizable in Settings (single chars). */
type QuickPrefixes = {
  commands: string;
  components: string;
  category: string;
  tag: string;
  tools: string;
};

const DEFAULT_PREFIXES: QuickPrefixes = {
  commands: ">",
  components: "=",
  category: "/",
  tag: "#",
  tools: "?",
};

/** Config values win when each is one non-space char and none collide. */
function readPrefixes(cfg: AppConfig | null): QuickPrefixes {
  const clean = (v: string | undefined, fallback: string) => {
    const s = (v ?? "").trim();
    return s.length === 1 ? s : fallback;
  };
  const p: QuickPrefixes = {
    commands: clean(cfg?.quick_prefix_commands, DEFAULT_PREFIXES.commands),
    components: clean(cfg?.quick_prefix_components, DEFAULT_PREFIXES.components),
    category: clean(cfg?.quick_prefix_category, DEFAULT_PREFIXES.category),
    tag: clean(cfg?.quick_prefix_tag, DEFAULT_PREFIXES.tag),
    tools: clean(cfg?.quick_prefix_tools, DEFAULT_PREFIXES.tools),
  };
  const vals = Object.values(p);
  return new Set(vals).size === vals.length ? p : DEFAULT_PREFIXES;
}

/** `/live midi #show` → { catFilters: ["live"], tagFilters: ["show"], words: "midi" }. */
function parseQuery(
  raw: string,
  px: QuickPrefixes,
): {
  catFilters: string[];
  tagFilters: string[];
  words: string;
} {
  const catFilters: string[] = [];
  const tagFilters: string[] = [];
  const words: string[] = [];
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    if (tok.length > 1 && tok.startsWith(px.category)) catFilters.push(tok.slice(1));
    else if (tok.length > 1 && tok.startsWith(px.tag)) tagFilters.push(tok.slice(1));
    else if (tok !== px.category && tok !== px.tag) words.push(tok);
  }
  return { catFilters, tagFilters, words: words.join(" ") };
}

/**
 * Field-aware score: each query word takes its best hit across the fields,
 * weighted name > category/tags > path — a name hit on `blur` outranks a
 * path that merely contains it. 0 when any word misses everywhere.
 */
function scoreEntry(words: string, e: QuickEntry): number {
  if (!words) return 1;
  let total = 0;
  for (const w of words.split(/\s+/).filter(Boolean)) {
    const s = Math.max(
      fuzzyScore(w, e.searchText),
      e.category ? fuzzyScore(w, e.category) * 0.85 : 0,
      e.tags?.length ? fuzzyScore(w, e.tags.join(" ")) * 0.85 : 0,
      // Substring only on the path — subsequence over a long path matches
      // almost anything and buries the real hits in noise.
      e.path?.toLowerCase().includes(w) ? fuzzyScore(w, e.path) * 0.5 : 0,
    );
    if (s <= 0) return 0;
    total += s;
  }
  return total;
}

type QuickData = {
  config: AppConfig | null;
  families: ProjectFamily[];
  tagsByPath: Record<string, string[]>;
  sessions: OpenProject[];
  toolbox: ToolboxView | null;
  palette: PaletteItem[];
  patreon: CachedPatreonTox[];
  templates: string[];
  discover: DiscoverResult;
  dragIcon: string;
  /** Tool-announced commands per session (normalized .toe path), from the
   *  companion's FNS_CommandRegistry via `fns_commands`. */
  toolCommands: Record<string, FnsToolCommand[]>;
  /** `tool#id` -> usage bonus from the shared command-usage.json. */
  usage: Record<string, number>;
};

const EMPTY_DATA: QuickData = {
  config: null,
  families: [],
  tagsByPath: {},
  sessions: [],
  toolbox: null,
  palette: [],
  patreon: [],
  templates: [],
  discover: { versions: [], players: [] },
  dragIcon: "",
  toolCommands: {},
  usage: {},
};

/** Session path → last known tool commands, module-lived so a re-summon
 *  renders instantly while the background refetch is in flight. */
const toolCmdCache: Record<string, FnsToolCommand[]> = {};

/** Ask each live companion session for its registered tool commands.
 *  An old companion answers `unknown action` (an error here) — treated as
 *  "no commands", never surfaced. */
async function fetchToolCommands(
  sessions: OpenProject[],
): Promise<Record<string, FnsToolCommand[]>> {
  const out: Record<string, FnsToolCommand[]> = {};
  await Promise.all(
    sessions
      .filter((s) => s.alive && s.utility_available)
      .map(async (s) => {
        try {
          const res = (await api.openProjectUtility(
            s.path,
            "fns_commands",
            null,
          )) as FnsCommandList;
          if (res && res.ok !== false && Array.isArray(res.commands)) {
            out[normPath(s.path)] = res.commands;
          }
        } catch {
          /* no companion verb / bus down — no commands */
        }
      }),
  );
  return out;
}

/** Type weight added to the match score so e.g. sessions outrank palette rows. */
const TYPE_WEIGHT: Record<EntryType, number> = {
  // Window rows only ever exist inside the drill-in, where they are the whole
  // list — the weight is never actually compared against another type.
  window: 30,
  session: 30,
  project: 25,
  tox: 12,
  template: 8,
  toolcmd: 7,
  verb: 6,
  action: 5,
};

const VERB_LABEL: Record<NonNullable<QuickEntry["verb"]>, string> = {
  focus: "Focus",
  save: "Save",
  snapshot: "Thumbnail",
  record: "Preview video",
  relaunch: "Relaunch",
  kill: "Kill",
};

function buildEntries(d: QuickData, focusedPid: number | null): QuickEntry[] {
  const entries: QuickEntry[] = [];
  // The summoned-over session (foreground TD process at summon — any of its
  // windows counts, floating panes included) sorts first; its rows also carry
  // `focused` so scored searches rank them ahead.
  const aliveSessions = d.sessions
    .filter((s) => s.alive)
    .sort(
      (a, b) =>
        Number(b.pid != null && b.pid === focusedPid) -
        Number(a.pid != null && a.pid === focusedPid),
    );
  const sessionPaths = new Set(aliveSessions.map((s) => normPath(s.path)));

  for (const s of aliveSessions) {
    const isFocused = s.pid != null && s.pid === focusedPid;
    const bits: string[] = [];
    if (s.version_key) bits.push(s.version_key.replace(/^Touch(Designer|Player)\./, ""));
    if (s.pid != null) bits.push(`pid ${s.pid}`);
    entries.push({
      id: `session:${s.path}`,
      type: "session",
      badge: "session",
      title: s.display_name || basename(s.path),
      subtitle: `${isFocused ? "focused" : "running"} · ${bits.join(" · ")} — Enter focuses`,
      searchText: s.display_name || basename(s.path),
      // A running project keeps its tags — `#show` must find live shows too.
      tags: d.tagsByPath[normPath(s.path)],
      recency: s.started_at ?? Date.now() / 1000,
      path: s.path,
      pid: s.pid,
      focused: isFocused,
      // Drill-in fodder: ArrowRight lists these instead of leaving the only
      // way to reach one window a trip through the main window's list.
      windows: s.windows,
    });

    // Verb-first command rows: "> kill aurora" → Kill AuroraSet.
    const name = s.display_name || basename(s.path);
    const verbSubtitle: Record<NonNullable<QuickEntry["verb"]>, string> = {
      focus: "Bring the TD window to the front",
      save: "Save the project in place (companion)",
      snapshot: "Update project icon + preview.png (companion)",
      record: "Record preview.mp4 (companion)",
      relaunch: "Kill this session and relaunch the project",
      kill: "Terminate the TD process",
    };
    const verbs = buildSessionActions({
      alive: true,
      hasPid: s.pid != null,
      hasCompanion: s.utility_available === true,
      hasEnvoy: s.mcp_available,
      windowCount: s.windows.length,
    }).filter((a) => QUICK_SESSION_ACTION_IDS.has(a.id) && a.enabled);
    for (const action of verbs) {
      const verb = action.id as NonNullable<QuickEntry["verb"]>;
      entries.push({
        id: `verb:${verb}:${s.path}`,
        type: "verb",
        badge: "command",
        title: `${VERB_LABEL[verb]} ${name}`,
        subtitle: verbSubtitle[verb],
        searchText: `${VERB_LABEL[verb]} ${name}`,
        recency: s.started_at ?? 0,
        path: s.path,
        pid: s.pid,
        verb,
        destructive: action.destructive,
        focused: isFocused,
      });
    }
  }

  // Tool-announced commands (FNS_CommandRegistry): each live companion
  // session contributes what its tools registered at runtime. They ride the
  // `>` command list and own the `?` prefix; name-searchable without either.
  //
  // The same command key across several sessions merges into ONE row. The
  // target resolves silently when it can — a sole candidate, or the session
  // the palette was summoned over — otherwise the row carries its candidates
  // and Enter opens the session picker (see `pending` in QuickPalette).
  const cmdSessions = aliveSessions.filter(
    (s) => (d.toolCommands[normPath(s.path)] ?? []).length > 0,
  );
  // Curation: user overrides (config, keyed on the project-stable `tool#id`
  // identity) beat the tool's own declared default (`hidden` on the wire).
  const userHidden = new Set(d.config?.quick_hidden_commands ?? []);
  const userShown = new Set(d.config?.quick_shown_commands ?? []);
  const favorites = new Set(d.config?.quick_favorite_commands ?? []);
  // "Rank by usage" off = no bonus. Recording is unaffected (usageKey).
  const usage = d.config?.quick_rank_by_usage === false ? {} : d.usage;
  const commandVisible = (c: FnsToolCommand) => {
    const identity = `${c.tool}#${c.id}`;
    if (userShown.has(identity)) return true;
    if (userHidden.has(identity)) return false;
    return !c.hidden;
  };

  type CmdGroup = { cmd: FnsToolCommand; targets: QuickCmdTarget[]; recency: number };
  const byKey = new Map<string, CmdGroup>();
  // Unfiltered identity map: presets resolve against this, so a preset over
  // a hidden command still works — authoring a preset IS the opt-in. One
  // identity can have SEVERAL keys: a multi-instance tool registers each copy
  // on its own path, so the identity keeps a group per key rather than
  // folding every copy into whichever registered first.
  const byIdentity = new Map<string, Map<string, CmdGroup>>();
  for (const s of cmdSessions) {
    const name = s.display_name || basename(s.path);
    for (const c of d.toolCommands[normPath(s.path)] ?? []) {
      const copies = byIdentity.get(`${c.tool}#${c.id}`) ?? new Map<string, CmdGroup>();
      const all = copies.get(c.key) ?? { cmd: c, targets: [], recency: 0 };
      all.targets.push({ path: s.path, pid: s.pid ?? null, name, state: c.state });
      all.recency = Math.max(all.recency, s.started_at ?? 0);
      copies.set(c.key, all);
      byIdentity.set(`${c.tool}#${c.id}`, copies);
      if (!commandVisible(c)) continue;
      const g = byKey.get(c.key) ?? { cmd: c, targets: [], recency: 0 };
      g.targets.push({ path: s.path, pid: s.pid ?? null, name, state: c.state });
      g.recency = Math.max(g.recency, s.started_at ?? 0);
      byKey.set(c.key, g);
    }
  }
  for (const [key, g] of byKey) {
    const resolved =
      g.targets.length === 1
        ? g.targets[0]
        : g.targets.find((t) => t.pid != null && t.pid === focusedPid);
    // Always name the project a row runs in -- the list spans every open
    // session, so a sole source is still not necessarily the summoned-over
    // one. An unresolved row's candidate count shows as a number badge
    // (rendered from `targets`) and Enter asks.
    const suffix = resolved ? ` — ${resolved.name}` : "";
    entries.push({
      id: `toolcmd:${key}`,
      type: "toolcmd",
      // Declared params render as ghost chips after the title. Built-in
      // TD commands read as native commands, not third-party tool rows.
      badge: g.cmd.builtin ? "command" : "tool",
      // Copies of a multi-instance tool would otherwise be identical rows.
      title: withInstance(g.cmd.label, g.cmd.instance),
      subtitle: (g.cmd.help || `${canonicalToolName(g.cmd.tool)} command`) + suffix,
      searchText: `${g.cmd.label} ${g.cmd.tool} ${canonicalToolName(g.cmd.tool)} ${g.cmd.id} ${g.cmd.instance ?? ""}`,
      instance: g.cmd.instance,
      category: canonicalToolName(g.cmd.tool),
      recency: g.recency,
      path: resolved?.path,
      pid: resolved?.pid,
      cmdKey: key,
      identity: `${g.cmd.tool}#${g.cmd.id}`,
      favorite: favorites.has(`${g.cmd.tool}#${g.cmd.id}`) || undefined,
      usageKey: `${g.cmd.tool}#${g.cmd.id}`,
      usage: usage[`${g.cmd.tool}#${g.cmd.id}`] || undefined,
      targets: g.targets,
      params: g.cmd.params?.length ? g.cmd.params : undefined,
      builtin: g.cmd.builtin || undefined,
      state: mergedState(g.targets, resolved),
      focused: resolved != null && resolved.pid != null && resolved.pid === focusedPid,
    });
  }

  // User-authored presets: aliases over registered commands with baked
  // values. Rendered like commands (chips pre-filled), grouped under
  // "Presets"; dormant while the target isn't live in any session.
  for (const [pi, preset] of (d.config?.quick_command_presets ?? []).entries()) {
    // `tool#id` runs on every live copy; `tool#id@instance` pins one copy.
    const { identity: presetIdentity, instance: pinned } = splitPresetTarget(preset.target);
    const copies = [...(byIdentity.get(presetIdentity) ?? new Map<string, CmdGroup>()).entries()].filter(
      ([, g]) => pinned === undefined || g.cmd.instance === pinned,
    );
    if (!copies.length) continue; // dormant — target not in any live session
    // An unpinned preset over several live copies lists once per copy: running
    // "whichever registered first" is not a meaning anyone chose.
    const spread = pinned === undefined && copies.length > 1;
    for (const [key, g] of copies) {
    const resolved =
      g.targets.length === 1
        ? g.targets[0]
        : g.targets.find((t) => t.pid != null && t.pid === focusedPid);
    const kwargs = preset.kwargs ?? {};
    entries.push({
      id: `preset:${pi}:${preset.target}${spread ? `:${key}` : ""}`,
      type: "toolcmd",
      badge: "preset",
      title: withInstance(preset.label, spread ? g.cmd.instance : undefined),
      subtitle:
        withInstance(g.cmd.label, g.cmd.instance) +
        (resolved ? ` — ${resolved.name}` : ""),
      searchText: `${preset.label} ${g.cmd.tool} ${g.cmd.id} ${Object.values(kwargs).join(" ")}`,
      category: "Presets",
      recency: g.recency,
      path: resolved?.path,
      pid: resolved?.pid,
      cmdKey: key,
      targets: g.targets,
      params: g.cmd.params?.length ? g.cmd.params : undefined,
      presetKwargs: kwargs,
      // A preset counts against its target's tool#id (pin already split off).
      usageKey: presetIdentity,
      usage: usage[presetIdentity] || undefined,
      state: mergedState(g.targets, resolved),
      focused: resolved != null && resolved.pid != null && resolved.pid === focusedPid,
    });
    }
  }

  for (const f of d.families) {
    if (!f.variants.length) continue; // vanished from disk
    const launchPath = f.head ?? f.variants[0].path;
    // A project that's already running lives in the list as its session row.
    if (sessionPaths.has(normPath(launchPath))) continue;
    const tags = d.tagsByPath[normPath(launchPath)] ?? [];
    entries.push({
      id: `project:${f.key}`,
      type: "project",
      badge: "project",
      title: f.display_name,
      subtitle: tags.length ? `${f.dir} · ${tags.join(" ")}` : f.dir,
      searchText: f.display_name,
      tags,
      recency: f.latest_activity,
      path: launchPath,
    });
  }

  // One entry per distinct .tox file — a Toolbox tool that lives in the
  // Palette (or was fetched into the cache) wins over the raw folder row.
  const toxSeen = new Set<string>();
  const pushTox = (
    path: string,
    title: string,
    category: string,
    badge: string,
    keywords = "",
  ) => {
    const key = normPath(path);
    if (toxSeen.has(key)) return;
    toxSeen.add(key);
    entries.push({
      id: `tox:${key}`,
      type: "tox",
      badge,
      title,
      subtitle: category,
      searchText: keywords ? `${title} ${keywords}` : title,
      category,
      recency: 0,
      path,
      draggable: true,
    });
  };
  for (const t of d.toolbox?.tools ?? []) {
    if (!t.resolvedPath || !isToxPath(t.resolvedPath)) continue;
    pushTox(
      t.resolvedPath,
      t.label || basename(t.resolvedPath),
      `Toolbox${t.category ? ` / ${t.category}` : ""}`,
      "toolbox",
      t.notes,
    );
  }
  for (const p of d.palette) {
    pushTox(p.path, p.name, `${p.root_label}${p.folder ? ` / ${p.folder}` : ""}`, "palette");
  }
  for (const p of d.patreon) {
    pushTox(p.path, p.name, `Patreon / ${p.creator}`, "patreon");
  }

  entries.push({
    id: "template:__default__",
    type: "template",
    // Not "command": it now sits among the launch rows, where a COMMAND badge
    // between SESSION and PROJECT read as filed-in-the-wrong-place.
    badge: "new",
    title: "New default project",
    subtitle: "Launch TD with default startup",
    searchText: "open new default project blank empty startup untitled",
    category: "Templates",
    recency: 0,
    path: DEFAULT_TEMPLATE,
    isCommand: true,
  });
  for (const t of d.templates) {
    entries.push({
      id: `template:${t}`,
      type: "template",
      badge: "template",
      title: basename(t),
      subtitle: "Template",
      searchText: basename(t),
      category: "Templates",
      recency: 0,
      path: t,
    });
  }

  const actions: { id: string; title: string; subtitle: string; search: string }[] = [
    { id: "open", title: "Open TDXLU", subtitle: "Show the launcher window", search: "open tdxlu launcher window show" },
    { id: "settings", title: "Settings…", subtitle: "Open launcher settings", search: "settings preferences options config" },
    { id: "about", title: "About / Check for updates", subtitle: "Version info and updates", search: "about version check updates" },
  ];
  for (const a of actions) {
    entries.push({
      id: `action:${a.id}`,
      type: "action",
      badge: "command",
      title: a.title,
      subtitle: a.subtitle,
      searchText: a.search,
      recency: 0,
    });
  }
  return entries;
}

function QuickPalette() {
  const [data, setData] = useState<QuickData>(EMPTY_DATA);
  const [query, setQuery] = useState("");
  /** Selected row, or -1 for "nothing typed, nothing picked" — the state an
   *  untouched palette opens in, where Enter shows the launcher instead. */
  const [sel, setSel] = useState(-1);
  const [status, setStatus] = useState(hasTauri ? "" : "Not running inside TDXLU — preview only");
  /** Entry id of a destructive command waiting for its second Enter. */
  const [armed, setArmed] = useState<string | null>(null);
  /** TD process the palette was summoned over — the foreground pid captured
   *  Rust-side BEFORE the overlay stole focus (any TD window counts,
   *  floating panes included). null = not summoned over a session. */
  const [focusedPid, setFocusedPid] = useState<number | null>(null);
  /** Ambiguous tool command awaiting a session pick: the "sub-menu" state.
   *  While set, the list shows the command's candidate sessions. */
  const [pending, setPending] = useState<QuickEntry | null>(null);
  /** Query as it was when the picker opened — Esc restores it, so backing
   *  out lands on the view the user descended from. */
  const pendingQueryRef = useRef("");
  /** Executed-query history (most recent first), cycled with Alt+↑/↓ like a
   *  shell. `histIdx` -1 = the live draft, saved in `histDraft` so cycling
   *  back down past the newest entry restores what was being typed. */
  const historyRef = useRef<string[]>(loadQuickHistory());
  const histIdxRef = useRef(-1);
  const histDraftRef = useRef("");
  /** Argument prompt for a command with declared params: collects one value
   *  per param in order (typed params via the input, menu/toggle params via
   *  option rows), then runs with the gathered kwargs. `entry` carries the
   *  resolved target path. */
  const [argFlow, setArgFlow] = useState<{
    entry: QuickEntry;
    index: number;
    values: Record<string, string>;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // Has THIS summon actually held focus yet? Arms the blur dismiss — mirrors
  // the authoritative guard in Rust (lib.rs). A summon that never won
  // foreground (hotkey colliding with the Windows layout-switch combo, a UAC
  // prompt, a toast) must not dismiss itself on the blur that follows, which
  // is what made the overlay blink open and vanish.
  const focusedOnceRef = useRef(false);
  // When this summon started. Focus lost within a moment of being summoned is
  // the OS reshuffling foreground (a hotkey colliding with the Windows
  // layout-switch, a toast), not the user clicking away — mirrors the grace
  // window in Rust. Without it, focus that lands and is stolen milliseconds
  // later arms the dismiss and then immediately trips it.
  const shownAtRef = useRef(0);
  const dataRef = useRef(data);
  dataRef.current = data;

  const hide = useCallback(() => {
    setQuery("");
    setSel(-1);
    setStatus("");
    setArmed(null);
    setPending(null);
    setArgFlow(null);
    if (hasTauri) void getCurrentWindow().hide();
  }, []);

  const refresh = useCallback(async () => {
    try {
      // Sessions land the moment they arrive: the rest of this refresh
      // (families, project meta, the palette scan) can take a while, and the
      // stale list it replaces is missing whatever was opened since the last
      // summon — a session you just started must be there when you look.
      const sessionsP = api.openProjectsList().catch(() => null);
      void sessionsP.then((fresh) => {
        if (fresh) setData((d) => ({ ...d, sessions: fresh }));
      });
      const [config, recents, templates, toolbox, sessions, patreon, discover, dragIcon] =
        await Promise.all([
          api.getConfig(),
          api.getRecents(true),
          api.getTemplates(),
          api.getToolbox().catch(() => null),
          sessionsP.then((s) => s ?? ([] as OpenProject[])),
          api.patreonCachedTox().catch(() => [] as CachedPatreonTox[]),
          api.discoverVersions(),
          api.getDragIconPath().catch(() => ""),
        ]);
      // Separate from the batch above so an old launcher without the command
      // (or any failure) just means no bonus.
      const usage = await api.commandUsageBonuses().catch(() => ({}) as Record<string, number>);
      document.documentElement.setAttribute("data-theme", config?.theme ?? "classic");
      const families = await api
        .listProjectFamilies(
          ((recents ?? []) as RecentEntry[]).map((r) => ({
            path: r.path,
            last_opened: r.last_opened ?? null,
          })),
        )
        .catch(() => [] as ProjectFamily[]);
      const headPaths = (families ?? [])
        .filter((f) => f.variants.length)
        .map((f) => f.head ?? f.variants[0].path);
      const pmetas = headPaths.length ? await api.getProjectsMeta(headPaths).catch(() => []) : [];
      // Normalized keys — session paths and family head paths must both hit.
      const tagsByPath: Record<string, string[]> = {};
      for (const pm of pmetas ?? []) tagsByPath[normPath(pm.project_path)] = pm.meta.tags ?? [];
      // Palette scan needs the factory install for the TD-shipped folders;
      // newest mainline is the launcher's own fallback choice.
      let palette: PaletteItem[] = [];
      try {
        const withInstall = (discover?.versions ?? []).filter(
          (v) => v.install_path || v.app_path,
        );
        const key = newestMainlineKey(withInstall.map((v) => v.key));
        const factory = withInstall.find((v) => v.key === key);
        palette =
          (await api.getPaletteItems(factory?.install_path || factory?.app_path || null)) ?? [];
      } catch {
        /* palette optional */
      }
      setData({
        config: config ?? null,
        families: families ?? [],
        tagsByPath,
        sessions: sessions ?? [],
        toolbox: toolbox ?? null,
        palette,
        patreon: patreon ?? [],
        templates: templates ?? [],
        discover: discover ?? { versions: [], players: [] },
        dragIcon: dragIcon ?? "",
        // Last summon's commands render instantly; the refetch lands below.
        toolCommands: { ...toolCmdCache },
        usage: usage ?? {},
      });
      // One bus round-trip per companion session, off the critical path —
      // the palette renders without waiting and updates when this lands.
      void fetchToolCommands(sessions ?? []).then((fresh) => {
        // Replace, never merge: a session that stopped answering (companion
        // removed or reloading, bus down) must lose its rows, not keep
        // offering commands it can no longer run.
        for (const k of Object.keys(toolCmdCache)) delete toolCmdCache[k];
        Object.assign(toolCmdCache, fresh);
        // Everything fetched feeds the historical command catalog (what the
        // Settings curation list renders), including commands filtered from
        // display below. It lives in config, so it survives a reinstall and
        // rides along on a settings export.
        const now = Date.now() / 1000;
        // One sighting per identity: copies of a multi-instance tool share it,
        // so their instance labels are gathered here (the catalog keeps one
        // row per identity and would otherwise remember only the last copy).
        const instancesOf = new Map<string, Set<string>>();
        const sightings = new Map<string, FnsToolCommand>();
        for (const c of Object.values(fresh).flat()) {
          const identity = `${c.tool}#${c.id}`;
          if (!sightings.has(identity)) sightings.set(identity, c);
          if (c.instance) {
            const set = instancesOf.get(identity) ?? new Set<string>();
            set.add(c.instance);
            instancesOf.set(identity, set);
          }
        }
        void api
          .mergeQuickSeenCommands([
            ...takeLegacyQuickSeenCommands(),
            ...[...sightings.entries()].map(([identity, c]) => ({
              identity,
              tool: c.tool,
              id: c.id,
              label: c.label,
              help: c.help,
              hidden: c.hidden,
              builtin: c.builtin,
              param_count: c.params?.length || undefined,
              params: c.params?.length ? c.params : undefined,
              instances: instancesOf.has(identity)
                ? [...instancesOf.get(identity)!].sort()
                : undefined,
              last_seen: now,
            })),
          ])
          .catch(() => {
            /* catalog is a convenience — never block the palette on it */
          });
        setData((d) => ({ ...d, toolCommands: { ...toolCmdCache } }));
      });
    } catch (e) {
      setStatus(String(e));
    }
  }, []);

  // A companion appeared on the bus (launcher started after TD, utility
  // injected or reloaded): gather sessions + tool commands now, so the first
  // summon opens warm instead of popping commands in mid-view. Short delay —
  // the first hello can beat the registry's own init and the tools' deferred
  // registrations by a beat.
  useEffect(() => {
    let timer: number | undefined;
    const unlisten = listen("utility-hello", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 1500);
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // Summon protocol: reset, focus, refetch (stale data keeps rendering
  // meanwhile — the palette must feel instant).
  useEffect(() => {
    void refresh();
    const unlisten = listen("quick:open", (e) => {
      const pid = (e.payload as { focused_pid?: number | null } | null)?.focused_pid;
      setFocusedPid(typeof pid === "number" ? pid : null);
      focusedOnceRef.current = false;
      shownAtRef.current = Date.now();
      setQuery("");
      setSel(-1);
      setStatus("");
      setArmed(null);
      setPending(null);
      setArgFlow(null);
      histIdxRef.current = -1;
      histDraftRef.current = "";
      inputRef.current?.focus();
      inputRef.current?.select();
      void refresh();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // Dismiss when the window loses focus — except mid-drag (dragging a .tox
  // out inevitably blurs the overlay; it closes when the drag lands). The
  // AUTHORITATIVE dismiss lives in Rust (lib.rs, the quick window's
  // Focused(false) handler): this JS listener rides the tauri event bridge,
  // which drops window focus events often enough that the overlay used to
  // stay up after clicking away, and WKWebView never fires DOM blur when
  // the NSWindow resigns key. Kept as a best-effort fast path because it
  // also resets the query state.
  useEffect(() => {
    if (!hasTauri) return;
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        focusedOnceRef.current = true;
        return;
      }
      // Never landed — the blur is the failed summon, not the user leaving.
      if (!focusedOnceRef.current) return;
      // Landed, then was taken straight back off us.
      if (Date.now() - shownAtRef.current < 600) return;
      if (!draggingRef.current) hide();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [hide]);

  const entries = useMemo(() => buildEntries(data, focusedPid), [data, focusedPid]);
  const px = useMemo(() => readPrefixes(data.config), [data.config]);

  // Leading-prefix modes, Raycast style: `>` = commands only (verbs + app
  // actions + tool commands), `=` = components only (palette / Toolbox /
  // Patreon .tox), `?` = tool-announced commands only.
  const lead = query.trimStart();
  const commandMode = lead.startsWith(px.commands);
  const componentsMode = !commandMode && lead.startsWith(px.components);
  const toolsMode = !commandMode && !componentsMode && lead.startsWith(px.tools);
  const effectiveQuery =
    commandMode || componentsMode || toolsMode ? lead.slice(1).trim() : query.trim();
  const parsed = useMemo(
    () =>
      commandMode || toolsMode
        ? { catFilters: [], tagFilters: [], words: effectiveQuery }
        : parseQuery(effectiveQuery, px),
    [commandMode, toolsMode, effectiveQuery, px],
  );
  /** Category-browse mode: `/x` present — results group under folder headers. */
  const browsing = parsed.catFilters.length > 0;

  const results = useMemo(() => {
    // Arg flow: menu/toggle params present their options as pick rows;
    // typed params leave the list empty — the input IS the value.
    if (argFlow?.entry.params) {
      const p = argFlow.entry.params[argFlow.index];
      if (p.style === "menu" || p.style === "toggle") {
        const options = p.style === "toggle" ? ["on", "off"] : (p.menu ?? []);
        const words = query.trim();
        const def = paramDefaultLabel(p);
        const cur = paramCurrentLabel(p, argFlow.entry);
        return options
          .filter((o) => !words || fuzzyScore(words, o) > 0)
          .map(
            (o, i): QuickEntry => ({
              id: `argopt:${i}:${o}`,
              type: "toolcmd",
              badge: "value",
              title: o,
              subtitle: `${p.label || p.name}${
                o === cur ? " — current" : o === def ? " — default" : ""
              }`,
              searchText: o,
              recency: 0,
              argValue: o,
            }),
          );
      }
      return [];
    }

    // Window picker: ArrowRight on a session lists the OS windows it owns,
    // so a specific pane can be raised without hunting for it behind the
    // main window. Typing filters by title / pane path.
    if (pending?.type === "session" && pending.windows?.length) {
      const words = query.trim();
      return pending.windows
        .filter(
          (w) =>
            !words ||
            fuzzyScore(words, `${w.title} ${w.pane_owner ?? ""} ${w.pane_type ?? ""}`) > 0,
        )
        .map((w, i): QuickEntry => {
          const where = [
            w.pane_type ? w.pane_type.toLowerCase() : null,
            w.pane_owner,
            w.monitor ? `display ${w.monitor}${w.monitor_primary ? " (main)" : ""}` : null,
            w.minimized ? "minimized" : null,
          ].filter(Boolean);
          return {
            id: `win:${w.id}:${i}`,
            type: "window",
            badge: "window",
            title: w.title || pending.title,
            subtitle: `${where.join(" · ")} — Enter raises`,
            searchText: `${w.title} ${w.pane_owner ?? ""}`,
            recency: 0,
            path: pending.path,
            pid: w.pid,
            winId: w.id,
            focused: w.foreground,
          };
        });
    }

    // Session picker for an ambiguous tool command: the list becomes the
    // command's candidate sessions (typing filters them by project name).
    if (pending?.targets?.length) {
      const words = query.trim();
      return pending.targets
        .filter((t) => !words || fuzzyScore(words, `${t.name} ${basename(t.path)}`) > 0)
        .map(
          (t, i): QuickEntry => ({
            id: `pick:${i}:${t.path}`,
            type: "toolcmd",
            badge: "session",
            title: t.name,
            subtitle: `Run "${pending.title}" in this session`,
            searchText: t.name,
            recency: 0,
            path: t.path,
            pid: t.pid,
            cmdKey: pending.cmdKey,
            params: pending.params,
            inlineArgs: pending.inlineArgs,
            usageKey: pending.usageKey,
            focused: t.pid != null && t.pid === focusedPid,
          }),
        );
    }

    let pool = commandMode
      ? entries.filter(
          (e) =>
            e.type === "verb" || e.type === "action" || e.type === "toolcmd" || e.isCommand,
        )
      : componentsMode
        ? entries.filter((e) => e.type === "tox")
        : toolsMode
          ? // Third-party tool commands + presets; built-in TD commands
            // belong to the `>` world.
            entries.filter((e) => e.type === "toolcmd" && !e.builtin)
          : entries;

    // `/x` keeps entries whose category matches every filter; `#x` the same
    // for project tags. Entries without the field drop out — the filter names
    // a place (or tag) to look in.
    for (const f of parsed.catFilters) {
      pool = pool.filter((e) => e.category && fuzzyScore(f, e.category) > 0);
    }
    for (const f of parsed.tagFilters) {
      pool = pool.filter(
        (e) => e.tags?.length && e.tags.some((t) => fuzzyScore(f, t) > 0),
      );
    }

    if (!parsed.words && !browsing && !parsed.tagFilters.length) {
      if (commandMode) {
        // Bare ">": commands on the ACTIVE projects first (summoned-over
        // session ahead, then newest), then the user's favourite tool
        // commands, then the tools' other commands, then the built-in TD
        // commands, then "New default project", then the app actions —
        // doing beats configuring, and About shouldn't outrank starting
        // work.
        const rank = (e: QuickEntry) =>
          e.type === "verb"
            ? 0
            : e.type === "toolcmd"
              ? e.favorite
                ? 0.5
                : e.builtin
                  ? 2
                  : 1
              : e.isCommand
                ? 3
                : 4;
        return [...pool].sort(
          (a, b) =>
            rank(a) - rank(b) ||
            // Within a tier, the commands you actually run come first
            // (shared with FNSTools' palette). Never across tiers: session
            // verbs still lead, and doing still beats configuring.
            (b.usage ?? 0) - (a.usage ?? 0) ||
            Number(b.focused ?? false) - Number(a.focused ?? false) ||
            b.recency - a.recency,
        );
      }
      if (toolsMode) {
        // Bare "?": favourites first, then presets (the user's own moves),
        // then every tool-announced command grouped by tool.
        return [...pool]
          .sort(
            (a, b) =>
              Number(!!b.favorite) - Number(!!a.favorite) ||
              Number(!!b.presetKwargs) - Number(!!a.presetKwargs) ||
              // Used commands float up; the unused rest stays grouped by tool.
              (b.usage ?? 0) - (a.usage ?? 0) ||
              (a.category ?? "").localeCompare(b.category ?? "", undefined, {
                sensitivity: "base",
              }) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
          )
          .slice(0, 40);
      }
      if (componentsMode) {
        // Bare "=": the whole component library grouped by where it lives.
        return [...pool]
          .sort(
            (a, b) =>
              (a.category ?? "").localeCompare(b.category ?? "", undefined, {
                sensitivity: "base",
              }) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
          )
          .slice(0, 40);
      }
      // Empty query: what's running, then "New default project", then the
      // recent projects, then the app actions. Starting fresh is a launch
      // target like the rows around it — it sits with them, right under the
      // sessions, rather than filed away with Settings and About.
      const sessions = entries.filter((e) => e.type === "session");
      const newProject = entries.filter((e) => e.isCommand);
      const projects = entries
        .filter((e) => e.type === "project")
        .sort((a, b) => b.recency - a.recency)
        .slice(0, 8);
      const actions = entries.filter((e) => e.type === "action");
      return [...sessions, ...newProject, ...projects, ...actions];
    }

    const scored = pool
      .map((e) => {
        let score = scoreEntry(parsed.words, e);
        // Inline arguments, Raycast style: "? rec 1" — when the full query
        // misses a params-command, trailing tokens become values for its
        // declared params (in order) and the head must still match. The row
        // then previews the mapping and Enter can skip the prompt.
        if (score <= 0 && e.type === "toolcmd" && e.params?.length && parsed.words) {
          const tokens = parsed.words.split(/\s+/).filter(Boolean);
          const maxArgs = Math.min(e.params.length, tokens.length - 1);
          for (let k = 1; k <= maxArgs; k++) {
            const head = tokens.slice(0, tokens.length - k).join(" ");
            const s = scoreEntry(head, e);
            if (s > 0) {
              // The values land in the row's param chips — no subtitle text.
              // Each consumed token is an EXACT structural match (it fits a
              // declared param), so it scores like a strong word hit —
              // otherwise a row that incidentally contains the digits ("2"
              // in a "...2025..." session name) outranks the command the
              // args were typed for.
              //
              // One tier band per token (fuzzyScore's bands are 1000 wide,
              // with 0..700 of quality inside one). That is the smallest
              // amount that still means "worth a word": it clears any
              // within-tier quality an incidental match can have, and one
              // whole tier of genuinely better match still wins. It was 90
              // against the old ~100-point scale, which is the same
              // intention at the old magnitude.
              return {
                e: { ...e, inlineArgs: tokens.slice(tokens.length - k) },
                score: s + 1000 * k,
              };
            }
          }
        }
        return { e, score };
      })
      .filter((r) => r.score > 0);
    if (browsing) {
      // Browsing a folder: keep its contents together, alphabetical inside.
      return scored
        .sort(
          (a, b) =>
            (a.e.category ?? "").localeCompare(b.e.category ?? "", undefined, {
              sensitivity: "base",
            }) ||
            b.score - a.score ||
            a.e.title.localeCompare(b.e.title, undefined, { sensitivity: "base" }),
        )
        .slice(0, 40)
        .map((r) => r.e);
    }
    // The summoned-over session's rows get a nudge — enough to win ties
    // against sibling sessions, not enough to bury a clearly better match.
    // User-authored presets get a similar nudge over raw commands, and a
    // favourite a bigger one: the user said "this one", so on a tie (or a
    // near-tie) it wins, while a clearly better match still outranks it.
    //
    // These, and TYPE_WEIGHT, are single digits and tens against a score
    // whose tiers are 1000 apart with 0..700 of quality inside one. They
    // are therefore pure TIE-BREAKERS now: they decide two rows that match
    // equally well, and can never pull a row up past one that matches
    // better. That is what the sentences above already ask for, so they
    // were deliberately NOT rescaled when the scorer's magnitudes changed
    // — unlike the inline-args bonus, which meant "worth a whole word" and
    // was. If you want type or focus to outweigh match quality again, that
    // is a real ranking decision, not a constant to nudge.
    const weight = (r: { e: QuickEntry; score: number }) =>
      r.score +
      TYPE_WEIGHT[r.e.type] +
      (r.e.focused ? 8 : 0) +
      (r.e.presetKwargs ? 5 : 0) +
      (r.e.favorite ? 12 : 0) +
      // 0..8 from the shared usage file: settles ties and near-ties, never
      // beats a better match (tiers are 1000 apart) or a favourite alone.
      (r.e.usage ?? 0);
    return scored
      .sort((a, b) => weight(b) - weight(a) || b.e.recency - a.e.recency)
      .slice(0, 12)
      .map((r) => r.e);
  }, [entries, parsed, commandMode, componentsMode, toolsMode, browsing, pending, argFlow, query, focusedPid]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, results.length - 1)));
  }, [results]);

  // Keep the selected row in view while arrowing through the list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // Anything that changes what Enter would hit disarms a pending confirm.
  useEffect(() => {
    setArmed(null);
  }, [query, sel]);

  /** Raise a session's TouchDesigner windows.
   *
   *  Running a command or placing a component ACTS INSIDE TouchDesigner — it
   *  opens a dialog, a panel, or drops a COMP you want to see land — so the
   *  overlay hands the front to that session on its way out. Best-effort: a
   *  focus that fails must never read as an action that failed.
   *
   *  Always AFTER the action's reply, never before: the overlay's blur dismiss
   *  is enforced in Rust (lib.rs, the quick window's Focused(false) handler),
   *  so handing TD the front first would tear down the window that still has
   *  to show an error. */
  const focusSession = useCallback(async (pid: number | null | undefined) => {
    if (pid == null) return;
    try {
      await api.openProjectFocus(pid);
    } catch {
      /* the action already landed — focus is the courtesy, not the point */
    }
  }, []);

  const placeTargets = useMemo(() => {
    const list = data.sessions.filter((s) => s.alive && s.utility_available);
    // The summoned-over session receives the place — that's where the user
    // was working; "first companion in the list" is only the fallback.
    const i = focusedPid != null ? list.findIndex((s) => s.pid === focusedPid) : -1;
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
    return list;
  }, [data.sessions, focusedPid]);

  const launchToe = useCallback(
    async (path: string, forcePlayer: boolean, isTemplate: boolean) => {
      const d = dataRef.current;
      const keys = (forcePlayer ? d.discover.players : d.discover.versions).map((v) => v.key);
      let versionKey: string | null = null;
      if (isTemplate) {
        versionKey = resolveTemplateVersion(loadTemplateDefaultVersion(), mainlineVersionKeys(keys));
      } else {
        try {
          const info = await api.inspectToe(path);
          versionKey = info ? findMatchingVersionKey(info, keys, forcePlayer) : newestMainlineKey(keys);
        } catch {
          versionKey = newestMainlineKey(keys);
        }
      }
      if (!versionKey) {
        setStatus("No matching TD version installed");
        return;
      }
      try {
        await api.launchProject(path, versionKey, forcePlayer, path !== DEFAULT_TEMPLATE);
        hide();
      } catch (e) {
        setStatus(String(e));
      }
    },
    [hide],
  );

  const placeTox = useCallback(
    async (path: string) => {
      const target = placeTargets[0];
      if (!target) {
        setStatus("No running session with the companion utility — drag the row into TD instead");
        return;
      }
      setStatus(`Placing ${basename(path)} in ${target.display_name}…`);
      try {
        const result = await api.openProjectUtility(target.path, "load_tox", {
          path,
          persist: false,
        });
        const r = (result ?? {}) as { ok?: boolean; error?: string };
        if (r.ok === false) {
          setStatus(`Place failed: ${r.error ?? "unknown error"}`);
          return;
        }
        hide();
        // The COMP landed in a network you are not looking at — see it land.
        await focusSession(target.pid);
      } catch (e) {
        setStatus(String(e));
      }
    },
    [placeTargets, hide, focusSession],
  );

  const runVerb = useCallback(
    async (entry: QuickEntry) => {
      const session = dataRef.current.sessions.find(
        (s) => normPath(s.path) === normPath(entry.path ?? ""),
      );
      try {
        switch (entry.verb) {
          case "focus":
            if (entry.pid != null) await api.openProjectFocus(entry.pid);
            hide();
            return;
          case "save":
          case "snapshot":
          case "record": {
            const action = entry.verb === "save" ? "save" : entry.verb === "snapshot" ? "pulse" : "record";
            setStatus(`${VERB_LABEL[entry.verb]}…`);
            const result = await api.openProjectUtility(entry.path!, action, null);
            const r = (result ?? {}) as { ok?: boolean; error?: string };
            if (r.ok === false) {
              setStatus(`${VERB_LABEL[entry.verb!]} failed: ${r.error ?? "unknown error"}`);
              return;
            }
            hide();
            return;
          }
          case "kill":
            if (entry.pid != null) await api.openProjectKill(entry.pid);
            hide();
            return;
          case "relaunch": {
            // Same build the session runs now; detect from the file if unknown.
            let versionKey = session?.version_key ?? null;
            const player = session?.use_touchplayer ?? false;
            if (!versionKey) {
              const keys = (
                player ? dataRef.current.discover.players : dataRef.current.discover.versions
              ).map((v) => v.key);
              const info = await api.inspectToe(entry.path!).catch(() => null);
              versionKey = info ? findMatchingVersionKey(info, keys, player) : newestMainlineKey(keys);
            }
            if (!versionKey) {
              setStatus("No matching TD version installed");
              return;
            }
            await api.openProjectRelaunch(entry.path!, versionKey, player, true, entry.pid);
            hide();
            return;
          }
        }
      } catch (e) {
        setStatus(String(e));
      }
    },
    [hide],
  );

  /** Pin / unpin a tool command. The list lives in the launcher config
   *  (one source of truth with Settings and the in-TD palette); the local
   *  copy is patched first so the re-rank is immediate. */
  const toggleFavorite = useCallback(
    async (entry: QuickEntry) => {
      if (entry.type !== "toolcmd" || !entry.identity) return;
      const identity = entry.identity;
      const cur = data.config?.quick_favorite_commands ?? [];
      const on = !cur.includes(identity);
      const next = on ? [...cur, identity] : cur.filter((i) => i !== identity);
      setData((d) =>
        d.config ? { ...d, config: { ...d.config, quick_favorite_commands: next } } : d,
      );
      try {
        await api.updatePrefs({ quick_favorite_commands: next });
        setStatus(on ? `★ ${entry.title} pinned as a favourite` : `${entry.title} unpinned`);
      } catch (e) {
        setStatus(String(e));
      }
    },
    [data.config],
  );

  /** The session a command ran in — its own pid when the row resolved one,
   *  else the session at its path. Handed to `focusSession`. */
  const focusCommandTarget = useCallback(
    (entry: QuickEntry) =>
      focusSession(
        entry.pid ??
          dataRef.current.sessions.find(
            (s) => normPath(s.path) === normPath(entry.path ?? ""),
          )?.pid,
      ),
    [focusSession],
  );

  const runToolCommand = useCallback(
    async (entry: QuickEntry, kwargs?: Record<string, string>) => {
      if (!entry.path || !entry.cmdKey) return;
      setStatus(`Running ${entry.title}…`);
      try {
        // Values ride as strings; the registry coerces + validates them by
        // each param's declared style (single source of truth TD-side).
        const result = await api.openProjectUtility(entry.path, "fns_run_command", {
          key: entry.cmdKey,
          ...(kwargs && Object.keys(kwargs).length ? { kwargs } : {}),
        });
        const r = (result ?? {}) as { ok?: boolean; error?: string };
        if (r.ok === false) {
          setStatus(`${entry.title} failed: ${r.error ?? "unknown error"}`);
          return;
        }
        // Successful runs only (docs: FNSTools docs/CommandUsage.md).
        // Fire-and-forget: usage must never make a command that ran look failed.
        if (entry.usageKey) void api.commandUsageRecord(entry.usageKey).catch(() => {});
        hide();
        await focusCommandTarget(entry);
      } catch (e) {
        setStatus(String(e));
      }
    },
    [hide, focusCommandTarget],
  );

  /** Record the current param's value and step the arg flow — next param,
   *  or run with the collected kwargs. Empty value = use the default / omit
   *  (a missing required param is refused registry-side, legibly). */
  const advanceArg = useCallback(
    (raw: string) => {
      if (!argFlow?.entry.params) return;
      const p = argFlow.entry.params[argFlow.index];
      const values = { ...argFlow.values, [p.name]: raw.trim() };
      if (argFlow.index + 1 < argFlow.entry.params.length) {
        const next = argFlow.entry.params[argFlow.index + 1];
        setArgFlow({ ...argFlow, index: argFlow.index + 1, values });
        // Pre-fill a value already gathered (preset kwargs, a back-step) —
        // else the param's live current value — so Enter keeps it and
        // setting becomes nudge-and-enter instead of blind typing.
        setQuery(values[next.name] ?? paramPrefill(next, argFlow.entry));
        setSel(0);
        return;
      }
      setArgFlow(null);
      const kwargs: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v !== "") kwargs[k] = v;
      void runToolCommand(argFlow.entry, kwargs);
    },
    [argFlow, runToolCommand],
  );

  /** Step the arg flow backwards: previous param (its value back in the
   *  input for editing), or out to the view the command was picked from. */
  const backArg = useCallback(() => {
    if (!argFlow) return;
    if (argFlow.index > 0 && argFlow.entry.params) {
      const prev = argFlow.entry.params[argFlow.index - 1];
      setArgFlow({ ...argFlow, index: argFlow.index - 1 });
      setQuery(argFlow.values[prev.name] ?? "");
      setSel(0);
      return;
    }
    setArgFlow(null);
    setQuery(pendingQueryRef.current);
    setSel(pendingQueryRef.current.trim() ? 0 : -1);
  }, [argFlow]);

  const run = useCallback(
    async (entry: QuickEntry, forcePlayer = false) => {
      if (entry.destructive && armed !== entry.id) {
        setArmed(entry.id);
        return;
      }
      setArmed(null);
      // Acting on a typed query records the EXECUTED entry's canonical
      // query, not the typed fragment (top-level only — picker filters and
      // arg values are transient; their descent recorded its start here).
      if (!pending && !argFlow && entry.argValue == null && query.trim()) {
        historyRef.current = pushQuickHistory(canonicalHistoryQuery(entry, px));
        histIdxRef.current = -1;
      }
      switch (entry.type) {
        case "session":
          if (entry.pid != null) {
            try {
              await api.openProjectFocus(entry.pid);
              hide();
            } catch (e) {
              setStatus(String(e));
            }
          }
          return;
        case "verb":
          await runVerb(entry);
          return;
        case "toolcmd":
          if (entry.argValue != null) {
            // An option row inside the arg flow (menu/toggle param).
            advanceArg(entry.argValue);
            return;
          }
          if (!entry.path && entry.targets?.length) {
            // Ambiguous target — descend into the session picker.
            pendingQueryRef.current = query;
            setPending(entry);
            setQuery("");
            setSel(0);
            return;
          }
          if (entry.params?.length) {
            // Values gather by param NAME: preset kwargs first, inline-typed
            // tokens overlaid positionally. When everything left is satisfied
            // by defaults, run without prompting at all.
            const values: Record<string, string> = { ...(entry.presetKwargs ?? {}) };
            (entry.inlineArgs ?? []).forEach((v, i) => {
              const p = entry.params![i];
              if (p) values[p.name] = v;
            });
            const provided = Object.keys(values).length;
            const satisfied = entry.params.every(
              (p) => p.name in values || !p.required || p.default !== undefined,
            );
            if (provided && satisfied) {
              await runToolCommand(entry, values);
              return;
            }
            // Prompt from the first missing param (values pre-seeded). Keep
            // the back target from the picker descent when we came through.
            if (!pending) pendingQueryRef.current = query;
            setPending(null);
            const startIdx = Math.max(
              0,
              entry.params.findIndex((p) => !(p.name in values)),
            );
            setArgFlow({ entry, index: startIdx, values });
            setQuery(
              values[entry.params[startIdx].name] ??
                paramPrefill(entry.params[startIdx], entry),
            );
            setSel(0);
            return;
          }
          await runToolCommand(entry);
          return;
        case "project":
          if (entry.path) await launchToe(entry.path, forcePlayer, false);
          return;
        case "template":
          if (entry.path) await launchToe(entry.path, forcePlayer, true);
          return;
        case "tox":
          if (entry.path) await placeTox(entry.path);
          return;
        case "window":
          // Raise the one pane, not the whole session — that is the point of
          // having drilled in. A minimized window restores on focus.
          if (entry.winId != null) {
            try {
              await api.sessionWindowAction(entry.winId, "focus");
              hide();
            } catch (err) {
              setStatus(String(err));
            }
          }
          return;
        case "action": {
          const id = entry.id.replace(/^action:/, "");
          try {
            await api.showMainWindow();
            if (id !== "open") await emitTo("main", "quick-action", { id });
            hide();
          } catch (e) {
            setStatus(String(e));
          }
        }
      }
    },
    [armed, hide, launchToe, placeTox, runVerb, runToolCommand, advanceArg, pending, argFlow, query, px],
  );

  /** Raise the main launcher window — Enter's fallback with nothing picked. */
  const showLauncher = useCallback(async () => {
    try {
      await api.showMainWindow();
      hide();
    } catch (e) {
      setStatus(String(e));
    }
  }, [hide]);

  const beginDrag = useCallback(
    (entry: QuickEntry, e: React.DragEvent) => {
      e.preventDefault();
      if (!hasTauri || !entry.path || !isToxPath(entry.path)) return;
      draggingRef.current = true;
      // Tell the Rust-side blur dismiss to hold off while the drag is in
      // flight — the invoke lands before startDrag begins the OS drag
      // session, so the flag is set before the overlay blurs.
      void api.setQuickDragging(true);
      void startDrag({
        item: [entry.path],
        icon: dataRef.current.dragIcon || entry.path,
        mode: "copy",
      })
        .catch((err) => setStatus(String(err)))
        .finally(() => {
          draggingRef.current = false;
          void api.setQuickDragging(false);
          hide();
        });
    },
    [hide],
  );

  const onKeyDown = (e: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    target?: unknown;
    preventDefault: () => void;
  }) => {
    // Alt+↑/↓: cycle the executed-query history, shell style. ↓ past the
    // newest entry restores the draft that was being typed. Not inside the
    // picker / arg flow — the input means something else there.
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !pending && !argFlow) {
      e.preventDefault();
      const h = historyRef.current;
      if (!h.length) return;
      if (histIdxRef.current === -1) histDraftRef.current = query;
      const i = Math.max(
        -1,
        Math.min(h.length - 1, histIdxRef.current + (e.key === "ArrowUp" ? 1 : -1)),
      );
      histIdxRef.current = i;
      const next = i === -1 ? histDraftRef.current : h[i];
      setQuery(next);
      setSel(next.trim() ? 0 : -1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (armed) setArmed(null);
      else if (argFlow) backArg();
      else if (pending) {
        // Back out of the session picker to the view it was entered from.
        setPending(null);
        setQuery(pendingQueryRef.current);
        setSel(pendingQueryRef.current.trim() ? 0 : -1);
      } else hide();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // With nothing typed, arrowing off the top returns to no selection.
      setSel((s) => Math.max(s - 1, query.trim() ? 0 : -1));
    } else if (e.key === "ArrowRight") {
      // Descend into the session picker on demand — also for a RESOLVED tool
      // command, to override where it runs. Only with the caret at the end of
      // the input, so the key still edits text mid-query.
      const entry = sel >= 0 ? results[sel] : undefined;
      const el = inputRef.current;
      const caretAtEnd =
        !el || (el.selectionStart === el.value.length && el.selectionEnd === el.value.length);
      const canPickSession =
        entry?.type === "toolcmd" && entry.cmdKey && (entry.targets?.length ?? 0) > 1;
      // A session drills into its own windows.
      const canPickWindow = entry?.type === "session" && (entry.windows?.length ?? 0) > 0;
      if (!pending && !argFlow && caretAtEnd && (canPickSession || canPickWindow)) {
        e.preventDefault();
        pendingQueryRef.current = query;
        setPending(entry!);
        setQuery("");
        setSel(0);
      }
    } else if (e.key === "ArrowLeft") {
      // Mirror of ArrowRight: back out of the picker (caret at the start, so
      // the key still walks the caret through a typed filter).
      const el = inputRef.current;
      const caretAtStart = !el || (el.selectionStart === 0 && el.selectionEnd === 0);
      if (caretAtStart && argFlow) {
        e.preventDefault();
        backArg();
      } else if (caretAtStart && pending) {
        e.preventDefault();
        setPending(null);
        setQuery(pendingQueryRef.current);
        setSel(pendingQueryRef.current.trim() ? 0 : -1);
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
      // Ctrl+D: pin / unpin the selected tool command (bookmark muscle
      // memory). Not inside the picker / arg flow.
      const entry = sel >= 0 ? results[sel] : undefined;
      if (entry?.type === "toolcmd" && entry.identity && !entry.argValue && !pending && !argFlow) {
        e.preventDefault();
        void toggleFavorite(entry);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (argFlow?.entry.params) {
        const p = argFlow.entry.params[argFlow.index];
        if (p.style === "menu" || p.style === "toggle") {
          const entry = sel >= 0 ? results[sel] : undefined;
          if (entry?.argValue != null) advanceArg(entry.argValue);
        } else {
          // The input is the value; empty = default/omit.
          advanceArg(query);
        }
        return;
      }
      const entry = sel >= 0 ? results[sel] : undefined;
      if (entry) void run(entry, e.ctrlKey || e.metaKey);
      else if (!query.trim()) void showLauncher();
    } else if (e.target !== inputRef.current) {
      // DOM focus drifted off the input (a row click, a re-show where the
      // summon reset never landed) — pull it back so typing keeps working.
      inputRef.current?.focus();
    }
  };

  // Keys are handled at the DOCUMENT level, not on the shell div: the div
  // only sees keys while a descendant has DOM focus, and the summon reset
  // that refocuses the input rides the flaky event bridge (see the focus
  // effect above) — Esc used to die whenever that reset was dropped. The
  // document listener sees every key the webview gets, focus or no focus.
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKeyDownRef.current(e);
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  const selected = sel >= 0 ? results[sel] : undefined;
  const armedEntry = armed ? results.find((r) => r.id === armed) : null;
  const argParam = argFlow?.entry.params?.[argFlow.index];
  const argCurrent = argFlow && argParam ? paramCurrentLabel(argParam, argFlow.entry) : "";
  const hint = argFlow && argParam
    ? `${argFlow.entry.title} · ${argParam.label || argParam.name}${
        argCurrent ? ` (now ${argCurrent})` : ""
      }${
        argParam.required
          ? ""
          : paramDefaultLabel(argParam)
            ? ` (default ${paramDefaultLabel(argParam)})`
            : " (optional)"
      }${argParam.help ? ` — ${argParam.help}` : ""} · ↵ ${
        argFlow.index + 1 < (argFlow.entry.params?.length ?? 0) ? "next" : "run"
      } · esc/← back`
    : pending?.type === "session"
    ? `↵ raise the selected window of ${pending.title} · esc/← back`
    : pending
    ? `↵ run "${pending.title}" in the selected session · esc/← back`
    : armedEntry
    ? `⚠ Enter again to ${armedEntry.title}${
        armedEntry.verb === "kill" ? " — unsaved work is lost" : ""
      } · esc keeps it`
    : !selected
      ? `${query.trim() ? "" : "↵ open TDXLU · "}type to search — ${px.commands} commands · ${px.tools} tools · ${px.components} components · ${px.category}folder · ${px.tag}tag${historyRef.current.length ? " · alt+↑ history" : ""}`
      : selected.type === "tox"
        ? placeTargets.length
          ? `↵ place in ${placeTargets[0].display_name} · drag row into TD · esc close`
          : "drag row into a TD network · esc close"
        : selected.type === "session"
          ? `↵ focus session${
              selected.windows?.length ? " · → its windows" : ""
            } · ${px.commands} for commands · esc close`
          : selected.type === "verb"
            ? selected.destructive
              ? "↵ arm (second ↵ runs) · esc close"
              : "↵ run · esc close"
            : selected.type === "project" || selected.type === "template"
              ? "↵ launch · ctrl+↵ TouchPlayer · esc close"
              : selected.type === "toolcmd"
                ? !selected.path
                  ? "↵ choose session · ctrl+D ★ · esc close"
                  : (selected.targets?.length ?? 0) > 1
                    ? `↵ run in ${
                        selected.targets?.find((t) => t.path === selected.path)?.name ??
                        "session"
                      } · → choose session · ctrl+D ★ · esc close`
                    : "↵ run · ctrl+D ★ · esc close"
                : "↵ run · esc close";

  return (
    <div className="quick-shell">
      <input
        ref={inputRef}
        className="quick-input"
        placeholder={
          // The input IS the argument field / picker filter while a flow is
          // active — say so where the typing happens, not off in a corner.
          argFlow && argParam
            ? argParam.style === "menu" || argParam.style === "toggle"
              ? `${argParam.label || argParam.name} — pick a value (type to filter)`
              : `${argParam.label || argParam.name}${
                  argParam.style && argParam.style !== "str" ? ` (${argParam.style})` : ""
                }${
                  paramDefaultLabel(argParam)
                    ? ` — Enter keeps ${paramDefaultLabel(argParam)}`
                    : argParam.required
                      ? " — required"
                      : " — optional, Enter skips"
                }`
            : pending?.type === "session"
              ? `${pending.title} — pick a window (type to filter)`
              : pending
              ? `Run "${pending.title}" — pick a session (type to filter)`
              : `Search — ${px.commands} commands · ${px.tools} tools · ${px.components} components · ${px.category}folder · ${px.tag}tag`
        }
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          // Typing starts a fresh draft — history cycling restarts from it.
          histIdxRef.current = -1;
          // In the picker / arg flow a row is always the Enter target; only
          // the top-level empty state has the "nothing picked" -1.
          setSel(pending || argFlow || e.target.value.trim() ? 0 : -1);
        }}
      />
      <div className="quick-list" ref={listRef}>
        {results.length === 0 ? (
          <div className="quick-empty">
            {argFlow && argParam
              ? // The prompt itself lives in the input's placeholder; this
                // area carries the param's own help when it has any.
                argParam.help || "↵ continues"
              : pending
              ? "No matching session"
              : commandMode
                ? "No matching commands"
                : componentsMode
                  ? "No matching components"
                  : toolsMode
                    ? "No tool commands — tools in live sessions register them at runtime"
                    : browsing
                      ? "Nothing in a matching folder"
                      : "No matches"}
          </div>
        ) : (
          results.map((r, i) => (
            <Fragment key={r.id}>
            {(browsing || componentsMode || toolsMode) &&
              !pending &&
              r.category &&
              r.category !== results[i - 1]?.category && (
                <div className="quick-group-header">{r.category}</div>
              )}
            <div
              data-idx={i}
              className={[
                "quick-row",
                i === sel ? "selected" : "",
                armed === r.id ? "armed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable={!!r.draggable}
              onDragStart={(e) => beginDrag(r, e)}
              onMouseMove={() => setSel(i)}
              onClick={() => void run(r)}
              title={r.path ?? r.title}
            >
              <div className="quick-row-main">
                <span className="quick-title">
                  {r.title}
                  {r.state !== undefined &&
                    (typeof r.state === "boolean" ? (
                      <span
                        className={`quick-state ${r.state ? "on" : "off"}`}
                        title="Live state in the target session"
                      >
                        {r.state ? "ON" : "OFF"}
                      </span>
                    ) : (
                      <span className="quick-state val" title="Live value in the target session">
                        {r.state}
                      </span>
                    ))}
                  {r.params?.length ? (
                    <span className="quick-args">
                      {r.params.map((p, pi) => {
                        const v = r.inlineArgs?.[pi] ?? r.presetKwargs?.[p.name];
                        return (
                          <span key={p.name} className={`quick-arg${v != null ? " filled" : ""}`}>
                            {p.label || p.name}
                            {v != null ? ` ${v}` : ""}
                          </span>
                        );
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="quick-subtitle">
                  {armed === r.id ? "Enter again to confirm" : r.subtitle}
                </span>
              </div>
              {(r.targets?.length ?? 0) > 1 && (
                <span className="quick-badge count" title="Sessions offering this command">
                  {r.targets!.length}
                </span>
              )}
              {r.type === "session" && (r.windows?.length ?? 0) > 1 && (
                <span
                  className="quick-badge wins"
                  title={`${r.windows!.length} open windows — press → to pick one`}
                >
                  {"→ "}
                  {r.windows!.length}
                </span>
              )}
              {r.type === "toolcmd" && r.identity && !r.argValue && (
                <span
                  className={`quick-fav${r.favorite ? " on" : ""}`}
                  title={
                    r.favorite
                      ? "Favourite — click or Ctrl+D to unpin"
                      : "Pin as a favourite (Ctrl+D): first in the lists, here and in TD's palette"
                  }
                  onMouseDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void toggleFavorite(r);
                  }}
                >
                  {r.favorite ? "★" : "☆"}
                </span>
              )}
              <span className={`quick-badge ${r.badge}${r.destructive ? " danger" : ""}`}>
                {r.badge}
              </span>
            </div>
            </Fragment>
          ))
        )}
      </div>
      <div className="quick-footer">
        <span className={`quick-status${armedEntry ? " armed" : ""}`}>{status || hint}</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QuickPalette />
  </StrictMode>,
);
