//! Browser control panel server.
//!
//! Serves the standalone control page (second Vite entry, `dist/control.html`)
//! and a tokened JSON API that proxies into the same utility-action path the
//! in-app panel uses (`commands::run_utility_action`: TCP bus first, Envoy
//! fallback). Started lazily by `open_control_server_cmd`; lives until the app
//! exits. Binds 127.0.0.1 unless the LAN setting is on; every `/api/*` request
//! must carry the per-run bearer token, which only travels in the opened URL's
//! hash fragment.

#[allow(unused_imports)]
use std::io::Read;
use std::collections::HashMap;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Response, Server};

use crate::commands::AppState;

/// Worker threads sharing the listener: a value poll must not queue behind a
/// slider write burst from another client.
const WORKERS: usize = 4;

#[derive(Clone)]
pub struct ControlServerInfo {
    pub port: u16,
    pub lan: bool,
    pub token: String,
    /// Set true to tell the worker threads to drain and exit, so the socket
    /// can be rebound (e.g. loopback -> LAN when Phone Remote turns on).
    shutdown: Arc<AtomicBool>,
}

/// Routes this server used to answer and no longer does (D5 — the fleet
/// rescope), each naming what took the job. A phone bookmark, a cached page
/// or a script still asking gets this instead of a bare 404, because "the
/// endpoint moved into the session" is the one thing a 404 cannot say.
///
/// The client tier retired with them: what it existed for — a link that
/// reaches the authored controls and nothing else — is FNS_Remote's own
/// client link now (docs/fns-remote.md §9), and fleet is author-only
/// because it kills processes.
fn retired_route(path: &str) -> Option<&'static str> {
    match path {
        "/api/control/schema" | "/api/control/values" | "/api/control/set" => Some(
            "parameter control moved into the session: open its FNS_Remote page \
             (control_url on the session's /api/sessions entry)",
        ),
        "/api/control/comps" | "/api/control/add" | "/api/control/remove" => Some(
            "exposing a COMP moved into the session: FNS_Remote's own page manages \
             its exposed set",
        ),
        "/api/sessions/action" => Some(
            "save / snapshot / record moved into the session: run them from its \
             FNS_Remote page, or from the launcher",
        ),
        "/ws/touch" => Some("phone touch is served by FNS_Remote inside the session"),
        _ => None,
    }
}

// --- Media preview tickets ----------------------------------------------------
//
// `<img>` and `<video>` cannot set an Authorization header, and the bearer
// must never ride in a URL. So an authenticated request mints a ticket for
// ONE file; the element then fetches with that ticket alone. A leaked ticket
// buys one already-referenced media file for a few minutes, not the API.

const MEDIA_TICKET_TTL: Duration = Duration::from_secs(300);
const MEDIA_TICKET_MAX: usize = 512;

fn media_tickets() -> &'static std::sync::Mutex<HashMap<String, (PathBuf, std::time::Instant)>> {
    static TICKETS: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, (PathBuf, std::time::Instant)>>,
    > = std::sync::OnceLock::new();
    TICKETS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Mint a ticket for one media file. `None` when the file is not previewable.
fn mint_media_ticket(path: &str) -> Option<String> {
    let path = PathBuf::from(path.replace('\\', "/"));
    if !crate::media_stream::is_previewable(&path) {
        return None;
    }
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    let mut map = media_tickets().lock().ok()?;
    let now = std::time::Instant::now();
    map.retain(|_, (_, born)| now.duration_since(*born) < MEDIA_TICKET_TTL);
    if map.len() >= MEDIA_TICKET_MAX {
        // Oldest first — a page that scrolled a long media list never wedges
        // the mint for the rows still on screen.
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, (_, born))| *born)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
    }
    map.insert(ticket.clone(), (path, now));
    Some(ticket)
}

fn media_ticket_path(ticket: &str) -> Option<PathBuf> {
    let map = media_tickets().lock().ok()?;
    let (path, born) = map.get(ticket)?;
    (std::time::Instant::now().duration_since(*born) < MEDIA_TICKET_TTL).then(|| path.clone())
}

/// The parts of a running server that cannot be cloned, kept beside the
/// cloneable `ControlServerInfo` so `stop` can actually close the socket
/// instead of only asking the workers nicely.
///
/// The listener is owned by tiny_http's `Server`, and its `Drop` is what
/// closes it — so the socket lives until the LAST `Arc<Server>` goes. Those
/// clones live in the worker threads, which means a stop that just sets a
/// flag and returns leaves the port held for as long as any worker is busy.
/// Holding the Arc and the `JoinHandle`s here is what makes the release
/// deterministic. Observed in the field 2026-09-11: the flag was set and the
/// listener was still bound HOURS later, so the next start failed with
/// "Only one usage of each socket address" — the launcher blocked by itself.
struct RunningServer {
    server: Arc<Server>,
    workers: Vec<thread::JoinHandle<()>>,
}

#[derive(Default)]
pub struct ControlServerState {
    started: Option<ControlServerInfo>,
    running: Option<RunningServer>,
}

impl ControlServerState {
    /// `(port, lan)` of the live server, if one is serving — read-only, drives
    /// the header Phone button's "live" state.
    pub fn status(&self) -> Option<(u16, bool)> {
        self.started.as_ref().map(|i| (i.port, i.lan))
    }
}

/// How long a worker blocks on `recv_timeout` before re-checking the shutdown
/// flag — the ceiling on how long a rebind waits for threads to drain.
const POLL: Duration = Duration::from_millis(200);

