import type {
  ListItem,
  ProjectFamily,
  RecentEntry,
  SessionInstance,
  SessionWindow,
} from "./types";
import { DEFAULT_TEMPLATE } from "./types";
import { fuzzyScore as tieredScore } from "./fuzzy";

/** The normalization family `member_paths` use: forward slashes + lowercase. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Collapse numbered autosaves: project.7.toe → project.toe group key */
export function collapseKey(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  const m = name.match(/^(.*)\.(\d+)\.toe$/i);
  if (m) {
    const dir = path.slice(0, path.length - name.length);
    return dir + m[1] + ".toe";
  }
  return path;
}

export function displayName(path: string, isDefault = false): string {
  if (isDefault || path === DEFAULT_TEMPLATE) return "Default (new project)";
  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  return name;
}

/** Hierarchical tags use `/`. Filter matches exact, parent, or child. */
export function tagsMatch(projectTags: string[], filter: string[]): boolean {
  if (!filter.length) return true;
  return filter.some((f) => {
    const needle = f.trim().replace(/^\/+|\/+$/g, "");
    if (!needle) return true;
    const n = needle.toLowerCase();
    return projectTags.some((t) => {
      const tag = t.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
      return tag === n || tag.startsWith(`${n}/`) || n.startsWith(`${tag}/`);
    });
  });
}

export function matchesSearch(path: string, filter: string): boolean {
  if (!filter.trim()) return true;
  const name = displayName(path).toLowerCase();
  const full = path.toLowerCase();
  let q = filter.trim().toLowerCase();

  // Wildcard mode (* = any run, ? = any single char) — match original fnmatch behavior
  if (q.includes("*") || q.includes("?")) {
    if (!q.startsWith("*")) q = `*${q}`;
    if (!q.endsWith("*")) q = `${q}*`;
    const re = new RegExp(
      "^" +
        q
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
      "i",
    );
    return re.test(name) || re.test(full);
  }

  return name.includes(q) || full.includes(q);
}

/** Is this file still on disk?
 *
 * `meta` is authoritative once fetched; until then fall back to the family,
 * whose variants come from a live directory scan — so a just-deleted file is
 * known to be gone before the next meta round-trip lands. Unknown counts as
 * present: never hide a row on missing information.
 */
function pathOnDisk(
  path: string,
  meta: Record<string, MetaEntry>,
  family?: ProjectFamily,
): boolean {
  const m = meta[path];
  if (m) return m.exists;
  if (family) return family.variants.some((v) => normPath(v.path) === normPath(path));
  return true;
}

export function buildRecentItems(
  recents: RecentEntry[],
  meta: Record<string, MetaEntry>,
  collapse: boolean,
  filter: string,
  activePath?: string | null,
  families?: ProjectFamily[],
): ListItem[] {
  const familyByPath = new Map<string, ProjectFamily>();
  for (const f of families ?? []) {
    for (const mp of f.member_paths) familyByPath.set(mp, f);
  }

  type Row = { path: string; family?: ProjectFamily };
  const rows: Row[] = [];
  const seen = new Set<string>();
  /** Family keys that already produced (or will produce) a badge-carrying row. */
  const familyRowClaimed = new Set<string>();

  for (const r of recents) {
    const family = familyByPath.get(normPath(r.path));
    const groupKey = family?.key ?? collapseKey(r.path).toLowerCase();
    if (collapse) {
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);
      // Representative: the head when it exists on disk — Launch always fires
      // the head, never a guessed variant. The pinned active path stays
      // itself, because the user explicitly picked that file — but only while
      // it still EXISTS. Deleting the increment you were working on (Increment
      // Filename left on by accident) must hand the card back to the plain
      // .toe, not leave it pinned to a file that is gone.
      let path = r.path;
      const pinnedButGone =
        r.path === activePath && !pathOnDisk(r.path, meta, family);
      if (family?.head && (r.path !== activePath || pinnedButGone)) {
        path = family.head;
      }
      rows.push({ path, family });
      if (family) familyRowClaimed.add(family.key);
    } else {
      rows.push({ path: r.path, family });
    }
  }

  const byPath = new Map(recents.map((r) => [r.path, r]));
  const items: ListItem[] = [];
  for (const { path, family } of rows) {
    // A family row matches when any member matches — searching "Project.5"
    // must surface the collapsed card.
    const matches =
      matchesSearch(path, filter) ||
      (!!family && family.member_paths.some((mp) => matchesSearch(mp, filter)));
    if (!matches) continue;

    const entry = byPath.get(path);
    const m = meta[path];
    const isHeadRow = !!family && !!family.head && normPath(path) === normPath(family.head);
    // Exactly one row per family carries the badge: the collapsed card, or in
    // expanded lists the head row (first-seen member when no head exists).
    let carriesFamily = false;
    if (family && (family.variants.length >= 2 || family.crash_newer_than_head)) {
      if (collapse) carriesFamily = true;
      else if (isHeadRow || (!family.head && !familyRowClaimed.has(family.key))) {
        carriesFamily = true;
        familyRowClaimed.add(family.key);
      }
    }

    // Collapsed family cards read as project titles ("Project"), not file
    // names — unless the row is a pinned specific variant.
    const name =
      carriesFamily && collapse && isHeadRow && family
        ? family.display_name
        : displayName(path);

    items.push({
      path,
      displayName: name,
      source: path === activePath ? "active" : entry?.source ?? "launcher",
      missing: m ? !m.exists : family ? !family.variants.some((v) => normPath(v.path) === normPath(path)) : false,
      mtime: m?.mtime,
      ...(carriesFamily && family
        ? {
            familyKey: family.key,
            familyCount: family.variants.length,
            familyCrash: family.crash_newer_than_head,
            familyLastOpened:
              family.last_opened_variant &&
              normPath(family.last_opened_variant) !== normPath(path)
                ? family.last_opened_variant
                : null,
          }
        : {}),
    });
  }
  return items;
}

