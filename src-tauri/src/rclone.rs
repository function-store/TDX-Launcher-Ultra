//! Direct-to-cloud backup via a managed `rclone` binary.
//!
//! rclone gives us the FreeFileSync experience for every major provider with
//! zero per-provider app registrations: `rclone config create` opens the
//! system browser, runs the OAuth loopback dance itself, and stores the
//! refresh token in our own config file (`{config_dir}/rclone.conf`, kept
//! separate from any rclone the user already has). The binary is downloaded
//! on first use into `{config_dir}/rclone/` — the installer stays lean.
//!
//! Cloud transfers reuse the Backup panel's plan/run model: `--dry-run` with
//! `--use-json-log` produces the plan, the real run reports per-file copies
//! plus a final stats object. Cloud mode is Backup/Restore only (no two-way
//! sync in v1 — rclone bisync is not solid enough to trust silently).

use crate::backup::{BackupFileOp, BackupFilters, BackupPlan, BackupResult, BackupTargetInfo};
use crate::config::ConfigManager;
use crate::proc;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Default base folder on the remote for all project backups (the
/// `cloud_backup_root` pref; overridable in Settings).
pub fn default_cloud_backup_root() -> String {
    "TDXLU-Backups".into()
}

/// OAuth providers offered in the UI: (rclone type, label, extra create params).
/// `drive` pins `scope=drive` so the default question answer is explicit.
pub const PROVIDERS: &[(&str, &str, &[(&str, &str)])] = &[
    ("drive", "Google Drive", &[("scope", "drive")]),
    ("dropbox", "Dropbox", &[]),
    ("onedrive", "OneDrive", &[]),
    ("box", "Box", &[]),
];

#[derive(Debug, Clone, Serialize)]
pub struct RcloneRemote {
    pub name: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RcloneStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub config_path: String,
    pub remotes: Vec<RcloneRemote>,
}

fn rclone_dir() -> PathBuf {
    ConfigManager::config_dir().join("rclone")
}

fn rclone_conf_path() -> PathBuf {
    ConfigManager::config_dir().join("rclone.conf")
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    }
}

/// App-managed copy first, then PATH. Re-probed each call (install can land
/// mid-session).
pub fn find_rclone() -> Option<PathBuf> {
    let managed = rclone_dir().join(exe_name());
    if managed.is_file() {
        return Some(managed);
    }
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = proc::command(finder).arg("rclone").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let p = PathBuf::from(first);
    p.is_file().then_some(p)
}

/// Run rclone with our private config file injected.
fn run_rclone(args: &[&str]) -> Result<std::process::Output, String> {
    let bin = find_rclone().ok_or_else(|| "rclone is not installed yet".to_string())?;
    let conf = rclone_conf_path();
    proc::command(&bin)
        .arg("--config")
        .arg(&conf)
        .args(args)
        .output()
        .map_err(|e| format!("rclone failed to start: {e}"))
}

fn version_of(bin: &Path) -> Option<String> {
    let out = proc::command(bin).arg("version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // First line: "rclone v1.75.0"
    text.lines()
        .next()
        .map(|l| l.trim().trim_start_matches("rclone ").to_string())
        .filter(|s| !s.is_empty())
}

fn list_remotes() -> Vec<RcloneRemote> {
    let Ok(out) = run_rclone(&["config", "dump"]) else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    let Ok(map) = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&out.stdout)
    else {
        return vec![];
    };
    let mut remotes: Vec<RcloneRemote> = map
        .into_iter()
        .map(|(name, v)| RcloneRemote {
            provider: v
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string(),
            name,
        })
        .collect();
    remotes.sort_by(|a, b| a.name.cmp(&b.name));
    remotes
}

pub fn status() -> RcloneStatus {
    let bin = find_rclone();
    let version = bin.as_deref().and_then(version_of);
    RcloneStatus {
        available: bin.is_some(),
        version,
        path: bin.map(|p| p.to_string_lossy().replace('\\', "/")),
        config_path: rclone_conf_path().to_string_lossy().replace('\\', "/"),
        remotes: list_remotes(),
    }
}