/// Best-effort LAN IP for the URL shown when binding all interfaces. The
/// classic UDP trick: connecting a datagram socket picks the outbound
/// interface without sending a packet.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => {
                let hex = bytes.get(i + 1..i + 3);
                if let Some(h) = hex.and_then(|h| std::str::from_utf8(h).ok()) {
                    if let Ok(v) = u8::from_str_radix(h, 16) {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

/// Directory holding the built frontend (control.html + assets). Release: the
/// bundled resource copy of `dist/`. Dev: the repo's `dist/` next to the
/// manifest, checked FIRST — tauri-build also drops a resource copy next to
/// the debug exe, snapshotted at cargo-build time, and serving that meant a
/// page edit only went live when a Rust rebuild happened to follow
/// `npm run build`.
fn dist_dir(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        if dev.join("control.html").is_file() {
            return Some(dev);
        }
    }
    if let Ok(p) = app
        .path()
        .resolve("../dist", tauri::path::BaseDirectory::Resource)
    {
        if p.join("control.html").is_file() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if dev.join("control.html").is_file() {
        return Some(dev);
    }
    None
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" | "map" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(body.to_string().into_bytes())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
}

/// The bearer token to use: the persisted one when set, else a freshly minted
/// one saved back to config so it survives restarts (phone bookmarks keep
/// working). Regenerating is just clearing `control_token` and re-running this.
fn resolve_token(app: &AppHandle) -> Result<String, String> {
    resolve_token_in(app, |cfg| &mut cfg.control_token)
}

fn resolve_token_in(
    app: &AppHandle,
    field: impl Fn(&mut crate::config::AppConfig) -> &mut String,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
    let slot = field(&mut cfg.config);
    if !slot.trim().is_empty() {
        return Ok(slot.clone());
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    *slot = token.clone();
    // Persist best-effort: a save failure shouldn't block starting the server,
    // it just means the token won't survive the next restart.
    if let Err(e) = cfg.save() {
        log::warn!("could not persist control token: {e}");
    }
    Ok(token)
}

/// Stop the running server and RELEASE THE PORT. Called under the control
/// lock.
///
/// Three steps, and the first two are what the old version was missing:
///
/// 1. the shutdown flag, so a worker between requests exits its loop;
/// 2. `unblock()`, so a worker parked in `recv_timeout` returns NOW rather
///    than when its poll happens to lapse;
/// 3. join the workers and drop the `Arc<Server>` — tiny_http closes the
///    listener in `Drop`, and that only runs when the last clone goes.
///
/// Step 3 happens on its own thread: a worker can be mid-request, and a
/// request can be a companion-bus call with a 25-second read timeout. The UI
/// thread must not wait for that. The caller therefore cannot assume the port
/// is free the instant this returns — `bind_with_retry` is the other half.
fn stop_locked(ctl: &mut ControlServerState) {
    let Some(info) = ctl.started.take() else { return };
    info.shutdown.store(true, Ordering::SeqCst);
    if let Some(run) = ctl.running.take() {
        run.server.unblock();
        thread::spawn(move || {
            let RunningServer { server, workers } = run;
            for h in workers {
                let _ = h.join();
            }
            drop(server); // last Arc — tiny_http's Drop closes the listener
            log::info!("control server stopped, port released");
        });
    }
    log::info!("control server stopping");
}

/// How long a start will wait for a previous server to finish letting go.
const REBIND_WAIT: Duration = Duration::from_secs(4);

/// Bind, giving a server that is still shutting down a moment to release the
/// port. A stop hands the join off to another thread (see `stop_locked`), so
/// an immediate start — flipping loopback to LAN, or Stop then Start — can
/// legitimately arrive while the socket is still held by our own process.
///
/// The error, when it does give up, says so in those terms: "in use" for a
/// port we were just listening on almost always means us, not somebody else,
/// and the raw OS text ("Only one usage of each socket address is normally
/// permitted") sends people hunting for a phantom other program.
fn bind_with_retry(bind_host: &str, port: u16) -> Result<Server, String> {
    bind_within(bind_host, port, REBIND_WAIT)
}

fn bind_within(bind_host: &str, port: u16, wait: Duration) -> Result<Server, String> {
    let addr = format!("{bind_host}:{port}");
    let deadline = std::time::Instant::now() + wait;
    let mut last;
    loop {
        match Server::http(&addr) {
            Ok(s) => return Ok(s),
            Err(e) => {
                last = e.to_string();
                if std::time::Instant::now() >= deadline {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(format!(
        "Control server could not bind {addr} after waiting {}s: {last}. \
         Port {port} is still held — usually by this launcher's previous \
         server finishing a request. Try again in a moment, or set a \
         different port in Settings.",
        wait.as_secs()
    ))
}

/// Ensure the server is running on the requested bind; returns the URL to open
/// (token in the hash). If a server is already up on a *different* bind
/// (loopback vs LAN), it is stopped and rebound — this is how one-tap Phone
/// Remote flips a loopback-only server to LAN without an app restart.
pub fn ensure_started(app: &AppHandle, port: u16, lan: bool) -> Result<String, String> {
    let token = resolve_token(app)?;
    let state = app.state::<AppState>();
    let mut ctl = state.control.lock().map_err(|e| e.to_string())?;

    // Reuse only when the live bind matches what's asked (port, interface) and
    // the token still matches (a regenerate clears the persisted token).
    if let Some(info) = &ctl.started {
        if info.port == port && info.lan == lan && info.token == token {
            return Ok(author_url(info));
        }
        stop_locked(&mut ctl);
    }

    let bind_host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let server = Arc::new(bind_with_retry(bind_host, port)?);
    let shutdown = Arc::new(AtomicBool::new(false));
    let mut workers = Vec::with_capacity(WORKERS);
    for _ in 0..WORKERS {
        let server = Arc::clone(&server);
        let shutdown = Arc::clone(&shutdown);
        let app = app.clone();
        let token = token.clone();
        workers.push(thread::spawn(move || {
            while !shutdown.load(Ordering::SeqCst) {
                match server.recv_timeout(POLL) {
                    Ok(Some(request)) => handle_request(&app, &token, request),
                    Ok(None) => {}       // timeout or unblock() — re-check
                    Err(_) => break,     // socket closed
                }
            }
        }));
    }
    let info = ControlServerInfo {
        port,
        lan,
        token,
        shutdown,
    };
    ctl.started = Some(info.clone());
    ctl.running = Some(RunningServer {
        server: Arc::clone(&server),
        workers,
    });
    log::info!("control server listening on {bind_host}:{port}");
    Ok(author_url(&info))
}

/// URL to open — LAN IP when bound to all interfaces, else loopback.
fn url_with_token(info: &ControlServerInfo, token: &str) -> String {
    let host = if info.lan {
        lan_ip().unwrap_or_else(|| "127.0.0.1".into())
    } else {
        "127.0.0.1".into()
    };
    format!("http://{host}:{}/#k={}", info.port, token)
}

/// Full-control link (the developer's own).
fn author_url(info: &ControlServerInfo) -> String {
    url_with_token(info, &info.token)
}

/// URL of one of our pages on loopback, whatever the server is bound to
/// (0.0.0.0 answers on 127.0.0.1 too). Starts the server with the saved
/// settings when it isn't up — the in-TD palette tabs need no LAN and no
/// pairing dialog. `query` is appended verbatim (already encoded); the author
/// token rides in the fragment like every other link we hand out.
pub fn loopback_page_url(app: &AppHandle, page: &str, query: &str) -> Result<String, String> {
    let (port, lan) = {
        let state = app.state::<AppState>();
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (cfg.config.control_server_port, cfg.config.control_server_lan)
    };
    ensure_started(app, port, lan)?;
    let state = app.state::<AppState>();
    let ctl = state.control.lock().map_err(|e| e.to_string())?;
    let info = ctl
        .started
        .as_ref()
        .ok_or_else(|| "control server is not running".to_string())?;
    let q = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    Ok(format!("http://127.0.0.1:{}/{page}{q}#k={}", info.port, info.token))
}

/// The fleet link for the running server. One tier since D5 retired the
/// client tier: this page lists and kills sessions, so it is author-only.
/// Starts the server (LAN, like Phone Remote) when it isn't up yet.
pub fn phone_url(app: &AppHandle) -> Result<String, String> {
    let _ = start_for_phone(app)?;
    let state = app.state::<AppState>();
    let ctl = state.control.lock().map_err(|e| e.to_string())?;
    let info = ctl
        .started
        .as_ref()
        .ok_or_else(|| "control server is not running".to_string())?;
    Ok(url_with_token(info, &info.token))
}

/// The fleet link WITHOUT starting anything: `None` when the server is not
/// running, else `(url, lan)` — a loopback-only server yields a link a phone
/// cannot reach, which the caller shows as "not on the LAN".
pub fn phone_url_if_running(app: &AppHandle) -> Result<Option<(String, bool)>, String> {
    let state = app.state::<AppState>();
    let ctl = state.control.lock().map_err(|e| e.to_string())?;
    Ok(ctl
        .started
        .as_ref()
        .map(|info| (url_with_token(info, &info.token), info.lan)))
}

/// Force the control server onto the LAN and return the URL — the one-tap
/// Phone Remote entry point. Enables + persists the LAN setting, then
/// (re)binds. Separate from `ensure_started` so the caller's intent ("I want
/// this reachable from another device") is explicit.
pub fn start_for_phone(app: &AppHandle) -> Result<String, String> {
    let port = {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        if !cfg.config.control_server_lan {
            cfg.config.control_server_lan = true;
            let _ = cfg.save();
        }
        cfg.config.control_server_port
    };
    ensure_started(app, port, true)
}

/// Stop the server (drain workers, drop the listener) but keep the token, so
/// starting again reuses the same link. Idempotent — a no-op when not running.
pub fn stop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut ctl = state.control.lock().map_err(|e| e.to_string())?;
    stop_locked(&mut ctl);
    Ok(())
}

/// Clear the persisted token and stop the server so the next start mints a
/// fresh one — every previously shared link/bookmark stops working.
pub fn regenerate_token(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.control_token.clear();
        // Retired with the client tier (D5); cleared so no dead secret sits
        // in config, and nothing can authenticate with a stale one.
        cfg.config.control_client_token.clear();
        cfg.save()?;
    }
    let mut ctl = state.control.lock().map_err(|e| e.to_string())?;
    stop_locked(&mut ctl);
    Ok(())
}

fn handle_request(app: &AppHandle, token: &str, mut request: tiny_http::Request) {
    let url = request.url().to_string();
    let path = url.split_once('?').map(|(p, _)| p).unwrap_or(&url).to_string();

    let response = if path.starts_with("/api/") {
        let bearer = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.as_str().to_string())
            .and_then(|v| v.strip_prefix("Bearer ").map(str::to_string));
        // One tier: this server is the fleet page, and fleet kills processes.
        let authed = match bearer {
            Some(t) => constant_time_eq(&t, token),
            // A media preview element cannot send a header; its ticket was
            // minted by an authenticated request and names one file.
            None => {
                path == "/api/palette/media"
                    && query_param(&url, "t")
                        .and_then(|t| media_ticket_path(&t))
                        .is_some()
            }
        };
        if !authed {
            json_response(401, &json!({"ok": false, "error": "missing or invalid token"}))
        } else if let Some(moved) = retired_route(&path) {
            json_response(410, &json!({"ok": false, "error": moved, "retired": true}))
        } else {
            handle_api(app, &path, &url, &mut request)
        }
    } else {
        handle_static(app, &path)
    };
    let _ = request.respond(response);
}

// Phone touch is NOT served here any more (D7, 2026-08-31).
//
// It used to be a WebSocket upgrade on `/ws/touch` that this process pumped
// over TCP into the companion's TDXLUSensors. That receiver has moved into
// the FNS_Remote package, which serves its own page and holds the phone's
// WebSocket itself -- so the phone now reaches the SESSION directly and this
// relay had nothing left to talk to. It also fixes the targeting bug the
// relay could never solve: it port-scanned 12100-12199 and drove whichever
// companion answered first, which is wrong the moment two sessions are live.
//
// The launcher's remaining phone job is the fleet page plus the hand-off
// link to a session's own remote (docs/fns-plus-capabilities.md D5).

/// Parse a request body as JSON, or None on read / parse failure.
fn body_json(request: &mut tiny_http::Request) -> Option<Value> {
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body).ok()?;
    serde_json::from_str(&body).ok()
}

/// The session list the phone renders — live sessions AND stale tombstones,
/// with the fields a remote needs to relaunch (version_key, use_touchplayer).
fn sessions_payload(state: &AppState) -> Value {
    let hints = crate::commands::utility_peer_hints(state);
    let mut list = match state.open.lock() {
        Ok(mut open) => open.list_with_peers(&hints),
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    // Watchdog status per path, so the phone can show "armed / last pulse" the
    // same way the desktop Heartbeat panel does. Lock is best-effort — a busy
    // watch manager just means no heartbeat facts this poll, never an error.
    let watch = state.watch.lock().ok();
    // Resolve the companion over its own TCP bus, exactly as the desktop list
    // does. Skipping this left the phone with whatever the OPTIONAL Envoy
    // probe reported, so a project without Embody looked companion-less and
    // the phone greyed out Save / Snapshot / Record and the parameter panel —
    // for actions whose routes are all bus-first and would have worked.
    if let Some(w) = watch.as_ref() {
        crate::commands::apply_utility_presence(w, &mut list);
    }
    let mut sessions: Vec<Value> = list
        .iter()
        .map(|p| {
            let watchdog = watch.as_ref().and_then(|w| w.watchdog_status(&p.path)).map(
                |(active, phase, last_hb, crashes)| {
                    json!({
                        "active": active,
                        "phase": phase,
                        "last_heartbeat_secs_ago": last_hb,
                        "crash_count": crashes,
                    })
                },
            );
            json!({
                "path": p.path,
                "name": p.display_name,
                "pid": p.pid,
                "alive": p.alive,
                "ended_at": p.ended_at,
                "started_at": p.started_at,
                "source": p.source,
                "envoy_up": p.envoy_up,
                "version_key": p.version_key,
                "use_touchplayer": p.use_touchplayer,
                "utility_available": p.utility_available,
                "utility_version": p.utility_version,
                "watchdog": watchdog,
                "control_url": Value::Null,
                "client_url": Value::Null,
                "remote": Value::Null,
            })
        })
        .collect();
    // The hand-off (D5): a session that carries FNS_Remote serves its own
    // phone page, and the fleet page opens THAT — its origin, its token. Asked
    // over the bus, which locks `watch` itself, so the presence guard above
    // must be gone first.
    drop(watch);
    for s in sessions.iter_mut() {
        let alive = s["alive"].as_bool().unwrap_or(false);
        let has_utility = s["utility_available"].as_bool().unwrap_or(false);
        if !(alive && has_utility) {
            continue;
        }
        let Some(path) = s["path"].as_str().map(str::to_string) else { continue };
        if let Some(remote) = crate::remote_handoff::remote_info(state, &path) {
            s["control_url"] = remote["url"].clone();
            s["client_url"] = remote["client_url"].clone();
            s["remote"] = remote;
        }
    }
    json!({"ok": true, "sessions": sessions})
}

/// Recent projects the phone can launch — launcher + TD history, minus the
/// ones already running (those live in the session tabs). Each carries enough
/// to launch without a desktop round-trip: path, name, and last-used version.
fn recents_payload(state: &AppState) -> Value {
    let recents = match state.config.lock() {
        Ok(cfg) => cfg.get_merged_recents(),
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    // Paths already open (normalized) — hide them from the launch list.
    let hints = crate::commands::utility_peer_hints(state);
    let running: std::collections::HashSet<String> = match state.open.lock() {
        Ok(mut open) => open
            .list_with_peers(&hints)
            .iter()
            .filter(|p| p.alive)
            .map(|p| p.path.replace('\\', "/").to_lowercase())
            .collect(),
        Err(_) => std::collections::HashSet::new(),
    };
    let items: Vec<Value> = recents
        .iter()
        .filter(|r| !running.contains(&r.path.replace('\\', "/").to_lowercase()))
        .map(|r| {
            let name = std::path::Path::new(&r.path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| r.path.clone());
            json!({
                "path": r.path,
                "name": name,
                "source": r.source,
                "last_opened": r.last_opened,
            })
        })
        .collect();
    json!({"ok": true, "recents": items})
}

fn handle_api(
    app: &AppHandle,
    path: &str,
    url: &str,
    request: &mut tiny_http::Request,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let state = app.state::<AppState>();
    match path {
        // App-level facts the phone needs to render like the desktop: theme
        // (the standalone page carries every theme's CSS) and whether the
        // perf readout should poll at all.
        "/api/app" => {
            let (theme, perf_enabled) = match state.config.lock() {
                Ok(cfg) => (cfg.config.theme.clone(), cfg.config.perf_monitor_enabled),
                Err(e) => return json_response(500, &json!({"ok": false, "error": e.to_string()})),
            };
            json_response(
                200,
                &json!({
                    "ok": true,
                    "name": "TDXLU",
                    "theme": theme,
                    "perf_enabled": perf_enabled,
                    // Constant now the client tier is gone (D5). Kept on the
                    // wire so a page cached before the rescope still parses.
                    "role": "author",
                    "entitled": crate::licensing::status().entitled,
                }),
            )
        }
        // --- In-TD palette tabs (docs/palette-tabs.md). Author tier only:
        // the client allow-list above never reaches these. ---
        "/api/palette/catalog" => {
            let sid = query_param(url, "sid");
            match crate::palette_tabs::catalog(app, sid.as_deref()) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(500, &json!({"ok": false, "error": e})),
            }
        }
        // The session's FNS_CommandRegistry commands, and running one.
        "/api/palette/commands" => {
            let Some(sid) = query_param(url, "sid") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?sid="}));
            };
            // `?all=1` skips the curation: capability lookups (Collect,
            // Autosave) need the commands tools register as hidden.
            let all = query_param(url, "all").is_some_and(|v| v == "1");
            match crate::palette_tabs::commands(app, &sid, all) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/palette/run" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path (session id)"}));
            };
            let Some(key) = body.get("key").and_then(|k| k.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.key"}));
            };
            match crate::palette_tabs::run_command(app, toe, key, body.get("kwargs")) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Right-click on a Patreon .tox: copy it into the user's TD palette
        // instead of into a session. No session id needed.
        "/api/palette/palette_add" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(source) = body.get("source").filter(|s| s.is_object()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.source"}));
            };
            let session = body
                .get("path")
                .and_then(|p| p.as_str())
                .filter(|s| !s.trim().is_empty());
            match crate::palette_tabs::add_to_palette(app, source, session) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // The inverse of place: save the session's selected COMP and pin it
        // to the Toolbox.
        "/api/palette/pin_selected" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path (session id)"}));
            };
            let category = body.get("category").and_then(|c| c.as_str()).unwrap_or("");
            let label = body.get("label").and_then(|l| l.as_str()).unwrap_or("");
            match crate::palette_tabs::pin_selected(app, toe, category, label) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Session bar: the free Companion-bar verbs (allow-listed in palette_tabs).
        "/api/palette/session" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path (session id)"}));
            };
            let Some(action) = body.get("action").and_then(|a| a.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.action"}));
            };
            match crate::palette_tabs::session_action(app, toe, action, body.get("payload")) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Phone Remote from inside TD: the client link (+ whether it is on
        // the LAN) without side effects, and the explicit "turn it on".
        // With `?sid=` the session's own FNS_Remote answers first (its QR, its
        // token); without one, or when the session carries no package, the
        // launcher's control server is the fallback until D5 retires it.
        "/api/palette/phone" => {
            let sid = query_param(url, "sid");
            match crate::palette_tabs::phone_info(app, sid.as_deref()) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(500, &json!({"ok": false, "error": e})),
            }
        }
        "/api/palette/phone/enable" => {
            let sid = body_json(request)
                .and_then(|b| b.get("path").and_then(|p| p.as_str()).map(str::to_string))
                .filter(|s| !s.trim().is_empty());
            match crate::palette_tabs::phone_enable(app, sid.as_deref()) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Mint a preview ticket for one media file (see MEDIA_TICKET_TTL):
        // the page holds the bearer, the <img> / <video> that renders the file
        // cannot send one.
        "/api/palette/media/ticket" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(path) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path"}));
            };
            match mint_media_ticket(path) {
                Some(t) => json_response(200, &json!({"ok": true, "url": format!("/api/palette/media?t={t}")})),
                None => json_response(415, &json!({"ok": false, "error": "no preview for this file type"})),
            }
        }
        // A local media file, for the previews in the Media / Collect lists.
        // The same files (and the same allow-list) the desktop serves its own
        // WebView through the `media://` protocol — this page lives over HTTP,
        // so it needs a route instead. Nothing is written, resized or cached:
        // the browser renders and scales the real file.
        "/api/palette/media" => {
            let Some(ticket) = query_param(url, "t") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?t= (mint one at /api/palette/media/ticket)"}));
            };
            let Some(file) = media_ticket_path(&ticket) else {
                return json_response(403, &json!({"ok": false, "error": "unknown or expired preview ticket"}));
            };
            let range = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Range"))
                .map(|h| h.value.as_str().to_string());
            match crate::media_stream::http_body(&file, range.as_deref()) {
                Ok(body) => {
                    let mut resp = Response::from_data(body.bytes)
                        .with_status_code(body.status)
                        .with_header(header("Content-Type", body.mime))
                        .with_header(header("Accept-Ranges", "bytes"))
                        // Media can be replaced under a stable path while the
                        // page is open (Replace, a re-render) — never cache.
                        .with_header(header("Cache-Control", "no-store"));
                    if let Some(cr) = body.content_range {
                        resp = resp.with_header(header("Content-Range", &cr));
                    }
                    resp
                }
                Err((code, why)) => json_response(code, &json!({"ok": false, "error": why})),
            }
        }
        // The session's OS windows (main, torn-off panes, perform) and
        // focus / minimize / restore — the desktop's Windows feature.
        "/api/palette/oswindows" => {
            let Some(sid) = query_param(url, "sid") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?sid="}));
            };
            match crate::palette_tabs::os_windows(app, &sid) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/palette/oswindows/action" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(action) = body.get("action").and_then(|a| a.as_str()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.action"}));
            };
            let id = body.get("id").and_then(|i| i.as_i64());
            let pid = body.get("pid").and_then(|p| p.as_u64()).map(|p| p as u32);
            match crate::palette_tabs::os_window_action(id, pid, action) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Git quick-commit: status of the session's repo, and save + commit.
        "/api/palette/git" => {
            let Some(sid) = query_param(url, "sid") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?sid="}));
            };
            match crate::palette_tabs::git_status(&sid) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/palette/git/commit" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path (session id)"}));
            };
            let message = body.get("message").and_then(|m| m.as_str()).unwrap_or("");
            let save_first = body.get("save").and_then(|s| s.as_bool()).unwrap_or(true);
            match crate::palette_tabs::git_commit(app, toe, message, save_first) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Backup now: the plan to the configured folder, and running it.
        "/api/palette/backup" => {
            let Some(sid) = query_param(url, "sid") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?sid="}));
            };
            match crate::palette_tabs::backup_info(app, &sid) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/palette/backup/run" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path (session id)"}));
            };
            match crate::palette_tabs::backup_run(app, toe) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Pin / unpin a command as a favourite (launcher config, shared with
        // the quick-launch and Settings).
        "/api/palette/favorite" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(identity) = body.get("identity").and_then(|i| i.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.identity (tool#id)"}));
            };
            let favorite = body.get("favorite").and_then(|f| f.as_bool()).unwrap_or(true);
            match crate::palette_tabs::set_favorite(app, identity, favorite) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Open a web page in the system browser — a locked Patreon post, the
        // Plus tier's support page. https only; see palette_tabs::open_url.
        "/api/palette/open_url" => {
            let Some(url) = body_json(request)
                .and_then(|b| b.get("url").and_then(|u| u.as_str()).map(str::to_string))
            else {
                return json_response(400, &json!({"ok": false, "error": "missing body.url"}));
            };
            match crate::palette_tabs::open_url(&url) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(400, &json!({"ok": false, "error": e})),
            }
        }
        // Dismiss the "a .tox runs the creator's code" warning, once for both
        // this page and the launcher window.
        "/api/palette/patreon_ack" => {
            let ack = body_json(request)
                .and_then(|b| b.get("ack").and_then(|a| a.as_bool()))
                .unwrap_or(true);
            match crate::palette_tabs::set_patreon_trust_ack(app, ack) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Repoint + reload the session's companion to the launcher's current TOX.
        "/api/palette/update_companion" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path (session id)"}));
            };
            match crate::palette_tabs::update_companion(app, toe) {
                Ok(v) => json_response(200, &v),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/palette/place" | "/api/palette/fetch" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(source) = body.get("source").filter(|s| s.is_object()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.source"}));
            };
            if path == "/api/palette/fetch" {
                // Warm the cache only (☁ on a url tool / FNS package) — no session needed.
                return match crate::palette_tabs::resolve_source(app, source) {
                    Ok(p) => json_response(200, &json!({"ok": true, "path": p})),
                    Err(e) => json_response(502, &json!({"ok": false, "error": e})),
                };
            }
            let Some(toe) = body.get("path").and_then(|p| p.as_str()).filter(|s| !s.trim().is_empty()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path (session id)"}));
            };
            log::info!("palette place: {source} into {toe}");
            match crate::palette_tabs::place(app, toe, source) {
                Ok(v) => json_response(200, &v),
                Err(e) => {
                    log::warn!("palette place: {source} into {toe} failed: {e}");
                    json_response(502, &json!({"ok": false, "error": e}))
                }
            }
        }
        "/api/patreon/campaigns" => match crate::palette_tabs::patreon_campaigns(app) {
            Ok(v) => json_response(200, &json!({"ok": true, "campaigns": v})),
            Err(e) => json_response(502, &json!({"ok": false, "error": e})),
        },
        "/api/patreon/posts" => {
            let Some(campaign) = query_param(url, "campaign") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?campaign="}));
            };
            // The creator's display name only rides along so the listing can be
            // filed under it in the search index; the fetch never needs it.
            let name = query_param(url, "name");
            match crate::palette_tabs::patreon_posts(app, &campaign, name.as_deref()) {
                Ok(v) => json_response(200, &json!({"ok": true, "posts": v})),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/patreon/search" => {
            let Some(q) = query_param(url, "q") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?q="}));
            };
            match crate::palette_tabs::patreon_search(app, &q) {
                Ok(v) => json_response(200, &json!({"ok": true, "result": v})),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/patreon/post" => {
            let Some(id) = query_param(url, "id") else {
                return json_response(400, &json!({"ok": false, "error": "missing ?id="}));
            };
            match crate::palette_tabs::patreon_post(app, &id) {
                Ok(v) => json_response(200, &json!({"ok": true, "post": v})),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Client tier gets a trimmed list: live sessions only, no pids /
        // builds / tombstones — just enough to pick whose controls to show.
        "/api/sessions" => json_response(200, &sessions_payload(&state)),
        // Perf sample: process CPU/RAM for every live session in one refresh,
        // plus TD-internal stats (companion Perform CHOP) for the one session
        // the phone is actually showing (`?td=`). Same gate as the desktop —
        // the Settings toggle owns whether anything samples.
        "/api/sessions/perf" => {
            let enabled = match state.config.lock() {
                Ok(cfg) => cfg.config.perf_monitor_enabled,
                Err(e) => return json_response(500, &json!({"ok": false, "error": e.to_string()})),
            };
            if !enabled {
                return json_response(200, &json!({"ok": true, "enabled": false}));
            }
            let hints = crate::commands::utility_peer_hints(&state);
            let pids: Vec<u32> = match state.open.lock() {
                Ok(mut open) => open
                    .list_with_peers(&hints)
                    .iter()
                    .filter(|p| p.alive)
                    .filter_map(|p| p.pid)
                    .collect(),
                Err(e) => return json_response(500, &json!({"ok": false, "error": e.to_string()})),
            };
            let proc = match state.perf.lock() {
                Ok(mut perf) => perf.sample_many(&pids),
                Err(e) => return json_response(500, &json!({"ok": false, "error": e.to_string()})),
            };
            let td = query_param(url, "td")
                .and_then(|p| crate::commands::run_utility_action(&state, &p, "perf", None).ok());
            json_response(200, &json!({"ok": true, "enabled": true, "proc": proc, "td": td}))
        }
        "/api/sessions/kill" => {
            let Some(pid) = body_json(request).and_then(|b| b.get("pid").and_then(|p| p.as_u64())) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.pid"}));
            };
            // Leaves a relaunchable tombstone for launcher AND external sessions.
            crate::commands::kill_and_tombstone(app, &state, pid as u32);
            json_response(200, &sessions_payload(&state))
        }
        "/api/sessions/dismiss" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path"}));
            };
            if let Ok(mut open) = state.open.lock() {
                open.forget_path(toe);
            }
            json_response(200, &sessions_payload(&state))
        }
        "/api/sessions/focus" => {
            let Some(pid) = body_json(request).and_then(|b| b.get("pid").and_then(|p| p.as_u64())) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.pid"}));
            };
            match crate::open_projects::focus_pid(pid as u32) {
                Ok(()) => json_response(200, &json!({"ok": true})),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        "/api/sessions/relaunch" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path"}));
            };
            let version_key = body.get("version_key").and_then(|v| v.as_str()).unwrap_or("");
            let use_touchplayer = body.get("use_touchplayer").and_then(|v| v.as_bool()).unwrap_or(false);
            let kill_first = body.get("kill_first").and_then(|v| v.as_bool()).unwrap_or(false);
            let pid = body.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32);
            // Re-derive the build from the .toe when the tombstone didn't record
            // one (externally-opened session).
            let result = crate::commands::ensure_version_key(app, &state, toe, version_key).and_then(
                |vk| crate::commands::relaunch_project(&state, toe, &vk, use_touchplayer, kill_first, pid),
            );
            match result {
                Ok(_) => json_response(200, &sessions_payload(&state)),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // Recent projects not currently running — the phone's launch list.
        "/api/recents" => json_response(200, &recents_payload(&state)),
        // Launch a project that isn't running. Version is resolved from the
        // .toe when the phone doesn't send one (the common case).
        "/api/launch" => {
            let Some(body) = body_json(request) else {
                return json_response(400, &json!({"ok": false, "error": "bad body"}));
            };
            let Some(toe) = body.get("path").and_then(|p| p.as_str()) else {
                return json_response(400, &json!({"ok": false, "error": "missing body.path"}));
            };
            let version_key = body.get("version_key").and_then(|v| v.as_str()).unwrap_or("");
            let use_touchplayer = body.get("use_touchplayer").and_then(|v| v.as_bool()).unwrap_or(false);
            // relaunch_project with kill_first=false / pid=None is just a launch
            // that registers the session — exactly what a fresh open needs.
            let result = crate::commands::ensure_version_key(app, &state, toe, version_key).and_then(
                |vk| crate::commands::relaunch_project(&state, toe, &vk, use_touchplayer, false, None),
            );
            match result {
                Ok(_) => json_response(200, &sessions_payload(&state)),
                Err(e) => json_response(502, &json!({"ok": false, "error": e})),
            }
        }
        // /api/sessions/action and /api/control/* are RETIRED (D5) —
        // retired_route() answers them 410 with what took the job, before
        // this match is reached. The session serves its own controls now.
        _ => json_response(404, &json!({"ok": false, "error": "unknown endpoint"})),
    }
}

