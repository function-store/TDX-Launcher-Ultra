//! In-TD palette tabs — the launcher's Palette / Patreon tabs inside
//! TouchDesigner's Palette Browser (see `docs/palette-tabs.md`).
//!
//! The companion (`TDXLUPalette`, utility ≥ 0.21.0) shows a page this app
//! serves on its loopback control server. This module is the launcher half:
//! handing every fresh companion the page URL over the bus (`palette_url`),
//! and the JSON the page reads — one catalog call, a "place this into the
//! session" verb that resolves any source (Toolbox tool, palette file, FNS
//! package, Patreon attachment, plain URL) to a local `.tox` and runs the same
//! `load_tox` the desktop Palette tab uses, the session's FNS_CommandRegistry
//! commands (list + run, the quick-launch `?` list next to the network), and
//! the companion update the desktop offers. The Patreon cookie never leaves
//! this process: the page asks us, we ask Patreon.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;

/// Third Vite entry (next to `control.html` / `quick.html`).
pub const PAGE: &str = "palette.html";

fn enabled(state: &AppState) -> bool {
    state
        .config
        .lock()
        .map(|c| c.config.palette_tabs_enabled)
        .unwrap_or(false)
}

/// RFC 3986 unreserved set stays; everything else is %XX. The session id is a
/// lowercased, forward-slashed `.toe` path — spaces and colons are the norm.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Loopback page URL for one session. `?sid=` names the hello id the page
/// addresses its place requests to. Starts the control server when it isn't
/// up (loopback unless the LAN setting is on — either way 127.0.0.1 answers).
pub fn page_url(app: &AppHandle, session_id: &str) -> Result<String, String> {
    let query = format!("sid={}", percent_encode(session_id));
    crate::control_server::loopback_page_url(app, PAGE, &query)
}

/// A companion just appeared (fresh hello). Hand it the page URL, off the bus
/// listener thread. Quiet no-op when the feature is off in Settings or the
/// utility predates the verb (it answers `unknown action`).
pub fn on_fresh_peer(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        // The hello arrives the moment the utility's cmd server bound; a
        // beat of slack keeps this from racing its first accept loop.
        std::thread::sleep(Duration::from_millis(400));
        match push_url(&app, &id) {
            Ok(_) => log::info!("palette tabs: handed the page URL to {id}"),
            Err(e) => log::info!("palette tabs: {id}: {e}"),
        }
    });
}

/// Send `palette_url` to one session (also the manual "reconnect" path).
pub fn push_url(app: &AppHandle, id: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    if !enabled(&state) {
        return Err("palette tabs are off in Settings".into());
    }
    let url = page_url(app, id)?;
    crate::commands::utility_call_unlocked(
        &state,
        id,
        None,
        "palette_url",
        Some(&json!({ "url": url })),
        std::time::Duration::from_secs(5),
    )
}

/// Everything the page needs in one round trip. With a session id the reply
/// also carries `companion` — that session's utility version against the one
/// this launcher hands out — so the page can offer the in-place update.
pub fn catalog(app: &AppHandle, session: Option<&str>) -> Result<Value, String> {
    let state = app.state::<AppState>();
    // No palette-folder scan: TD's own palette is one tab over in the same
    // dialog, so the page only carries what TD doesn't have (Toolbox, FNS).
    let (toolbox, fns_base, patreon_connected, patreon_trust_ack, theme) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (
            crate::commands::build_toolbox_view(&cfg.config),
            cfg.config.fns_base_url.clone(),
            !cfg.config.patreon_session_cookie.trim().is_empty(),
            cfg.config.patreon_trust_ack,
            cfg.config.theme.clone(),
        )
    };
    // Cache-first; a cold cache with no network is simply "no shelf".
    let (fns, fns_error) = match crate::fns_store::get_manifest(&fns_base, false) {
        Ok(info) => (serde_json::to_value(info).ok(), None),
        Err(e) => (None, Some(e)),
    };
    let fns_store = crate::fns_store::store_status(None);
    let companion = session.map(|sid| companion_status(app, sid));
    let license = crate::licensing::status();
    Ok(json!({
        "ok": true,
        "theme": theme,
        // What the claim names — the FNS shelf's Plus rail reads it exactly as
        // the desktop FNSTools tab does: a gated package the claim does not
        // name renders locked.
        "products": license.products,
        "patreon_enabled": cfg!(feature = "patreon"),
        "patreon_connected": patreon_connected,
        "patreon_trust_ack": patreon_trust_ack,
        "toolbox": toolbox,
        "fns": fns,
        "fns_error": fns_error,
        "fns_store": fns_store,
        "companion": companion,
    }))
}