/** "3h 12m" / "12m" / "44s" — coarse on purpose, this is a glanceable fact. */
export function formatUptime(startedAt: number): string {
  return formatDuration(Date.now() / 1000 - startedAt);
}

/** A length of time, same coarse style as uptime: "3h 12m" / "12m" / "44s". */
export function formatDuration(seconds: number): string {
  const secs = Math.max(0, Math.floor(seconds));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

/** FNSTools' public naming convention omits the implementation prefix. */
export function canonicalToolName(name: string): string {
  return name.replace(/^FNS_/i, "");
}

/** A command title that names which copy of a multi-instance tool it runs on
 *  (registry >= 1.11.0 sends `instance`). Unchanged for single-instance tools. */
export function withInstance(title: string, instance: string | undefined): string {
  return instance ? `${title} · ${instance}` : title;
}

/** Split a preset target: `tool#id@instance` pins one copy of a
 *  multi-instance tool, a bare `tool#id` targets every live copy. Tool names
 *  and command ids cannot contain `@`, so the first `@` is the separator. */
export function splitPresetTarget(target: string): { identity: string; instance?: string } {
  const at = target.indexOf("@");
  if (at < 0) return { identity: target };
  const instance = target.slice(at + 1);
  return instance ? { identity: target.slice(0, at), instance } : { identity: target.slice(0, at) };
}

export function buildOpenItems(
  open: {
    path: string;
    display_name: string;
    pid: number | null;
    alive: boolean;
    version_key: string | null;
    use_touchplayer?: boolean;
    envoy_port: number | null;
    envoy_up?: boolean | null;
    mcp_available?: boolean;
    utility_available?: boolean | null;
    utility_version?: string | null;
    companion_silent_secs?: number | null;
    source: string;
    started_at?: number | null;
    ended_at?: number | null;
    windows?: SessionWindow[];
    instances?: SessionInstance[];
  }[],
  filter: string,
): ListItem[] {
  const items: ListItem[] = [];
  for (const p of open) {
    // Stale (ended) launcher sessions are kept as relaunchable tombstones;
    // only drop a dead row that isn't a tombstone (shouldn't occur, but safe).
    const stale = !p.alive;
    if (stale && p.ended_at == null) continue;
    const windows = p.windows ?? [];
    const instances = p.instances ?? [];
    // Window titles are searchable too — "perform" or "textport" should surface
    // the session holding that window, not just projects with matching paths.
    if (
      !matchesSearch(p.path, filter) &&
      !matchesSearch(p.display_name, filter) &&
      !windows.some(
        (w) =>
          matchesSearch(w.title, filter) ||
          (w.pane_owner ? matchesSearch(w.pane_owner, filter) : false),
      )
    ) {
      continue;
    }
    const bits: string[] = [];
    if (stale) {
      const when = formatWhen(p.ended_at ?? undefined);
      bits.push(when ? `ended ${when}` : "ended");
    } else {
      if (p.pid != null) bits.push(`pid ${p.pid}`);
      // The same .toe open twice is worth stating outright — the row's PID,
      // perf and Envoy port all describe only the primary one.
      if (instances.length > 1) bits.push(`${instances.length} instances`);
      if (p.envoy_port != null) bits.push(`:${p.envoy_port}`);
      if (windows.length > 1) bits.push(`${windows.length} windows`);
    }
    items.push({
      path: p.path,
      displayName: p.display_name || displayName(p.path),
      source: stale ? "stale" : p.source === "launcher" ? "launcher" : "process",
      missing: false,
      mtime: bits.join(" · ") || (stale ? "ended" : "open"),
      openPid: stale ? null : p.pid,
      openEnvoyPort: p.envoy_port,
      openEnvoyUp: p.envoy_up ?? null,
      openMcpAvailable: !stale && !!p.mcp_available,
      openUtilityAvailable: stale ? null : p.utility_available ?? null,
      openUtilityVersion: p.utility_version ?? null,
      openVersionKey: p.version_key,
      openUsePlayer: !!p.use_touchplayer,
      openStartedAt: p.started_at ?? null,
      openEndedAt: p.ended_at ?? null,
      openSilentSecs: stale ? null : p.companion_silent_secs ?? null,
      openWindows: stale ? [] : windows,
      openInstances: stale ? [] : instances,
    });
  }
  return items;
}

export function buildTemplateItems(
  templates: string[],
  meta: Record<string, MetaEntry>,
  filter: string,
): ListItem[] {
  const items: ListItem[] = [
    {
      path: DEFAULT_TEMPLATE,
      displayName: "Default (new project)",
      source: "default",
      missing: false,
      isDefault: true,
    },
  ];
  for (const path of templates) {
    if (!matchesSearch(path, filter)) continue;
    const m = meta[path];
    items.push({
      path,
      displayName: displayName(path),
      source: "template",
      missing: m ? !m.exists : false,
      mtime: m?.mtime,
    });
  }
  return items.filter(
    (i) => i.isDefault || matchesSearch(i.path, filter) || !filter.trim(),
  );
}

export function buildPaletteItems(
  palettes: { path: string; name: string; folder: string; root_label: string }[],
  meta: Record<string, MetaEntry>,
  filter: string,
): ListItem[] {
  const items: ListItem[] = [];
  for (const p of palettes) {
    const hay = `${p.root_label}/${p.folder}/${p.name} ${p.path}`;
    if (!matchesSearch(hay, filter) && filter.trim()) continue;
    const m = meta[p.path];
    const category = p.folder
      ? `${p.root_label} / ${p.folder}`
      : p.root_label;
    items.push({
      path: p.path,
      displayName: p.name,
      source: category,
      missing: m ? !m.exists : false,
      mtime: m?.mtime,
    });
  }
  return items;
}

export type PaletteTreeFile = {
  kind: "file";
  id: string;
  name: string;
  path: string;
  missing: boolean;
  mtime?: string;
  /** Absolute User Palette root when this file lives under an importable tree. */
  absRoot?: string;
  relFolder?: string;
  acceptImports?: boolean;
};

/**
 * Per-path file facts the list needs: existence + display date, plus the raw
 * values the sort comparators use.
 */
export type MetaEntry = {
  exists: boolean;
  mtime: string;
  mtimeSecs?: number;
  bytes?: number;
};

export type PaletteTreeFolder = {
  kind: "folder";
  id: string;
  name: string;
  children: PaletteTreeNode[];
  absRoot: string;
  relFolder: string;
  acceptImports: boolean;
};

export type PaletteTreeNode = PaletteTreeFolder | PaletteTreeFile;

type MutableFolder = {
  kind: "folder";
  id: string;
  name: string;
  absRoot: string;
  relFolder: string;
  acceptImports: boolean;
  folders: Map<string, MutableFolder>;
  files: PaletteTreeFile[];
};

function finalizeFolder(node: MutableFolder): PaletteTreeFolder {
  const children: PaletteTreeNode[] = [
    ...[...node.folders.values()]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map(finalizeFolder),
    ...node.files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    ),
  ];
  return {
    kind: "folder",
    id: node.id,
    name: node.name,
    children,
    absRoot: node.absRoot,
    relFolder: node.relFolder,
    acceptImports: node.acceptImports,
  };
}

