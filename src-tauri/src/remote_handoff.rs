//! The fleet hand-off: what a session's own FNS_Remote is serving, read over
//! the loopback bus (docs/fns-plus-capabilities.md D5, docs/fns-remote.md §9).
//!
//! The launcher owns no phone page for a session any more; the package inside
//! the session does. This module asks that package, through the command
//! registry, for its hidden `info` command (`fns.mobile-control`) and shapes
//! the reply for two consumers: the fleet page's `/api/sessions` rows (open
//! the author or client link per session) and the in-TD palette tab's Phone
//! drawer (the session's own QR instead of the launcher's).
//!
//! Two bus round-trips per lookup (`fns_commands` to find the key, then
//! `fns_run_command`), so answers are cached briefly per session: the fleet
//! page polls, and a link does not change between polls.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::commands::{run_utility_action, AppState};

const CAPABILITY: &str = "fns.mobile-control";
const TTL: Duration = Duration::from_secs(3);

type Cache = Mutex<HashMap<String, (Instant, Option<Value>)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn norm(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// The registry key (`<owner path>#<id>`) of one `fns.mobile-control`
/// command in the session, or None when the package is not there.
pub fn command_key(state: &AppState, path: &str, id: &str) -> Option<String> {
    let reply = run_utility_action(state, path, "fns_commands", None).ok()?;
    reply
        .get("commands")?
        .as_array()?
        .iter()
        .find(|c| {
            c.get("capability").and_then(|v| v.as_str()) == Some(CAPABILITY)
                && c.get("id").and_then(|v| v.as_str()) == Some(id)
        })
        .and_then(|c| c.get("key"))
        .and_then(|k| k.as_str())
        .map(str::to_string)
}

/// Shape the package's `info` reply for our consumers.
///
/// `url` / `client_url` are present only when the server is up AND on the
/// LAN: a loopback-only link is one a phone cannot reach, so it rides as
/// `loopback_url` instead and `state` says why there is nothing to scan.
pub fn shape(info: &Value) -> Value {
    let active = info.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
    let lan = info.get("lan").and_then(|v| v.as_bool()).unwrap_or(false);
    let url = info.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let client_url = info.get("client_url").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let reachable = active && lan;
    json!({
        "present": true,
        "active": active,
        "lan": lan,
        "state": if !active { "off" } else if lan { "lan" } else { "loopback" },
        "url": if reachable { url } else { None },
        "client_url": if reachable { client_url } else { None },
        "loopback_url": if active && !lan { url } else { None },
        "paired": info.get("paired").cloned().unwrap_or(Value::Null),
        "client_touch": info.get("client_touch").cloned().unwrap_or(Value::Null),
        "port": info.get("port").cloned().unwrap_or(Value::Null),
        // The extension's own constant, NOT the package's Pkgversion (0.1.0
        // against a released 3.2.0 at the time of writing). Informational
        // only — never compare it against a manifest version.
        "version": info.get("version").cloned().unwrap_or(Value::Null),
    })
}

fn fetch(state: &AppState, path: &str) -> Option<Value> {
    let key = command_key(state, path, "info")?;
    let reply = run_utility_action(state, path, "fns_run_command", Some(&json!({ "key": key }))).ok()?;
    if reply.get("ok").and_then(|o| o.as_bool()) == Some(false) {
        // The package is there but its info command failed: present, dark.
        return Some(shape(&json!({ "active": false })));
    }
    Some(shape(&reply))
}

/// What the session's FNS_Remote is serving, or None when the session has
/// no `fns.mobile-control` package (or cannot be reached over the bus).
/// Cached for a few seconds per session.
pub fn remote_info(state: &AppState, path: &str) -> Option<Value> {
    let k = norm(path);
    if let Ok(c) = cache().lock() {
        if let Some((at, v)) = c.get(&k) {
            if at.elapsed() < TTL {
                return v.clone();
            }
        }
    }
    let v = fetch(state, path);
    if let Ok(mut c) = cache().lock() {
        c.insert(k, (Instant::now(), v.clone()));
    }
    v
}

/// Forget a session's cached answer, so the next lookup asks again — after
/// an action that changes what it serves (pairing opened, LAN toggled).
pub fn forget(path: &str) {
    if let Ok(mut c) = cache().lock() {
        c.remove(&norm(path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_links_ride_only_when_reachable() {
        let on_lan = shape(&json!({
            "active": true, "lan": true, "url": "http://10.0.0.5:9980/#k=a",
            "client_url": "http://10.0.0.5:9980/#k=c", "paired": "author", "client_touch": true
        }));
        assert_eq!(on_lan["state"], "lan");
        assert_eq!(on_lan["url"], "http://10.0.0.5:9980/#k=a");
        assert_eq!(on_lan["client_url"], "http://10.0.0.5:9980/#k=c");
        assert!(on_lan["loopback_url"].is_null());

        let loopback = shape(&json!({
            "active": true, "lan": false, "url": "http://127.0.0.1:9980/#k=a",
            "client_url": "http://127.0.0.1:9980/#k=c"
        }));
        assert_eq!(loopback["state"], "loopback");
        assert!(loopback["url"].is_null(), "a phone cannot reach loopback");
        assert!(loopback["client_url"].is_null());
        assert_eq!(loopback["loopback_url"], "http://127.0.0.1:9980/#k=a");

        let off = shape(&json!({ "active": false, "lan": true, "url": null }));
        assert_eq!(off["state"], "off");
        assert!(off["url"].is_null());
        assert!(off["loopback_url"].is_null());
    }
}