// --- Companion update notice ----------------------------------------------

/// `{session_version, available_version, update_available}` for one session.
/// `session_version` is null when the peer is gone or predates versioning —
/// then there is nothing to compare and no notice.
pub fn companion_status(app: &AppHandle, session: &str) -> Value {
    let state = app.state::<AppState>();
    let session_version = state
        .watch
        .lock()
        .ok()
        .and_then(|w| w.peer_utility_version(session));
    let available = crate::updates::effective_utility_version(app);
    let update_available = session_version
        .as_deref()
        .map(|v| crate::updates::cmp_version(&available, v) == std::cmp::Ordering::Greater)
        .unwrap_or(false);
    json!({
        "session_version": session_version,
        "available_version": available,
        "update_available": update_available,
    })
}

/// The desktop's "Update utility" for one session: refresh the palette copy
/// of the effective TOX (stable path, overwritten to current), then have the
/// utility repoint its External .tox there and reload in place. The session
/// hellos again afterwards and gets the page URL re-pushed, so the page stays.
pub fn update_companion(app: &AppHandle, session: &str) -> Result<Value, String> {
    let dest = crate::commands::install_bundled_utility_cmd(app.clone())?;
    let state = app.state::<AppState>();
    let mut result = crate::commands::run_utility_action(
        &state,
        session,
        "update_utility",
        Some(&json!({ "path": dest })),
    )?;
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "version".into(),
            Value::String(crate::updates::effective_utility_version(app)),
        );
    }
    Ok(result)
}

// --- Tool commands (FNS_CommandRegistry) ---------------------------------

/// The project-stable curation key of a wire command: `tool#id`.
fn command_identity(c: &Value) -> String {
    format!(
        "{}#{}",
        c.get("tool").and_then(|t| t.as_str()).unwrap_or(""),
        c.get("id").and_then(|i| i.as_str()).unwrap_or("")
    )
}

/// The session's registered tool commands (`fns_commands`), curated the way
/// the quick-launch curates them: the user's shown/hidden lists (keyed on the
/// project-stable `tool#id`) beat the tool's own `hidden` default. Each
/// command also carries the user's `favorite` flag. `all` skips the
/// curation -- for capability lookups, which must see hidden commands.
pub fn commands(app: &AppHandle, session: &str, all: bool) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (shown, hidden, favorites) = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        (
            cfg.config.quick_shown_commands.clone(),
            cfg.config.quick_hidden_commands.clone(),
            cfg.config.quick_favorite_commands.clone(),
        )
    };
    let reply = crate::commands::run_utility_action(&state, session, "fns_commands", None)?;
    if reply.get("ok").and_then(|o| o.as_bool()) == Some(false) {
        let why = reply
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("fns_commands failed");
        return Err(why.to_string());
    }
    let visible = |c: &Value| -> bool {
        if all {
            return true;
        }
        let identity = command_identity(c);
        if shown.iter().any(|s| s == &identity) {
            return true;
        }
        if hidden.iter().any(|h| h == &identity) {
            return false;
        }
        !c.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false)
    };
    let commands: Vec<Value> = reply
        .get("commands")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|c| visible(c))
                .map(|c| {
                    let mut c = c.clone();
                    let fav = favorites.iter().any(|f| f == &command_identity(&c));
                    if let Some(obj) = c.as_object_mut() {
                        obj.insert("favorite".into(), Value::Bool(fav));
                    }
                    c
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "ok": true,
        "rev": reply.get("rev").cloned().unwrap_or(Value::Null),
        "commands": commands,
    }))
}

/// Pin / unpin a command (`tool#id`) from the page. One source of truth —
/// the launcher config — so the quick-launch and Settings see the same
/// list; the main window is told to re-read its config when it changed.
pub fn set_favorite(app: &AppHandle, identity: &str, favorite: bool) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (changed, favorites) = {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        let changed = cfg.set_command_favorite(identity, favorite)?;
        (changed, cfg.config.quick_favorite_commands.clone())
    };
    if changed {
        let _ = app.emit(
            "prefs-changed",
            json!({ "quick_favorite_commands": favorites }),
        );
    }
    Ok(json!({
        "ok": true,
        "identity": identity.trim(),
        "favorite": favorite,
        "changed": changed,
        "favorites": favorites,
    }))
}

