import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  AppInfo,
  AutosaveFields,
  AutosaveState,
  CachedPatreonTox,
  BackupPlan,
  BackupResult,
  BackupTargetInfo,
  DiscoverResult,
  FileMeta,
  GitCommit,
  GitCommitDetail,
  GitDiff,
  GitHubUser,
  GitStatus,
  GitToolInfo,
  GpuMonitorOption,
  PrefsUpdate,
  ProjectFamily,
  ProjectMeta,
  ProjectMetaInfo,
  ReadmeInfo,
  RestoreResult,
  SafeModeCopy,
  VariantInfo,
  RecentEntry,
  PaletteItem,
  PaletteImportResult,
  PaletteScanRoot,
  ToolboxView,
  FnsConfigFile,
  FnsManifestInfo,
  FnsStoreStatus,
  FnsUiSetReply,
  FnsUiState,
  McpBridgeStatus,
  OpenProject,
  ProcPerf,
  SessionWindow,
  TdPerfResult,
  WindowAction,
  WatchOverview,
  PatreonCampaign,
  PatreonToxPost,
  PatreonSearchResult,
  PatreonPostDetail,
  PatreonZipExtract,
  RcloneStatus,
  SettingsImportResult,
  ControlAddResult,
  ControlCompsResult,
  ControlSchemaResult,
  ControlSetResult,
  ControlValuesResult,
  UtilityUpdateInfo,
  LicenseStatus,
  RecheckReport,
  QuickSeenCommand,
  FnsConfigScope,
  FnsUiScopeReply,
} from "./types";