/** Build a folder tree from flat palette scan results (root → folders → .tox). */
export function buildPaletteTree(
  palettes: {
    path: string;
    name: string;
    folder: string;
    root: string;
    root_label: string;
  }[],
  meta: Record<string, MetaEntry>,
  filter: string,
): PaletteTreeFolder[] {
  const roots = new Map<string, MutableFolder>();

  for (const p of palettes) {
    const hay = `${p.root_label}/${p.folder}/${p.name} ${p.path}`;
    if (filter.trim() && !matchesSearch(hay, filter)) continue;

    const acceptImports = p.root_label === "User Palette";
    let root = roots.get(p.root_label);
    if (!root) {
      root = {
        kind: "folder",
        id: p.root_label,
        name: p.root_label,
        absRoot: p.root,
        relFolder: "",
        acceptImports,
        folders: new Map(),
        files: [],
      };
      roots.set(p.root_label, root);
    }

    let cur = root;
    const parts = p.folder
      ? p.folder.split(/[/\\]+/).filter(Boolean)
      : [];
    const trail: string[] = [];
    for (const part of parts) {
      trail.push(part);
      const id = `${cur.id}/${part}`;
      let next = cur.folders.get(part);
      if (!next) {
        next = {
          kind: "folder",
          id,
          name: part,
          absRoot: p.root,
          relFolder: trail.join("/"),
          acceptImports,
          folders: new Map(),
          files: [],
        };
        cur.folders.set(part, next);
      }
      cur = next;
    }

    const m = meta[p.path];
    cur.files.push({
      kind: "file",
      id: p.path,
      name: p.name,
      path: p.path,
      missing: m ? !m.exists : false,
      mtime: m?.mtime,
      absRoot: p.root,
      relFolder: cur.relFolder,
      acceptImports,
    });
  }

  return [...roots.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map(finalizeFolder);
}

/** Folder ids that should be open so matching files are visible. */
export function paletteTreeExpandIds(roots: PaletteTreeFolder[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: PaletteTreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === "folder") {
        ids.push(n.id);
        walk(n.children);
      }
    }
  };
  walk(roots);
  return ids;
}