/// Record that the user dismissed the "a .tox runs the creator's code" warning.
/// Shared with the launcher window through `prefs-changed`, so dismissing it in
/// TD's palette also settles it there (and the other way round).
pub fn set_patreon_trust_ack(app: &AppHandle, ack: bool) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let changed = {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        if cfg.config.patreon_trust_ack == ack {
            false
        } else {
            cfg.config.patreon_trust_ack = ack;
            cfg.save()?;
            true
        }
    };
    if changed {
        let _ = app.emit("prefs-changed", json!({ "patreon_trust_ack": ack }));
    }
    Ok(json!({ "ok": true, "patreon_trust_ack": ack, "changed": changed }))
}

/// Run one registered command in the session (`fns_run_command`). `kwargs`
/// values cross as strings; the registry coerces them by declared style.
pub fn run_command(
    app: &AppHandle,
    session: &str,
    key: &str,
    kwargs: Option<&Value>,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let mut payload = json!({ "key": key });
    if let Some(kw) = kwargs.filter(|k| k.as_object().map(|o| !o.is_empty()).unwrap_or(false)) {
        payload["kwargs"] = kw.clone();
    }
    crate::commands::run_utility_action(&state, session, "fns_run_command", Some(&payload))
}

fn str_field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing source.{key}"))
}

/// Turn a page-side source descriptor into a local `.tox` path, fetching
/// where the desktop would (tox cache, FNS store, Patreon download cache).
pub fn resolve_source(app: &AppHandle, source: &Value) -> Result<String, String> {
    let state = app.state::<AppState>();
    let kind = source.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    match kind {
        "local" => {
            let path = str_field(source, "path")?;
            if Path::new(path).is_file() {
                Ok(path.replace('\\', "/"))
            } else {
                Err(format!("file not found: {path}"))
            }
        }
        "toolbox" => {
            let id = str_field(source, "id")?;
            let (tool_kind, tool_source, cached, token) = {
                let cfg = state.config.lock().map_err(|e| e.to_string())?;
                let tool = cfg
                    .config
                    .toolbox_tools
                    .iter()
                    .find(|t| t.id == id)
                    .ok_or_else(|| "Toolbox tool not found".to_string())?;
                let t = cfg.config.github_token.trim().to_string();
                (
                    tool.kind.clone(),
                    tool.source.clone(),
                    tool.cached_path.clone(),
                    (!t.is_empty()).then_some(t),
                )
            };
            match tool_kind.as_str() {
                "local" => {
                    if Path::new(&tool_source).is_file() {
                        Ok(tool_source.replace('\\', "/"))
                    } else {
                        Err("this tool's file is missing on disk".into())
                    }
                }
                "url" => {
                    // An already-cached tool places from the cache; only a
                    // missing one is fetched.
                    if let Some(p) = cached.filter(|p| Path::new(p).is_file()) {
                        return Ok(p);
                    }
                    let result =
                        crate::tox_cache::cache_tox_from_source(&tool_source, token.as_deref())?;
                    let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
                    cfg.toolbox_set_cached_path(id, &result.path)?;
                    Ok(result.path)
                }
                _ => Err("Package tools install from the desktop Companion bar (From package…)".into()),
            }
        }
        "url" => {
            let url = str_field(source, "url")?;
            let token = {
                let cfg = state.config.lock().map_err(|e| e.to_string())?;
                let t = cfg.config.github_token.trim().to_string();
                (!t.is_empty()).then_some(t)
            };
            Ok(crate::tox_cache::cache_tox_from_source(url, token.as_deref())?.path)
        }
        "fns" => {
            let name = str_field(source, "name")?;
            if name.contains(['/', '\\', ':']) {
                return Err("bad package name".into());
            }
            let path = crate::fns_store::store_dir().join(format!("{name}.tox"));
            if !path.is_file() {
                let base = {
                    let cfg = state.config.lock().map_err(|e| e.to_string())?;
                    cfg.config.fns_base_url.clone()
                };
                crate::fns_store::sync_store(&base, Some(&[name.to_string()]), false, |_| {})?;
            }
            if path.is_file() {
                Ok(path.to_string_lossy().replace('\\', "/"))
            } else {
                Err(format!("{name}.tox did not land in the FNS store"))
            }
        }
        "patreon" => {
            let url = str_field(source, "url")?.to_string();
            let filename = str_field(source, "filename")?.to_string();
            let campaign = source
                .get("campaign")
                .and_then(|c| c.as_str())
                .unwrap_or("Patreon")
                .to_string();
            let (cookie, root) = {
                let cfg = state.config.lock().map_err(|e| e.to_string())?;
                (
                    cfg.config.patreon_session_cookie.clone(),
                    cfg.config.patreon_download_root.clone(),
                )
            };
            crate::proc::off_runtime(move || {
                crate::patreon::download_tox(&cookie, &url, &filename, &root, &campaign)
            })
        }
        other => Err(format!("unknown source kind: {other:?}")),
    }
}

