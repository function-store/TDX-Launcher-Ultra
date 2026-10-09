//! Tauri command handlers for TDX Launcher Ultra.

use crate::backup::{self, BackupFilters, BackupPlan, BackupResult, BackupTargetInfo};
use crate::rclone::{self, RcloneStatus};
use crate::config::{AppConfig, ConfigManager, PlusTemplatesImport, PrefsUpdate, RecentEntry};
use crate::git::{self, GitCommit, GitCommitDetail, GitDiff, GitHubUser, GitStatus};
use crate::palette::{self, PaletteItem};
use crate::project::{
    get_file_meta, get_files_meta, get_readme_info, icon_data_url, open_in_file_manager, save_readme,
    FileMeta, ReadmeInfo,
};
use crate::project_meta::{
    collect_tags, load_project_meta, load_projects_meta, save_project_meta, ProjectMeta,
    ProjectMetaInfo,
};
use crate::td_manager::{DiscoverResult, TDManager, DEFAULT_TEMPLATE};
use crate::variants;
use crate::notify::{self, EmailConfig};
use crate::mcp_bridge::{self, McpBridgeStatus};
use crate::open_projects::{OpenProject, OpenProjectsHub};
use crate::watch::{self, WatchConfig, WatchManager, WatchOverview};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Single source of truth is the crate version, which `tauri build` keeps in
/// step with `tauri.conf.json`. Hardcoding it here drifted once already (the
/// About box read 0.2.1 while the updater compared against 0.3.0), so don't.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Version of the utility TOX bundled with this build (utility/UTILITY_VERSION;
/// the same string lives in TDXLUUtilityExt.UTILITY_VERSION — bump both).
///
/// This is the floor, not necessarily what the launcher hands out: a newer TOX
/// pulled from the utility release channel supersedes it. See
/// [`crate::updates::effective_utility`].
pub fn bundled_utility_version() -> &'static str {
    include_str!("../../utility/UTILITY_VERSION").trim()
}

pub struct AppState {
    pub cli_toe: Mutex<Option<String>>,
    /// True while the quick-launch overlay has a .tox drag-out in flight —
    /// the Rust-side blur dismiss must not hide the window mid-drag.
    pub quick_dragging: std::sync::atomic::AtomicBool,
    /// True once the current summon of the overlay has actually held focus.
    ///
    /// Arms the blur dismiss. Without it, anything that steals foreground
    /// during the summon — a UAC prompt or toast, for example — makes the
    /// overlay hide itself the instant it appears, which reads as a one-frame blink.
    /// Cleared on every show, set on the first Focused(true).
    pub quick_focused: std::sync::atomic::AtomicBool,
    pub config: Mutex<ConfigManager>,
    pub td: Mutex<TDManager>,
    pub watch: Mutex<WatchManager>,
    pub open: Mutex<OpenProjectsHub>,
    /// Result of registering each global hotkey at startup: None = ok/disabled,
    /// Some(msg) = why it failed (bad combo, already in use). Read by Settings.
    pub hotkey_status: Mutex<HotkeyStatus>,
    /// Browser control panel server (started lazily, lives until app exit).
    pub control: Mutex<crate::control_server::ControlServerState>,
    /// Persistent sysinfo sampler — CPU% needs deltas between refreshes of the
    /// same instance, so it must outlive individual session_perf_cmd calls.
    pub perf: Mutex<crate::session_perf::PerfSampler>,
}

/// Registration status of each of the three global hotkeys (quick-launch
/// overlay, main window, main window on Palette). None = ok or disabled.
#[derive(Default, Clone)]
pub struct HotkeyStatus {
    pub quick: Option<String>,
    /// The quick overlay's optional alternate combo.
    pub quick_alt: Option<String>,
    pub main: Option<String>,
    /// The main window's optional alternate combo.
    pub main_alt: Option<String>,
    pub palette: Option<String>,
}

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub default_template: String,
    /// Whether this build compiled the optional Patreon import (Cargo feature).
    /// The frontend gates the whole Patreon UI on this.
    pub patreon_enabled: bool,
    /// Version of the utility TOX this launcher hands out — the bundled copy,
    /// or a newer one pulled from the utility release channel. Independent of
    /// the app version; the two update separately.
    pub utility_version: String,
    /// Launched by the OS at login (autostart `--autostart` flag) — the
    /// frontend starts in the tray instead of showing the window.
    pub autostart_launch: bool,
}

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: APP_VERSION.into(),
        platform: std::env::consts::OS.into(),
        default_template: DEFAULT_TEMPLATE.into(),
        patreon_enabled: cfg!(feature = "patreon"),
        utility_version: crate::updates::effective_utility_version(&app),
        autostart_launch: std::env::args().any(|a| a == "--autostart"),
    }
}

/// The `.toe` this run was asked to open, if any — **consumed on read**.
///
/// One-shot on purpose. This used to clone, so the path lived in state forever
/// and EVERY mount of the frontend re-armed the five-second auto-launch: a dev
/// server reload, or any webview reload, silently opened the project again. A
/// pending open belongs to one startup, not to every mount.
///
/// The single-instance hook refills the slot for a file opened while we are
/// already running and also emits `cli-toe-opened` at the mounted window;
/// whichever path gets there first wins and the other finds the slot empty.
#[tauri::command]
pub fn get_cli_toe_file(state: State<'_, AppState>) -> Option<String> {
    let mut slot = state.cli_toe.lock().ok()?;
    slot.take()
}

/// Why the quick-launch hotkey didn't register (bad combo / in use), or None if fine.
#[tauri::command]
pub fn get_hotkey_status(state: State<'_, AppState>) -> Option<String> {
    state.hotkey_status.lock().ok().and_then(|s| s.quick.clone())
}

/// Registration status of the quick overlay's optional alternate combo.
#[tauri::command]
pub fn get_hotkey_status_quick_alt(state: State<'_, AppState>) -> Option<String> {
    state
        .hotkey_status
        .lock()
        .ok()
        .and_then(|s| s.quick_alt.clone())
}

/// Registration status of the main window's optional alternate combo.
#[tauri::command]
pub fn get_hotkey_status_main_alt(state: State<'_, AppState>) -> Option<String> {
    state
        .hotkey_status
        .lock()
        .ok()
        .and_then(|s| s.main_alt.clone())
}

/// The overlay reports drag-out state so the Rust-side focus-loss dismiss
/// (see the quick window's event handler in lib.rs) leaves the window up
/// while a .tox drag is in flight.
#[tauri::command]
pub fn set_quick_dragging_cmd(state: State<'_, AppState>, dragging: bool) {
    state
        .quick_dragging
        .store(dragging, std::sync::atomic::Ordering::Relaxed);
}

/// Enable/disable the quick-launch hotkey live (persists + (un)registers).
/// Returns a status message on failure, else null.
#[tauri::command]
pub fn set_hotkey_enabled_cmd(app: AppHandle, enabled: bool) -> Option<String> {
    #[cfg(desktop)]
    {
        crate::set_hotkey_enabled(&app, crate::HotkeyTarget::Quick, enabled)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        None
    }
}

/// Why the main-window hotkey didn't register, or None if fine.
#[tauri::command]
pub fn get_hotkey_status_main(state: State<'_, AppState>) -> Option<String> {
    state.hotkey_status.lock().ok().and_then(|s| s.main.clone())
}

/// Enable/disable the main-window hotkey live. Returns a status message on
/// failure, else null.
#[tauri::command]
pub fn set_hotkey_enabled_main_cmd(app: AppHandle, enabled: bool) -> Option<String> {
    #[cfg(desktop)]
    {
        crate::set_hotkey_enabled(&app, crate::HotkeyTarget::Main, enabled)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        None
    }
}

/// Why the Palette hotkey didn't register, or None if fine.
#[tauri::command]
pub fn get_hotkey_status_palette(state: State<'_, AppState>) -> Option<String> {
    state.hotkey_status.lock().ok().and_then(|s| s.palette.clone())
}

/// Enable/disable the Palette hotkey live. Returns a status message on
/// failure, else null.
#[tauri::command]
pub fn set_hotkey_enabled_palette_cmd(app: AppHandle, enabled: bool) -> Option<String> {
    #[cfg(desktop)]
    {
        crate::set_hotkey_enabled(&app, crate::HotkeyTarget::Palette, enabled)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        None
    }
}

/// Restart the application (used by "restart to apply" links in Settings).
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// Absolute path to the companion TOX this launcher hands out — a newer copy
/// downloaded from the utility channel when there is one, else the build's
/// bundled resource. `None` in a dev build with neither.
///
/// Named for the bundled case it started as; it is the *effective* utility now
/// (the IPC name is kept so existing callers and the demo mock keep working).
#[tauri::command]
pub fn get_bundled_utility_tox(app: AppHandle) -> Option<String> {
    let (_, path) = crate::updates::effective_utility(&app);
    Some(path?.to_string_lossy().replace('\\', "/"))
}

/// Ask the utility release channel whether a newer companion TOX exists.
/// Network call; returns `available: false` when already current.
#[tauri::command(async)]
pub fn check_utility_update_cmd(
    app: AppHandle,
) -> Result<crate::updates::UtilityUpdateInfo, String> {
    crate::updates::check_utility_update(&app)
}

/// Download + verify the newest utility TOX and make it the effective one.
///
/// Only the launcher's own copy changes here. Pushing it into a *running*
/// session is still the existing repoint flow (`install_bundled_utility_cmd`
/// then the utility's own reload), which now picks this file up automatically.
/// Any Toolbox tool pinned to the previous copy is retargeted so the drag
/// handle doesn't keep serving the old version. Returns the new version.
#[tauri::command(async)]
pub fn install_utility_update_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let previous = crate::updates::effective_utility(&app)
        .1
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    let version = crate::updates::install_utility_update(&app)?;

    if let (Some(old), Some(new)) = (
        previous,
        crate::updates::effective_utility(&app)
            .1
            .map(|p| p.to_string_lossy().replace('\\', "/")),
    ) {
        if !old.eq_ignore_ascii_case(&new) {
            if let Ok(mut cfg) = state.config.lock() {
                let _ = cfg.toolbox_retarget_local(&old, &new);
            }
        }
    }
    Ok(version)
}

// ---------------------------------------------------------------------------
// FNS tools store + configurator (see docs/fns-integration.md and fns_store.rs)

/// The rolling FNS release manifest — cache-first unless `refresh`.
#[tauri::command(async)]
pub fn fns_manifest_cmd(
    refresh: bool,
    state: State<'_, AppState>,
) -> Result<crate::fns_store::FnsManifestInfo, String> {
    let base = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.fns_base_url.clone()
    };
    crate::fns_store::get_manifest(&base, refresh)
}

/// What the palette store holds, checked against the best local manifest.
#[tauri::command(async)]
pub fn fns_store_status_cmd() -> Result<crate::fns_store::FnsStoreStatus, String> {
    Ok(crate::fns_store::store_status(None))
}

/// Download manifest + artifacts into the palette store (all packages when
/// `names` is omitted). Progress rides `transfer-progress` as `fns-store`.
#[tauri::command(async)]
pub fn fns_sync_store_cmd(
    names: Option<Vec<String>>,
    include_rails: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::fns_store::FnsStoreStatus, String> {
    let base = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.fns_base_url.clone()
    };
    let emit = progress_emitter(app, "fns-store");
    crate::fns_store::sync_store(
        &base,
        names.as_deref(),
        include_rails.unwrap_or(false),
        emit,
    )
}

/// Write `<palette>/FNSTools/selection.json` for the given tool names; returns its path.
///
/// `minimal` (default false) writes the install-one-capability shape: exactly
/// these packages plus their own `requires`, no forced core and no removals.
/// Leave it off for the FNS tab's toolkit picker, where choosing a set and
/// getting the registries with it is the point.
#[tauri::command(async)]
pub fn fns_write_selection_cmd(
    tools: Vec<String>,
    minimal: Option<bool>,
) -> Result<String, String> {
    crate::fns_store::write_selection(&tools, minimal.unwrap_or(false))
}

/// Land one FNS package in a session from the desktop shelf, honouring its
/// manifest `placement` exactly like the in-TD page's ↳ (see
/// `palette_tabs::place`): pane/none drop into the pane, the rest install
/// through FNS_Installer. `session` is the project path the companion bus
/// is keyed by.
#[tauri::command(async)]
pub fn fns_place_cmd(
    app: AppHandle,
    session: String,
    name: String,
) -> Result<serde_json::Value, String> {
    if name.contains(['/', '\\', ':']) {
        return Err("bad package name".into());
    }
    crate::palette_tabs::place(
        &app,
        &session,
        &serde_json::json!({ "kind": "fns", "name": name }),
    )
}

