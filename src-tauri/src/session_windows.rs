//! Top-level OS windows belonging to running TouchDesigner sessions.
//!
//! A TD session is rarely a single window: the network editor, one or more
//! Perform windows parked on other displays, the Textport, floating dialogs.
//! Alt-Tab flattens them all into one undifferentiated pile, which is exactly
//! the thing that gets hard to navigate once two or three projects are open.
//! So the launcher enumerates windows per PID and offers focus/minimize on
//! each one individually.
//!
//! Everything reported here is an objective Win32 fact (visibility, owner,
//! iconic state, monitor, rect) — no guesses about TouchDesigner's internal
//! window naming. Callers that want a friendlier label derive it from the
//! title, which is what the user recognises anyway.
//!
//! Enumeration is a single in-process `EnumWindows` pass, cheap enough to ride
//! along on the existing open-projects poll. Focus runs in-process too, which
//! matters: `SetForegroundWindow` is only granted to the *foreground process*,
//! and the launcher is that process at the moment the user clicks a button —
//! a helper process spawned to do the same job is not, and gets refused.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SessionWindow {
    /// Opaque OS handle; pass back to [`focus`] / [`minimize`] / [`restore`].
    pub id: i64,
    pub pid: u32,
    pub title: String,
    /// Window has an owner — a dialog or floating tool, not a top-level window.
    pub owned: bool,
    pub minimized: bool,
    pub foreground: bool,
    /// 1-based display index in enumeration order; 0 = unknown.
    pub monitor: u32,
    pub monitor_primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Pane type reported by the companion Utility ("NETWORKEDITOR", "PANEL",
    /// …). None when the project has no Utility, or the window is not a pane.
    pub pane_type: Option<String>,
    /// Network path the pane is showing ("/", "/project1/scene").
    pub pane_owner: Option<String>,
}

/// Ask a project's companion Utility what each pane is showing, and attach it
/// to the matching window.
///
/// Windows titles a torn-off pane's window with the pane NAME — literally
/// "pane2" — which says nothing about its content. TD is the only thing that
/// knows the pane's owner, so when the Utility is loaded we ask it and match on
/// that title. Anything without a match (the main editor window, dialogs) is
/// left alone.
pub fn label_from_panes(windows: &mut [SessionWindow], panes: &serde_json::Value) {
    let Some(panes) = panes.get("panes").and_then(|p| p.as_array()) else {
        return;
    };
    for w in windows.iter_mut() {
        let hit = panes.iter().find(|p| {
            p.get("name").and_then(|n| n.as_str()) == Some(w.title.as_str())
        });
        let Some(pane) = hit else { continue };
        w.pane_type = pane
            .get("type")
            .and_then(|t| t.as_str())
            .map(str::to_string);
        w.pane_owner = pane
            .get("owner")
            .and_then(|o| o.as_str())
            .map(str::to_string);
    }
}

/// Whether asking the Utility could tell us anything: torn-off panes are owned
/// windows, so a session showing none has nothing to label.
pub fn has_pane_candidates(windows: &[SessionWindow]) -> bool {
    windows.iter().any(|w| w.owned)
}

/// Windows of the given processes, ordered main-window-first per process.
pub fn list_for_pids(pids: &[u32]) -> Vec<SessionWindow> {
    if pids.is_empty() {
        return Vec::new();
    }
    imp::list_for_pids(pids)
}

/// Owning process of the current foreground window.
///
/// Read this BEFORE showing an overlay — the summoned window steals the
/// foreground, after which the answer is the launcher itself. Any window of
/// the process counts (TD's floating panes and perform windows report the
/// same pid as the main editor). None off-Windows or when there is no
/// foreground window.
pub fn foreground_pid() -> Option<u32> {
    imp::foreground_pid()
}

/// Raw handle of the current foreground window, for comparing against one of
/// our own windows. None off-Windows or when nothing has the foreground.
pub fn foreground_hwnd() -> Option<isize> {
    imp::foreground_hwnd()
}

