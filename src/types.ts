export const DEFAULT_TEMPLATE = "__default__";

export interface AppInfo {
  version: string;
  platform: string;
  default_template: string;
  /** Build compiled with the optional Patreon import feature. */
  patreon_enabled: boolean;
  /**
   * Version of the utility TOX this launcher hands out — the bundled copy, or a
   * newer one pulled from the utility release channel. Independent of `version`;
   * the app and the utility update separately.
   */
  utility_version: string;
  /** Launched by the OS at login — the frontend starts in the tray. */
  autostart_launch: boolean;
}

/**
 * Membership state from the cached signed claim (licensing.rs). No launcher
 * feature depends on this — `products` decides which FNSTools Plus packages
 * unlock. Activations are offline until the claim's own expiry — a failed
 * request is never a lockout.
 */
export interface LicenseStatus {
  /** An active Function Store membership — derived from the claim's product list. */
  entitled: boolean;
  /** The claim's kind. "patreon" is all TDXLU mints itself, but adopting
      the shared machine session can surface a toolkit-minted "gumroad".
      "" = none; "disabled" = unlicensed build. */
  provider: string;
  /** "" | "auth_required" | "reauth_required" | "no_entitlement" */
  blockReason: string;
  /** What the entitlement claim names. Empty when signed out or lapsed. */
  products: string[];
}

/** The gate's /session/recheck answer, consumed verbatim (docs/fns-gate.md §6). */
export interface RecheckReport {
  products: string[];
  /** false = the Patreon grant is dead — only a fresh sign-in helps. */
  connected: boolean;
  /** true = last known answer served during a Patreon outage, not a real "no". */
  stale: boolean;
  verifiedAt: number;
  message: string;
}

/** Result of polling the utility release channel (`utility/latest.json`). */
export interface UtilityUpdateInfo {
  /** Worth fetching: newer than what this launcher hands out, or none held. */
  available: boolean;
  /** A copy exists locally — false means this is a first install, not an update. */
  installed: boolean;
  /** Effective version right now (downloaded copy, else the bundled one). */
  currentVersion: string;
  latestVersion: string;
  notes: string;
}

export interface PatreonCampaign {
  id: string;
  name: string;
  url: string;
  avatarUrl: string | null;
  isOwn: boolean;
  /** Added by hand from a creator URL — removable from the list. */
  manual: boolean;
  /** Function Store, offered because the list lacked it — dismissable, and
   *  dismissing is permanent. Absent from a launcher that predates it. */
  featured?: boolean;
}

export interface PatreonToxFile {
  name: string;
  url: string;
  source: string;
  /** "tox" (load into a session), "toe" (open as a project), or "zip" (download + extract). */
  kind: string;
}

/** A .tox/.toe found inside an extracted zip — path is already local, no download needed. */
export interface PatreonExtractedFile {
  name: string;
  path: string;
  kind: string;
}

export interface PatreonZipExtract {
  zipPath: string;
  extractedDir: string;
  files: PatreonExtractedFile[];
  fromCache: boolean;
}

/**
 * One hit from the cached-.tox name search. `url` is absent for a file only
 * the disk knows about (unzipped, or downloaded before the index existed);
 * `localPath` is absent for one that still has to be downloaded.
 */
export interface PatreonSearchHit {
  name: string;
  /** "tox", "toe" or "zip". */
  kind: string;
  url: string | null;
  localPath: string | null;
  campaignId: string | null;
  campaignName: string;
  postId: string | null;
  postTitle: string | null;
  publishedAt: string | null;
  canView: boolean;
  /** The .zip this came out of, when it was found inside one. */
  fromZip: string | null;
}

export interface PatreonSearchResult {
  hits: PatreonSearchHit[];
  /** How many creators have ever been listed — 0 means the cache is empty, not that nothing matched. */
  cachedCreators: number;
  newestAt: number;
  truncated: boolean;
}

export interface PatreonToxPost {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  canView: boolean;
  toxFiles: PatreonToxFile[];
  contentHtml: string | null;
  teaser: string | null;
  embedHtml: string | null;
  embedUrl: string | null;
  embedProvider: string | null;
  imageUrl: string | null;
  /** Set from the on-demand detail fetch: Patreon-native video post. */
  isVideo?: boolean;
  /** content_html was built by us (safe to render in-DOM). */
  contentIsRich?: boolean;
}

export interface PatreonPostDetail {
  contentHtml: string | null;
  teaser: string | null;
  embedHtml: string | null;
  embedUrl: string | null;
  embedProvider: string | null;
  imageUrl: string | null;
  canView: boolean;
  contentIsRich: boolean;
  isVideo: boolean;
  debug: string | null;
}

export interface RecentEntry {
  path: string;
  source?: string | null;
  last_opened?: number | null;
}

export interface VersionInfo {
  key: string;
  executable: string;
  install_path?: string | null;
  app_path?: string | null;
  bundle_version?: string | null;
}

export interface DiscoverResult {
  versions: VersionInfo[];
  players: VersionInfo[];
}

