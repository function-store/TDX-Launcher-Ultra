//! Membership sign-in on the FNSTools entitlement gate (docs/fns-gate.md).
//!
//! The launcher itself is free in full and gates nothing (2026-10-02): the
//! claim exists for the FNSTools Plus packages, whose rows read `products`.
//!
//! The launcher is a PUBLIC client of `gate.functionstore.tools`: it holds no
//! Patreon secret and no HMAC key. The gate turns a Patreon membership into
//! an opaque revocable **device token** plus a signed **Ed25519 entitlement
//! claim** (a JWT verified against `GATE_PUBLIC_KEY`; publishing that key
//! mints nothing). The local auth file is just those two values —
//! verification is a signature check, not trust in the file.
//!
//! - **No activation needed to use the launcher**: nothing here phones home
//!   unless the user signs in, and every feature survives any gate outage.
//! - **The claim is a PRODUCT LIST, never a boolean** — `entitled` (an active
//!   membership) is derived (the claim names at least one product), not
//!   stored. No product is the launcher's own: `TDXLU_Pro` retired
//!   2026-10-02.
//! - **Patreon only.** The trial AND the Gumroad/license-key surface are
//!   dropped by decision (2026-08-30): paid capability is delivered through
//!   FNSTools Plus, and any Gumroad-entitled
//!   product is an FNSTools package governed by the toolkit's rail — TDXLU
//!   redeems no keys and mints no trial windows.
//! - **Activate once per machine.** Day-to-day paid use never phones home:
//!   the cached claim is valid until its `exp` (180 d, renewed on any
//!   successful re-check). A failed request is never a revocation — the
//!   claim is only ever REPLACED by a fresh one, never discarded.
//! - **The session is machine-wide, shared with FNSTools** (fns-gate.md §5):
//!   one sign-in on a machine serves both products. Sign-in writes the
//!   device token to the shared file in the toolkit's config area; an
//!   install with no session of its own ADOPTS the shared token before ever
//!   opening a browser. Claims stay per-client.
//! - **Sign-out revokes first** (`POST /session/revoke`), then clears the
//!   file — and signs the MACHINE out: the shared file is deleted when it
//!   still holds the revoked token.
//!
//! The machine binding in the claim is a hash of a CLIENT-computed
//! fingerprint the gate treats as opaque — honesty-box, same tier of
//! protection as the HMAC scheme it replaces. Purchase gate, not DRM.
//!
//! The companion utility TOX channel is deliberately NOT gated.

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// -- The gate. One Worker, shared with FNSTools; every route below is
// -- specified in docs/fns-gate.md and canonical in FNSTools worker/src.
const GATE_BASE_URL: &str = "https://gate.functionstore.tools";
/// Base64 SPKI Ed25519 — the same value as the Worker's `JWT_PUBLIC_KEY`
/// wrangler secret (public half; safe to embed). EMPTY fails closed: no
/// claim verifies, so sign-in refuses loudly rather than storing a claim
/// this build can never check. Canonical source: `GET <gate>/pubkey`
/// (returns the exact SPKI the claims verify against).
const GATE_PUBLIC_KEY: &str = "MCowBQYDK2VwAyEAAsq8SgmAcgIrQFimbJPzpkBCtDupOUIM5nhFoz7UVew=";

// -- Sign-in loopback (same registered Patreon client as TDMap; the gate
// -- holds the secret and redirects to /fns-auth on this port).
const OAUTH_BIND_ADDR: &str = "127.0.0.1:16669";
const OAUTH_PORT: u16 = 16669;
/// How long the loopback listener waits for the user to finish in the browser.
const OAUTH_WAIT_SECS: u64 = 300;

/// Refresh a Patreon-kind claim in the background when the cached copy is
/// older than this (a claim in use renews long before its 180 d `exp`).
const PATREON_CLAIM_REFRESH_SECS: u64 = 24 * 60 * 60;
/// Don't re-attempt a failed background refresh more often than this.
const REFRESH_RETRY_SECS: u64 = 6 * 60 * 60;

const AUTH_FILENAME: &str = "tdxlu-license.json";

const USER_AGENT: &str = "TDXLU";
const EVENT_NAME: &str = "license-status";

// ---------------------------------------------------------------------------
// Session state (process-lifetime; never persisted)
// ---------------------------------------------------------------------------

struct Session {
    /// A sign-in dance is currently holding the callback port.
    oauth_in_progress: bool,
    /// Monotonic instant of the last background claim-refresh attempt.
    refresh_attempt_mono: Option<Instant>,
    /// Last shared-session adoption attempt (throttle + which token), so the
    /// watchdog retries a failed adoption slowly but jumps on a NEW token
    /// (the toolkit just signed in) immediately.
    adopt_attempt_mono: Option<Instant>,
    adopt_attempt_token: Option<String>,
    /// Set by an explicit sign-out: background adoption stays off for the
    /// rest of the process, so a surviving toolkit session (divergent-token
    /// case) is not silently re-adopted against the user's stated intent.
    /// An explicit Sign-in click lifts it; an app restart resets it.
    adopt_suppressed: bool,
    /// Last emitted status JSON, to emit only on transitions.
    last_emitted: Option<String>,
}

static SESSION: Mutex<Session> = Mutex::new(Session {
    oauth_in_progress: false,
    refresh_attempt_mono: None,
    adopt_attempt_mono: None,
    adopt_attempt_token: None,
    adopt_suppressed: false,
    last_emitted: None,
});

fn enforced() -> bool {
    cfg!(feature = "licensing")
}

