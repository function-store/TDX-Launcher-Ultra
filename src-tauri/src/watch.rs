//! Multi-project Utility TCP bus + optional Watch watchdog.
//!
//! TDXLU listens on a shared port (default 11999) for `hello` / `heartbeat`
//! from TDXLauncherUtility. Commands go the other way to each peer's
//! `cmd_port` (default 12000). See `utility/heartbeat/PROTOCOL.md`.

use crate::notify::{self, Alert, AlertKind, EmailConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// How long a bus peer stays "live" without a hello. Hellos arrive every ~2s,
/// so this is four missed beats — the crash/hang fallback. Clean removal is
/// the utility's `bye` on teardown, which drops the peer instantly; keep this
/// window tight so a killed TD doesn't read as "companion loaded" for long.
const PEER_STALE: Duration = Duration::from_secs(8);
/// How long a utility command waits for TouchDesigner's reply. Generous on
/// purpose: saves, installs and loads run on TD's main thread. Polls use
/// `invoke_utility_quick` with a short wait instead.
pub const UTILITY_REPLY_TIMEOUT: Duration = Duration::from_secs(25);

/// Version-family key for a project id: the id with a trailing numeric
/// Increment-and-Save suffix stripped (`.../Show.28.toe` -> `.../Show.toe`).
/// Two numbered saves of one project share a family; unrelated projects in
/// the same folder have different stems. This is the LAST-resort peer match,
/// for pre-0.8.2 utilities that report no pid: a renamed session's row can
/// still find its peer, because both sides collapse to the same family.
pub(crate) fn family_key(id: &str) -> String {
    if let Some(base) = id.strip_suffix(".toe") {
        if let Some(i) = base.rfind('.') {
            let suffix = &base[i + 1..];
            if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
                return format!("{}.toe", &base[..i]);
            }
        }
    }
    id.to_string()
}