export function isToxPath(path: string | null | undefined): boolean {
  return !!path && /\.tox$/i.test(path);
}

/**
 * Does this `.toe` sit directly inside a `Backup/` folder?
 *
 * TD writes incremental backups one level below the project folder, so a
 * backup opened in place resolves every project-relative asset path one
 * level too deep. Matches the Rust side's `is_backup_dir_name`
 * (case-insensitive, exactly "Backup") so both ends agree on what a backup
 * is.
 */
export function isInBackupFolder(path: string | null | undefined): boolean {
  if (!path) return false;
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.length >= 2 && parts[parts.length - 2].toLowerCase() === "backup";
}

export function displayBuildInfo(build: string | null, usePlayer: boolean): string {
  if (!build) return "";
  if (usePlayer) return build.replace(/^TouchDesigner\./, "TouchPlayer.");
  return build;
}

export function versionNumeric(key: string): string {
  return key.replace(/^Touch(Designer|Player)\./, "");
}

/** True when version has an experimental branch suffix (`year.build.N` with N > 0). */
export function versionHasBranch(key: string): boolean {
  const parts = versionNumeric(key).split(".");
  return parts.length >= 3 && Number(parts[2]) > 0;
}

/** Parse `year.build[.branch]` for ordering; branch defaults to 0. */
export function parseVersionParts(key: string): [number, number, number] {
  const parts = versionNumeric(key).split(".");
  const year = Number(parts[0]) || -1;
  const build = Number(parts[1]) || -1;
  const branch = Number(parts[2]) || 0;
  return [year, build, branch];
}

function versionPartsLte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return true;
}

/** Newest installed build, preferring mainline (no branch) over experimental. */
export function newestMainlineKey(keys: string[]): string | null {
  if (!keys.length) return null;
  for (let i = keys.length - 1; i >= 0; i--) {
    if (!versionHasBranch(keys[i])) return keys[i];
  }
  return keys[keys.length - 1];
}

/** Sentinel for template default version dropdown. */
export const TEMPLATE_VERSION_LATEST = "latest";

/** Resolve template launch version: `"latest"` → newest mainline, else a concrete key. */
export function resolveTemplateVersion(
  preference: string,
  keys: string[],
): string | null {
  if (!keys.length) return null;
  if (!preference || preference === TEMPLATE_VERSION_LATEST) {
    return newestMainlineKey(keys);
  }
  if (keys.includes(preference)) return preference;
  return newestMainlineKey(keys);
}

