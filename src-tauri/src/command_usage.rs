//! Shared command usage — `<user palette>/FNSTools/config/command-usage.json`.
//!
//! Frequently run commands rank higher, as a bounded tie-breaker, in BOTH
//! command palettes that run registry commands: FNS_CommandPalette inside TD
//! and this launcher's quick-launch overlay. The contract lives with the
//! toolkit: FNSTools `docs/CommandUsage.md` (in force 2026-09-23).
//!
//! - Each consumer writes only its own block (`consumers.tdxlu` here) and
//!   reads every block, so a command run often from FNSTools' palette rises
//!   here too, and the other way round.
//! - An entry stores a DECAYED score plus the time it was last run, so old
//!   heavy use fades (14-day half-life) instead of pinning a command forever.
//! - Every write re-reads the file and changes one key on the value just
//!   read: several TDs write the `fnstools` block concurrently, and a block
//!   written from memory would erase their increments. This process is the
//!   only `tdxlu` writer, serialized by [`WRITE_LOCK`] across both windows.
//!
//! Resolved exactly as `command-curation.json` is: always the machine-default
//! user palette folder ([`crate::fns_store::fns_palette_dir`]), never a
//! relocated store.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// This launcher's block name in `consumers`.
pub const CONSUMER: &str = "tdxlu";
/// The highest document schema this code understands.
pub const SCHEMA: u64 = 1;
/// Pinned by the contract; both sides compute identically (IEEE double).
pub const HALF_LIFE: f64 = 1_209_600.0; // 14 days, in seconds
pub const V_SAT: f64 = 20.0;
pub const BONUS_MAX: f64 = 8.0;
pub const PRUNE_BELOW: f64 = 0.01;

/// Serializes this process's read-modify-write cycles. The main window and
/// the quick overlay are separate webviews that can both reach the file.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn usage_path() -> PathBuf {
    crate::fns_store::fns_palette_dir()
        .join("config")
        .join("command-usage.json")
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// `0.5 ** (max(0, dt) / HALF_LIFE)` — a `last` in the future counts as now.
pub fn decay(dt: f64) -> f64 {
    0.5f64.powf(dt.max(0.0) / HALF_LIFE)
}

/// The ranking bonus for a summed, decayed usage value: `[0, BONUS_MAX]`,
/// log-scaled so the first few runs matter most, used unrounded.
pub fn bonus(v: f64) -> f64 {
    if v <= 0.0 {
        return 0.0;
    }
    (BONUS_MAX * (1.0 + v).ln() / (1.0 + V_SAT).ln()).min(BONUS_MAX)
}

/// The curation identity a run counts against: `tool#id`, with any
/// `@instance` pin dropped (a preset's target may carry one). `None` for
/// anything that is not a `tool#id` — session verbs, app actions, projects
/// and `.tox` placement never touch the file.
pub fn usage_key(identity: &str) -> Option<String> {
    let identity = identity.trim();
    let (tool, rest) = identity.split_once('#')?;
    let id = rest.split('@').next().unwrap_or("").trim();
    let tool = tool.trim();
    (!tool.is_empty() && !id.is_empty()).then(|| format!("{tool}#{id}"))
}

/// What reading the file found.
enum Doc {
    Missing,
    Ok(Map<String, Value>),
    /// A schema newer than [`SCHEMA`]: read nothing, write nothing.
    Newer,
    /// Unparseable, or not the document shape: park it.
    Corrupt,
}

fn read_doc(path: &Path) -> Result<Doc, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Doc::Missing),
        // Held open / unreadable right now is not corruption: never park a
        // file just because another writer had it at that instant.
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(&text) else {
        return Ok(Doc::Corrupt);
    };
    let Some(schema) = doc.get("schema").and_then(Value::as_u64) else {
        return Ok(Doc::Corrupt);
    };
    if schema > SCHEMA {
        return Ok(Doc::Newer);
    }
    match doc.get("consumers") {
        None | Some(Value::Object(_)) => Ok(Doc::Ok(doc)),
        Some(_) => Ok(Doc::Corrupt),
    }
}

