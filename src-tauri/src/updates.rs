//! Release channels served from the project's own object storage (Cloudflare R2).
//!
//! Two channels move **independently** off one bucket:
//!
//! ```text
//!   app/latest.json                              Tauri updater manifest
//!   app/v<ver>/<installer>            (+ .sig)   NSIS .exe / .app.tar.gz
//!   utility/latest.json                          UtilityManifest (below)
//!   utility/v<ver>/TDXLauncherUtility.tox
//! ```
//!
//! The **app** channel is consumed by `tauri-plugin-updater`, whose endpoint is
//! baked into `tauri.conf.json` at build time — it is not read from here (a unit
//! test below pins the two to the same host so they cannot drift).
//!
//! The **utility** channel is this module. Shipping a new companion TOX is a
//! manifest + `.tox` upload with **no app rebuild**: the launcher fetches
//! `utility/latest.json`, verifies the SHA-256, and stores the file under the
//! app config dir. From then on the *effective* utility — what gets copied to
//! the palette and dragged into projects — is that download rather than the
//! copy bundled into the installer. See [`effective_utility`].

use crate::config::ConfigManager;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Base URL of the release bucket, without a trailing slash.
///
/// Change it with `npm run set-release-host <url>`, which rewrites this
/// constant **and** the updater endpoint in `tauri.conf.json` together —
/// `endpoint_matches_release_base` fails the build if they ever diverge.
pub const DEFAULT_RELEASE_BASE: &str = "https://launchdl.functionstore.tools";

/// File name of the companion TOX, on the release host and on disk.
pub const UTILITY_TOX_NAME: &str = "TDXLauncherUtility.tox";

const USER_AGENT: &str = "TDXLU";
/// The real TOX is ~120 KiB; this is purely a runaway-download guard.
const MAX_TOX_BYTES: usize = 64 * 1024 * 1024;

/// Release host for this build. `TDXLU_RELEASE_BASE` overrides it at runtime
/// so a dev build can be pointed at a staging bucket without recompiling.
pub fn release_base_url() -> String {
    let raw = std::env::var("TDXLU_RELEASE_BASE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASE_BASE.to_string());
    raw.trim_end_matches('/').to_string()
}

pub fn utility_manifest_url() -> String {
    format!("{}/utility/latest.json", release_base_url())
}

/// `utility/latest.json` — hand-written by `scripts/prepare-utility-release.mjs`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UtilityManifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub pub_date: Option<String>,
    /// Absolute URL of the `.tox`.
    pub url: String,
    /// Lowercase hex SHA-256 of the `.tox`; a mismatch aborts the install.
    pub sha256: String,
}

/// What the frontend needs to decide whether to offer an update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UtilityUpdateInfo {
    /// Worth fetching: either newer than what this launcher hands out, or the
    /// launcher has no copy at all.
    pub available: bool,
    /// Whether a companion TOX exists locally (bundled or downloaded). False
    /// means the offer is a first install, not an update.
    pub installed: bool,
    /// Effective version right now (downloaded copy, else the bundled one).
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
}

/// Where downloaded utility releases live: `<config>/utility/`.
pub fn utility_store_dir() -> PathBuf {
    ConfigManager::config_dir().join("utility")
}

fn stored_version_path() -> PathBuf {
    utility_store_dir().join("VERSION")
}

fn stored_tox_path() -> PathBuf {
    utility_store_dir().join(UTILITY_TOX_NAME)
}

/// A previously downloaded utility, if both the `.tox` and its VERSION stamp
/// are present. A half-written pair is treated as absent.
pub fn downloaded_utility() -> Option<(String, PathBuf)> {
    let tox = stored_tox_path();
    if !tox.is_file() {
        return None;
    }
    let version = fs::read_to_string(stored_version_path()).ok()?;
    let version = version.trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some((version, tox))
}