/// Stable id for a watched project (normalized absolute .toe path).
pub fn watch_project_id(path: &str) -> String {
    let p = Path::new(path);
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let s = canon.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let s = s.replace('\\', "/");
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchSessionStatus {
    pub id: String,
    pub active: bool,
    pub phase: String,
    pub project_path: String,
    pub version_key: String,
    pub use_touchplayer: bool,
    pub pid: Option<u32>,
    pub last_heartbeat_secs_ago: Option<f64>,
    pub fps: Option<f64>,
    pub crash_count: u32,
    pub message: String,
    pub log_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchOverview {
    pub listening: bool,
    pub port: u16,
    pub sessions: Vec<WatchSessionStatus>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct WatchConfig {
    pub port: u16,
    pub timeout_secs: u64,
    pub launch_grace_secs: u64,
    pub max_restarts: u32,
    pub screenshot_on_crash: bool,
    pub reboot_after_crashes: u32,
    pub email: EmailConfig,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            port: 11999,
            timeout_secs: 60,
            launch_grace_secs: 45,
            max_restarts: 5,
            screenshot_on_crash: true,
            reboot_after_crashes: 0,
            email: EmailConfig::default(),
        }
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct BusPeer {
    id: String,
    cmd_port: u16,
    last_seen: Instant,
    utility: bool,
    /// Utility version from the hello payload (None = pre-versioning utility).
    utility_version: Option<String>,
    /// TD process id from the hello payload (None = pre-0.8.2 utility). Lets
    /// lookups match a session row whose recorded path has gone stale.
    pid: Option<u32>,
}

struct Session {
    id: String,
    project_path: String,
    version_key: String,
    use_touchplayer: bool,
    pid: Option<u32>,
    phase: String,
    message: String,
    crash_count: u32,
    last_hb: Option<Instant>,
    fps: Option<f64>,
    grace_until: Instant,
    log_lines: Vec<String>,
    stop: AtomicBool,
    worker: Option<JoinHandle<()>>,
}

struct Hub {
    port: u16,
    listening: bool,
    listener_stop: AtomicBool,
    listener_thread: Option<JoinHandle<()>>,
    sessions: HashMap<String, Session>,
    /// Utility hello registry (id -> command port).
    peers: HashMap<String, BusPeer>,
    /// Later project id -> the session key that still owns it.
    ///
    /// The utility derives its id from the LIVE `project.name`, so an
    /// Increment and Save renames the session out from under us and its
    /// heartbeats start arriving under a new id. Re-keying `sessions` would
    /// orphan the worker thread (it looks itself up by the key it was started
    /// with), so the session keeps its original key and the new id is aliased
    /// onto it instead.
    aliases: HashMap<String, String>,
    cfg: WatchConfig,
    log_dir: PathBuf,
    launch_fn: Option<Arc<dyn Fn(&str, &str, bool) -> Result<Option<u32>, String> + Send + Sync>>,
    app: Option<AppHandle>,
}

pub struct WatchManager {
    hub: Arc<Mutex<Hub>>,
}

impl WatchManager {
    pub fn new() -> Self {
        Self {
            hub: Arc::new(Mutex::new(Hub {
                port: 11999,
                listening: false,
                listener_stop: AtomicBool::new(false),
                listener_thread: None,
                sessions: HashMap::new(),
                peers: HashMap::new(),
                aliases: HashMap::new(),
                cfg: WatchConfig::default(),
                log_dir: PathBuf::new(),
                launch_fn: None,
                app: None,
            })),
        }
    }

    /// Keep the Utility TCP bus listening even when no Watch sessions are active.
    pub fn ensure_bus(&mut self, port: u16) -> Result<(), String> {
        self.ensure_listener(port)
    }

    /// Hand the hub its AppHandle at app setup. Watch `start()` also sets it,
    /// but the bus runs from startup — without this, peer events (and the
    /// overview) can't be emitted until a Watch session first starts.
    pub fn set_app(&mut self, app: AppHandle) {
        if let Ok(mut g) = self.hub.lock() {
            g.app = Some(app);
        }
    }

    /// Look up a live Utility peer for this .toe (from recent hello).
    pub fn peer_cmd_port(&self, path: &str) -> Option<u16> {
        let id = watch_project_id(path);
        let g = self.hub.lock().ok()?;
        let peer = g.peers.get(&id)?;
        if peer.last_seen.elapsed() > PEER_STALE {
            return None;
        }
        Some(peer.cmd_port)
    }

    pub fn has_utility_peer(&self, path: &str) -> bool {
        self.peer_cmd_port(path).is_some()
    }

    /// Utility version reported by this .toe's live peer (None = no peer, or a
    /// pre-versioning utility that doesn't report one).
    pub fn peer_utility_version(&self, path: &str) -> Option<String> {
        let id = watch_project_id(path);
        let g = self.hub.lock().ok()?;
        let peer = g.peers.get(&id)?;
        if peer.last_seen.elapsed() > PEER_STALE {
            return None;
        }
        peer.utility_version.clone()
    }

    /// How long the companion inside TD process `pid` has been silent, once
    /// it is past `PEER_STALE` without a `bye`. The pulse runs on TD's main
    /// thread (Timer CHOP), so a silent companion in a live process reads as
    /// "TD not responding": hung, or stalled in a long synchronous save.
    /// Matched by pid only, never by path: a relaunched project's old peer
    /// must not lend its silence to the new process while that one boots.
    /// None = a live peer, or none ever heard from this process.
    pub fn silent_peer_age(&self, pid: u32) -> Option<Duration> {
        let g = self.hub.lock().ok()?;
        let peer = g
            .peers
            .values()
            .filter(|p| p.utility && p.pid == Some(pid))
            .max_by_key(|p| p.last_seen)?;
        let age = peer.last_seen.elapsed();
        (age > PEER_STALE).then_some(age)
    }

    /// Live utility peer matched by TD process id: `(hello_id, cmd_port,
    /// version)`. The rename-proof lookup — a session row's recorded path goes
    /// stale on Increment-and-Save (argv is frozen and the title read needs
    /// Automation consent macOS may silently deny), but the pid the 0.8.2+
    /// utility reports in its hello identifies the process no matter what the
    /// project file is called today. `hello_id` is the id the utility answers
    /// commands under; address it with that, never the stale row path.
    pub fn peer_for_pid(&self, pid: u32) -> Option<(String, u16, Option<String>)> {
        let g = self.hub.lock().ok()?;
        g.peers
            .values()
            .filter(|p| p.pid == Some(pid) && p.last_seen.elapsed() <= PEER_STALE)
            .max_by_key(|p| p.last_seen)
            .map(|p| (p.id.clone(), p.cmd_port, p.utility_version.clone()))
    }

    /// Live peer matched by version family (see [`family_key`]) — the fallback
    /// for pre-0.8.2 utilities that report no pid. Only an UNAMBIGUOUS match
    /// counts: with two live peers in the same family (two numbered saves of
    /// one project open at once) there is no way to tell whose utility this
    /// is, so none is returned rather than guessing.
    pub fn peer_for_family(&self, path: &str) -> Option<(String, u16, Option<String>)> {
        let want = family_key(&watch_project_id(path));
        let g = self.hub.lock().ok()?;
        let mut hits = g
            .peers
            .values()
            .filter(|p| p.last_seen.elapsed() <= PEER_STALE && family_key(&p.id) == want);
        let first = hits.next()?;
        if hits.next().is_some() {
            return None;
        }
        Some((first.id.clone(), first.cmd_port, first.utility_version.clone()))
    }

    /// Every live utility peer that reported its TD pid, as `(pid, project
    /// path)` — the session list folds these in as a discovery source, not
    /// just a presence flag. A TD the process scan cannot place (macOS puts no
    /// `.toe` on the argv of a Finder-, Dock- or File > Open-started TD, and
    /// the title read needs Automation consent the user may never grant) gets
    /// its row the moment a companion hellos from inside it. Only path-like
    /// ids qualify: a bare id names nothing a row could be keyed on.
    pub fn live_utility_peers(&self) -> Vec<(u32, String)> {
        let Ok(g) = self.hub.lock() else {
            return Vec::new();
        };
        g.peers
            .values()
            .filter(|p| p.utility && p.last_seen.elapsed() <= PEER_STALE)
            .filter_map(|p| {
                let pid = p.pid?;
                let id = p.id.as_str();
                let path_like = (id.contains('/') || id.contains('\\'))
                    && id.to_ascii_lowercase().ends_with(".toe");
                path_like.then(|| (pid, id.to_string()))
            })
            .collect()
    }

    /// Watchdog status for this .toe, if it's under active watch — the compact
    /// facts the Phone Remote shows on a session tab (armed / last pulse /
    /// crashes). `None` when no watch session is registered for the path.
    /// Returns `(active, phase, last_heartbeat_secs_ago, crash_count)`.
    pub fn watchdog_status(&self, path: &str) -> Option<(bool, String, Option<f64>, u32)> {
        let id = watch_project_id(path);
        let mut g = self.hub.lock().ok()?;
        let s = g.sessions.get_mut(&id)?;
        let st = session_status(s);
        Some((
            st.active,
            st.phase,
            st.last_heartbeat_secs_ago,
            st.crash_count,
        ))
    }

    /// Invoke a Utility action over the TCP command port for this .toe.
    /// Routes by hello registry (id -> cmd_port). Never blindly hits :12000 when
    /// another project may own that port - discovers via ping scan if needed.
    ///
    /// `pid` is the session's TD process id when the caller knows it: a row
    /// whose path went stale (Increment-and-Save) matches no peer by id, but
    /// the peer's hello'd pid still finds it — and the command is then
    /// addressed with the peer's OWN hello id, since the utility refuses an
    /// id it doesn't answer to.
    pub fn invoke_utility_ex(
        &self,
        path: &str,
        pid: Option<u32>,
        action: &str,
        extra: Option<&Value>,
    ) -> Result<Value, String> {
        let id = watch_project_id(path);
        if let Some(cmd_port) = self.peer_cmd_port(path) {
            return self.invoke_utility_on_port(&id, cmd_port, action, extra);
        }
        if let Some((peer_id, cmd_port, _)) = pid.and_then(|p| self.peer_for_pid(p)) {
            return self.invoke_utility_on_port(&peer_id, cmd_port, action, extra);
        }
        // Pre-0.8.2 utilities report no pid; an unambiguous version-family
        // match still ties a renamed session's row to its peer — this is
        // what lets "Update utility" reach the very sessions that need it.
        if let Some((peer_id, cmd_port, _)) = self.peer_for_family(path) {
            return self.invoke_utility_on_port(&peer_id, cmd_port, action, extra);
        }
        let cmd_port = self.discover_cmd_port(&id).ok_or_else(|| {
            String::from(
                "No Utility peer for this project - open TD with TDXLauncherUtility (hello)",
            )
        })?;
        self.invoke_utility_on_port(&id, cmd_port, action, extra)
    }

    /// Where a project's utility answers — the id it is known by and its cmd
    /// port — from the peers already known (no discovery scan), in the same
    /// order `invoke_utility_ex` tries them.
    ///
    /// Callers resolve the route under the watch lock and send the request
    /// with [`utility_request`] AFTER dropping it: a busy TouchDesigner
    /// answers late, and a request made while holding the lock stalled every
    /// other command that needs it, polls included, until it timed out.
    pub fn utility_route(&self, path: &str, pid: Option<u32>) -> Option<(String, u16)> {
        let id = watch_project_id(path);
        if let Some(cmd_port) = self.peer_cmd_port(path) {
            return Some((id, cmd_port));
        }
        if let Some((peer_id, cmd_port, _)) = pid.and_then(|p| self.peer_for_pid(p)) {
            return Some((peer_id, cmd_port));
        }
        self.peer_for_family(path)
            .map(|(peer_id, cmd_port, _)| (peer_id, cmd_port))
    }

    fn discover_cmd_port(&self, want_id: &str) -> Option<u16> {
        // Match Utility CMD_PORT_SPAN (100) from base 12000.
        for port in 12000u16..12100 {
            if let Ok(v) = self.invoke_utility_on_port(want_id, port, "ping", None) {
                let got = v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .map(watch_project_id);
                if got.as_deref() == Some(want_id) {
                    let cmd = v
                        .get("cmd_port")
                        .and_then(|p| p.as_u64())
                        .map(|p| p as u16)
                        .unwrap_or(port);
                    let version = v
                        .get("utility_version")
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                    let td_pid = v.get("td_pid").and_then(|x| x.as_u64()).map(|p| p as u32);
                    apply_hello(&self.hub, want_id, cmd, true, version, td_pid);
                    return Some(cmd);
                }
            }
        }
        None
    }

    fn invoke_utility_on_port(
        &self,
        id: &str,
        cmd_port: u16,
        action: &str,
        extra: Option<&Value>,
    ) -> Result<Value, String> {
        self.invoke_utility_on_port_within(id, cmd_port, action, extra, UTILITY_REPLY_TIMEOUT)
    }

    fn invoke_utility_on_port_within(
        &self,
        id: &str,
        cmd_port: u16,
        action: &str,
        extra: Option<&Value>,
        reply_timeout: Duration,
    ) -> Result<Value, String> {
        utility_request(id, cmd_port, action, extra, reply_timeout)
    }
}

/// One request/reply on a utility's cmd port. Holds no launcher state, so it
/// can (and on hot paths must) run without the watch lock held.
pub fn utility_request(
    id: &str,
    cmd_port: u16,
    action: &str,
    extra: Option<&Value>,
    reply_timeout: Duration,
) -> Result<Value, String> {
    let req = format!("tdxlu-{}", Instant::now().elapsed().as_nanos());
    let mut body = serde_json::json!({
        "type": "cmd",
        "v": 1,
        "id": id,
        "action": action,
        "req": req,
    });
    if let Some(Value::Object(map)) = extra {
        if let Some(obj) = body.as_object_mut() {
            for (k, v) in map {
                if matches!(k.as_str(), "type" | "v" | "id" | "action" | "req") {
                    continue;
                }
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{cmd_port}").parse().unwrap(),
        Duration::from_millis(400),
    )
    .map_err(|e| {
        format!(
            "Utility cmd port :{cmd_port} unreachable ({e}) - is TDXLauncherUtility loaded?"
        )
    })?;
    stream
        .set_read_timeout(Some(reply_timeout))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok();
    let line = format!("{body}\n");
    stream
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut resp = String::new();
    reader
        .read_line(&mut resp)
        .map_err(|e| format!("Utility cmd no reply: {e}"))?;
    let v: Value = serde_json::from_str(resp.trim())
        .map_err(|e| format!("Utility cmd bad JSON: {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
        let err = v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("utility action failed");
        return Err(err.to_string());
    }
    Ok(v)
}

impl WatchManager {
    pub fn overview(&self) -> WatchOverview {
        let mut g = self.hub.lock().unwrap();
        let port = g.port;
        let listening = g.listening;
        let mut sessions: Vec<_> = g
            .sessions
            .values_mut()
            .map(|s| session_status(s))
            .collect();
        sessions.sort_by(|a, b| a.project_path.cmp(&b.project_path));
        let n = sessions.len();
        let peers = g.peers.len();
        WatchOverview {
            listening,
            port,
            message: if n == 0 {
                if listening {
                    format!("Bus :{port} | {peers} utility peer(s) | no watches")
                } else {
                    "Bus idle".into()
                }
            } else {
                format!("{n} watch(es) | bus :{port} | {peers} peer(s)")
            },
            sessions,
        }
    }

    pub fn stop_all(&mut self) {
        let ids: Vec<String> = {
            let g = self.hub.lock().unwrap();
            g.sessions.keys().cloned().collect()
        };
        for id in ids {
            let _ = self.stop_one(&id);
        }
        // Keep bus listener up for hello / future commands
    }

    /// Follow a watched session that saved itself to a new file.
    ///
    /// Called when the Current tab notices a session's `.toe` changed under it
    /// (Increment and Save). The session keeps its original key — the worker
    /// thread is identified by it — but learns the new path, so a restart
    /// relaunches the file the user is actually working in, and the utility's
    /// heartbeats under the new id are aliased back onto this session.
    ///
    /// No-op when nothing is watching the old path.
    pub fn retarget_project(&self, old_path: &str, new_path: &str) -> bool {
        let old_id = watch_project_id(old_path);
        let new_id = watch_project_id(new_path);
        if old_id == new_id {
            return false;
        }
        let mut g = self.hub.lock().unwrap();
        let key = if g.sessions.contains_key(&old_id) {
            old_id
        } else {
            // Already following an earlier rename — chase the alias chain so a
            // second increment lands on the same session.
            match g.aliases.get(&old_id).cloned() {
                Some(k) if g.sessions.contains_key(&k) => k,
                _ => return false,
            }
        };
        let Some(sess) = g.sessions.get_mut(&key) else {
            return false;
        };
        sess.project_path = new_path.to_string();
        push_sess_log(sess, &format!("Project saved as {new_path} - following it"));
        g.aliases.insert(new_id, key);
        drop(g);
        emit_overview(&self.hub);
        true
    }

    pub fn stop_one(&mut self, id_or_path: &str) -> Result<WatchOverview, String> {
        let id = if self.hub.lock().unwrap().sessions.contains_key(id_or_path) {
            id_or_path.to_string()
        } else {
            watch_project_id(id_or_path)
        };

        let handle = {
            let mut g = self.hub.lock().unwrap();
            let Some(sess) = g.sessions.get_mut(&id) else {
                return Err(format!("No watch for {id_or_path}"));
            };
            sess.stop.store(true, Ordering::SeqCst);
            sess.phase = "stopped".into();
            push_sess_log(sess, "Watch stopped");
            sess.worker.take()
        };
        if let Some(h) = handle {
            let _ = h.join();
        }
        {
            let mut g = self.hub.lock().unwrap();
            g.sessions.remove(&id);
            // Keep Utility TCP bus listening for hello / commands
        }
        emit_overview(&self.hub);
        Ok(self.overview())
    }

    fn ensure_listener(&mut self, port: u16) -> Result<(), String> {
        let mut g = self.hub.lock().unwrap();
        if g.listening && g.port == port {
            return Ok(());
        }
        if g.listening && g.port != port {
            return Err(format!(
                "Watch listener already on port {} - stop all watches before changing port",
                g.port
            ));
        }
        g.port = port;
        g.listener_stop.store(false, Ordering::SeqCst);
        let listener = TcpListener::bind(format!("127.0.0.1:{port}"))
            .map_err(|e| format!("Cannot bind watch port {port}: {e}"))?;
        let _ = listener.set_nonblocking(true);
        g.listening = true;
        let hub = Arc::clone(&self.hub);
        let handle = thread::spawn(move || listener_loop(hub, listener));
        g.listener_thread = Some(handle);
        Ok(())
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        project_path: String,
        version_key: String,
        use_touchplayer: bool,
        cfg: WatchConfig,
        launch_fn: Arc<dyn Fn(&str, &str, bool) -> Result<Option<u32>, String> + Send + Sync>,
        log_dir: PathBuf,
        existing_pid: Option<u32>,
    ) -> Result<WatchOverview, String> {
        let id = watch_project_id(&project_path);
        if self.hub.lock().unwrap().sessions.contains_key(&id) {
            return Err(format!("Already watching this project ({id})"));
        }

        fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let captures = log_dir.join("captures");
        fs::create_dir_all(&captures).map_err(|e| e.to_string())?;

        self.ensure_listener(cfg.port)?;

        {
            let mut g = self.hub.lock().unwrap();
            g.cfg = cfg.clone();
            g.log_dir = log_dir.clone();
            g.launch_fn = Some(Arc::clone(&launch_fn));
            g.app = Some(app.clone());
            g.port = cfg.port;
        }

        let attach = existing_pid.filter(|p| *p != 0);
        let mut sess = Session {
            id: id.clone(),
            project_path: project_path.clone(),
            version_key: version_key.clone(),
            use_touchplayer,
            pid: attach,
            phase: if attach.is_some() {
                "grace".into()
            } else {
                "starting".into()
            },
            message: if attach.is_some() {
                "Attached to running session...".into()
            } else {
                "Starting...".into()
            },
            crash_count: 0,
            last_hb: None,
            fps: None,
            grace_until: Instant::now() + Duration::from_secs(cfg.launch_grace_secs),
            log_lines: vec![],
            stop: AtomicBool::new(false),
            worker: None,
        };
        push_sess_log(
            &mut sess,
            &format!(
                "Watch start | id={id} | port {} | timeout {}s | grace {}s{}",
                cfg.port,
                cfg.timeout_secs,
                cfg.launch_grace_secs,
                attach
                    .map(|p| format!(" | attach pid={p}"))
                    .unwrap_or_default()
            ),
        );
        append_log_file(&log_dir, &format!("[{id}] Watch start"));

        // Insert before spawning so the worker always finds the session.
        {
            let mut g = self.hub.lock().unwrap();
            g.sessions.insert(id.clone(), sess);
        }

        let hub = Arc::clone(&self.hub);
        let id_clone = id.clone();
        let worker = thread::spawn(move || {
            session_loop(
                hub,
                id_clone,
                project_path,
                version_key,
                use_touchplayer,
                cfg,
                launch_fn,
                log_dir,
                captures,
                attach,
            );
        });
        {
            let mut g = self.hub.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(&id) {
                s.worker = Some(worker);
            }
        }
        emit_overview(&self.hub);
        Ok(self.overview())
    }
}

fn session_status(s: &mut Session) -> WatchSessionStatus {
    WatchSessionStatus {
        id: s.id.clone(),
        active: s.phase != "stopped" && s.phase != "gave_up" && s.phase != "error",
        phase: s.phase.clone(),
        project_path: s.project_path.clone(),
        version_key: s.version_key.clone(),
        use_touchplayer: s.use_touchplayer,
        pid: s.pid,
        last_heartbeat_secs_ago: s.last_hb.map(|t| t.elapsed().as_secs_f64()),
        fps: s.fps,
        crash_count: s.crash_count,
        message: s.message.clone(),
        log_lines: s.log_lines.clone(),
    }
}

fn push_sess_log(s: &mut Session, msg: &str) {
    let line = format!("[{}] {msg}", chrono_stamp());
    s.log_lines.push(line);
    if s.log_lines.len() > 60 {
        let n = s.log_lines.len() - 60;
        s.log_lines.drain(0..n);
    }
    s.message = msg.to_string();
    log::info!("[watch:{}] {msg}", s.id);
}

fn chrono_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn append_log_file(log_dir: &Path, msg: &str) {
    let day = chrono::Local::now().format("%Y-%m-%d");
    let path = log_dir.join(format!("watch_{day}.log"));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {msg}", chrono_stamp());
    }
}

fn emit_overview(hub: &Arc<Mutex<Hub>>) {
    let (app, overview) = {
        let mut g = hub.lock().unwrap();
        let app = g.app.clone();
        let port = g.port;
        let listening = g.listening;
        let mut sessions: Vec<_> = g
            .sessions
            .values_mut()
            .map(|s| session_status(s))
            .collect();
        sessions.sort_by(|a, b| a.project_path.cmp(&b.project_path));
        let n = sessions.len();
        (
            app,
            WatchOverview {
                listening,
                port,
                message: if n == 0 {
                    "No active watches".into()
                } else {
                    format!("{n} watch(es) | port {port}")
                },
                sessions,
            },
        )
    };
    if let Some(app) = app {
        let _ = app.emit("watch-status", overview);
    }
}

fn fire_alert(
    cfg: &WatchConfig,
    kind: AlertKind,
    id: &str,
    project_path: &str,
    crash_count: u32,
    message: &str,
    screenshot: Option<PathBuf>,
    log_dir: &Path,
) {
    notify::spawn_email_alert(
        cfg.email.clone(),
        Alert {
            kind,
            project_id: id.to_string(),
            project_path: project_path.to_string(),
            message: message.to_string(),
            crash_count,
            screenshot,
        },
        Some(log_dir.to_path_buf()),
    );
}

/// Delegates to `open_projects::kill_pid`, which bounds the wait — a process
/// wedged in a kernel-mode wait (GPU driver TDR) can otherwise make the OS's
/// own termination call block indefinitely, hanging this watchdog thread on
/// one stuck session instead of giving up and logging it.
fn kill_pid(pid: u32) {
    if let Err(e) = crate::open_projects::kill_pid(pid) {
        eprintln!("watch: kill_pid({pid}) failed: {e}");
    }
}

fn capture_screenshot(dest: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let path = dest.to_string_lossy().replace('\'', "''");
        let ps = format!(
            r#"Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bounds = [Drawing.Rectangle]::FromLTRB(0,0,
  [Windows.Forms.SystemInformation]::VirtualScreen.Width,
  [Windows.Forms.SystemInformation]::VirtualScreen.Height)
$bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('{path}', [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()"#
        );
        let out = crate::proc::command("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = dest;
        Err("Screenshot capture not implemented on this platform".into())
    }
}

fn try_reboot() {
    #[cfg(windows)]
    {
        let _ = crate::proc::command("shutdown")
            .args(["/r", "/t", "30", "/c", "TDXLU watch: repeated crashes"])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = crate::proc::command("osascript")
            .args(["-e", "tell app \"System Events\" to restart"])
            .spawn();
    }
}

#[derive(Deserialize)]
struct BusMsg {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    fps: Option<f64>,
    #[serde(default)]
    cmd_port: Option<u16>,
    #[serde(default)]
    utility: Option<bool>,
    #[serde(default)]
    utility_version: Option<String>,
    /// TD process id, reported by 0.8.2+ utilities. The permission-free
    /// session match: a row's path goes stale on Increment-and-Save (argv
    /// never changes, and the title read needs Automation consent macOS may
    /// silently withhold), but the pid identifies the process regardless.
    #[serde(default)]
    td_pid: Option<u32>,
}

fn resolve_hb_id(msg_id: Option<&str>, project: Option<&str>, path: Option<&str>) -> Option<String> {
    if let Some(id) = msg_id.map(str::trim).filter(|s| !s.is_empty()) {
        // Accept raw id or path-like id
        if id.contains('/') || id.contains('\\') || id.contains(".toe") {
            return Some(watch_project_id(id));
        }
        return Some(id.to_string());
    }
    if let Some(p) = path.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(watch_project_id(p));
    }
    if let Some(p) = project.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(watch_project_id(p));
    }
    None
}

fn apply_hello(
    hub: &Arc<Mutex<Hub>>,
    id: &str,
    cmd_port: u16,
    utility: bool,
    utility_version: Option<String>,
    td_pid: Option<u32>,
) {
    let (app, fresh, known_pid) = {
        let mut g = hub.lock().unwrap();
        // A peer counts as freshly appeared when it was unknown, had gone
        // stale (crash/hang fallback), or wasn't a utility before. Hellos
        // repeat every ~2s, so this fires once per appearance, not per beat.
        let fresh = utility
            && g.peers
                .get(id)
                .map_or(true, |p| !p.utility || p.last_seen.elapsed() > PEER_STALE);
        // Heartbeats re-hello without a version — keep the last known one. Same
        // for the pid: an older message without it must not erase what we know.
        let known_version = utility_version.or_else(|| {
            g.peers
                .get(id)
                .and_then(|p| p.utility_version.clone())
        });
        let known_pid = td_pid.or_else(|| g.peers.get(id).and_then(|p| p.pid));
        g.peers.insert(
            id.to_string(),
            BusPeer {
                id: id.to_string(),
                cmd_port,
                last_seen: Instant::now(),
                utility,
                utility_version: known_version,
                pid: known_pid,
            },
        );
        (g.app.clone(), fresh, known_pid)
    };
    // A companion just came up (launcher started after TD, utility injected,
    // or reloaded). Windows use this to gather session extras proactively —
    // the quick palette prefetches tool commands so its first summon is warm.
    if fresh {
        if let Some(app) = app {
            let _ = app.emit(
                "utility-hello",
                serde_json::json!({ "id": id, "pid": known_pid, "cmd_port": cmd_port }),
            );
            // The in-TD palette tabs need the page URL from us: hand it over
            // now (off this thread), so a launcher restart re-connects every
            // session and a freshly injected utility lights up within a beat.
            crate::palette_tabs::on_fresh_peer(&app, id);
        }
    }
}

fn apply_heartbeat(hub: &Arc<Mutex<Hub>>, id: &str, fps: Option<f64>) {
    let mut g = hub.lock().unwrap();
    let key = if g.sessions.contains_key(id) {
        id.to_string()
    } else {
        let normalized = watch_project_id(id);
        if g.sessions.contains_key(&normalized) {
            normalized
        } else if let Some(aliased) = g.aliases.get(&normalized).cloned() {
            // The session saved itself to a new file and is now announcing
            // itself under that name. Without this the pulses look like another
            // project's noise, the watch times out, and it "restarts" a session
            // that never stopped.
            aliased
        } else {
            return; // unknown id - ignore (other project's noise)
        }
    };
    let Some(sess) = g.sessions.get_mut(&key) else {
        return;
    };
    sess.last_hb = Some(Instant::now());
    if fps.is_some() {
        sess.fps = fps;
    }
    if sess.phase == "grace" || sess.phase == "starting" {
        sess.phase = "watching".into();
        sess.message = "Heartbeat received - watching".into();
    }
}

fn handle_client(stream: TcpStream, hub: &Arc<Mutex<Hub>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(msg) = serde_json::from_str::<BusMsg>(trimmed) {
                    let kind = msg.r#type.to_ascii_lowercase();
                    let Some(id) = resolve_hb_id(
                        msg.id.as_deref(),
                        msg.project.as_deref(),
                        msg.path.as_deref(),
                    ) else {
                        continue;
                    };
                    if kind == "hello" || kind == "register" {
                        apply_hello(
                            hub,
                            &id,
                            msg.cmd_port.unwrap_or(12000),
                            msg.utility.unwrap_or(true),
                            msg.utility_version.clone(),
                            msg.td_pid,
                        );
                        emit_overview(hub);
                        continue;
                    }
                    if kind == "bye" {
                        // Clean teardown (utility deleted / project closing):
                        // drop the peer now instead of waiting out PEER_STALE.
                        if let Ok(mut g) = hub.lock() {
                            g.peers.remove(&id);
                        }
                        emit_overview(hub);
                        continue;
                    }
                    if kind.is_empty() || kind == "heartbeat" || kind == "hb" {
                        if let Some(port) = msg.cmd_port {
                            apply_hello(hub, &id, port, true, msg.utility_version.clone(), msg.td_pid);
                        }
                        apply_heartbeat(hub, &id, msg.fps);
                        emit_overview(hub);
                        continue;
                    }
                    continue;
                }
                // Legacy: HB id=<id> fps=60
                let lower = trimmed.to_ascii_lowercase();
                if !(lower == "hb"
                    || lower.starts_with("hb ")
                    || lower.starts_with("heartbeat"))
                {
                    continue;
                }
                let mut id = None;
                let mut fps = None;
                for part in trimmed.split_whitespace() {
                    if let Some(v) = part
                        .strip_prefix("id=")
                        .or_else(|| part.strip_prefix("ID="))
                    {
                        id = resolve_hb_id(Some(v), None, None);
                    }
                    if let Some(v) = part
                        .strip_prefix("path=")
                        .or_else(|| part.strip_prefix("project="))
                    {
                        id = resolve_hb_id(None, None, Some(v));
                    }
                    if let Some(v) = part.strip_prefix("fps=") {
                        fps = v.parse().ok();
                    }
                }
                let Some(id) = id else {
                    continue; // require id for multi-project safety
                };
                apply_heartbeat(hub, &id, fps);
                emit_overview(hub);
            }
            Err(_) => break,
        }
    }
}

fn listener_loop(hub: Arc<Mutex<Hub>>, listener: TcpListener) {
    loop {
        {
            let g = hub.lock().unwrap();
            if g.listener_stop.load(Ordering::SeqCst) {
                break;
            }
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let h = Arc::clone(&hub);
                thread::spawn(move || handle_client(stream, &h));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(40));
            }
            Err(_) => thread::sleep(Duration::from_millis(80)),
        }
    }
}

