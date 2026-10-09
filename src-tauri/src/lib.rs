mod backup;
mod command_usage;
mod commands;
mod config;
mod fns_store;
mod git;
mod licensing;
mod mcp_bridge;
mod media_stream;
mod notify;
mod open_projects;
mod palette;
mod patreon;
mod patreon_index;
mod proc;
mod project;
mod project_meta;
mod rclone;
mod session_perf;
mod session_windows;
mod td_manager;
mod tdp;
mod tdp_catalog;
mod tox_cache;
mod updates;
mod variants;
mod control_server;
mod palette_tabs;
mod remote_handoff;
mod watch;

use commands::{parse_cli_toe, AppState, APP_VERSION};
use config::ConfigManager;
use open_projects::OpenProjectsHub;
use std::sync::Mutex;
use td_manager::TDManager;
use watch::WatchManager;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// Windows' native RegisterHotKey is what gives a background app reliable
/// permission to take foreground. While a game owns a fullscreen foreground
/// window we temporarily release every binding instead, so the same chords are
/// available to the game without replacing the reliable activation path.
#[cfg(windows)]
static HOTKEYS_SUSPENDED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Should native global hotkeys be inactive right now?
///
/// True only when a FULLSCREEN window owns the foreground and it does not
/// belong to TouchDesigner. Fullscreen alone is not enough: TD in Perform
/// Mode fills the screen, and that is exactly when the overlay is wanted.
///
/// The process is matched by executable name rather than against the tracked
/// session list, so a TD the launcher never started — or one whose session
/// row has not been scanned yet — still counts as TouchDesigner.
fn hotkey_blocked_by_fullscreen() -> bool {
    if !session_windows::user_in_fullscreen_app() {
        return false;
    }
    let Some(pid) = session_windows::foreground_pid() else {
        // Fullscreen but unattributable: let the hotkey through rather than
        // swallowing it on a guess.
        return false;
    };
    if pid == std::process::id() {
        return false;
    }
    // This is polled on Windows while deciding whether native registrations
    // should be temporarily released. A direct process-image query keeps that
    // check cheap and avoids refreshing a whole sysinfo process table.
    let name = session_windows::foreground_process_name().unwrap_or_default();
    !keeps_hotkeys_when_fullscreen(&name)
}

/// Windows' own shell surfaces that report a full-screen notification state
/// while they are up, but are not a game or a video: the Start/Search panel,
/// flyouts, the snipping overlay, the emoji panel, the lock screen. Releasing
/// the hotkeys for these swallowed the next press — the launcher log showed
/// every release in a day's use came from searchhost.exe or snippingtool.exe.
const SHELL_OVERLAYS: &[&str] = &[
    "searchhost.exe",
    "searchapp.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "snippingtool.exe",
    "screenclippinghost.exe",
    "textinputhost.exe",
    "lockapp.exe",
    "explorer.exe",
];

/// Does a fullscreen app with this process image name keep the hotkeys?
///
/// TouchDesigner does (Perform Mode is fullscreen, and that is when the
/// overlay is wanted most), and so does every Windows shell overlay. Anything
/// else fullscreen — a game, a fullscreen video — gets the chords instead.
fn keeps_hotkeys_when_fullscreen(process_name: &str) -> bool {
    let name = process_name.to_ascii_lowercase();
    // TouchDesigner.exe / TouchPlayer.exe, and the bare names off-Windows.
    name.contains("touchdesigner")
        || name.contains("touchplayer")
        || SHELL_OVERLAYS.contains(&name.as_str())
}

#[cfg(test)]
mod fullscreen_hotkey_tests {
    use super::keeps_hotkeys_when_fullscreen as keeps;

    #[test]
    fn touchdesigner_keeps_hotkeys() {
        assert!(keeps("TouchDesigner.exe"));
        assert!(keeps("touchplayer.exe"));
    }

    #[test]
    fn windows_shell_overlays_keep_hotkeys() {
        // The two that actually showed up in the launcher log.
        assert!(keeps("SearchHost.exe"));
        assert!(keeps("SnippingTool.exe"));
        assert!(keeps("StartMenuExperienceHost.exe"));
    }

    #[test]
    fn games_and_players_release_them() {
        assert!(!keeps("eldenring.exe"));
        assert!(!keeps("vlc.exe"));
        assert!(!keeps(""));
    }
}

/// Run the action behind a configured global hotkey.
#[cfg(desktop)]
pub(crate) fn fire_hotkey_target(app: &tauri::AppHandle, target: HotkeyTarget) {
    match target {
        HotkeyTarget::Quick | HotkeyTarget::QuickAlt => {
            if let Some(win) = app.get_webview_window("quick") {
                let vis = win.is_visible().unwrap_or(false);
                let foc = win.is_focused().unwrap_or(false);
                log::info!(
                    "hotkey quick: visible={vis} focused={foc} -> {}",
                    if vis { "HIDE" } else { "show" }
                );
                if vis {
                    let _ = win.hide();
                } else {
                    show_quick_window(app);
                }
            }
        }
        HotkeyTarget::Main | HotkeyTarget::MainAlt => toggle_main_window_hotkey(app, None),
        HotkeyTarget::Palette => toggle_main_window_hotkey(app, Some("palette")),
    }
}