export interface AppConfig {
  version: number;
  launcher_recents: unknown[];
  td_recents: unknown[];
  td_recents_timestamp: number;
  templates: unknown[];
  max_recent_files: number;
  confirm_remove_from_list: boolean;
  show_icons: boolean;
  show_readme: boolean;
  collapse_versions: boolean;
  show_full_history: boolean;
  has_prompted_file_assoc: boolean;
  theme: string;
  view_mode: string;
  show_tray: boolean;
  close_to_tray: boolean;
  /** Opens the quick-launch overlay. */
  global_hotkey_enabled: boolean;
  global_hotkey: string;
  /** Optional alternate combo for the overlay (same action, second binding). */
  global_hotkey_alt?: string;
  hotkey_skip_fullscreen?: boolean;
  /** Shows/hides the main launcher window. */
  global_hotkey_main_enabled?: boolean;
  global_hotkey_main?: string;
  /** Optional alternate combo for the main window. */
  global_hotkey_main_alt?: string;
  /** Shows/hides the main launcher window on the Palette tab. */
  global_hotkey_palette_enabled?: boolean;
  global_hotkey_palette?: string;
  /** Quick-palette filter prefixes (single chars; defaults > = / # ?). */
  quick_prefix_commands?: string;
  quick_prefix_components?: string;
  quick_prefix_category?: string;
  quick_prefix_tag?: string;
  quick_prefix_tools?: string;
  /** Tool-command curation (`tool#id` identities): sparse overrides of each
   *  command's own default visibility in the quick palette. */
  quick_hidden_commands?: string[];
  quick_shown_commands?: string[];
  /** Favourite commands (`tool#id`): first in the quick-launch lists and the
   *  in-TD palette's Commands tab, nudged up on typed queries. */
  quick_favorite_commands?: string[];
  /** Rank frequently run commands higher (shared command-usage.json).
   *  Absent = on. Recording runs either way. */
  quick_rank_by_usage?: boolean;
  /** User-authored quick-launch presets: label + `tool#id` target + baked
   *  argument values (strings; the registry coerces by declared style). */
  quick_command_presets?: QuickCommandPreset[];
  /** Every tool command this machine has ever seen or imported — the
   *  historical catalog the Settings curation list renders. Merged, never
   *  replaced, so a command stays curatable with no session live and an
   *  imported one can be hidden or given a preset before it registers here. */
  quick_seen_commands?: QuickSeenCommand[];
  quit_after_launch: boolean;
  hide_after_launch: boolean;
  switch_to_current_after_launch: boolean;
  /** Tab shown when the app opens on its own; `last` = where it was left. */
  startup_tab?: string;
  /** Build the file-open countdown falls back to when the exact one is missing:
   *  `"ask"` | `"closest"` | `"latest"` | a pinned install key. */
  cli_fallback_version: string;
  keybindings: Record<string, string>;
  github_username: string;
  github_token: string;
  patreon_session_cookie: string;
  /** Destination folder for Patreon downloads (always grouped by creator). Empty = ~/Documents/TDXLU/Patreon Downloads. */
  patreon_download_root: string;
  /** Dismissed the "a .tox runs its creator's code" warning. Shared with the
   *  in-TD palette page, so the banner is shown once per install. */
  patreon_trust_ack: boolean;
  backup_root: string;
  cloud_backup_root: string;
  backup_exclude: string;
  backup_include: string;
  backup_max_file_mb: number;
  backup_respect_gitignore: boolean;
  /** Skip TouchDesigner's Backup/ folders. Off by default — some people work in them. */
  backup_skip_td_backups?: boolean;
  palette_extra_folders: string;
  package_index_url: string;
  package_index_prefix: string;
  fns_base_url: string;
  control_server_port: number;
  control_server_lan: boolean;
  /** Hand companions the loopback palette page → TDXLU / Patreon tabs in TD's Palette Browser. */
  palette_tabs_enabled?: boolean;
  /** Let the restricted client-tier link reach the phone touch pad. */
  control_touch_client?: boolean;
  /** Run the automatic update checks (once a day, never mid-session). Manual checks work regardless. */
  auto_update_check?: boolean;
  /** Show the FNSTools tab (default true). The Palette tab's FNS shelf stays either way. */
  show_fns_tab?: boolean;
  /** Version the user skipped; the startup check stays silent for exactly this one. */
  skipped_app_version?: string;
  skipped_utility_version?: string;
  watch_tcp_port: number;
  watch_timeout_secs: number;
  watch_launch_grace_secs: number;
  watch_max_restarts: number;
  watch_screenshot_on_crash: boolean;
  watch_reboot_after_crashes: number;
  alert_email_enabled: boolean;
  alert_email_to: string;
  alert_email_from: string;
  alert_smtp_host: string;
  alert_smtp_port: number;
  alert_smtp_security: string;
  alert_smtp_username: string;
  alert_smtp_password: string;
  alert_on_stall: boolean;
  alert_on_relaunch: boolean;
  alert_on_gave_up: boolean;
  alert_on_reboot: boolean;
  alert_attach_screenshot: boolean;
  alert_cooldown_secs: number;
  perf_monitor_enabled: boolean;
  perf_poll_secs: number;
}