fn gate_key_configured() -> bool {
    !GATE_PUBLIC_KEY.trim().is_empty()
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Status DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// An active Function Store membership. Derived from the claim's product
    /// list — never stored as a boolean (the gate's first design rule). No
    /// launcher feature depends on this; the app is always fully usable.
    pub entitled: bool,
    /// The claim's kind. "patreon" is the only kind TDXLU itself mints,
    /// but ADOPTING the shared machine session (fns-gate.md §5) can surface
    /// a toolkit-minted kind — "gumroad" after a key redeem over there —
    /// so the UI must render those too. "" = none; "disabled" = build
    /// compiled without enforcement.
    pub provider: String,
    /// "" | "auth_required" | "reauth_required" | "no_entitlement" — gate
    /// refusal codes surface here, not new copy.
    pub block_reason: String,
    /// What the claim names. Empty when signed out or lapsed.
    pub products: Vec<String>,
}

/// Current entitlement, from the cached signed claim. No network.
pub fn status() -> LicenseStatus {
    let base = |provider: &str, block: &str| LicenseStatus {
        entitled: false,
        provider: provider.into(),
        block_reason: block.into(),
        products: Vec::new(),
    };
    if !enforced() {
        return LicenseStatus {
            entitled: true,
            ..base("disabled", "")
        };
    }
    let auth = load_auth();
    let claim_str = str_field(&auth, "claim");
    if claim_str.is_empty() {
        return base("", "auth_required");
    }
    match parse_claim(&claim_str, GATE_PUBLIC_KEY, &claim_machine()) {
        Ok(c) => {
            // Any product means a paying membership: the gate's TIERS map
            // only lists products for paid tiers.
            let entitled = !c.products.is_empty();
            LicenseStatus {
                entitled,
                products: c.products.clone(),
                ..base(
                    &c.kind,
                    if entitled { "" } else { "no_entitlement" },
                )
            }
        }
        // A claim aged out (180 d unrenewed Patreon, or clock games): one
        // fresh sign-in / re-check restores it. Never a lockout of the free
        // tier.
        Err(ClaimError::Expired(c)) => base(&c.kind, "reauth_required"),
        // Unverifiable (tampered, copied to another machine, key missing):
        // exactly a signed-out install.
        Err(_) => base("", "auth_required"),
    }
}

/// Emit the current status to the frontend when it changed since last emit.
fn emit_status(app: &AppHandle) {
    let st = status();
    let json = serde_json::to_string(&st).unwrap_or_default();
    {
        let mut s = SESSION.lock().unwrap();
        if s.last_emitted.as_deref() == Some(json.as_str()) {
            return;
        }
        s.last_emitted = Some(json);
    }
    let _ = app.emit(EVENT_NAME, st);
}

// ---------------------------------------------------------------------------
// Machine fingerprint
// ---------------------------------------------------------------------------

/// Stable per-machine id: OS machine GUID where available, hostname-ish
/// environment as salt. Hashed, 32 hex chars — stable across app updates,
/// survives reinstall (registry/IOKit-backed, not an app file).
fn machine_fingerprint() -> String {
    let raw = format!(
        "{}|{}|{}",
        std::env::consts::OS,
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_default(),
        os_machine_id(),
    );
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

#[cfg(target_os = "windows")]
fn os_machine_id() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .and_then(|k| k.get_value::<String, _>("MachineGuid"))
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn os_machine_id() -> String {
    std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            text.lines()
                .find(|l| l.contains("IOPlatformUUID"))
                .and_then(|l| l.split('"').nth(3).map(|s| s.to_string()))
        })
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn os_machine_id() -> String {
    std::fs::read_to_string("/etc/machine-id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn sha256hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The `machine` value carried in claims: sha256 of the fingerprint —
/// opaque to the gate (it passes it through unverified, by design) and
/// checked locally so a claim copied to another PC reads as foreign.
fn claim_machine() -> String {
    sha256hex(&machine_fingerprint())
}

// ---------------------------------------------------------------------------
// Ed25519 claim verification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct Claim {
    pub kind: String,
    pub products: Vec<String>,
    pub exp: u64,
}

#[derive(Debug)]
pub(crate) enum ClaimError {
    /// This build has no `GATE_PUBLIC_KEY` — nothing can verify.
    NoKey,
    Malformed,
    BadSignature,
    WrongIssuer,
    MachineMismatch,
    /// Signature was good; the claim is past its `exp`. Carries the payload
    /// so the caller can tell an ended trial from an aged-out Patreon claim.
    Expired(Claim),
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim())
        .ok()
}

/// Raw 32-byte Ed25519 key out of a base64 SPKI DER blob (the `openssl
/// pkey -pubout -outform DER | base64` shape the Worker stores).
fn spki_ed25519(b64: &str) -> Option<[u8; 32]> {
    use base64::Engine;
    let der = base64::engine::general_purpose::STANDARD
        .decode(b64.split_whitespace().collect::<String>())
        .ok()?;
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != 44 || der[..12] != PREFIX {
        return None;
    }
    der[12..].try_into().ok()
}