/// Show the quick-launch overlay window and tell it to reset for a fresh
/// query. Recentered every summon — monitors change between shows.
pub(crate) fn show_quick_window(app: &tauri::AppHandle) {
    // What was the user looking at when they summoned? Captured BEFORE the
    // overlay shows and steals the foreground. The palette uses it to rank
    // the summoned-over TD session first and to target it directly —
    // floating panes and perform windows carry the same pid as their main
    // editor, so summoning over any TD window counts. Our own pid means the
    // user came from the launcher: no session context.
    let focused_pid =
        crate::session_windows::foreground_pid().filter(|pid| *pid != std::process::id());
    if let Some(win) = app.get_webview_window("quick") {
        // Disarm the blur dismiss for this summon: it re-arms on the first
        // Focused(true). A show that never wins foreground must not hide
        // itself on the blur that follows. See the window event handler.
        app.state::<AppState>()
            .quick_focused
            .store(false, std::sync::atomic::Ordering::Relaxed);
        log::debug!("quick: show (dismiss disarmed)");
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_focus();
        // Window focus alone sometimes leaves the webview out of the
        // responder chain on macOS — the overlay then ignores every key,
        // Esc included. Focus the webview explicitly so keys land.
        let webview: &tauri::Webview = win.as_ref();
        let _ = webview.set_focus();
        let _ = win.emit("quick:open", serde_json::json!({ "focused_pid": focused_pid }));
    }
}

/// Show (never hide) the main launcher window, optionally telling the
/// frontend to switch tabs first (e.g. "palette").
pub(crate) fn show_main_window(app: &tauri::AppHandle, tab: Option<&str>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(t) = tab {
        let _ = app.emit("main:open-tab", t);
    }
}

/// Hide the main window if it's up and focused, else bring it forward
/// (optionally on a specific tab). Used by the tray click.
#[cfg(desktop)]
pub(crate) fn toggle_main_window(app: &tauri::AppHandle, tab: Option<&str>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
    }
    show_main_window(app, tab);
}

/// Is the launcher window actually in front — the window the user is looking
/// at, not just shown somewhere behind another app or minimized?
///
/// On Windows this compares the real foreground window with ours rather than
/// trusting the webview's tracked focus flag. Elsewhere it falls back to that
/// flag.
#[cfg(desktop)]
fn main_window_in_front(win: &tauri::WebviewWindow) -> bool {
    if !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
        return false;
    }
    #[cfg(windows)]
    if let (Ok(ours), Some(fg)) = (win.hwnd(), crate::session_windows::foreground_hwnd()) {
        return ours.0 as isize == fg;
    }
    win.is_focused().unwrap_or(false)
}

/// Hotkey toggle: hide the launcher only when it is in front; from anywhere
/// else — hidden, minimized, or buried behind another window — bring it up.
///
/// A plain visibility toggle used to be here, and it made the hotkey take two
/// presses whenever the launcher was open but behind something: the first
/// press saw "visible" and hid it, the second showed it.
#[cfg(desktop)]
fn toggle_main_window_hotkey(app: &tauri::AppHandle, tab: Option<&str>) {
    if let Some(win) = app.get_webview_window("main") {
        let in_front = main_window_in_front(&win);
        log::info!("hotkey main: in_front={in_front} -> {}", if in_front { "HIDE" } else { "show" });
        if in_front {
            let _ = win.hide();
            return;
        }
    }
    show_main_window(app, tab);
}

/// macOS: re-show the launcher when the app is activated with no window up.
///
/// Cmd+Tab (and clicking the app's name in the menu bar) only *activates* the
/// process — AppKit sends no reopen Apple Event for it, so `RunEvent::Reopen`,
/// which covers the Dock/Finder click, never fires. A close-to-tray'd launcher
/// therefore listed itself in the Cmd+Tab switcher but selecting it looked
/// dead: the menu bar swapped in and no window came back. Observing
/// `NSApplicationDidBecomeActive` closes that gap.
///
/// Two guards keep it from firing when it shouldn't:
/// - it only acts once the app has resigned active at least once, so the
///   activation that comes with launching the app can't yank a
///   `--autostart` (start-in-tray) run onto the screen;
/// - it only acts when none of our windows are visible, so summoning the
///   quick overlay — which activates the app too — doesn't drag the main
///   window along with it.
#[cfg(target_os = "macos")]
fn watch_app_activation(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let was_inactive = Arc::new(AtomicBool::new(false));

    let resigned = was_inactive.clone();
    let on_resign = RcBlock::new(move |_: NonNull<NSNotification>| {
        resigned.store(true, Ordering::Relaxed);
    });

    let handle = app.clone();
    let on_activate = RcBlock::new(move |_: NonNull<NSNotification>| {
        if !was_inactive.swap(false, Ordering::Relaxed) {
            return;
        }
        let any_visible = handle
            .webview_windows()
            .values()
            .any(|w| w.is_visible().unwrap_or(false));
        if !any_visible {
            show_main_window(&handle, None);
        }
    });

    // Both blocks run on the main queue, where touching windows is legal. The
    // observers are never removed — they live as long as the process.
    unsafe {
        let center = NSNotificationCenter::defaultCenter();
        let queue = NSOperationQueue::mainQueue();
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidResignActiveNotification),
            None,
            Some(&queue),
            &on_resign,
        ));
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidBecomeActiveNotification),
            None,
            Some(&queue),
            &on_activate,
        ));
    }
}

/// Which window (and, for Palette, tab) a global hotkey binding controls.
#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HotkeyTarget {
    /// Quick-launch overlay.
    Quick,
    /// Optional second combo for the quick-launch overlay. Follows the
    /// Quick enabled flag; "" = unbound.
    QuickAlt,
    /// Main launcher window, whatever tab was last active.
    Main,
    /// Optional second combo for the main window. Follows the Main enabled
    /// flag; "" = unbound.
    MainAlt,
    /// Main launcher window, jumped to the Palette tab.
    Palette,
}