export interface PrefsUpdate {
  max_recent_files?: number;
  confirm_remove_from_list?: boolean;
  show_icons?: boolean;
  show_readme?: boolean;
  collapse_versions?: boolean;
  show_full_history?: boolean;
  has_prompted_file_assoc?: boolean;
  theme?: string;
  view_mode?: string;
  show_tray?: boolean;
  close_to_tray?: boolean;
  global_hotkey_enabled?: boolean;
  global_hotkey?: string;
  global_hotkey_alt?: string;
  hotkey_skip_fullscreen?: boolean;
  global_hotkey_main_enabled?: boolean;
  global_hotkey_main?: string;
  global_hotkey_main_alt?: string;
  global_hotkey_palette_enabled?: boolean;
  global_hotkey_palette?: string;
  quick_prefix_commands?: string;
  quick_prefix_components?: string;
  quick_prefix_category?: string;
  quick_prefix_tag?: string;
  quick_prefix_tools?: string;
  quick_hidden_commands?: string[];
  quick_shown_commands?: string[];
  quick_favorite_commands?: string[];
  quick_rank_by_usage?: boolean;
  quick_command_presets?: QuickCommandPreset[];
  quit_after_launch?: boolean;
  hide_after_launch?: boolean;
  switch_to_current_after_launch?: boolean;
  startup_tab?: string;
  cli_fallback_version?: string;
  keybindings?: Record<string, string>;
  github_username?: string;
  github_token?: string;
  patreon_session_cookie?: string;
  patreon_download_root?: string;
  patreon_trust_ack?: boolean;
  backup_root?: string;
  cloud_backup_root?: string;
  backup_exclude?: string;
  backup_include?: string;
  backup_max_file_mb?: number;
  backup_respect_gitignore?: boolean;
  backup_skip_td_backups?: boolean;
  palette_extra_folders?: string;
  package_index_url?: string;
  package_index_prefix?: string;
  fns_base_url?: string;
  control_server_port?: number;
  control_server_lan?: boolean;
  palette_tabs_enabled?: boolean;
  control_touch_client?: boolean;
  auto_update_check?: boolean;
  show_fns_tab?: boolean;
  skipped_app_version?: string;
  skipped_utility_version?: string;
  watch_tcp_port?: number;
  watch_timeout_secs?: number;
  watch_launch_grace_secs?: number;
  watch_max_restarts?: number;
  watch_screenshot_on_crash?: boolean;
  watch_reboot_after_crashes?: number;
  alert_email_enabled?: boolean;
  alert_email_to?: string;
  alert_email_from?: string;
  alert_smtp_host?: string;
  alert_smtp_port?: number;
  alert_smtp_security?: string;
  alert_smtp_username?: string;
  alert_smtp_password?: string;
  alert_on_stall?: boolean;
  alert_on_relaunch?: boolean;
  alert_on_gave_up?: boolean;
  alert_on_reboot?: boolean;
  alert_attach_screenshot?: boolean;
  alert_cooldown_secs?: number;
  perf_monitor_enabled?: boolean;
  perf_poll_secs?: number;
}

/** Process CPU/RAM of a running session (`session_perf_cmd`). */
export interface ProcPerf {
  /** Percent of the whole machine (process usage / logical core count). */
  cpu_pct: number;
  mem_mb: number;
}

/** TD-internal stats from the companion utility's Perform CHOP (`perf` action). */
export interface TdPerfResult {
  ok: boolean;
  fps?: number;
  /** Target frame rate the project cooks toward. */
  cook_rate?: number;
  /** Cook time of the last frame, ms. */
  cook_ms?: number;
  /** Frames dropped since the previous frame — instantaneous, never cumulative. */
  dropped?: number;
  gpu_mem_mb?: number;
  gpu_mem_total_mb?: number;
  cpu_mem_mb?: number;
  error?: string;
}

/** Companion autosave settings + readouts (`autosave_get`, utility >= 0.10.0). */
export interface AutosaveState {
  ok?: boolean;
  error?: string;
  active: boolean;
  /** Minutes between saves. */
  interval: number;
  /** `td` follows TouchDesigner's own increment/backup preferences; `overwrite` always lands in the open .toe. */
  mode: AutosaveMode;
  only_modified: boolean;
  skip_perform: boolean;
  /** Readout line: when the last save landed, or why one was skipped. */
  status?: string;
  /** Epoch seconds of the last save the companion made, null if none yet. */
  last_save?: number | null;
  /** Seconds until the next scheduled save, null when idle. */
  next_in?: number | null;
  /** Operators changed since the last save (`project.modified`). */
  modified?: number;
  perform?: boolean;
  project?: string;
  project_path?: string;
  /** False for a project that has never been written to disk - nothing to autosave into. */
  project_saved?: boolean;
  project_save_time?: string;
}

export type AutosaveMode = "td" | "overwrite";

/** The subset of AutosaveState a write may carry (`autosave_set`). */
export type AutosaveFields = Partial<
  Pick<AutosaveState, "active" | "interval" | "mode" | "only_modified" | "skip_perform">
>;

/** Outcome of merging an exported settings file into the live config. */
export interface SettingsImportResult {
  config: AppConfig;
  prefs_applied: number;
  tools_added: number;
  categories_added: number;
  commands_added: number;
}

/** One declared argument of a tool command, as last seen. */
export interface QuickSeenParam {
  name: string;
  label?: string;
  style?: string;
  required?: boolean;
  default?: string | number | boolean;
  menu?: string[];
  help?: string;
}

/** One tool command the palette has ever fetched (or a settings import
 *  carried in). `identity` (`tool#id`) is the curation key; the rest is
 *  display data from the last sighting. */
export interface QuickSeenCommand {
  identity: string;
  tool: string;
  id: string;
  label: string;
  help?: string;
  /** Tool-declared default visibility at last sighting. */
  hidden?: boolean;
  /** Built-in TD/system command (not a third-party tool's). */
  builtin?: boolean;
  param_count?: number;
  params?: QuickSeenParam[];
  /** Instance labels of the live copies at last sighting (multi-instance
   *  tools only) -- lets the Settings preset editor pin a preset to one copy. */
  instances?: string[];
  /** Unix seconds; 0 when unknown (an old export, a legacy adoption). */
  last_seen: number;
}