/// Executable filename of the foreground window's owning process, lower-case.
/// Kept as a direct OS query because the fullscreen hotkey watcher polls this
/// state and should not refresh a whole process table each time.
pub fn foreground_process_name() -> Option<String> {
    imp::foreground_process_name()
}

/// Notification states that mean "the user is in a full-screen experience".
///
/// The numbers are the `QUERY_USER_NOTIFICATION_STATE` enum. Split out from
/// the API call so the policy is testable without a desktop.
///
/// Not listed, therefore never suppressing: `QUNS_ACCEPTS_NOTIFICATIONS` (the
/// ordinary desktop, INCLUDING a maximized window), `QUNS_NOT_PRESENT` (a
/// locked or screensavered machine) and `QUNS_QUIET_TIME`.
pub(crate) fn state_is_fullscreen_app(state: i32) -> bool {
    const QUNS_BUSY: i32 = 2;
    const QUNS_RUNNING_D3D_FULL_SCREEN: i32 = 3;
    const QUNS_PRESENTATION_MODE: i32 = 4;
    const QUNS_APP: i32 = 7;
    matches!(
        state,
        QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE | QUNS_APP
    )
}

/// Is the user in a full-screen app right now — a game, a fullscreen video,
/// a presentation?
///
/// Asks Windows through `SHQueryUserNotificationState`, the same signal the OS
/// uses to decide whether a toast notification may interrupt. That is exactly
/// the question being asked here, and it is the reason this is not measured
/// from window geometry: with an auto-hidden taskbar the work area equals the
/// whole monitor, so a merely MAXIMIZED window fills the monitor rect exactly
/// and is indistinguishable from a fullscreen one by size alone.
///
/// Pair it with [`foreground_pid`]: TouchDesigner in Perform Mode is a
/// fullscreen app too, and that is when the hotkey is wanted most.
pub fn user_in_fullscreen_app() -> bool {
    imp::user_in_fullscreen_app()
}

/// Raise a single window and give it keyboard focus, un-minimizing if needed.

pub fn focus(id: i64) -> Result<(), String> {
    imp::focus(id)
}

pub fn minimize(id: i64) -> Result<(), String> {
    imp::minimize(id)
}

pub fn restore(id: i64) -> Result<(), String> {
    imp::restore(id)
}

/// Raise every window of a session, ending on its main window so that one
/// keeps focus. Un-minimizes anything iconic on the way.
pub fn raise_session(pid: u32) -> Result<(), String> {
    let windows = list_for_pids(&[pid]);
    if windows.is_empty() {
        return Err(format!("No windows found for PID {pid}"));
    }
    // Reverse order: the list is main-first, and the LAST raise wins focus.
    for w in windows.iter().rev() {
        let _ = imp::restore(w.id);
    }
    windows
        .first()
        .map(|w| imp::focus(w.id))
        .unwrap_or_else(|| Err(format!("No windows found for PID {pid}")))
}

/// Minimize every window of a session — clears a project off screen without
/// killing it.
pub fn minimize_session(pid: u32) -> Result<(), String> {
    let windows = list_for_pids(&[pid]);
    if windows.is_empty() {
        return Err(format!("No windows found for PID {pid}"));
    }
    for w in &windows {
        let _ = imp::minimize(w.id);
    }
    Ok(())
}

/// Best guess at the session's main window: first in list order.
///
/// Only called from the Windows focus path; macOS focuses via AppleScript.
#[cfg(windows)]
pub fn main_window_for_pid(pid: u32) -> Option<i64> {
    list_for_pids(&[pid]).first().map(|w| w.id)
}