/// Path to the FNSTools bootstrap to hand the companion: the palette store's
/// rail when present, else the copy bundled with this app. `None` means
/// neither exists — the caller should say the toolkit needs a sync rather
/// than pretend an install is possible.
#[tauri::command(async)]
pub fn fns_bootstrap_path_cmd(app: AppHandle, state: State<'_, AppState>) -> Option<String> {
    // Same rule as the pane's install route: bring the store's rail up to
    // the bucket first, so the bundle is only ever the offline fallback.
    if let Ok(cfg) = state.config.lock() {
        let base = cfg.config.fns_base_url.clone();
        drop(cfg);
        crate::fns_store::refresh_rails(&base);
    }
    crate::fns_store::effective_bootstrap(&app)
}

/// Local path to a capability artifact bundled with this app, or `None`.
/// Hand it to the installer's `source` so a machine that never synced can
/// still install that package.
#[tauri::command(async)]
pub fn fns_bundled_artifact_cmd(app: AppHandle, package: String) -> Option<String> {
    crate::fns_store::bundled_artifact(&app, &package)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// The global FNS config JSON (offline configurator source).
#[tauri::command(async)]
pub fn fns_config_read_cmd() -> Result<crate::fns_store::FnsConfigFile, String> {
    crate::fns_store::read_config()
}

/// Overwrite the global FNS config JSON (validated, atomic, `.bak` kept).
#[tauri::command(async)]
pub fn fns_config_write_cmd(content: String) -> Result<(), String> {
    crate::fns_store::write_config(&content)
}

/// Proxy `GET /api/state` on a live ConfigRegistry settings server.
/// Free, like the rest of the FNS bridge.
#[tauri::command(async)]
pub fn fns_settings_state_cmd(url: String) -> Result<serde_json::Value, String> {
    crate::fns_store::settings_state(&url)
}

/// Proxy `POST /api/set` on a live ConfigRegistry settings server.
#[tauri::command(async)]
pub fn fns_settings_set_cmd(
    url: String,
    tool: String,
    par: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::fns_store::settings_set(&url, &tool, &par, &value)
}

/// Proxy `/api/scope` on a live ConfigRegistry settings server: read the
/// toolkit's config scope, or flip it (to global only with a push/adopt mode).
#[tauri::command(async)]
pub fn fns_settings_scope_cmd(
    url: String,
    value: Option<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::fns_store::settings_scope(&url, value.as_deref(), mode.as_deref())
}

#[tauri::command(async)]
pub fn discover_versions(state: State<'_, AppState>) -> Result<DiscoverResult, String> {
    let mut td = state.td.lock().map_err(|e| e.to_string())?;
    Ok(td.discover())
}

#[tauri::command(async)]
pub fn inspect_toe(
    app: AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p);
    let td = state.td.lock().map_err(|e| e.to_string())?;
    Ok(td.inspect_toe_file(&path, resource_dir.as_deref()))
}

#[tauri::command]
pub fn launch_project(
    app: AppHandle,
    path: String,
    version_key: String,
    use_touchplayer: bool,
    promote: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (quit_after, hide_after) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (cfg.config.quit_after_launch, cfg.config.hide_after_launch)
    };
    if promote && path != DEFAULT_TEMPLATE {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.add_recent_file(&path)?;
    }
    let pid = {
        let td = state.td.lock().map_err(|e| e.to_string())?;
        td.launch(&path, &version_key, use_touchplayer, "launch_project")?
    };
    {
        let mut open = state.open.lock().map_err(|e| e.to_string())?;
        open.register_launch(&path, &version_key, use_touchplayer, pid);
    }
    if quit_after {
        app.exit(0);
    } else if hide_after {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
        }
    }
    Ok(())
}

/// Resolve companion presence from the Utility's own TCP bus.
///
/// The bus is the authority here: it ships with the companion TOX, so it is
/// the one signal that means something in every project. Embody/Envoy is an
/// optional third-party package that most projects never have — `list()` may
/// fill in `utility_available` from an Envoy probe as a rescue for a session
/// whose bus is misconfigured, but a live peer always wins, and a project
/// without Embody must still detect its companion. Every path that hands a
/// session list to a client (desktop, Quick Launch, Phone Remote) has to run
/// this, or that client sees a companion-less session.
///
/// Takes an already-locked `WatchManager` — callers hold `open` then `watch`,
/// and `std::sync::Mutex` is not reentrant.
pub(crate) fn apply_utility_presence(watch: &crate::watch::WatchManager, list: &mut [OpenProject]) {
    for p in list.iter_mut() {
        if watch.has_utility_peer(&p.path) {
            p.utility_available = Some(true);
            p.utility_version = watch.peer_utility_version(&p.path);
        } else if let Some((_, _, version)) = p
            .pid
            .and_then(|pid| watch.peer_for_pid(pid))
            .or_else(|| watch.peer_for_family(&p.path))
        {
            // The row's path went stale (Increment-and-Save renamed the file;
            // argv is frozen and the title read needs Automation consent macOS
            // may silently deny) — but the peer's hello'd TD pid still ties it
            // to this session, version and all; for pre-0.8.2 utilities that
            // report no pid, an unambiguous version-family match does the same.
            // Without this the Envoy probe "rescues" presence WITHOUT a version
            // and the Companion bar shows "(pre-versioning)" with an eternal
            // utility-update offer.
            p.utility_available = Some(true);
            p.utility_version = version;
        } else if p.alive {
            // No live peer — but if this process's companion WAS heard from
            // and went quiet, TD itself has most likely stopped responding.
            p.companion_silent_secs = p
                .pid
                .and_then(|pid| watch.silent_peer_age(pid))
                .map(|age| age.as_secs());
        }
    }
}

/// The companion reports the session list folds in as a discovery source:
/// `(TD pid, project path)` per live utility peer. Read under the watch lock
/// and released BEFORE `open` is taken — callers of the presence path hold
/// `open` then `watch`, and that order must never invert. Best-effort: a
/// poisoned watch lock just means no hints this poll, never an error.
pub(crate) fn utility_peer_hints(state: &AppState) -> Vec<(u32, String)> {
    state
        .watch
        .lock()
        .map(|w| w.live_utility_peers())
        .unwrap_or_default()
}

/// The session list every client should get: presence resolved over the bus.
pub(crate) fn sessions_with_utility(state: &AppState) -> Result<Vec<OpenProject>, String> {
    let hints = utility_peer_hints(state);
    let mut list = {
        let mut open = state.open.lock().map_err(|e| e.to_string())?;
        open.list_with_peers(&hints)
    };
    if let Ok(watch) = state.watch.lock() {
        apply_utility_presence(&watch, &mut list);
    }
    Ok(list)
}

#[tauri::command(async)]
pub fn open_projects_list_cmd(state: State<'_, AppState>) -> Result<Vec<OpenProject>, String> {
    let hints = utility_peer_hints(&state);
    let (mut list, migrations) = {
        let mut open = state.open.lock().map_err(|e| e.to_string())?;
        // A session that did Increment and Save is now a different file. The
        // hub has already re-pointed its row; anything else keyed by project
        // path has to follow, or it goes on addressing a file nobody has open.
        (open.list_with_peers(&hints), open.take_path_migrations())
    };
    let mut pane_routes = Vec::new();
    if let Ok(watch) = state.watch.lock() {
        for (old, new) in &migrations {
            watch.retarget_project(old, new);
        }
        apply_utility_presence(&watch, &mut list);
        for (i, p) in list.iter().enumerate() {
            if let Some(route) = pane_label_route(&watch, p) {
                pane_routes.push((i, route));
            }
        }
    }
    // The pane asks go out with the watch lock released (see utility_route).
    for (i, (id, port)) in pane_routes {
        label_panes(&mut list[i], &id, port);
    }
    Ok(list)
}

/// A utility request with the watch lock held only for the route lookup.
///
/// Every hot path that talks to a session's utility goes through here (or the
/// same two steps in `run_utility_action`): the lock guards the peer table,
/// never the round-trip, so a busy TouchDesigner cannot stall the other
/// commands waiting on the lock.
pub(crate) fn utility_call_unlocked(
    state: &AppState,
    path: &str,
    pid: Option<u32>,
    action: &str,
    payload: Option<&serde_json::Value>,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let route = {
        let watch = state.watch.lock().map_err(|e| e.to_string())?;
        watch.utility_route(path, pid)
    };
    match route {
        Some((id, port)) => crate::watch::utility_request(&id, port, action, payload, timeout),
        None => Err("No known Utility peer for this project".into()),
    }
}

/// Where to ask for a session's pane names, when it is worth asking.
///
/// Only worth a round-trip when the project has a Utility AND owns a torn-off
/// pane window; a Utility-less project (or one with just its main window) is
/// skipped so the list poll stays cheap.
fn pane_label_route(
    watch: &crate::watch::WatchManager,
    project: &OpenProject,
) -> Option<(String, u16)> {
    if project.utility_available != Some(true)
        || !crate::session_windows::has_pane_candidates(&project.windows)
    {
        return None;
    }
    // Panes come from the ONE utility the project's Envoy port resolves to, and
    // `envoy.json` records no PID — so with the same `.toe` open twice there is
    // no way to tell whose windows these are. Raw OS titles beat labelling one
    // instance's windows with the other's pane names.
    if project.instances.len() > 1 {
        return None;
    }
    watch.utility_route(&project.path, project.pid)
}

/// Label a session's floating-pane windows with what TD is showing in them.
///
/// This runs on the 4s list poll: a short ask, never the full command wait,
/// and never under the watch lock. A busy TD keeps the raw titles this round.
fn label_panes(project: &mut OpenProject, id: &str, port: u16) {
    if let Ok(panes) = crate::watch::utility_request(
        id,
        port,
        "panes",
        None,
        std::time::Duration::from_millis(1500),
    ) {
        crate::session_windows::label_from_panes(&mut project.windows, &panes);
    }
}

#[tauri::command(async)]
pub fn open_project_kill_cmd(
    app: AppHandle,
    pid: u32,
    state: State<'_, AppState>,
) -> Result<Vec<OpenProject>, String> {
    kill_and_tombstone(&app, &state, pid);
    sessions_with_utility(&state)
}

/// The `.toe` + build to relaunch a live `pid`. From the launcher's own
/// record when it started the session; otherwise the running project is
/// scanned and its required build read from the file (empty when it can't be
/// determined — relaunch re-derives it). Called BEFORE the kill so the still-
/// live process is discoverable.
pub(crate) fn resolve_session_for_kill(
    app: &AppHandle,
    state: &AppState,
    pid: u32,
) -> Option<(String, String, bool)> {
    if let Ok(open) = state.open.lock() {
        if let Some(info) = open.launched_info(pid) {
            return Some(info);
        }
    }
    // The companion's hello names the process and its live project — the
    // permission-free source, and the only one for a Finder-started TD on a
    // Mac without Automation consent (no `.toe` on argv, title unreadable).
    let peer_toe = state.watch.lock().ok().and_then(|w| {
        w.peer_for_pid(pid)
            .map(|(id, _, _)| id)
            .filter(|id| id.to_ascii_lowercase().ends_with(".toe"))
    });
    let toe = peer_toe.or_else(|| crate::open_projects::toe_for_pid(pid))?;
    let resource_dir = app.path().resource_dir().ok();
    let version = state
        .td
        .lock()
        .ok()
        .and_then(|td| td.inspect_toe_file(&toe, resource_dir.as_deref()))
        .unwrap_or_default();
    Some((toe, version, false))
}

/// Kill `pid` and leave a relaunchable tombstone — for launcher-started AND
/// externally-discovered sessions alike (resolve first, then kill, then
/// record). Shared by the desktop command and the Phone Remote kill route.
pub(crate) fn kill_and_tombstone(app: &AppHandle, state: &AppState, pid: u32) {
    let resolved = resolve_session_for_kill(app, state, pid);
    // The OS kill runs without the open lock held — a wedged process can block
    // termination for seconds, and that lock also gates the list poll.
    let _ = crate::open_projects::kill_pid(pid);
    if let Ok(mut open) = state.open.lock() {
        match resolved {
            Some((path, version_key, use_player)) => {
                open.ensure_tombstone(pid, &path, &version_key, use_player)
            }
            None => open.mark_ended_pid(pid),
        }
    }
}

/// The `version_key` to launch with — the caller's when set, else re-derived
/// from the project's `.toe`. Lets a stale row with no recorded build (an
/// externally-opened session) still relaunch.
pub(crate) fn ensure_version_key(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    version_key: &str,
) -> Result<String, String> {
    if !version_key.trim().is_empty() {
        return Ok(version_key.to_string());
    }
    let resource_dir = app.path().resource_dir().ok();
    let td = state.td.lock().map_err(|e| e.to_string())?;
    td.inspect_toe_file(path, resource_dir.as_deref())
        .ok_or_else(|| "Could not determine the TD build this project needs".to_string())
}