export type ThemeId = "classic" | "ocean" | "amber" | "ember" | "frost" | "violet" | "mono";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "ocean", label: "Ocean" },
  { id: "amber", label: "Amber" },
  { id: "ember", label: "Ember" },
  { id: "frost", label: "Frost" },
  { id: "violet", label: "Violet" },
  { id: "mono", label: "Mono" },
];

export interface FileMeta {
  exists: boolean;
  name: string;
  dir: string;
  mtime: string;
  mtime_secs: number;
  /** File size in bytes (0 when missing or unreadable). */
  bytes: number;
}

export interface ReadmeInfo {
  path: string | null;
  content: string;
  summary: string;
}

export interface MediaItem {
  path: string;
  kind: string;
  caption?: string | null;
}

/**
 * Bind this project's TD process to one graphics card at launch (Windows,
 * TD 2022.20000+). `monitor` is a Monitors DAT index — left to right, bottom to
 * top, which is not the OS display order. `bus_id` names the card outright
 * (`domain:bus:device:function`) and is not portable between machines.
 * `monitor` wins when both are present.
 * https://docs.derivative.ca/Using_Multiple_Graphic_Cards
 */
export interface GpuAffinity {
  monitor?: number | null;
  bus_id?: string | null;
}

export interface ProjectMeta {
  version: number;
  tags: string[];
  title?: string | null;
  description?: string | null;
  hero?: string | null;
  media_dir?: string | null;
  media: MediaItem[];
  gpu?: GpuAffinity | null;
}

/** A GPU the affinity control can offer, named by a monitor attached to it. */
export interface GpuMonitorOption {
  /** The index TD's `-gpuformonitor` expects (Monitors DAT order). */
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  name: string | null;
}

export interface ResolvedMedia {
  path: string;
  kind: string;
  caption?: string | null;
  source: string;
  /** Last-modified ms. Goes into the file's URL so a re-captured preview
   *  (same path, new bytes) is fetched fresh instead of from cache. */
  mtime?: number | null;
}

export interface ProjectMetaInfo {
  project_path: string;
  sidecar_path: string | null;
  meta: ProjectMeta;
  hero_path: string | null;
  /** The hero file's last-modified ms (see ResolvedMedia.mtime). */
  hero_mtime?: number | null;
  media_folder: string | null;
  media: ResolvedMedia[];
}

export type TabId = "recent" | "current" | "templates" | "palette" | "fns" | "patreon";

/** One top-level OS window owned by a running TD session. */
export interface SessionWindow {
  /** Opaque OS handle — pass back to focus/minimize/restore. */
  id: number;
  pid: number;
  title: string;
  /** Has an owner window: a dialog or floating tool, not a top-level window. */
  owned: boolean;
  minimized: boolean;
  foreground: boolean;
  /** 1-based display index; 0 = unknown. */
  monitor: number;
  monitor_primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pane type from the companion Utility ("NETWORKEDITOR", "PANEL", …).
   *  Null when the project has no Utility, or the window is not a pane. */
  pane_type: string | null;
  /** Network path the pane is showing ("/", "/project1/scene"). */
  pane_owner: string | null;
}

export type WindowAction = "focus" | "minimize" | "restore";

/** One live TouchDesigner process for a project.
 *
 *  Normally one. Two or more means the same `.toe` is open more than once —
 *  launched twice, opened from Explorer while already running, relaunched
 *  without kill-first, or started by an autostart service. Both processes
 *  share the project's `.embody` and externalized files, so the last save
 *  wins; that's why the row surfaces the count instead of hiding it. */
export interface SessionInstance {
  pid: number;
  /** "launcher" if this launcher started it, "process" if discovered. */
  source: string;
  /** Epoch seconds — launcher-started instances only. */
  started_at: number | null;
  /** Top-level windows owned by THIS process. */
  windows: SessionWindow[];
}

export interface OpenProject {
  id: string;
  path: string;
  display_name: string;
  pid: number | null;
  alive: boolean;
  version_key: string | null;
  use_touchplayer: boolean;
  envoy_port: number | null;
  envoy_up: boolean | null;
  mcp_available: boolean;
  utility_available: boolean | null;
  /** Version reported by the live utility peer (null = unknown / pre-versioning). */
  utility_version: string | null;
  /** Seconds since a live session's companion last pulsed, once it has gone
   *  silent — TD is likely not responding. null = answering, or no companion
   *  to judge by. Absent from a launcher that predates the field. */
  companion_silent_secs?: number | null;
  source: string;
  started_at: number | null;
  /** Epoch seconds the launcher-started process ended; null while live. A
   *  stale/tombstone row (alive=false, ended_at set) can be relaunched. */
  ended_at: number | null;
  /** Top-level windows this session owns, main window first — flattened
   *  across every entry in `instances` (each window carries its own pid). */
  windows: SessionWindow[];
  /** Every live process for this project, primary first. Empty on a tombstone. */
  instances: SessionInstance[];
}

export interface PaletteItem {
  path: string;
  name: string;
  folder: string;
  root: string;
  root_label: string;
}

export type ToolboxKind = "local" | "url" | "package";

/** A user-pinned tool in the palette Toolbox section. */
export interface ToolboxTool {
  id: string;
  label: string;
  kind: ToolboxKind;
  /** local: absolute .tox path; url: URL / owner-repo spec; package: pip spec. */
  source: string;
  /** Category name; empty = Toolbox top level. */
  category: string;
  notes: string;
  /** Draggable local .tox for this tool, when one exists on disk. */
  resolvedPath: string | null;
  /** Local tool whose file has vanished (url tools are "unfetched", not missing). */
  missing: boolean;
}