fn session_loop(
    hub: Arc<Mutex<Hub>>,
    id: String,
    project_path: String,
    version_key: String,
    use_touchplayer: bool,
    cfg: WatchConfig,
    launch_fn: Arc<dyn Fn(&str, &str, bool) -> Result<Option<u32>, String> + Send + Sync>,
    log_dir: PathBuf,
    captures: PathBuf,
    existing_pid: Option<u32>,
) {
    // Attach to a live process (Current tab) or launch a new one.
    if let Some(pid) = existing_pid {
        let mut g = hub.lock().unwrap();
        if let Some(s) = g.sessions.get_mut(&id) {
            s.pid = Some(pid);
            s.phase = "grace".into();
            s.grace_until = Instant::now() + Duration::from_secs(cfg.launch_grace_secs);
            push_sess_log(
                s,
                &format!(
                    "Attached pid={pid} - grace {}s (no relaunch until stall)",
                    cfg.launch_grace_secs
                ),
            );
        }
        append_log_file(&log_dir, &format!("[{id}] Attached pid={pid}"));
    } else {
        match launch_fn(&project_path, &version_key, use_touchplayer) {
            Ok(pid) => {
                let mut g = hub.lock().unwrap();
                if let Some(s) = g.sessions.get_mut(&id) {
                    s.pid = pid;
                    s.phase = "grace".into();
                    s.grace_until = Instant::now() + Duration::from_secs(cfg.launch_grace_secs);
                    push_sess_log(
                        s,
                        &format!(
                            "Launched{} - grace {}s",
                            pid.map(|p| format!(" pid={p}")).unwrap_or_default(),
                            cfg.launch_grace_secs
                        ),
                    );
                }
                append_log_file(&log_dir, &format!("[{id}] Launched"));
            }
            Err(e) => {
                let mut g = hub.lock().unwrap();
                if let Some(s) = g.sessions.get_mut(&id) {
                    s.phase = "error".into();
                    push_sess_log(s, &format!("Launch failed: {e}"));
                }
                append_log_file(&log_dir, &format!("[{id}] Launch failed: {e}"));
                fire_alert(
                    &cfg,
                    AlertKind::LaunchFailed,
                    &id,
                    &project_path,
                    0,
                    &format!("Launch failed: {e}"),
                    None,
                    &log_dir,
                );
                emit_overview(&hub);
                return;
            }
        }
    }
    emit_overview(&hub);

    loop {
        {
            let g = hub.lock().unwrap();
            let Some(s) = g.sessions.get(&id) else {
                break;
            };
            if s.stop.load(Ordering::SeqCst) {
                break;
            }
        }

        thread::sleep(Duration::from_millis(400));
        emit_overview(&hub);

        let (phase, last_hb, grace_until, crash_count, pid_now) = {
            let g = hub.lock().unwrap();
            let Some(s) = g.sessions.get(&id) else {
                break;
            };
            (
                s.phase.clone(),
                s.last_hb,
                s.grace_until,
                s.crash_count,
                s.pid,
            )
        };

        if matches!(phase.as_str(), "error" | "stopped" | "gave_up" | "rebooting") {
            break;
        }

        if Instant::now() < grace_until && last_hb.is_none() {
            continue;
        }

        let timed_out = match last_hb {
            None => Instant::now() >= grace_until,
            Some(t) => t.elapsed() >= Duration::from_secs(cfg.timeout_secs),
        };
        if !timed_out {
            continue;
        }

        {
            let mut g = hub.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(&id) {
                s.phase = "restarting".into();
                push_sess_log(
                    s,
                    &format!("No heartbeat for {}s - stalled", cfg.timeout_secs),
                );
            }
            append_log_file(&log_dir, &format!("[{id}] Heartbeat timeout"));
        }
        emit_overview(&hub);

        let mut shot_path: Option<PathBuf> = None;
        if cfg.screenshot_on_crash {
            let name = format!(
                "screenshot_{}_{}.png",
                id.chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .take(40)
                    .collect::<String>(),
                chrono::Local::now().format("%Y%m%d_%H%M%S")
            );
            let path = captures.join(name);
            match capture_screenshot(&path) {
                Ok(()) => {
                    shot_path = Some(path.clone());
                    let mut g = hub.lock().unwrap();
                    if let Some(s) = g.sessions.get_mut(&id) {
                        push_sess_log(s, &format!("Screenshot -> {}", path.display()));
                    }
                }
                Err(e) => {
                    let mut g = hub.lock().unwrap();
                    if let Some(s) = g.sessions.get_mut(&id) {
                        push_sess_log(s, &format!("Screenshot failed: {e}"));
                    }
                }
            }
        }

        fire_alert(
            &cfg,
            AlertKind::Stall,
            &id,
            &project_path,
            crash_count + 1,
            &format!("No heartbeat for {}s - stalled", cfg.timeout_secs),
            shot_path.clone(),
            &log_dir,
        );

        if let Some(pid) = pid_now {
            kill_pid(pid);
            let mut g = hub.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(&id) {
                push_sess_log(s, &format!("Terminated pid {pid}"));
            }
            append_log_file(&log_dir, &format!("[{id}] Terminated pid {pid}"));
        }

        let new_count = crash_count + 1;
        {
            let mut g = hub.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(&id) {
                s.crash_count = new_count;
                s.last_hb = None;
            }
        }

        if cfg.reboot_after_crashes > 0 && new_count >= cfg.reboot_after_crashes {
            let mut g = hub.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(&id) {
                s.phase = "rebooting".into();
                push_sess_log(
                    s,
                    &format!(
                        "Crash limit {} reached - rebooting",
                        cfg.reboot_after_crashes
                    ),
                );
            }
            append_log_file(&log_dir, &format!("[{id}] Rebooting system"));
            fire_alert(
                &cfg,
                AlertKind::Reboot,
                &id,
                &project_path,
                new_count,
                &format!(
                    "Crash limit {} reached - rebooting in ~30s",
                    cfg.reboot_after_crashes
                ),
                shot_path.clone(),
                &log_dir,
            );
            emit_overview(&hub);
            try_reboot();
            break;
        }

        if new_count > cfg.max_restarts {
            let mut g = hub.lock().unwrap();
            if let Some(s) = g.sessions.get_mut(&id) {
                s.phase = "gave_up".into();
                push_sess_log(
                    s,
                    &format!("Exceeded max restarts ({})", cfg.max_restarts),
                );
            }
            append_log_file(&log_dir, &format!("[{id}] Gave up"));
            fire_alert(
                &cfg,
                AlertKind::GaveUp,
                &id,
                &project_path,
                new_count,
                &format!("Exceeded max restarts ({})", cfg.max_restarts),
                shot_path.clone(),
                &log_dir,
            );
            emit_overview(&hub);
            break;
        }

        thread::sleep(Duration::from_secs(2));
        // Relaunch what the session IS, not what it was started as: an
        // Increment and Save moves it to a new file, and restarting the old one
        // would drop the user back onto a stale version of their work.
        let relaunch_path = {
            let g = hub.lock().unwrap();
            g.sessions
                .get(&id)
                .map(|s| s.project_path.clone())
                .unwrap_or_else(|| project_path.clone())
        };
        match launch_fn(&relaunch_path, &version_key, use_touchplayer) {
            Ok(new_pid) => {
                let mut g = hub.lock().unwrap();
                if let Some(s) = g.sessions.get_mut(&id) {
                    s.pid = new_pid;
                    s.phase = "grace".into();
                    s.grace_until = Instant::now() + Duration::from_secs(cfg.launch_grace_secs);
                    push_sess_log(
                        s,
                        &format!(
                            "Relaunched (crash #{new_count}){}",
                            new_pid.map(|p| format!(" pid={p}")).unwrap_or_default()
                        ),
                    );
                }
                append_log_file(&log_dir, &format!("[{id}] Relaunched #{new_count}"));
                fire_alert(
                    &cfg,
                    AlertKind::Relaunch,
                    &id,
                    &project_path,
                    new_count,
                    &format!(
                        "Relaunched after stall (crash #{new_count}){}",
                        new_pid.map(|p| format!(" pid={p}")).unwrap_or_default()
                    ),
                    shot_path,
                    &log_dir,
                );
            }
            Err(e) => {
                let mut g = hub.lock().unwrap();
                if let Some(s) = g.sessions.get_mut(&id) {
                    s.phase = "error".into();
                    push_sess_log(s, &format!("Relaunch failed: {e}"));
                }
                fire_alert(
                    &cfg,
                    AlertKind::LaunchFailed,
                    &id,
                    &project_path,
                    new_count,
                    &format!("Relaunch failed: {e}"),
                    shot_path,
                    &log_dir,
                );
                emit_overview(&hub);
                break;
            }
        }
        emit_overview(&hub);
    }

    emit_overview(&hub);
}