// ----- Install (download-on-demand, like tox_cache) -----

fn download_url() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "osx",
        "linux" => "linux",
        other => return Err(format!("Unsupported OS for rclone download: {other}")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => return Err(format!("Unsupported architecture for rclone download: {other}")),
    };
    Ok(format!(
        "https://downloads.rclone.org/rclone-current-{os}-{arch}.zip"
    ))
}

fn extract_zip(zip: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut cmd = if cfg!(windows) {
        let mut c = proc::command("powershell");
        c.args(["-NoProfile", "-Command", "Expand-Archive", "-Force", "-Path"])
            .arg(zip)
            .arg("-DestinationPath")
            .arg(dest);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = proc::command("ditto");
        c.args(["-x", "-k"]).arg(zip).arg(dest);
        c
    } else {
        let mut c = proc::command("unzip");
        c.args(["-o", "-q"]).arg(zip).arg("-d").arg(dest);
        c
    };
    let out = cmd.output().map_err(|e| format!("extract: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "extract failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn find_extracted_exe(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_extracted_exe(&p) {
                return Some(found);
            }
        } else if p.file_name().map(|n| n == exe_name()).unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

/// Download the current rclone build into `{config_dir}/rclone/` (~20 MB).
pub fn install() -> Result<RcloneStatus, String> {
    let dir = rclone_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let url = download_url()?;
    let zip = dir.join("rclone-download.zip");
    let extract_dir = dir.join("extract");

    // Blocking HTTP must not run on the async runtime — see proc::off_runtime.
    proc::off_runtime(|| -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .header("User-Agent", "TDXLU")
            .send()
            .map_err(|e| format!("download: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("download HTTP {} from {url}", resp.status()));
        }
        let bytes = resp.bytes().map_err(|e| format!("download: {e}"))?;
        fs::write(&zip, &bytes).map_err(|e| e.to_string())
    })?;

    let _ = fs::remove_dir_all(&extract_dir);
    extract_zip(&zip, &extract_dir)?;
    let exe = find_extracted_exe(&extract_dir)
        .ok_or_else(|| "downloaded archive did not contain rclone".to_string())?;
    let dest = dir.join(exe_name());
    let _ = fs::remove_file(&dest);
    fs::rename(&exe, &dest).or_else(|_| fs::copy(&exe, &dest).map(|_| ()).map_err(|e| e.to_string()))?;
    let _ = fs::remove_dir_all(&extract_dir);
    let _ = fs::remove_file(&zip);

    if !dest.is_file() {
        return Err("rclone install failed: binary missing after extract".into());
    }
    Ok(status())
}

// ----- Remotes -----

fn validate_remote_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && name.chars().next().map(|c| c != '-').unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("Remote name must be letters, digits, - or _".into())
    }
}

/// Create a remote. For OAuth providers rclone opens the system browser and
/// completes the loopback flow itself; this blocks until the user approves
/// (or rclone gives up). Unanswered config questions take rclone's defaults.
pub fn add_remote(name: &str, provider: &str) -> Result<RcloneStatus, String> {
    let name = name.trim();
    validate_remote_name(name)?;
    let (ptype, _, params) = PROVIDERS
        .iter()
        .find(|(t, _, _)| *t == provider)
        .ok_or_else(|| format!("Unknown provider: {provider}"))?;
    if list_remotes().iter().any(|r| r.name == name) {
        return Err(format!("A remote named \"{name}\" already exists"));
    }

    let mut args: Vec<String> = vec!["config".into(), "create".into(), name.into(), (*ptype).into()];
    for (k, v) in params.iter() {
        args.push(format!("{k}={v}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_rclone(&arg_refs)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // If the create half-finished, don't leave a broken token-less remote.
        let _ = run_rclone(&["config", "delete", name]);
        return Err(format!(
            "Connecting {provider} failed: {}",
            last_meaningful_line(&err)
        ));
    }
    Ok(status())
}

pub fn delete_remote(name: &str) -> Result<RcloneStatus, String> {
    validate_remote_name(name.trim())?;
    let out = run_rclone(&["config", "delete", name.trim()])?;
    if !out.status.success() {
        return Err(format!(
            "Delete failed: {}",
            last_meaningful_line(&String::from_utf8_lossy(&out.stderr))
        ));
    }
    Ok(status())
}

fn last_meaningful_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .next_back()
        .unwrap_or("unknown error")
        .to_string()
}

// ----- Cloud plan / run -----

/// `remote:path` destination for a project: `{cloud_root}/{project name}`, or
/// the per-project override verbatim. Custom paths must stay inside the
/// remote (no `:` — that would switch remotes / drive letters).
fn remote_spec(
    remote: &str,
    project_dir: &Path,
    path_override: Option<&str>,
    cloud_root: &str,
) -> Result<String, String> {
    validate_remote_name(remote)?;
    let clean = |p: &str| -> Result<String, String> {
        let p = p.replace('\\', "/");
        if p.contains(':') {
            return Err("Remote path cannot contain ':'".into());
        }
        Ok(p.trim().trim_matches('/').to_string())
    };
    let sub = match path_override.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => clean(p)?,
        None => {
            let name = project_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "project".into());
            let root = clean(cloud_root)?;
            if root.is_empty() {
                name
            } else {
                format!("{root}/{name}")
            }
        }
    };
    Ok(format!("{remote}:{sub}"))
}