/**
 * `cli_fallback_version` sentinels — anything else is a concrete install key.
 * See `resolveCliFallbackVersion`.
 */
/**
 * Not answered yet — the config default. Distinct from `CLI_FALLBACK_ASK`:
 * "ask" is a settled policy of never auto-launching, whereas unset means the
 * user has not been asked, so the first file-open that hits a missing build
 * prompts once and stores whatever they pick.
 */
export const CLI_FALLBACK_UNSET = "";
export const CLI_FALLBACK_ASK = "ask";
export const CLI_FALLBACK_CLOSEST = "closest";
export const CLI_FALLBACK_LATEST = "latest";

/**
 * Which installed build the file-open countdown should launch when the one the
 * project was saved with isn't installed, or `null` to not count down at all
 * and let the user pick.
 *
 * `preference` is one of the `CLI_FALLBACK_*` sentinels or a pinned install key.
 * A pinned build that has since been uninstalled degrades to the closest match
 * rather than silently launching whatever is newest — the user pinned a build
 * precisely to avoid that.
 *
 * Everything returned is guaranteed to be a member of `keys`, so a caller can
 * launch it without re-checking; with nothing installed the answer is `null`.
 */
export function resolveCliFallbackVersion(
  preference: string,
  buildInfo: string,
  keys: string[],
  usePlayer: boolean,
): string | null {
  // Unset falls through to null the same as "ask" — the caller prompts instead.
  if (!keys.length || !preference || preference === CLI_FALLBACK_ASK) return null;
  if (preference === CLI_FALLBACK_LATEST) return newestMainlineKey(keys);
  if (preference !== CLI_FALLBACK_CLOSEST) {
    // Pinned. Match numerically so the pin survives the TouchPlayer toggle,
    // which swaps the whole key pool over to `TouchPlayer.*`.
    const pinned = keys.find((k) => versionNumeric(k) === versionNumeric(preference));
    if (pinned) return pinned;
  }
  const closest = findMatchingVersionKey(buildInfo, keys, usePlayer);
  return closest && keys.includes(closest) ? closest : null;
}

/** Mainline (non-branched) install keys for template version picker. */
export function mainlineVersionKeys(keys: string[]): string[] {
  return keys.filter((k) => !versionHasBranch(k));
}

/**
 * Exact match, else closest older installed build.
 * Mainline `.toe` builds (no branch) never auto-select experimental `year.build.N`
 * unless that exact branched version was saved into the file.
 *
 * Falling back to an older build only holds *within* a release year. An install
 * from an earlier year cannot open the file at all (a 2023 build refuses a
 * 2025.30060 `.toe`), while a newer build opens it with an upgrade prompt — so
 * when the closest older install crosses a year boundary, the closest newer one
 * wins instead.
 */
export function findMatchingVersionKey(
  buildInfo: string,
  keys: string[],
  usePlayer: boolean,
): string | null {
  if (!keys.length) {
    return usePlayer
      ? buildInfo.replace(/^TouchDesigner\./, "TouchPlayer.")
      : buildInfo;
  }
  const target = versionNumeric(buildInfo);
  const exact = keys.find((k) => versionNumeric(k) === target);
  if (exact) return exact;

  const targetHasBranch = versionHasBranch(buildInfo);
  const pool = targetHasBranch ? keys : keys.filter((k) => !versionHasBranch(k));
  const search = pool.length ? pool : keys;

  const targetParts = parseVersionParts(buildInfo);
  // `search` is sorted ascending, so the walk ends on the newest build at or
  // below the target and the first build above it.
  let older: string | null = null;
  let newer: string | null = null;
  for (const k of search) {
    if (versionPartsLte(parseVersionParts(k), targetParts)) older = k;
    else {
      newer = k;
      break;
    }
  }

  const targetYear = targetParts[0];
  if (
    older &&
    newer &&
    targetYear > 0 &&
    parseVersionParts(older)[0] !== targetYear
  ) {
    return newer;
  }
  return older ?? newer ?? search[0];
}

export function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function dirname(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? path.slice(0, path.length - (norm.length - i)) : path;
}

/**
 * Turns a display name (e.g. a Patreon creator) into a single safe path
 * segment — no separators (so it can't smuggle in extra directory levels),
 * no Windows-illegal characters, trimmed, length-capped, never empty.
 * Mirrors `sanitize_dir_name` in src-tauri/src/patreon.rs.
 */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"|?*/\\]/g, "")
    .trim()
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 100);
  return cleaned || "creator";
}