export interface ToolboxView {
  categories: string[];
  tools: ToolboxTool[];
}

/** One palette scan root with why-is-it-empty diagnostics. */
export interface PaletteScanRoot {
  label: string;
  path: string;
  exists: boolean;
  /** Directory listing succeeded (false on macOS Documents-permission denial). */
  readable: boolean;
  tox_count: number;
}

export interface PaletteImportResult {
  copied: string[];
  skipped: string[];
  dest_dir: string;
  palette_data_updated: boolean;
}

export type FocusArea = "picker" | "versions";
export type ViewMode = "list" | "gallery";

export interface GitChange {
  path: string;
  old_path: string | null;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  /** Working-tree size; null for deleted files. */
  bytes: number | null;
}

export interface GitStatus {
  project_dir: string;
  is_repo: boolean;
  root: string | null;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  branches: string[];
  remotes: string[];
  remote_urls: string[];
  staged: number;
  unstaged: number;
  untracked: number;
  changes: GitChange[];
  summary: string;
}

export interface GitDiff {
  path: string;
  staged: boolean;
  binary: boolean;
  text: string;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  timestamp: number;
  relative_time: string;
  subject: string;
}

export interface GitCommitFile {
  path: string;
  status: string;
}

export interface GitCommitDetail {
  commit: GitCommit;
  body: string;
  parents: string[];
  files: GitCommitFile[];
  diff: GitDiff;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface GitToolInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  credential_helper: string | null;
  note: string;
}

export interface RcloneRemote {
  name: string;
  provider: string;
}

export interface RcloneStatus {
  available: boolean;
  version: string | null;
  path: string | null;
  config_path: string;
  remotes: RcloneRemote[];
}

export interface BackupFileOp {
  relative: string;
  direction: string;
  reason: string;
  bytes: number;
}

export interface BackupPlan {
  local_root: string;
  remote_root: string;
  mode: string;
  ops: BackupFileOp[];
  to_remote: number;
  to_local: number;
  skipped: number;
  filtered: number;
  summary: string;
  /** .gitignore filtering was requested AND the project is a git repo. */
  gitignore_active: boolean;
}

export interface BackupResult {
  local_root: string;
  remote_root: string;
  mode: string;
  copied_to_remote: number;
  copied_to_local: number;
  skipped: number;
  filtered: number;
  bytes_copied: number;
  errors: string[];
  summary: string;
}

export interface BackupTargetInfo {
  local_root: string;
  remote_root: string;
  remote_exists: boolean;
  local_file_count: number;
  remote_file_count: number;
  local_filtered: number;
  remote_filtered: number;
  /** The project folder sits inside a git work tree. */
  git_repo: boolean;
}

export interface WatchSessionStatus {
  id: string;
  active: boolean;
  phase: string;
  project_path: string;
  version_key: string;
  use_touchplayer: boolean;
  pid: number | null;
  last_heartbeat_secs_ago: number | null;
  fps: number | null;
  crash_count: number;
  message: string;
  log_lines: string[];
}

export interface WatchOverview {
  listening: boolean;
  port: number;
  sessions: WatchSessionStatus[];
  message: string;
}

/** Embody/Envoy (and future MCP providers) lifecycle status. */
export interface McpBridgeStatus {
  provider_id: string | null;
  provider_label: string | null;
  detected: boolean;
  project_root: string | null;
  envoy_json: string | null;
  mcp_json: string | null;
  active_instance: string | null;
  port: number | null;
  toe_path: string | null;
  td_executable: string | null;
  td_pid: number | null;
  td_alive: boolean;
  port_open: boolean;
  envoy_reachable: boolean;
  mcp_server_keys: string[];
  mcp_snippet: string | null;
  bridge_command: string | null;
  status: string;
  message: string;
}

/** One `.tox` found in the Patreon download cache on disk. */
export interface CachedPatreonTox {
  name: string;
  path: string;
  creator: string;
}

/** One file of a project family (Name.toe / Name.N.toe / Backup / crash). */
export interface VariantInfo {
  path: string;
  kind: "head" | "increment" | "backup" | "crash";
  ordinal?: number | null;
  /** File mtime, epoch seconds. */
  modified?: number | null;
  size: number;
  /** Recents stamp for this exact file, when it appears there. */
  last_opened?: number | null;
}

/** Result of creating a `CrashAutoSave.` Safe Mode copy. */
export interface SafeModeCopy {
  /** The copy — or the file already in the way when `needs_confirm`. */
  path: string;
  /** Nothing written yet: a file is there and replacing it needs a yes. */
  needs_confirm: boolean;
  /** mtime of the file in the way, epoch seconds. */
  existing_modified?: number | null;
  /** An existing copy was replaced. */
  replaced: boolean;
}

/** A logical project: its head plus every variant copy found on disk. */
export interface ProjectFamily {
  key: string;
  display_name: string;
  dir: string;
  head?: string | null;
  latest_activity: number;
  last_opened_variant?: string | null;
  crash_newer_than_head: boolean;
  reclaimable_bytes: number;
  variants: VariantInfo[];
  /** Normalized (lowercase, forward-slash) member paths for row grouping. */
  member_paths: string[];
}

export interface RestoreResult {
  head: string;
  preserved_as?: string | null;
}

