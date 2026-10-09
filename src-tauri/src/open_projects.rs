//! Currently open TouchDesigner project sessions.
//!
//! Combines (1) projects this launcher spawned and (2) every live TD process,
//! placed by its window title, its companion's hello, or the `.toe` on its
//! command line — whichever it has (plus Embody envoy.json hints).

use crate::session_windows::SessionWindow;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// One live TouchDesigner process for a project.
///
/// Normally there is exactly one. Two or more means the same `.toe` is open
/// more than once — launched twice from here, opened from Explorer while
/// already running, relaunched without kill-first, or started by an autostart
/// service. The launcher can't prevent that (most of those paths never touch
/// it), so the row owns the project and this list owns the processes.
///
/// Worth knowing when you see two: both processes share the project's
/// `.embody` directory and externalized files, so whichever saves last wins.
#[derive(Debug, Clone, Serialize)]
pub struct SessionInstance {
    pub pid: u32,
    /// "launcher" when this launcher started it, "process" when discovered by
    /// the process scan.
    pub source: String,
    /// Epoch seconds, launcher-started sessions only.
    pub started_at: Option<f64>,
    /// Top-level OS windows owned by THIS process.
    pub windows: Vec<SessionWindow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenProject {
    pub id: String,
    pub path: String,
    pub display_name: String,
    pub pid: Option<u32>,
    pub alive: bool,
    pub version_key: Option<String>,
    pub use_touchplayer: bool,
    pub envoy_port: Option<u16>,
    /// TCP check on envoy_port (None if port unknown).
    pub envoy_up: Option<bool>,
    /// Project has .embody / .mcp.json (disk).
    pub mcp_available: bool,
    /// Live TD has TDXLauncherUtility. Always `None` as this hub builds it —
    /// resolved from the Utility's own TCP bus by
    /// `commands::apply_utility_presence`, which every caller that surfaces
    /// this field runs over the list. `None` = no live peer = no companion.
    pub utility_available: Option<bool>,
    /// Version reported by the live utility peer (None = unknown / pre-versioning).
    pub utility_version: Option<String>,
    /// Seconds since this live session's companion last pulsed, once it has
    /// gone silent (see `WatchManager::silent_peer_age`) — TD is likely not
    /// responding. None = answering, or no companion to judge by. Resolved by
    /// `commands::apply_utility_presence` like `utility_available`.
    pub companion_silent_secs: Option<u64>,
    pub source: String,
    pub started_at: Option<f64>,
    /// When a launcher-started session's process ended, epoch seconds. `None`
    /// while live. A stale/tombstone row (alive=false, ended_at=Some) stays in
    /// the Current tab so it can be relaunched — cleared on app restart.
    pub ended_at: Option<f64>,
    /// Top-level OS windows this session owns, main window first. Empty when
    /// the PID is unknown or the platform can't enumerate windows. Flattened
    /// across every entry in `instances` (each window carries its own `pid`),
    /// so window search and counts stay whole-project.
    pub windows: Vec<SessionWindow>,
    /// Every live process for this project, primary first. Empty on a
    /// tombstone, and on a launcher session whose PID was never known.
    pub instances: Vec<SessionInstance>,
}

fn with_envoy(port: Option<u16>) -> (Option<u16>, Option<bool>) {
    match port {
        Some(p) => (Some(p), Some(crate::mcp_bridge::port_is_open(p))),
        None => (None, None),
    }
}

fn mcp_available_for_toe(toe_path: &str) -> bool {
    crate::mcp_bridge::find_project_root(Path::new(toe_path)).is_some()
}

// Companion presence is NOT probed here. It is resolved exclusively over the
// Utility's own TCP bus by `commands::apply_utility_presence`, which runs over
// every list this hub hands out.
//
// This used to call Envoy's `execute_python` per live session as a "rescue"
// probe. That was a category error: Envoy belongs to Embody, an optional
// third-party package most projects never have, so it can only ever answer
// questions about Embody/MCP — never "is OUR companion loaded?". Worse, the
// list poll runs every 4s, so every open session paid a synchronous Python
// call on TouchDesigner's MAIN THREAD (~30ms spikes against a 16ms frame
// budget) to re-derive a value the bus already owned and overwrote moments
// later.
//
// The cost of dropping it: an Embody project whose bus is misconfigured
// (wrong host/port, firewalled) no longer gets rescued via Envoy and simply
// reports no companion. That is a rare misconfiguration, and "no companion"
// is the honest answer when the companion's own transport cannot be reached.

#[derive(Debug, Clone)]
struct Launched {
    path: String,
    version_key: String,
    use_touchplayer: bool,
    pid: Option<u32>,
    started_at: f64,
    /// Set when the process is first observed dead (or killed via our button);
    /// keeps the row as a relaunchable tombstone instead of dropping it.
    ended_at: Option<f64>,
}

/// Claim scanned processes for launcher records that never learned a pid.
///
/// macOS launches through `open`, which reports no pid (see `td_manager`), so
/// a launcher-started session arrives pid-less — and everything downstream is
/// keyed by pid. Such a record could not follow a rename, so an Increment and
/// Save left it pinned to the launch path while the process scan listed the
/// renamed file as a SECOND row: one process, two cards, one of them pid-less
/// and unkillable.
///
/// Matching is on the scanned COMMAND LINE rather than the window title,
/// because the command line is fixed at launch and so still carries the path
/// we launched with even after TD has saved itself to a new file. Ids already
/// spoken for are skipped, so the same `.toe` opened twice claims one process
/// each instead of both records grabbing the first.
fn adopt_scanned_pids(launched: &mut [Launched], scanned: &[(u32, Option<String>)]) {
    let mut claimed: HashSet<u32> = launched.iter().filter_map(|l| l.pid).collect();
    for l in launched.iter_mut() {
        if l.pid.is_some() || l.ended_at.is_some() {
            continue;
        }
        let want = normalize_path(&l.path);
        if let Some((pid, _)) = scanned.iter().find(|(pid, cmdline)| {
            !claimed.contains(pid)
                && cmdline.as_deref().is_some_and(|c| normalize_path(c) == want)
        }) {
            l.pid = Some(*pid);
            claimed.insert(*pid);
        }
    }
}

#[derive(Default)]
pub struct OpenProjectsHub {
    launched: Vec<Launched>,
    /// `(old_path, new_path)` for sessions seen to have saved themselves to a
    /// new file since the last poll. Drained by the caller, which owns the
    /// other things keyed by project path — above all the watchdog, whose
    /// session would otherwise stop matching the utility's heartbeats.
    path_migrations: Vec<(String, String)>,
    /// Where each live process was last placed (`pid -> .toe`), from a
    /// source better than its command line. See `remember_placements`.
    placed: HashMap<u32, String>,
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn normalize_path(p: &str) -> String {
    let p = p.trim().trim_matches('"');
    let path = PathBuf::from(p);
    let abs = path
        .canonicalize()
        .unwrap_or_else(|_| path.clone());
    let s = abs.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let out = s.replace('\\', "/");
    #[cfg(windows)]
    let out = out.to_lowercase();
    out
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

pub(crate) fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        crate::proc::command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| {
                let s = String::from_utf8_lossy(&o.stdout);
                s.contains(&pid.to_string())
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
            || crate::proc::command("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
    }
}

/// Parse `.toe` path out of a TouchDesigner command line.
fn toe_from_cmdline(cmdline: &str) -> Option<String> {
    // Prefer quoted paths, then bare tokens ending in .toe
    let lower = cmdline.to_lowercase();
    if !lower.contains(".toe") {
        return None;
    }
    // "C:\foo\bar.toe" or "C:/foo/bar.toe"
    let bytes = cmdline.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            if let Some(end) = cmdline[i + 1..].find('"') {
                let inner = &cmdline[i + 1..i + 1 + end];
                if inner.to_lowercase().ends_with(".toe") {
                    return Some(inner.to_string());
                }
                i += end + 2;
                continue;
            }
        }
        i += 1;
    }
    for tok in cmdline.split_whitespace() {
        let t = tok.trim_matches('"');
        if t.to_lowercase().ends_with(".toe") {
            return Some(t.to_string());
        }
    }
    None
}

/// The `.toe` a TouchDesigner main-window title names.
///
/// TD titles its main window `TouchDesigner <build>: <path/to/project.toe>`
/// and RETITLES it whenever the open file changes — Save As, and above all
/// Increment and Save, which is a normal part of a working session. The
/// command line never changes, so after one increment the process is running
/// `Show.28.toe` while its argv still says `Show.26.toe`.
///
/// That matters beyond a cosmetic label: Utility commands are addressed BY
/// PATH (the utility answers `id mismatch` to anything else) and Relaunch
/// launches the path we recorded — so a stale path silently breaks the
/// companion bus and relaunches a file the user has moved on from.
///
/// The separator is `": "`; a Windows drive letter is `C:\` or `C:/`, never
/// colon-space, so splitting there is safe for paths containing spaces.
///
/// TD also appends `*` to the title while the project has unsaved edits — the
/// normal state of a session someone is working in. That marker has to come
/// off before the `.toe` test, or the parse fails exactly when it matters and
/// the caller quietly falls back to the command line: the same session then
/// shows up twice, once under the file it now holds and once under the file it
/// was launched with. `*` is not legal in a Windows filename, so stripping it
/// can never eat part of a real path.
fn toe_from_window_title(title: &str) -> Option<String> {
    let (_, rest) = title.split_once(": ")?;
    let rest = rest.trim().trim_end_matches('*').trim_end();
    if rest.to_lowercase().ends_with(".toe") && !rest.is_empty() {
        Some(rest.to_string())
    } else {
        None
    }
}

/// Main-window titles for live TD processes, `pid -> title`, on platforms
/// where they don't come from the window enumeration.
///
/// Windows gets these free from `session_windows::list_for_pids`. macOS has no
/// window enumeration, so the title — the only thing that tracks Increment and
/// Save — has to be asked for separately, through the same Accessibility
/// surface `focus_pid` already uses. One `osascript` for every process rather
/// than one per pid, cached, because the session list polls often.
///
/// Every failure path yields an empty map: no Accessibility permission, no
/// System Events, a TD build that names its process differently. The caller
/// then falls back to the command line, which is what it did before this
/// existed — degraded, never broken.
#[cfg(target_os = "macos")]
fn titles_by_pid() -> HashMap<u32, String> {
    const TTL_SECS: f64 = 4.0;
    static CACHE: Mutex<Option<(f64, HashMap<u32, String>)>> = Mutex::new(None);

    let now = now_secs();
    if let Ok(guard) = CACHE.lock() {
        if let Some((at, cached)) = guard.as_ref() {
            if now - at < TTL_SECS {
                return cached.clone();
            }
        }
    }
    // `unix id` is the pid. The project path lives in the MAIN window's title,
    // but `window 1` is merely the process's frontmost window — with a
    // Textport, a dialog, or a torn-off pane focused, `window 1` is that
    // window and the parse fails, silently falling back to the (stale) argv
    // path. So scan every window of the process and keep the first whose name
    // ends in `.toe` (`.toe*` while dirty) — that is the main window whatever
    // is stacked in front of it. `window 1` stays as the fallback for odd
    // titles so behavior degrades to the old one, never below it.
    //
    // Matched on the "Touch" prefix rather than an exact name: the macOS app
    // bundle carries its version ("TouchDesigner 4.app" — see the comment on
    // the non-Windows branch of `scan_td_processes`), so an exact match would
    // quietly find nothing. Being loose here is safe because the caller keeps
    // only pids it already knows are TouchDesigner processes.
    //
    // Intermittent by nature, not just by permission: System Events lists
    // only the windows on the ACTIVE Space, so a TD parked on another desktop
    // (or fullscreen on its own) reports zero windows and drops out of this
    // map until the user switches back — observed on macOS 26, the same
    // process answering with its title one minute and with nothing the next.
    // The caller therefore remembers where each pid was last placed
    // (`remember_placements`) rather than letting a row exist only while its
    // window happens to be on-screen.
    const SCRIPT: &str = r#"tell application "System Events"
set out to ""
repeat with p in (every process whose name starts with "Touch")
try
set best to ""
repeat with w in (every window of p)
try
set t to name of w
if t ends with ".toe" or t ends with ".toe*" then
set best to t
exit repeat
end if
end try
end repeat
if best is "" then set best to name of window 1 of p
set out to out & (unix id of p) & tab & best & linefeed
end try
end repeat
return out
end tell"#;
    let mut map = HashMap::new();
    if let Ok(out) = crate::proc::command("osascript").args(["-e", SCRIPT]).output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some((pid, title)) = line.split_once('\t') {
                    if let Ok(pid) = pid.trim().parse::<u32>() {
                        map.insert(pid, title.trim().to_string());
                    }
                }
            }
        }
    }
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((now, map.clone()));
    }
    map
}

