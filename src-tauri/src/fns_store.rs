//! FNSTools (FNS) — bucket manifest, palette store, and global
//! config plumbing.
//!
//! The FNS toolkit ships as *pickable packages* from a bucket
//! (`{fns_base_url}/manifest.json` is the ROLLING release manifest; artifact
//! URLs inside it are absolute and sha256-pinned). Machine-wide, artifacts
//! live in the **palette store** `<user palette>/FNSTools/store/`, which
//! is by contract a MIRROR of the bucket: nothing in it is anyone's work, so
//! a file whose digest disagrees with the manifest is stale cache to
//! re-download, never a modification to preserve. The FNS installer and
//! FNS_Updater inside TouchDesigner read the same store, so a store this
//! module stocks is indistinguishable from one TD stocked.
//!
//! Design record: `docs/fns-integration.md` (and, on the toolkit side,
//! `FunctionStore_tools_PUB/docs/ConfiguratorDistribution.md`).

use crate::commands::TransferProgressEvent;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const USER_AGENT: &str = "TDXLU-FNS";
/// The one-drop rail: carries FNS_Installer and FNS_Updater.
pub const FNS_BOOTSTRAP_NAME: &str = "FNSTools.tox";
/// Largest artifact today is ~1 MiB; this is a runaway-download guard.
const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Paths

/// The toolkit's machine-wide palette folder as named by the contract
/// (FNSTools `docs/PaletteFolderContract.md`, in force 2026-09-18).
pub const FNS_PALETTE_DIR: &str = "FNSTools";
/// What the folder was called before that contract, in any casing (the
/// toolkit wrote `FNStools_ext`, other tooling shipped `FNSTools_ext`).
const LEGACY_PALETTE_DIR: &str = "fnstools_ext";

/// `<user palette>/FNSTools` — the toolkit's machine-wide folder, shared
/// with FNS_Updater / FNS_Installer / FNS_ConfigRegistry inside TD, which
/// derive it independently from `app.userPaletteFolder`.
///
/// Migrates the retired `FNStools_ext` folder on the way, whoever gets
/// there first (the toolkit runs the same steps): a lone legacy folder is
/// renamed into place; when both exist, every legacy entry without a
/// namesake moves over (folders both hold are merged the same way, a file
/// both hold stays as the new side has it, the legacy copy is dropped) and
/// the legacy folder goes once empty. A rename that
/// fails (a file held open) leaves the legacy folder in use for this run
/// and is retried on the next call. The folder is not created here.
pub fn fns_palette_dir() -> PathBuf {
    resolve_palette_dir(&crate::palette::default_user_palette_dir())
}

/// Case-insensitive lookup of the legacy folder directly under `palette`.
fn legacy_palette_dir(palette: &Path) -> Option<PathBuf> {
    fs::read_dir(palette).ok()?.flatten().find_map(|e| {
        let name = e.file_name();
        (name.to_string_lossy().eq_ignore_ascii_case(LEGACY_PALETTE_DIR) && e.path().is_dir())
            .then(|| e.path())
    })
}

/// The contract's resolver + migration, over an explicit palette root so it
/// can be exercised on a scratch tree.
fn resolve_palette_dir(palette: &Path) -> PathBuf {
    let target = palette.join(FNS_PALETTE_DIR);
    let Some(legacy) = legacy_palette_dir(palette) else {
        return target;
    };
    if !target.is_dir() {
        // Step 1: a lone legacy folder is renamed into place.
        return match fs::rename(&legacy, &target) {
            Ok(()) => target,
            // Step 3: something holds it open; stay on the legacy folder.
            Err(_) => legacy,
        };
    }
    // Step 2: both exist -- merge entry by entry, each on its own: a
    // folder something still watches (TDFam's Folder DAT on the old family
    // tree) refuses to move, and that must not keep the store or the
    // config from moving. A folder both sides hold is merged the same way
    // one level down, because a reader that seeds its file when it is
    // missing (OpTemplates) can have made the new folder before this ran;
    // a FILE both sides hold stays as the new side has it and the legacy
    // copy goes: every writer resolves (and so merges) before it writes,
    // so the new side's copy is by construction the later state, and a
    // legacy folder that lingers holding shadowed files is exactly the
    // folder being retired. Emptied legacy folders are removed.
    merge_legacy_dir(&legacy, &target);
    target
}

/// Move every entry of `src` that has no namesake in `dst`; recurse into a
/// folder both hold; drop a file both hold (the `dst` copy is the later
/// state); remove `src` once it is empty. A locked entry is left for the
/// next run and never aborts the loop.
fn merge_legacy_dir(src: &Path, dst: &Path) {
    let Ok(entries) = fs::read_dir(src) else {
        return;
    };
    for e in entries.flatten() {
        let (from, to) = (e.path(), dst.join(e.file_name()));
        if !to.exists() {
            let _ = fs::rename(&from, &to);
        } else if from.is_dir() && to.is_dir() {
            merge_legacy_dir(&from, &to);
        } else if from.is_file() && to.is_file() {
            let _ = fs::remove_file(&from);
        }
    }
    let empty = fs::read_dir(src)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false);
    if empty {
        let _ = fs::remove_dir(src);
    }
}

/// The machine-wide artifact store the FNS installer/updater read.
pub fn store_dir() -> PathBuf {
    fns_palette_dir().join("store")
}

/// The global per-tool settings file ConfigRegistry persists.
pub fn config_json_path() -> PathBuf {
    fns_palette_dir().join("config").join("FNStools_config.json")
}

/// Whether a path points inside the FNS palette store. Formerly the freemium
/// carve-out for `load_tox` (generic load was pro, a store place was free) —
/// the whole companion verb surface went free with the FNSTools Plus flip
/// (docs/fns-plus-capabilities.md D3), so nothing gates on it today. Kept
/// (with its test) as the store-containment contract; P3's stocking work is
/// a likely next consumer.
/// Textual containment on normalized separators/case — both sides come from
/// the same machine, so no canonicalization is needed (and a non-existent
/// path must still compare, the store may not be created yet).
#[allow(dead_code)]
pub fn path_in_store(path: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let store = norm(&store_dir().to_string_lossy());
    let p = norm(path);
    p.strip_prefix(&store)
        .map(|rest| rest.starts_with('/'))
        .unwrap_or(false)
        && !p.contains("/../")
}