/// Resolve, then land in the session — the page's ↳ button and the desktop
/// shelf's place action.
///
/// An FNS package goes where its manifest row says (`placement`): `pane` and
/// `none` drop into the current pane as a frozen instance via `load_tox`;
/// `root` and absent are installs and are handed to FNS_Installer with a
/// minimal one-package selection (additive, never removes, records the
/// install so updates and removal see it; drops the bootstrap first when the
/// project has no toolkit root). Everything else places via `load_tox`.
pub fn place(app: &AppHandle, session: &str, source: &Value) -> Result<Value, String> {
    let path = resolve_source(app, source)?;
    if source.get("kind").and_then(|k| k.as_str()) == Some("fns") {
        let name = str_field(source, "name")?;
        let base = {
            let state = app.state::<AppState>();
            let cfg = state.config.lock().map_err(|e| e.to_string())?;
            cfg.config.fns_base_url.clone()
        };
        let placement = crate::fns_store::get_manifest(&base, false)
            .ok()
            .and_then(|info| {
                crate::fns_store::package_row(&info.manifest, name)
                    .and_then(crate::fns_store::package_placement)
                    .map(str::to_string)
            });
        if !crate::fns_store::placement_lands_in_pane(placement.as_deref()) {
            return install_package(app, session, name, placement.as_deref());
        }
    }
    let persist = source
        .get("persist")
        .and_then(|p| p.as_bool())
        .unwrap_or(false);
    let state = app.state::<AppState>();
    let mut result = crate::commands::run_utility_action(
        &state,
        session,
        "load_tox",
        Some(&json!({ "path": path, "persist": persist })),
    )?;
    if let Some(obj) = result.as_object_mut() {
        obj.insert("resolved_path".into(), Value::String(path));
    }
    Ok(result)
}

/// Install one FNS package through the toolkit's own installer: a minimal
/// selection naming just it, handed to the companion's `fns_install` verb.
/// The store already holds the artifact (resolve ran first).
fn install_package(
    app: &AppHandle,
    session: &str,
    name: &str,
    placement: Option<&str>,
) -> Result<Value, String> {
    let selection = crate::fns_store::write_selection(&[name.to_string()], true)?;
    let state = app.state::<AppState>();
    // The rail the companion may drop must be the bucket's current one, not
    // whatever this build was frozen with — see fns_store::refresh_rails.
    let base = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.fns_base_url.clone()
    };
    crate::fns_store::refresh_rails(&base);
    let bootstrap = crate::fns_store::effective_bootstrap(app).ok_or_else(|| {
        "No FNSTools bootstrap available — refresh the store once while online.".to_string()
    })?;
    log::info!("fns install: {name} into {session} (selection {selection}, bootstrap {bootstrap})");
    let mut result = crate::commands::run_utility_action(
        &state,
        session,
        "fns_install",
        Some(&json!({ "selection": selection, "bootstrap": bootstrap })),
    )?;
    log::info!("fns install: {name} → {result}");
    if let Some(obj) = result.as_object_mut() {
        obj.insert("installed".into(), Value::Bool(true));
        obj.insert("package".into(), Value::String(name.to_string()));
        obj.insert(
            "placement".into(),
            placement.map(|p| Value::String(p.to_string())).unwrap_or(Value::Null),
        );
    }
    Ok(result)
}

// --- Add to the user's TD palette -------------------------------------------

/// One safe path segment from a creator's display name: no separators (it
/// must not smuggle in extra directory levels), no Windows-illegal
/// characters, trimmed, capped, never empty. Mirrors the desktop's
/// `sanitizeFolderName` so the same creator lands in the same folder from
/// either surface (patreon.rs keeps its own copy behind the patreon feature).
fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\'))
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let cleaned: String = cleaned.chars().take(100).collect();
    if cleaned.is_empty() {
        "creator".into()
    } else {
        cleaned
    }
}