/// Translate the Settings filter prefs into rclone `--filter` rules.
/// First match wins in rclone, so: excludes, then includes + catch-all
/// exclude when an include list is present. Directory patterns (trailing
/// `/`) become `dir/**`. `--ignore-case` matches the local engine.
fn filter_args(filters: &BackupFilters) -> Vec<String> {
    let mut args: Vec<String> = vec!["--ignore-case".into()];
    let dirify = |p: &str| -> String {
        let p = p.trim().replace('\\', "/");
        if let Some(stripped) = p.strip_suffix('/') {
            format!("{stripped}/**")
        } else {
            p
        }
    };
    for pat in &filters.exclude {
        let p = dirify(pat);
        if p.is_empty() {
            continue;
        }
        args.push("--filter".into());
        args.push(format!("- {p}"));
    }
    let includes: Vec<String> = filters
        .include
        .iter()
        .map(|p| dirify(p))
        .filter(|p| !p.is_empty())
        .collect();
    if !includes.is_empty() {
        for p in &includes {
            args.push("--filter".into());
            args.push(format!("+ {p}"));
        }
        args.push("--filter".into());
        args.push("- **".into());
    }
    if filters.max_file_bytes > 0 {
        args.push("--max-size".into());
        args.push(format!("{}B", filters.max_file_bytes));
    }
    args
}

fn local_dir_arg(dir: &Path) -> String {
    dir.to_string_lossy().replace('\\', "/")
}