#[cfg(not(target_os = "macos"))]
fn titles_by_pid() -> HashMap<u32, String> {
    HashMap::new()
}

/// Every live TD / TouchPlayer process, with the `.toe` from its command line
/// when it has one. A process without one is NOT dropped: it is the caller's
/// job to place it by window title or companion hello (see
/// `resolve_scanned_paths`), and only a process with no source at all is
/// left out.
///
/// In-process via sysinfo (process APIs, no WMI, no child process). This
/// used to be a `powershell … Get-CimInstance Win32_Process` spawn waited on
/// with a plain `.output()`: while WMI was stalled (observed right after a
/// hung TD was killed) that child never exited, the wait never returned, and
/// because the scan runs under the `open` lock every session route in the
/// app — desktop and control server alike — froze behind it. The CIM scan
/// survives only as a bounded fallback for processes whose command line the
/// process APIs won't hand us (an elevated TD).
#[cfg(windows)]
fn scan_td_processes() -> Vec<(u32, Option<String>)> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let td_pids: Vec<sysinfo::Pid> = sys
        .processes()
        .iter()
        .filter(|(_, p)| {
            let name = p.name().to_string_lossy().to_ascii_lowercase();
            name == "touchdesigner.exe" || name == "touchplayer.exe"
        })
        .map(|(pid, _)| *pid)
        .collect();
    if td_pids.is_empty() {
        return vec![];
    }
    // Command lines only for the TD pids — opening every process on the
    // machine for its PEB is the expensive part.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&td_pids),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let mut rows: Vec<(u32, Option<String>)> = Vec::new();
    let mut unreadable: Vec<u32> = Vec::new();
    for pid in &td_pids {
        let Some(p) = sys.process(*pid) else {
            continue;
        };
        let args = p.cmd();
        if args.is_empty() {
            // No command line for us (elevated / protected process).
            unreadable.push(pid.as_u32());
            continue;
        }
        // Already split into argv — a path with spaces is one arg, so match
        // the whole arg rather than re-tokenising it.
        let toe = args.iter().skip(1).find_map(|a| {
            let s = a.to_string_lossy();
            let t = s.trim().trim_matches('"');
            t.to_lowercase().ends_with(".toe").then(|| t.to_string())
        });
        rows.push((pid.as_u32(), toe));
    }
    if !unreadable.is_empty() {
        let cim = scan_td_processes_cim();
        for pid in unreadable {
            // CIM may still hand us the command line; if not, the process
            // stays in the scan pathless so its window title can place it.
            let toe = cim.iter().find(|(p, _)| *p == pid).map(|(_, t)| t.clone());
            rows.push((pid, toe));
        }
    }
    rows
}