/// The web app manifest, generated so the phone can install the remote as a
/// standalone home-screen app. Deliberately token-free: `start_url` is the
/// bare origin (browsers fetch a manifest without the Authorization header, so
/// embedding the token here would leak it). The page re-supplies the token
/// from localStorage when launched without the pairing hash — see
/// control-standalone.tsx.
fn manifest_json() -> Value {
    json!({
        "name": "TDXLU Remote",
        "short_name": "TDXLU",
        "start_url": ".",
        "scope": ".",
        "display": "standalone",
        "orientation": "portrait",
        "background_color": "#1a1a1e",
        "theme_color": "#1a1a1e",
        "icons": [
            { "src": "icon.png", "sizes": "128x128", "type": "image/png", "purpose": "any" },
            { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
        ]
    })
}

fn handle_static(app: &AppHandle, path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    // Served without auth (browsers fetch manifests unauthenticated); carries
    // no secret — see manifest_json.
    if path == "/manifest.webmanifest" {
        return Response::from_data(manifest_json().to_string().into_bytes())
            .with_header(header("Content-Type", "application/manifest+json"))
            .with_header(header("Cache-Control", "no-cache"));
    }
    let Some(dist) = dist_dir(app) else {
        // A packaged build gets dist from bundle.resources; a dev build falls
        // back to the repo. Neither present means a broken install, not a
        // missing `npm run build` — the old wording sent installed users off
        // to a repo they do not have. Name the probed path so the next report
        // is diagnosable on sight.
        let probed = app
            .path()
            .resolve("../dist", tauri::path::BaseDirectory::Resource)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<unresolved>".to_string());
        log::error!("control page assets missing; probed resource path: {probed}");
        return Response::from_data(
            format!(
                "TDX Launcher Ultra\n\n\
                 The control page assets are missing from this installation, so the phone \
                 panel cannot be served. Reinstalling should fix it.\n\n\
                 Probed: {probed}\n\n\
                 (Running from source? Run `npm run build` in the repo.)"
            )
            .into_bytes(),
        )
        .with_status_code(503)
        .with_header(header("Content-Type", "text/plain; charset=utf-8"));
    };
    let rel = static_rel(path);
    // Vite hashes asset filenames, so assets may cache forever; the HTML
    // entry must revalidate every load or browsers heuristically serve a
    // stale page (no-header 200s invite that) and CSS fixes never arrive.
    let cache = if rel.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    match resolve_static_file(&dist, rel).and_then(|f| std::fs::read(f).ok()) {
        Some(bytes) => Response::from_data(bytes)
            .with_header(header("Content-Type", content_type(rel)))
            .with_header(header("Cache-Control", cache)),
        None => Response::from_data(b"not found".to_vec())
            .with_status_code(404)
            .with_header(header("Content-Type", "text/plain")),
    }
}

/// The file a request path names, relative to `dist`.
fn static_rel(path: &str) -> &str {
    match path {
        "/" | "/index.html" | "/control.html" => "control.html",
        p => p.trim_start_matches('/'),
    }
}

/// Resolve `rel` to a real file inside `dist`, or `None` if it escapes, does
/// not exist, or is not a file.
///
/// This route is the ONE unauthenticated surface on the server — a browser has
/// to fetch the page before any script of ours can attach a bearer — so the
/// containment check here is the whole gate, and it gets two independent
/// layers because on Windows they catch different things.
///
/// 1. **Syntactic.** Reject `..` and empty segments, and reject ANY backslash.
///    The backslash is the one that bit: Windows treats `\` as a path
///    separator but a `split('/')` does not, so `..\..\..\Windows\win.ini`
///    looked like a single harmless *filename* to a `/`-only segment check
///    while `Path::join` read it as three levels up. tiny_http passes the
///    request target through verbatim (`client.rs`, `line.split(' ')`) — it
///    does not normalise `\` the way a browser does — so a raw HTTP client
///    could ask for exactly that. Percent-encoding is not a way around this:
///    the path is never percent-decoded, so `%2e%2e` stays a literal filename.
///
/// 2. **Semantic.** Canonicalise both sides and confirm the target is still
///    under `dist`. `Path::starts_with` compares whole components, so a
///    sibling `dist-old/` cannot pass as a prefix of `dist/`. This is what
///    catches anything layer 1 does not think of — symlinks, 8.3 short names,
///    a future refactor that reintroduces a gap.
///
/// Every failure returns `None` and the caller answers a plain 404: a refused
/// traversal is deliberately indistinguishable from a missing file, so probing
/// tells an attacker nothing about what exists or where the guard is.
fn resolve_static_file(dist: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty()
        || rel.contains('\\')
        || rel.split('/').any(|seg| seg == ".." || seg.is_empty())
    {
        return None;
    }
    let root = std::fs::canonicalize(dist).ok()?;
    let target = std::fs::canonicalize(dist.join(rel)).ok()?;
    (target.starts_with(&root) && target.is_file()).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This replaces `client_tier_route_gate` (the plan asked for it updated,
    /// not deleted). The client tier is gone; what this now pins is the D5
    /// rescope: the session half answers 410 with a pointer, and every route
    /// the fleet page actually needs still reaches the handler.
    ///
    /// A 410 matters more than a 404 here. A phone has the old page cached and
    /// a bookmark for it; "gone, and here is what took the job" is debuggable,
    /// a bare 404 reads as a broken launcher.
    #[test]
    fn retired_session_routes_answer_gone() {
        for gone in [
            "/api/control/schema",
            "/api/control/values",
            "/api/control/set",
            "/api/control/comps",
            "/api/control/add",
            "/api/control/remove",
            "/api/sessions/action",
            "/ws/touch",
        ] {
            let hint = retired_route(gone);
            assert!(hint.is_some(), "{gone} must answer 410, not 404");
            assert!(
                hint.unwrap().contains("FNS_Remote") || hint.unwrap().contains("session"),
                "{gone}: the hint must name what took the job"
            );
        }
        // The fleet route set (D5): process operations only the launcher can
        // perform, plus what the page needs to render. None may be retired.
        for kept in [
            "/api/app",
            "/api/sessions",
            "/api/sessions/kill",
            "/api/sessions/relaunch",
            "/api/sessions/dismiss",
            "/api/sessions/focus",
            "/api/sessions/perf",
            "/api/recents",
            "/api/launch",
            // The in-TD palette surface is a separate concern, out of D5 scope.
            "/api/palette/catalog",
            "/api/palette/session",
            "/api/palette/phone",
            "/api/palette/phone/enable",
            "/api/palette/media",
        ] {
            assert!(retired_route(kept).is_none(), "{kept} must still be served");
        }
    }

    /// Stop used to set a flag and return, leaving tiny_http's listener alive
    /// until the last worker happened to drop its `Arc<Server>` — in the field
    /// that was still bound hours later, and the next start died on the OS's
    /// "Only one usage of each socket address". The port is now released
    /// deterministically, and a start that still cannot bind must say WHY in
    /// our words: the raw OS text sends people hunting for another program
    /// when the holder is almost always our own previous server.
    #[test]
    fn bind_reports_a_held_port_in_our_own_words() {
        // Hold a port the way a not-yet-released server would.
        let hold = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fixture");
        let port = hold.local_addr().unwrap().port();

        let err = bind_within("127.0.0.1", port, Duration::from_millis(150))
            .err()
            .expect("a held port must not bind");
        assert!(err.contains("still held"), "says the port is held: {err}");
        assert!(err.contains("Settings"), "offers the way out: {err}");
        assert!(err.contains(&port.to_string()), "names the port: {err}");

        // And the moment it frees, the same call succeeds — this is the path a
        // stop-then-start takes once the workers have drained.
        drop(hold);
        assert!(
            bind_within("127.0.0.1", port, Duration::from_secs(2)).is_ok(),
            "a freed port binds again"
        );
    }

    /// A `dist/` with one asset, and a secret one level above it — the shape
    /// the traversal was reaching for.
    fn dist_fixture(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("tdxlu-static-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dist = base.join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::write(dist.join("control.html"), b"<html>").unwrap();
        std::fs::write(dist.join("assets").join("app-abc123.js"), b"//js").unwrap();
        std::fs::write(base.join("secret.txt"), b"GITHUB_TOKEN").unwrap();
        (base, dist)
    }

    /// The static route is unauthenticated, so this containment check IS the
    /// gate. The backslash cases are the regression: `split('/')` saw
    /// `..\..\secret.txt` as one innocent filename while `Path::join` walked
    /// out of `dist` with it on Windows.
    #[test]
    fn static_route_refuses_traversal() {
        let (base, dist) = dist_fixture("traversal");

        for ok in ["/", "/control.html", "/index.html", "/assets/app-abc123.js"] {
            assert!(
                resolve_static_file(&dist, static_rel(ok)).is_some(),
                "{ok} should be served"
            );
        }

        for bad in [
            // The bug: backslash separators, which only Windows honours.
            r"/..\secret.txt",
            r"/..\..\secret.txt",
            r"/assets\..\..\secret.txt",
            r"/..\..\..\Windows\win.ini",
            // Forward-slash traversal, which the original check did catch.
            "/../secret.txt",
            "/assets/../../secret.txt",
            // Percent-encoding is not decoded, so these are just filenames
            // that do not exist — but assert it, so a future decode step
            // cannot quietly open a hole.
            "/%2e%2e/secret.txt",
            "/..%5Csecret.txt",
            // Absolute paths and empty segments.
            "//secret.txt",
            r"/C:\Windows\win.ini",
            // A directory is not a file.
            "/assets",
        ] {
            assert!(
                resolve_static_file(&dist, static_rel(bad)).is_none(),
                "{bad} must be refused"
            );
        }

        // The secret really was reachable from dist by relative path — proving
        // the fixture models the risk rather than passing by accident.
        assert!(base.join("secret.txt").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A sibling directory sharing a name prefix must not pass containment.
    /// `Path::starts_with` compares components, so `dist-old` is not under
    /// `dist` — a naive string prefix check would have said otherwise.
    #[test]
    fn static_route_refuses_prefix_sibling_directory() {
        let (base, dist) = dist_fixture("sibling");
        let sibling = base.join("dist-old");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("stale.js"), b"//old").unwrap();

        assert!(
            resolve_static_file(&dist, static_rel("/../dist-old/stale.js")).is_none(),
            "a sibling sharing the dist prefix must be refused"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