/// Escape rclone glob metacharacters so a literal path stays literal.
fn escape_rclone_glob(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for c in p.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '{' | '}' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Write locally git-ignored paths as rclone exclude rules to a temp file
/// (`--filter-from`), sidestepping command-line length limits. None when the
/// project ignores nothing. Remote-only ignored files (restore direction)
/// are not covered — git can only report on the local tree here.
fn gitignore_rules_file(local_dir: &Path) -> Option<std::path::PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let ignored = crate::git::ignored_untracked(local_dir);
    if ignored.is_empty() {
        return None;
    }
    let mut rules = String::new();
    for entry in ignored {
        if let Some(dir) = entry.strip_suffix('/') {
            rules.push_str(&format!("- {}/**\n", escape_rclone_glob(dir)));
        } else {
            rules.push_str(&format!("- {}\n", escape_rclone_glob(&entry)));
        }
    }
    let path = std::env::temp_dir().join(format!(
        "tdxlu-gitignore-{}-{}.filter",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    std::fs::write(&path, rules).ok()?;
    Some(path)
}

/// `--filter-from` rules for the gitignore toggle, or None when off / not a
/// repo / nothing ignored. Also reports whether the project is a repo.
fn gitignore_filtering(local_dir: &Path, filters: &BackupFilters) -> (bool, Option<std::path::PathBuf>) {
    let git_repo = crate::git::is_git_repo_dir(local_dir);
    let rules = if filters.respect_gitignore && git_repo {
        gitignore_rules_file(local_dir)
    } else {
        None
    };
    (git_repo, rules)
}

struct ParsedLog {
    ops: Vec<BackupFileOp>,
    errors: Vec<String>,
    /// From the final stats object: files already up to date.
    checks: u64,
    transfers: u64,
    bytes: u64,
}

/// Parse `--use-json-log` output. Dry-run copy candidates carry
/// `"skipped":"copy"`; real copies log `msg:"Copied (…)"`; the last line
/// carries a `stats` object with totals.
fn parse_json_log(stderr: &str, direction: &str, reason: &str) -> ParsedLog {
    let mut parsed = ParsedLog {
        ops: vec![],
        errors: vec![],
        checks: 0,
        transfers: 0,
        bytes: 0,
    };
    for line in stderr.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let level = v.get("level").and_then(|l| l.as_str()).unwrap_or("");
        let msg = v.get("msg").and_then(|m| m.as_str()).unwrap_or("");
        let object = v.get("object").and_then(|o| o.as_str());
        let size = v.get("size").and_then(|s| s.as_u64()).unwrap_or(0);

        if level == "error" {
            let what = match object {
                Some(o) => format!("{o}: {msg}"),
                None => msg.to_string(),
            };
            if parsed.errors.len() < 20 {
                parsed.errors.push(what);
            }
            continue;
        }
        let skipped_copy = v.get("skipped").and_then(|s| s.as_str()) == Some("copy");
        let copied = msg.starts_with("Copied");
        if (skipped_copy || copied) && object.is_some() {
            parsed.ops.push(BackupFileOp {
                relative: object.unwrap_or_default().to_string(),
                direction: direction.to_string(),
                reason: reason.to_string(),
                bytes: size,
            });
        }
        if let Some(stats) = v.get("stats") {
            parsed.checks = stats.get("checks").and_then(|c| c.as_u64()).unwrap_or(0);
            parsed.transfers = stats.get("transfers").and_then(|t| t.as_u64()).unwrap_or(0);
            parsed.bytes = stats.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0);
        }
    }
    parsed
}

/// (source, dest, op direction, op reason) for a cloud transfer.
fn transfer_ends<'a>(
    mode: &str,
    local: &'a str,
    remote: &'a str,
) -> Result<(&'a str, &'a str, &'static str, &'static str), String> {
    match mode.trim().to_lowercase().as_str() {
        "backup" => Ok((local, remote, "to_remote", "new or newer on local")),
        "restore" => Ok((remote, local, "to_local", "new or newer on remote")),
        "sync" => Err(
            "Two-way sync is not supported for cloud remotes yet — use Backup or Restore".into(),
        ),
        other => Err(format!("Unknown mode '{other}' (use backup or restore)")),
    }
}

fn run_transfer(
    src: &str,
    dst: &str,
    filters: &BackupFilters,
    gitignore_rules: Option<&Path>,
    dry_run: bool,
) -> Result<std::process::Output, String> {
    let mut args: Vec<String> = vec![
        "copy".into(),
        src.into(),
        dst.into(),
        "--update".into(),
        "--use-json-log".into(),
        "--log-level".into(),
        "INFO".into(),
    ];
    if dry_run {
        args.push("--dry-run".into());
    }
    // Before the user filters so an include list cannot resurrect ignored files.
    if let Some(rules) = gitignore_rules {
        args.push("--filter-from".into());
        args.push(rules.to_string_lossy().to_string());
    }
    args.extend(filter_args(filters));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_rclone(&arg_refs)
}