/// The PowerShell/CIM scan, bounded: WMI can stall, and a scan that never
/// returns is worse than one that returns nothing.
#[cfg(windows)]
fn scan_td_processes_cim() -> Vec<(u32, String)> {
    let mut cmd = crate::proc::command("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name = 'TouchDesigner.exe' OR Name = 'TouchPlayer.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    let Ok(out) = crate::proc::output_with_timeout(cmd, Duration::from_secs(8)) else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.is_empty() || text == "null" {
        return vec![];
    }
    let mut rows: Vec<(u32, String)> = Vec::new();
    let parse_one = |v: &serde_json::Value, rows: &mut Vec<(u32, String)>| {
        let pid = v
            .get("ProcessId")
            .and_then(|p| p.as_u64())
            .or_else(|| v.get("ProcessId").and_then(|p| p.as_i64()).map(|i| i as u64));
        let cmd = v
            .get("CommandLine")
            .and_then(|c| c.as_str())
            .unwrap_or("");
        if let (Some(pid), Some(toe)) = (pid, toe_from_cmdline(cmd)) {
            rows.push((pid as u32, toe));
        }
    };
    if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(text) {
        for v in arr {
            parse_one(&v, &mut rows);
        }
    } else if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        parse_one(&v, &mut rows);
    }
    rows
}

#[cfg(not(windows))]
fn scan_td_processes() -> Vec<(u32, Option<String>)> {
    // `comm=` alone (no args) is unambiguous even though app bundle paths
    // contain spaces ("TouchDesigner 4.app") — the whole remainder of the
    // line after the numeric PID is the executable path, nothing else.
    let Ok(out) = crate::proc::command("ps").args(["-axo", "pid=,comm="]).output() else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows: Vec<(u32, Option<String>)> = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        let Some(sp) = line.find(char::is_whitespace) else {
            continue;
        };
        let (pid_str, rest) = line.split_at(sp);
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        let exe_name = Path::new(rest.trim())
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if exe_name != "TouchDesigner" && exe_name != "TouchPlayer" {
            continue;
        }
        // Separate call for the full command line: keeps column parsing
        // unambiguous (`args=` is the only field, however many spaces it holds).
        //
        // A `.toe` on the command line is the exception on macOS, not the
        // rule: a TD started from Finder, the Dock, or File > Open receives
        // its document through an Apple Event, and its argv names only the
        // executable. Only this launcher's own `open --args` launches carry
        // the path. Such a process still belongs in the scan — pathless — so
        // the caller can place it by window title or companion hello.
        // Dropping it here, which is what used to happen, made every TD not
        // started from here invisible on the Current tab.
        let toe = crate::proc::command("ps")
            .args(["-p", &pid.to_string(), "-o", "args="])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| toe_from_cmdline(String::from_utf8_lossy(&o.stdout).trim()));
        rows.push((pid, toe));
    }
    rows
}

/// Fold the companion's own reports into the scan.
///
/// A Utility that hellos from inside TD names its process id and the project
/// it is running (from the live `project.name`, so current across renames).
/// That is a discovery source in its own right, not just a presence flag: a
/// process the scan missed altogether — the executable named unexpectedly,
/// `ps` failing — joins it here, provided it is actually alive, and every
/// reported pid's path comes back for the caller to fill in wherever the
/// window title left a process pathless. The title stays authoritative when
/// it resolved; this fills gaps, it never overrides.
fn merge_peer_hints(
    scanned: &mut Vec<(u32, Option<String>)>,
    peers: &[(u32, String)],
    alive: impl Fn(u32) -> bool,
) -> HashMap<u32, String> {
    let mut paths = HashMap::new();
    for (pid, path) in peers {
        if path.trim().is_empty() {
            continue;
        }
        if !scanned.iter().any(|(p, _)| p == pid) {
            if !alive(*pid) {
                continue;
            }
            scanned.push((*pid, None));
        }
        paths.entry(*pid).or_insert_with(|| path.clone());
    }
    paths
}

/// Keep a process placed once it has been placed.
///
/// The title read is intermittent on macOS — System Events lists only the
/// windows on the active Space, so a TD on another desktop reports none —
/// and the companion's report stops with the companion. A process whose
/// only path source is one of those would appear and vanish with the user's
/// Space switches. So every resolution is remembered per pid while the
/// process lives, and fills in whenever the live sources come back empty.
/// Live sources still win when they answer (the remembered path is at worst
/// one Increment and Save behind; argv is behind forever), and a pid that
/// left the scan is forgotten, so a reused pid can never inherit a path.
fn remember_placements(
    placed: &mut HashMap<u32, String>,
    scanned: &[(u32, Option<String>)],
    current_by_pid: &mut HashMap<u32, String>,
) {
    placed.retain(|pid, _| scanned.iter().any(|(p, _)| p == pid));
    for (pid, path) in current_by_pid.iter() {
        placed.insert(*pid, path.clone());
    }
    for (pid, path) in placed.iter() {
        current_by_pid.entry(*pid).or_insert_with(|| path.clone());
    }
}

/// The `.toe` each scanned process is running: window title or companion
/// report (`current_by_pid`) first, command line as the fallback — the
/// title tracks Increment and Save, argv never moves.
///
/// A process with neither has nothing to key a row on and is left out of
/// this poll — logged once per appearance rather than every 2s, because on
/// macOS that is the exact signature of a Finder/Dock-started TD whose title
/// we may not read (Automation consent for System Events withheld). The
/// fixes are granting that consent, or dropping the companion into the
/// session so it reports itself.
fn resolve_scanned_paths(
    scanned: Vec<(u32, Option<String>)>,
    current_by_pid: &HashMap<u32, String>,
) -> Vec<(u32, String)> {
    static REPORTED: Mutex<Option<HashSet<u32>>> = Mutex::new(None);
    let mut rows = Vec::with_capacity(scanned.len());
    let mut unresolved: Vec<u32> = Vec::new();
    for (pid, cmdline) in scanned {
        match current_by_pid.get(&pid).cloned().or(cmdline) {
            Some(toe) => rows.push((pid, toe)),
            None => unresolved.push(pid),
        }
    }
    if let Ok(mut guard) = REPORTED.lock() {
        let seen = guard.get_or_insert_with(HashSet::new);
        // A pid that resolved (or exited) is forgotten, so it logs again if
        // it ever goes dark a second time.
        seen.retain(|p| unresolved.contains(p));
        for pid in unresolved {
            if seen.insert(pid) {
                log::warn!(
                    "session scan: TouchDesigner pid {pid} has no .toe on its command line and \
                     no readable window title; it stays off the Current tab until a title can \
                     be read (macOS: allow Automation for System Events) or a TDXLauncherUtility \
                     hellos from inside it"
                );
            }
        }
    }
    rows
}