#[cfg(desktop)]
impl HotkeyTarget {
    /// The configured accelerator string for this target ("" = unbound).
    fn accel(self, app: &tauri::AppHandle) -> String {
        let st = app.state::<AppState>();
        let Ok(cfg) = st.config.lock() else {
            return String::new();
        };
        match self {
            HotkeyTarget::Quick => cfg.config.global_hotkey.clone(),
            HotkeyTarget::QuickAlt => cfg.config.global_hotkey_alt.clone(),
            HotkeyTarget::Main => cfg.config.global_hotkey_main.clone(),
            HotkeyTarget::MainAlt => cfg.config.global_hotkey_main_alt.clone(),
            HotkeyTarget::Palette => cfg.config.global_hotkey_palette.clone(),
        }
    }
}

/// Register or unregister one target's configured hotkey live. Idempotent
/// (clears that target's own prior binding first, leaving the other targets
/// untouched). Returns an error message on failure, else None.
#[cfg(desktop)]
pub(crate) fn register_hotkey(
    app: &tauri::AppHandle,
    target: HotkeyTarget,
    enabled: bool,
) -> Option<String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let hotkey = target.accel(app);
    let gs = app.global_shortcut();
    if let Ok(sc) = hotkey.parse::<Shortcut>() {
        let _ = gs.unregister(sc);
    }
    if !enabled {
        return None;
    }
    if hotkey.trim().is_empty() {
        // An empty ALTERNATE is simply unbound, not a problem.
        return if matches!(target, HotkeyTarget::QuickAlt | HotkeyTarget::MainAlt) {
            None
        } else {
            Some("No hotkey set.".into())
        };
    }
    match hotkey.parse::<Shortcut>() {
        Ok(sc) => {
            #[cfg(windows)]
            if HOTKEYS_SUSPENDED.load(std::sync::atomic::Ordering::Relaxed) {
                return None;
            }
            match gs.register(sc) {
                Ok(_) => {
                    log::info!("global hotkey ({target:?}) registered: {hotkey}");
                    None
                }
                Err(e) => {
                    log::warn!("hotkey '{hotkey}' ({target:?}) register failed: {e}");
                    Some(format!(
                        "'{hotkey}' couldn't be registered — likely already in use by the OS or \
                     another app. Try Ctrl+Alt+E."
                    ))
                }
            }
        }
        Err(e) => Some(format!(
            "'{hotkey}' isn't a valid shortcut ({e}). Use Ctrl, Alt, Shift, Super — e.g. Ctrl+Alt+E."
        )),
    }
}

/// Re-bind one hotkey after its COMBO changed, and store the resulting status.
///
/// The config already holds the new accelerator by the time this runs, so
/// `register_hotkey` alone would never release the old binding — it would stay
/// live while the newly typed one did nothing. That is exactly why editing the
/// combo used to need a restart. Pass the accelerator as it was BEFORE the
/// edit so it can be unregistered explicitly.
///
/// Must be called with no config lock held: `register_hotkey` takes it.
#[cfg(desktop)]
pub(crate) fn rebind_hotkey(
    app: &tauri::AppHandle,
    target: HotkeyTarget,
    old_accel: &str,
) -> Option<String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    if !old_accel.trim().is_empty() {
        if let Ok(sc) = old_accel.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(sc);
        }
    }

    let enabled = {
        let st = app.state::<AppState>();
        let Ok(cfg) = st.config.lock() else {
            return Some("config busy".into());
        };
        match target {
            HotkeyTarget::Quick | HotkeyTarget::QuickAlt => cfg.config.global_hotkey_enabled,
            HotkeyTarget::Main | HotkeyTarget::MainAlt => cfg.config.global_hotkey_main_enabled,
            HotkeyTarget::Palette => cfg.config.global_hotkey_palette_enabled,
        }
    };
    let status = register_hotkey(app, target, enabled);
    if let Ok(mut s) = app.state::<AppState>().hotkey_status.lock() {
        match target {
            HotkeyTarget::Quick => s.quick = status.clone(),
            HotkeyTarget::QuickAlt => s.quick_alt = status.clone(),
            HotkeyTarget::Main => s.main = status.clone(),
            HotkeyTarget::MainAlt => s.main_alt = status.clone(),
            HotkeyTarget::Palette => s.palette = status.clone(),
        }
    }
    status
}

/// Persist the enabled flag for one target, (un)register live, and store the
/// resulting status. Returns the status message on failure, else None.
#[cfg(desktop)]
pub(crate) fn set_hotkey_enabled(
    app: &tauri::AppHandle,
    target: HotkeyTarget,
    enabled: bool,
) -> Option<String> {
    if let Ok(mut cfg) = app.state::<AppState>().config.lock() {
        match target {
            HotkeyTarget::Quick => cfg.config.global_hotkey_enabled = enabled,
            HotkeyTarget::Main => cfg.config.global_hotkey_main_enabled = enabled,
            HotkeyTarget::Palette => cfg.config.global_hotkey_palette_enabled = enabled,
            // Alternates carry no enabled flag of their own — they follow
            // their primary and are toggled through it below.
            HotkeyTarget::QuickAlt | HotkeyTarget::MainAlt => {}
        }
        let _ = cfg.save();
    }
    let status = register_hotkey(app, target, enabled);
    // The optional alternate combo follows its primary's toggle.
    let alt_status = match target {
        HotkeyTarget::Quick => Some(register_hotkey(app, HotkeyTarget::QuickAlt, enabled)),
        HotkeyTarget::Main => Some(register_hotkey(app, HotkeyTarget::MainAlt, enabled)),
        _ => None,
    };
    if let Ok(mut s) = app.state::<AppState>().hotkey_status.lock() {
        match target {
            HotkeyTarget::Quick => {
                s.quick = status.clone();
                s.quick_alt = alt_status.flatten();
            }
            HotkeyTarget::QuickAlt => s.quick_alt = status.clone(),
            HotkeyTarget::Main => {
                s.main = status.clone();
                s.main_alt = alt_status.flatten();
            }
            HotkeyTarget::MainAlt => s.main_alt = status.clone(),
            HotkeyTarget::Palette => s.palette = status.clone(),
        }
    }
    status
}