/// Verify an EdDSA JWT against the given SPKI key and machine binding.
/// Pure function of its inputs so the tests can mint their own keypair.
pub(crate) fn parse_claim(
    jwt: &str,
    pub_key_b64: &str,
    expect_machine: &str,
) -> Result<Claim, ClaimError> {
    if pub_key_b64.trim().is_empty() {
        return Err(ClaimError::NoKey);
    }
    let key_bytes = spki_ed25519(pub_key_b64).ok_or(ClaimError::NoKey)?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| ClaimError::NoKey)?;

    let mut parts = jwt.split('.');
    let (h, p, s) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(p), Some(s), None) => (h, p, s),
        _ => return Err(ClaimError::Malformed),
    };
    let sig_bytes = b64url_decode(s).ok_or(ClaimError::Malformed)?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| ClaimError::Malformed)?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);
    let msg = format!("{h}.{p}");
    key.verify_strict(msg.as_bytes(), &sig)
        .map_err(|_| ClaimError::BadSignature)?;

    let payload: Value = serde_json::from_slice(&b64url_decode(p).ok_or(ClaimError::Malformed)?)
        .map_err(|_| ClaimError::Malformed)?;
    if payload.get("iss").and_then(|v| v.as_str()) != Some("fnstools") {
        return Err(ClaimError::WrongIssuer);
    }
    // Machine before exp: a foreign file is "not yours", never "expired".
    let machine = payload.get("machine").and_then(|v| v.as_str()).unwrap_or("");
    if machine != expect_machine {
        return Err(ClaimError::MachineMismatch);
    }
    let claim = Claim {
        kind: payload
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        products: payload
            .get("products")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        exp: payload.get("exp").and_then(|v| v.as_u64()).unwrap_or(0),
    };
    if claim.exp <= now_epoch() {
        return Err(ClaimError::Expired(claim));
    }
    Ok(claim)
}

// ---------------------------------------------------------------------------
// Auth file — { device_token, claim, cached_at }
// ---------------------------------------------------------------------------

fn auth_path() -> PathBuf {
    crate::config::ConfigManager::config_dir().join(AUTH_FILENAME)
}