fn envoy_port_for_toe(toe_path: &str) -> Option<u16> {
    let start = PathBuf::from(toe_path);
    let mut cur = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start
    };
    for _ in 0..8 {
        let envoy = cur.join(".embody").join("envoy.json");
        if envoy.is_file() {
            let text = std::fs::read_to_string(&envoy).ok()?;
            let v: serde_json::Value = serde_json::from_str(&text).ok()?;
            let instances = v.get("instances")?.as_object()?;
            let toe_norm = normalize_path(toe_path);
            // Prefer instance whose toe_path matches this project
            for inst in instances.values() {
                if let Some(tp) = inst.get("toe_path").and_then(|t| t.as_str()) {
                    let resolved = if Path::new(tp).is_absolute() {
                        PathBuf::from(tp)
                    } else {
                        cur.join(tp)
                    };
                    if normalize_path(&resolved.to_string_lossy()) == toe_norm {
                        return inst.get("port").and_then(|p| p.as_u64()).map(|p| p as u16);
                    }
                }
            }
            let active = v.get("active").and_then(|a| a.as_str());
            let inst = active
                .and_then(|a| instances.get(a))
                .or_else(|| instances.values().next())?;
            return inst.get("port").and_then(|p| p.as_u64()).map(|p| p as u16);
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

/// Bound how long we'll wait on the OS to confirm termination. A process
/// wedged in a kernel-mode wait (GPU driver TDR, hung device I/O) can resist
/// even a forceful kill indefinitely — see `proc::output_with_timeout`.
const KILL_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) fn kill_pid(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Err("Invalid PID".into());
    }
    let not_responding = || {
        format!(
            "PID {pid} did not respond to termination within {:.0}s — it may be stuck \
             (e.g. a GPU driver hang). Give it a few seconds and try again, or end it \
             from Task Manager.",
            KILL_TIMEOUT.as_secs_f64()
        )
    };
    #[cfg(windows)]
    {
        let mut cmd = crate::proc::command("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let out = crate::proc::output_with_timeout(cmd, KILL_TIMEOUT).map_err(|_| not_responding())?;
        // 128 = process not found - treat as success (already gone)
        if out.status.success() || out.status.code() == Some(128) {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        Err(if err.trim().is_empty() {
            format!("taskkill failed for PID {pid}")
        } else {
            err.trim().to_string()
        })
    }
    #[cfg(not(windows))]
    {
        let mut cmd = crate::proc::command("kill");
        cmd.args(["-9", &pid.to_string()]);
        let out = crate::proc::output_with_timeout(cmd, KILL_TIMEOUT).map_err(|_| not_responding())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("kill failed for PID {pid}"))
        }
    }
}

/// The `.toe` a live TD `pid` has open — used at kill time to tombstone a
/// session the launcher never tracked. Must be called while the process is
/// still alive (before the kill). Same sources as the list, same order:
/// window title first (it follows Increment and Save), command line after.
pub fn toe_for_pid(pid: u32) -> Option<String> {
    let (_, cmdline) = scan_td_processes().into_iter().find(|(p, _)| *p == pid)?;
    crate::session_windows::list_for_pids(&[pid])
        .iter()
        .find_map(|w| toe_from_window_title(&w.title))
        .or_else(|| titles_by_pid().get(&pid).and_then(|t| toe_from_window_title(t)))
        .or(cmdline)
}

/// Bring the main visible window of `pid` to the foreground.
///
/// On Windows this runs in-process on purpose: `SetForegroundWindow` is only
/// granted to the foreground *process*, which the launcher is when the user
/// clicks Focus. The previous PowerShell helper was a separate process and so
/// was refused whenever Windows enforced that rule.
pub fn focus_pid(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Err("Invalid PID".into());
    }
    #[cfg(windows)]
    {
        let hwnd = crate::session_windows::main_window_for_pid(pid)
            .ok_or_else(|| format!("No window for PID {pid}"))?;
        crate::session_windows::focus(hwnd)
    }
    #[cfg(target_os = "macos")]
    {
        // The focus command runs on the main thread, and osascript can sit on
        // an Automation permission prompt: run it on its own thread and give
        // up waiting (not the focus itself) after a moment.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let out = crate::proc::command("osascript")
                .args([
                    "-e",
                    &format!(
                        "tell application \"System Events\" to set frontmost of first process whose unix id is {pid} to true"
                    ),
                ])
                .output();
            let _ = tx.send(out);
        });
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(Ok(out)) if out.status.success() => Ok(()),
            Ok(Ok(_)) => Err(format!("Could not focus PID {pid}")),
            Ok(Err(e)) => Err(e.to_string()),
            // Still running (a permission prompt is the usual reason); it
            // lands on its own when the prompt is answered.
            Err(_) => Ok(()),
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = pid;
        Err("Focus window is not supported on this platform".into())
    }
}