/// Drop a stale (ended) session row from the Current tab for good — the
/// tombstone's Dismiss ×. No-op on a live session (it reappears next poll).
#[tauri::command(async)]
pub fn open_project_dismiss_cmd(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<OpenProject>, String> {
    {
        let mut open = state.open.lock().map_err(|e| e.to_string())?;
        open.forget_path(&path);
    }
    sessions_with_utility(&state)
}

/// Synchronous on purpose: a sync command runs on the main thread, so a
/// click on Focus never waits for a free async-runtime worker behind
/// slow polls, and the main thread is the launcher's foreground thread,
/// which Windows lets hand the foreground over. Nothing here blocks:
/// window enumeration is local and the show calls are async.
#[tauri::command]
pub fn open_project_focus_cmd(pid: u32) -> Result<(), String> {
    crate::open_projects::focus_pid(pid)
}

/// Windows of one session (`pid`), or of every live session when omitted.
///
/// `path` is the project's .toe: pass it to get floating panes labelled by what
/// they show. Without it the windows come back with raw OS titles.
#[tauri::command(async)]
pub fn session_windows_list_cmd(
    pid: Option<u32>,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::session_windows::SessionWindow>, String> {
    let pids: Vec<u32> = match pid {
        Some(p) => vec![p],
        None => {
            let hints = utility_peer_hints(&state);
            let mut open = state.open.lock().map_err(|e| e.to_string())?;
            open.list_with_peers(&hints).iter().filter_map(|p| p.pid).collect()
        }
    };
    let mut windows = crate::session_windows::list_for_pids(&pids);
    if let Some(path) = path.filter(|_| crate::session_windows::has_pane_candidates(&windows)) {
        if let Ok(panes) = utility_call_unlocked(
            &state,
            &path,
            pid,
            "panes",
            None,
            std::time::Duration::from_millis(1500),
        ) {
            crate::session_windows::label_from_panes(&mut windows, &panes);
        }
    }
    Ok(windows)
}

/// Act on a single window: `focus`, `minimize`, or `restore`.
/// Sync, on the main thread, for the same reason as `open_project_focus_cmd`.
#[tauri::command]
pub fn session_window_action_cmd(id: i64, action: String) -> Result<(), String> {
    match action.as_str() {
        "focus" => crate::session_windows::focus(id),
        "minimize" => crate::session_windows::minimize(id),
        "restore" => crate::session_windows::restore(id),
        other => Err(format!("Unknown window action '{other}'")),
    }
}

/// Act on every window of a session: `raise` or `minimize`.
/// Sync, on the main thread, for the same reason as `open_project_focus_cmd`.
#[tauri::command]
pub fn session_windows_bulk_cmd(pid: u32, action: String) -> Result<(), String> {
    match action.as_str() {
        "raise" => crate::session_windows::raise_session(pid),
        "minimize" => crate::session_windows::minimize_session(pid),
        other => Err(format!("Unknown session window action '{other}'")),
    }
}

/// Utility action over the TCP bus with Envoy fallback — shared by the Tauri
/// command below and the browser control server's HTTP handlers.
pub(crate) fn run_utility_action(
    state: &AppState,
    path: &str,
    action: &str,
    payload: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    // The session's TD pid unlocks the rename-proof peer match (see
    // apply_utility_presence). Resolved before the watch lock — callers of the
    // presence path hold `open` then `watch`, and the order must not invert.
    // Deliberately NOT a full `list()`: that re-runs the process scan (a
    // PowerShell/CIM spawn on Windows, ~500ms) on a path where the pid is
    // only a routing fallback — the peer match by path and the utility's own
    // id check do the real targeting.
    let pid = {
        let open = state.open.lock().map_err(|e| e.to_string())?;
        open.known_pid_for_path(path)
    };
    // The request goes out with the watch lock RELEASED: saves and loads can
    // keep TD's main thread busy for many seconds, and holding the lock that
    // long stalled every other command needing it (the 4s list poll among
    // them) until the async-runtime workers ran out and even Focus queued.
    let route = {
        let watch = state.watch.lock().map_err(|e| e.to_string())?;
        watch.utility_route(path, pid)
    };
    let tcp_err = match route {
        Some((id, port)) => match crate::watch::utility_request(
            &id,
            port,
            action,
            payload,
            crate::watch::UTILITY_REPLY_TIMEOUT,
        ) {
            Ok(v) => return Ok(v),
            Err(e) => e,
        },
        // No known peer yet: the discovery scan needs the manager itself.
        None => {
            let watch = state.watch.lock().map_err(|e| e.to_string())?;
            match watch.invoke_utility_ex(path, pid, action, payload) {
                Ok(v) => return Ok(v),
                Err(e) => e,
            }
        }
    };
    let port = {
        let hints = utility_peer_hints(state);
        let mut open = state.open.lock().map_err(|e| e.to_string())?;
        let list = open.list_with_peers(&hints);
        let norm = path.replace('\\', "/").to_lowercase();
        list.iter()
            .find(|p| p.path.replace('\\', "/").to_lowercase() == norm)
            .and_then(|p| p.envoy_port)
            .or_else(|| mcp_bridge::inspect_path(path).port)
    };
    if let Some(port) = port {
        if mcp_bridge::port_is_open(port) {
            return mcp_bridge::run_utility_action_ex(port, action, payload)
                .map_err(|e| format!("TCP: {tcp_err} | Envoy: {e}"));
        }
    }
    Err(tcp_err)
}

/// Process CPU/RAM for every given running session, one refresh for all PIDs.
/// Gated on the performance toggle so a stale frontend timer can never keep
/// sampling after the user turns it off. Dead PIDs are absent from the map.
#[tauri::command(async)]
pub fn sessions_perf_cmd(
    pids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<u32, crate::session_perf::ProcPerf>, String> {
    let enabled = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.perf_monitor_enabled
    };
    if !enabled {
        return Err("Performance monitoring is disabled".into());
    }
    let mut perf = state.perf.lock().map_err(|e| e.to_string())?;
    Ok(perf.sample_many(&pids))
}

#[tauri::command(async)]
pub fn open_project_utility_cmd(
    path: String,
    action: String,
    payload: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // The whole companion verb surface is FREE (owner decision, 2026-08-31,
    // docs/fns-plus-capabilities.md D3 executed early): pro capability is
    // delivered as FNSTools Plus packages gated at STOCKING time on the
    // toolkit rail — a capability either exists in the session or it
    // doesn't, and the launcher renders/drives whatever is advertised.
    // The old per-verb allowlist (and the fns-store load_tox carve-out it
    // needed) is gone with the gate; this is also what keeps the free-verb
    // list from growing forever as capabilities move to the registry rail.
    run_utility_action(&state, &path, &action, payload.as_ref())
}

/// Start (if needed) the browser control server and return the URL to open.
#[tauri::command(async)]
pub fn open_control_server_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (port, lan) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (
            cfg.config.control_server_port,
            cfg.config.control_server_lan,
        )
    };
    crate::control_server::ensure_started(&app, port, lan)
}

/// One-tap Phone Remote: force the control server onto the LAN (persisting the
/// setting) and return the URL to encode as a QR for a phone to scan.
#[tauri::command(async)]
pub fn phone_remote_start_cmd(app: AppHandle) -> Result<String, String> {
    crate::control_server::start_for_phone(&app)
}

/// Stop the control server (keeps the token, so a later start reuses the link).
#[tauri::command(async)]
pub fn control_server_stop_cmd(app: AppHandle) -> Result<(), String> {
    crate::control_server::stop(&app)
}

/// Invalidate every shared control link: clear the token, stop the server.
#[tauri::command(async)]
pub fn control_regenerate_token_cmd(app: AppHandle) -> Result<(), String> {
    crate::control_server::regenerate_token(&app)
}

/// Whether the browser control server is serving right now, and on what bind.
/// Read-only (no entitlement gate) — the header Phone button shows a live
/// indicator while the LAN surface is reachable.
#[tauri::command]
pub fn control_server_status_cmd(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let ctl = state.control.lock().map_err(|e| e.to_string())?;
    Ok(match ctl.status() {
        Some((port, lan)) => serde_json::json!({"running": true, "lan": lan, "port": port}),
        None => serde_json::json!({"running": false, "lan": false, "port": 0}),
    })
}

/// Relaunch a project, optionally killing the current process first. Shared by
/// the desktop command and the Phone Remote `/api/sessions/relaunch` route so
/// both take the exact same path (kill → settle → launch → register).
pub(crate) fn relaunch_project(
    state: &AppState,
    path: &str,
    version_key: &str,
    use_touchplayer: bool,
    kill_first: bool,
    pid: Option<u32>,
) -> Result<Vec<OpenProject>, String> {
    if path.is_empty() || path == DEFAULT_TEMPLATE {
        return Err("Pick a .toe project to relaunch".into());
    }
    // Runs without the lock held — see open_project_kill_cmd.
    if kill_first {
        if let Some(p) = pid {
            // The result used to be discarded and the launch went ahead after a
            // flat 400ms. A TouchDesigner that refuses to die (hung, or a
            // permission failure) therefore survived AND got a sibling — every
            // press adding another instance instead of replacing one. Confirm
            // it is actually gone, and refuse to launch if it is not.
            if let Err(e) = crate::open_projects::kill_pid(p) {
                log::warn!("relaunch: kill of pid {p} reported: {e}");
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while crate::open_projects::pid_alive(p) {
                if std::time::Instant::now() >= deadline {
                    log::warn!("relaunch: pid {p} still alive after kill - refusing to launch");
                    return Err(format!(
                        "The running TouchDesigner (PID {p}) did not close, so it was not \
                         relaunched — launching now would leave two copies of the project \
                         open. Close it manually, then try again."
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        // Brief pause so Windows releases file locks after the process exits.
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    let new_pid = {
        let td = state.td.lock().map_err(|e| e.to_string())?;
        td.launch(path, version_key, use_touchplayer, "relaunch_project")?
    };
    {
        let mut open = state.open.lock().map_err(|e| e.to_string())?;
        open.register_launch(path, version_key, use_touchplayer, new_pid);
    }
    sessions_with_utility(state)
}

#[tauri::command(async)]
pub fn open_project_relaunch_cmd(
    app: AppHandle,
    path: String,
    version_key: String,
    use_touchplayer: bool,
    kill_first: bool,
    pid: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<OpenProject>, String> {
    let _ = app;
    relaunch_project(&state, &path, &version_key, use_touchplayer, kill_first, pid)
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.config.clone())
}

#[tauri::command]
pub fn update_prefs(
    app: AppHandle,
    prefs: PrefsUpdate,
    state: State<'_, AppState>,
) -> Result<AppConfig, String> {
    // Which combos is this update touching? Read before `prefs` is consumed.
    let touched = (
        prefs.global_hotkey.is_some(),
        prefs.global_hotkey_main.is_some(),
        prefs.global_hotkey_palette.is_some(),
        prefs.global_hotkey_alt.is_some(),
        prefs.global_hotkey_main_alt.is_some(),
    );

    // Scoped so the config lock is released before re-registering — the
    // rebind path takes the same lock and would otherwise deadlock.
    let (old, config) = {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        let old = (
            cfg.config.global_hotkey.clone(),
            cfg.config.global_hotkey_main.clone(),
            cfg.config.global_hotkey_palette.clone(),
            cfg.config.global_hotkey_alt.clone(),
            cfg.config.global_hotkey_main_alt.clone(),
        );
        cfg.apply_prefs(prefs)?;
        (old, cfg.config.clone())
    };

    // Bind the new combo immediately. Persisting alone left the OLD shortcut
    // registered and the newly typed one inert until an app restart, which
    // made the hotkey field look broken.
    #[cfg(desktop)]
    {
        for (changed, target, old_accel) in [
            (touched.0, crate::HotkeyTarget::Quick, &old.0),
            (touched.1, crate::HotkeyTarget::Main, &old.1),
            (touched.2, crate::HotkeyTarget::Palette, &old.2),
            (touched.3, crate::HotkeyTarget::QuickAlt, &old.3),
            (touched.4, crate::HotkeyTarget::MainAlt, &old.4),
        ] {
            if changed {
                crate::rebind_hotkey(&app, target, old_accel);
            }
        }
    }
    #[cfg(not(desktop))]
    let _ = (app, touched, old);

    Ok(config)
}

#[tauri::command(async)]
pub fn get_recents(merged: bool, state: State<'_, AppState>) -> Result<Vec<RecentEntry>, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    Ok(if merged {
        cfg.get_merged_recents()
    } else {
        cfg.get_launcher_recents_only()
    })
}

#[tauri::command]
pub fn add_recent(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.add_recent_file(&path)
}

#[tauri::command]
pub fn remove_recent(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.remove_recent_file(&path)
}

#[tauri::command]
pub fn clear_recents(state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.clear_recents()
}

#[tauri::command]
pub fn clear_missing(state: State<'_, AppState>) -> Result<u32, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.clear_missing_files()
}

#[tauri::command(async)]
pub fn get_templates(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.get_templates())
}

#[tauri::command]
pub fn add_template(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.add_template(&path)
}

#[tauri::command]
pub fn remove_template(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.remove_template(&path)
}

#[tauri::command]
pub fn move_template(
    path: String,
    direction: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.move_template(&path, &direction)
}

#[tauri::command(async)]
pub fn import_plus_templates_cmd(
    state: State<'_, AppState>,
) -> Result<PlusTemplatesImport, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.import_templates_from_plus()
}

#[tauri::command(async)]
pub fn find_icon(path: String) -> Option<String> {
    crate::project::find_project_icon(&path)
}

#[tauri::command(async)]
pub fn get_icon_data_url(path: String) -> Option<String> {
    let icon = crate::project::find_project_icon(&path)?;
    icon_data_url(&icon)
}

#[tauri::command(async)]
pub fn get_project_meta(path: String) -> ProjectMetaInfo {
    load_project_meta(&path)
}

#[tauri::command(async)]
pub fn get_projects_meta(paths: Vec<String>) -> Vec<ProjectMetaInfo> {
    load_projects_meta(&paths)
}

#[tauri::command(async)]
pub fn get_all_tags(paths: Vec<String>) -> Vec<String> {
    let infos = load_projects_meta(&paths);
    collect_tags(&infos)
}

#[tauri::command(async)]
pub fn save_project_meta_cmd(path: String, meta: ProjectMeta) -> Result<String, String> {
    save_project_meta(&path, &meta)
}

/// One pickable GPU for the affinity control, described by a monitor attached
/// to it.
///
/// `index` is what goes on TD's command line, so it follows the Monitors DAT
/// order (left to right, then bottom to top) rather than the order the OS
/// reports - those disagree, and the wiki is explicit that the flag means the
/// DAT's index. The geometry rides along so the UI can label an entry with
/// something the user recognises, and so a mismatch is visible rather than
/// silent.
#[derive(Debug, Clone, Serialize)]
pub struct GpuMonitorOption {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    pub name: Option<String>,
}

/// Monitors in TD's affinity-index order. Empty off Windows, where TD has no
/// GPU-affinity flags - which is also how the UI knows to hide the control.
#[tauri::command]
pub fn list_gpu_monitors(app: AppHandle) -> Vec<GpuMonitorOption> {
    // Deliberately NOT entitlement-gated: this is plain OS monitor
    // enumeration, and the UI needs it on the free tier too — that is how it
    // knows to hide the (pro) affinity row entirely on a one-display machine
    // instead of dangling an upsell for something the rig cannot use. The
    // write, `set_project_gpu_affinity`, is the gated half.
    if !cfg!(windows) {
        return Vec::new();
    }
    let Ok(monitors) = app.available_monitors() else {
        return Vec::new();
    };
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.position().x, m.position().y));

    let mut rows: Vec<GpuMonitorOption> = monitors
        .iter()
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            GpuMonitorOption {
                index: 0,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                primary: primary == Some((pos.x, pos.y)),
                name: m.name().cloned(),
            }
        })
        .collect();

    // Left to right; for displays stacked in the same column, bottom first.
    // Screen Y grows downward, so "bottom to top" is descending Y.
    rows.sort_by(|a, b| a.x.cmp(&b.x).then(b.y.cmp(&a.y)));
    for (i, row) in rows.iter_mut().enumerate() {
        row.index = i as u32;
    }
    rows
}