/// Move an unreadable file aside as `<file>.corrupt-<epoch>`. Two consumers
/// can each park the same file; that leaves two copies and loses nothing
/// that was readable.
fn park(path: &Path) {
    let parked = path.with_file_name(format!(
        "{}.corrupt-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("command-usage.json"),
        now_secs() as u64
    ));
    let _ = fs::rename(path, parked);
}

/// Temp file in the same folder, renamed over the target, the rename retried
/// a few times for Windows sharing violations (curation rule 3).
fn write_atomic(path: &Path, doc: &Value) -> Result<(), String> {
    let dir = path.parent().ok_or("usage file has no folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        "{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("command-usage.json"),
        std::process::id()
    ));
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    let mut last_err = None;
    for attempt in 0..5 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < 4 {
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(format!(
        "could not replace {}: {}",
        path.display(),
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn entry_value(e: &Value, now: f64) -> f64 {
    let score = e.get("score").and_then(Value::as_f64).unwrap_or(0.0);
    let last = e.get("last").and_then(Value::as_f64).unwrap_or(now);
    score * decay(now - last)
}

/// Record one successful run of `identity` at `now`. Returns whether the file
/// was written (`false` for a non-command identity or a newer schema).
pub fn record_at(path: &Path, identity: &str, now: f64) -> Result<bool, String> {
    let Some(key) = usage_key(identity) else {
        return Ok(false);
    };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut doc = match read_doc(path)? {
        Doc::Newer => return Ok(false),
        Doc::Ok(doc) => doc,
        Doc::Missing => Map::new(),
        Doc::Corrupt => {
            park(path);
            Map::new()
        }
    };
    doc.insert("schema".into(), json!(SCHEMA));
    let consumers = doc
        .entry("consumers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("consumers is not an object")?;
    let own = consumers
        .entry(CONSUMER)
        .or_insert_with(|| Value::Object(Map::new()));
    if !own.is_object() {
        *own = Value::Object(Map::new());
    }
    let own = own.as_object_mut().expect("just made an object");

    let prev = own.get(&key);
    let (score, count) = match prev {
        Some(e) => (
            entry_value(e, now) + 1.0,
            e.get("count").and_then(Value::as_u64).unwrap_or(0) + 1,
        ),
        None => (1.0, 1),
    };
    own.insert(key, json!({ "score": score, "last": now, "count": count }));
    // Prune only our own block; every other block stays exactly as read.
    own.retain(|_, e| entry_value(e, now) >= PRUNE_BELOW);

    write_atomic(path, &Value::Object(doc))?;
    Ok(true)
}

pub fn record(identity: &str) -> Result<bool, String> {
    record_at(&usage_path(), identity, now_secs())
}

/// `tool#id` -> ranking bonus, summed across EVERY consumer block. Empty for
/// a missing, unreadable, corrupt or newer-schema file: no bonus, no error —
/// usage is a tie-breaker, never a reason for the palette to fail.
pub fn bonuses_at(path: &Path, now: f64) -> HashMap<String, f64> {
    let Ok(Doc::Ok(doc)) = read_doc(path) else {
        return HashMap::new();
    };
    let mut sums: HashMap<String, f64> = HashMap::new();
    if let Some(Value::Object(consumers)) = doc.get("consumers") {
        for block in consumers.values() {
            let Value::Object(block) = block else { continue };
            for (k, e) in block {
                *sums.entry(k.clone()).or_default() += entry_value(e, now);
            }
        }
    }
    sums.into_iter()
        .map(|(k, v)| (k, bonus(v)))
        .filter(|(_, b)| *b > 0.0)
        .collect()
}

pub fn bonuses() -> HashMap<String, f64> {
    bonuses_at(&usage_path(), now_secs())
}

/// Clear the launcher's OWN history. The FNSTools block is untouched, and
/// ranking sums every block, so its history keeps counting — the Settings
/// copy says so.
pub fn clear_own_at(path: &Path) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    match read_doc(path)? {
        Doc::Missing => Ok(()),
        Doc::Newer => Err("the usage file is from a newer FNSTools; left untouched".into()),
        Doc::Corrupt => {
            // Nothing in it was readable, ours included.
            park(path);
            Ok(())
        }
        Doc::Ok(mut doc) => {
            let had = doc
                .get_mut("consumers")
                .and_then(Value::as_object_mut)
                .map(|c| c.remove(CONSUMER).is_some())
                .unwrap_or(false);
            if had {
                write_atomic(path, &Value::Object(doc))?;
            }
            Ok(())
        }
    }
}

pub fn clear_own() -> Result<(), String> {
    clear_own_at(&usage_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: f64 = 86_400.0;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 5e-5 // "compare to 4 decimal places"
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tdxlu-usage-{}-{}-{name}",
            std::process::id(),
            now_secs() as u64
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("command-usage.json")
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    // --- the contract's seven test vectors -------------------------------

    #[test]
    fn vector_never_used() {
        assert_eq!(bonus(0.0), 0.0);
    }

    #[test]
    fn vector_one_run_just_now() {
        assert!(close(bonus(1.0), 1.8214), "{}", bonus(1.0));
    }

    #[test]
    fn vector_one_run_a_half_life_ago() {
        let v = 1.0 * decay(HALF_LIFE);
        assert!(close(v, 0.5));
        assert!(close(bonus(v), 1.0654), "{}", bonus(v));
    }

    #[test]
    fn vector_update_after_one_half_life() {
        let score = 4.0 * decay(HALF_LIFE) + 1.0;
        assert!(close(score, 3.0), "{score}");
    }

    #[test]
    fn vector_summed_across_consumers() {
        assert!(close(bonus(3.0 + 2.0), 4.7082), "{}", bonus(5.0));
    }

    #[test]
    fn vector_saturated() {
        assert_eq!(bonus(20.0), 8.0);
        assert_eq!(bonus(100.0), 8.0);
    }

    #[test]
    fn vector_old_heavy_use_fades() {
        let v = 101.0 * decay(365.0 * DAY);
        assert!(v < 1.5e-6 && v > 1.4e-6, "{v}");
        assert!(close(bonus(v), 0.0));
    }

    #[test]
    fn future_last_counts_as_now() {
        assert_eq!(decay(-500.0), 1.0);
    }

    // --- identities --------------------------------------------------------

    #[test]
    fn keys_are_tool_hash_id_with_the_instance_pin_dropped() {
        assert_eq!(usage_key("Scope#freeze").as_deref(), Some("Scope#freeze"));
        assert_eq!(usage_key("Scope#freeze@Main out").as_deref(), Some("Scope#freeze"));
        assert_eq!(usage_key(" Autosave#save-now ").as_deref(), Some("Autosave#save-now"));
        for bad in ["", "focus", "#id", "tool#", "tool#@inst"] {
            assert_eq!(usage_key(bad), None, "{bad:?}");
        }
    }

    // --- file rules --------------------------------------------------------

    #[test]
    fn first_run_creates_the_document() {
        let p = scratch("create");
        assert!(record_at(&p, "Autosave#save-now", 1000.0).unwrap());
        let d = read(&p);
        assert_eq!(d["schema"], 1);
        let e = &d["consumers"]["tdxlu"]["Autosave#save-now"];
        assert_eq!(e["score"], 1.0);
        assert_eq!(e["last"], 1000.0);
        assert_eq!(e["count"], 1);
    }

    #[test]
    fn a_run_decays_then_adds_one() {
        let p = scratch("decay");
        record_at(&p, "T#a", 0.0).unwrap();
        record_at(&p, "T#a", 0.0).unwrap(); // score 2 at t=0
        record_at(&p, "T#a", HALF_LIFE).unwrap(); // 2 * 0.5 + 1
        let e = &read(&p)["consumers"]["tdxlu"]["T#a"];
        assert!(close(e["score"].as_f64().unwrap(), 2.0));
        assert_eq!(e["count"], 3);
    }

    #[test]
    fn other_blocks_survive_exactly_as_read() {
        let p = scratch("others");
        let theirs = json!({"T#a": {"score": 3.0, "last": 50.0, "count": 5},
                            "Old#x": {"score": 0.001, "last": 0.0, "count": 1}});
        fs::write(
            &p,
            json!({"schema": 1, "consumers": {"fnstools": theirs.clone()}}).to_string(),
        )
        .unwrap();
        record_at(&p, "T#a", 100.0).unwrap();
        let d = read(&p);
        // Theirs untouched -- including an entry below the prune line, which
        // only its own writer may prune.
        assert_eq!(d["consumers"]["fnstools"], theirs);
        assert_eq!(d["consumers"]["tdxlu"]["T#a"]["count"], 1);
    }

    #[test]
    fn bonuses_sum_every_block() {
        let p = scratch("sum");
        fs::write(
            &p,
            json!({"schema": 1, "consumers": {
                "fnstools": {"T#a": {"score": 3.0, "last": 0.0, "count": 3}},
                "tdxlu":    {"T#a": {"score": 2.0, "last": 0.0, "count": 2},
                             "T#b": {"score": 1.0, "last": 0.0, "count": 1}}
            }})
            .to_string(),
        )
        .unwrap();
        let b = bonuses_at(&p, 0.0);
        assert!(close(b["T#a"], 4.7082));
        assert!(close(b["T#b"], 1.8214));
    }

    #[test]
    fn our_own_decayed_entries_are_pruned_on_write() {
        let p = scratch("prune");
        record_at(&p, "T#stale", 0.0).unwrap();
        // 100 days on, one run falls under PRUNE_BELOW (~93 days).
        record_at(&p, "T#fresh", 100.0 * DAY).unwrap();
        let own = read(&p)["consumers"]["tdxlu"].clone();
        assert!(own.get("T#stale").is_none());
        assert!(own.get("T#fresh").is_some());
    }

    #[test]
    fn a_newer_schema_is_left_untouched() {
        let p = scratch("newer");
        let newer = json!({"schema": 2, "whatever": true}).to_string();
        fs::write(&p, &newer).unwrap();
        assert!(!record_at(&p, "T#a", 1.0).unwrap());
        assert_eq!(fs::read_to_string(&p).unwrap(), newer);
        assert!(bonuses_at(&p, 1.0).is_empty());
        assert!(clear_own_at(&p).is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), newer);
    }

    #[test]
    fn a_corrupt_file_is_parked_and_replaced_fresh() {
        let p = scratch("corrupt");
        fs::write(&p, "{ not json").unwrap();
        assert!(bonuses_at(&p, 1.0).is_empty());
        record_at(&p, "T#a", 1.0).unwrap();
        let d = read(&p);
        assert_eq!(d["consumers"]["tdxlu"]["T#a"]["count"], 1);
        assert_eq!(d["consumers"].as_object().unwrap().len(), 1);
        let parked = fs::read_dir(p.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(parked, 1);
    }

    #[test]
    fn non_commands_never_touch_the_file() {
        let p = scratch("noncmd");
        assert!(!record_at(&p, "focus", 1.0).unwrap());
        assert!(!p.exists());
    }

    #[test]
    fn clear_removes_only_our_block() {
        let p = scratch("clear");
        fs::write(
            &p,
            json!({"schema": 1, "consumers": {
                "fnstools": {"T#a": {"score": 1.0, "last": 0.0, "count": 1}},
                "tdxlu":    {"T#b": {"score": 1.0, "last": 0.0, "count": 1}}
            }})
            .to_string(),
        )
        .unwrap();
        clear_own_at(&p).unwrap();
        let d = read(&p);
        assert!(d["consumers"].get("tdxlu").is_none());
        assert_eq!(d["consumers"]["fnstools"]["T#a"]["count"], 1);
        // Missing file: nothing to clear, not an error.
        clear_own_at(&scratch("clear-missing")).unwrap();
    }
}