/// Resolve a page-side source and copy its `.tox` into the user's TD palette,
/// where TouchDesigner's own Palette Browser will show it — no session
/// involved. This is the page's half of the desktop's right-click
/// "Add to Palette…", and lands in the same per-creator folder.
///
/// Unlike the desktop's drag-import, a file already sitting in the
/// destination is reported rather than copied again: this hangs off a
/// context menu that is easy to hit twice, and `unique_dest_path` would
/// answer that with `name_1.tox`, `name_2.tox` ...
///
/// With a session id, it also asks that session to reload paletteData.json
/// so the new component shows up in TD's Palette tab straight away. That is
/// a courtesy, not the job: a session that is gone or busy never fails the
/// add, it just leaves `refreshed` false.
pub fn add_to_palette(
    app: &AppHandle,
    source: &Value,
    session: Option<&str>,
) -> Result<Value, String> {
    let path = resolve_source(app, source)?;
    let raw = source
        .get("folder")
        .or_else(|| source.get("campaign"))
        .and_then(|f| f.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let folder = if raw.is_empty() {
        None
    } else {
        Some(sanitize_folder_name(&raw))
    };

    let file_name = Path::new(&path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut dest_dir = crate::palette::default_user_palette_dir();
    if let Some(f) = folder.as_deref() {
        dest_dir.push(f);
    }
    let existing = dest_dir.join(&file_name);
    if !file_name.is_empty() && existing.is_file() {
        return Ok(json!({
            "ok": true,
            "already": true,
            "path": existing.to_string_lossy().replace('\\', "/"),
            "dest_dir": dest_dir.to_string_lossy().replace('\\', "/"),
            "name": file_name,
        }));
    }

    let res = crate::palette::import_tox_to_user_palette(&[path.clone()], folder.as_deref())?;
    let Some(added) = res.copied.first().cloned() else {
        return Err(res
            .skipped
            .into_iter()
            .next()
            .unwrap_or_else(|| "nothing was copied".into()));
    };
    // Courtesy refresh: TD reads paletteData.json on start and never again,
    // so without this the .tox is on disk but not in the tree until restart.
    let refreshed = session
        .map(|toe| {
            let state = app.state::<AppState>();
            crate::commands::run_utility_action(&state, toe, "palette_refresh", None)
                .map(|r| r.get("ok").and_then(|o| o.as_bool()).unwrap_or(false))
                .unwrap_or(false)
        })
        .unwrap_or(false);

    Ok(json!({
        "ok": true,
        "already": false,
        "path": added.replace('\\', "/"),
        "dest_dir": res.dest_dir.replace('\\', "/"),
        "name": file_name,
        "palette_data_updated": res.palette_data_updated,
        "refreshed": refreshed,
        "skipped": res.skipped,
    }))
}

// --- Pin the selected COMP to the Toolbox ----------------------------------

/// Where pinned components are saved: a folder of the user's TD palette, so
/// they also show in TD's own palette ("My Components") and outlive the
/// launcher's config.
fn pinned_tox_dir() -> std::path::PathBuf {
    crate::palette::default_user_palette_dir().join("TDXLU Toolbox")
}

/// The inverse of ↳: have the session save its selected COMP as a `.tox`
/// (`toolbox_save_selected`), then pin that file as a local Toolbox tool.
/// A file already pinned is not pinned twice.
pub fn pin_selected(
    app: &AppHandle,
    session: &str,
    category: &str,
    label: &str,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let dir = pinned_tox_dir().to_string_lossy().replace('\\', "/");
    let reply = crate::commands::run_utility_action(
        &state,
        session,
        "toolbox_save_selected",
        Some(&json!({ "dir": dir, "name": label })),
    )?;
    if reply.get("ok").and_then(|o| o.as_bool()) == Some(false) {
        let why = reply
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("save failed");
        return Err(why.to_string());
    }
    let path = reply
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "the utility returned no .tox path".to_string())?
        .to_string();
    let name = reply
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let (id, already) = {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        let norm = path.to_lowercase();
        match cfg.config.toolbox_tools.iter().find(|t| {
            t.kind == "local" && t.source.replace('\\', "/").to_lowercase() == norm
        }) {
            Some(t) => (t.id.clone(), true),
            None => (
                cfg.toolbox_add_tool(&name, "local", &path, category, "Pinned from TouchDesigner")?,
                false,
            ),
        }
    };
    // The file landed inside the user palette: refresh TD's index of it.
    let _ = crate::palette::rebuild_user_palette_data(&crate::palette::default_user_palette_dir());
    Ok(json!({
        "ok": true,
        "id": id,
        "path": path,
        "name": name,
        "comp": reply.get("comp").cloned().unwrap_or(Value::Null),
        "selected": reply.get("selected").cloned().unwrap_or(Value::Null),
        "already_pinned": already,
    }))
}

// --- Session bar ---------------------------------------------------------------

/// The Companion-bar verbs the page's session bar exposes — all FREE, same
/// as the desktop (`open_project_utility_cmd`): the companion verb surface
/// is ungated since docs/fns-plus-capabilities.md D3 (2026-08-31); pro
/// capability gates at Plus-package stocking, not at the verb.
///
/// Every verb here is one the companion still implements. The autosave,
/// collect and media verbs D7 retired are gone from the list AND from the
/// page: the session bar reads FNS_Autosave, and the Collect and Media
/// drawers drive FNS_Collect and FNS_MediaBrowser, over `/api/palette/run`.
/// `repoint_assets` stays because re-rooting really is still the companion's
/// own job — the Media drawer deliberately mixes the two rails.
///
/// Keep this list and `TDXLUUtilityExt`'s dispatch in step. A verb allowed
/// here but absent there fails at the far end, where a caller sees a generic
/// error rather than "this moved to a package".
const SESSION_ACTIONS: &[&str] = &[
    "save",
    "pulse",
    "record",
    "repoint_assets",
    "selection",
    "control_schema",
    "control_comps",
    "control_add",
    "control_remove",
    "windows",
    "window_set",
    "window_apply",
    "window_save",
    "window_clear",
];

pub fn session_action(
    app: &AppHandle,
    session: &str,
    action: &str,
    payload: Option<&Value>,
) -> Result<Value, String> {
    if !SESSION_ACTIONS.contains(&action) {
        return Err(format!("action must be one of {}", SESSION_ACTIONS.join("|")));
    }
    let state = app.state::<AppState>();
    crate::commands::run_utility_action(&state, session, action, payload)
}

// --- OS windows of the session (the desktop's Windows feature) ---------------

/// The session's real OS windows — main window, torn-off panes, the perform
/// window — labelled by what each pane shows when the companion answers
/// `panes`. Same enumeration the desktop's session rows and the quick-launch
/// drill-in use.
pub fn os_windows(app: &AppHandle, session: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let hints = crate::commands::utility_peer_hints(&state);
    let pids: Vec<u32> = {
        let mut open = state.open.lock().map_err(|e| e.to_string())?;
        match open.known_pid_for_path(session) {
            Some(p) => vec![p],
            None => {
                let norm = session.replace('\\', "/").to_lowercase();
                open.list_with_peers(&hints)
                    .iter()
                    .filter(|p| p.alive && p.path.replace('\\', "/").to_lowercase() == norm)
                    .filter_map(|p| p.pid)
                    .collect()
            }
        }
    };
    if pids.is_empty() {
        return Err("no live process for this session".into());
    }
    let mut windows = crate::session_windows::list_for_pids(&pids);
    if crate::session_windows::has_pane_candidates(&windows) {
        if let Ok(panes) = crate::commands::utility_call_unlocked(
            &state,
            session,
            pids.first().copied(),
            "panes",
            None,
            std::time::Duration::from_millis(1500),
        ) {
            crate::session_windows::label_from_panes(&mut windows, &panes);
        }
    }
    Ok(json!({ "ok": true, "pid": pids[0], "windows": windows }))
}

/// One window: `focus` | `minimize` | `restore`; or the whole session with
/// `pid`: `raise` | `minimize`. Paid tier, like the desktop commands.
pub fn os_window_action(id: Option<i64>, pid: Option<u32>, action: &str) -> Result<Value, String> {
    match (id, pid, action) {
        (Some(id), _, "focus") => crate::session_windows::focus(id)?,
        (Some(id), _, "minimize") => crate::session_windows::minimize(id)?,
        (Some(id), _, "restore") => crate::session_windows::restore(id)?,
        (None, Some(pid), "raise") => crate::session_windows::raise_session(pid)?,
        (None, Some(pid), "minimize") => crate::session_windows::minimize_session(pid)?,
        (_, _, other) => return Err(format!("unknown window action {other:?} (focus|minimize|restore with id, raise|minimize with pid)")),
    }
    Ok(json!({ "ok": true }))
}

// --- Phone Remote from inside TD ---------------------------------------------

/// Whether the control server is reachable from a phone right now, and the
/// client-tier link if so. Never starts or rebinds anything.
pub fn phone_info(app: &AppHandle, session: Option<&str>) -> Result<Value, String> {
    let state = app.state::<AppState>();
    // The session's own remote first (docs/fns-remote.md §9): the tab runs
    // inside that session, so its QR is the right one. The launcher's own
    // server below is the fallback until D5 retires it.
    if let Some(sid) = session {
        if let Some(remote) = crate::remote_handoff::remote_info(&state, sid) {
            let lan = remote["lan"].as_bool().unwrap_or(false);
            return Ok(json!({
                "ok": true,
                "source": "fns_remote",
                "running": remote["active"].as_bool().unwrap_or(false),
                "lan": lan,
                "setting_lan": lan,
                "url": remote["url"],
                "client_url": remote["client_url"],
                "loopback_url": remote["loopback_url"],
                "paired": remote["paired"],
                "client_touch": remote["client_touch"],
            }));
        }
    }
    let setting_lan = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.control_server_lan
    };
    let running = crate::control_server::phone_url_if_running(app)?;
    let (url, lan) = match &running {
        Some((url, lan)) => (Some(url.clone()), *lan),
        None => (None, false),
    };
    Ok(json!({
        "ok": true,
        "source": "launcher",
        "running": running.is_some(),
        "lan": lan,
        "setting_lan": setting_lan,
        "url": if lan { url } else { None },
    }))
}