export interface ListItem {
  path: string;
  displayName: string;
  source?: string;
  missing: boolean;
  mtime?: string;
  isDefault?: boolean;
  tags?: string[];
  heroUrl?: string | null;
  /** Project-family fields (Recent tab) — set when the row represents a family. */
  familyKey?: string;
  /** Number of variant files on disk; badge shows when ≥ 2. */
  familyCount?: number;
  /** A crash autosave newer than the head exists. */
  familyCrash?: boolean;
  /** Variant with the newest recents stamp, when it isn't this row's path. */
  familyLastOpened?: string | null;
  /** Current-tab session fields */
  openPid?: number | null;
  openEnvoyPort?: number | null;
  openEnvoyUp?: boolean | null;
  openMcpAvailable?: boolean;
  openUtilityAvailable?: boolean | null;
  openUtilityVersion?: string | null;
  openVersionKey?: string | null;
  openUsePlayer?: boolean;
  /** Epoch seconds the session started, when known. */
  openStartedAt?: number | null;
  /** Epoch seconds a launcher session ended — set only on stale rows. */
  openEndedAt?: number | null;
  /** Seconds the live session's companion has been silent (TD likely not
   *  responding); null while it answers or when there is none. */
  openSilentSecs?: number | null;
  /** Top-level OS windows of this session, main window first. */
  openWindows?: SessionWindow[];
  /** Live processes for this project, primary first. More than one = the same
   *  `.toe` is open twice; the row badges it and the expansion breaks it out. */
  openInstances?: SessionInstance[];
}

/** One exposed parameter in the utility's remote-control schema. */
export interface ControlParDescriptor {
  name: string;
  label: string;
  style: string;
  page: string;
  /** CONSTANT | EXPRESSION | EXPORT | BIND — only CONSTANT accepts writes. */
  mode: string;
  value: unknown;
  enabled: boolean;
  readonly: boolean;
  tuplet: string;
  vecindex: number;
  /** Number of pars in this ParGroup (1 = standalone). */
  tupletsize?: number;
  min?: number | null;
  max?: number | null;
  clampmin?: boolean;
  clampmax?: boolean;
  normmin?: number | null;
  normmax?: number | null;
  menunames?: string[];
  menulabels?: string[];
  default?: unknown;
}

/** One control source: a sequence-block COMP or the perform window. */
export interface ControlTarget {
  key: string;
  path: string;
  name: string;
  builtin: boolean;
  pars: ControlParDescriptor[];
}

export interface ControlSchemaResult {
  ok: boolean;
  targets: ControlTarget[];
  hash: string;
  error?: string;
}

export interface ControlValuesResult {
  ok: boolean;
  targets: { key: string; path: string; values: Record<string, unknown> }[];
  error?: string;
}

/** One candidate COMP the session could expose remotely (`control_comps`). */
export interface ControlCompEntry {
  path: string;
  name: string;
  /** Custom-parameter count — a hint at how much the COMP would expose. */
  pars: number;
  /** Already targeted by a Control-sequence block. */
  added: boolean;
  /** Has COMP children to expand — drives the lazy tree twisty. */
  has_children?: boolean;
}

export interface ControlCompsResult {
  ok: boolean;
  /** The parent whose immediate children these are ("" = root layer). */
  parent?: string;
  comps?: ControlCompEntry[];
  error?: string;
}

/** Result of `control_add` / `control_remove` on the companion. */
export interface ControlAddResult {
  ok: boolean;
  key?: string;
  already?: boolean;
  error?: string;
}

export interface ControlSetItemResult {
  target: string;
  par: string;
  ok: boolean;
  error?: string;
  value?: unknown;
}

export interface ControlSetResult {
  ok: boolean;
  results?: ControlSetItemResult[];
  error?: string;
}

/** One media file reference reported by the companion's media_list action. */
export interface MediaRef {
  /** '<op path>.<par name>' — the identity used to replace it. */
  ref: string;
  op: string;
  par: string;
  /** TD operator type of the referencing op, e.g. "moviefileinTOP". */
  optype?: string;
  /**
   * Path of the local Time COMP driving the op, when it differs from the
   * root timeline — a sync then has two candidate timelines.
   */
  local_timeline?: string | null;
  /** Value as authored (may be project-relative). */
  value: string;
  /** Absolute path, for previewing. */
  file: string;
  name: string;
  category: string;
  mode: string;
  sequence?: boolean;
  exists?: boolean;
  bytes?: number | null;
  /** Set when the ref cannot be rewritten (expression/bind/export, sequence). */
  locked?: string | null;
  inside?: boolean;
}

/** Reply from the companion's media_list action. */
export interface MediaListReply {
  ok?: boolean;
  error?: string;
  refs?: MediaRef[];
  count?: number;
  missing?: number;
  total_bytes?: number;
  counts?: Record<string, number>;
}

/**
 * Reply from the companion's media_probe action — facts about the file as the
 * REFERENCING operator decoded it. `kind` says which facts are present:
 * "movie" (resx/resy/fps/frames/seconds/has_audio), "audio"
 * (channels/seconds), "image" (resx/resy), "unopened" (file not open in the
 * op), "none" (nothing to probe for this op type). No codec field: TD does
 * not expose one.
 */
export interface MediaProbeReply {
  ok?: boolean;
  error?: string;
  ref?: string;
  value?: string;
  kind?: "movie" | "audio" | "image" | "unopened" | "none";
  resx?: number;
  resy?: number;
  fps?: number;
  frames?: number;
  seconds?: number | null;
  has_audio?: boolean;
  channels?: number;
  open_failed?: boolean;
}