/// Live progress of a cloud transfer, from rclone's periodic stats lines.
#[derive(Debug, Clone, Default)]
pub struct CloudProgress {
    /// Files transferred so far / total files rclone plans to move.
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
    pub total_bytes: u64,
    /// File currently in flight (or last completed).
    pub detail: String,
}

/// Real (non-dry) transfer, streaming rclone's json log line-by-line so the
/// caller can report progress while it runs. `--stats 1s` makes rclone emit a
/// stats object every second mid-transfer. Returns (success, full stderr) —
/// the accumulated log parses with `parse_json_log` exactly like `.output()`.
fn run_transfer_streaming(
    src: &str,
    dst: &str,
    filters: &BackupFilters,
    gitignore_rules: Option<&Path>,
    mut on_line: impl FnMut(&str),
) -> Result<(bool, String), String> {
    let bin = find_rclone().ok_or_else(|| "rclone is not installed yet".to_string())?;
    let conf = rclone_conf_path();
    let mut args: Vec<String> = vec![
        "copy".into(),
        src.into(),
        dst.into(),
        "--update".into(),
        "--use-json-log".into(),
        "--log-level".into(),
        "INFO".into(),
        "--stats".into(),
        "1s".into(),
    ];
    if let Some(rules) = gitignore_rules {
        args.push("--filter-from".into());
        args.push(rules.to_string_lossy().to_string());
    }
    args.extend(filter_args(filters));

    let mut child = proc::command(&bin)
        .arg("--config")
        .arg(&conf)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("rclone failed to start: {e}"))?;

    let mut all = String::new();
    if let Some(stderr) = child.stderr.take() {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            on_line(&line);
            all.push_str(&line);
            all.push('\n');
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok((status.success(), all))
}

/// File count + byte size of a path as rclone sees it (with filters applied).
/// A missing remote directory reports as non-existing, not an error.
fn sized(spec: &str, filters: &BackupFilters, gitignore_rules: Option<&Path>) -> (bool, usize) {
    let mut args: Vec<String> = vec!["size".into(), spec.into(), "--json".into()];
    if let Some(rules) = gitignore_rules {
        args.push("--filter-from".into());
        args.push(rules.to_string_lossy().to_string());
    }
    args.extend(filter_args(filters));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let Ok(out) = run_rclone(&arg_refs) else {
        return (false, 0);
    };
    if !out.status.success() {
        return (false, 0);
    }
    let count = serde_json::from_slice::<serde_json::Value>(&out.stdout)
        .ok()
        .and_then(|v| v.get("count").and_then(|c| c.as_u64()))
        .unwrap_or(0);
    (true, count as usize)
}

pub fn cloud_target_info(
    project_path: &str,
    remote: &str,
    path_override: Option<&str>,
    cloud_root: &str,
    filters: &BackupFilters,
) -> Result<BackupTargetInfo, String> {
    let local_dir = crate::backup::project_dir_from_path(project_path)?;
    let spec = remote_spec(remote, &local_dir, path_override, cloud_root)?;
    let local_arg = local_dir_arg(&local_dir);
    let (git_repo, rules) = gitignore_filtering(&local_dir, filters);
    let (_, local_count) = sized(&local_arg, filters, rules.as_deref());
    let (remote_exists, remote_count) = sized(&spec, filters, rules.as_deref());
    if let Some(r) = &rules {
        let _ = std::fs::remove_file(r);
    }
    Ok(BackupTargetInfo {
        local_root: local_arg,
        remote_root: spec,
        remote_exists,
        local_file_count: local_count,
        remote_file_count: remote_count,
        local_filtered: 0,
        remote_filtered: 0,
        git_repo,
    })
}