/// Order a project's instances (launcher-started first, then ascending PID)
/// and adopt the first as the row's primary.
///
/// The process scan's order is not stable across polls, so without this the
/// primary — and Focus / Kill / perf, which all key off it — could hop between
/// two live instances from one refresh to the next.
fn settle_instances(p: &mut OpenProject) {
    p.instances.sort_by(|a, b| {
        (a.source != "launcher")
            .cmp(&(b.source != "launcher"))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    if let Some(first) = p.instances.first() {
        p.pid = Some(first.pid);
    }
}

impl OpenProjectsHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_launch(
        &mut self,
        path: &str,
        version_key: &str,
        use_touchplayer: bool,
        pid: Option<u32>,
    ) {
        if path.is_empty() || path == crate::td_manager::DEFAULT_TEMPLATE {
            return;
        }
        let norm = normalize_path(path);
        // A relaunch of the same project replaces any prior entry, live or a
        // tombstone — so relaunching a stale row makes it live again.
        self.launched.retain(|l| normalize_path(&l.path) != norm);
        self.launched.push(Launched {
            path: path.replace('\\', "/"),
            version_key: version_key.to_string(),
            use_touchplayer,
            pid,
            started_at: now_secs(),
            ended_at: None,
        });
    }

    /// Mark a session ended (kept as a stale, relaunchable tombstone) rather
    /// than forgetting it — used when the user kills it via the launcher so an
    /// accidental kill can be undone with Relaunch.
    pub fn mark_ended_pid(&mut self, pid: u32) {
        let now = now_secs();
        for l in &mut self.launched {
            if l.pid == Some(pid) && l.ended_at.is_none() {
                l.ended_at = Some(now);
            }
        }
    }

    /// Launch facts the launcher recorded for a live pid: `(path, version_key,
    /// use_touchplayer)`. `None` for a session it didn't start (process-scan).
    pub fn launched_info(&self, pid: u32) -> Option<(String, String, bool)> {
        self.launched
            .iter()
            .find(|l| l.pid == Some(pid))
            .map(|l| (l.path.clone(), l.version_key.clone(), l.use_touchplayer))
    }

    /// Ensure a killed session leaves a relaunchable tombstone — mark an
    /// existing launcher entry ended, or record a fresh tombstone for a
    /// session the launcher never tracked (opened externally, or discovered
    /// after a launcher restart). `version_key` may be empty if the build
    /// couldn't be resolved; relaunch re-derives it from the `.toe` then.
    pub fn ensure_tombstone(&mut self, pid: u32, path: &str, version_key: &str, use_touchplayer: bool) {
        let now = now_secs();
        if let Some(l) = self.launched.iter_mut().find(|l| l.pid == Some(pid)) {
            if l.ended_at.is_none() {
                l.ended_at = Some(now);
            }
            return;
        }
        let norm = normalize_path(path);
        self.launched.retain(|l| normalize_path(&l.path) != norm);
        self.launched.push(Launched {
            path: path.replace('\\', "/"),
            version_key: version_key.to_string(),
            use_touchplayer,
            pid: Some(pid),
            started_at: now,
            ended_at: Some(now),
        });
    }

    /// Sessions that have saved themselves to a new file since the last call,
    /// as `(old_path, new_path)`. Consumed once — call after `list()`.
    pub fn take_path_migrations(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.path_migrations)
    }

    /// Permanently drop a session by project path (the stale-row Dismiss ×).
    pub fn forget_path(&mut self, path: &str) {
        let norm = normalize_path(path);
        self.launched.retain(|l| normalize_path(&l.path) != norm);
    }

    /// Cheap pid lookup for the utility-verb hot path.
    ///
    /// Reads the records the last real `list()` built instead of re-running
    /// the process scan — on Windows that scan spawns a PowerShell/CIM query
    /// costing ~half a second, which used to sit between hitting Enter on a
    /// quick-launch command and the ~17ms bus call actually running it.
    ///
    /// Freshness is the UI's own 4s list poll (plus the summon-time refresh
    /// in the quick palette), and the pid is only the rename-proof FALLBACK
    /// for peer matching (`invoke_utility_ex` matches the live hello peer by
    /// path first, and the utility refuses a mis-addressed id) — so a
    /// slightly stale or missing pid degrades routing gracefully, never
    /// mis-targets.
    pub fn known_pid_for_path(&self, path: &str) -> Option<u32> {
        let norm = normalize_path(path);
        self.launched
            .iter()
            .find(|l| l.ended_at.is_none() && normalize_path(&l.path) == norm)
            .and_then(|l| l.pid)
    }

    /// `peers` are the live companion reports — `(TD pid, project path)` from
    /// `WatchManager::live_utility_peers` — folded in as a discovery source
    /// (see `merge_peer_hints`). Every caller that can reach the watch manager
    /// should pass them (`commands::utility_peer_hints`), or a session only
    /// the companion knows about drops out of that caller's view of the list.
    pub fn list_with_peers(&mut self, peers: &[(u32, String)]) -> Vec<OpenProject> {
        let now = now_secs();
        // macOS `open` often yields no PID - keep those briefly so the tab isn't empty
        const UNKNOWN_PID_TTL_SECS: f64 = 7200.0;
        // How many stale (ended) sessions to keep as relaunchable tombstones.
        const MAX_ENDED: usize = 15;

        let is_alive = |l: &Launched| match l.pid {
            Some(pid) => pid_alive(pid),
            None => now - l.started_at < UNKNOWN_PID_TTL_SECS,
        };

        // Stamp ended_at the first time a launched session is seen dead — the
        // row then persists as a stale tombstone instead of being dropped.
        for l in &mut self.launched {
            if l.ended_at.is_none() && !is_alive(l) {
                l.ended_at = Some(now);
            }
        }
        // Bound the tombstone set: keep the most-recently-ended, drop the rest.
        let mut ended_times: Vec<f64> = self.launched.iter().filter_map(|l| l.ended_at).collect();
        if ended_times.len() > MAX_ENDED {
            ended_times.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            let cutoff = ended_times[MAX_ENDED - 1];
            self.launched
                .retain(|l| l.ended_at.map(|t| t >= cutoff).unwrap_or(true));
        }

        // One process scan + one window pass, up front: the window titles tell
        // us which file each process ACTUALLY has open (see
        // `toe_from_window_title`), which the command line cannot after an
        // Increment and Save. Everything below keys off the corrected path.
        let mut scanned = scan_td_processes();
        let peer_paths = merge_peer_hints(&mut scanned, peers, pid_alive);
        let mut win_pids: Vec<u32> = scanned.iter().map(|(pid, _)| *pid).collect();
        for l in &self.launched {
            // A launched session whose cmdline we couldn't parse still owns
            // windows worth enumerating.
            if let Some(pid) = l.pid {
                if l.ended_at.is_none() && is_alive(l) && !win_pids.contains(&pid) {
                    win_pids.push(pid);
                }
            }
        }
        let mut all_windows = if win_pids.is_empty() {
            Vec::new()
        } else {
            crate::session_windows::list_for_pids(&win_pids)
        };
        let mut current_by_pid: HashMap<u32, String> = all_windows
            .iter()
            .filter_map(|w| toe_from_window_title(&w.title).map(|toe| (w.pid, toe)))
            .collect();
        // Platforms without window enumeration ask for the titles directly.
        // Only for pids we don't already have, so Windows never pays for it.
        if win_pids.iter().any(|pid| !current_by_pid.contains_key(pid)) {
            for (pid, title) in titles_by_pid() {
                if win_pids.contains(&pid) && !current_by_pid.contains_key(&pid) {
                    if let Some(toe) = toe_from_window_title(&title) {
                        current_by_pid.insert(pid, toe);
                    }
                }
            }
        }
        // The companion's own report fills whatever the title read left
        // pathless — the permission-free source, and the only one for a
        // Finder-started TD on a Mac that never granted Automation consent.
        for (pid, path) in peer_paths {
            current_by_pid.entry(pid).or_insert(path);
        }
        remember_placements(&mut self.placed, &scanned, &mut current_by_pid);

        adopt_scanned_pids(&mut self.launched, &scanned);

        // Follow the increment: a session that saved itself to a new file is
        // still the same session, so re-point our record at the file it now
        // holds rather than leaving a row (and a Relaunch) aimed at the old one.
        for l in &mut self.launched {
            if l.ended_at.is_some() {
                continue; // a tombstone is a record of what ended; leave it be
            }
            if let Some(pid) = l.pid {
                if let Some(current) = current_by_pid.get(&pid) {
                    if normalize_path(current) != normalize_path(&l.path) {
                        let old = std::mem::replace(&mut l.path, current.replace('\\', "/"));
                        self.path_migrations.push((old, l.path.clone()));
                    }
                }
            }
        }

        let mut by_path: HashMap<String, OpenProject> = HashMap::new();

        for l in &self.launched {
            let key = normalize_path(&l.path);
            // A tombstone (ended_at set) is stale immediately and stays stale —
            // never re-derived from the process, so a kill yields a relaunchable
            // row at once instead of racing `pid_alive` after termination.
            let alive = l.ended_at.is_none() && is_alive(l);
            // Dead sessions have no live Envoy to reach — skip the TCP check
            // and just carry the relaunch facts.
            let (envoy_port, envoy_up) = if alive {
                with_envoy(envoy_port_for_toe(&l.path))
            } else {
                (None, None)
            };
            // Seed the instance list with the process we started, when it's
            // still ours to claim. A dead PID contributes nothing — the scan
            // below adds whatever is actually running at this path.
            let instances = match (alive, l.pid) {
                (true, Some(pid)) => vec![SessionInstance {
                    pid,
                    source: "launcher".into(),
                    started_at: Some(l.started_at),
                    windows: Vec::new(),
                }],
                _ => Vec::new(),
            };
            by_path.insert(
                key.clone(),
                OpenProject {
                    id: key,
                    path: l.path.clone(),
                    display_name: display_name(&l.path),
                    pid: l.pid,
                    alive,
                    version_key: Some(l.version_key.clone()),
                    use_touchplayer: l.use_touchplayer,
                    envoy_port,
                    envoy_up,
                    mcp_available: mcp_available_for_toe(&l.path),
                    // Filled in by `commands::apply_utility_presence` (TCP bus).
                    utility_available: None,
                    utility_version: None,
                    companion_silent_secs: None,
                    source: "launcher".into(),
                    started_at: Some(l.started_at),
                    ended_at: l.ended_at,
                    windows: Vec::new(),
                    instances,
                },
            );
        }

        for (pid, toe) in resolve_scanned_paths(scanned, &current_by_pid) {
            let key = normalize_path(&toe);
            let display_path = toe.replace('\\', "/");
            if let Some(existing) = by_path.get_mut(&key) {
                existing.alive = true;
                // Same project reopened externally — it's no longer a tombstone.
                existing.ended_at = None;
                // A second process on a path we already know is a real second
                // instance, not a duplicate reading — record it rather than
                // overwriting the first (which is what used to happen, leaving
                // one of the two invisible and unkillable from here).
                if !existing.instances.iter().any(|i| i.pid == pid) {
                    existing.instances.push(SessionInstance {
                        pid,
                        source: "process".into(),
                        started_at: None,
                        windows: Vec::new(),
                    });
                }
                if existing.source != "launcher" {
                    existing.source = "process".into();
                }
                if existing.envoy_port.is_none() {
                    let (port, up) = with_envoy(envoy_port_for_toe(&display_path));
                    existing.envoy_port = port;
                    existing.envoy_up = up;
                }
                if !existing.mcp_available {
                    existing.mcp_available = mcp_available_for_toe(&display_path);
                }
            } else {
                let (envoy_port, envoy_up) = with_envoy(envoy_port_for_toe(&display_path));
                let mcp_available = mcp_available_for_toe(&display_path);
                by_path.insert(
                    key.clone(),
                    OpenProject {
                        id: key,
                        path: display_path.clone(),
                        display_name: display_name(&display_path),
                        pid: Some(pid),
                        alive: true,
                        version_key: None,
                        use_touchplayer: false,
                        envoy_port,
                        envoy_up,
                        mcp_available,
                        // Filled in by `commands::apply_utility_presence`.
                        utility_available: None,
                        utility_version: None,
                        companion_silent_secs: None,
                        source: "process".into(),
                        started_at: None,
                        ended_at: None,
                        windows: Vec::new(),
                        instances: vec![SessionInstance {
                            pid,
                            source: "process".into(),
                            started_at: None,
                            windows: Vec::new(),
                        }],
                    },
                );
            }
        }

        // Settle each project's instance order, then its primary PID. Scan
        // order is not stable across polls, so without this the row's PID (and
        // everything keyed off it — Focus, Kill, perf) could hop between two
        // live instances from one refresh to the next.
        for p in by_path.values_mut() {
            settle_instances(p);
        }

        // Keep live sessions and launcher tombstones (stale rows); dead
        // external processes never reach here (the scan only yields live pids).
        let mut list: Vec<OpenProject> =
            by_path.into_values().filter(|p| p.alive || p.ended_at.is_some()).collect();

        // One ended row per project FAMILY, and none while it runs again.
        // Forget the superseded records outright, or they would resurface the
        // moment the live session ends.
        let superseded = supersede_family_tombstones(&mut list);
        if !superseded.is_empty() {
            self.launched.retain(|l| {
                l.ended_at.is_none() || !superseded.contains(&normalize_path(&l.path))
            });
        }

        // Hand out the windows from the single pass above — every LIVE instance
        // (tombstones own none), not just each project's primary, so a second
        // instance's windows are reachable instead of missing from the switcher.
        if !all_windows.is_empty() {
            for p in &mut list {
                if !p.alive {
                    continue;
                }
                for inst in &mut p.instances {
                    let (mine, rest): (Vec<_>, Vec<_>) =
                        all_windows.into_iter().partition(|w| w.pid == inst.pid);
                    inst.windows = mine;
                    all_windows = rest;
                }
                // Project-level view: every window, primary instance's first.
                p.windows = p.instances.iter().flat_map(|i| i.windows.clone()).collect();
            }
        }

        // Live first, then stale (most-recently-ended on top within each group).
        list.sort_by(|a, b| {
            b.alive.cmp(&a.alive).then_with(|| {
                let ak = a.ended_at.or(a.started_at);
                let bk = b.ended_at.or(b.started_at);
                bk.partial_cmp(&ak)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.display_name.cmp(&b.display_name))
            })
        });
        list
    }
}