/// Path to the utility TOX bundled into this build's installer resources.
pub fn bundled_utility_tox(app: &AppHandle) -> Option<PathBuf> {
    let p = app
        .path()
        .resolve(
            format!("../release/{UTILITY_TOX_NAME}"),
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    p.is_file().then_some(p)
}

/// The utility this launcher hands out: the downloaded release when it is
/// strictly newer than the bundled one, otherwise the bundled copy.
///
/// A newer *app* therefore reclaims the channel automatically — after an app
/// update ships a fresher TOX than the last download, the stale download simply
/// stops winning the comparison.
pub fn effective_utility(app: &AppHandle) -> (String, Option<PathBuf>) {
    let bundled_version = crate::commands::bundled_utility_version().to_string();
    let bundled_path = bundled_utility_tox(app);

    if let Some((dl_version, dl_path)) = downloaded_utility() {
        let newer = cmp_version(&dl_version, &bundled_version) == Ordering::Greater;
        // With no bundled resource at all (dev builds), any download wins.
        if newer || bundled_path.is_none() {
            return (dl_version, Some(dl_path));
        }
    }
    (bundled_version, bundled_path)
}

/// Effective version as a bare string (see [`effective_utility`]).
pub fn effective_utility_version(app: &AppHandle) -> String {
    effective_utility(app).0
}

/// Compare dotted numeric versions ("0.3.10" > "0.3.9"). Segments that are not
/// numbers fall back to a string compare of that segment, and a shorter version
/// is padded with zeros so "0.3" == "0.3.0".
pub fn cmp_version(a: &str, b: &str) -> Ordering {
    let norm = |s: &str| {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split('.')
            .map(|p| p.trim().to_string())
            .collect::<Vec<_>>()
    };
    let (a, b) = (norm(a), norm(b));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).map(String::as_str).unwrap_or("0");
        let y = b.get(i).map(String::as_str).unwrap_or("0");
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
            _ => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    Ordering::Equal
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch `utility/latest.json`. Blocking HTTP, so callers go through
/// `proc::off_runtime` (see [`check_utility_update`]).
fn fetch_manifest_blocking() -> Result<UtilityManifest, String> {
    let url = utility_manifest_url();
    let resp = http_client()?
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        // The manifest is uploaded with no-cache, but a proxy in between might
        // not care; ask for a fresh copy explicitly.
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|e| format!("utility manifest: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("utility manifest HTTP {} ({url})", resp.status()));
    }
    resp.json::<UtilityManifest>()
        .map_err(|e| format!("utility manifest is not valid JSON: {e}"))
}

/// Is there a utility release newer than the one this launcher hands out?
pub fn check_utility_update(app: &AppHandle) -> Result<UtilityUpdateInfo, String> {
    let (current, current_path) = effective_utility(app);
    let manifest = crate::proc::off_runtime(fetch_manifest_blocking)?;
    Ok(UtilityUpdateInfo {
        // With no local copy at all there is nothing to compare — the channel
        // is simply the way to get one, so anything it offers is available.
        available: current_path.is_none()
            || cmp_version(&manifest.version, &current) == Ordering::Greater,
        installed: current_path.is_some(),
        current_version: current,
        latest_version: manifest.version,
        notes: manifest.notes,
    })
}

/// Download the advertised utility TOX, verify its digest, and store it as the
/// new effective utility. Returns the version now in force.
///
/// The manifest is re-fetched rather than passed in from the frontend, so the
/// digest that gets enforced is always the one the server published — an
/// untrusted caller cannot hand us a matching (url, sha256) pair of its own.
pub fn install_utility_update(app: &AppHandle) -> Result<String, String> {
    let (current, current_path) = effective_utility(app);
    let manifest = crate::proc::off_runtime(fetch_manifest_blocking)?;
    // The "not newer" refusal only makes sense when we already hold a copy. A
    // build with no bundled resource and no prior download (a dev build, or one
    // where the resource was stripped) has nothing to hand out, so it must be
    // able to fetch the current release even though the versions match.
    if current_path.is_some() && cmp_version(&manifest.version, &current) != Ordering::Greater {
        return Err(format!(
            "utility v{} is not newer than the installed v{current}",
            manifest.version
        ));
    }
    let version = manifest.version.clone();
    crate::proc::off_runtime(move || download_and_store(&manifest))?;
    Ok(version)
}

fn download_and_store(manifest: &UtilityManifest) -> Result<(), String> {
    let expected = manifest.sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("manifest sha256 is not a 64-character hex digest".into());
    }

    let resp = http_client()?
        .get(&manifest.url)
        .header("User-Agent", USER_AGENT)
        .send()
        .map_err(|e| format!("utility download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "utility download HTTP {} ({})",
            resp.status(),
            manifest.url
        ));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_TOX_BYTES {
            return Err(format!("utility tox too large ({len} bytes)"));
        }
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    if bytes.len() > MAX_TOX_BYTES {
        return Err(format!("utility tox too large ({} bytes)", bytes.len()));
    }
    if bytes.len() < 16 {
        return Err("downloaded file is too small to be a .tox".into());
    }

    let actual = hex_digest(&bytes);
    if actual != expected {
        return Err(format!(
            "utility tox digest mismatch (expected {expected}, got {actual}) — download rejected"
        ));
    }

    let dir = utility_store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    // Write the tox first and only then stamp VERSION: a crash in between
    // leaves an unstamped tox, which downloaded_utility() ignores. The reverse
    // order would advertise a version whose file never landed.
    let tox = stored_tox_path();
    let tmp = tox.with_extension("tox.partial");
    let _ = fs::remove_file(&tmp);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &tox).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("install utility tox: {e}")
    })?;
    fs::write(stored_version_path(), manifest.version.trim())
        .map_err(|e| format!("stamp utility version: {e}"))?;
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app channel's endpoint lives in tauri.conf.json and the utility
    /// channel's in this file. They must name the same bucket, or a release
    /// silently updates one channel and orphans the other.
    #[test]
    fn endpoint_matches_release_base() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let endpoint = conf["plugins"]["updater"]["endpoints"][0]
            .as_str()
            .expect("updater endpoint");
        assert!(
            endpoint.starts_with(DEFAULT_RELEASE_BASE),
            "updater endpoint `{endpoint}` does not start with DEFAULT_RELEASE_BASE \
             `{DEFAULT_RELEASE_BASE}` — run `npm run set-release-host <url>` to set both"
        );
        assert!(
            endpoint.ends_with("/app/latest.json"),
            "updater endpoint `{endpoint}` should point at app/latest.json"
        );
    }

    #[test]
    fn version_ordering() {
        assert_eq!(cmp_version("0.3.1", "0.3.0"), Ordering::Greater);
        assert_eq!(cmp_version("0.3.10", "0.3.9"), Ordering::Greater);
        assert_eq!(cmp_version("0.4.0", "0.3.99"), Ordering::Greater);
        assert_eq!(cmp_version("0.3", "0.3.0"), Ordering::Equal);
        assert_eq!(cmp_version("v0.3.1", "0.3.1"), Ordering::Equal);
        assert_eq!(cmp_version("0.3.0", "0.3.1"), Ordering::Less);
    }

    #[test]
    fn base_url_has_no_trailing_slash() {
        assert!(!release_base_url().ends_with('/'));
        assert!(utility_manifest_url().ends_with("/utility/latest.json"));
    }

    #[test]
    fn digest_is_lowercase_hex() {
        // Well-known SHA-256 of the empty input.
        assert_eq!(
            hex_digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn manifest_parses_with_optional_fields_absent() {
        let m: UtilityManifest = serde_json::from_str(
            r#"{"version":"0.3.1","url":"https://h/utility/v0.3.1/x.tox","sha256":"ab"}"#,
        )
        .expect("parse");
        assert_eq!(m.version, "0.3.1");
        assert_eq!(m.notes, "");
        assert!(m.pub_date.is_none());
    }
}