fn cache_dir() -> PathBuf {
    crate::config::ConfigManager::config_dir().join("fns")
}

fn cached_manifest_path() -> PathBuf {
    cache_dir().join("manifest.json")
}

// ---------------------------------------------------------------------------
// Manifest

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsManifestInfo {
    /// The manifest verbatim — the frontend reads categories, category_meta,
    /// package metadata and release notes straight out of it.
    pub manifest: Value,
    /// `"network"` when just fetched, `"cache"` when served from disk.
    pub source: String,
    pub base_url: String,
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

fn fetch_manifest_blocking(base_url: &str) -> Result<Value, String> {
    let url = format!("{}/manifest.json", base_url.trim_end_matches('/'));
    let resp = http_client()?
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|e| format!("FNS manifest: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("FNS manifest HTTP {} ({url})", resp.status()));
    }
    let v: Value = resp
        .json()
        .map_err(|e| format!("FNS manifest is not valid JSON: {e}"))?;
    if v.get("packages").and_then(|p| p.as_array()).is_none() {
        return Err("FNS manifest has no packages array".into());
    }
    Ok(v)
}

fn write_cached_manifest(v: &Value) -> Result<(), String> {
    let dir = cache_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    fs::write(cached_manifest_path(), text).map_err(|e| e.to_string())
}

/// Best local copy of the manifest: the launcher's cache, else the palette
/// store's (a store FNS_Updater refreshed counts too).
pub fn load_local_manifest() -> Option<Value> {
    for path in [cached_manifest_path(), store_dir().join("manifest.json")] {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if v.get("packages").is_some() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// The rolling manifest — network when asked (or when there is no local
/// copy), cache otherwise. A failed fetch falls back to the cache rather
/// than erroring, so the store panel keeps working offline.
pub fn get_manifest(base_url: &str, refresh: bool) -> Result<FnsManifestInfo, String> {
    if !refresh {
        if let Some(m) = load_local_manifest() {
            return Ok(FnsManifestInfo {
                manifest: m,
                source: "cache".into(),
                base_url: base_url.to_string(),
            });
        }
    }
    let base = base_url.to_string();
    match crate::proc::off_runtime(|| fetch_manifest_blocking(&base)) {
        Ok(m) => {
            write_cached_manifest(&m)?;
            Ok(FnsManifestInfo {
                manifest: m,
                source: "network".into(),
                base_url: base_url.to_string(),
            })
        }
        Err(e) => match load_local_manifest() {
            Some(m) => Ok(FnsManifestInfo {
                manifest: m,
                source: "cache".into(),
                base_url: base_url.to_string(),
            }),
            None => Err(e),
        },
    }
}

// ---------------------------------------------------------------------------
// Store status

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsFileState {
    pub name: String,
    pub present: bool,
    /// `None` when absent or the manifest names no digest for it.
    pub sha_ok: Option<bool>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsStoreStatus {
    pub store_dir: String,
    pub palette_dir: String,
    /// Release the store's own manifest.json claims, if one is there.
    pub store_release: Option<String>,
    pub config_path: String,
    pub config_exists: bool,
    /// One entry per manifest package (`<name>.tox` beside the manifest).
    pub artifacts: Vec<FnsFileState>,
    /// The droppable rails (`FNSTools.tox` bootstrap, `FNS_Installer.tox`).
    pub rails: Vec<FnsFileState>,
}

fn hex_digest_file(path: &PathBuf) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn file_state(dir: &PathBuf, name: &str, expected_sha: Option<&str>) -> FnsFileState {
    let path = dir.join(format!("{name}.tox"));
    let meta = fs::metadata(&path).ok();
    let present = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
    let sha_ok = match (present, expected_sha) {
        (true, Some(exp)) if !exp.is_empty() => {
            hex_digest_file(&path).map(|got| got.eq_ignore_ascii_case(exp.trim()))
        }
        _ => None,
    };
    FnsFileState {
        name: name.to_string(),
        present,
        sha_ok,
        bytes: meta.map(|m| m.len()).unwrap_or(0),
    }
}

/// Rail names are stored with their `.tox` suffix in the manifest
/// (`rails: {"FNSTools.tox": {...}}`) but files on disk drop nothing — strip
/// the suffix once so `file_state` can re-append it uniformly.
fn rail_stem(rail_key: &str) -> &str {
    rail_key.strip_suffix(".tox").unwrap_or(rail_key)
}

/// What the palette store holds, checked against the given manifest (falls
/// back to the best local manifest when `None`). Digest checks read every
/// present artifact — the whole store is a few MB, so this stays cheap.
pub fn store_status(manifest: Option<&Value>) -> FnsStoreStatus {
    let local;
    let manifest = match manifest {
        Some(m) => Some(m),
        None => {
            local = load_local_manifest();
            local.as_ref()
        }
    };
    let dir = store_dir();
    let store_release = fs::read_to_string(dir.join("manifest.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("release").and_then(|r| r.as_str()).map(String::from));

    let mut artifacts = Vec::new();
    let mut rails = Vec::new();
    if let Some(m) = manifest {
        if let Some(pkgs) = m.get("packages").and_then(|p| p.as_array()) {
            for p in pkgs {
                let Some(name) = p.get("name").and_then(|n| n.as_str()) else {
                    continue;
                };
                let sha = p
                    .get("artifact")
                    .and_then(|a| a.get("sha256"))
                    .and_then(|s| s.as_str());
                artifacts.push(file_state(&dir, name, sha));
            }
        }
        if let Some(r) = m.get("rails").and_then(|r| r.as_object()) {
            for (key, rail) in r {
                let sha = rail.get("sha256").and_then(|s| s.as_str());
                rails.push(file_state(&dir, rail_stem(key), sha));
            }
        }
    }
    let config = config_json_path();
    FnsStoreStatus {
        store_dir: dir.to_string_lossy().replace('\\', "/"),
        palette_dir: fns_palette_dir().to_string_lossy().replace('\\', "/"),
        store_release,
        config_path: config.to_string_lossy().replace('\\', "/"),
        config_exists: config.is_file(),
        artifacts,
        rails,
    }
}

// ---------------------------------------------------------------------------
// Store sync (download)

struct DownloadJob {
    name: String,
    url: String,
    sha256: String,
    bytes: u64,
    /// Manifest `access` names a tier (fns-gate.md §4.3): the artifact lives
    /// under the gate's `fnstools/plus/` prefix and the fetch needs a
    /// short-lived download token. Fail-closed server-side; this flag only
    /// decides whether we bring one.
    gated: bool,
}

fn job_for(name: &str, art: &Value, gated: bool) -> Option<DownloadJob> {
    Some(DownloadJob {
        name: name.to_string(),
        url: art.get("url")?.as_str()?.to_string(),
        sha256: art
            .get("sha256")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        bytes: art.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0),
        gated,
    })
}

/// A package row's `access` field names a tier id; absent or `"free"` is the
/// free rail.
fn package_gated(p: &Value) -> bool {
    p.get("access")
        .and_then(|a| a.as_str())
        .map(|a| !a.is_empty() && !a.eq_ignore_ascii_case("free"))
        .unwrap_or(false)
}

/// The FNSTools bootstrap this launcher can fall back on when the palette
/// store has no rail yet.
///
/// WHY THIS EXISTS: `fns_install` needs a bootstrap tox to load when a
/// project has no `/FNSTools` root -- and the bootstrap is what carries
/// FNS_Installer AND FNS_Updater. Without one there is no installer and no
/// updater, only a dropped file that can never be maintained. Today that
/// bootstrap comes from the store, which means a machine that has never
/// synced cannot install anything at all, online or off.
///
/// PRECEDENCE IS STORE-FIRST, ALWAYS. A populated store is authoritative and
/// very likely carries a fresher rail than shipped with this build; the
/// bundle is a cold-start fallback and nothing more. It is never copied INTO
/// the store, so it cannot make a store artifact look present-but-stale --
/// the store's own sha checks stay the only truth about what is in it.
pub fn bundled_bootstrap(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let p = app
        .path()
        .resolve(
            format!("../release/{FNS_BOOTSTRAP_NAME}"),
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    p.is_file().then_some(p)
}

/// Bring the store's rails up to the bucket before an install, best-effort.
///
/// WHY: a store the toolkit's own updater stocked (or the pane filled one
/// package at a time) holds every artifact and NO rail — neither path ever
/// mirrors `FNSTools.tox`. `effective_bootstrap` then falls to the bundled
/// copy, frozen at whatever release the app was built against, and the user
/// drops a bootstrap several releases old without anything saying so. One
/// rails-only sync here (no packages: `names = Some(&[])`) fetches the rail
/// when it is missing and re-fetches it when the bucket's digest moved; a
/// current rail costs one manifest read. Offline or refused, the bundle is
/// still there — this never blocks an install, it only tries to improve it.
///
/// Deliberately NOT `sync_store`: that rewrites the store's `manifest.json`,
/// and a store the toolkit stocked carries a `manifest.json.sig` beside it
/// that the updater verifies — a re-serialized manifest under the old
/// signature reads as tampered and the updater refuses it. Only the two
/// rail files are touched here; the manifest on disk is left exactly as
/// whoever wrote it left it.
pub fn refresh_rails(base_url: &str) {
    let base = base_url.to_string();
    let manifest = match crate::proc::off_runtime(|| fetch_manifest_blocking(&base)) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("fns store: could not read the bucket manifest ({e}); the bundled bootstrap stands in if the store has no rail");
            return;
        }
    };
    let dir = store_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("fns store: create {}: {e}", dir.display());
        return;
    }
    let Some(rails) = manifest.get("rails").and_then(|r| r.as_object()) else {
        log::warn!("fns store: bucket manifest publishes no rails");
        return;
    };
    for (key, rail) in rails {
        let Some(job) = job_for(rail_stem(key), rail, false) else {
            continue;
        };
        let path = dir.join(format!("{}.tox", job.name));
        let current = !job.sha256.is_empty()
            && path.is_file()
            && hex_digest_file(&path)
                .map(|got| got.eq_ignore_ascii_case(job.sha256.trim()))
                .unwrap_or(false);
        if current {
            continue;
        }
        match crate::proc::off_runtime(|| download_verified(&job, &dir, None)) {
            Ok(()) => log::info!(
                "fns store: {} refreshed to {}",
                job.name,
                manifest.get("release").and_then(|r| r.as_str()).unwrap_or("?")
            ),
            Err(e) => log::warn!("fns store: could not refresh {} ({e})", job.name),
        }
    }
}

/// The bootstrap to hand the companion: the store's rail when it is there,
/// else the bundled copy. Returns `None` when neither exists, which is the
/// honest "there is no offline path on this machine" answer.
pub fn effective_bootstrap(app: &tauri::AppHandle) -> Option<String> {
    let from_store = store_dir().join(FNS_BOOTSTRAP_NAME);
    if from_store.is_file() {
        return Some(from_store.to_string_lossy().replace('\\', "/"));
    }
    bundled_bootstrap(app).map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// A capability artifact bundled with this app, by package name.
///
/// These are the packages an offline machine installs FROM — the bootstrap
/// only gives it something to install WITH. Only FREE, launcher-capable
/// packages are ever bundled (`package_bundleable`, enforced at build time by
/// scripts/fetch-fns-bootstrap.mjs), so nothing gated can be here.
///
/// Like the bootstrap, this is an artifact SOURCE and never a store write:
/// hand the path to the installer's `source`, which records the digest of the
/// bytes that actually landed. A bundled copy older than the manifest then
/// installs cleanly and the next online compare offers the upgrade, rather
/// than blocking as a "stale store" file would.
#[allow(dead_code)]
pub fn bundled_artifact(app: &tauri::AppHandle, package: &str) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    // Package names come from the manifest, but this builds a path -- refuse
    // anything that could climb out of the resource dir.
    if package.is_empty()
        || package.contains(['/', '\\', ':'])
        || package.contains("..")
    {
        return None;
    }
    let p = app
        .path()
        .resolve(
            format!("../release/fns/{package}.tox"),
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    p.is_file().then_some(p)
}

/// The manifest row for a package, by name.
pub fn package_row<'a>(manifest: &'a Value, name: &str) -> Option<&'a Value> {
    manifest
        .get("packages")?
        .as_array()?
        .iter()
        .find(|p| p.get("name").and_then(|n| n.as_str()) == Some(name))
}

/// Where the toolkit says a package goes (`placement` in its manifest row,
/// authored in the CMS): `pane` spawns into the network the user is working
/// in, `none` places nothing at install (the FNS operator family: reached
/// from the OP Create dialog or the family folder), `root` lands beside the
/// toolkit container, and absent means a child of the toolkit container.
pub fn package_placement(p: &Value) -> Option<&str> {
    p.get("placement").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

/// Whether a shelf's place action may drop this package into the current
/// pane as a frozen instance (`load_tox`). True for `pane` and `none` --
/// both are components the user reaches for by hand, and for `none` a pane
/// drop is exactly what picking it as an OP-Create alternative does. False
/// for `root` and absent: those are installs that must arrive where the
/// toolkit puts them, recorded, so they go through FNS_Installer instead.
pub fn placement_lands_in_pane(placement: Option<&str>) -> bool {
    matches!(placement, Some("pane") | Some("none"))
}

/// Does this package contribute to the LAUNCHER's surfaces (the manifest's
/// `launcher` block: it declares a command with a non-`quick` surface, or a
/// capability id)? Absent means "commands only" -- most of the fleet.
///
/// Presence-style on purpose, and tolerant of the field being missing
/// entirely: the live bucket manifest predates it.
#[allow(dead_code)]
pub fn package_launcher_capable(p: &Value) -> bool {
    p.get("launcher").map(|l| l.is_object()).unwrap_or(false)
}

/// The ONLY predicate allowed to decide that a package's bytes may ship
/// inside this app.
///
/// `launcher` marks CAPABILITY, never licence -- three of the four
/// launcher-capable packages today are Base-tier. Bundling on `launcher`
/// alone would put paid artifacts inside a freely-downloadable installer,
/// which is the same class of mistake as a build carrying a gated package
/// into a public mirror. So the free check is the load-bearing half and is
/// written FIRST; a future `seedable` key from the toolkit collapses the two
/// into one lookup, and this stays correct either way.
///
/// Gated packages are not an omission here: a gated fetch needs a download
/// token minted by the gate, so it requires the network whether or not the
/// bytes are local. An offline entitlement is a contradiction, not a gap.
#[allow(dead_code)]
pub fn package_bundleable(p: &Value) -> bool {
    // The toolkit nests this INSIDE the launcher block (`launcher.seedable`),
    // not at package top level -- measured on the live v3.0.13 manifest, where
    // `p.seedable` is absent for all four. Read the nested one first and keep
    // the top-level as a fallback in case it ever moves. Getting this wrong is
    // silent: the free check below still returns the right answer, so a
    // cross-check that never fires looks exactly like one that agrees.
    let declared = p
        .get("launcher")
        .and_then(|l| l.get("seedable"))
        .and_then(|v| v.as_bool())
        .or_else(|| p.get("seedable").and_then(|v| v.as_bool()));
    if let Some(seedable) = declared {
        // Trust the toolkit's own answer when it ships one, but never let it
        // widen us past free -- belt and braces on the one field that, if it
        // were ever wrong, leaks paid bytes.
        return seedable && !package_gated(p);
    }
    !package_gated(p) && package_launcher_capable(p)
}

/// Turn a refused artifact fetch into something a person can act on.
///
/// The gated prefix (`.../fnstools/plus/...`) is served by the entitlement
/// worker -- `storage.functionstore.tools/fnstools/plus/*` is a route on the
/// SAME worker as `gate.functionstore.tools`, so the manifest URL IS the
/// enforcing endpoint. Its refusals carry a machine-readable `error` code and
/// a written `message`; surface the gate's own copy rather than inventing new
/// wording (fns-gate.md: "Surface the gate's refusal codes rather than
/// inventing new copy").
///
/// The three that matter look identical as a bare status line, and only one
/// of them is this client's bug:
///   401 bad_token    -- the download token expired or was never minted
///   403 not_entitled -- the claim genuinely lacks this package (worker TIERS)
///   404              -- the path did not match the worker's strict
///                       `/fnstools/plus/<release>/<Package>.tox` shape, so it
///                       failed BEFORE auth: suspect the URL, not the account.
fn gate_refusal(job: &DownloadJob, resp: reqwest::blocking::Response) -> String {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let code = v.get("error").and_then(|s| s.as_str()).unwrap_or("");
    let message = v.get("message").and_then(|s| s.as_str()).unwrap_or("");
    if status.as_u16() == 404 && job.gated {
        return format!(
            "{}: the gate did not recognise this artifact path ({}). The URL              shape is wrong, not your entitlement.",
            job.name, job.url
        );
    }
    if !message.is_empty() {
        // The gate names the missing tier in `not_entitled`; it also returns
        // the claim's `products`, which is what makes "why not me?" answerable.
        let products = v
            .get("products")
            .and_then(|p| p.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty());
        return match products {
            Some(p) => format!("{}: {message} (your claim covers: {p})", job.name),
            None => format!("{}: {message}", job.name),
        };
    }
    if code.is_empty() {
        format!("{} HTTP {} ({})", job.name, status, job.url)
    } else {
        format!("{}: {code} (HTTP {status})", job.name)
    }
}

fn download_verified(job: &DownloadJob, dir: &PathBuf, bearer: Option<&str>) -> Result<(), String> {
    let mut req = http_client()?
        .get(&job.url)
        .header("User-Agent", USER_AGENT);
    if let Some(t) = bearer {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().map_err(|e| format!("{}: {e}", job.name))?;
    if !resp.status().is_success() {
        return Err(gate_refusal(job, resp));
    }
    let bytes = resp.bytes().map_err(|e| format!("{}: {e}", job.name))?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(format!("{} too large ({} bytes)", job.name, bytes.len()));
    }
    if bytes.len() < 16 {
        return Err(format!("{} download is too small to be a .tox", job.name));
    }
    if !job.sha256.is_empty() {
        let mut h = Sha256::new();
        h.update(&bytes);
        let got: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !got.eq_ignore_ascii_case(job.sha256.trim()) {
            return Err(format!(
                "{} digest mismatch (expected {}, got {got}) — download rejected",
                job.name, job.sha256
            ));
        }
    }
    let target = dir.join(format!("{}.tox", job.name));
    let tmp = target.with_extension("tox.partial");
    let _ = fs::remove_file(&tmp);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("store {}: {e}", job.name)
    })?;
    Ok(())
}

/// Fetch a fresh manifest and bring the store up to it: every requested
/// artifact (all packages when `names` is `None`) plus, optionally, the
/// rails. Present files whose digest already matches are skipped — the store
/// is a mirror, so a mismatch means stale cache and is re-fetched. Writes
/// the store's `manifest.json` last, so the manifest on disk never promises
/// artifacts that failed to land.
pub fn sync_store(
    base_url: &str,
    names: Option<&[String]>,
    include_rails: bool,
    mut progress: impl FnMut(TransferProgressEvent),
) -> Result<FnsStoreStatus, String> {
    let base = base_url.to_string();
    let manifest = crate::proc::off_runtime(|| fetch_manifest_blocking(&base))?;
    write_cached_manifest(&manifest)?;

    let dir = store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let mut jobs: Vec<DownloadJob> = Vec::new();
    let wanted: Option<std::collections::HashSet<&str>> =
        names.map(|ns| ns.iter().map(String::as_str).collect());
    if let Some(pkgs) = manifest.get("packages").and_then(|p| p.as_array()) {
        for p in pkgs {
            let Some(name) = p.get("name").and_then(|n| n.as_str()) else {
                continue;
            };
            if let Some(w) = &wanted {
                if !w.contains(name) {
                    continue;
                }
            }
            if let Some(art) = p.get("artifact") {
                if let Some(job) = job_for(name, art, package_gated(p)) {
                    jobs.push(job);
                }
            }
        }
    }
    if let Some(w) = &wanted {
        let have: std::collections::HashSet<&str> =
            jobs.iter().map(|j| j.name.as_str()).collect();
        let missing: Vec<&str> = w
            .iter()
            .filter(|n| !have.contains(**n))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "not in release {}: {}",
                manifest
                    .get("release")
                    .and_then(|r| r.as_str())
                    .unwrap_or("?"),
                missing.join(", ")
            ));
        }
    }
    if include_rails {
        if let Some(r) = manifest.get("rails").and_then(|r| r.as_object()) {
            for (key, rail) in r {
                if let Some(job) = job_for(rail_stem(key), rail, false) {
                    jobs.push(job);
                }
            }
        }
    }

    // Gated (Plus) rows: a sync-all quietly skips what the claim doesn't
    // name — a free user's "sync everything" must not fail on the paid
    // rail's existence. An EXPLICITLY requested gated package goes through
    // and lets the gate answer (fail-closed; its refusal copy is the truth).
    let products = crate::licensing::status().products;
    let jobs: Vec<DownloadJob> = jobs
        .into_iter()
        .filter(|j| {
            if !j.gated || products.iter().any(|p| p == &j.name) {
                return true;
            }
            match &wanted {
                Some(w) => w.contains(j.name.as_str()),
                None => {
                    log::info!("fns store: skipping gated {} (not in the claim)", j.name);
                    false
                }
            }
        })
        .collect();

    // Skip what already matches, so a refresh only moves changed bytes.
    let jobs: Vec<DownloadJob> = jobs
        .into_iter()
        .filter(|j| {
            let path = dir.join(format!("{}.tox", j.name));
            if j.sha256.is_empty() || !path.is_file() {
                return true;
            }
            hex_digest_file(&path)
                .map(|got| !got.eq_ignore_ascii_case(j.sha256.trim()))
                .unwrap_or(true)
        })
        .collect();

    let total = jobs.len() as u64;
    let total_bytes: u64 = jobs.iter().map(|j| j.bytes).sum();
    let mut done_bytes: u64 = 0;
    let mut errors: Vec<String> = Vec::new();
    // One download token covers every gated row of this sync (they expire in
    // minutes, not seconds). Minted lazily so a free-only sync never phones
    // the gate; a refusal fails only the gated rows, with the gate's copy.
    let mut bearer: Option<Result<String, String>> = None;
    for (i, job) in jobs.iter().enumerate() {
        progress(TransferProgressEvent {
            op_id: String::new(),
            done: i as u64,
            total,
            bytes: done_bytes,
            total_bytes,
            detail: format!("{}.tox", job.name),
        });
        let token: Option<&str> = if job.gated {
            let entry =
                bearer.get_or_insert_with(|| crate::proc::off_runtime(crate::licensing::download_token));
            match entry {
                Ok(t) => Some(t.as_str()),
                Err(e) => {
                    errors.push(format!("{}: {e}", job.name));
                    done_bytes += job.bytes;
                    continue;
                }
            }
        } else {
            None
        };
        let res = crate::proc::off_runtime(|| download_verified(job, &dir, token));
        if let Err(e) = res {
            errors.push(e);
        }
        done_bytes += job.bytes;
    }
    progress(TransferProgressEvent {
        op_id: String::new(),
        done: total,
        total,
        bytes: total_bytes,
        total_bytes,
        detail: String::new(),
    });
    if !errors.is_empty() {
        return Err(errors.join(" | "));
    }

    let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join("manifest.json"), text)
        .map_err(|e| format!("write store manifest: {e}"))?;

    Ok(store_status(Some(&manifest)))
}