export const api = {
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  /** Write a portable settings JSON; null = dialog cancelled. */
  exportSettings: (includePaths: boolean) =>
    invoke<string | null>("export_settings_cmd", { includePaths }),
  /** Merge a settings JSON into the live config; null = dialog cancelled. */
  importSettings: () => invoke<SettingsImportResult | null>("import_settings_cmd"),
  /** Upsert tool-command sightings into the historical catalog Settings
   *  curates from; resolves with how many identities were new here. */
  mergeQuickSeenCommands: (cmds: QuickSeenCommand[]) =>
    invoke<number>("merge_quick_seen_commands_cmd", { cmds }),
  getCliToe: () => invoke<string | null>("get_cli_toe_file"),
  getHotkeyStatus: () => invoke<string | null>("get_hotkey_status"),
  getHotkeyStatusQuickAlt: () => invoke<string | null>("get_hotkey_status_quick_alt"),
  getHotkeyStatusMainAlt: () => invoke<string | null>("get_hotkey_status_main_alt"),
  setHotkeyEnabled: (enabled: boolean) =>
    invoke<string | null>("set_hotkey_enabled_cmd", { enabled }),
  /** Flag a quick-overlay .tox drag-out so the Rust blur dismiss holds off. */
  setQuickDragging: (dragging: boolean) =>
    invoke<void>("set_quick_dragging_cmd", { dragging }),
  getHotkeyStatusMain: () => invoke<string | null>("get_hotkey_status_main"),
  setHotkeyEnabledMain: (enabled: boolean) =>
    invoke<string | null>("set_hotkey_enabled_main_cmd", { enabled }),
  getHotkeyStatusPalette: () => invoke<string | null>("get_hotkey_status_palette"),
  setHotkeyEnabledPalette: (enabled: boolean) =>
    invoke<string | null>("set_hotkey_enabled_palette_cmd", { enabled }),
  restartApp: () => invoke<void>("restart_app"),
  getBundledUtilityTox: () => invoke<string | null>("get_bundled_utility_tox"),
  installBundledUtility: () => invoke<string>("install_bundled_utility_cmd"),
  /** Ask the utility release channel whether a newer companion TOX exists. */
  checkUtilityUpdate: () => invoke<UtilityUpdateInfo>("check_utility_update_cmd"),
  /** Download + verify it; returns the version now in force. */
  installUtilityUpdate: () => invoke<string>("install_utility_update_cmd"),
  /** Current entitlement from the cached signed claim (no network). */
  licenseStatus: () => invoke<LicenseStatus>("license_status_cmd"),
  /** Browser sign-in through the gate; resolves when it finishes (or times out). */
  licensePatreonSignIn: () => invoke<LicenseStatus>("license_patreon_sign_in_cmd"),
  /** Best-effort claim refresh before installing an app update. */
  licenseVerifyUpdate: (targetVersion: string) =>
    invoke<void>("license_verify_update_cmd", { targetVersion }),
  /** Forced re-check past the gate's entitlement cache (throttled). */
  licenseRecheck: () => invoke<RecheckReport>("license_recheck_cmd"),
  licenseSignOut: () => invoke<LicenseStatus>("license_sign_out_cmd"),
  discoverVersions: () => invoke<DiscoverResult>("discover_versions"),
  inspectToe: (path: string) => invoke<string | null>("inspect_toe", { path }),
  launchProject: (
    path: string,
    versionKey: string,
    useTouchplayer: boolean,
    promote = true,
  ) =>
    invoke<void>("launch_project", {
      path,
      versionKey,
      useTouchplayer,
      promote,
    }),
  openProjectsList: () => invoke<OpenProject[]>("open_projects_list_cmd"),
  openProjectKill: (pid: number) =>
    invoke<OpenProject[]>("open_project_kill_cmd", { pid }),
  openProjectDismiss: (path: string) =>
    invoke<OpenProject[]>("open_project_dismiss_cmd", { path }),
  openProjectFocus: (pid: number) =>
    invoke<void>("open_project_focus_cmd", { pid }),
  /** Windows of one session, or of every live session when pid is omitted.
   *  Pass the project path to get floating panes labelled by what they show. */
  sessionWindows: (pid?: number, path?: string) =>
    invoke<SessionWindow[]>("session_windows_list_cmd", {
      pid: pid ?? null,
      path: path ?? null,
    }),
  sessionWindowAction: (id: number, action: WindowAction) =>
    invoke<void>("session_window_action_cmd", { id, action }),
  sessionWindowsBulk: (pid: number, action: "raise" | "minimize") =>
    invoke<void>("session_windows_bulk_cmd", { pid, action }),
  /** Process CPU/RAM for all given sessions in one refresh (perf toggle must be on). */
  sessionsPerf: (pids: number[]) =>
    invoke<Record<string, ProcPerf>>("sessions_perf_cmd", { pids }),
  /** TD-internal stats from the companion utility's Perform CHOP. */
  sessionTdPerf: (path: string) =>
    invoke<TdPerfResult>("open_project_utility_cmd", {
      path,
      action: "perf",
      payload: null,
    }),
  openProjectRelaunch: (
    path: string,
    versionKey: string,
    useTouchplayer: boolean,
    killFirst: boolean,
    pid?: number | null,
  ) =>
    invoke<OpenProject[]>("open_project_relaunch_cmd", {
      path,
      versionKey,
      useTouchplayer,
      killFirst,
      pid: pid ?? null,
    }),
  openProjectUtility: (
    path: string,
    action: string,
    payload?: Record<string, unknown> | null,
  ) =>
    invoke<unknown>("open_project_utility_cmd", {
      path,
      action,
      payload: payload ?? null,
    }),
  // Autosave left the companion for the FNS_Autosave package (D7): the
  // launcher drives it through the fns.autosave capability now, so there are
  // no autosave_* wrappers here any more.
  /** Exposed-parameter schema from the running session's utility (Control page). */
  controlSchema: (path: string) =>
    invoke<ControlSchemaResult>("open_project_utility_cmd", {
      path,
      action: "control_schema",
      payload: null,
    }),
  /** Current values of every exposed parameter — cheap poll companion. */
  controlValues: (path: string) =>
    invoke<ControlValuesResult>("open_project_utility_cmd", {
      path,
      action: "control_get",
      payload: null,
    }),
  /** Write values to exposed parameters (utility refuses anything outside the schema). */
  controlSet: (
    path: string,
    sets: { target: string; par: string; value: unknown }[],
  ) =>
    invoke<ControlSetResult>("open_project_utility_cmd", {
      path,
      action: "control_set",
      payload: { sets },
    }),
  /** Candidate COMPs (with custom pars) the session could expose remotely. */
  controlComps: (path: string, parent?: string) =>
    invoke<ControlCompsResult>("open_project_utility_cmd", {
      path,
      action: "control_comps",
      payload: parent ? { parent } : null,
    }),
  /** Point a Control-sequence block at a COMP — expose it remotely. */
  controlAddComp: (path: string, comp: string) =>
    invoke<ControlAddResult>("open_project_utility_cmd", {
      path,
      action: "control_add",
      payload: { comp },
    }),
  /** Stop exposing a Control-sequence block (schema key "blockN"). */
  controlRemoveComp: (path: string, key: string) =>
    invoke<ControlAddResult>("open_project_utility_cmd", {
      path,
      action: "control_remove",
      payload: { key },
    }),
  getConfig: () => invoke<AppConfig>("get_config"),
  updatePrefs: (prefs: PrefsUpdate) => invoke<AppConfig>("update_prefs", { prefs }),
  getRecents: (merged = true) => invoke<RecentEntry[]>("get_recents", { merged }),
  addRecent: (path: string) => invoke<void>("add_recent", { path }),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  clearRecents: () => invoke<void>("clear_recents"),
  clearMissing: () => invoke<number>("clear_missing"),
  listProjectFamilies: (entries: { path: string; last_opened?: number | null }[]) =>
    invoke<ProjectFamily[]>("list_project_families_cmd", { entries }),
  createVariant: (sourcePath: string) =>
    invoke<VariantInfo>("create_variant_cmd", { sourcePath }),
  createSafeModeCopy: (sourcePath: string, overwrite = false) =>
    invoke<SafeModeCopy>("create_safe_mode_copy_cmd", { sourcePath, overwrite }),
  restoreVariantAsHead: (variantPath: string) =>
    invoke<RestoreResult>("restore_variant_as_head_cmd", { variantPath }),
  trashVariants: (paths: string[]) => invoke<number>("trash_variants_cmd", { paths }),
  openQuick: () => invoke<void>("open_quick_cmd"),
  patreonCachedTox: () => invoke<CachedPatreonTox[]>("patreon_cached_tox_cmd"),
  getTemplates: () => invoke<string[]>("get_templates"),
  addTemplate: (path: string) => invoke<void>("add_template", { path }),
  removeTemplate: (path: string) => invoke<void>("remove_template", { path }),
  moveTemplate: (path: string, direction: "up" | "down") =>
    invoke<void>("move_template", { path, direction }),
  importPlusTemplates: () =>
    invoke<{ imported: number; total: number; source: string }>("import_plus_templates_cmd"),
  getIconDataUrl: (path: string) => invoke<string | null>("get_icon_data_url", { path }),
  getProjectMeta: (path: string) => invoke<ProjectMetaInfo>("get_project_meta", { path }),
  getProjectsMeta: (paths: string[]) =>
    invoke<ProjectMetaInfo[]>("get_projects_meta", { paths }),
  getAllTags: (paths: string[]) => invoke<string[]>("get_all_tags", { paths }),
  saveProjectMeta: (path: string, meta: ProjectMeta) =>
    invoke<string>("save_project_meta_cmd", { path, meta }),
  listGpuMonitors: () => invoke<GpuMonitorOption[]>("list_gpu_monitors"),
  /** Write the sidecar `gpu` block; applies on the project's next launch. */
  setProjectGpuAffinity: (
    path: string,
    monitor: number | null,
    busId: string | null = null,
  ) => invoke<string>("set_project_gpu_affinity", { path, monitor, busId }),
  showMainWindow: () => invoke<void>("show_main_window"),
  getReadme: (path: string) => invoke<ReadmeInfo>("get_readme", { path }),
  saveReadme: (projectPath: string, content: string) =>
    invoke<string>("save_readme_cmd", { projectPath, content }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  /** Start (if needed) the browser control server; returns the tokened URL. */
  openControlServer: () => invoke<string>("open_control_server_cmd"),
  phoneRemoteStart: () => invoke<string>("phone_remote_start_cmd"),
  /** Client-tier link: authored controls only (server-enforced). */
  controlRegenerateToken: () => invoke<void>("control_regenerate_token_cmd"),
  controlServerStop: () => invoke<void>("control_server_stop_cmd"),
  /** Is the control server serving, and on what bind — header Phone indicator. */
  controlServerStatus: () =>
    invoke<{ running: boolean; lan: boolean; port: number }>("control_server_status_cmd"),
  pickToeFiles: (multiple: boolean) =>
    invoke<string[]>("pick_toe_files", { multiple }),
  pickToxFiles: (multiple: boolean) =>
    invoke<string[]>("pick_tox_files", { multiple }),
  /** Replacement media file for the media browser; null = dialog cancelled. */
  /**
   * Map basenames to full paths under a folder — the batch-relink helper.
   * Case-insensitive; only names that were found appear in the result.
   */
  locateMediaFiles: (root: string, names: string[]) =>
    invoke<Record<string, string>>("locate_media_files_cmd", { root, names }),
  pickMediaFile: (category: string) =>
    invoke<string | null>("pick_media_file", { category }),
  cacheToxFromUrl: (source: string) =>
    invoke<{
      path: string;
      source: string;
      filename: string;
      fromCache: boolean;
      resolvedUrl: string;
    }>("cache_tox_from_url_cmd", { source }),
  // Shared command usage (command-usage.json, with FNSTools' palette).
  commandUsageRecord: (identity: string) => invoke<void>("command_usage_record", { identity }),
  commandUsageBonuses: () => invoke<Record<string, number>>("command_usage_bonuses"),
  commandUsageClear: () => invoke<void>("command_usage_clear"),
  tdpEnvStatus: (path: string) =>
    invoke<{
      projectDir: string;
      hasContext: boolean;
      contextSource: string | null;
      venvPath: string | null;
      pythonPath: string | null;
      uvPath: string | null;
      uvAvailable: boolean;
      ready: boolean;
    }>("tdp_env_status_cmd", { path }),
  tdpInstallPackage: (path: string, spec: string) =>
    invoke<{
      spec: string;
      module: string;
      toxPath: string;
      venvPath: string;
      alreadyInstalled: boolean;
      uvLog: string;
    }>("tdp_install_package_cmd", { path, spec }),
  tdpPypiCatalog: (forceRefresh = false) =>
    invoke<{
      source: string;
      fetchedAt: number;
      packages: Array<{
        id: string;
        name: string;
        summary: string;
        version: string;
        tags: string[];
        homePage: string;
        projectUrl: string;
        spec: string;
        module: string;
        yanked: boolean;
      }>;
      fromCache: boolean;
    }>("tdp_pypi_catalog_cmd", { forceRefresh }),
  tdpPypiReadme: (name: string) =>
    invoke<{
      name: string;
      markdown: string;
      sourceUrl: string;
    }>("tdp_pypi_readme_cmd", { name }),
  patreonOpenLogin: () => invoke<void>("patreon_open_login"),
  patreonTryCapture: () => invoke<string>("patreon_try_capture"),
  /** Forget the session cookie AND clear patreon.com cookies from our webview. */
  patreonLogout: () => invoke<AppConfig>("patreon_logout"),
  patreonListCampaigns: () =>
    invoke<PatreonCampaign[]>("patreon_list_campaigns_cmd"),
  patreonAddCreator: (url: string) =>
    invoke<PatreonCampaign>("patreon_add_creator_cmd", { url }),
  patreonRemoveCreator: (campaignId: string) =>
    invoke<void>("patreon_remove_creator_cmd", { campaignId }),
  /** The creator's name rides along so the listing lands in the search index under it. */
  patreonListToxPosts: (campaignId: string, campaignName?: string) =>
    invoke<PatreonToxPost[]>("patreon_list_tox_posts_cmd", { campaignId, campaignName }),
  /** Name-search the cached listings + downloaded files, across every creator.
   *  Local only, no network — safe to call while the user is still typing. */
  patreonSearch: (query: string) => invoke<PatreonSearchResult>("patreon_search_cmd", { query }),
  patreonCampaignLastUpload: (campaignId: string) =>
    invoke<string | null>("patreon_campaign_last_upload_cmd", { campaignId }),
  patreonCampaignLatestPost: (campaignId: string) =>
    invoke<string | null>("patreon_campaign_latest_post_cmd", { campaignId }),
  patreonPostDetail: (postId: string) =>
    invoke<PatreonPostDetail>("patreon_post_detail_cmd", { postId }),
  patreonDownloadTox: (url: string, filename: string, campaignName: string) =>
    invoke<string>("patreon_download_tox_cmd", { url, filename, campaignName }),
  patreonExtractZip: (url: string, filename: string, campaignName: string) =>
    invoke<PatreonZipExtract>("patreon_extract_zip_cmd", { url, filename, campaignName }),
  patreonZipExtractStatus: (url: string, filename: string, campaignName: string) =>
    invoke<PatreonZipExtract | null>("patreon_zip_extract_status_cmd", {
      url,
      filename,
      campaignName,
    }),
  /** Where a Patreon file already sits on disk, or null if not downloaded yet. No network. */
  patreonToxLocalPath: (url: string, filename: string, campaignName: string) =>
    invoke<string | null>("patreon_tox_local_path_cmd", { url, filename, campaignName }),
  pickFolder: (title?: string) =>
    invoke<string | null>("pick_folder", { title: title ?? null }),
  defaultPaletteDir: () => invoke<string>("default_palette_dir_cmd"),
  getDragIconPath: () => invoke<string>("get_drag_icon_path"),
  getPaletteItems: (factoryInstall?: string | null) =>
    invoke<PaletteItem[]>("get_palette_items_cmd", {
      factoryInstall: factoryInstall || null,
    }),
  importToxToPalette: (paths: string[], destFolder?: string | null) =>
    invoke<PaletteImportResult>("import_tox_to_palette_cmd", {
      paths,
      destFolder: destFolder ?? null,
    }),
  removePaletteFile: (path: string) => invoke<void>("remove_palette_file_cmd", { path }),
  rebuildPaletteData: () => invoke<string>("rebuild_palette_data_cmd"),
  paletteScanInfo: (factoryInstall?: string | null) =>
    invoke<PaletteScanRoot[]>("palette_scan_info_cmd", {
      factoryInstall: factoryInstall || null,
    }),
  getToolbox: () => invoke<ToolboxView>("toolbox_get_cmd"),
  toolboxSeedBundled: () => invoke<ToolboxView>("toolbox_seed_bundled_cmd"),
  toolboxAddTool: (
    label: string,
    kind: string,
    source: string,
    category: string,
    notes?: string | null,
  ) =>
    invoke<ToolboxView>("toolbox_add_tool_cmd", {
      label,
      kind,
      source,
      category,
      notes: notes ?? null,
    }),
  toolboxUpdateTool: (
    id: string,
    patch: { label?: string; category?: string; source?: string; notes?: string },
  ) =>
    invoke<ToolboxView>("toolbox_update_tool_cmd", {
      id,
      label: patch.label ?? null,
      category: patch.category ?? null,
      source: patch.source ?? null,
      notes: patch.notes ?? null,
    }),
  toolboxRemoveTool: (id: string) =>
    invoke<ToolboxView>("toolbox_remove_tool_cmd", { id }),
  toolboxMoveTool: (id: string, direction: "up" | "down") =>
    invoke<ToolboxView>("toolbox_move_tool_cmd", { id, direction }),
  toolboxFetchTool: (id: string) =>
    invoke<ToolboxView>("toolbox_fetch_tool_cmd", { id }),
  toolboxAddCategory: (name: string) =>
    invoke<ToolboxView>("toolbox_add_category_cmd", { name }),
  toolboxRenameCategory: (old: string, next: string) =>
    invoke<ToolboxView>("toolbox_rename_category_cmd", { old, new: next }),
  toolboxRemoveCategory: (name: string) =>
    invoke<ToolboxView>("toolbox_remove_category_cmd", { name }),
  toolboxMoveCategory: (name: string, direction: "up" | "down") =>
    invoke<ToolboxView>("toolbox_move_category_cmd", { name, direction }),
  // FNSTools (FNS) — docs/fns-integration.md
  fnsManifest: (refresh: boolean) =>
    invoke<FnsManifestInfo>("fns_manifest_cmd", { refresh }),
  fnsStoreStatus: () => invoke<FnsStoreStatus>("fns_store_status_cmd"),
  fnsSyncStore: (names?: string[] | null, includeRails?: boolean) =>
    invoke<FnsStoreStatus>("fns_sync_store_cmd", {
      names: names ?? null,
      includeRails: includeRails ?? null,
    }),
  /** `minimal` writes the install-one-capability shape: exactly these
   *  packages plus their own requires, no forced core, no removals. Off for
   *  the FNS tab's picker, where getting the registries is the point. */
  fnsWriteSelection: (tools: string[], minimal = false) =>
    invoke<string>("fns_write_selection_cmd", { tools, minimal }),
  /** Bootstrap tox to hand the companion: the palette store's rail when it
   *  is there, else the copy bundled with this app. `null` = neither, so the
   *  toolkit genuinely cannot be installed on this machine without a sync. */
  fnsBootstrapPath: () => invoke<string | null>("fns_bootstrap_path_cmd"),
  /** Land one FNS package in a session by its manifest `placement`: pane /
   *  none drop into the pane (`load_tox`), the rest install through
   *  FNS_Installer with a minimal one-package selection. */
  fnsPlace: (session: string, name: string) =>
    invoke<Record<string, unknown>>("fns_place_cmd", { session, name }),
  fnsConfigRead: () => invoke<FnsConfigFile>("fns_config_read_cmd"),
  fnsConfigWrite: (content: string) =>
    invoke<void>("fns_config_write_cmd", { content }),
  fnsSettingsState: (url: string) =>
    invoke<FnsUiState>("fns_settings_state_cmd", { url }),
  fnsSettingsSet: (url: string, tool: string, par: string, value: unknown) =>
    invoke<FnsUiSetReply>("fns_settings_set_cmd", { url, tool, par, value }),
  /** Read the config scope (no args) or flip it; "global" needs a mode. */
  fnsSettingsScope: (url: string, value?: FnsConfigScope, mode?: "push" | "adopt") =>
    invoke<FnsUiScopeReply>("fns_settings_scope_cmd", { url, value, mode }),
  backupTargetInfo: (path: string, remoteOverride?: string | null) =>
    invoke<BackupTargetInfo>("backup_target_info_cmd", {
      path,
      remoteOverride: remoteOverride ?? null,
    }),
  backupPlan: (path: string, mode: string, remoteOverride?: string | null) =>
    invoke<BackupPlan>("backup_plan_cmd", {
      path,
      mode,
      remoteOverride: remoteOverride ?? null,
    }),
  backupRun: (path: string, mode: string, remoteOverride?: string | null) =>
    invoke<BackupResult>("backup_run_cmd", {
      path,
      mode,
      remoteOverride: remoteOverride ?? null,
    }),
  rcloneStatus: () => invoke<RcloneStatus>("rclone_status_cmd"),
  rcloneInstall: () => invoke<RcloneStatus>("rclone_install_cmd"),
  rcloneRemoteAdd: (name: string, provider: string) =>
    invoke<RcloneStatus>("rclone_remote_add_cmd", { name, provider }),
  rcloneRemoteDelete: (name: string) =>
    invoke<RcloneStatus>("rclone_remote_delete_cmd", { name }),
  cloudBackupInfo: (path: string, remote: string, remotePath?: string | null) =>
    invoke<BackupTargetInfo>("cloud_backup_info_cmd", {
      path,
      remote,
      remotePath: remotePath ?? null,
    }),
  cloudBackupPlan: (
    path: string,
    remote: string,
    mode: string,
    remotePath?: string | null,
  ) =>
    invoke<BackupPlan>("cloud_backup_plan_cmd", {
      path,
      remote,
      mode,
      remotePath: remotePath ?? null,
    }),
  cloudBackupRun: (
    path: string,
    remote: string,
    mode: string,
    remotePath?: string | null,
  ) =>
    invoke<BackupResult>("cloud_backup_run_cmd", {
      path,
      remote,
      mode,
      remotePath: remotePath ?? null,
    }),
  getDownloadUrl: (buildOption: string) =>
    invoke<string | null>("get_download_url", { buildOption }),
  downloadTd: (url: string, destPath: string) =>
    invoke<void>("download_td", { url, destPath }),
  openInstaller: (path: string) => invoke<void>("open_installer", { path }),
  checkVersionInstalled: (version: string, useTouchplayer: boolean) =>
    invoke<boolean>("check_version_installed", { version, useTouchplayer }),
  rediscoverAndCheck: (version: string, useTouchplayer: boolean) =>
    invoke<boolean>("rediscover_and_check", { version, useTouchplayer }),
  getFileMeta: (path: string) => invoke<FileMeta>("get_file_meta_cmd", { path }),
  getFilesMeta: (paths: string[]) => invoke<FileMeta[]>("get_files_meta_cmd", { paths }),
  gitStatus: (path: string) => invoke<GitStatus>("git_status_cmd", { path }),
  gitToolInfo: () => invoke<GitToolInfo>("git_tool_info_cmd"),
  /** `gitignore` seeds a TouchDesigner .gitignore in the new repo. */
  gitInit: (path: string, gitignore = true) =>
    invoke<GitStatus>("git_init_cmd", { path, gitignore }),
  gitStage: (path: string, paths: string[] = []) =>
    invoke<GitStatus>("git_stage_cmd", { path, paths }),
  gitIgnoreAdd: (path: string, pattern: string) =>
    invoke<boolean>("git_ignore_add_cmd", { path, pattern }),
  gitUnstage: (path: string, paths: string[] = []) =>
    invoke<GitStatus>("git_unstage_cmd", { path, paths }),
  gitCommit: (path: string, message: string, addAll = false) =>
    invoke<GitStatus>("git_commit_cmd", { path, message, addAll }),
  gitCheckout: (path: string, branch: string, create = false) =>
    invoke<GitStatus>("git_checkout_cmd", { path, branch, create }),
  gitSetRemote: (path: string, name: string, url: string) =>
    invoke<GitStatus>("git_set_remote_cmd", { path, name, url }),
  gitDiff: (path: string, file: string, staged = false) =>
    invoke<GitDiff>("git_diff_cmd", { path, file, staged }),
  gitLog: (path: string, limit = 100) =>
    invoke<GitCommit[]>("git_log_cmd", { path, limit }),
  gitShow: (path: string, rev: string, file?: string | null) =>
    invoke<GitCommitDetail>("git_show_cmd", {
      path,
      rev,
      file: file ?? null,
    }),
  gitPush: (path: string, remote?: string | null, setUpstream = true) =>
    invoke<GitStatus>("git_push_cmd", {
      path,
      remote: remote ?? null,
      setUpstream,
    }),
  gitPull: (path: string, remote?: string | null) =>
    invoke<GitStatus>("git_pull_cmd", { path, remote: remote ?? null }),
  verifyGithubToken: (token: string) =>
    invoke<GitHubUser>("verify_github_token_cmd", { token }),
  watchStatus: () => invoke<WatchOverview>("watch_status_cmd"),
  watchProjectId: (path: string) => invoke<string>("watch_project_id_cmd", { path }),
  watchStart: (path: string, versionKey: string, useTouchplayer = false, existingPid?: number | null) =>
    invoke<WatchOverview>("watch_start_cmd", {
      path,
      versionKey,
      useTouchplayer,
      existingPid: existingPid ?? null,
    }),
  watchStop: (id: string) => invoke<WatchOverview>("watch_stop_cmd", { id }),
  watchStopAll: () => invoke<WatchOverview>("watch_stop_all_cmd"),
  mcpStatus: (path: string) => invoke<McpBridgeStatus>("mcp_status_cmd", { path }),
  mcpOpenFolder: (path: string) => invoke<void>("mcp_open_folder_cmd", { path }),
  mcpSetPort: (path: string, port: number) =>
    invoke<McpBridgeStatus>("mcp_set_port_cmd", { path, port }),
  alertTestEmail: () => invoke<string>("alert_test_email_cmd"),
  quitApp: () => invoke<void>("quit_app"),
  writeTempHtml: (content: string) => invoke<string>("write_temp_html", { content }),
};