/// The one-tap "turn on Phone Remote". A session carrying FNS_Remote gets
/// its own pairing flow: the package's `remote` command starts serving and
/// shows its QR in TouchDesigner — putting it on the LAN stays the explicit
/// act the package requires, made there. Otherwise the launcher's control
/// server binds to the LAN (persisting the setting, like the desktop's
/// Phone button) and returns the client link.
pub fn phone_enable(app: &AppHandle, session: Option<&str>) -> Result<Value, String> {
    if let Some(sid) = session {
        let state = app.state::<AppState>();
        if let Some(key) = crate::remote_handoff::command_key(&state, sid, "remote") {
            let reply = run_command(app, sid, &key, None)?;
            if reply.get("ok").and_then(|o| o.as_bool()) == Some(false) {
                let why = reply.get("error").and_then(|e| e.as_str()).unwrap_or("pairing failed");
                return Err(why.to_string());
            }
            crate::remote_handoff::forget(sid);
            let mut info = phone_info(app, Some(sid))?;
            info["opened_pairing"] = json!(true);
            return Ok(info);
        }
    }
    let url = crate::control_server::phone_url(app)?;
    Ok(json!({ "ok": true, "source": "launcher", "running": true, "lan": true, "url": url }))
}

// --- Git quick-commit --------------------------------------------------------