/** One on-disk media file no operator references (media_unreferenced). */
export interface UnreferencedFile {
  file: string;
  /** Path relative to the project folder — what the list shows. */
  rel: string;
  name: string;
  category: string;
  bytes?: number | null;
}

/** Reply from the companion's media_unreferenced action. */
export interface MediaUnreferencedReply {
  ok?: boolean;
  error?: string;
  files?: UnreferencedFile[];
  count?: number;
  total_bytes?: number;
  referenced_count?: number;
  /**
   * Parameters the scan could not evaluate. Non-zero means files referenced
   * only by broken expressions may wrongly appear unreferenced — present the
   * list as "probably unreferenced" when set.
   */
  unreadable_pars?: number;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// FNSTools (FNS) — see docs/fns-integration.md

/** One artifact (or rail) entry in the FNS release manifest. */
export interface FnsArtifactRef {
  path?: string;
  bytes: number;
  sha256: string;
  url: string;
}

/** One package in the FNS release manifest (fields the UI reads). */
export interface FnsPackage {
  name: string;
  /** `"core"` installs as a unit; `"tool"` is pickable. */
  kind: string;
  category: string;
  description: string;
  /** The governed Pkgversion the updater compares. */
  version: string;
  help_url?: string;
  surfaces?: string[];
  shortcut?: string;
  ops?: number;
  requires?: string[];
  integrates_with?: string[];
  whatsnew?: string;
  artifact?: FnsArtifactRef;
  /** Plus rail (fns-gate.md §4.3): names a TIER ID from `toolkit.tiers`
   *  ("8323905"), or "free"/absent for the free rail. The field is safe to
   *  publish — what's gated is the bytes, fail-closed at the gate. */
  access?: string;
  /** Unreleased: shipped for the creator's own testing, hidden from everyone
   *  else (FNSTools docs/PreviewPackages.md). `access` is then "preview". */
  preview?: boolean;
  /** A Gumroad key exists for this package (toolkit-side redeem). */
  key_available?: boolean;
  /** Present when the package contributes to the LAUNCHER's own surfaces:
   *  it declares a command with a non-`quick` surface, or a capability id.
   *  Absent = commands only, which is most of the fleet. Derived by
   *  reflection on the toolkit side, so it tracks both registration shapes.
   *
   *  CAPABILITY MARKER, NOT A LICENCE ONE — most launcher-capable packages
   *  are gated. Never treat this as "safe to ship inside the app"; that
   *  question is `access === "free"` (see fns_store::package_bundleable). */
  launcher?: { surfaces?: string[]; capabilities?: string[] };
  /** Toolkit's own answer to "may this ship inside the launcher": launcher-
   *  capable AND free. Advisory — the Rust side still checks `access`. */
  seedable?: boolean;
  /** Where the toolkit puts it at install (authored in the CMS): `pane` =
   *  spawned into the working network, `none` = placed nowhere (the FNS
   *  operator family: reached from the OP Create dialog or the family
   *  folder), `root` = beside the toolkit container, absent = a child of it.
   *  The shelves' place action follows this (Rust: placement_lands_in_pane). */
  placement?: "pane" | "none" | "root" | string;
  /** Stock operator types this package stands in for. TD offers it as an
   *  alternative when such an operator is created (alt+ctrl) once the tox
   *  is in the palette store — so downloading it here is what enables that. */
  alternatives_for?: string[];
}

/** One rung of the toolkit's tier ladder, WITH its label — the manifest's
 *  routes projection (fns-gate.md §2): UI copy like "unlocks at the Pro
 *  tier" reads this instead of hardcoding labels. */
export interface FnsTier {
  id: string;
  label: string;
}

export interface FnsCategoryMeta {
  glyph?: string;
  pitch?: string;
}

/** The rolling FNS release manifest, verbatim from the bucket. */
export interface FnsManifest {
  schema: number;
  release: string;
  notes?: string;
  channel?: string;
  base_url?: string;
  toolkit?: {
    name?: string;
    td_build?: string;
    project?: string;
    /** Tier ladder with labels — see FnsTier. */
    tiers?: FnsTier[];
    /** Where "unlocks at …" copy sends people (the creator's Patreon). */
    support_url?: string;
  };
  core: string[];
  categories?: string[];
  category_meta?: Record<string, FnsCategoryMeta>;
  packages: FnsPackage[];
  /** Names the toolkit has retired (renamed or dropped). A stale local
   *  manifest may still carry one of these under `packages`. */
  retired?: string[];
  rails?: Record<string, FnsArtifactRef>;
}

export interface FnsManifestInfo {
  manifest: FnsManifest;
  /** `"network"` fresh, `"cache"` served from disk (offline). */
  source: string;
  baseUrl: string;
}

/** Presence + digest state of one `<name>.tox` in the palette store. */
export interface FnsFileState {
  name: string;
  present: boolean;
  /** null = absent, or the manifest names no digest. */
  shaOk: boolean | null;
  bytes: number;
}

export interface FnsStoreStatus {
  storeDir: string;
  paletteDir: string;
  storeRelease: string | null;
  configPath: string;
  configExists: boolean;
  artifacts: FnsFileState[];
  rails: FnsFileState[];
}

export interface FnsConfigFile {
  path: string;
  exists: boolean;
  content: string;
}

/** A user-authored quick-launch preset — an alias over a registered tool
 *  command with baked argument values. Dormant while its target command
 *  isn't live in any session. */
export interface QuickCommandPreset {
  label: string;
  /** `tool#id` identity of the underlying command. */
  target: string;
  /** Param name → value (strings; registry coerces by declared style). */
  kwargs?: Record<string, string>;
}

/** One user-suppliable argument a tool command declares (fns_commands). The
 *  registry owns validation: values go over the wire as strings and are
 *  coerced by declared style TD-side. */
export interface FnsCommandParam {
  name: string;
  label?: string;
  style?: "str" | "int" | "float" | "toggle" | "menu";
  required?: boolean;
  default?: string | number | boolean;
  /** Menu style: the legal values. */
  menu?: string[];
  help?: string;
  /** Live prefill (registry ≥ 1.6.0): the param's current value, evaluated at
   *  fetch time — seeds the prompt instead of the static default. */
  current?: boolean | string;
}

/** One tool-registered quick-launch command, as fns_commands lists it. */
export interface FnsToolCommand {
  /** Stable execute handle: `<owner COMP path>#<command id>`. */
  key: string;
  /** Owning tool's COMP name, e.g. "HydroHomie". */
  tool: string;
  id: string;
  label: string;
  help?: string;
  /** Owning tool's COMP path inside the session. */
  path?: string;
  /** Arguments to prompt the user for before running. */
  params?: FnsCommandParam[];
  /** Tool-declared default visibility: surfaced only when the user opts in
   *  (an "advanced" affordance — user prefs override in either direction). */
  hidden?: boolean;
  /** Built-in TD/system command (registry ≥ 1.4.0): listed with the palette's
   *  native commands (`>`), not under the tools prefix. */
  builtin?: boolean;
  /** Live state (registry ≥ 1.6.0), evaluated at fetch time: true/false for
   *  toggles (chipped ON/OFF), a short string for values ("0.8", "120"). */
  state?: boolean | string;
  /** Consumer surfaces the command wants (registry ≥ 1.7.0): absent means
   *  quick-launch only; "session" = expanded Sessions card,
   *  "context-menu" = session right-click menu. Serve what you recognise. */
  surface?: string[];
  /** Blessed-capability id (registry ≥ 1.7.0), e.g. "fns.collect" — a
   *  consumer that recognises it may render rich native UI for the group. */
  capability?: string;
  /** Palette-page listing only (`/api/palette/commands`): the launcher's
   *  favourite flag for this command (`quick_favorite_commands`). */
  favorite?: boolean;
  /** Which copy of a multi-instance tool this is (registry >= 1.11.0): the
   *  owner's `FnsInstance()` label, evaluated at fetch time. Absent for
   *  single-instance tools. Curation stays on `tool#id`; a preset may pin
   *  one copy as `tool#id@instance`. */
  instance?: string;
}

/** Reply of the companion's fns_commands verb. */
export interface FnsCommandList {
  ok?: boolean;
  error?: string;
  /** Monotonic change counter — bumps on every registry mutation. */
  rev?: number;
  commands?: FnsToolCommand[];
}

/** One installed package as the companion's fns_status reports it. */
export interface FnsSessionPackage {
  name: string;
  version: string;
}

/** Reply of the companion's fns_status verb. */
export interface FnsSessionStatus {
  ok?: boolean;
  error?: string;
  present?: boolean;
  root?: string | null;
  packages?: FnsSessionPackage[];
  installer?: string | null;
  installer_status?: string | null;
  config_registry?: boolean;
}

/** Reply of the companion's fns_install verb. */
export interface FnsInstallReply {
  ok?: boolean;
  error?: string;
  started?: boolean;
  root?: string;
  installer?: string;
  bootstrapped?: boolean;
  pulse_in_frames?: number;
}

/** One component of a par group in the ConfigRegistry settings state. */
export interface FnsUiParComp {
  name: string;
  val: unknown;
  /** Not constant-mode (bind/expression) — shown, never written. */
  readonly: boolean;
  mode: string;
}

/** One labelled parameter row (a full parGroup) in the settings state. */
export interface FnsUiPar {
  name: string;
  label: string;
  page: string;
  style: string;
  order: number;
  pars: FnsUiParComp[];
  help?: string;
  menuNames?: string[];
  menuLabels?: string[];
  min?: number;
  max?: number;
}

export interface FnsUiTool {
  /** Canonical name -- keys the roaming config JSON; never changes. */
  name: string;
  path: string;
  /** Public name (leading FNS_ dropped) -- what a reader sees. */
  label?: string;
  version?: string;
  pars: FnsUiPar[];
}

/** Where the toolkit's persisted settings live. One switch for the WHOLE
 *  toolkit (there is no per-tool scope): `global` roams through the
 *  machine-wide JSON, `project` keeps everything in the .toe and never
 *  touches that file. */
export type FnsConfigScope = "global" | "project";

/** GET /api/state of the ConfigRegistry settings server (proxied). */
export interface FnsUiState {
  tools: FnsUiTool[];
  config_path?: string;
  project?: string;
  scope?: FnsConfigScope;
  /** Path of the session's FNS_Installer COMP, null when none. */
  installer?: string | null;
}

/** GET/POST /api/scope reply. */
export interface FnsUiScopeReply {
  ok: boolean;
  scope?: FnsConfigScope;
  why?: string;
}

/** POST /api/set reply. */
export interface FnsUiSetReply {
  ok: boolean;
  why?: string;
  val?: unknown;
}