/// Collapse ended rows by project family (`Show.toe`, `Show.125.toe`, ... —
/// the Increment-and-Save suffix stripped, see `watch::family_key`).
///
/// Closing TD and reopening the newest increment between saves used to leave
/// one ended row per increment closed (`Show ·125`, `Show ·126`, ...) beside
/// the live `Show ·130` — the same project, listed as if it were several. An
/// ended row only means "you can pick this back up", so:
/// - while any session of the family is LIVE, its ended rows go;
/// - otherwise the family keeps only its most recently ended row.
///
/// Relaunch targets the family head anyway (the frontend's `relaunchPathFor`),
/// so no dropped row was the way back to anything. Different folders are
/// different families; a `Backup/` copy or a `CrashAutoSave.` file is its own.
/// Returns the ids (normalized paths) of the rows removed.
fn supersede_family_tombstones(list: &mut Vec<OpenProject>) -> Vec<String> {
    use std::collections::HashSet;
    let family = |p: &OpenProject| crate::watch::family_key(&p.id);
    let live: HashSet<String> = list.iter().filter(|p| p.alive).map(family).collect();
    let mut newest: HashMap<String, (f64, String)> = HashMap::new();
    for p in list.iter().filter(|p| !p.alive) {
        let t = p.ended_at.unwrap_or(0.0);
        let entry = newest.entry(family(p)).or_insert((f64::MIN, String::new()));
        if t > entry.0 {
            *entry = (t, p.id.clone());
        }
    }
    let mut dropped = Vec::new();
    list.retain(|p| {
        if p.alive {
            return true;
        }
        let fam = family(p);
        let keep = !live.contains(&fam) && newest.get(&fam).is_some_and(|(_, id)| *id == p.id);
        if !keep {
            dropped.push(p.id.clone());
        }
        keep
    });
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, alive: bool, ended_at: Option<f64>) -> OpenProject {
        OpenProject {
            id: id.into(),
            path: id.into(),
            display_name: id.rsplit('/').next().unwrap_or(id).into(),
            pid: None,
            alive,
            version_key: None,
            use_touchplayer: false,
            envoy_port: None,
            envoy_up: None,
            mcp_available: false,
            utility_available: None,
            utility_version: None,
            companion_silent_secs: None,
            source: "process".into(),
            started_at: Some(0.0),
            ended_at,
            windows: Vec::new(),
            instances: Vec::new(),
        }
    }

    fn ids(list: &[OpenProject]) -> Vec<&str> {
        let mut v: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
        v.sort();
        v
    }

    /// The reported case: closed and reopened the newest increment between
    /// saves, and every closed increment stayed behind as its own ended row.
    #[test]
    fn a_live_family_member_supersedes_its_ended_rows() {
        let mut list = vec![
            row("c:/p/sprind.130.toe", true, None),
            row("c:/p/sprind.126.toe", false, Some(20.0)),
            row("c:/p/sprind.125.toe", false, Some(10.0)),
            row("c:/q/testttt.4.toe", false, Some(30.0)),
        ];
        let dropped = supersede_family_tombstones(&mut list);
        assert_eq!(ids(&list), vec!["c:/p/sprind.130.toe", "c:/q/testttt.4.toe"]);
        assert_eq!(dropped.len(), 2);
    }

    #[test]
    fn with_nothing_live_a_family_keeps_its_latest_ended_row() {
        let mut list = vec![
            row("c:/p/show.125.toe", false, Some(10.0)),
            row("c:/p/show.toe", false, Some(40.0)),
            row("c:/p/show.126.toe", false, Some(20.0)),
        ];
        supersede_family_tombstones(&mut list);
        assert_eq!(ids(&list), vec!["c:/p/show.toe"]);
    }

    #[test]
    fn other_folders_and_crash_files_are_other_families() {
        let mut list = vec![
            row("c:/p/show.130.toe", true, None),
            row("c:/p/backup/show.31.toe", false, Some(10.0)),
            row("c:/p/crashautosave.show.toe", false, Some(11.0)),
            row("c:/other/show.12.toe", false, Some(12.0)),
        ];
        let dropped = supersede_family_tombstones(&mut list);
        assert!(dropped.is_empty(), "{dropped:?}");
        assert_eq!(list.len(), 4);
    }

    #[test]
    fn two_live_increments_are_both_kept() {
        // Running .125 and .130 side by side on purpose: live rows never go.
        let mut list = vec![
            row("c:/p/show.130.toe", true, None),
            row("c:/p/show.125.toe", true, None),
        ];
        assert!(supersede_family_tombstones(&mut list).is_empty());
        assert_eq!(list.len(), 2);
    }

    /// A launcher-started session that's killed keeps its recorded build and
    /// becomes a tombstone (ensure_tombstone marks the existing entry ended).
    #[test]
    fn kill_of_launched_session_marks_ended_in_place() {
        let mut hub = OpenProjectsHub::new();
        hub.register_launch("C:/proj/Show.toe", "TouchDesigner.2025.30060", false, Some(4321));
        assert_eq!(
            hub.launched_info(4321),
            Some(("C:/proj/Show.toe".into(), "TouchDesigner.2025.30060".into(), false))
        );
        hub.ensure_tombstone(4321, "C:/proj/Show.toe", "TouchDesigner.2025.30060", false);
        // One entry, now a tombstone that still knows its build.
        assert_eq!(hub.launched.len(), 1);
        assert!(hub.launched[0].ended_at.is_some());
        assert_eq!(hub.launched[0].version_key, "TouchDesigner.2025.30060");
    }

    /// The regression: killing a session the launcher never tracked (opened
    /// externally / discovered after restart) must still leave a relaunchable
    /// tombstone rather than vanishing.
    #[test]
    fn kill_of_untracked_session_creates_a_tombstone() {
        let mut hub = OpenProjectsHub::new();
        assert!(hub.launched_info(999).is_none());
        hub.ensure_tombstone(999, "C:/proj/External.toe", "TouchDesigner.2025.32050", false);
        assert_eq!(hub.launched.len(), 1);
        let t = &hub.launched[0];
        assert!(t.ended_at.is_some(), "recorded as a tombstone");
        assert_eq!(t.pid, Some(999));
        assert_eq!(t.version_key, "TouchDesigner.2025.32050");
    }

    /// The reported bug: TD is retitled by Increment and Save, the command
    /// line is not, and the gap only widens. Every string below is verbatim
    /// from one live process, observed across two increments — argv still said
    /// TDXLPP.toe while the window had already moved .1 -> .2.
    #[test]
    fn window_title_reports_the_incremented_file() {
        for (title, expected) in [
            (
                "TouchDesigner 2025.33070: C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.1.toe",
                "C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.1.toe",
            ),
            (
                "TouchDesigner 2025.33070: C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.2.toe",
                "C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.2.toe",
            ),
        ] {
            assert_eq!(toe_from_window_title(title).as_deref(), Some(expected));
        }
        let cmdline = r#""C:\Program Files\Derivative\TouchDesigner.2025.33070\bin\TouchDesigner.exe" C:\VJ\TD\Projects\TDXLPP\utility\TDXLPP.toe"#;
        assert_eq!(
            toe_from_cmdline(cmdline).as_deref(),
            Some(r"C:\VJ\TD\Projects\TDXLPP\utility\TDXLPP.toe"),
            "the command line keeps naming the file the session STARTED with"
        );
    }

    /// TD marks unsaved edits with a trailing `*`. Left in, the title stops
    /// ending in `.toe`, the parse fails, and the caller falls back to the
    /// command line — so the moment you touch an incremented project it
    /// reappears in the list a second time under its pre-increment name, on
    /// the same MCP port as the row that is already there.
    #[test]
    fn window_title_survives_the_unsaved_changes_marker() {
        for title in [
            "TouchDesigner 2025.33070: C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.8.toe *",
            "TouchDesigner 2025.33070: C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.8.toe*",
        ] {
            assert_eq!(
                toe_from_window_title(title).as_deref(),
                Some("C:/VJ/TD/Projects/TDXLPP/utility/TDXLPP.8.toe"),
                "{title}"
            );
        }
    }

    /// A drive letter is `C:\` / `C:/`, never colon-space, so a project path
    /// with spaces in it survives the split.
    #[test]
    fn window_title_handles_paths_with_spaces() {
        let title = "TouchPlayer 2025.30060: D:/Shows/Big Show 2026/Main.28.toe";
        assert_eq!(
            toe_from_window_title(title).as_deref(),
            Some("D:/Shows/Big Show 2026/Main.28.toe")
        );
    }

    /// Torn-off pane and dialog windows must not be mistaken for the main one.
    #[test]
    fn window_title_ignores_non_project_windows() {
        assert_eq!(toe_from_window_title("pane2"), None);
        assert_eq!(toe_from_window_title("TouchDesigner 2025.33070"), None);
        assert_eq!(toe_from_window_title("Textport and DATs"), None);
        assert_eq!(toe_from_window_title("Export Movie: out1"), None);
    }

    fn inst(pid: u32, source: &str) -> SessionInstance {
        SessionInstance { pid, source: source.into(), started_at: None, windows: Vec::new() }
    }

    fn project_with(instances: Vec<SessionInstance>) -> OpenProject {
        OpenProject {
            id: "k".into(),
            path: "C:/proj/Show.toe".into(),
            display_name: "Show.toe".into(),
            pid: None,
            alive: true,
            version_key: None,
            use_touchplayer: false,
            envoy_port: None,
            envoy_up: None,
            mcp_available: false,
            utility_available: None,
            utility_version: None,
            companion_silent_secs: None,
            source: "process".into(),
            started_at: None,
            ended_at: None,
            windows: Vec::new(),
            instances,
        }
    }

    /// The session we started owns the row, whatever order the process scan
    /// hands the two instances over in.
    #[test]
    fn launcher_instance_is_primary_regardless_of_scan_order() {
        let mut a = project_with(vec![inst(8820, "process"), inst(4312, "launcher")]);
        settle_instances(&mut a);
        assert_eq!(a.pid, Some(4312));
        assert_eq!(a.instances[0].pid, 4312, "launcher-started sorts first");

        // Reversed input must settle identically — that's the whole point.
        let mut b = project_with(vec![inst(4312, "launcher"), inst(8820, "process")]);
        settle_instances(&mut b);
        assert_eq!(b.pid, a.pid);
    }

    /// Two externally-opened instances: lowest PID wins, stably.
    #[test]
    fn external_instances_order_by_pid() {
        let mut p = project_with(vec![inst(9000, "process"), inst(500, "process")]);
        settle_instances(&mut p);
        assert_eq!(p.pid, Some(500));
        assert_eq!(
            p.instances.iter().map(|i| i.pid).collect::<Vec<_>>(),
            vec![500, 9000]
        );
    }

    fn launched_at(path: &str, pid: Option<u32>, ended: bool) -> Launched {
        Launched {
            path: path.into(),
            version_key: "2025.33070".into(),
            use_touchplayer: false,
            pid,
            started_at: 1000.0,
            ended_at: if ended { Some(2000.0) } else { None },
        }
    }

    /// macOS `open` reports no pid, so the launcher's own record arrives
    /// pid-less; it has to claim the process the scan found at that path or it
    /// can never be killed, and — since following a rename is keyed by pid —
    /// an Increment and Save would strand it as a second, phantom row.
    #[test]
    fn pidless_launch_adopts_the_scanned_process() {
        let mut launched = vec![launched_at("/Users/dan/Show.toe", None, false)];
        let scanned = vec![(4312u32, Some("/Users/dan/Show.toe".to_string()))];
        adopt_scanned_pids(&mut launched, &scanned);
        assert_eq!(launched[0].pid, Some(4312));
    }

    /// The command line keeps the launch path after TD saves itself to a new
    /// file, so adoption still works on a session that already incremented.
    #[test]
    fn adoption_matches_command_line_not_current_file() {
        let mut launched = vec![launched_at("/Users/dan/Show.toe", None, false)];
        // The process now holds Show.2.toe, but its cmdline never moved.
        let scanned = vec![(4312u32, Some("/Users/dan/Show.toe".to_string()))];
        adopt_scanned_pids(&mut launched, &scanned);
        assert_eq!(
            launched[0].pid,
            Some(4312),
            "adoption must key off the fixed command line"
        );
    }

    /// The same file launched twice: one process each, never both on the first.
    #[test]
    fn two_pidless_launches_claim_distinct_processes() {
        let mut launched = vec![
            launched_at("/Users/dan/Show.toe", None, false),
            launched_at("/Users/dan/Show.toe", None, false),
        ];
        let scanned = vec![
            (4312u32, Some("/Users/dan/Show.toe".to_string())),
            (8820u32, Some("/Users/dan/Show.toe".to_string())),
        ];
        adopt_scanned_pids(&mut launched, &scanned);
        assert_eq!(launched[0].pid, Some(4312));
        assert_eq!(launched[1].pid, Some(8820));
    }

    /// A process already owned by another record is not stolen, and a
    /// tombstone never adopts — it is a record of something that ended.
    #[test]
    fn adoption_skips_claimed_pids_and_tombstones() {
        let mut launched = vec![
            launched_at("/Users/dan/Show.toe", Some(4312), false),
            launched_at("/Users/dan/Show.toe", None, false),
            launched_at("/Users/dan/Other.toe", None, true),
        ];
        let scanned = vec![
            (4312u32, Some("/Users/dan/Show.toe".to_string())),
            (8820u32, Some("/Users/dan/Other.toe".to_string())),
        ];
        adopt_scanned_pids(&mut launched, &scanned);
        assert_eq!(launched[0].pid, Some(4312), "kept its own");
        assert_eq!(launched[1].pid, None, "4312 was taken, nothing else matches");
        assert_eq!(launched[2].pid, None, "tombstones do not adopt");
    }

    /// A pathless process (no `.toe` on argv, cannot adopt — it names nothing)
    /// never claims a pid-less launch record.
    #[test]
    fn adoption_ignores_pathless_processes() {
        let mut launched = vec![launched_at("/Users/dan/Show.toe", None, false)];
        let scanned = vec![(4312u32, None)];
        adopt_scanned_pids(&mut launched, &scanned);
        assert_eq!(launched[0].pid, None);
    }

    /// A Finder-, Dock- or File > Open-started TD on macOS has no `.toe` on
    /// its command line. The scan used to drop it before the window title was
    /// ever consulted — every TD not started from here was invisible. Now the
    /// title places it, argv is the fallback, and only a process with neither
    /// is left out.
    #[test]
    fn pathless_process_is_placed_by_its_window_title() {
        let scanned = vec![
            (4312u32, None),
            (8820u32, Some("/Users/dan/Argv.toe".to_string())),
            (9000u32, None),
        ];
        let titles = HashMap::from([(4312u32, "/Users/dan/Show.toe".to_string())]);
        let rows = resolve_scanned_paths(scanned, &titles);
        assert_eq!(
            rows,
            vec![
                (4312, "/Users/dan/Show.toe".to_string()),
                (8820, "/Users/dan/Argv.toe".to_string()),
            ],
            "titled and argv'd processes are placed; 9000 has no source and is left out"
        );
    }

    /// The title tracks Increment and Save; argv never moves. Title wins.
    #[test]
    fn window_title_outranks_command_line() {
        let scanned = vec![(4312u32, Some("/Users/dan/Show.toe".to_string()))];
        let titles = HashMap::from([(4312u32, "/Users/dan/Show.2.toe".to_string())]);
        let rows = resolve_scanned_paths(scanned, &titles);
        assert_eq!(rows, vec![(4312, "/Users/dan/Show.2.toe".to_string())]);
    }

    /// The companion's hello is a discovery source: it names the pid and the
    /// live project, so a TD the scan holds pathless (no argv, title read
    /// denied) gets its path from it — and one the scan missed entirely joins
    /// the scan, if it is actually alive. A dead peer pid is never resurrected.
    #[test]
    fn utility_peer_places_and_adds_processes() {
        let mut scanned = vec![(4312u32, None)];
        let peers = vec![
            (4312u32, "/Users/dan/Show.toe".to_string()),
            (7777u32, "/Users/dan/Other.toe".to_string()),
            (6666u32, "/Users/dan/Dead.toe".to_string()),
        ];
        let paths = merge_peer_hints(&mut scanned, &peers, |pid| pid != 6666);
        assert!(
            scanned.iter().any(|(p, _)| *p == 7777),
            "a live process the scan missed joins it"
        );
        assert!(
            !scanned.iter().any(|(p, _)| *p == 6666),
            "a stale peer's dead pid is not resurrected"
        );
        assert_eq!(paths.get(&4312).map(String::as_str), Some("/Users/dan/Show.toe"));
        assert_eq!(paths.get(&7777).map(String::as_str), Some("/Users/dan/Other.toe"));
        assert!(!paths.contains_key(&6666));

        // Fed through the resolver, the pathless-but-reported process is placed.
        let rows = resolve_scanned_paths(scanned, &paths);
        assert_eq!(
            rows,
            vec![
                (4312, "/Users/dan/Show.toe".to_string()),
                (7777, "/Users/dan/Other.toe".to_string()),
            ]
        );
    }

    /// Diagnostic, not a unit test: runs the REAL scan + title read on this
    /// machine and prints what the Current tab would show, so the session
    /// discovery can be checked against whatever TD is actually running —
    /// argv or not, Automation consent or not. Run with
    /// `cargo test --lib live_scan -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_scan_on_this_machine() {
        let scanned = scan_td_processes();
        println!("scan: {scanned:?}");
        println!("titles: {:?}", titles_by_pid());
        let mut hub = OpenProjectsHub::new();
        for p in hub.list_with_peers(&[]) {
            println!(
                "row: pid={:?} alive={} source={} path={} instances={:?}",
                p.pid,
                p.alive,
                p.source,
                p.path,
                p.instances.iter().map(|i| i.pid).collect::<Vec<_>>()
            );
        }
    }

    /// A process placed by its title stays placed when the title read comes
    /// back empty (TD's window moved to another Space), and is forgotten once
    /// the pid leaves the scan.
    #[test]
    fn placement_survives_a_blank_title_read_while_the_process_lives() {
        let mut placed = HashMap::new();
        let scanned = vec![(4312u32, None)];
        // Poll 1: the title is readable.
        let mut current = HashMap::from([(4312u32, "/Users/dan/Show.toe".to_string())]);
        remember_placements(&mut placed, &scanned, &mut current);
        // Poll 2: TD's window is on another Space — nothing came back.
        let mut current: HashMap<u32, String> = HashMap::new();
        remember_placements(&mut placed, &scanned, &mut current);
        assert_eq!(current.get(&4312).map(String::as_str), Some("/Users/dan/Show.toe"));
        assert_eq!(
            resolve_scanned_paths(scanned.clone(), &current),
            vec![(4312, "/Users/dan/Show.toe".to_string())]
        );
        // Poll 3: the title is back and has moved on — live wins.
        let mut current = HashMap::from([(4312u32, "/Users/dan/Show.2.toe".to_string())]);
        remember_placements(&mut placed, &scanned, &mut current);
        assert_eq!(placed.get(&4312).map(String::as_str), Some("/Users/dan/Show.2.toe"));
        // Poll 4: the process is gone — so is the memory of it.
        let mut current: HashMap<u32, String> = HashMap::new();
        remember_placements(&mut placed, &[], &mut current);
        assert!(placed.is_empty());
        assert!(current.is_empty());
    }

    /// A tombstone owns no processes, and must not have a primary invented for it.
    #[test]
    fn no_instances_leaves_primary_untouched() {
        let mut p = project_with(Vec::new());
        p.pid = Some(111);
        settle_instances(&mut p);
        assert_eq!(p.pid, Some(111));
    }

    /// Relaunching the same path replaces its tombstone with a fresh live entry.
    #[test]
    fn relaunch_replaces_tombstone() {
        let mut hub = OpenProjectsHub::new();
        hub.ensure_tombstone(999, "C:/proj/Show.toe", "TouchDesigner.2025.30060", false);
        hub.register_launch("C:/proj/Show.toe", "TouchDesigner.2025.30060", false, Some(5000));
        assert_eq!(hub.launched.len(), 1, "no duplicate row");
        assert!(hub.launched[0].ended_at.is_none(), "live again");
        assert_eq!(hub.launched[0].pid, Some(5000));
    }
}