fn str_field(auth: &Map<String, Value>, key: &str) -> String {
    auth.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn u64_field(auth: &Map<String, Value>, key: &str) -> u64 {
    auth.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Auth body, or empty when absent/unreadable. The file carries no local
/// signature any more — the CLAIM is the signed artifact, verified on every
/// read by `parse_claim` (so tampering or copying shows up there, not here).
fn load_auth() -> Map<String, Value> {
    let raw = match std::fs::read_to_string(auth_path()) {
        Ok(s) => s,
        Err(_) => return Map::new(),
    };
    match serde_json::from_str(&raw) {
        Ok(Value::Object(m)) => m,
        // A legacy HMAC-era file (or truncation) parses as garbage → signed
        // out. Nothing shipped on the old scheme; no migration path needed.
        _ => Map::new(),
    }
}

/// Atomic write (ship audit DATA-01): temp file in the same directory, then
/// rename over — a crash mid-write must never leave a truncated auth file
/// that reads as unlicensed.
fn save_auth(auth: Map<String, Value>) {
    let path = auth_path();
    if auth.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = match serde_json::to_string_pretty(&Value::Object(auth)) {
        Ok(j) => j,
        Err(e) => {
            log::error!("license: serialize failed: {e}");
            return;
        }
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &json) {
        log::error!("license: save failed: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        log::error!("license: atomic rename failed: {e}");
        let _ = std::fs::remove_file(&tmp);
    }
}

fn save_session_auth(device_token: &str, claim: &str) {
    let mut auth = Map::new();
    auth.insert("device_token".into(), Value::String(device_token.into()));
    auth.insert("claim".into(), Value::String(claim.into()));
    auth.insert("cached_at".into(), Value::from(now_epoch()));
    save_auth(auth);
}

// ---------------------------------------------------------------------------
// HTTP helpers (blocking — callers must be off the async runtime)
// ---------------------------------------------------------------------------

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// A response the gate answered definitively vs a network failure — callers
/// treat them differently (offline keeps the cached claim, a refusal is a
/// fact).
enum HttpOutcome {
    Json(u16, Value),
    Network(String),
}

fn post_gate(path: &str, bearer: Option<&str>, body: &Value) -> HttpOutcome {
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return HttpOutcome::Network(e),
    };
    let mut req = client
        .post(format!("{GATE_BASE_URL}{path}"))
        .header("User-Agent", USER_AGENT)
        .header("Content-Type", "application/json");
    if let Some(t) = bearer {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    match req.body(body.to_string()).send() {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let val = resp.json::<Value>().unwrap_or(Value::Null);
            HttpOutcome::Json(code, val)
        }
        Err(e) => HttpOutcome::Network(e.to_string()),
    }
}

/// The gate's refusals name what is missing (`error` + `message`); surface
/// the message, fall back to the code, never invent new copy.
fn gate_message(v: &Value, fallback: &str) -> String {
    v.get("message")
        .and_then(|s| s.as_str())
        .or_else(|| v.get("error").and_then(|s| s.as_str()))
        .unwrap_or(fallback)
        .to_string()
}

fn gate_error_code(v: &Value) -> String {
    v.get("error").and_then(|s| s.as_str()).unwrap_or("").to_string()
}

// ---------------------------------------------------------------------------
// /entitlement — the signed claim
// ---------------------------------------------------------------------------

/// Why a claim fetch failed — the adoption path branches on it (a dead
/// shared token is deleted; an unreachable gate is retried later). Callers
/// that only need copy call `.message()`.
enum FetchError {
    Network(String),
    /// The gate says this token is dead (revoked or unknown).
    SignedOut,
    Refused(String),
}

impl FetchError {
    fn message(self) -> String {
        match self {
            FetchError::Network(e) => format!("Could not reach the license gate: {e}"),
            FetchError::SignedOut => {
                "This install is no longer signed in — sign in again.".into()
            }
            FetchError::Refused(m) => m,
        }
    }
}

/// Fetch a fresh signed claim for a device token and persist it. The gate
/// re-resolves entitlement as it goes (same `refreshEntitlement` as
/// `/token/download`), so a successful call IS the re-check. Callers decide
/// whether a failure may fall back to the cached claim (§7: a failed
/// request is never a revocation).
fn fetch_and_store_claim(device_token: &str) -> Result<Claim, FetchError> {
    if !gate_key_configured() {
        return Err(FetchError::Refused(
            "This build has no gate public key baked in — it cannot verify entitlement \
             claims. This is a build error, not an account problem."
                .into(),
        ));
    }
    let body = serde_json::json!({ "machine": claim_machine() });
    match post_gate("/entitlement", Some(device_token), &body) {
        HttpOutcome::Network(e) => Err(FetchError::Network(e)),
        HttpOutcome::Json(code, v) => {
            let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
            let claim_str = v.get("claim").and_then(|s| s.as_str()).unwrap_or("");
            if !ok || claim_str.is_empty() {
                if gate_error_code(&v) == "signed_out" {
                    return Err(FetchError::SignedOut);
                }
                return Err(FetchError::Refused(gate_message(
                    &v,
                    &format!("The license gate refused the request (HTTP {code})."),
                )));
            }
            // Never store a claim this machine can't verify — a bad key or a
            // gate-side signing bug must surface HERE, not as a silent
            // signed-out state later.
            let claim = parse_claim(claim_str, GATE_PUBLIC_KEY, &claim_machine())
                .map_err(|e| {
                    FetchError::Refused(format!("The gate's claim did not verify ({e:?})."))
                })?;
            save_session_auth(device_token, claim_str);
            Ok(claim)
        }
    }
}

// ---------------------------------------------------------------------------
// Shared machine session (fns-gate.md §5) — one sign-in serves FNSTools AND
// the launcher. The file holds the device token and nothing else; claims
// stay per-client.
// ---------------------------------------------------------------------------

/// `<user palette>/FNSTools/config/gate-session.json` — beside the
/// toolkit's own `FNStools_config.json`, deliberately OUTSIDE `store/`
/// (the store is a purgeable bucket mirror; a credential must never live
// ---------------------------------------------------------------------------
// /token/download — gated-artifact stocking (fns-gate.md §4.2's motion)
// ---------------------------------------------------------------------------

/// Mint a short-lived signed download token for gated artifacts on the
/// toolkit rail (`fnstools/plus/…`). The gate re-resolves entitlement as it
/// goes, so a refusal here is a fact — surface its own copy — while a
/// network failure is transient. Never touches the cached claim: stocking
/// needs a session, but a failure to stock is never a revocation (§7).
pub fn download_token() -> Result<String, String> {
    let device_token = str_field(&load_auth(), "device_token");
    if device_token.is_empty() {
        return Err("Not signed in — gated packages need a Patreon sign-in first.".into());
    }
    match post_gate("/token/download", Some(&device_token), &Value::Null) {
        HttpOutcome::Network(e) => Err(format!("Could not reach the license gate: {e}")),
        HttpOutcome::Json(code, v) => {
            let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
            let token = v.get("token").and_then(|s| s.as_str()).unwrap_or("");
            if ok && !token.is_empty() {
                Ok(token.to_string())
            } else {
                Err(gate_message(
                    &v,
                    &format!("The license gate refused a download token (HTTP {code})."),
                ))
            }
        }
    }
}

/// where a cleaner is allowed to delete).
fn shared_session_path() -> PathBuf {
    crate::fns_store::fns_palette_dir()
        .join("config")
        .join("gate-session.json")
}

/// Token out of the shared file's JSON, or None. Pure for testability.
fn parse_shared_session(raw: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let token = v.get("device_token")?.as_str()?.trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn read_shared_session() -> Option<String> {
    std::fs::read_to_string(shared_session_path())
        .ok()
        .and_then(|raw| parse_shared_session(&raw))
}

/// Best-effort atomic write after a successful sign-in — even a session
/// that is not entitled to THIS product is written (the toolkit's grant may
/// differ, and the account is the machine's either way).
fn write_shared_session(device_token: &str) {
    let path = shared_session_path();
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    let json = serde_json::json!({
        "schema": 1,
        "device_token": device_token,
        "written_by": "tdxlu",
        "written_at": now_epoch(),
    });
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json.to_string()).is_ok()
        && std::fs::rename(&tmp, &path).is_err()
    {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Delete the shared file ONLY while it still holds `token` — a different
/// token means the other product signed in again; leave theirs alone.
fn clear_shared_session_if(token: &str) {
    if read_shared_session().as_deref() == Some(token) {
        let _ = std::fs::remove_file(shared_session_path());
    }
}

/// The gate answered `signed_out` to a BACKGROUND refresh: this token was
/// revoked (e.g. a machine-wide sign-out from the other product). Honor it —
/// clear the local session and the shared file while it still holds the dead
/// token. This is NOT the outage path: §7's "never discard a claim because a
/// request failed" protects against network failures, and `FetchError` keeps
/// the two apart by type. A definitive online "this session is dead" is the
/// one answer a well-behaved client acts on early rather than riding its
/// claim to `exp`.
fn handle_definitive_signout(device_token: &str) {
    log::info!("license: gate reports the session revoked — clearing the local record");
    save_auth(Map::new());
    clear_shared_session_if(device_token);
}

/// Backfill: an install that signed in BEFORE the shared session existed
/// (or whose file was cleaned up) holds a token the machine can't see.
/// Once per process, publish it when the file is absent. Mirrors ExtAuth's
/// backfill on the FNSTools side. Caveat, accepted on both sides: this
/// can republish a DEAD token — knowing would cost a gate round-trip — but
/// any adopter's first `signed_out` answer runs the guarded delete and the
/// file self-heals.
fn maybe_backfill_shared_session() {
    let token = str_field(&load_auth(), "device_token");
    if !token.is_empty() && read_shared_session().is_none() {
        write_shared_session(&token);
        log::info!("license: backfilled the shared machine session");
    }
}

/// Adopt the shared machine session when this install has none of its own:
/// present its token to `/entitlement` and cache the claim. Returns true
/// when a claim was stored. A `signed_out` answer means the token is dead —
/// the file is deleted so the toolkit stops retrying it too; network
/// failures leave it for a later attempt. `force` (the explicit Sign-in
/// click) lifts the post-sign-out suppression and the retry throttle.
fn try_adopt_shared_session(force: bool) -> bool {
    if !str_field(&load_auth(), "device_token").is_empty() {
        return false; // own session wins; adoption is only for the tokenless
    }
    let Some(token) = read_shared_session() else {
        return false;
    };
    {
        let mut s = SESSION.lock().unwrap();
        if force {
            s.adopt_suppressed = false;
        } else {
            if s.adopt_suppressed {
                return false;
            }
            let same_token = s.adopt_attempt_token.as_deref() == Some(token.as_str());
            let recent = s
                .adopt_attempt_mono
                .map(|t| t.elapsed().as_secs() < REFRESH_RETRY_SECS)
                .unwrap_or(false);
            // Retry a failed token slowly, but jump on a NEW one immediately
            // — that is the "user just signed in inside TouchDesigner"
            // moment.
            if same_token && recent {
                return false;
            }
        }
        s.adopt_attempt_mono = Some(Instant::now());
        s.adopt_attempt_token = Some(token.clone());
    }
    match fetch_and_store_claim(&token) {
        Ok(_) => {
            log::info!("license: adopted the shared machine session");
            true
        }
        Err(FetchError::SignedOut) => {
            log::info!("license: shared machine session is dead — clearing it");
            clear_shared_session_if(&token);
            false
        }
        Err(e) => {
            log::info!("license: shared-session adoption failed ({})", e.message());
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Patreon sign-in — loopback listener + gate-brokered OAuth
// ---------------------------------------------------------------------------

/// Full browser sign-in: bind the loopback, open the gate's consent URL
/// (the gate holds the Patreon secret), wait for the redirect carrying a
/// one-time grant code, claim the device token, fetch the claim.
/// Blocking for up to OAUTH_WAIT_SECS — run via `proc::off_runtime`.
pub fn patreon_sign_in(app: &AppHandle) -> Result<LicenseStatus, String> {
    if !enforced() {
        return Ok(status());
    }
    {
        let mut s = SESSION.lock().unwrap();
        if s.oauth_in_progress {
            return Err("A sign-in is already in progress — finish it in the browser.".into());
        }
        s.oauth_in_progress = true;
    }
    let result = patreon_sign_in_inner();
    SESSION.lock().unwrap().oauth_in_progress = false;
    emit_status(app);
    result
}

fn patreon_sign_in_inner() -> Result<LicenseStatus, String> {
    if !gate_key_configured() {
        return Err(
            "This build has no gate public key baked in — it cannot verify entitlement \
             claims. This is a build error, not an account problem."
                .into(),
        );
    }
    // Adopt first (fns-gate.md §5): a session the toolkit already minted on
    // this machine means no browser at all. Fall through to the dance when
    // there is nothing to adopt — or the adopted session is not entitled
    // (the user may want a different account).
    if try_adopt_shared_session(true) && status().entitled {
        return Ok(status());
    }
    // Bind BEFORE opening the browser so a busy port fails fast (e.g. TDMap
    // is mid-sign-in inside TouchDesigner — it uses the same callback port).
    let server = bind_loopback()?;

    // The CLIENT nonce: the gate carries it through the OAuth exchange and
    // the listener accepts a grant code only when it comes back matching —
    // the gate's own `state` nonce protects the gate, not this listener.
    let cn = uuid::Uuid::new_v4().simple().to_string();
    let consent = format!("{GATE_BASE_URL}/patreon/start?port={OAUTH_PORT}&cn={cn}");
    tauri_plugin_opener::open_url(&consent, None::<&str>)
        .map_err(|e| format!("Could not open the browser for sign-in: {e}"))?;

    // Wait for the gate's redirect to /fns-auth?code=<grant>&cn=<nonce>.
    let code = wait_for_loopback(&server, "/fns-auth", "code", &cn)?;
    drop(server); // release the port before the network round-trips

    // Exchange the one-time grant code for the device token, exactly once.
    let device_token = match post_gate(
        "/session/claim",
        None,
        &serde_json::json!({ "code": code }),
    ) {
        HttpOutcome::Network(e) => return Err(format!("Could not reach the license gate: {e}")),
        HttpOutcome::Json(_, v) => {
            let tok = v
                .get("device_token")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            if tok.is_empty() {
                return Err(gate_message(&v, "Sign-in could not be completed — try again."));
            }
            tok
        }
    };

    // The signed claim — cached until its exp; day-to-day use never phones
    // home again. Stored even when it names no products: a lapsed session
    // must be able to learn that it has lapsed.
    let claim = fetch_and_store_claim(&device_token).map_err(FetchError::message)?;
    // The machine session (§5): the toolkit adopts this token instead of
    // asking the user to sign in a second time. Written regardless of THIS
    // product's entitlement — the toolkit's grant may differ.
    write_shared_session(&device_token);
    if claim.products.is_empty() {
        return Err(
            "Signed in, but this Patreon account has no active Function Store \
             membership. Subscribe on Patreon, then use Check again — no need to sign \
             in twice."
                .into(),
        );
    }
    log::info!("license: signed in via gate ({})", claim.kind);
    Ok(status())
}

fn bind_loopback() -> Result<tiny_http::Server, String> {
    tiny_http::Server::http(OAUTH_BIND_ADDR).map_err(|e| {
        format!(
            "Could not open the sign-in callback port ({OAUTH_BIND_ADDR}): {e}. \
             Close any other sign-in window (or TouchDesigner running TDMap) and try again."
        )
    })
}

/// Serve the loopback until `path` arrives carrying `param` and a matching
/// `cn`, or the deadline lapses. Anything else that finds the port (scans,
/// stray tabs, a mismatched nonce) is answered and ignored — noise must not
/// abort a sign-in the user is mid-way through.
fn wait_for_loopback(
    server: &tiny_http::Server,
    path: &str,
    param: &str,
    cn: &str,
) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(OAUTH_WAIT_SECS);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("Sign-in timed out — try again.".into());
        }
        let request = match server.recv_timeout(left.min(Duration::from_secs(2))) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(e) => return Err(format!("callback listener error: {e}")),
        };
        let url = request.url().to_string();
        if !url.starts_with(path) {
            let _ = request.respond(html_response("Not found.", false, 404));
            continue;
        }
        let params = parse_query(&url);
        if params.get("cn").map(String::as_str) != Some(cn) {
            let _ = request.respond(html_response(
                "This sign-in link was not minted by the launcher session that is \
                 waiting. Start again from TDX Launcher Ultra.",
                false,
                400,
            ));
            continue;
        }
        match params.get(param) {
            Some(v) if !v.is_empty() => {
                let _ = request.respond(html_response(
                    "Signed in — you can close this tab and return to TDX Launcher Ultra.",
                    true,
                    200,
                ));
                return Ok(v.clone());
            }
            _ => {
                let err = params
                    .get("error_description")
                    .or_else(|| params.get("error"))
                    .cloned()
                    .unwrap_or_else(|| "unknown error".into());
                let _ = request.respond(html_response(
                    &format!("Sign-in returned an error: {err}"),
                    false,
                    400,
                ));
                return Err(format!("Sign-in returned an error: {err}"));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sign-out — revoke FIRST, then clear (else signing out doesn't sign out)
// ---------------------------------------------------------------------------

pub fn sign_out(app: &AppHandle) -> LicenseStatus {
    let auth = load_auth();
    let device_token = str_field(&auth, "device_token");
    if !device_token.is_empty() {
        match post_gate("/session/revoke", Some(&device_token), &Value::Null) {
            HttpOutcome::Json(_, _) => {}
            // Offline sign-out still clears locally — the server row ages out
            // on its own TTL, and refusing to sign out offline would strand
            // the user. Logged, not silent.
            HttpOutcome::Network(e) => {
                log::warn!("license: sign-out revoke unreachable ({e}) — cleared locally only");
            }
        }
    }
    save_auth(Map::new());
    // Sign the MACHINE out (§5): the revoked token is dead for the toolkit
    // too, so the shared file goes — unless it already holds a DIFFERENT
    // token (the other product re-signed-in; that session is not ours).
    if !device_token.is_empty() {
        clear_shared_session_if(&device_token);
    }
    {
        let mut s = SESSION.lock().unwrap();
        s.refresh_attempt_mono = None;
        s.adopt_attempt_mono = None;
        s.adopt_attempt_token = None;
        // Signed out means SIGNED OUT: background adoption stays off until
        // an explicit Sign-in click (or the next app start).
        s.adopt_suppressed = true;
    }
    emit_status(app);
    status()
}

// ---------------------------------------------------------------------------
// Re-check — /session/recheck, consumed verbatim (fns-gate.md §6)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecheckReport {
    pub products: Vec<String>,
    /// false = the Patreon grant on the session is DEAD — only a fresh
    /// sign-in helps. The UI must route to sign-in, never offer "check
    /// again". (The cached claim keeps working until its exp regardless.)
    pub connected: bool,
    /// true = this answer is the last known state served during a Patreon
    /// outage — staleness, not a refusal. Surface it as such.
    pub stale: bool,
    pub verified_at: u64,
    pub message: String,
}

/// Force past the gate's 6 h entitlement cache (throttled server-side). A
/// successful, connected re-check renews the cached claim via /entitlement.
pub fn recheck(app: &AppHandle) -> Result<RecheckReport, String> {
    if !enforced() {
        return Err("This build has no license enforcement.".into());
    }
    let auth = load_auth();
    let device_token = str_field(&auth, "device_token");
    if device_token.is_empty() {
        return Err("Not signed in — nothing to re-check.".into());
    }
    let report = match post_gate("/session/recheck", Some(&device_token), &Value::Null) {
        HttpOutcome::Network(e) => {
            return Err(format!("Could not reach the license gate: {e}"))
        }
        HttpOutcome::Json(code, v) => {
            let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
            if !ok {
                return Err(gate_message(
                    &v,
                    &format!("The license gate refused the re-check (HTTP {code})."),
                ));
            }
            RecheckReport {
                products: v
                    .get("products")
                    .and_then(|a| a.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                connected: v.get("connected").and_then(|b| b.as_bool()).unwrap_or(false),
                stale: v.get("stale").and_then(|b| b.as_bool()).unwrap_or(false),
                verified_at: v.get("verified_at").and_then(|n| n.as_u64()).unwrap_or(0),
                message: v
                    .get("message")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
            }
        }
    };
    if report.connected {
        // Renewal is best-effort: the re-check answer stands even if the
        // claim refresh trips (never discard a claim over a failed request).
        if let Err(e) = fetch_and_store_claim(&device_token) {
            log::warn!("license: claim renewal after recheck failed: {}", e.message());
        }
    }
    emit_status(app);
    Ok(report)
}

// ---------------------------------------------------------------------------
// Enforcement points
// ---------------------------------------------------------------------------

/// Update-time entitlement refresh — the frontend calls this before
/// `downloadAndInstall`. Updates are NEVER refused. A Patreon-kind claim
/// refreshes best-effort (the gate re-checks entitlement as it mints);
/// Gumroad is perpetual and never re-checked by decision. A failed refresh
/// keeps the cached claim — never a lockout (fns-gate.md §7).
pub fn verify_for_update(app: &AppHandle, _target_version: &str) -> Result<(), String> {
    if !enforced() {
        return Ok(());
    }
    let auth = load_auth();
    let device_token = str_field(&auth, "device_token");
    let claim_str = str_field(&auth, "claim");
    if device_token.is_empty() || claim_str.is_empty() {
        return Ok(()); // signed out: nothing to refresh
    }
    let kind = match parse_claim(&claim_str, GATE_PUBLIC_KEY, &claim_machine()) {
        Ok(c) => c.kind,
        Err(ClaimError::Expired(c)) => c.kind,
        Err(_) => return Ok(()),
    };
    if kind == "patreon" {
        match fetch_and_store_claim(&device_token) {
            Ok(_) => {}
            Err(FetchError::SignedOut) => handle_definitive_signout(&device_token),
            Err(e) => log::info!(
                "license: update-time claim refresh failed ({}) — keeping cached claim",
                e.message()
            ),
        }
        emit_status(app);
    }
    Ok(())
}

/// Startup entitlement pass. Called once from a background thread at launch:
/// adopts the shared machine session when this install has none (§5), then
/// refreshes a stale Patreon-kind claim best-effort. Everything else is
/// already answered by the cached claim with no network.
pub fn startup_check(app: &AppHandle) {
    if !enforced() {
        return;
    }
    maybe_backfill_shared_session();
    try_adopt_shared_session(false);
    maybe_refresh_claim();
    emit_status(app);
}

/// Refresh the cached claim when it is a Patreon kind older than the renew
/// horizon. Best-effort, throttled per process; failures keep the cache.
fn maybe_refresh_claim() {
    let auth = load_auth();
    let device_token = str_field(&auth, "device_token");
    let claim_str = str_field(&auth, "claim");
    if device_token.is_empty() || claim_str.is_empty() {
        return;
    }
    let kind = match parse_claim(&claim_str, GATE_PUBLIC_KEY, &claim_machine()) {
        Ok(c) => c.kind,
        // An expired Patreon claim still refreshes: the SESSION may well be
        // alive (180 d row TTL) even when the cached claim aged out.
        Err(ClaimError::Expired(c)) => c.kind,
        Err(_) => return,
    };
    if kind != "patreon" {
        return;
    }
    if now_epoch().saturating_sub(u64_field(&auth, "cached_at")) < PATREON_CLAIM_REFRESH_SECS {
        return;
    }
    {
        let mut s = SESSION.lock().unwrap();
        if let Some(t) = s.refresh_attempt_mono {
            if t.elapsed().as_secs() < REFRESH_RETRY_SECS {
                return;
            }
        }
        s.refresh_attempt_mono = Some(Instant::now());
    }
    match fetch_and_store_claim(&device_token) {
        Ok(_) => log::info!("license: claim renewed"),
        Err(FetchError::SignedOut) => handle_definitive_signout(&device_token),
        Err(e) => log::info!(
            "license: claim renewal failed ({}) — keeping cached claim",
            e.message()
        ),
    }
}

/// Background loop: watches for a shared machine session appearing (the
/// user signing in inside TouchDesigner while the launcher runs), renews a
/// stale Patreon claim, and re-emits on transitions. Spawn once at setup.
pub fn spawn_watchdog(app: AppHandle) {
    if !enforced() {
        return;
    }
    std::thread::spawn(move || {
        startup_check(&app);
        loop {
            std::thread::sleep(Duration::from_secs(60));
            try_adopt_shared_session(false);
            maybe_refresh_claim();
            emit_status(&app);
        }
    });
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

fn parse_query(url: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(q) = url.splitn(2, '?').nth(1) else {
        return out;
    };
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        if !k.is_empty() {
            out.insert(urldecode(k), urldecode(v));
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    fn hex_val(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => {
                if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    out.push(hi * 16 + lo);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn html_response(message: &str, ok: bool, code: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let color = if ok { "#3fbf7f" } else { "#e0564f" };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>TDX Launcher Ultra</title></head>\
         <body style=\"background:#141414;color:#eee;font-family:system-ui,sans-serif;\
         display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
         <div style=\"max-width:420px;text-align:center\">\
         <h2 style=\"color:{color}\">TDX Launcher Ultra</h2><p>{}</p></div></body></html>",
        message.replace('<', "&lt;").replace('>', "&gt;")
    );
    let mut resp = tiny_http::Response::from_string(body).with_status_code(code);
    resp.add_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
            .expect("static header"),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::Signer;

    const SPKI_PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];

    fn test_keypair() -> (ed25519_dalek::SigningKey, String) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let mut der = SPKI_PREFIX.to_vec();
        der.extend_from_slice(sk.verifying_key().as_bytes());
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        (sk, b64)
    }

    fn mint(sk: &ed25519_dalek::SigningKey, payload: &Value) -> String {
        let b64u = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
        let header = serde_json::json!({ "alg": "EdDSA", "typ": "JWT" });
        let body = format!(
            "{}.{}",
            b64u(header.to_string().as_bytes()),
            b64u(payload.to_string().as_bytes())
        );
        let sig = sk.sign(body.as_bytes());
        format!("{body}.{}", b64u(&sig.to_bytes()))
    }

    fn payload(machine: &str, exp: i64) -> Value {
        serde_json::json!({
            "iss": "fnstools", "sub": "abc", "machine": machine,
            "kind": "patreon", "products": ["FNS_TimelineTools"],
            "trial_expires_at": null,
            "iat": now_epoch(), "exp": now_epoch() as i64 + exp,
        })
    }

    #[test]
    fn claim_roundtrip_verifies() {
        let (sk, pubkey) = test_keypair();
        let jwt = mint(&sk, &payload("m1", 3600));
        let c = parse_claim(&jwt, &pubkey, "m1").expect("valid claim");
        assert_eq!(c.kind, "patreon");
        assert_eq!(c.products, vec!["FNS_TimelineTools".to_string()]);
        assert!(c.exp > now_epoch());
    }

    #[test]
    fn expired_claim_carries_its_payload() {
        let (sk, pubkey) = test_keypair();
        let jwt = mint(&sk, &payload("m1", -10));
        match parse_claim(&jwt, &pubkey, "m1") {
            Err(ClaimError::Expired(c)) => assert_eq!(c.kind, "patreon"),
            other => panic!("expected Expired, got {other:?}"),
        }
    }

    #[test]
    fn foreign_machine_is_mismatch_not_expiry() {
        let (sk, pubkey) = test_keypair();
        // Expired AND foreign: the machine check must win, so a copied file
        // reads as "not yours" rather than "sign in again".
        let jwt = mint(&sk, &payload("other-machine", -10));
        assert!(matches!(
            parse_claim(&jwt, &pubkey, "m1"),
            Err(ClaimError::MachineMismatch)
        ));
    }

    #[test]
    fn tampered_payload_fails_signature() {
        let (sk, pubkey) = test_keypair();
        let jwt = mint(&sk, &payload("m1", 3600));
        let mut parts: Vec<&str> = jwt.split('.').collect();
        let forged = serde_json::json!({
            "iss": "fnstools", "machine": "m1", "kind": "patreon",
            "products": ["FNS_TimelineTools", "Everything_Else"],
            "iat": 0, "exp": now_epoch() + 9999,
        });
        let forged_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(forged.to_string().as_bytes());
        parts[1] = &forged_b64;
        let tampered = parts.join(".");
        assert!(matches!(
            parse_claim(&tampered, &pubkey, "m1"),
            Err(ClaimError::BadSignature)
        ));
    }

    #[test]
    fn wrong_key_fails_signature() {
        let (sk, _) = test_keypair();
        let other = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let mut der = SPKI_PREFIX.to_vec();
        der.extend_from_slice(other.verifying_key().as_bytes());
        let other_pub = base64::engine::general_purpose::STANDARD.encode(der);
        let jwt = mint(&sk, &payload("m1", 3600));
        assert!(matches!(
            parse_claim(&jwt, &other_pub, "m1"),
            Err(ClaimError::BadSignature)
        ));
    }

    #[test]
    fn wrong_issuer_refused() {
        let (sk, pubkey) = test_keypair();
        let mut p = payload("m1", 3600);
        p["iss"] = Value::String("notus".into());
        assert!(matches!(
            parse_claim(&mint(&sk, &p), &pubkey, "m1"),
            Err(ClaimError::WrongIssuer)
        ));
    }

    #[test]
    fn empty_key_fails_closed() {
        let (sk, _) = test_keypair();
        let jwt = mint(&sk, &payload("m1", 3600));
        assert!(matches!(parse_claim(&jwt, "", "m1"), Err(ClaimError::NoKey)));
        assert!(matches!(
            parse_claim(&jwt, "not base64!!", "m1"),
            Err(ClaimError::NoKey)
        ));
    }

    #[test]
    fn garbage_jwt_is_malformed_not_panic() {
        let (_, pubkey) = test_keypair();
        for bad in ["", "a.b", "a.b.c.d", "!!.!!.!!"] {
            assert!(matches!(
                parse_claim(bad, &pubkey, "m1"),
                Err(ClaimError::Malformed)
            ));
        }
    }

    #[test]
    fn spki_parses_only_ed25519_shape() {
        let (_, pubkey) = test_keypair();
        assert!(spki_ed25519(&pubkey).is_some());
        assert!(spki_ed25519("").is_none());
        // Right length, wrong DER prefix.
        let bogus = base64::engine::general_purpose::STANDARD.encode([0u8; 44]);
        assert!(spki_ed25519(&bogus).is_none());
    }

    #[test]
    fn fingerprint_is_stable_and_32_hex() {
        let a = machine_fingerprint();
        let b = machine_fingerprint();
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(claim_machine().len(), 64);
    }

    #[test]
    fn embedded_gate_key_is_a_valid_ed25519_spki() {
        // The shipped trust anchor. A mangled paste (or an emptied value)
        // must fail HERE, loudly, not as a silent signed-out state in the
        // field. Value pinned from GET /pubkey (worker 9ea13ff8) and
        // cross-checked against the deployed gate on 2026-08-30.
        assert!(
            spki_ed25519(GATE_PUBLIC_KEY).is_some(),
            "GATE_PUBLIC_KEY is not a 44-byte Ed25519 SPKI"
        );
        assert!(gate_key_configured());
    }

    #[test]
    fn shared_session_parsing() {
        // The §5 wire shape.
        let good = r#"{ "schema": 1, "device_token": "abc123",
                        "written_by": "fnstools", "written_at": 1756500000 }"#;
        assert_eq!(parse_shared_session(good).as_deref(), Some("abc123"));
        // Token-only still counts — the extras are informational.
        assert_eq!(
            parse_shared_session(r#"{"device_token":" t "}"#).as_deref(),
            Some("t")
        );
        // Absent, empty, wrong type, or garbage → no adoption, no panic.
        for bad in [
            r#"{}"#,
            r#"{"device_token":""}"#,
            r#"{"device_token":42}"#,
            "not json",
            "",
        ] {
            assert!(parse_shared_session(bad).is_none(), "case: {bad}");
        }
    }

    #[test]
    fn query_parsing() {
        let p = parse_query("/fns-auth?code=abc%2B1&cn=xy+z");
        assert_eq!(p.get("code").map(String::as_str), Some("abc+1"));
        assert_eq!(p.get("cn").map(String::as_str), Some("xy z"));
        assert!(parse_query("/fns-auth").is_empty());
    }

}