/// Bind a project to one GPU (or clear it) by writing its sidecar `gpu` block.
///
/// Takes effect on the project's next launch from the launcher - the flags can
/// only be passed at process start.
#[tauri::command(async)]
pub fn set_project_gpu_affinity(
    path: String,
    monitor: Option<u32>,
    bus_id: Option<String>,
) -> Result<String, String> {
    let affinity = crate::project_meta::GpuAffinity {
        monitor,
        bus_id: bus_id.filter(|b| !b.trim().is_empty()),
    };
    crate::project_meta::set_gpu_affinity(&path, Some(affinity))
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.unminimize().map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn get_readme(path: String) -> ReadmeInfo {
    get_readme_info(&path)
}

#[tauri::command(async)]
pub fn save_readme_cmd(project_path: String, content: String) -> Result<String, String> {
    save_readme(&project_path, &content)
}

#[tauri::command(async)]
pub fn open_path(path: String) -> Result<(), String> {
    open_in_file_manager(&path)
}

#[tauri::command(async)]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    let _ = app;
    Ok(())
}

#[tauri::command]
pub async fn pick_toe_files(
    app: AppHandle,
    multiple: bool,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dialog = app.dialog().file().add_filter("TouchDesigner", &["toe"]);
    let picked = if multiple {
        dialog.blocking_pick_files()
    } else {
        dialog.blocking_pick_file().map(|p| vec![p])
    };

    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

/// Pick a replacement media file for the media browser.
///
/// The filter follows the category of the reference being replaced, and lists
/// what TOUCHDESIGNER reads rather than what the app can preview — the point is
/// to repoint a TD parameter, so offering only the WebView-previewable subset
/// would refuse perfectly good exr / tif / mxf / geometry files.
#[tauri::command]
pub async fn pick_media_file(app: AppHandle, category: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (label, exts): (&str, &[&str]) = match category.as_str() {
        "video" => (
            "Movie",
            &[
                "mp4", "mov", "avi", "mkv", "m4v", "mpg", "mpeg", "mxf", "r3d", "ts", "m2ts",
                "mts", "flv", "3gp",
            ],
        ),
        "image" => (
            "Image",
            &[
                "png", "jpg", "jpeg", "tif", "tiff", "exr", "dds", "hdr", "dpx", "bmp", "gif",
                "webp", "ktx", "pfm", "fit", "fits", "pic",
            ],
        ),
        "audio" => ("Audio", &["wav", "mp3", "aif", "aiff", "flac", "m4a", "ogg"]),
        "geometry" => (
            "Geometry",
            &[
                "obj", "fbx", "abc", "usd", "usda", "usdc", "dae", "3ds", "dxf", "ply", "pts",
                "xyz", "e57", "spz", "tog",
            ],
        ),
        _ => ("Media", &[]),
    };

    let mut dialog = app.dialog().file();
    if !exts.is_empty() {
        dialog = dialog.add_filter(label, exts);
    }
    Ok(dialog
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().replace('\\', "/")))
}

/// Find files by basename under a folder — the batch-relink helper. The user
/// points at where the missing media actually lives; this walks it once and
/// maps each requested name (case-insensitive) to the first match, so the
/// caller can hand every hit to the companion's media_replace. Bounded like
/// the companion's own walk: hidden dirs are skipped, and a runaway folder
/// stops the search rather than the app.
#[tauri::command(async)]
pub fn locate_media_files_cmd(
    root: String,
    names: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    const MAX_VISITED: usize = 50_000;
    let mut wanted: std::collections::HashMap<String, String> = names
        .into_iter()
        .map(|n| (n.to_lowercase(), n))
        .collect();
    let mut found: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut stack = vec![std::path::PathBuf::from(&root)];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        if wanted.is_empty() || visited > MAX_VISITED {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_VISITED {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !name.starts_with('.') {
                    stack.push(path);
                }
            } else if let Some(orig) = wanted.remove(&name.to_lowercase()) {
                found.insert(orig, path.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(found)
}

#[tauri::command]
pub async fn pick_tox_files(
    app: AppHandle,
    multiple: bool,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dialog = app
        .dialog()
        .file()
        .add_filter("TouchDesigner Component", &["tox"]);
    let picked = if multiple {
        dialog.blocking_pick_files()
    } else {
        dialog.blocking_pick_file().map(|p| vec![p])
    };

    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

/// Resolve a .tox URL or GitHub owner/repo into a local tox_cache path.
#[tauri::command(async)]
pub fn cache_tox_from_url_cmd(
    source: String,
    state: State<'_, AppState>,
) -> Result<crate::tox_cache::ToxCacheResult, String> {
    let token = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        let t = cfg.config.github_token.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    };
    crate::tox_cache::cache_tox_from_source(&source, token.as_deref())
}

/// Record one successful quick-launch run of a registry command (`tool#id`;
/// a preset passes its target, any `@instance` pin is dropped). Shared with
/// FNSTools' palette through `command-usage.json` -- see `command_usage.rs`.
/// Recorded whatever `quick_rank_by_usage` says, so switching ranking on
/// later finds history. A failure is logged, never surfaced: usage is a
/// tie-breaker and must not make a command that ran look like it failed.
#[tauri::command(async)]
pub fn command_usage_record(identity: String) {
    if let Err(e) = crate::command_usage::record(&identity) {
        log::warn!("command usage: could not record {identity}: {e}");
    }
}

/// `tool#id` -> ranking bonus (0..8), summed across every palette that
/// writes the shared file. Empty when there is nothing usable.
#[tauri::command(async)]
pub fn command_usage_bonuses() -> std::collections::HashMap<String, f64> {
    crate::command_usage::bonuses()
}

/// Clear the launcher's own usage history (FNSTools' still counts).
#[tauri::command(async)]
pub fn command_usage_clear() -> Result<(), String> {
    crate::command_usage::clear_own()
}

/// Detect TDPyEnvManager vEnv + uv for a project .toe.
#[tauri::command(async)]
pub fn tdp_env_status_cmd(path: String) -> Result<crate::tdp::TdpEnvStatus, String> {
    // Logged because this decides whether "From package…" can open at all, and
    // a refusal is a one-line status in the UI that is easy to miss — the log
    // is what a "it does nothing" report can be checked against.
    let out = crate::tdp::env_status(&path);
    match &out {
        Ok(s) => log::info!(
            "tdp env: {} -> dir={} venv={:?} uv={:?} ready={}",
            path,
            s.project_dir,
            s.venv_path,
            s.uv_path,
            s.ready
        ),
        Err(e) => log::warn!("tdp env: {path} -> failed: {e}"),
    }
    out
}

/// uv pip install a TDP/git spec into the project vEnv and resolve ToxFile.
#[tauri::command(async)]
pub fn tdp_install_package_cmd(
    path: String,
    spec: String,
    state: State<'_, AppState>,
) -> Result<crate::tdp::TdpInstallResult, String> {
    let base = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.package_index_url.clone()
    };
    crate::tdp::install_and_resolve(&path, &spec, &base)
}

/// List packages (name-prefix filtered) from the configured index (cached).
#[tauri::command(async)]
pub fn tdp_pypi_catalog_cmd(
    force_refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<crate::tdp_catalog::TdpRemoteCatalog, String> {
    let (base, prefix) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (
            cfg.config.package_index_url.clone(),
            cfg.config.package_index_prefix.clone(),
        )
    };
    crate::tdp_catalog::fetch_pypi_catalog(base, prefix, force_refresh.unwrap_or(false))
}

/// Fetch a package's long description (README) from the configured index.
#[tauri::command(async)]
pub fn tdp_pypi_readme_cmd(
    name: String,
    state: State<'_, AppState>,
) -> Result<crate::tdp_catalog::TdpReadme, String> {
    let base = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.package_index_url.clone()
    };
    crate::tdp_catalog::fetch_pypi_readme(base, name)
}

// --- Patreon import (optional; gated by the `patreon` Cargo feature) --------
//
// Blocking HTTP → off_runtime (see proc.rs). The cookie is read from config on
// the main thread and passed in; the worker never touches TD/app state.

/// Creators found through the account (pledges / memberships / follows) plus
/// the ones added by hand. Hand-added creators are the fallback for everything
/// Patreon won't tell us — so when the account lookup finds nothing, they are
/// shown instead of the error rather than alongside it.
#[tauri::command(async)]
pub fn patreon_list_campaigns_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<crate::patreon::PatreonCampaign>, String> {
    let (cookie, saved) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (
            cfg.config.patreon_session_cookie.clone(),
            cfg.config.patreon_creators.clone(),
        )
    };
    let manual: Vec<crate::patreon::PatreonCampaign> = saved
        .into_iter()
        .map(|c| crate::patreon::PatreonCampaign {
            id: c.id,
            name: c.name,
            url: c.url,
            avatar_url: c.avatar_url,
            is_own: false,
            manual: true,
            featured: false,
        })
        .collect();
    let found = {
        let cookie = cookie.clone();
        crate::proc::off_runtime(move || crate::patreon::list_campaigns(&cookie))
    };
    match found {
        Ok(mut list) => {
            for m in manual {
                if !list.iter().any(|c| c.id == m.id) {
                    list.push(m);
                }
            }
            add_featured_creator(&state, &cookie, &mut list);
            Ok(list)
        }
        Err(e) if manual.is_empty() => Err(e),
        Err(_) => Ok(manual),
    }
}