#[cfg(desktop)]
fn initialise_hotkey_bindings(app: &tauri::AppHandle) {
    let (quick_enabled, main_enabled, palette_enabled) = app
        .state::<AppState>()
        .config
        .lock()
        .map(|c| {
            (
                c.config.global_hotkey_enabled,
                c.config.global_hotkey_main_enabled,
                c.config.global_hotkey_palette_enabled,
            )
        })
        .unwrap_or((false, false, false));
    let quick_status = register_hotkey(app, HotkeyTarget::Quick, quick_enabled);
    let quick_alt_status = register_hotkey(app, HotkeyTarget::QuickAlt, quick_enabled);
    let main_status = register_hotkey(app, HotkeyTarget::Main, main_enabled);
    let main_alt_status = register_hotkey(app, HotkeyTarget::MainAlt, main_enabled);
    let palette_status = register_hotkey(app, HotkeyTarget::Palette, palette_enabled);
    if let Ok(mut s) = app.state::<AppState>().hotkey_status.lock() {
        s.quick = quick_status;
        s.quick_alt = quick_alt_status;
        s.main = main_status;
        s.main_alt = main_alt_status;
        s.palette = palette_status;
    }
}

#[cfg(windows)]
fn fullscreen_hotkeys_should_suspend(app: &tauri::AppHandle) -> bool {
    let skip = app
        .state::<AppState>()
        .config
        .lock()
        .map(|c| c.config.hotkey_skip_fullscreen)
        .unwrap_or(true);
    skip && hotkey_blocked_by_fullscreen()
}

/// Keep native hotkey registrations only while they are useful. RegisterHotKey
/// supplies reliable one-press foreground activation; releasing it while a
/// non-TD fullscreen app is active lets games receive the same chord.
#[cfg(windows)]
fn initialise_and_watch_windows_hotkeys(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering::Relaxed;
    use std::time::Duration;

    let initially_suspended = fullscreen_hotkeys_should_suspend(app);
    HOTKEYS_SUSPENDED.store(initially_suspended, Relaxed);
    initialise_hotkey_bindings(app);
    if initially_suspended {
        log::info!("global hotkeys temporarily released for fullscreen foreground app");
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut suspended = initially_suspended;
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let next = fullscreen_hotkeys_should_suspend(&handle);
            if next == suspended {
                continue;
            }

            // Set the gate first. initialise_hotkey_bindings unregisters every
            // current accelerator, then only registers it when this is false.
            HOTKEYS_SUSPENDED.store(next, Relaxed);
            initialise_hotkey_bindings(&handle);
            suspended = next;

            if next {
                let pid = session_windows::foreground_pid().unwrap_or_default();
                let name = session_windows::foreground_process_name().unwrap_or_default();
                log::info!(
                    "global hotkeys temporarily released: fullscreen foreground pid={pid} ({name})"
                );
            } else {
                log::info!("global hotkeys restored after leaving fullscreen app");
            }
        }
    });
}