pub fn cloud_plan(
    project_path: &str,
    remote: &str,
    mode: &str,
    path_override: Option<&str>,
    cloud_root: &str,
    filters: &BackupFilters,
) -> Result<BackupPlan, String> {
    let local_dir = crate::backup::project_dir_from_path(project_path)?;
    let spec = remote_spec(remote, &local_dir, path_override, cloud_root)?;
    let local_arg = local_dir_arg(&local_dir);
    let (src, dst, direction, reason) = transfer_ends(mode, &local_arg, &spec)?;

    let (git_repo, rules) = gitignore_filtering(&local_dir, filters);
    let out = run_transfer(src, dst, filters, rules.as_deref(), true);
    if let Some(r) = &rules {
        let _ = std::fs::remove_file(r);
    }
    let out = out?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    let parsed = parse_json_log(&stderr, direction, reason);
    if !out.status.success() && parsed.ops.is_empty() {
        return Err(format!(
            "rclone plan failed: {}",
            parsed
                .errors
                .first()
                .cloned()
                .unwrap_or_else(|| last_meaningful_line(&stderr))
        ));
    }

    let to_remote = if direction == "to_remote" { parsed.ops.len() } else { 0 };
    let to_local = if direction == "to_local" { parsed.ops.len() } else { 0 };
    let skipped = parsed.checks as usize;
    let mode_l = mode.trim().to_lowercase();
    let summary = format!("{mode_l}: ^{to_remote} v{to_local} | {skipped} ok | cloud");
    Ok(BackupPlan {
        local_root: local_arg,
        remote_root: spec,
        mode: mode_l,
        ops: parsed.ops,
        to_remote,
        to_local,
        skipped,
        filtered: 0,
        summary,
        gitignore_active: filters.respect_gitignore && git_repo,
    })
}