/** Plain-text summary for status line (strip leftover markdown). */
export function plainSummary(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

/**
 * Collapse digit runs to "*" so versioned names generalize:
 * "Project.42.toe" → "Project.*.toe", "capture_0042.png" → "capture_*.png".
 * Null when the name has no digits or nothing changes.
 */
export function numberWildcardName(name: string): string | null {
  if (!/\d/.test(name)) return null;
  const pat = name.replace(/\d+/g, "*").replace(/\*{2,}/g, "*");
  return pat === name ? null : pat;
}

/**
 * Quick-launch match score: 0 = no match, higher = better. Every
 * whitespace-separated query word must hit.
 *
 * The scorer itself lives in `./fuzzy` — a tiered matcher shared with
 * FNSTools (their `scripts/shared/FuzzyMatch.py`; keep the two in step).
 * This stays the only entry point, so `scoreEntry` and the `> 0` filters
 * are untouched.
 *
 * What changed for callers, and what deliberately did not:
 *
 * - **0 is still the only no-match value**, and every real match is now
 *   >= 1000, so the five `fuzzyScore(...) > 0` filters keep working. An
 *   empty query still returns 1.
 * - **The bands are a thousand wide** — exact 7000+, prefix 6000+, word
 *   5000+, substring 4000+, initials 3000+, typo 2000+, subsequence
 *   1000+, each plus 0..700 of within-tier quality. A better tier always
 *   beats any quality in a worse one.
 * - **Nothing that matched before ranks differently among itself**: the
 *   old substring/subsequence behaviour is the top and bottom of the new
 *   ladder, and initials, typo and the spelling folds only ever fill in
 *   below the strict tiers.
 * - **Magnitudes moved by ~50x**, which matters for anything that ADDS a
 *   constant to this score. `scoreEntry`'s multipliers are fine (they
 *   scale). The additive nudges in quick.tsx were sized against the old
 *   ~100 scale: the one that meant "worth a whole word" was rescaled with
 *   it, the ones that meant "break a tie" were left, because that is what
 *   they still do. See the comments there before adding another.
 */
export function fuzzyScore(query: string, text: string): number {
  return tieredScore(query, text);
}

/** Compact "when" for variant rows: relative under two weeks, then a date. */
export function formatWhen(secs?: number | null): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const diff = Date.now() - d.getTime();
  const min = 60_000;
  const hr = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.round(diff / min)} min ago`;
  if (diff < day) return `${Math.round(diff / hr)} h ago`;
  if (diff < 14 * day) return `${Math.round(diff / day)} d ago`;
  return d.toLocaleDateString();
}

/** Compact byte size for list rows: "812 B", "4.2 MB", "1.7 GB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // One decimal below 10 (4.2 MB), none above (256 MB) — keeps the column narrow.
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Whether a shelf's place action drops this package into the current pane
 *  (`pane` / `none`) rather than installing it through FNS_Installer. Mirrors
 *  `fns_store::placement_lands_in_pane` — keep the two in step. */
export function packageLandsInPane(p: { placement?: string }): boolean {
  const v = (p.placement ?? "").trim();
  return v === "pane" || v === "none";
}

/** `noiseCHOP` → `Noise CHOP`: TD's internal optype split into name + family. */
export function optypeLabel(optype: string): string {
  const m = /^(.*?)(COMP|TOP|CHOP|SOP|MAT|DAT|POP)$/.exec(optype);
  if (!m) return optype;
  const name = m[1] ? m[1][0].toUpperCase() + m[1].slice(1) : "";
  return name ? `${name} ${m[2]}` : m[2];
}

/** One line for a package's `alternatives_for`, or null when it has none:
 *  the types by name up to three, else a count. The full list belongs in the
 *  title (see `alternativesTitle`). */
export function alternativesLabel(p: { alternatives_for?: string[] }): string | null {
  const types = p.alternatives_for ?? [];
  if (types.length === 0) return null;
  if (types.length <= 3) return `alternative for ${types.map(optypeLabel).join(", ")}`;
  return `alternative for ${types.length} operator types`;
}

/** Tooltip copy explaining the OP-Create alternative mechanism for one package. */
export function alternativesTitle(p: { alternatives_for?: string[] }): string {
  const types = (p.alternatives_for ?? []).map(optypeLabel);
  return `Offered by TouchDesigner as an alternative when you create ${types.join(", ")} (hold alt+ctrl on create) — once the package is in the FNS palette store.`;
}