/// Function Store's own Patreon page — the creator every user is offered.
const FEATURED_CREATOR_URL: &str = "https://www.patreon.com/function_store";

/// Put Function Store first in a signed-in user's creator list when it isn't
/// there already (not supported, followed, owned or hand-added) and the user
/// hasn't dismissed it. Resolved once through the user's own session and
/// cached in config; any failure just leaves the list as it was.
pub(crate) fn add_featured_creator(
    state: &AppState,
    cookie: &str,
    list: &mut Vec<crate::patreon::PatreonCampaign>,
) {
    let (dismissed, cached) = match state.config.lock() {
        Ok(cfg) => (
            cfg.config.patreon_featured_dismissed,
            cfg.config.patreon_featured.clone(),
        ),
        Err(_) => return,
    };
    if dismissed {
        return;
    }
    let entry = match cached {
        Some(entry) => entry,
        None => {
            let cookie = cookie.to_string();
            let Ok(c) = crate::proc::off_runtime(move || {
                crate::patreon::resolve_creator(&cookie, FEATURED_CREATOR_URL)
            }) else {
                return;
            };
            let entry = crate::config::PatreonCreatorEntry {
                id: c.id,
                name: c.name,
                url: c.url,
                avatar_url: c.avatar_url,
            };
            if let Ok(mut cfg) = state.config.lock() {
                cfg.config.patreon_featured = Some(entry.clone());
                let _ = cfg.save();
            }
            entry
        }
    };
    if list.iter().any(|c| c.id == entry.id) {
        return;
    }
    list.insert(
        0,
        crate::patreon::PatreonCampaign {
            id: entry.id,
            name: entry.name,
            url: entry.url,
            avatar_url: entry.avatar_url,
            is_own: false,
            manual: false,
            featured: true,
        },
    );
}

/// Resolve a pasted creator URL and remember it. Re-adding an existing creator
/// refreshes its name/avatar rather than duplicating it.
#[tauri::command(async)]
pub fn patreon_add_creator_cmd(
    url: String,
    state: State<'_, AppState>,
) -> Result<crate::patreon::PatreonCampaign, String> {
    let cookie = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_session_cookie.clone()
    };
    let campaign =
        crate::proc::off_runtime(move || crate::patreon::resolve_creator(&cookie, &url))?;
    {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        let entry = crate::config::PatreonCreatorEntry {
            id: campaign.id.clone(),
            name: campaign.name.clone(),
            url: campaign.url.clone(),
            avatar_url: campaign.avatar_url.clone(),
        };
        match cfg
            .config
            .patreon_creators
            .iter_mut()
            .find(|c| c.id == entry.id)
        {
            Some(existing) => *existing = entry,
            None => cfg.config.patreon_creators.push(entry),
        }
        let _ = cfg.save();
    }
    Ok(campaign)
}

/// Forget a hand-added creator. Only affects the saved list — a creator the
/// account itself reports keeps showing up.
#[tauri::command(async)]
pub fn patreon_remove_creator_cmd(
    campaign_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.config.patreon_creators.retain(|c| c.id != campaign_id);
    // The × on the featured Function Store entry: hide it for good.
    if cfg.config.patreon_featured.as_ref().is_some_and(|f| f.id == campaign_id) {
        cfg.config.patreon_featured_dismissed = true;
    }
    let _ = cfg.save();
    Ok(())
}

#[tauri::command(async)]
pub fn patreon_list_tox_posts_cmd(
    campaign_id: String,
    campaign_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::patreon::PatreonToxPost>, String> {
    let cookie = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_session_cookie.clone()
    };
    let id = campaign_id.clone();
    let posts =
        crate::proc::off_runtime(move || crate::patreon::list_tox_posts(&cookie, &campaign_id))?;
    // Every listing the user pays for is also one the name search can use
    // later, so snapshot it on the way past. Best-effort; never fatal.
    crate::patreon_index::record(&id, campaign_name.as_deref().unwrap_or(&id), &posts);
    Ok(posts)
}

/// Name-search the Patreon cache: every creator whose posts have been listed
/// at least once, plus every `.tox`/`.toe` already on disk. Local only - no
/// cookie, no network - so it is safe to call while the user is still typing.
#[tauri::command(async)]
pub fn patreon_search_cmd(
    query: String,
    state: State<'_, AppState>,
) -> Result<crate::patreon_index::SearchResult, String> {
    let root = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_download_root.clone()
    };
    Ok(crate::patreon_index::search_result(&query, &root))
}

/// A campaign's most recent `.tox`/`.toe` post date, for sorting the
/// creators list by "Latest upload". `None` if none turned up recently.
#[tauri::command(async)]
pub fn patreon_campaign_last_upload_cmd(
    campaign_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let cookie = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_session_cookie.clone()
    };
    crate::proc::off_runtime(move || crate::patreon::latest_upload_at(&cookie, &campaign_id))
}

/// A campaign's single most recent post date, of any kind — the cheap
/// default for sorting the creators list (one request, no attachment scan).
#[tauri::command(async)]
pub fn patreon_campaign_latest_post_cmd(
    campaign_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let cookie = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_session_cookie.clone()
    };
    crate::proc::off_runtime(move || crate::patreon::latest_post_at(&cookie, &campaign_id))
}

const PATREON_LOGIN_WINDOW: &str = "patreon-login";

/// Open (or focus) an embedded Patreon login window. The user logs in there and
/// we capture the session cookie from our OWN webview — no OS-browser access.
///
/// Async (like `patreon_try_capture`) because building a webview window from a
/// SYNCHRONOUS command deadlocks on Windows: WebView2 creation pumps the main
/// thread's message loop, which the sync command is already blocking. The
/// symptom is exactly what it sounds like — a white, unclosable login window
/// and a frozen app that has to be killed. See the `WebviewWindowBuilder`
/// "Known issues" note and https://github.com/tauri-apps/wry/issues/583.
#[tauri::command(async)]
pub fn patreon_open_login(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(PATREON_LOGIN_WINDOW) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let url = tauri::Url::parse("https://www.patreon.com/login").map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, PATREON_LOGIN_WINDOW, tauri::WebviewUrl::External(url))
        .title("Log in to Patreon")
        .inner_size(520.0, 780.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Poll the login window's cookie jar. Returns:
///   "connected|<label>" — signed-in session captured + saved (window closed)
///   "waiting"           — window open, no finished login yet
///   "closed"            — the login window is gone (user cancelled)
///
/// Patreon hands out a `session_id` to anonymous and half-finished logins too,
/// and the jar can hold more than one (host-only vs `.patreon.com`), so a value
/// is only accepted once it resolves to a NAMED account — and of several
/// candidates we keep the one that can actually see supported creators. A
/// cookie that merely authenticates gets us a user resource with no pledges,
/// which is what "No supported creators found" was really reporting.
/// Async so reading cookies doesn't deadlock on Windows (per Tauri docs).
#[tauri::command(async)]
pub fn patreon_try_capture(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let Some(win) = app.get_webview_window(PATREON_LOGIN_WINDOW) else {
        return Ok("closed".into());
    };
    let url = tauri::Url::parse("https://www.patreon.com").map_err(|e| e.to_string())?;
    let mut candidates: Vec<String> = Vec::new();
    for host in ["https://www.patreon.com", "https://patreon.com"] {
        let Ok(host_url) = tauri::Url::parse(host) else { continue };
        let cookies = if host_url == url {
            win.cookies_for_url(host_url).map_err(|e| e.to_string())?
        } else {
            win.cookies_for_url(host_url).unwrap_or_default()
        };
        for c in cookies {
            if c.name() != "session_id" {
                continue;
            }
            // Some cookie stores hand back the value still quoted.
            let v = c.value().trim().trim_matches('"').to_string();
            if !v.is_empty() && !candidates.contains(&v) {
                candidates.push(v);
            }
        }
    }
    if candidates.is_empty() {
        return Ok("waiting".into());
    }
    let mut best: Option<(String, crate::patreon::PatreonIdentity)> = None;
    for sid in candidates {
        let Some(ident) = crate::proc::off_runtime(|| crate::patreon::session_identity(&sid))
        else {
            continue;
        };
        let supported = ident.supported;
        if best.as_ref().map_or(true, |(_, b)| supported > b.supported) {
            best = Some((sid, ident));
        }
        if supported > 0 {
            break;
        }
    }
    // Recognized but unnamed = login not finished; keep the window open.
    let Some((sid, ident)) = best else {
        return Ok("waiting".into());
    };
    {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_session_cookie = sid;
        let _ = cfg.save();
    }
    let _ = win.close();
    let label = if ident.supported == 0 {
        format!("{} — this account supports no creators", ident.name)
    } else {
        ident.name
    };
    Ok(format!("connected|{label}"))
}

/// Log out of the Patreon *content* session: forget the stored `session_id` and
/// clear patreon.com cookies out of our own webview jar.
///
/// Clearing the config value alone is not a logout. The login webview keeps its
/// cookies, so the next "Log in with Patreon" lands straight back in the same
/// account with no prompt — there is no way to switch accounts, and the browsing
/// session stays alive in the app. Deleting the jar's cookies makes the next
/// login a real sign-in.
///
/// Not the same thing as [`license_sign_out_cmd`]: that drops the OAuth token
/// this build is *entitled* by. This drops the browsing session used to list
/// creators' posts. Saved creators are deliberately left alone — they are
/// user-added bookmarks, not credentials.
///
/// Async for the same reason as [`patreon_try_capture`] — touching webview
/// cookies from a synchronous command deadlocks the main thread on Windows.
#[tauri::command(async)]
pub fn patreon_logout(app: AppHandle, state: State<'_, AppState>) -> Result<AppConfig, String> {
    // Close the login window first: a live page can re-set what we just deleted.
    if let Some(win) = app.get_webview_window(PATREON_LOGIN_WINDOW) {
        let _ = win.close();
    }
    // Every window shares the runtime's cookie store, so the main window can
    // clear cookies the (now closed) login window set.
    if let Some(win) = app.get_webview_window("main") {
        for host in ["https://www.patreon.com", "https://patreon.com"] {
            let Ok(url) = tauri::Url::parse(host) else {
                continue;
            };
            for cookie in win.cookies_for_url(url).unwrap_or_default() {
                let _ = win.delete_cookie(cookie);
            }
        }
    }
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.config.patreon_session_cookie = String::new();
    cfg.save()?;
    Ok(cfg.config.clone())
}

#[tauri::command(async)]
pub fn patreon_post_detail_cmd(
    post_id: String,
    state: State<'_, AppState>,
) -> Result<crate::patreon::PatreonPostDetail, String> {
    let cookie = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_session_cookie.clone()
    };
    crate::proc::off_runtime(move || crate::patreon::get_post_detail(&cookie, &post_id))
}

/// Download a post's `.tox` into the Patreon download folder (Settings →
/// Patreon, or Documents/TDXLU/Patreon Downloads by default — always
/// grouped by creator name) and return its path. The frontend then loads it
/// via the existing `load_tox` companion action — same path as "From URL…",
/// so it drops into the
/// selected session.
#[tauri::command(async)]
pub fn patreon_download_tox_cmd(
    url: String,
    filename: String,
    campaign_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (cookie, download_root) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (cfg.config.patreon_session_cookie.clone(), cfg.config.patreon_download_root.clone())
    };
    crate::proc::off_runtime(move || {
        crate::patreon::download_tox(&cookie, &url, &filename, &download_root, &campaign_name)
    })
}

/// Download (if needed) + extract a Patreon `.zip` attachment, returning
/// every `.tox`/`.toe` inside as local, already-loadable files. Idempotent —
/// a prior extraction is reused without re-downloading or re-extracting.
#[tauri::command(async)]
pub fn patreon_extract_zip_cmd(
    url: String,
    filename: String,
    campaign_name: String,
    state: State<'_, AppState>,
) -> Result<crate::patreon::PatreonZipExtract, String> {
    let (cookie, download_root) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (cfg.config.patreon_session_cookie.clone(), cfg.config.patreon_download_root.clone())
    };
    crate::proc::off_runtime(move || {
        crate::patreon::extract_zip(&cookie, &url, &filename, &download_root, &campaign_name)
    })
}