/// Branch, dirty counts and the summary of the session's project repo (the
/// `.toe`'s folder, or the work tree it sits in).
pub fn git_status(session: &str) -> Result<Value, String> {
    let s = crate::git::git_status(session)?;
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// Save the project in the session first (optional), then `git add -A` +
/// commit in its repo — the desktop Git panel's pair, one click from inside
/// TD.
pub fn git_commit(
    app: &AppHandle,
    session: &str,
    message: &str,
    save_first: bool,
) -> Result<Value, String> {
    if save_first {
        let state = app.state::<AppState>();
        let r = crate::commands::run_utility_action(&state, session, "save", None)?;
        if r.get("ok").and_then(|o| o.as_bool()) == Some(false) {
            let why = r.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
            return Err(format!("save failed: {why}"));
        }
    }
    let s = crate::git::git_commit(session, message, true)?;
    serde_json::to_value(s).map_err(|e| e.to_string())
}

// --- Backup now ----------------------------------------------------------------

fn backup_prefs(state: &AppState) -> Result<(String, crate::backup::BackupFilters), String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    let c = &cfg.config;
    Ok((
        c.backup_root.clone(),
        crate::backup::BackupFilters::from_prefs(
            &c.backup_exclude,
            &c.backup_include,
            c.backup_max_file_mb,
        )
        .respecting_gitignore(c.backup_respect_gitignore)
        .skipping_td_backups(c.backup_skip_td_backups),
    ))
}

/// Destination and what a `backup` run would copy — the confirmation line
/// the page shows before running. Local folder backups only; cloud remotes
/// stay a desktop flow (they need the rclone remote picker).
pub fn backup_info(app: &AppHandle, session: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (root, filters) = backup_prefs(&state)?;
    let info = crate::backup::backup_target_info(session, &root, None, &filters)?;
    let plan = crate::backup::backup_plan(session, &root, "backup", None, &filters)?;
    Ok(json!({
        "ok": true,
        "remote_root": plan.remote_root,
        "remote_exists": info.remote_exists,
        "local_file_count": info.local_file_count,
        "to_remote": plan.to_remote,
        "skipped": plan.skipped,
        "filtered": plan.filtered,
        "summary": plan.summary,
        "gitignore_active": plan.gitignore_active,
    }))
}