#[cfg(windows)]
mod imp {
    use super::SessionWindow;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO,
        MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
        IsWindowVisible, SetForegroundWindow, ShowWindowAsync, GW_OWNER, SW_MINIMIZE, SW_RESTORE,
        SW_SHOW,
    };

    /// `MONITORINFO::dwFlags` bit for the primary display. Not re-exported by
    /// windows-sys, so spelled out here.
    const MONITORINFOF_PRIMARY: u32 = 0x0000_0001;

    const FOREGROUND_REFUSED: &str =
        "Windows refused to change the foreground window — click the launcher first, then retry";

    fn hwnd_of(id: i64) -> HWND {
        id as usize as *mut c_void
    }

    fn id_of(hwnd: HWND) -> i64 {
        hwnd as usize as i64
    }

    pub fn foreground_hwnd() -> Option<isize> {
        let hwnd = unsafe { GetForegroundWindow() };
        (!hwnd.is_null()).then_some(hwnd as isize)
    }

    pub fn foreground_pid() -> Option<u32> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            (pid != 0).then_some(pid)
        }
    }

    pub fn foreground_process_name() -> Option<String> {
        let pid = foreground_pid()?;
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut buffer = vec![0u16; 32_768];
            let mut len = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len);
            CloseHandle(process);
            if ok == 0 || len == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buffer[..len as usize]);
            std::path::Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_ascii_lowercase())
        }
    }

    pub fn user_in_fullscreen_app() -> bool {
        let mut state: i32 = 0;
        // S_OK only; any failure means "no idea", which must not suppress.
        let hr = unsafe {
            windows_sys::Win32::UI::Shell::SHQueryUserNotificationState(&mut state as *mut i32 as *mut _)
        };
        if hr != 0 {
            return false;
        }
        super::state_is_fullscreen_app(state)
    }

    fn window_title(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; len as usize + 1];
            let written = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if written <= 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..written as usize])
        }
    }

    /// HMONITOR handles in enumeration order — the index becomes the display
    /// number the user sees ("Display 2").
    fn monitor_order() -> Vec<isize> {
        unsafe extern "system" fn cb(
            monitor: HMONITOR,
            _hdc: HDC,
            _rect: *mut RECT,
            data: LPARAM,
        ) -> windows_sys::core::BOOL {
            let out = unsafe { &mut *(data as *mut Vec<isize>) };
            out.push(monitor as isize);
            TRUE
        }
        let mut out: Vec<isize> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(cb),
                &mut out as *mut Vec<isize> as LPARAM,
            );
        }
        out
    }

    struct Scan {
        pids: Vec<u32>,
        found: Vec<(HWND, u32)>,
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, data: LPARAM) -> windows_sys::core::BOOL {
        let scan = unsafe { &mut *(data as *mut Scan) };
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return TRUE;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || !scan.pids.contains(&pid) {
                return TRUE;
            }
            // Untitled visible windows are TD's internal scaffolding (tooltips,
            // layered helpers) — nothing the user could pick out of a list.
            if GetWindowTextLengthW(hwnd) <= 0 {
                return TRUE;
            }
            scan.found.push((hwnd, pid));
        }
        TRUE
    }

    pub fn list_for_pids(pids: &[u32]) -> Vec<SessionWindow> {
        let mut scan = Scan {
            pids: pids.to_vec(),
            found: Vec::new(),
        };
        unsafe {
            EnumWindows(Some(enum_cb), &mut scan as *mut Scan as LPARAM);
        }
        if scan.found.is_empty() {
            return Vec::new();
        }

        let monitors = monitor_order();
        let foreground = unsafe { GetForegroundWindow() };

        let mut out: Vec<SessionWindow> = scan
            .found
            .into_iter()
            .map(|(hwnd, pid)| {
                let title = window_title(hwnd);
                let owned = unsafe { !GetWindow(hwnd, GW_OWNER).is_null() };
                let minimized = unsafe { IsIconic(hwnd) != 0 };
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                let have_rect = unsafe { GetWindowRect(hwnd, &mut rect) != 0 };
                let (monitor, monitor_primary) = unsafe {
                    let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                    let index = monitors
                        .iter()
                        .position(|m| *m == hmon as isize)
                        .map(|i| i as u32 + 1)
                        .unwrap_or(0);
                    let mut info = MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    let primary = !hmon.is_null()
                        && GetMonitorInfoW(hmon, &mut info) != 0
                        && info.dwFlags & MONITORINFOF_PRIMARY != 0;
                    (index, primary)
                };
                SessionWindow {
                    id: id_of(hwnd),
                    pid,
                    title,
                    owned,
                    minimized,
                    foreground: !foreground.is_null() && hwnd == foreground,
                    monitor,
                    monitor_primary,
                    x: rect.left,
                    y: rect.top,
                    width: if have_rect { rect.right - rect.left } else { 0 },
                    height: if have_rect { rect.bottom - rect.top } else { 0 },
                    // Filled in later by the Utility, when the project has one.
                    pane_type: None,
                    pane_owner: None,
                }
            })
            .collect();

        // Main windows first (unowned, then largest — the editor dwarfs its
        // dialogs), so `first()` is a sane "the project's window".
        out.sort_by(|a, b| {
            a.owned
                .cmp(&b.owned)
                .then_with(|| {
                    let area = |w: &SessionWindow| (w.width as i64) * (w.height as i64);
                    area(b).cmp(&area(a))
                })
                .then_with(|| a.title.cmp(&b.title))
        });
        out
    }

    fn valid(id: i64) -> Result<HWND, String> {
        let hwnd = hwnd_of(id);
        if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
            return Err("That window is gone — refresh the session list".into());
        }
        Ok(hwnd)
    }

    pub fn focus(id: i64) -> Result<(), String> {
        let hwnd = valid(id)?;
        // ShowWindowAsync, not ShowWindow: these are another process's
        // windows, and ShowWindow waits for that window's thread to handle
        // the message. A TouchDesigner busy cooking or loading answers late,
        // so the old call (and the click behind it) could hang for as long
        // as TD stayed busy. The async form posts and returns.
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindowAsync(hwnd, SW_RESTORE);
            } else {
                ShowWindowAsync(hwnd, SW_SHOW);
            }
            if SetForegroundWindow(hwnd) != 0 && GetForegroundWindow() == hwnd {
                return Ok(());
            }
            // Refused. Windows grants the foreground to the process that owns
            // it, to whoever got the last input event — or to a thread that is
            // attached to the foreground thread's input queue. That last one is
            // the only lever available here, and it has to attach OUR thread to
            // the foreground thread (attaching two other threads to each other
            // grants this caller nothing).
            let fg = GetForegroundWindow();
            if fg.is_null() {
                return Err(FOREGROUND_REFUSED.into());
            }
            let cur = GetCurrentThreadId();
            let fg_thread = GetWindowThreadProcessId(fg, std::ptr::null_mut());
            if fg_thread == 0 || fg_thread == cur {
                return Err(FOREGROUND_REFUSED.into());
            }
            if AttachThreadInput(cur, fg_thread, TRUE) == 0 {
                return Err(FOREGROUND_REFUSED.into());
            }
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            AttachThreadInput(cur, fg_thread, FALSE);
            if GetForegroundWindow() == hwnd {
                Ok(())
            } else {
                Err(FOREGROUND_REFUSED.into())
            }
        }
    }

    pub fn minimize(id: i64) -> Result<(), String> {
        let hwnd = valid(id)?;
        unsafe { ShowWindowAsync(hwnd, SW_MINIMIZE) };
        Ok(())
    }

    pub fn restore(id: i64) -> Result<(), String> {
        let hwnd = valid(id)?;
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindowAsync(hwnd, SW_RESTORE);
            } else {
                BringWindowToTop(hwnd);
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::SessionWindow;

    const UNSUPPORTED: &str = "Per-window control is only available on Windows";

    pub fn list_for_pids(_pids: &[u32]) -> Vec<SessionWindow> {
        Vec::new()
    }

    pub fn focus(_id: i64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn minimize(_id: i64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn restore(_id: i64) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    /// Frontmost APPLICATION pid via NSWorkspace — native, no osascript spawn
    /// (which would stall the summon) and no Automation consent prompt.
    /// Window-level enumeration stays unsupported here; the summon only needs
    /// the owning process, and every TD window belongs to the TD process.
    #[cfg(target_os = "macos")]
    pub fn foreground_pid() -> Option<u32> {
        let ws = objc2_app_kit::NSWorkspace::sharedWorkspace();
        let app = ws.frontmostApplication()?;
        // Applications without a pid report -1 (AppKit contract).
        let pid = app.processIdentifier();
        (pid > 0).then_some(pid as u32)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn foreground_pid() -> Option<u32> {
        None
    }

    pub fn foreground_hwnd() -> Option<isize> {
        None
    }

    pub fn foreground_process_name() -> Option<String> {
        None
    }

    /// Off-Windows the probe reports false, so hotkey suppression never fires
    /// there rather than guessing from an unsupported signal.
    pub fn user_in_fullscreen_app() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    /// Manual probe against a live TouchDesigner — enumerate, focus, and round-
    /// trip minimize/restore on a real session. Ignored by default because it
    /// needs TD running and moves windows on the developer's desktop:
    ///
    ///   TDXLU_WINDOW_PID=<pid> cargo test --lib session_windows -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_live_session() {
        let pid: u32 = std::env::var("TDXLU_WINDOW_PID")
            .expect("set TDXLU_WINDOW_PID to a running TouchDesigner PID")
            .parse()
            .expect("numeric pid");

        let windows = super::list_for_pids(&[pid]);
        println!("{} window(s) for pid {pid}", windows.len());
        for w in &windows {
            println!(
                "  id={} owned={} min={} fg={} mon={}{} {}x{} @({},{}) :: {}",
                w.id, w.owned, w.minimized, w.foreground, w.monitor,
                if w.monitor_primary { "*" } else { "" },
                w.width, w.height, w.x, w.y, w.title
            );
        }
        assert!(!windows.is_empty(), "no windows found for pid {pid}");
        // The main window sorts first: unowned, and the largest of those.
        assert!(!windows[0].owned, "first entry should be a top-level window");

        // Act on the main window, not a floating pane: panes are opened and
        // closed freely while TD runs, and a handle that dies mid-test proves
        // nothing about focus (that race is what `valid()` reports on).
        let target = windows[0].id;
        let state_of = |id: i64| super::list_for_pids(&[pid]).into_iter().find(|w| w.id == id);

        // Informational only. Windows grants the foreground to the process the
        // user last interacted with; a test binary spawned in the background
        // never qualifies, so a refusal here is correct OS behaviour, not a
        // defect. Focus is exercised for real from the launcher window, which
        // IS the foreground process when the user clicks.
        println!("focus() -> {:?}", super::focus(target));

        super::minimize(target).expect("minimize");
        assert!(state_of(target).is_some_and(|w| w.minimized), "target did not minimize");
        super::restore(target).expect("restore");
        assert!(state_of(target).is_some_and(|w| !w.minimized), "target did not restore");

        // Same caveat on the focus half; the un-minimize half is checkable.
        super::minimize_session(pid).expect("minimize_session");
        assert!(
            state_of(windows[0].id).is_some_and(|w| w.minimized),
            "minimize_session should minimize the main window"
        );
        let _ = super::raise_session(pid);
        assert!(
            state_of(windows[0].id).is_some_and(|w| !w.minimized),
            "raise_session should un-minimize the main window"
        );
    }
}

#[cfg(test)]
mod pane_tests {
    use super::SessionWindow;

    fn win(id: i64, title: &str, owned: bool) -> SessionWindow {
        SessionWindow {
            id,
            pid: 1,
            title: title.into(),
            owned,
            minimized: false,
            foreground: false,
            monitor: 1,
            monitor_primary: true,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            pane_type: None,
            pane_owner: None,
        }
    }

    /// Verbatim payload from a live TD 2025.33070 over the Utility TCP bus,
    /// with one pane torn off. `pane2`/`pane3`/`pane4` are DOCKED — they have
    /// no OS window of their own and must not label anything.
    fn live_payload() -> serde_json::Value {
        serde_json::json!({
            "ok": true,
            "panes": [
                {"name": "pane4", "id": 0, "type": "NETWORKEDITOR", "owner": "/", "owner_name": "root"},
                {"name": "pane3", "id": 1, "type": "PARAMETERS", "owner": "/", "owner_name": "root"},
                {"name": "pane2", "id": 2, "type": "PANEL", "owner": "/", "owner_name": "root"},
                {"name": "copy_of_pane4_0", "id": 3, "type": "NETWORKEDITOR",
                 "owner": "/TDXLauncherUtility", "owner_name": "TDXLauncherUtility"}
            ]
        })
    }

    #[test]
    fn labels_floating_pane_and_leaves_main_window_alone() {
        let mut windows = vec![
            win(1, "TouchDesigner 2025.33070: C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.toe", false),
            win(2, "copy_of_pane4_0", true),
        ];
        super::label_from_panes(&mut windows, &live_payload());

        // The main window's title matches no pane name.
        assert_eq!(windows[0].pane_owner, None);
        assert_eq!(windows[0].pane_type, None);

        assert_eq!(windows[1].pane_owner.as_deref(), Some("/TDXLauncherUtility"));
        assert_eq!(windows[1].pane_type.as_deref(), Some("NETWORKEDITOR"));
    }

    /// An older Utility (pre-0.2.1) answers `{"ok": false, "error": "unknown
    /// action: panes"}`. That must degrade to "no labels", never a panic.
    #[test]
    fn unknown_action_response_is_inert() {
        let mut windows = vec![win(1, "pane2", true)];
        let stale = serde_json::json!({"ok": false, "error": "unknown action: panes"});
        super::label_from_panes(&mut windows, &stale);
        assert_eq!(windows[0].pane_owner, None);
    }

    #[test]
    fn only_owned_windows_are_worth_asking_about() {
        let main = vec![win(1, "TouchDesigner 2025.33070: x.toe", false)];
        assert!(!super::has_pane_candidates(&main));
        let with_pane = vec![win(1, "x", false), win(2, "pane2", true)];
        assert!(super::has_pane_candidates(&with_pane));
    }
}

#[cfg(test)]
mod fullscreen_probe {
    /// Manual probe: prints the live foreground pid + fullscreen verdict every
    /// second for 15s. Ignored by default — it reports on whatever the
    /// developer alt-tabs to, which is the entire point.
    ///
    ///   cargo test --lib fullscreen_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn watch_foreground() {
        for _ in 0..15 {
            let pid = super::foreground_pid();
            let fs = super::user_in_fullscreen_app();
            println!("foreground pid={pid:?} fullscreen_app={fs}");
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod fullscreen_rules {
    use super::state_is_fullscreen_app;

    /// The ordinary desktop — and this is the regression that mattered: a
    /// MAXIMIZED window reports this, not a fullscreen state. The rule this
    /// replaced measured window geometry and could not tell the two apart on
    /// a machine with an auto-hidden taskbar, where the work area equals the
    /// whole monitor.
    #[test]
    fn a_maximized_window_is_just_the_desktop() {
        assert!(!state_is_fullscreen_app(5)); // QUNS_ACCEPTS_NOTIFICATIONS
    }

    #[test]
    fn exclusive_fullscreen_game_suppresses() {
        assert!(state_is_fullscreen_app(3)); // QUNS_RUNNING_D3D_FULL_SCREEN
    }

    #[test]
    fn borderless_fullscreen_app_suppresses() {
        assert!(state_is_fullscreen_app(2)); // QUNS_BUSY
    }

    #[test]
    fn presentation_and_store_fullscreen_suppress() {
        assert!(state_is_fullscreen_app(4)); // QUNS_PRESENTATION_MODE
        assert!(state_is_fullscreen_app(7)); // QUNS_APP
    }

    #[test]
    fn locked_or_quiet_machine_does_not_suppress() {
        assert!(!state_is_fullscreen_app(1)); // QUNS_NOT_PRESENT
        assert!(!state_is_fullscreen_app(6)); // QUNS_QUIET_TIME
    }
}