/// Read-only check for a prior extraction (no network) — lets the frontend
/// restore "already unzipped" state when a post is reopened.
#[tauri::command(async)]
pub fn patreon_zip_extract_status_cmd(
    url: String,
    filename: String,
    campaign_name: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::patreon::PatreonZipExtract>, String> {
    let download_root = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_download_root.clone()
    };
    crate::proc::off_runtime(move || {
        crate::patreon::zip_extract_status(&url, &filename, &download_root, &campaign_name)
    })
}

/// Read-only: where a Patreon `.tox`/`.toe` already lives on disk, or `None`
/// if it hasn't been downloaded yet. No network. The Patreon panel asks this
/// per file so it can mark drag-ready rows: an OS-level drag starts with the
/// mouse button already down and can't wait on a download, so knowing the
/// local path up front is what makes drag-and-drop instant.
#[tauri::command(async)]
pub fn patreon_tox_local_path_cmd(
    url: String,
    filename: String,
    campaign_name: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let download_root = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_download_root.clone()
    };
    Ok(crate::proc::off_runtime(move || {
        crate::patreon::tox_local_path(&url, &filename, &download_root, &campaign_name)
    }))
}

#[derive(serde::Serialize)]
pub struct SettingsImportResult {
    pub config: AppConfig,
    pub prefs_applied: usize,
    pub tools_added: usize,
    pub categories_added: usize,
    pub commands_added: usize,
}

/// Save-dialog + write a portable settings JSON (secrets never included).
/// None = user cancelled the dialog.
#[tauri::command]
pub async fn export_settings_cmd(
    app: AppHandle,
    include_paths: bool,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let value = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.export_settings(include_paths)?
    };
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Export TDXLU settings")
        .set_file_name("tdxlu-settings.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Write {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Open-dialog + merge a settings export into the live config.
/// None = user cancelled the dialog.
#[tauri::command]
pub async fn import_settings_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SettingsImportResult>, String> {
    use tauri_plugin_dialog::DialogExt;

    let Some(path) = app
        .dialog()
        .file()
        .set_title("Import TDXLU settings")
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("Read {}: {e}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Not valid JSON: {e}"))?;
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    let counts = cfg.import_settings(&value)?;
    Ok(Some(SettingsImportResult {
        config: cfg.config.clone(),
        prefs_applied: counts.prefs_applied,
        tools_added: counts.tools_added,
        categories_added: counts.categories_added,
        commands_added: counts.commands_added,
    }))
}