/// Hand a `.toe` the OS asked us to open to the frontend.
///
/// Both channels are used on purpose, because either can be the only one that
/// works depending on how far along startup we are:
///
/// * the `cli_toe` slot covers a file that arrives BEFORE the webview has
///   mounted — the frontend drains it once during bootstrap;
/// * the `cli-toe-opened` event covers a file that arrives AFTER, when the
///   already-mounted window will never re-run that bootstrap read.
///
/// Whichever gets there first wins; the other finds the slot empty.
fn deliver_toe(app: &tauri::AppHandle, toe: String) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut slot) = state.cli_toe.lock() {
            *slot = Some(toe.clone());
        }
    }
    let _ = app.emit("cli-toe-opened", toe);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_toe = parse_cli_toe();

    let mut builder = tauri::Builder::default();

    // Must be registered before any other plugin. When a second instance is
    // launched (e.g. double-clicking the exe, or Start Menu/taskbar) while
    // we're already running (including hidden in the tray), this fires in
    // the FIRST instance instead of a new process starting, so we wake and
    // focus our existing window.
    //
    // The second process's argv arrives here too, and it is the ONLY place a
    // file-association open lands once we're running: Explorer starts
    // `tdxlu.exe "D:\Some.toe"`, that process hands us its args and exits.
    // Dropping them left the window sitting on whatever project it was
    // already showing — so opening a different .toe from Explorer looked like
    // it re-targeted the previous one, and the only way through was to kill
    // the background TDXLU so Explorer could start a fresh process.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(toe) = commands::toe_from_args(&args) {
                deliver_toe(app, toe);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Login launches carry this flag so the app can start in the tray.
            Some(vec!["--autostart"]),
        ))
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            std::thread::spawn(move || {
                responder.respond(media_stream::handle_request(request));
            });
        })
        .manage(AppState {
            cli_toe: Mutex::new(cli_toe),
            quick_dragging: std::sync::atomic::AtomicBool::new(false),
            quick_focused: std::sync::atomic::AtomicBool::new(false),
            config: Mutex::new(ConfigManager::new()),
            td: Mutex::new(TDManager::new()),
            watch: Mutex::new(WatchManager::new()),
            open: Mutex::new(OpenProjectsHub::new()),
            hotkey_status: Mutex::new(commands::HotkeyStatus::default()),
            control: Mutex::new(control_server::ControlServerState::default()),
            perf: Mutex::new(session_perf::PerfSampler::new()),
        })
        .setup(|app| {
            // Log in RELEASE too, to a file. A packaged build previously
            // discarded every log line, so any user-reported misbehaviour had
            // to be reproduced on a dev machine before it could even be
            // observed. The file target makes a report actionable on its own.
            {
                // clear_targets() first: the default set is already
                // [Stdout, LogDir], so adding to it yields duplicate targets —
                // every line logged twice and two files written.
                let mut builder = tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .clear_targets()
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("tdxlu".into()),
                        },
                    ));
                if cfg!(debug_assertions) {
                    builder = builder.target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ));
                }
                app.handle().plugin(builder.build())?;
            }
            log::info!("TDX Launcher Ultra v{APP_VERSION}");

            // macOS Cmd+Tab / menu-bar activation -> bring the window back.
            #[cfg(target_os = "macos")]
            watch_app_activation(app.handle());

            // Licensing: startup entitlement pass (best-effort claim renewal)
            // + watchdog. No-ops without the `licensing` feature. Paid
            // licenses never lock out on a failed request — see licensing.rs.
            licensing::spawn_watchdog(app.handle().clone());

            // Quick-launch overlay window — hidden until the global hotkey
            // summons it. Built up front so the first summon is instant.
            #[cfg(desktop)]
            {
                use tauri::{WebviewUrl, WebviewWindowBuilder};
                match WebviewWindowBuilder::new(
                    app,
                    "quick",
                    WebviewUrl::App("quick.html".into()),
                )
                .title("Quick Launch")
                .inner_size(640.0, 460.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .center()
                .build()
                {
                    Ok(w) => {
                        log::info!("quick-launch overlay ready");
                        // Dismiss on focus loss HERE, not in the webview: the
                        // tauri JS event bridge drops window focus events
                        // intermittently, and WKWebView never fires DOM blur
                        // when the NSWindow resigns key — so the overlay stayed
                        // up after clicking away. tao delivers Focused(false)
                        // reliably. Exception: a .tox drag-out blurs the
                        // overlay by design — the frontend flags it via
                        // set_quick_dragging_cmd and hides the window itself
                        // when the drag lands.
                        let win = w.clone();
                        w.on_window_event(move |ev| {
                            use std::sync::atomic::Ordering::Relaxed;
                            let state = win.app_handle().state::<AppState>();
                            match ev {
                                // The summon actually landed. Only now may a
                                // later blur dismiss it.
                                tauri::WindowEvent::Focused(true) => {
                                    log::debug!("quick: Focused(true) - dismiss armed");
                                    state.quick_focused.store(true, Relaxed);
                                }
                                tauri::WindowEvent::Focused(false) => {
                                    // Focus notifications can briefly bounce as
                                    // the OS finishes activating a hotkey-summoned
                                    // window. Re-check after that transition:
                                    // transient blur is ignored, while an actual
                                    // click-away remains unfocused and closes.
                                    let armed = state.quick_focused.load(Relaxed);
                                    let dragging = state.quick_dragging.load(Relaxed);
                                    if armed && !dragging {
                                        let delayed_win = win.clone();
                                        std::thread::spawn(move || {
                                            std::thread::sleep(
                                                std::time::Duration::from_millis(150),
                                            );
                                            let handle = delayed_win.app_handle().clone();
                                            let _ = handle.run_on_main_thread(move || {
                                                use std::sync::atomic::Ordering::Relaxed;
                                                let state =
                                                    delayed_win.app_handle().state::<AppState>();
                                                let focused = delayed_win
                                                    .is_focused()
                                                    .unwrap_or(false);
                                                let dragging = state.quick_dragging.load(Relaxed);
                                                log::info!(
                                                    "quick: delayed blur check focused={focused} dragging={dragging} -> {}",
                                                    if !focused && !dragging {
                                                        "HIDE"
                                                    } else {
                                                        "ignored"
                                                    }
                                                );
                                                if !focused && !dragging {
                                                    state.quick_focused.store(false, Relaxed);
                                                    let _ = delayed_win.hide();
                                                }
                                            });
                                        });
                                    }
                                }
                                _ => {}
                            }
                        });
                    }
                    Err(e) => log::warn!("quick-launch overlay failed to create: {e}"),
                }
            }

            // Native global hotkeys — three independent bindings (quick-launch
            // overlay, main window, main window on Palette). On Windows a
            // lightweight watcher releases all registrations while a non-TD
            // fullscreen app is foreground, so the game receives the chords.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

                let plugin_added = app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, sc, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            let (
                                quick_accel,
                                quick_alt,
                                main_accel,
                                main_alt,
                                palette_accel,
                                skip_fullscreen,
                            ) = app
                                .state::<AppState>()
                                .config
                                .lock()
                                .map(|c| {
                                    (
                                        c.config.global_hotkey.clone(),
                                        c.config.global_hotkey_alt.clone(),
                                        c.config.global_hotkey_main.clone(),
                                        c.config.global_hotkey_main_alt.clone(),
                                        c.config.global_hotkey_palette.clone(),
                                        c.config.hotkey_skip_fullscreen,
                                    )
                                })
                                .unwrap_or_default();
                            // Popping the overlay over a fullscreen game yanks
                            // the foreground out from under it. TD in Perform
                            // Mode is fullscreen too, so the test is "fullscreen
                            // AND not TouchDesigner", never fullscreen alone.
                            if skip_fullscreen && hotkey_blocked_by_fullscreen() {
                                return;
                            }
                            let fires = |accel: &str| {
                                !accel.trim().is_empty()
                                    && accel.parse::<Shortcut>().map(|s| &s == sc).unwrap_or(false)
                            };
                            if fires(&quick_accel) || fires(&quick_alt) {
                                fire_hotkey_target(app, HotkeyTarget::Quick);
                            } else if fires(&main_accel) || fires(&main_alt) {
                                fire_hotkey_target(app, HotkeyTarget::Main);
                            } else if fires(&palette_accel) {
                                fire_hotkey_target(app, HotkeyTarget::Palette);
                            }
                        })
                        .build(),
                );
                match plugin_added {
                    Ok(()) => {
                        #[cfg(windows)]
                        initialise_and_watch_windows_hotkeys(app.handle());
                        #[cfg(not(windows))]
                        initialise_hotkey_bindings(app.handle());
                    }
                    Err(e) => log::warn!("global-shortcut plugin init failed: {e}"),
                }
            }

            // Utility TCP bus (hello / heartbeat) - always on, independent of Watch sessions
            {
                let port = app
                    .state::<AppState>()
                    .config
                    .lock()
                    .map(|c| c.config.watch_tcp_port)
                    .unwrap_or(11999);
                let port = if port == 0 { 11999 } else { port };
                if let Err(e) = app
                    .state::<AppState>()
                    .watch
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|mut w| {
                        // The bus emits peer events (utility-hello) from startup,
                        // not only once a Watch session has supplied the handle.
                        w.set_app(app.handle().clone());
                        w.ensure_bus(port)
                    })
                {
                    log::warn!("Utility TCP bus failed to bind :{port}: {e}");
                } else {
                    log::info!("Utility TCP bus listening on 127.0.0.1:{port}");
                }
            }

            // One-time: copy the bundled companion TOX into the user's Palette
            // so it's always there to drag into projects. Once-flag (not
            // if-absent) so deleting it is respected.
            {
                let already = app
                    .state::<AppState>()
                    .config
                    .lock()
                    .map(|c| c.config.utility_palette_installed)
                    .unwrap_or(true);
                if !already {
                    if let Ok(tox) = app.path().resolve(
                        "../release/TDXLauncherUtility.tox",
                        tauri::path::BaseDirectory::Resource,
                    ) {
                        if tox.is_file() {
                            let src = tox.to_string_lossy().to_string();
                            match crate::palette::import_tox_to_user_palette(&[src], None) {
                                Ok(_) => {
                                    log::info!("companion TOX installed into user palette");
                                    if let Ok(mut c) = app.state::<AppState>().config.lock() {
                                        c.config.utility_palette_installed = true;
                                        let _ = c.save();
                                    }
                                }
                                Err(e) => log::warn!("companion TOX palette install failed: {e}"),
                            }
                        }
                        // Not a file (dev, unbundled) → leave the flag so a real
                        // build installs it later.
                    }
                }
            }

            let (show_tray, quick_accel, quick_enabled, quick_has, main_accel, main_enabled, main_has, palette_accel, palette_enabled, palette_has) =
                app.state::<AppState>()
                    .config
                    .lock()
                    .map(|c| {
                        let quick_has = !c.config.global_hotkey.trim().is_empty();
                        let quick_accel = if c.config.global_hotkey_enabled && quick_has {
                            Some(c.config.global_hotkey.clone())
                        } else {
                            None
                        };
                        let main_has = !c.config.global_hotkey_main.trim().is_empty();
                        let main_accel = if c.config.global_hotkey_main_enabled && main_has {
                            Some(c.config.global_hotkey_main.clone())
                        } else {
                            None
                        };
                        let palette_has = !c.config.global_hotkey_palette.trim().is_empty();
                        let palette_accel = if c.config.global_hotkey_palette_enabled && palette_has {
                            Some(c.config.global_hotkey_palette.clone())
                        } else {
                            None
                        };
                        (
                            c.config.show_tray,
                            quick_accel,
                            c.config.global_hotkey_enabled,
                            quick_has,
                            main_accel,
                            c.config.global_hotkey_main_enabled,
                            main_has,
                            palette_accel,
                            c.config.global_hotkey_palette_enabled,
                            palette_has,
                        )
                    })
                    .unwrap_or((true, None, false, false, None, false, false, None, false, false));

            if show_tray {
                // Show each hotkey next to its menu item so they're discoverable.
                let show_i =
                    MenuItem::with_id(app, "show", "Show TDX Launcher Ultra", true, main_accel.as_deref())?;
                let quick_i =
                    MenuItem::with_id(app, "quick", "Quick Launch", true, quick_accel.as_deref())?;
                let palette_i =
                    MenuItem::with_id(app, "palette", "Open Palette", true, palette_accel.as_deref())?;
                // Live enable/disable ticks for each global hotkey.
                let hotkey_i = CheckMenuItem::with_id(
                    app,
                    "toggle_hotkey",
                    "Quick Launch hotkey",
                    quick_has,
                    quick_enabled,
                    None::<&str>,
                )?;
                let hotkey_main_i = CheckMenuItem::with_id(
                    app,
                    "toggle_hotkey_main",
                    "Main window hotkey",
                    main_has,
                    main_enabled,
                    None::<&str>,
                )?;
                let hotkey_palette_i = CheckMenuItem::with_id(
                    app,
                    "toggle_hotkey_palette",
                    "Palette hotkey",
                    palette_has,
                    palette_enabled,
                    None::<&str>,
                )?;
                let watch_i =
                    MenuItem::with_id(app, "watch_status", "Heartbeat: idle", false, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &show_i,
                        &quick_i,
                        &palette_i,
                        &hotkey_main_i,
                        &hotkey_i,
                        &hotkey_palette_i,
                        &watch_i,
                        &quit_i,
                    ],
                )?;

                // The menu bar draws its items as stencils, so macOS gets a
                // black-on-clear template the system tints to match a light or
                // dark bar. Everywhere else the colour app icon is correct.
                #[cfg(target_os = "macos")]
                let tray_icon =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-mac-template.png"))?;
                #[cfg(not(target_os = "macos"))]
                let tray_icon = app.default_window_icon().unwrap().clone();

                let _tray = TrayIconBuilder::new()
                    .icon(tray_icon)
                    .icon_as_template(true)
                    .menu(&menu)
                    .tooltip("TDX Launcher Ultra")
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| match event.id.as_ref() {
                        "show" => show_main_window(app, None),
                        "quick" => show_quick_window(app),
                        "palette" => show_main_window(app, Some("palette")),
                        "toggle_hotkey" => {
                            let now = app
                                .state::<AppState>()
                                .config
                                .lock()
                                .map(|c| c.config.global_hotkey_enabled)
                                .unwrap_or(false);
                            let next = !now;
                            #[cfg(desktop)]
                            let _ = set_hotkey_enabled(app, HotkeyTarget::Quick, next);
                            let _ = hotkey_i.set_checked(next);
                        }
                        "toggle_hotkey_main" => {
                            let now = app
                                .state::<AppState>()
                                .config
                                .lock()
                                .map(|c| c.config.global_hotkey_main_enabled)
                                .unwrap_or(false);
                            let next = !now;
                            #[cfg(desktop)]
                            let _ = set_hotkey_enabled(app, HotkeyTarget::Main, next);
                            let _ = hotkey_main_i.set_checked(next);
                        }
                        "toggle_hotkey_palette" => {
                            let now = app
                                .state::<AppState>()
                                .config
                                .lock()
                                .map(|c| c.config.global_hotkey_palette_enabled)
                                .unwrap_or(false);
                            let next = !now;
                            #[cfg(desktop)]
                            let _ = set_hotkey_enabled(app, HotkeyTarget::Palette, next);
                            let _ = hotkey_palette_i.set_checked(next);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        // Mouse-up is often dropped on macOS for the first
                        // click while the app is inactive; mouse-down isn't.
                        // toggle_main_window also requires focus, so a
                        // "visible" but background/hidden-looking window is
                        // brought forward instead of immediately hidden.
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Down,
                            ..
                        } = event
                        {
                            toggle_main_window(tray.app_handle(), None);
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .app_handle()
                    .state::<AppState>()
                    .config
                    .lock()
                    .map(|c| c.config.close_to_tray && c.config.show_tray)
                    .unwrap_or(true);
                if close_to_tray {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_cli_toe_file,
            commands::get_hotkey_status,
            commands::get_hotkey_status_quick_alt,
            commands::get_hotkey_status_main_alt,
            commands::set_hotkey_enabled_cmd,
            commands::set_quick_dragging_cmd,
            commands::get_hotkey_status_main,
            commands::set_hotkey_enabled_main_cmd,
            commands::get_hotkey_status_palette,
            commands::set_hotkey_enabled_palette_cmd,
            commands::restart_app,
            commands::get_bundled_utility_tox,
            commands::discover_versions,
            commands::inspect_toe,
            commands::launch_project,
            commands::open_projects_list_cmd,
            commands::open_project_kill_cmd,
            commands::open_project_dismiss_cmd,
            commands::open_project_focus_cmd,
            commands::open_project_utility_cmd,
            commands::sessions_perf_cmd,
            commands::open_control_server_cmd,
            commands::phone_remote_start_cmd,
            commands::control_regenerate_token_cmd,
            commands::control_server_stop_cmd,
            commands::control_server_status_cmd,
            commands::open_project_relaunch_cmd,
            commands::session_windows_list_cmd,
            commands::session_window_action_cmd,
            commands::session_windows_bulk_cmd,
            commands::get_config,
            commands::update_prefs,
            commands::export_settings_cmd,
            commands::import_settings_cmd,
            commands::merge_quick_seen_commands_cmd,
            commands::get_recents,
            commands::add_recent,
            commands::remove_recent,
            commands::clear_recents,
            commands::clear_missing,
            commands::get_templates,
            commands::add_template,
            commands::remove_template,
            commands::move_template,
            commands::import_plus_templates_cmd,
            commands::find_icon,
            commands::get_icon_data_url,
            commands::get_project_meta,
            commands::get_projects_meta,
            commands::get_all_tags,
            commands::save_project_meta_cmd,
            commands::list_gpu_monitors,
            commands::set_project_gpu_affinity,
            commands::show_main_window,
            commands::get_readme,
            commands::save_readme_cmd,
            commands::open_path,
            commands::open_url,
            commands::pick_toe_files,
            commands::pick_tox_files,
            commands::pick_media_file,
            commands::locate_media_files_cmd,
            commands::cache_tox_from_url_cmd,
            commands::command_usage_record,
            commands::command_usage_bonuses,
            commands::command_usage_clear,
            commands::tdp_env_status_cmd,
            commands::tdp_install_package_cmd,
            commands::tdp_pypi_catalog_cmd,
            commands::tdp_pypi_readme_cmd,
            commands::patreon_open_login,
            commands::patreon_try_capture,
            commands::patreon_logout,
            commands::patreon_list_campaigns_cmd,
            commands::patreon_add_creator_cmd,
            commands::patreon_remove_creator_cmd,
            commands::patreon_list_tox_posts_cmd,
            commands::patreon_search_cmd,
            commands::patreon_campaign_last_upload_cmd,
            commands::patreon_campaign_latest_post_cmd,
            commands::patreon_post_detail_cmd,
            commands::patreon_download_tox_cmd,
            commands::patreon_extract_zip_cmd,
            commands::patreon_zip_extract_status_cmd,
            commands::patreon_tox_local_path_cmd,
            commands::pick_folder,
            commands::default_palette_dir_cmd,
            commands::get_drag_icon_path,
            commands::get_palette_items_cmd,
            commands::palette_scan_info_cmd,
            commands::import_tox_to_palette_cmd,
            commands::remove_palette_file_cmd,
            commands::rebuild_palette_data_cmd,
            commands::install_bundled_utility_cmd,
            commands::fns_place_cmd,
            commands::check_utility_update_cmd,
            commands::install_utility_update_cmd,
            commands::fns_manifest_cmd,
            commands::fns_store_status_cmd,
            commands::fns_sync_store_cmd,
            commands::fns_write_selection_cmd,
            commands::fns_bootstrap_path_cmd,
            commands::fns_bundled_artifact_cmd,
            commands::fns_config_read_cmd,
            commands::fns_config_write_cmd,
            commands::fns_settings_state_cmd,
            commands::fns_settings_set_cmd,
            commands::fns_settings_scope_cmd,
            commands::toolbox_get_cmd,
            commands::toolbox_seed_bundled_cmd,
            commands::toolbox_add_tool_cmd,
            commands::toolbox_update_tool_cmd,
            commands::toolbox_remove_tool_cmd,
            commands::toolbox_move_tool_cmd,
            commands::toolbox_fetch_tool_cmd,
            commands::toolbox_add_category_cmd,
            commands::toolbox_rename_category_cmd,
            commands::toolbox_remove_category_cmd,
            commands::toolbox_move_category_cmd,
            commands::backup_target_info_cmd,
            commands::backup_plan_cmd,
            commands::backup_run_cmd,
            commands::rclone_status_cmd,
            commands::rclone_install_cmd,
            commands::rclone_remote_add_cmd,
            commands::rclone_remote_delete_cmd,
            commands::cloud_backup_info_cmd,
            commands::cloud_backup_plan_cmd,
            commands::cloud_backup_run_cmd,
            commands::get_download_url,
            commands::download_td,
            commands::open_installer,
            commands::check_version_installed,
            commands::rediscover_and_check,
            commands::get_file_meta_cmd,
            commands::get_files_meta_cmd,
            commands::open_quick_cmd,
            commands::patreon_cached_tox_cmd,
            commands::list_project_families_cmd,
            commands::create_variant_cmd,
            commands::create_safe_mode_copy_cmd,
            commands::restore_variant_as_head_cmd,
            commands::trash_variants_cmd,
            commands::git_tool_info_cmd,
            commands::git_status_cmd,
            commands::git_init_cmd,
            commands::git_stage_cmd,
            commands::git_unstage_cmd,
            commands::git_ignore_add_cmd,
            commands::git_commit_cmd,
            commands::git_checkout_cmd,
            commands::git_set_remote_cmd,
            commands::git_diff_cmd,
            commands::git_log_cmd,
            commands::git_show_cmd,
            commands::git_push_cmd,
            commands::git_pull_cmd,
            commands::verify_github_token_cmd,
            commands::watch_status_cmd,
            commands::watch_project_id_cmd,
            commands::watch_start_cmd,
            commands::watch_stop_cmd,
            commands::watch_stop_all_cmd,
            commands::mcp_status_cmd,
            commands::mcp_open_folder_cmd,
            commands::mcp_set_port_cmd,
            commands::alert_test_email_cmd,
            commands::quit_app,
            commands::write_temp_html,
            commands::license_status_cmd,
            commands::license_patreon_sign_in_cmd,
            commands::license_verify_update_cmd,
            commands::license_recheck_cmd,
            commands::license_sign_out_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            match event {
                // macOS: clicking the Dock icon fires Reopen. A close-to-tray'd
                // (hidden) window must be re-shown here — without this the Dock
                // click does nothing and only the tray icon can bring it back.
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
                // macOS: double-clicking a .toe in Finder (or "Open With") does
                // NOT put the path in argv and does NOT start a second process
                // — AppKit sends the running app an open-document Apple Event,
                // which lands here as `Opened`. Without this arm the file was
                // dropped on the floor: the launcher came up (or came forward)
                // on whatever project it was already showing, never entered
                // file-open mode, and so never started the launch countdown.
                //
                // This is the ONLY delivery path on macOS — `parse_cli_toe`
                // and the single-instance hook both read argv, which Finder
                // never fills.
                tauri::RunEvent::Opened { ref urls } => {
                    let toe = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .find_map(|p| commands::normalize_toe(&p));
                    if let Some(toe) = toe {
                        deliver_toe(app, toe);
                    }
                    // The app may have been sitting hidden in the tray, or
                    // behind Finder — a Finder open has to bring it forward.
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, &event);
            }
        });
}