/// Run a `backup` (project → backup root, never the other way) to the
/// configured folder.
pub fn backup_run(app: &AppHandle, session: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (root, filters) = backup_prefs(&state)?;
    let result = crate::backup::backup_run(session, &root, "backup", None, &filters, |_, _, _| {})?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

// --- Patreon over HTTP: the desktop commands, minus the Tauri envelope ----

fn patreon_cookie(state: &AppState) -> Result<String, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.config.patreon_session_cookie.clone())
}

/// Creators the account supports plus the hand-added ones — same merge as
/// `patreon_list_campaigns_cmd`.
pub fn patreon_campaigns(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
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
    let list = match found {
        Ok(mut list) => {
            for m in manual {
                if !list.iter().any(|c| c.id == m.id) {
                    list.push(m);
                }
            }
            crate::commands::add_featured_creator(&state, &cookie, &mut list);
            list
        }
        Err(e) if manual.is_empty() => return Err(e),
        Err(_) => manual,
    };
    serde_json::to_value(list).map_err(|e| e.to_string())
}

/// `campaign_name` is only used to file the listing in the search index under
/// a human name; the fetch itself needs the id alone.
pub fn patreon_posts(
    app: &AppHandle,
    campaign_id: &str,
    campaign_name: Option<&str>,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let cookie = patreon_cookie(&state)?;
    let id = campaign_id.to_string();
    let posts = crate::proc::off_runtime(move || crate::patreon::list_tox_posts(&cookie, &id))?;
    // Same snapshot the desktop takes: one listing, both surfaces searchable.
    crate::patreon_index::record(
        campaign_id,
        campaign_name.unwrap_or(campaign_id),
        &posts,
    );
    serde_json::to_value(posts).map_err(|e| e.to_string())
}

/// The one scheme `open_url` will hand to the OS. The opener passes the string
/// to the shell, where a `file:` path or a custom scheme LAUNCHES something —
/// the desktop window's `open_url` command trusts its own UI, but this is an
/// HTTP route, so it opens web pages and nothing else.
fn is_openable_web_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://")
        && lower.len() > "https://".len()
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Open a web page in the system browser for the in-TD page — a locked
/// Patreon post, the Plus tier's support page. The page renders offscreen in
/// TouchDesigner's CEF, so it has no browser of its own to send anyone to.
pub fn open_url(url: &str) -> Result<Value, String> {
    let url = url.trim();
    if !is_openable_web_url(url) {
        return Err("only https:// pages can be opened from the palette".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true }))
}

/// Name-search everything cached, across every creator. Local only; the page
/// calls this on every keystroke.
pub fn patreon_search(app: &AppHandle, query: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let root = {
        let cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.config.patreon_download_root.clone()
    };
    serde_json::to_value(crate::patreon_index::search_result(query, &root))
        .map_err(|e| e.to_string())
}

pub fn patreon_post(app: &AppHandle, post_id: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let cookie = patreon_cookie(&state)?;
    let id = post_id.to_string();
    let detail = crate::proc::off_runtime(move || crate::patreon::get_post_detail(&cookie, &id))?;
    serde_json::to_value(detail).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_survive_the_query_string() {
        assert_eq!(
            percent_encode("c:/shows/my show.toe"),
            "c%3A%2Fshows%2Fmy%20show.toe"
        );
        assert_eq!(percent_encode("plain-id_1.toe"), "plain-id_1.toe");
    }

    #[test]
    fn unknown_source_kinds_are_refused_before_any_io() {
        // No AppHandle needed to reject the shape: the kind check is first.
        let v = json!({"kind": "ftp", "path": "x"});
        assert_eq!(v.get("kind").and_then(|k| k.as_str()), Some("ftp"));
        assert!(str_field(&v, "url").is_err());
        assert_eq!(str_field(&v, "path").unwrap(), "x");
    }

    #[test]
    fn open_url_takes_web_pages_only() {
        assert!(is_openable_web_url("https://www.patreon.com/posts/123"));
        assert!(is_openable_web_url("HTTPS://example.com/x?y=1"));
        // Anything the shell would LAUNCH rather than browse.
        assert!(!is_openable_web_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_openable_web_url("C:\\Windows\\System32\\calc.exe"));
        assert!(!is_openable_web_url("ms-settings:privacy"));
        assert!(!is_openable_web_url("javascript:alert(1)"));
        // Plain http and degenerate / smuggled forms.
        assert!(!is_openable_web_url("http://example.com"));
        assert!(!is_openable_web_url("https://"));
        assert!(!is_openable_web_url("https://example.com/a b"));
        assert!(!is_openable_web_url("https://example.com/\n&calc"));
    }
}