/// Upsert tool-command sightings into the historical catalog the Settings
/// curation list renders. Called by the quick palette after every fetch; the
/// config write is skipped unless something material changed. Returns how
/// many identities were new to this machine.
#[tauri::command]
pub fn merge_quick_seen_commands_cmd(
    cmds: Vec<crate::config::QuickSeenCommand>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.merge_quick_seen_commands(cmds)
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut dialog = app.dialog().file();
    if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
        dialog = dialog.set_title(t);
    }
    Ok(dialog
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command(async)]
pub fn get_drag_icon_path(app: AppHandle) -> Result<String, String> {
    // Dev: icons next to the crate. Release: bundled resource (icons/32x32.png).
    #[cfg(debug_assertions)]
    {
        let _ = &app;
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons").join("32x32.png");
        if p.is_file() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    // Bundled resources keep their src-tauri-relative path: the icon lands at
    // <resources>/icons/32x32.png, not at the resource root. The path must
    // also EXIST — on macOS the drag plugin aborts the whole drag with
    // "drag image not found" when the icon path is missing, which is why
    // every release build had drag-out dead while dev (branch above) worked.
    if let Ok(p) = app
        .path()
        .resolve("icons/32x32.png", tauri::path::BaseDirectory::Resource)
    {
        if p.is_file() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    // Last resort: materialize the compiled-in icon so the returned path is
    // guaranteed to exist, whatever the bundle layout does in the future.
    let fallback = ConfigManager::config_dir().join("drag-icon-32.png");
    if !fallback.is_file() {
        if let Some(dir) = fallback.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&fallback, include_bytes!("../icons/32x32.png"))
            .map_err(|e| e.to_string())?;
    }
    Ok(fallback.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn default_palette_dir_cmd() -> String {
    palette::default_user_palette_dir()
        .to_string_lossy()
        .to_string()
}

#[tauri::command(async)]
pub fn import_tox_to_palette_cmd(
    paths: Vec<String>,
    dest_folder: Option<String>,
) -> Result<palette::PaletteImportResult, String> {
    palette::import_tox_to_user_palette(&paths, dest_folder.as_deref())
}

/// Moves a `.tox` from the User Palette to the OS trash (recoverable) and
/// refreshes paletteData.json. Only files inside the user palette root can
/// be removed this way — re-verified server-side regardless of what the
/// frontend sent.
#[tauri::command(async)]
pub fn remove_palette_file_cmd(path: String) -> Result<(), String> {
    palette::remove_user_palette_file(&path)
}

#[tauri::command(async)]
pub fn rebuild_palette_data_cmd() -> Result<String, String> {
    let root = palette::default_user_palette_dir();
    palette::rebuild_user_palette_data(&root)?;
    Ok(root.join("paletteData.json").to_string_lossy().to_string())
}

/// Why-is-the-palette-empty diagnostics: every configured root with
/// exists/readable/tox-count, including roots the scan silently skips.
#[tauri::command(async)]
pub fn palette_scan_info_cmd(
    state: State<'_, AppState>,
    factory_install: Option<String>,
) -> Result<Vec<palette::PaletteScanRoot>, String> {
    let extra = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.palette_extra_folders.clone()
    };
    let factory = factory_install
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Ok(palette::palette_scan_info(&extra, factory))
}

#[tauri::command(async)]
pub fn get_palette_items_cmd(
    state: State<'_, AppState>,
    factory_install: Option<String>,
) -> Result<Vec<PaletteItem>, String> {
    let extra = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.palette_extra_folders.clone()
    };
    let factory = factory_install
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Ok(palette::scan_palette_roots(&extra, factory))
}

/// Copy the bundled utility TOX into the user palette root, OVERWRITING any
/// same-named copy (unlike drag-import, which uniquifies). Used by the utility
/// update flow so a session's External .tox can point at a stable path that is
/// always the launcher's current version. Returns the palette path.
#[tauri::command(async)]
pub fn install_bundled_utility_cmd(app: AppHandle) -> Result<String, String> {
    let bundled = get_bundled_utility_tox(app)
        .ok_or_else(|| "Bundled utility TOX not present in this build".to_string())?;
    let user_root = palette::default_user_palette_dir();
    std::fs::create_dir_all(&user_root)
        .map_err(|e| format!("Could not create user palette folder: {e}"))?;
    let file_name = Path::new(&bundled)
        .file_name()
        .ok_or_else(|| "Bundled utility path has no file name".to_string())?;
    let dest = user_root.join(file_name);
    std::fs::copy(&bundled, &dest).map_err(|e| format!("Copy failed: {e}"))?;
    let _ = palette::rebuild_user_palette_data(&user_root);
    Ok(dest.to_string_lossy().replace('\\', "/"))
}

// ----- Toolbox (pinned palette tools) -----

/// A toolbox tool plus what the UI needs to act on it: where its local `.tox`
/// lives right now (drag source), or why it has none yet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxToolView {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub source: String,
    pub category: String,
    pub notes: String,
    /// Draggable local `.tox` for this tool, when one exists on disk.
    pub resolved_path: Option<String>,
    /// Local tool whose file has vanished (url tools are "unfetched", not missing).
    pub missing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxView {
    pub categories: Vec<String>,
    pub tools: Vec<ToolboxToolView>,
}

pub(crate) fn build_toolbox_view(cfg: &AppConfig) -> ToolboxView {
    let tools = cfg
        .toolbox_tools
        .iter()
        .map(|t| {
            let (resolved_path, missing) = match t.kind.as_str() {
                "local" => {
                    let exists = Path::new(&t.source).is_file();
                    (exists.then(|| t.source.clone()), !exists)
                }
                "url" => {
                    let cached = t
                        .cached_path
                        .as_deref()
                        .filter(|p| Path::new(p).is_file())
                        .map(|p| p.to_string());
                    (cached, false)
                }
                _ => (None, false),
            };
            ToolboxToolView {
                id: t.id.clone(),
                label: t.label.clone(),
                kind: t.kind.clone(),
                source: t.source.clone(),
                category: t.category.clone(),
                notes: t.notes.clone(),
                resolved_path,
                missing,
            }
        })
        .collect();
    ToolboxView {
        categories: cfg.toolbox_categories.clone(),
        tools,
    }
}

#[tauri::command(async)]
pub fn toolbox_get_cmd(state: State<'_, AppState>) -> Result<ToolboxView, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    Ok(build_toolbox_view(&cfg.config))
}

/// One-time seed: pin the bundled companion utility TOX so a fresh install has
/// a tool to drag. The seeded flag is set only on success, so removing it later
/// sticks; a dev build without the resource just retries next start.
#[tauri::command(async)]
pub fn toolbox_seed_bundled_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ToolboxView, String> {
    let bundled = get_bundled_utility_tox(app);
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    if cfg.config.toolbox_utility_seeded {
        // Heal a stale pin: the seed stores an absolute path, and the bundled
        // resource has moved before (utility/ → release/ in 0.7.x), so a pin
        // from an older build can dangle after an app update. Re-point a
        // utility-named local pin when its file is gone, and also when it
        // still exists but lives in a superseded resource copy: any
        // Tauri-materialized resource path (recognizable by its `_up_/`
        // segment, in bundles and target/debug alike) that isn't the current
        // bundled tox. Old copies linger on disk after a move, so an
        // exists-only check would keep serving an outdated companion.
        // Hand-picked user paths live outside resource dirs and are left
        // alone (unless the file is gone entirely).
        if let Some(ref path) = bundled {
            let mut healed = false;
            for t in cfg.config.toolbox_tools.iter_mut() {
                if t.kind != "local" || t.source == *path {
                    continue;
                }
                let norm = t.source.replace('\\', "/");
                let is_utility = norm
                    .rsplit('/')
                    .next()
                    .is_some_and(|n| n.eq_ignore_ascii_case(crate::updates::UTILITY_TOX_NAME));
                let superseded_resource = norm.contains("/_up_/");
                if is_utility
                    && (superseded_resource || !std::path::Path::new(&t.source).is_file())
                {
                    t.source = path.clone();
                    healed = true;
                }
            }
            if healed {
                cfg.save()?;
            }
        }
        return Ok(build_toolbox_view(&cfg.config));
    }
    let Some(path) = bundled else {
        return Ok(build_toolbox_view(&cfg.config));
    };
    let norm = path.replace('\\', "/").to_lowercase();
    let already = cfg.config.toolbox_tools.iter().any(|t| {
        t.kind == "local" && t.source.replace('\\', "/").to_lowercase() == norm
    });
    if !already {
        cfg.toolbox_add_tool(
            "Launcher Utility",
            "local",
            &path,
            "",
            "Companion utility — drop into a project to enable Save / Snapshot / Record / Load tox from the launcher",
        )?;
    }
    cfg.config.toolbox_utility_seeded = true;
    cfg.save()?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_add_tool_cmd(
    state: State<'_, AppState>,
    label: String,
    kind: String,
    source: String,
    category: String,
    notes: Option<String>,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_add_tool(&label, &kind, &source, &category, notes.as_deref().unwrap_or(""))?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_update_tool_cmd(
    state: State<'_, AppState>,
    id: String,
    label: Option<String>,
    category: Option<String>,
    source: Option<String>,
    notes: Option<String>,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_update_tool(
        &id,
        label.as_deref(),
        category.as_deref(),
        source.as_deref(),
        notes.as_deref(),
    )?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_remove_tool_cmd(
    state: State<'_, AppState>,
    id: String,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_remove_tool(&id)?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_move_tool_cmd(
    state: State<'_, AppState>,
    id: String,
    direction: String,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_move_tool(&id, &direction)?;
    Ok(build_toolbox_view(&cfg.config))
}

/// Download a `url` tool's `.tox` into the cache (no-op when already cached).
#[tauri::command(async)]
pub fn toolbox_fetch_tool_cmd(
    state: State<'_, AppState>,
    id: String,
) -> Result<ToolboxView, String> {
    // Resolve what to fetch, then release the lock for the (blocking) download.
    let (source, token) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        let tool = cfg
            .config
            .toolbox_tools
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| "Toolbox tool not found".to_string())?;
        match tool.kind.as_str() {
            "url" => {}
            "local" => {
                // Nothing to fetch — just report current state.
                return Ok(build_toolbox_view(&cfg.config));
            }
            _ => return Err("Package tools are installed into a project, not fetched".into()),
        }
        let t = cfg.config.github_token.trim().to_string();
        (tool.source.clone(), (!t.is_empty()).then_some(t))
    };
    let result = crate::tox_cache::cache_tox_from_source(&source, token.as_deref())?;
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_set_cached_path(&id, &result.path)?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_add_category_cmd(
    state: State<'_, AppState>,
    name: String,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_add_category(&name)?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_rename_category_cmd(
    state: State<'_, AppState>,
    old: String,
    new: String,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_rename_category(&old, &new)?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_remove_category_cmd(
    state: State<'_, AppState>,
    name: String,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_remove_category(&name)?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn toolbox_move_category_cmd(
    state: State<'_, AppState>,
    name: String,
    direction: String,
) -> Result<ToolboxView, String> {
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    cfg.toolbox_move_category(&name, &direction)?;
    Ok(build_toolbox_view(&cfg.config))
}

#[tauri::command(async)]
pub fn backup_target_info_cmd(
    path: String,
    remote_override: Option<String>,
    state: State<'_, AppState>,
) -> Result<BackupTargetInfo, String> {
    let (backup_root, filters) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        let c = &cfg.config;
        (
            c.backup_root.clone(),
            BackupFilters::from_prefs(&c.backup_exclude, &c.backup_include, c.backup_max_file_mb)
                .respecting_gitignore(c.backup_respect_gitignore)
                .skipping_td_backups(c.backup_skip_td_backups),
        )
    };
    backup::backup_target_info(&path, &backup_root, remote_override.as_deref(), &filters)
}

#[tauri::command(async)]
pub fn backup_plan_cmd(
    path: String,
    mode: String,
    remote_override: Option<String>,
    state: State<'_, AppState>,
) -> Result<BackupPlan, String> {
    let (backup_root, filters) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        let c = &cfg.config;
        (
            c.backup_root.clone(),
            BackupFilters::from_prefs(&c.backup_exclude, &c.backup_include, c.backup_max_file_mb)
                .respecting_gitignore(c.backup_respect_gitignore)
                .skipping_td_backups(c.backup_skip_td_backups),
        )
    };
    backup::backup_plan(
        &path,
        &backup_root,
        &mode,
        remote_override.as_deref(),
        &filters,
    )
}

/// Live progress of a running transfer, for the frontend activity indicator.
/// Emitted on the `transfer-progress` event, throttled to ~10/s.
#[derive(Clone, Serialize)]
pub struct TransferProgressEvent {
    pub op_id: String,
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
    pub total_bytes: u64,
    pub detail: String,
}

/// Throttled `transfer-progress` emitter (always lets the final tick through).
fn progress_emitter(app: AppHandle, op_id: &'static str) -> impl FnMut(TransferProgressEvent) {
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    move |mut ev: TransferProgressEvent| {
        let is_final = ev.total > 0 && ev.done >= ev.total;
        if !is_final && last.elapsed() < std::time::Duration::from_millis(100) {
            return;
        }
        last = std::time::Instant::now();
        ev.op_id = op_id.into();
        let _ = app.emit("transfer-progress", ev);
    }
}

#[tauri::command(async)]
pub fn backup_run_cmd(
    path: String,
    mode: String,
    remote_override: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BackupResult, String> {
    let (backup_root, filters) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        let c = &cfg.config;
        (
            c.backup_root.clone(),
            BackupFilters::from_prefs(&c.backup_exclude, &c.backup_include, c.backup_max_file_mb)
                .respecting_gitignore(c.backup_respect_gitignore)
                .skipping_td_backups(c.backup_skip_td_backups),
        )
    };
    let mut emit = progress_emitter(app, "backup");
    backup::backup_run(
        &path,
        &backup_root,
        &mode,
        remote_override.as_deref(),
        &filters,
        move |done, total, detail| {
            emit(TransferProgressEvent {
                op_id: String::new(),
                done: done as u64,
                total: total as u64,
                bytes: 0,
                total_bytes: 0,
                detail: detail.to_string(),
            });
        },
    )
}

/// (filters, cloud_backup_root) snapshot for cloud transfer commands.
fn cloud_prefs(state: &State<'_, AppState>) -> Result<(BackupFilters, String), String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    let c = &cfg.config;
    Ok((
        BackupFilters::from_prefs(&c.backup_exclude, &c.backup_include, c.backup_max_file_mb)
                .respecting_gitignore(c.backup_respect_gitignore)
                .skipping_td_backups(c.backup_skip_td_backups),
        c.cloud_backup_root.clone(),
    ))
}

#[tauri::command(async)]
pub fn rclone_status_cmd() -> Result<RcloneStatus, String> {
    Ok(rclone::status())
}

#[tauri::command(async)]
pub fn rclone_install_cmd() -> Result<RcloneStatus, String> {
    rclone::install()
}

/// Opens the system browser for OAuth and blocks until the user approves.
#[tauri::command(async)]
pub fn rclone_remote_add_cmd(name: String, provider: String) -> Result<RcloneStatus, String> {
    rclone::add_remote(&name, &provider)
}

#[tauri::command(async)]
pub fn rclone_remote_delete_cmd(name: String) -> Result<RcloneStatus, String> {
    rclone::delete_remote(&name)
}

#[tauri::command(async)]
pub fn cloud_backup_info_cmd(
    path: String,
    remote: String,
    remote_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<BackupTargetInfo, String> {
    let (filters, cloud_root) = cloud_prefs(&state)?;
    rclone::cloud_target_info(&path, &remote, remote_path.as_deref(), &cloud_root, &filters)
}

#[tauri::command(async)]
pub fn cloud_backup_plan_cmd(
    path: String,
    remote: String,
    mode: String,
    remote_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<BackupPlan, String> {
    let (filters, cloud_root) = cloud_prefs(&state)?;
    rclone::cloud_plan(
        &path,
        &remote,
        &mode,
        remote_path.as_deref(),
        &cloud_root,
        &filters,
    )
}

#[tauri::command(async)]
pub fn cloud_backup_run_cmd(
    path: String,
    remote: String,
    mode: String,
    remote_path: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BackupResult, String> {
    let (filters, cloud_root) = cloud_prefs(&state)?;
    let mut emit = progress_emitter(app, "backup");
    rclone::cloud_run(
        &path,
        &remote,
        &mode,
        remote_path.as_deref(),
        &cloud_root,
        &filters,
        move |p| {
            emit(TransferProgressEvent {
                op_id: String::new(),
                done: p.done,
                total: p.total,
                bytes: p.bytes,
                total_bytes: p.total_bytes,
                detail: p.detail,
            });
        },
    )
}

#[tauri::command]
pub fn get_download_url(build_option: String) -> Option<String> {
    TDManager::generate_download_url(&build_option)
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    progress: f64,
    filename: String,
}

#[tauri::command(async)]
pub fn download_td(app: AppHandle, url: String, dest_path: String) -> Result<(), String> {
    // Blocking HTTP must not run on the async runtime — see proc::off_runtime.
    crate::proc::off_runtime(move || download_td_blocking(app, url, dest_path))
}

fn download_td_blocking(
    app: AppHandle,
    url: String,
    dest_path: String,
) -> Result<(), String> {
    if Path::new(&dest_path).exists() {
        return Ok(());
    }
    if let Some(parent) = Path::new(&dest_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let filename = Path::new(&dest_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client.get(&url).send().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut buffer = [0u8; 8192];

    use std::io::Read;
    loop {
        let n = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buffer[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        let progress = if total > 0 {
            (downloaded as f64 / total as f64).min(1.0)
        } else {
            0.0
        };
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                progress,
                filename: filename.clone(),
            },
        );
    }

    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            progress: 1.0,
            filename,
        },
    );
    Ok(())
}

#[tauri::command(async)]
pub fn open_installer(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Installer not found".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        crate::proc::command("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn check_version_installed(
    version: String,
    use_touchplayer: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let td = state.td.lock().map_err(|e| e.to_string())?;
    Ok(if use_touchplayer {
        td.is_player_installed(&version)
    } else {
        td.is_version_installed(&version)
    })
}

#[tauri::command(async)]
pub fn rediscover_and_check(
    version: String,
    use_touchplayer: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut td = state.td.lock().map_err(|e| e.to_string())?;
    td.discover();
    Ok(if use_touchplayer {
        td.is_player_installed(&version)
    } else {
        td.is_version_installed(&version)
    })
}

#[tauri::command(async)]
pub fn get_file_meta_cmd(path: String) -> FileMeta {
    get_file_meta(&path)
}

#[tauri::command(async)]
pub fn get_files_meta_cmd(paths: Vec<String>) -> Vec<FileMeta> {
    get_files_meta(&paths)
}

// ---- Quick-launch overlay ----

/// Show the quick-launch overlay (tray / main-window entry points; the global
/// hotkey path lives in lib.rs).
#[tauri::command]
pub fn open_quick_cmd(app: AppHandle) {
    #[cfg(desktop)]
    crate::show_quick_window(&app);
}

/// One `.tox` found in the Patreon download cache on disk.
#[derive(Debug, Clone, Serialize)]
pub struct CachedPatreonTox {
    pub name: String,
    pub path: String,
    /// Creator folder the file lives under.
    pub creator: String,
}

/// Walk the Patreon download root for cached `.tox` files — pure disk scan,
/// independent of the `patreon` build feature (the files exist either way).
/// Layout: `<root>/<creator>/<cache-key>/Name.tox`, with extracted zips
/// nesting further, so the walk is depth-limited rather than shaped.
#[tauri::command(async)]
pub fn patreon_cached_tox_cmd(state: State<'_, AppState>) -> Vec<CachedPatreonTox> {
    let root = {
        let configured = state
            .config
            .lock()
            .map(|c| c.config.patreon_download_root.clone())
            .unwrap_or_default();
        if configured.trim().is_empty() {
            // Mirrors patreon.rs default_download_dir().
            match dirs::document_dir() {
                Some(d) => d.join("TDXLU").join("Patreon Downloads"),
                None => return Vec::new(),
            }
        } else {
            PathBuf::from(configured.trim())
        }
    };
    if !root.is_dir() {
        return Vec::new();
    }

    const MAX_ITEMS: usize = 1000;
    const MAX_DEPTH: usize = 6;
    let mut out: Vec<CachedPatreonTox> = Vec::new();

    fn walk(
        dir: &Path,
        creator: Option<&str>,
        depth: usize,
        out: &mut Vec<CachedPatreonTox>,
    ) {
        if depth > MAX_DEPTH || out.len() >= MAX_ITEMS {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            if out.len() >= MAX_ITEMS {
                return;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                // First level below the root names the creator.
                let next_creator = creator.map(str::to_string).unwrap_or_else(|| name.clone());
                walk(&path, Some(&next_creator), depth + 1, out);
            } else if name.to_lowercase().ends_with(".tox") {
                out.push(CachedPatreonTox {
                    name,
                    path: path.to_string_lossy().to_string(),
                    creator: creator.unwrap_or("").to_string(),
                });
            }
        }
    }
    walk(&root, None, 0, &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// ---- Project variant families (Name.toe / Name.N.toe / Backup / crash) ----

#[tauri::command(async)]
pub fn list_project_families_cmd(
    entries: Vec<variants::FamilyScanEntry>,
) -> Vec<variants::ProjectFamily> {
    // A panicking command never resolves its invoke promise, and the frontend
    // awaits this during startup — a scan bug must degrade to "no grouping",
    // not hang the app on "Loading…" (it did once, on non-UTF8-boundary
    // slicing of a Cyrillic file name).
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        variants::scan_families(&entries)
    }))
    .unwrap_or_else(|_| {
        log::error!("variant family scan panicked; returning ungrouped");
        Vec::new()
    })
}

#[tauri::command(async)]
pub fn create_variant_cmd(source_path: String) -> Result<variants::VariantInfo, String> {
    variants::create_variant(&source_path)
}

#[tauri::command(async)]
pub fn create_safe_mode_copy_cmd(
    source_path: String,
    overwrite: Option<bool>,
) -> Result<variants::SafeModeCopy, String> {
    variants::create_safe_mode_copy(&source_path, overwrite.unwrap_or(false))
}

#[tauri::command(async)]
pub fn restore_variant_as_head_cmd(
    variant_path: String,
) -> Result<variants::RestoreResult, String> {
    variants::restore_variant_as_head(&variant_path)
}

#[tauri::command(async)]
pub fn trash_variants_cmd(paths: Vec<String>) -> Result<u64, String> {
    variants::trash_variants(&paths)
}

#[tauri::command(async)]
pub fn git_tool_info_cmd() -> git::GitToolInfo {
    git::git_tool_info()
}

#[tauri::command(async)]
pub fn git_status_cmd(path: String) -> Result<GitStatus, String> {
    git::git_status(&path)
}

#[tauri::command(async)]
pub fn git_init_cmd(path: String, gitignore: Option<bool>) -> Result<GitStatus, String> {
    git::git_init(&path, gitignore.unwrap_or(true))
}

#[tauri::command(async)]
pub fn git_stage_cmd(path: String, paths: Vec<String>) -> Result<GitStatus, String> {
    git::git_stage(&path, &paths)
}

#[tauri::command(async)]
pub fn git_unstage_cmd(path: String, paths: Vec<String>) -> Result<GitStatus, String> {
    git::git_unstage(&path, &paths)
}

#[tauri::command(async)]
pub fn git_ignore_add_cmd(path: String, pattern: String) -> Result<bool, String> {
    git::git_ignore_add(&path, &pattern)
}

#[tauri::command(async)]
pub fn git_commit_cmd(
    path: String,
    message: String,
    add_all: bool,
) -> Result<GitStatus, String> {
    git::git_commit(&path, &message, add_all)
}

#[tauri::command(async)]
pub fn git_checkout_cmd(
    path: String,
    branch: String,
    create: bool,
) -> Result<GitStatus, String> {
    git::git_checkout(&path, &branch, create)
}

#[tauri::command(async)]
pub fn git_set_remote_cmd(
    path: String,
    name: String,
    url: String,
) -> Result<GitStatus, String> {
    git::git_set_remote(&path, &name, &url)
}

#[tauri::command(async)]
pub fn git_diff_cmd(path: String, file: String, staged: bool) -> Result<GitDiff, String> {
    git::git_diff(&path, &file, staged)
}

#[tauri::command(async)]
pub fn git_log_cmd(path: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    git::git_log(&path, limit.unwrap_or(100))
}

#[tauri::command(async)]
pub fn git_show_cmd(
    path: String,
    rev: String,
    file: Option<String>,
) -> Result<GitCommitDetail, String> {
    git::git_show(&path, &rev, file.as_deref())
}

#[tauri::command(async)]
pub fn git_push_cmd(
    path: String,
    remote: Option<String>,
    set_upstream: bool,
    state: State<'_, AppState>,
) -> Result<GitStatus, String> {
    let token = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        let t = cfg.config.github_token.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    };
    git::git_push(&path, remote.as_deref(), set_upstream, token.as_deref())
}

#[tauri::command(async)]
pub fn git_pull_cmd(
    path: String,
    remote: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitStatus, String> {
    let token = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        let t = cfg.config.github_token.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    };
    git::git_pull(&path, remote.as_deref(), token.as_deref())
}

#[tauri::command(async)]
pub fn verify_github_token_cmd(token: String) -> Result<GitHubUser, String> {
    git::verify_github_token(&token)
}

#[tauri::command(async)]
pub fn watch_status_cmd(state: State<'_, AppState>) -> Result<WatchOverview, String> {
    let watch = state.watch.lock().map_err(|e| e.to_string())?;
    Ok(watch.overview())
}

#[tauri::command(async)]
pub fn watch_project_id_cmd(path: String) -> String {
    watch::watch_project_id(&path)
}

#[tauri::command(async)]
pub fn watch_start_cmd(
    app: AppHandle,
    path: String,
    version_key: String,
    use_touchplayer: bool,
    existing_pid: Option<u32>,
    state: State<'_, AppState>,
) -> Result<WatchOverview, String> {
    if path == DEFAULT_TEMPLATE {
        return Err("Pick a .toe project to watch".into());
    }
    // Attaching to a RUNNING session: its pulse is the companion utility's
    // heartbeat. With no utility nothing ever beats, so after the launch grace
    // the watchdog would read a healthy session as stalled and kill it. Refuse
    // up front. (A fresh launch is different: the utility hellos while TD boots,
    // inside the grace window, and there is no live session to lose.)
    if let Some(pid) = existing_pid {
        let has_companion = state
            .watch
            .lock()
            .map(|w| w.has_utility_peer(&path) || w.peer_for_pid(pid).is_some())
            .unwrap_or(false);
        if !has_companion {
            return Err(
                "Heartbeat needs the companion utility in this project — without it \
                 nothing sends heartbeats, and the watchdog would restart a healthy session. \
                 Drag TDXLauncherUtility.tox into the project first."
                    .into(),
            );
        }
    }
    let (cfg, log_dir) = {
        let c = state.config.lock().map_err(|e| e.to_string())?;
        let cfg = WatchConfig {
            port: c.config.watch_tcp_port,
            timeout_secs: c.config.watch_timeout_secs as u64,
            launch_grace_secs: c.config.watch_launch_grace_secs as u64,
            max_restarts: c.config.watch_max_restarts,
            screenshot_on_crash: c.config.watch_screenshot_on_crash,
            reboot_after_crashes: c.config.watch_reboot_after_crashes,
            email: EmailConfig::from_app(&c.config),
        };
        let log_dir = ConfigManager::config_dir().join("watch_logs");
        (cfg, log_dir)
    };

    if path != DEFAULT_TEMPLATE {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        let _ = cfg.add_recent_file(&path);
    }

    let launch_fn = {
        let app_handle = app.clone();
        Arc::new(move |p: &str, vk: &str, player: bool| {
            let state = app_handle.state::<AppState>();
            let td = state.td.lock().map_err(|e| e.to_string())?;
            td.launch(p, vk, player, "watchdog")
        }) as Arc<dyn Fn(&str, &str, bool) -> Result<Option<u32>, String> + Send + Sync>
    };

    let mut watch = state.watch.lock().map_err(|e| e.to_string())?;
    watch.start(
        app,
        path,
        version_key,
        use_touchplayer,
        cfg,
        launch_fn,
        log_dir,
        existing_pid,
    )
}

#[tauri::command(async)]
pub fn watch_stop_cmd(id: String, state: State<'_, AppState>) -> Result<WatchOverview, String> {
    let mut watch = state.watch.lock().map_err(|e| e.to_string())?;
    watch.stop_one(&id)
}

#[tauri::command(async)]
pub fn watch_stop_all_cmd(state: State<'_, AppState>) -> Result<WatchOverview, String> {
    let mut watch = state.watch.lock().map_err(|e| e.to_string())?;
    watch.stop_all();
    Ok(watch.overview())
}

#[tauri::command(async)]
pub fn mcp_status_cmd(path: String) -> McpBridgeStatus {
    mcp_bridge::inspect_path(&path)
}

#[tauri::command(async)]
pub fn mcp_open_folder_cmd(path: String) -> Result<(), String> {
    mcp_bridge::open_mcp_folder(&path)
}

#[tauri::command(async)]
pub fn mcp_set_port_cmd(path: String, port: u16) -> Result<McpBridgeStatus, String> {
    mcp_bridge::set_port(&path, port)
}

#[tauri::command(async)]
pub fn alert_test_email_cmd(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = {
        let c = state.config.lock().map_err(|e| e.to_string())?;
        EmailConfig::from_app(&c.config)
    };
    notify::send_test_email(&cfg)?;
    Ok(format!("Test email sent to {}", cfg.to))
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn write_temp_html(content: String) -> Result<String, String> {
    let dir = std::env::temp_dir();
    let path = dir.join("tdxlu-readme.html");
    let html = format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>README</title>
<style>body{{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.5;white-space:pre-wrap}}</style>
</head><body>{}</body></html>"#,
        html_escape(&content)
    );
    std::fs::write(&path, html).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// -- Licensing (see licensing.rs for the policy) ----------------------------

#[tauri::command(async)]
pub fn license_status_cmd() -> crate::licensing::LicenseStatus {
    crate::licensing::status()
}

/// Full browser OAuth round-trip — blocks (off the runtime) until the user
/// finishes in the browser or the 5-minute callback window lapses.
#[tauri::command(async)]
pub fn license_patreon_sign_in_cmd(
    app: AppHandle,
) -> Result<crate::licensing::LicenseStatus, String> {
    crate::proc::off_runtime(move || crate::licensing::patreon_sign_in(&app))
}

/// Best-effort entitlement refresh before an app-update install — updates
/// are never refused. The frontend calls this before `downloadAndInstall`.
#[tauri::command(async)]
pub fn license_verify_update_cmd(app: AppHandle, target_version: String) -> Result<(), String> {
    crate::proc::off_runtime(move || crate::licensing::verify_for_update(&app, &target_version))
}

/// Forced re-check past the gate's entitlement cache (throttled server-side).
/// Returns the gate's structured answer — `connected: false` means only a
/// fresh sign-in helps.
#[tauri::command(async)]
pub fn license_recheck_cmd(
    app: AppHandle,
) -> Result<crate::licensing::RecheckReport, String> {
    crate::proc::off_runtime(move || crate::licensing::recheck(&app))
}

/// Revokes the gate session first (best-effort when offline), then clears
/// the local file — network round-trip, so off the runtime.
#[tauri::command(async)]
pub fn license_sign_out_cmd(app: AppHandle) -> crate::licensing::LicenseStatus {
    crate::proc::off_runtime(move || crate::licensing::sign_out(&app))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The `.toe` an argv names, if any — skipping argv[0] (the exe) and any
/// flags such as `--autostart`.
///
/// Shared by startup and by the single-instance hook: when the app is already
/// running, Explorer's "open with" starts a second process whose argv is
/// handed to the FIRST instance, so both paths need the same parsing.
pub fn toe_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .find_map(|arg| normalize_toe(Path::new(arg.as_ref())))
}

/// An existing `.toe` at `p`, canonicalized to the absolute path the rest of
/// the app compares against (Windows verbatim `\\?\` prefix stripped), or
/// `None` if it isn't one.
///
/// Shared by the argv path (Windows/Linux) and macOS's open-document event,
/// which hands us `file://` URLs rather than arguments.
pub fn normalize_toe(p: &Path) -> Option<String> {
    let looks_toe = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase() == "toe")
        .unwrap_or(false);
    if !looks_toe || !p.exists() {
        return None;
    }
    let full = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let full = full.to_string_lossy().to_string();
    Some(
        full.strip_prefix(r"\\?\")
            .map(|s| s.to_string())
            .unwrap_or(full),
    )
}

pub fn parse_cli_toe() -> Option<String> {
    toe_from_args(std::env::args())
}

#[cfg(test)]
mod cli_arg_tests {
    use super::*;

    fn temp_toe(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(name);
        std::fs::write(&p, b"not really a toe").unwrap();
        p
    }

    /// argv[0] is the executable — a launcher installed at a path that happens
    /// to end in .toe must not be mistaken for the file to open.
    #[test]
    fn skips_argv0() {
        let exe = temp_toe("tdxlu_argv0_test.toe");
        let exe = exe.to_string_lossy().to_string();
        assert_eq!(toe_from_args(vec![exe.clone()]), None);
    }

    /// The real case: Explorer hands us `tdxlu.exe "C:\...\Project.toe"`.
    #[test]
    fn finds_the_toe_after_flags() {
        let toe = temp_toe("tdxlu_openme_test.toe");
        let args = vec![
            "tdxlu.exe".to_string(),
            "--autostart".to_string(),
            toe.to_string_lossy().to_string(),
        ];
        let found = toe_from_args(args).expect("the .toe argument");
        assert!(found.to_lowercase().ends_with("tdxlu_openme_test.toe"));
        assert!(!found.starts_with(r"\\?\"), "verbatim prefix is stripped");
    }

    /// A path that no longer exists is not something to open.
    #[test]
    fn ignores_missing_files_and_non_toe() {
        let args = vec![
            "tdxlu.exe".to_string(),
            r"C:\definitely\not\here\Ghost.toe".to_string(),
            "--autostart".to_string(),
        ];
        assert_eq!(toe_from_args(args), None);
    }

    /// macOS hands us `file://` URLs, not arguments, and percent-encodes the
    /// spaces that TouchDesigner project paths are full of. Decoding has to
    /// happen before the existence check or every such open is dropped.
    #[test]
    fn accepts_a_finder_file_url_with_spaces() {
        let toe = temp_toe("tdxlu url spaces test.toe");
        let url = tauri::Url::from_file_path(&toe).expect("an absolute path");
        assert!(url.as_str().contains("%20"), "space is percent-encoded");
        let path = url.to_file_path().expect("a file:// URL");
        let found = normalize_toe(&path).expect("the .toe");
        assert!(found.to_lowercase().ends_with("tdxlu url spaces test.toe"));
    }

    /// A `.tox`, a folder, or anything else the user aimed at us is not a
    /// project to open — the open-document event must ignore it rather than
    /// dropping the launcher into file-open mode on a file it can't launch.
    #[test]
    fn normalize_rejects_non_toe() {
        let tox = temp_toe("tdxlu_not_a_project_test.tox");
        assert_eq!(normalize_toe(&tox), None);
        assert_eq!(normalize_toe(&std::env::temp_dir()), None);
    }
}