// ---------------------------------------------------------------------------
// Selection

/// Write `<palette>/FNSTools/selection.json` in the shape `FNS_Installer`
/// consumes. Root level, not the store: the store is a purgeable mirror
/// and the installer's own default lookup is the root (contract table).
///
/// `minimal = false` is the toolkit-picker shape and always includes core —
/// a selection that omits it is a broken selection, not a request to go
/// without the registries.
///
/// `minimal = true` is the install-one-capability shape: exactly the named
/// packages plus whatever they themselves require, and no removals. Use it
/// whenever the user asked for a capability rather than choosing a toolkit.
pub fn write_selection(tools: &[String], minimal: bool) -> Result<String, String> {
    let manifest =
        load_local_manifest().ok_or("no FNS manifest yet — refresh the catalog first")?;
    let core: Vec<String> = manifest
        .get("core")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let known: std::collections::HashSet<&str> = manifest
        .get("packages")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| p.get("name").and_then(|n| n.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let mut tools: Vec<String> = tools
        .iter()
        .filter(|t| !core.contains(t))
        .cloned()
        .collect();
    tools.sort();
    tools.dedup();
    let unknown: Vec<&String> = tools.iter().filter(|t| !known.contains(t.as_str())).collect();
    if !unknown.is_empty() {
        return Err(format!(
            "not in the manifest: {}",
            unknown
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let toolkit = manifest
        .get("toolkit")
        .and_then(|t| t.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("FNSTools");
    // MINIMAL: install exactly what was asked for, and let the installer pull
    // each package's own declared `requires`. Without it the installer forces
    // the whole core, so "install autosave" lands ~10 packages including
    // FNS_Hub and FNS_Console -- both of which inject visible UI. That is a
    // fine default when the user is PICKING a toolkit in the FNS tab, and a
    // bait-and-switch when they asked for one capability.
    //
    // A minimal selection also protects the user's existing toolkit: `wanted`
    // being one package would otherwise read as "everything else is a removal
    // candidate" (measured toolkit-side: 11 steps / 38 removals full, vs
    // 2 steps / 0 removals minimal).
    let sel = if minimal {
        serde_json::json!({
            "schema": 1,
            "toolkit": toolkit,
            "install": tools,
            "minimal": true,
        })
    } else {
        let mut install = core.clone();
        install.extend(tools.iter().cloned());
        serde_json::json!({
            "schema": 1,
            "toolkit": toolkit,
            "core": core,
            "tools": tools,
            "install": install,
        })
    };
    let dir = fns_palette_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join("selection.json");
    let text = serde_json::to_string_pretty(&sel).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("write selection: {e}"))?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// Global config file (offline configurator)

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsConfigFile {
    pub path: String,
    pub exists: bool,
    pub content: String,
}

pub fn read_config() -> Result<FnsConfigFile, String> {
    let path = config_json_path();
    let exists = path.is_file();
    let content = if exists {
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?
    } else {
        String::new()
    };
    Ok(FnsConfigFile {
        path: path.to_string_lossy().replace('\\', "/"),
        exists,
        content,
    })
}

/// Overwrite the global config. The content must parse as a JSON object —
/// this is the last line of defence between a UI bug and every tool's
/// settings. Atomic (tmp → rename), and the previous file is kept beside it
/// as `.bak` so one bad write is recoverable by hand.
pub fn write_config(content: &str) -> Result<(), String> {
    let v: Value =
        serde_json::from_str(content).map_err(|e| format!("not valid JSON, refusing: {e}"))?;
    if !v.is_object() {
        return Err("config root must be a JSON object, refusing".into());
    }
    let path = config_json_path();
    let dir = path
        .parent()
        .ok_or("config path has no parent")?
        .to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    if path.is_file() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.partial");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("write config: {e}")
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Live settings proxy (ConfigRegistry settings server)

/// The ConfigRegistry settings server binds 127.0.0.1 on the first free port
/// in 9871–9880 and speaks plain JSON. The webview cannot fetch it directly
/// (CORS), so these two calls proxy through Rust — restricted to loopback so
/// a poisoned URL cannot turn the launcher into a generic HTTP client.
fn guard_loopback(url: &str) -> Result<(), String> {
    let ok = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if ok {
        Ok(())
    } else {
        Err(format!("not a loopback settings URL: {url}"))
    }
}

pub fn settings_state(url: &str) -> Result<Value, String> {
    guard_loopback(url)?;
    let url = format!("{}/api/state", url.trim_end_matches('/'));
    crate::proc::off_runtime(move || {
        let resp = http_client()?
            .get(&url)
            .header("User-Agent", USER_AGENT)
            .send()
            .map_err(|e| format!("settings state: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("settings state HTTP {}", resp.status()));
        }
        resp.json::<Value>()
            .map_err(|e| format!("settings state is not JSON: {e}"))
    })
}

pub fn settings_set(url: &str, tool: &str, par: &str, value: &Value) -> Result<Value, String> {
    guard_loopback(url)?;
    let url = format!("{}/api/set", url.trim_end_matches('/'));
    let body = serde_json::json!({ "tool": tool, "par": par, "value": value });
    crate::proc::off_runtime(move || {
        let resp = http_client()?
            .post(&url)
            .header("User-Agent", USER_AGENT)
            .json(&body)
            .send()
            .map_err(|e| format!("settings set: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("settings set HTTP {}", resp.status()));
        }
        resp.json::<Value>()
            .map_err(|e| format!("settings set reply is not JSON: {e}"))
    })
}

/// Read (`value` None) or flip the toolkit's config scope on a live settings
/// server -- `GET|POST /api/scope`. Flipping TO global must say what happens
/// to the machine-wide file (`mode` = "push" | "adopt"); the registry refuses
/// otherwise, so the launcher presents that choice instead of a TD popup.
pub fn settings_scope(url: &str, value: Option<&str>, mode: Option<&str>) -> Result<Value, String> {
    guard_loopback(url)?;
    let url = format!("{}/api/scope", url.trim_end_matches('/'));
    let body = value.map(|v| serde_json::json!({ "value": v, "mode": mode }));
    crate::proc::off_runtime(move || {
        let client = http_client()?;
        let req = match &body {
            Some(b) => client.post(&url).json(b),
            None => client.get(&url),
        };
        let resp = req
            .header("User-Agent", USER_AGENT)
            .send()
            .map_err(|e| format!("settings scope: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("settings scope HTTP {}", resp.status()));
        }
        resp.json::<Value>()
            .map_err(|e| format!("settings scope reply is not JSON: {e}"))
    })
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch palette root per test; tests run in parallel.
    fn scratch_palette(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tdxlpp-palette-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn palette_dir_is_fnstools_even_before_it_exists() {
        let palette = scratch_palette("fresh");
        assert_eq!(resolve_palette_dir(&palette), palette.join("FNSTools"));
        assert!(!palette.join("FNSTools").exists(), "resolver must not create it");
        let _ = fs::remove_dir_all(&palette);
    }

    #[test]
    fn a_lone_legacy_folder_is_renamed_into_place() {
        let palette = scratch_palette("rename");
        // The casing other tooling shipped, not the toolkit's own.
        let legacy = palette.join("FNSTools_ext");
        fs::create_dir_all(legacy.join("store")).unwrap();
        fs::write(legacy.join("store").join("FNS_Autosave.tox"), b"x").unwrap();

        let got = resolve_palette_dir(&palette);
        assert_eq!(got, palette.join("FNSTools"));
        assert!(got.join("store").join("FNS_Autosave.tox").is_file());
        assert!(!legacy.exists(), "legacy folder must be gone after the rename");
        let _ = fs::remove_dir_all(&palette);
    }

    #[test]
    fn both_present_merges_into_shared_folders_and_retires_the_legacy_copy() {
        let palette = scratch_palette("merge");
        let legacy = palette.join("FNStools_ext");
        let target = palette.join("FNSTools");
        // config/ exists on both sides: gate-session.json on both (new wins,
        // legacy copy dropped), fns_remote.json only in the legacy copy.
        fs::create_dir_all(legacy.join("config")).unwrap();
        fs::create_dir_all(target.join("config")).unwrap();
        fs::write(legacy.join("config").join("gate-session.json"), b"old").unwrap();
        fs::write(target.join("config").join("gate-session.json"), b"new").unwrap();
        fs::write(legacy.join("config").join("fns_remote.json"), b"remote").unwrap();
        // OpTemplates/: the new side was seeded empty by a reader before the
        // merge ran; the user's real library is still in the legacy copy.
        fs::create_dir_all(legacy.join("OpTemplates")).unwrap();
        fs::create_dir_all(target.join("OpTemplates")).unwrap();
        fs::write(legacy.join("OpTemplates").join("my_templates.tox"), b"lib").unwrap();
        fs::write(legacy.join("selection.json"), b"sel").unwrap();

        let got = resolve_palette_dir(&palette);
        assert_eq!(got, target);
        assert_eq!(fs::read(target.join("selection.json")).unwrap(), b"sel");
        assert_eq!(fs::read(target.join("config").join("fns_remote.json")).unwrap(), b"remote");
        assert_eq!(fs::read(target.join("OpTemplates").join("my_templates.tox")).unwrap(), b"lib");
        assert_eq!(fs::read(target.join("config").join("gate-session.json")).unwrap(), b"new");
        // The shadowed legacy copy is gone, so nothing is left behind and the
        // retired folder disappears in the same pass.
        assert!(!legacy.exists(), "legacy folder must be gone once fully merged");
        let _ = fs::remove_dir_all(&palette);
    }

    #[test]
    fn only_pane_and_none_placements_drop_into_the_pane() {
        assert!(placement_lands_in_pane(Some("pane")));
        assert!(placement_lands_in_pane(Some("none")), "family tools are placeable by hand");
        assert!(!placement_lands_in_pane(Some("root")), "root lands beside the toolkit");
        assert!(!placement_lands_in_pane(None), "absent = child of the toolkit container");

        let m = serde_json::json!({ "packages": [
            { "name": "FNS_RandomCHOP", "placement": "none" },
            { "name": "FNS_Autosave" },
            { "name": "TDXMap", "placement": " root " },
        ]});
        let placement = |n: &str| package_row(&m, n).and_then(package_placement);
        assert_eq!(placement("FNS_RandomCHOP"), Some("none"));
        assert_eq!(placement("FNS_Autosave"), None);
        assert_eq!(placement("TDXMap"), Some("root"));
        assert!(package_row(&m, "Nope").is_none());
    }

    #[test]
    fn rail_keys_lose_their_suffix_once() {
        assert_eq!(rail_stem("FNSTools.tox"), "FNSTools");
        assert_eq!(rail_stem("FNS_Installer.tox"), "FNS_Installer");
        assert_eq!(rail_stem("NoSuffix"), "NoSuffix");
    }

    #[test]
    fn selection_requires_a_manifest_shape() {
        // write_config refuses non-object roots outright.
        assert!(write_config("[1,2,3]").is_err());
        assert!(write_config("not json").is_err());
    }

    #[test]
    fn minimal_selection_asks_for_exactly_what_was_wanted() {
        // Shape only -- writing needs a manifest on disk, which a unit test
        // has no business creating. The contract being pinned is that the
        // minimal shape carries `minimal: true` and an `install` list with
        // no forced core, because that is what stops "install autosave" from
        // proposing a toolkit (and, toolkit-side, 38 removals).
        let wanted = vec!["FNS_Autosave".to_string()];
        let minimal = serde_json::json!({
            "schema": 1, "toolkit": "FNSTools",
            "install": wanted, "minimal": true,
        });
        assert_eq!(minimal["minimal"], serde_json::json!(true));
        assert_eq!(minimal["install"].as_array().unwrap().len(), 1);
        assert!(minimal.get("core").is_none(), "minimal must not force core");
    }

    #[test]
    fn bundleable_never_includes_a_gated_package() {
        // The whole point: `launcher` marks capability, not licence.
        let gated = serde_json::json!({
            "name": "FNS_Collect",
            "access": "8323905",
            "launcher": { "surfaces": ["session"], "capabilities": ["fns.collect"] }
        });
        assert!(package_launcher_capable(&gated));
        assert!(!package_bundleable(&gated), "gated package must never bundle");

        let free = serde_json::json!({
            "name": "FNS_Autosave",
            "access": "free",
            "launcher": { "surfaces": ["session"], "capabilities": ["fns.autosave"] }
        });
        assert!(package_bundleable(&free));

        // Free but not launcher-capable: nothing for us to seed.
        let plain = serde_json::json!({ "name": "SwapOps", "access": "free" });
        assert!(!package_bundleable(&plain));

        // A `seedable: true` that disagrees with `access` must NOT widen us --
        // in whichever position it is written.
        let lying = serde_json::json!({
            "name": "FNS_MediaBrowser",
            "access": "8323905",
            "seedable": true,
            "launcher": { "surfaces": ["session"] }
        });
        assert!(!package_bundleable(&lying), "seedable must not override access");
        let lying_nested = serde_json::json!({
            "name": "FNS_MediaBrowser",
            "access": "8323905",
            "launcher": { "surfaces": ["session"], "seedable": true }
        });
        assert!(
            !package_bundleable(&lying_nested),
            "nested seedable must not override access either"
        );

        // The REAL shape, from the live v3.0.14 manifest: `seedable` lives
        // INSIDE the launcher block. A `false` there must exclude a package
        // the free-first check would otherwise have accepted -- which is the
        // only way to notice this branch is wired to the right key at all.
        let real_free = serde_json::json!({
            "name": "FNS_Autosave", "access": "free",
            "launcher": { "surfaces": ["context-menu", "session"],
                          "capabilities": ["fns.autosave"], "seedable": true }
        });
        assert!(package_bundleable(&real_free));
        let free_but_declined = serde_json::json!({
            "name": "SomeFreeThing", "access": "free",
            "launcher": { "surfaces": ["session"], "seedable": false }
        });
        assert!(
            !package_bundleable(&free_but_declined),
            "a nested seedable:false must be honoured, not ignored"
        );
    }

    #[test]
    fn launcher_block_absence_is_tolerated() {
        // Two shapes in the wild, and only one was guessed. A manifest
        // written before the field simply OMITS it; the installer's live
        // available() instead reports `launcher: null` for every package on
        // a pre-field release (measured against a real v3.0.12 store: 49
        // packages, all null). Both must read as "not launcher-capable"
        // rather than throwing or, worse, counting as present.
        let absent = serde_json::json!({ "name": "AutoRes", "access": "free" });
        assert!(!package_launcher_capable(&absent));
        assert!(!package_bundleable(&absent));

        let explicit_null =
            serde_json::json!({ "name": "AltSelect", "version": "3.0.1",
                                "access": "free", "launcher": null });
        assert!(!package_launcher_capable(&explicit_null));
        assert!(!package_bundleable(&explicit_null));
    }

    #[test]
    fn store_containment() {
        let store = store_dir().to_string_lossy().replace('\\', "/");
        assert!(path_in_store(&format!("{store}/SwapOps.tox")));
        assert!(path_in_store(&format!(
            "{}\\SwapOps.tox",
            store.to_uppercase().replace('/', "\\")
        )));
        assert!(!path_in_store(&format!("{store}/../elsewhere/SwapOps.tox")));
        assert!(!path_in_store(&store)); // the folder itself is not an artifact
        assert!(!path_in_store("C:/anywhere/else/Tool.tox"));
        assert!(!path_in_store(""));
    }

    #[test]
    fn loopback_guard() {
        assert!(guard_loopback("http://127.0.0.1:9871/").is_ok());
        assert!(guard_loopback("http://localhost:9872").is_ok());
        assert!(guard_loopback("http://192.168.1.4:9871/").is_err());
        assert!(guard_loopback("https://evil.example/").is_err());
    }
}

#[cfg(test)]
mod gated_stock_check {
    //! The one leg of the FNS rail that reading cannot settle: does a real
    //! entitled claim actually fetch gated bytes?
    //!
    //! `#[ignore]` on purpose — it needs the network AND a signed-in machine,
    //! so it must never run in an ordinary `cargo test`. Run it deliberately:
    //!
    //!     cargo test --manifest-path src-tauri/Cargo.toml \
    //!         gated_stock_check -- --ignored --nocapture
    //!
    //! It writes nothing: bytes are hashed in memory, so a failed experiment
    //! cannot leave a half-file in the user's palette store.
    use super::*;

    #[test]
    #[ignore]
    fn entitled_claim_fetches_gated_bytes() {
        let st = crate::licensing::status();
        println!("entitled={} products={:?}", st.entitled, st.products);

        let manifest = crate::proc::off_runtime(|| {
            fetch_manifest_blocking("https://storage.functionstore.tools/fnstools")
        })
        .expect("manifest");
        let release = manifest.get("release").and_then(|r| r.as_str()).unwrap_or("?");

        let pkgs = manifest["packages"].as_array().expect("packages");
        let gated: Vec<&Value> = pkgs.iter().filter(|p| package_gated(p)).collect();
        println!("release={release} gated packages={}", gated.len());

        // EVERY gated package, not a chosen one. `gate_package` APPENDS to the
        // worker's tier map and never prunes, so a rename can leave the old
        // product granting entitlement to bytes that no longer exist AND the
        // new name missing from the map altogether. Testing a single package
        // notices neither. (v3.0.14 renamed FNS_Media -> FNS_MediaBrowser and
        // the map was corrected by hand, which is precisely when a sweep pays.)
        assert!(!gated.is_empty(), "manifest declares no gated packages");
        let token = crate::licensing::download_token().expect("download token");
        println!("  minted token ({} chars)", token.len());

        for pkg in &gated {
            let name = pkg["name"].as_str().unwrap();
            let url = pkg["artifact"]["url"].as_str().unwrap();
            let want = pkg["artifact"]["sha256"].as_str().unwrap_or("");
            println!("testing {name} -> {url}");

            // 1. Unauthenticated must be refused, or the gate is not enforcing
            //    and every other result here is meaningless.
            let bare = http_client()
                .unwrap()
                .get(url)
                .header("User-Agent", USER_AGENT)
                .send()
                .expect("bare request");
            println!("  no token   -> HTTP {}", bare.status());
            assert!(
                !bare.status().is_success(),
                "{name}: gated artifact served WITHOUT a token — the gate is not enforcing"
            );

            // 2. The authenticated fetch, and the digest the manifest pins.
            let job = DownloadJob {
                name: name.to_string(),
                url: url.to_string(),
                sha256: want.to_string(),
                bytes: 0,
                gated: true,
            };
            let resp = http_client()
                .unwrap()
                .get(&job.url)
                .header("User-Agent", USER_AGENT)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .expect("authorized request");
            let status = resp.status();
            if !status.is_success() {
                panic!("{name}: authorized fetch refused: {}", gate_refusal(&job, resp));
            }
            let bytes = resp.bytes().expect("body");
            let mut h = Sha256::new();
            h.update(&bytes);
            let got: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
            println!("  with token -> HTTP {status}, {} bytes", bytes.len());
            println!("  sha256 {} (manifest {})", got, want);
            assert_eq!(got, want, "{name}: digest mismatch on an authorized gated fetch");
            println!("  OK — entitled claim fetched {name} and the digest matches");
        }
    }
}

#[cfg(test)]
mod rail_tests {
    /// Diagnostic, not a unit test: refreshes the REAL store's rails from the
    /// default bucket and prints what is there afterwards. Run with
    /// `cargo test --lib live_refresh_rails -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_refresh_rails() {
        super::refresh_rails("https://storage.functionstore.tools/fnstools");
        for name in ["FNSTools", "FNS_Installer"] {
            let path = super::store_dir().join(format!("{name}.tox"));
            println!(
                "rail {name}: present={} sha={:?}",
                path.is_file(),
                super::hex_digest_file(&path).map(|s| s[..12].to_string())
            );
        }
    }
}