pub fn cloud_run(
    project_path: &str,
    remote: &str,
    mode: &str,
    path_override: Option<&str>,
    cloud_root: &str,
    filters: &BackupFilters,
    mut progress: impl FnMut(CloudProgress),
) -> Result<BackupResult, String> {
    let local_dir = crate::backup::project_dir_from_path(project_path)?;
    let spec = remote_spec(remote, &local_dir, path_override, cloud_root)?;
    let local_arg = local_dir_arg(&local_dir);
    let (src, dst, direction, reason) = transfer_ends(mode, &local_arg, &spec)?;

    let (_git_repo, rules) = gitignore_filtering(&local_dir, filters);
    // Track running state across log lines; stats lines carry totals, Copied
    // lines carry the file that just landed.
    let mut state = CloudProgress::default();
    let out = run_transfer_streaming(src, dst, filters, rules.as_deref(), |line| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        let msg = v.get("msg").and_then(|m| m.as_str()).unwrap_or("");
        if msg.starts_with("Copied") {
            if let Some(obj) = v.get("object").and_then(|o| o.as_str()) {
                state.detail = obj.to_string();
                state.done += 1;
                progress(state.clone());
            }
            return;
        }
        if let Some(stats) = v.get("stats") {
            let get = |k: &str| stats.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            state.done = state.done.max(get("transfers"));
            state.total = get("totalTransfers");
            state.bytes = get("bytes");
            state.total_bytes = get("totalBytes");
            if let Some(name) = stats
                .get("transferring")
                .and_then(|t| t.as_array())
                .and_then(|a| a.first())
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
            {
                state.detail = name.to_string();
            }
            progress(state.clone());
        }
    });
    if let Some(r) = &rules {
        let _ = std::fs::remove_file(r);
    }
    let (success, stderr) = out?;
    let mut parsed = parse_json_log(&stderr, direction, reason);
    if !success && parsed.errors.is_empty() {
        parsed.errors.push(last_meaningful_line(&stderr));
    }

    let copied = parsed.transfers.max(parsed.ops.len() as u64) as usize;
    let copied_to_remote = if direction == "to_remote" { copied } else { 0 };
    let copied_to_local = if direction == "to_local" { copied } else { 0 };
    let skipped = parsed.checks as usize;
    let summary = if parsed.errors.is_empty() {
        format!(
            "Done | ^{copied_to_remote} v{copied_to_local} | {skipped} ok | {} KB",
            parsed.bytes / 1024
        )
    } else {
        format!(
            "Finished with {} error(s) | ^{copied_to_remote} v{copied_to_local}",
            parsed.errors.len()
        )
    };
    Ok(BackupResult {
        local_root: local_arg,
        remote_root: spec,
        mode: mode.trim().to_lowercase(),
        copied_to_remote,
        copied_to_local,
        skipped,
        filtered: 0,
        bytes_copied: parsed.bytes,
        errors: parsed.errors,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters(exclude: &str, include: &str, max_mb: u64) -> BackupFilters {
        BackupFilters::from_prefs(exclude, include, max_mb)
    }

    #[test]
    fn filter_args_translates_dirs_and_includes() {
        let args = filter_args(&filters("node_modules/\n*.tmp", "*.toe\nassets/", 10));
        let joined = args.join(" ");
        assert!(joined.contains("--ignore-case"));
        assert!(joined.contains("- node_modules/**"));
        assert!(joined.contains("- *.tmp"));
        assert!(joined.contains("+ *.toe"));
        assert!(joined.contains("+ assets/**"));
        // Include list present -> catch-all exclude closes the filter rules
        let last_rule = args
            .iter()
            .filter(|a| a.starts_with("- ") || a.starts_with("+ "))
            .next_back();
        assert_eq!(last_rule.map(String::as_str), Some("- **"));
        assert!(joined.contains("--max-size 10485760B"));
    }

    #[test]
    fn filter_args_no_catchall_without_includes() {
        let args = filter_args(&filters("*.tmp", "", 0));
        assert!(!args.iter().any(|a| a == "- **"));
        assert!(!args.iter().any(|a| a == "--max-size"));
    }

    #[test]
    fn parse_dry_run_line() {
        // Captured verbatim from rclone v1.75.0
        let line = r#"{"time":"2026-08-07T23:00:22.36+02:00","level":"notice","msg":"Skipped copy as --dry-run is set (size 6)","skipped":"copy","size":6,"object":"sub/b.py","objectType":"*local.Object","source":"operations/operations.go:2631"}"#;
        let parsed = parse_json_log(line, "to_remote", "new or newer on local");
        assert_eq!(parsed.ops.len(), 1);
        assert_eq!(parsed.ops[0].relative, "sub/b.py");
        assert_eq!(parsed.ops[0].bytes, 6);
        assert_eq!(parsed.ops[0].direction, "to_remote");
    }

    #[test]
    fn parse_copied_and_stats_lines() {
        let log = concat!(
            r#"{"level":"info","msg":"Copied (new)","size":4,"object":"c.txt","objectType":"*local.Object"}"#,
            "\n",
            r#"{"level":"info","msg":"Set directory modification time (using DirSetModTime)","object":"sub","objectType":"string"}"#,
            "\n",
            r#"{"level":"info","msg":"stats","stats":{"bytes":16,"checks":3,"errors":0,"transfers":1}}"#,
        );
        let parsed = parse_json_log(log, "to_remote", "r");
        // Directory-modtime lines must not count as copies
        assert_eq!(parsed.ops.len(), 1);
        assert_eq!(parsed.checks, 3);
        assert_eq!(parsed.transfers, 1);
        assert_eq!(parsed.bytes, 16);
    }

    #[test]
    fn parse_error_lines() {
        let log = r#"{"level":"error","msg":"Failed to copy: quota exceeded","object":"big.mov"}"#;
        let parsed = parse_json_log(log, "to_remote", "r");
        assert!(parsed.ops.is_empty());
        assert_eq!(parsed.errors, vec!["big.mov: Failed to copy: quota exceeded"]);
    }

    #[test]
    fn remote_spec_defaults_and_rejects_colons() {
        let dir = Path::new("C:/VJ/TD/Projects/MyShow");
        let base = default_cloud_backup_root();
        assert_eq!(
            remote_spec("gdrive", dir, None, &base).unwrap(),
            "gdrive:TDXLU-Backups/MyShow"
        );
        assert_eq!(
            remote_spec("gdrive", dir, Some("Shows/2026/"), &base).unwrap(),
            "gdrive:Shows/2026"
        );
        // Custom and empty cloud roots
        assert_eq!(
            remote_spec("gdrive", dir, None, "Backups/TD/").unwrap(),
            "gdrive:Backups/TD/MyShow"
        );
        assert_eq!(remote_spec("gdrive", dir, None, "").unwrap(), "gdrive:MyShow");
        assert!(remote_spec("gdrive", dir, None, "bad:root").is_err());
        assert!(remote_spec("gdrive", dir, Some("evil:path"), &base).is_err());
        assert!(remote_spec("bad name", dir, None, &base).is_err());
    }

    /// End-to-end plan/run/restore through the real rclone binary, using a
    /// filesystem-backed `alias` remote as a stand-in cloud. Opt-in (touches
    /// the app config dir's rclone.conf): `cargo test cloud_smoke -- --ignored`.
    /// Skips silently when rclone is not installed.
    #[test]
    #[ignore]
    fn cloud_smoke_alias_roundtrip() {
        if find_rclone().is_none() {
            eprintln!("rclone not installed - skipping");
            return;
        }
        let base = std::env::temp_dir().join(format!("tdxlu-cloud-smoke-{}", std::process::id()));
        let local = base.join("MyShow");
        let remote_root = base.join("cloud");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&remote_root).unwrap();
        fs::write(local.join("show.toe"), b"toe bytes").unwrap();
        fs::write(local.join("scratch.tmp"), b"junk").unwrap();

        const REMOTE: &str = "tdxlu-selftest";
        let _ = run_rclone(&["config", "delete", REMOTE]);
        let alias_target = format!("remote={}", remote_root.to_string_lossy().replace('\\', "/"));
        let out = run_rclone(&["config", "create", REMOTE, "alias", &alias_target]).unwrap();
        assert!(out.status.success(), "alias create failed");

        let cleanup = || {
            let _ = run_rclone(&["config", "delete", REMOTE]);
            let _ = fs::remove_dir_all(&base);
        };
        let result = std::panic::catch_unwind(|| {
            let filters = BackupFilters::from_prefs("*.tmp", "", 0);
            let project = local.to_string_lossy().to_string();

            let plan = cloud_plan(&project, REMOTE, "backup", None, "TDXLU-Backups", &filters).unwrap();
            assert_eq!(plan.to_remote, 1, "plan: only show.toe should transfer");
            assert_eq!(plan.ops[0].relative, "show.toe");

            let run1 = cloud_run(&project, REMOTE, "backup", None, "TDXLU-Backups", &filters, |_| {}).unwrap();
            assert_eq!(run1.copied_to_remote, 1, "errors: {:?}", run1.errors);
            let backed = remote_root.join("TDXLU-Backups").join("MyShow");
            assert!(backed.join("show.toe").is_file());
            assert!(!backed.join("scratch.tmp").exists(), "filter leaked");

            let run2 = cloud_run(&project, REMOTE, "backup", None, "TDXLU-Backups", &filters, |_| {}).unwrap();
            assert_eq!(run2.copied_to_remote, 0);
            assert_eq!(run2.skipped, 1);

            fs::write(backed.join("recovered.py"), b"print('hi')").unwrap();
            let restore = cloud_run(&project, REMOTE, "restore", None, "TDXLU-Backups", &filters, |_| {}).unwrap();
            assert_eq!(restore.copied_to_local, 1, "errors: {:?}", restore.errors);
            assert!(local.join("recovered.py").is_file());

            assert!(cloud_plan(&project, REMOTE, "sync", None, "TDXLU-Backups", &filters).is_err());
        });
        cleanup();
        result.unwrap();
    }

    #[test]
    fn remote_name_validation() {
        assert!(validate_remote_name("gdrive").is_ok());
        assert!(validate_remote_name("my-drive_2").is_ok());
        assert!(validate_remote_name("").is_err());
        assert!(validate_remote_name("a b").is_err());
        assert!(validate_remote_name("-lead").is_err());
        assert!(validate_remote_name("semi;colon").is_err());
    }
}
