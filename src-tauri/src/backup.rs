//! Local folder backup / two-way sync for project directories.
//!
//! Destinations are filesystem paths - USB drives, or folders that OneDrive /
//! Google Drive / Dropbox already mirror. Include/exclude globs + max size
//! filters (FreeFileSync-style) decide what counts as part of the project.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// FAT32 stores modification times in 2-second steps and exFAT in 10 ms, so a
/// copy on a USB drive reads back slightly OLDER than its source. Without a
/// tolerance every backup to such a drive re-copied the whole project. Times
/// this close count as the same time, and size decides.
const MTIME_TOLERANCE: Duration = Duration::from_secs(2);

/// `a` vs `b`, with times within `MTIME_TOLERANCE` counted as equal.
fn cmp_mtime(a: SystemTime, b: SystemTime) -> Ordering {
    match a.duration_since(b) {
        Ok(d) if d > MTIME_TOLERANCE => Ordering::Greater,
        Ok(_) => Ordering::Equal,
        Err(e) if e.duration() > MTIME_TOLERANCE => Ordering::Less,
        Err(_) => Ordering::Equal,
    }
}

/// `child` is `parent` or inside it. Case-insensitive and separator-agnostic:
/// the default macOS and Windows filesystems ignore case.
fn is_within(child: &Path, parent: &Path) -> bool {
    let key = |p: &Path| {
        let mut s = p.to_string_lossy().replace('\\', "/").to_lowercase();
        while s.len() > 1 && s.ends_with('/') {
            s.pop();
        }
        s.push('/');
        s
    };
    key(child).starts_with(&key(parent))
}

/// Sensible TD / junk defaults (one pattern per line).
pub fn default_backup_exclude() -> String {
    [
        ".git/",
        ".svn/",
        ".hg/",
        "node_modules/",
        "__pycache__/",
        ".Trash/",
        "$RECYCLE.BIN/",
        "System Volume Information/",
        ".DS_Store",
        "Thumbs.db",
        "desktop.ini",
        "CrashAutoSave*/",
        "*.tmp",
        "*.temp",
        "*~",
    ]
    .join("\n")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupFilters {
    /// Glob patterns (one conceptually per entry). Matched against relative paths.
    pub exclude: Vec<String>,
    /// If non-empty, a file must match at least one include (after excludes).
    pub include: Vec<String>,
    /// Skip files larger than this (0 = unlimited).
    pub max_file_bytes: u64,
    /// Also skip whatever the project's .gitignore matches (repos only).
    #[serde(default)]
    pub respect_gitignore: bool,
}

impl BackupFilters {
    pub fn from_prefs(exclude_text: &str, include_text: &str, max_file_mb: u64) -> Self {
        Self {
            exclude: parse_pattern_lines(exclude_text),
            include: parse_pattern_lines(include_text),
            max_file_bytes: if max_file_mb == 0 {
                0
            } else {
                max_file_mb.saturating_mul(1024 * 1024)
            },
            respect_gitignore: false,
        }
    }

    pub fn respecting_gitignore(mut self, on: bool) -> Self {
        self.respect_gitignore = on;
        self
    }

    /// Also skip TouchDesigner's `Backup/` folders — the numbered saves TD
    /// writes beside a .toe, matched as any folder named Backup. Off by
    /// default: some people work straight out of those saves.
    pub fn skipping_td_backups(mut self, on: bool) -> Self {
        if on {
            self.exclude.push("Backup/".into());
        }
        self
    }
}

fn parse_pattern_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"))
        .map(|l| l.replace('\\', "/"))
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupFileOp {
    pub relative: String,
    /// `to_remote` | `to_local` | `skip` | `filtered`
    pub direction: String,
    pub reason: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupPlan {
    pub local_root: String,
    pub remote_root: String,
    pub mode: String,
    pub ops: Vec<BackupFileOp>,
    pub to_remote: usize,
    pub to_local: usize,
    pub skipped: usize,
    pub filtered: usize,
    pub summary: String,
    /// .gitignore filtering was requested AND the project is a git repo.
    pub gitignore_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
    pub local_root: String,
    pub remote_root: String,
    pub mode: String,
    pub copied_to_remote: usize,
    pub copied_to_local: usize,
    pub skipped: usize,
    pub filtered: usize,
    pub bytes_copied: u64,
    pub errors: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupTargetInfo {
    pub local_root: String,
    pub remote_root: String,
    pub remote_exists: bool,
    pub local_file_count: usize,
    pub remote_file_count: usize,
    pub local_filtered: usize,
    pub remote_filtered: usize,
    /// The local root sits inside a git work tree.
    pub git_repo: bool,
}

#[derive(Clone, Copy)]
enum Mode {
    Backup,
    Restore,
    Sync,
}

impl Mode {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_lowercase().as_str() {
            "backup" => Ok(Mode::Backup),
            "restore" => Ok(Mode::Restore),
            "sync" => Ok(Mode::Sync),
            other => Err(format!("Unknown mode '{other}' (use backup, restore, or sync)")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Mode::Backup => "backup",
            Mode::Restore => "restore",
            Mode::Sync => "sync",
        }
    }
}

struct FileMeta {
    mtime: SystemTime,
    size: u64,
}

struct WalkResult {
    files: BTreeMap<String, FileMeta>,
    filtered: Vec<BackupFileOp>,
}

struct CompiledFilters {
    exclude: Vec<(String, Regex)>,
    include: Vec<(String, Regex)>,
    max_file_bytes: u64,
}

fn compile_glob(pattern: &str) -> Result<Regex, String> {
    let mut pat = pattern.trim().replace('\\', "/");
    if pat.is_empty() {
        return Err("empty pattern".into());
    }
    let trailing_slash = pat.ends_with('/');
    while pat.ends_with('/') {
        pat.pop();
    }
    // Bare name / extension -> match anywhere in the tree
    if !pat.contains('/') {
        pat = format!("**/{pat}");
    }

    let mut re = String::from("(?i)^");
    let chars: Vec<char> = pat.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            re.push_str(".*");
            i += 2;
            if i < chars.len() && chars[i] == '/' {
                i += 1;
            }
        } else if chars[i] == '*' {
            re.push_str("[^/]*");
            i += 1;
        } else if chars[i] == '?' {
            re.push_str("[^/]");
            i += 1;
        } else {
            re.push_str(&regex::escape(&chars[i].to_string()));
            i += 1;
        }
    }
    if trailing_slash {
        // Directory itself or anything underneath
        re.push_str("(/.*)?");
    }
    re.push('$');
    Regex::new(&re).map_err(|e| format!("Bad filter pattern '{pattern}': {e}"))
}

fn compile_filters(filters: &BackupFilters) -> Result<CompiledFilters, String> {
    let mut exclude = Vec::new();
    for p in &filters.exclude {
        exclude.push((p.clone(), compile_glob(p)?));
    }
    let mut include = Vec::new();
    for p in &filters.include {
        include.push((p.clone(), compile_glob(p)?));
    }
    Ok(CompiledFilters {
        exclude,
        include,
        max_file_bytes: filters.max_file_bytes,
    })
}

fn filter_reason(rel: &str, size: u64, compiled: &CompiledFilters) -> Option<String> {
    // macOS writes `._name` sidecars (resource forks, xattrs) beside every
    // file it puts on an exFAT/FAT drive. Never project content — and a
    // restore or sync must not carry them into the project.
    if rel.rsplit('/').next().is_some_and(|name| name.starts_with("._")) {
        return Some("macOS ._ metadata".into());
    }
    for (pat, re) in &compiled.exclude {
        if re.is_match(rel) {
            return Some(format!("exclude [{pat}]"));
        }
    }
    if compiled.max_file_bytes > 0 && size > compiled.max_file_bytes {
        let mb = compiled.max_file_bytes / (1024 * 1024);
        return Some(format!("size > {mb} MB"));
    }
    if !compiled.include.is_empty() {
        let ok = compiled.include.iter().any(|(_, re)| re.is_match(rel));
        if !ok {
            return Some("not in include list".into());
        }
    }
    None
}

fn dir_excluded(rel: &str, compiled: &CompiledFilters) -> Option<String> {
    if rel.is_empty() {
        return None;
    }
    for (pat, re) in &compiled.exclude {
        if re.is_match(rel) || re.is_match(&format!("{rel}/")) {
            return Some(format!("exclude [{pat}]"));
        }
    }
    None
}

pub(crate) fn project_dir_from_path(project_path: &str) -> Result<PathBuf, String> {
    let p = Path::new(project_path);
    if !p.exists() {
        return Err(format!("Project path not found: {project_path}"));
    }
    if p.is_file() {
        p.parent()
            .map(|d| d.to_path_buf())
            .ok_or_else(|| "Project has no parent directory".into())
    } else {
        Ok(p.to_path_buf())
    }
}

fn default_remote_for(local_root: &Path, backup_root: &str) -> Result<PathBuf, String> {
    let backup_root = backup_root.trim();
    if backup_root.is_empty() {
        return Err("Set a backup root folder in Settings first".into());
    }
    let root = PathBuf::from(backup_root);
    if !root.exists() {
        return Err(format!("Backup root does not exist: {backup_root}"));
    }
    if !root.is_dir() {
        return Err(format!("Backup root is not a folder: {backup_root}"));
    }
    let name = local_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "project".into());
    Ok(root.join(name))
}

fn walk_files(root: &Path, compiled: &CompiledFilters) -> Result<WalkResult, String> {
    let mut out = WalkResult {
        files: BTreeMap::new(),
        filtered: Vec::new(),
    };
    if !root.exists() {
        return Ok(out);
    }
    walk_files_inner(root, root, "", compiled, &mut out)?;
    Ok(out)
}

fn walk_files_inner(
    root: &Path,
    dir: &Path,
    rel_dir: &str,
    compiled: &CompiledFilters,
    out: &mut WalkResult,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if rel_dir.is_empty() {
            name.replace('\\', "/")
        } else {
            format!("{rel_dir}/{}", name.replace('\\', "/"))
        };
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            if let Some(reason) = dir_excluded(&rel, compiled) {
                out.filtered.push(BackupFileOp {
                    relative: format!("{rel}/"),
                    direction: "filtered".into(),
                    reason,
                    bytes: 0,
                });
                continue;
            }
            walk_files_inner(root, &path, &rel, compiled, out)?;
        } else if ft.is_file() {
            let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
            let size = meta.len();
            if let Some(reason) = filter_reason(&rel, size, compiled) {
                out.filtered.push(BackupFileOp {
                    relative: rel,
                    direction: "filtered".into(),
                    reason,
                    bytes: size,
                });
                continue;
            }
            out.files.insert(
                rel,
                FileMeta {
                    mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    size,
                },
            );
        }
    }
    Ok(())
}

fn copy_file(src: &Path, dest: &Path) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::copy(src, dest).map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest.display()))
}

/// Move git-ignored entries out of both walks into `local.filtered` with the
/// reason "gitignore". One `check-ignore` batch covers both sides, so
/// remote-only files (restore direction) are honored too. Returns whether the
/// local root actually is a repo.
fn apply_gitignore(local_root: &Path, local: &mut WalkResult, remote: &mut WalkResult) -> bool {
    if !crate::git::is_git_repo_dir(local_root) {
        return false;
    }
    let mut all: Vec<String> = local.files.keys().cloned().collect();
    for k in remote.files.keys() {
        if !local.files.contains_key(k) {
            all.push(k.clone());
        }
    }
    let ignored = crate::git::ignored_among(local_root, &all);
    for rel in ignored {
        let mut bytes = 0;
        let mut had = false;
        if let Some(meta) = local.files.remove(&rel) {
            bytes = meta.size;
            had = true;
        }
        if remote.files.remove(&rel).is_some() {
            had = true;
        }
        if had {
            local.filtered.push(BackupFileOp {
                relative: rel,
                direction: "filtered".into(),
                reason: "gitignore".into(),
                bytes,
            });
        }
    }
    true
}

fn build_plan(
    local_root: &Path,
    remote_root: &Path,
    mode: Mode,
    filters: &BackupFilters,
) -> Result<BackupPlan, String> {
    let compiled = compile_filters(filters)?;
    let mut local = walk_files(local_root, &compiled)?;
    let mut remote = walk_files(remote_root, &compiled)?;
    let gitignore_active =
        filters.respect_gitignore && apply_gitignore(local_root, &mut local, &mut remote);

    let mut ops = Vec::new();
    // Show filtered from local first (what "extra" project files we're ignoring)
    for f in &local.filtered {
        ops.push(f.clone());
    }
    // Remote-only filtered are less interesting; keep a short note via counts

    let mut keys: BTreeMap<String, ()> = BTreeMap::new();
    for k in local.files.keys() {
        keys.insert(k.clone(), ());
    }
    for k in remote.files.keys() {
        keys.insert(k.clone(), ());
    }

    for rel in keys.keys() {
        let l = local.files.get(rel);
        let r = remote.files.get(rel);
        match (mode, l, r) {
            (Mode::Backup, Some(lf), None) => ops.push(BackupFileOp {
                relative: rel.clone(),
                direction: "to_remote".into(),
                reason: "new on local".into(),
                bytes: lf.size,
            }),
            (Mode::Backup, Some(lf), Some(rf)) => {
                let order = cmp_mtime(lf.mtime, rf.mtime);
                if order == Ordering::Greater || (order == Ordering::Equal && lf.size != rf.size) {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "to_remote".into(),
                        reason: if order == Ordering::Equal {
                            "size differs".into()
                        } else {
                            "local newer".into()
                        },
                        bytes: lf.size,
                    });
                } else {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "skip".into(),
                        reason: "up to date".into(),
                        bytes: lf.size,
                    });
                }
            }
            (Mode::Backup, None, Some(_)) => ops.push(BackupFileOp {
                relative: rel.clone(),
                direction: "skip".into(),
                reason: "remote-only (backup does not delete)".into(),
                bytes: 0,
            }),

            (Mode::Restore, None, Some(rf)) => ops.push(BackupFileOp {
                relative: rel.clone(),
                direction: "to_local".into(),
                reason: "new on remote".into(),
                bytes: rf.size,
            }),
            (Mode::Restore, Some(lf), Some(rf)) => {
                let order = cmp_mtime(rf.mtime, lf.mtime);
                if order == Ordering::Greater || (order == Ordering::Equal && rf.size != lf.size) {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "to_local".into(),
                        reason: if order == Ordering::Equal {
                            "size differs".into()
                        } else {
                            "remote newer".into()
                        },
                        bytes: rf.size,
                    });
                } else {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "skip".into(),
                        reason: "up to date".into(),
                        bytes: lf.size,
                    });
                }
            }
            (Mode::Restore, Some(_), None) => ops.push(BackupFileOp {
                relative: rel.clone(),
                direction: "skip".into(),
                reason: "local-only (restore does not delete)".into(),
                bytes: 0,
            }),

            (Mode::Sync, Some(lf), None) => ops.push(BackupFileOp {
                relative: rel.clone(),
                direction: "to_remote".into(),
                reason: "only on local".into(),
                bytes: lf.size,
            }),
            (Mode::Sync, None, Some(rf)) => ops.push(BackupFileOp {
                relative: rel.clone(),
                direction: "to_local".into(),
                reason: "only on remote".into(),
                bytes: rf.size,
            }),
            (Mode::Sync, Some(lf), Some(rf)) => {
                let order = cmp_mtime(lf.mtime, rf.mtime);
                if order == Ordering::Greater {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "to_remote".into(),
                        reason: "local newer".into(),
                        bytes: lf.size,
                    });
                } else if order == Ordering::Less {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "to_local".into(),
                        reason: "remote newer".into(),
                        bytes: rf.size,
                    });
                } else if lf.size != rf.size {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "to_remote".into(),
                        reason: "conflict (same time, prefer local)".into(),
                        bytes: lf.size,
                    });
                } else {
                    ops.push(BackupFileOp {
                        relative: rel.clone(),
                        direction: "skip".into(),
                        reason: "identical".into(),
                        bytes: lf.size,
                    });
                }
            }
            (_, None, None) => {}
        }
    }

    let to_remote = ops.iter().filter(|o| o.direction == "to_remote").count();
    let to_local = ops.iter().filter(|o| o.direction == "to_local").count();
    let skipped = ops.iter().filter(|o| o.direction == "skip").count();
    let filtered = local.filtered.len();
    let summary = format!(
        "{}: ^{to_remote} v{to_local} | {skipped} ok | {filtered} filtered",
        mode.as_str()
    );

    Ok(BackupPlan {
        local_root: local_root.to_string_lossy().to_string(),
        remote_root: remote_root.to_string_lossy().to_string(),
        mode: mode.as_str().into(),
        ops,
        to_remote,
        to_local,
        skipped,
        filtered,
        summary,
        gitignore_active,
    })
}

/// `progress(done, total, current_relative_path)` — called before each file
/// copy and once more at the end. `total` counts transfer ops only.
fn execute_plan(plan: &BackupPlan, progress: &mut dyn FnMut(usize, usize, &str)) -> BackupResult {
    let local_root = PathBuf::from(&plan.local_root);
    let remote_root = PathBuf::from(&plan.remote_root);
    let total_transfers = plan.to_remote + plan.to_local;
    let mut copied_to_remote = 0usize;
    let mut copied_to_local = 0usize;
    let mut skipped = 0usize;
    let mut filtered = 0usize;
    let mut bytes_copied = 0u64;
    let mut errors = Vec::new();

    if plan.to_remote > 0 {
        if let Err(e) = fs::create_dir_all(&remote_root) {
            errors.push(format!("Cannot create remote root: {e}"));
            return BackupResult {
                local_root: plan.local_root.clone(),
                remote_root: plan.remote_root.clone(),
                mode: plan.mode.clone(),
                copied_to_remote: 0,
                copied_to_local: 0,
                skipped: 0,
                filtered: 0,
                bytes_copied: 0,
                errors,
                summary: "Failed".into(),
            };
        }
    }

    for op in &plan.ops {
        match op.direction.as_str() {
            "skip" => skipped += 1,
            "filtered" => filtered += 1,
            "to_remote" => {
                progress(copied_to_remote + copied_to_local, total_transfers, &op.relative);
                let src = local_root.join(op.relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                let dest = remote_root.join(op.relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                match copy_file(&src, &dest) {
                    Ok(n) => {
                        copied_to_remote += 1;
                        bytes_copied += n;
                    }
                    Err(e) => errors.push(e),
                }
            }
            "to_local" => {
                progress(copied_to_remote + copied_to_local, total_transfers, &op.relative);
                let src = remote_root.join(op.relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                let dest = local_root.join(op.relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                match copy_file(&src, &dest) {
                    Ok(n) => {
                        copied_to_local += 1;
                        bytes_copied += n;
                    }
                    Err(e) => errors.push(e),
                }
            }
            _ => {}
        }
    }
    progress(total_transfers, total_transfers, "");

    let summary = if errors.is_empty() {
        format!(
            "Done | ^{copied_to_remote} v{copied_to_local} | {skipped} ok | {filtered} filtered | {} KB",
            bytes_copied / 1024
        )
    } else {
        format!(
            "Finished with {} error(s) | ^{copied_to_remote} v{copied_to_local}",
            errors.len()
        )
    };

    BackupResult {
        local_root: plan.local_root.clone(),
        remote_root: plan.remote_root.clone(),
        mode: plan.mode.clone(),
        copied_to_remote,
        copied_to_local,
        skipped,
        filtered,
        bytes_copied,
        errors,
        summary,
    }
}

fn resolve_roots(
    project_path: &str,
    backup_root: &str,
    remote_override: Option<&str>,
) -> Result<(PathBuf, PathBuf), String> {
    let local = project_dir_from_path(project_path)?;
    let remote = if let Some(r) = remote_override.map(str::trim).filter(|s| !s.is_empty()) {
        PathBuf::from(r)
    } else {
        default_remote_for(&local, backup_root)?
    };
    if is_within(&remote, &local) {
        return Err(if is_within(&local, &remote) {
            "Local and remote roots must be different folders".into()
        } else {
            "Remote root cannot be inside the project folder".into()
        });
    }
    // The other way round is just as bad: a sync would pull every sibling
    // project (and the project itself, nested) into the project folder.
    if is_within(&local, &remote) {
        return Err(
            "The backup folder contains the project folder — pick a folder outside it".into(),
        );
    }
    Ok((local, remote))
}

pub fn backup_target_info(
    project_path: &str,
    backup_root: &str,
    remote_override: Option<&str>,
    filters: &BackupFilters,
) -> Result<BackupTargetInfo, String> {
    let (local, remote) = resolve_roots(project_path, backup_root, remote_override)?;
    let compiled = compile_filters(filters)?;
    let mut local_files = walk_files(&local, &compiled)?;
    let mut remote_files = walk_files(&remote, &compiled)?;
    let git_repo = if filters.respect_gitignore {
        apply_gitignore(&local, &mut local_files, &mut remote_files)
    } else {
        crate::git::is_git_repo_dir(&local)
    };
    Ok(BackupTargetInfo {
        local_root: local.to_string_lossy().to_string(),
        remote_root: remote.to_string_lossy().to_string(),
        remote_exists: remote.is_dir(),
        local_file_count: local_files.files.len(),
        remote_file_count: remote_files.files.len(),
        local_filtered: local_files.filtered.len(),
        remote_filtered: remote_files.filtered.len(),
        git_repo,
    })
}

pub fn backup_plan(
    project_path: &str,
    backup_root: &str,
    mode: &str,
    remote_override: Option<&str>,
    filters: &BackupFilters,
) -> Result<BackupPlan, String> {
    let mode = Mode::parse(mode)?;
    let (local, remote) = resolve_roots(project_path, backup_root, remote_override)?;
    build_plan(&local, &remote, mode, filters)
}

pub fn backup_run(
    project_path: &str,
    backup_root: &str,
    mode: &str,
    remote_override: Option<&str>,
    filters: &BackupFilters,
    mut progress: impl FnMut(usize, usize, &str),
) -> Result<BackupResult, String> {
    let plan = backup_plan(project_path, backup_root, mode, remote_override, filters)?;
    Ok(execute_plan(&plan, &mut progress))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn filters() -> BackupFilters {
        BackupFilters::from_prefs(&default_backup_exclude(), "", 0)
    }

    fn write(path: &Path, body: &str, secs: u64, nanos: u32) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(UNIX_EPOCH + Duration::new(secs, nanos)).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tdxlu-backup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn moves(plan: &BackupPlan) -> Vec<String> {
        plan.ops
            .iter()
            .filter(|o| o.direction == "to_remote" || o.direction == "to_local")
            .map(|o| format!("{} {}", o.direction, o.relative))
            .collect()
    }

    #[test]
    fn mtime_tolerance_absorbs_usb_rounding_only() {
        let t = UNIX_EPOCH + Duration::new(1_790_000_001, 123_456_789);
        let fat = UNIX_EPOCH + Duration::new(1_790_000_000, 0);
        assert_eq!(cmp_mtime(t, fat), Ordering::Equal);
        assert_eq!(cmp_mtime(fat, t), Ordering::Equal);
        assert_eq!(cmp_mtime(t + Duration::from_secs(10), t), Ordering::Greater);
        assert_eq!(cmp_mtime(t, t + Duration::from_secs(10)), Ordering::Less);
    }

    #[test]
    fn round_trip_then_idle_and_never_deletes() {
        let base = scratch("roundtrip");
        let proj = base.join("Show");
        write(&proj.join("Show.toe"), "toe", 1_790_000_001, 123_456_789);
        write(&proj.join("media/clip.mov"), "mov", 1_790_000_002, 0);
        let root = base.join("Backups");
        fs::create_dir_all(&root).unwrap();
        let p = proj.join("Show.toe").to_string_lossy().to_string();
        let r = root.to_string_lossy().to_string();

        let run = backup_run(&p, &r, "backup", None, &filters(), |_, _, _| {}).unwrap();
        assert!(run.errors.is_empty(), "{:?}", run.errors);
        assert_eq!(run.copied_to_remote, 2);
        for mode in ["backup", "restore", "sync"] {
            let plan = backup_plan(&p, &r, mode, None, &filters()).unwrap();
            assert!(moves(&plan).is_empty(), "{mode}: {:?}", moves(&plan));
        }

        write(&proj.join("Show.toe"), "toe v2", 1_790_000_100, 0);
        fs::remove_file(proj.join("media/clip.mov")).unwrap();
        let plan = backup_plan(&p, &r, "backup", None, &filters()).unwrap();
        assert_eq!(moves(&plan), vec!["to_remote Show.toe"]);
        backup_run(&p, &r, "backup", None, &filters(), |_, _, _| {}).unwrap();
        assert!(root.join("Show/media/clip.mov").is_file(), "backup must never delete");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn usb_drive_copy_is_up_to_date() {
        // What exFAT/FAT hands back: the copy's time truncated, so OLDER.
        let base = scratch("usb");
        let proj = base.join("Show");
        let remote = base.join("USB/Show");
        write(&proj.join("Show.toe"), "toe", 1_790_000_001, 123_456_789);
        write(&remote.join("Show.toe"), "toe", 1_790_000_000, 0);
        let p = proj.join("Show.toe").to_string_lossy().to_string();
        let over = remote.to_string_lossy().to_string();
        for mode in ["backup", "restore", "sync"] {
            let plan = backup_plan(&p, "", mode, Some(&over), &filters()).unwrap();
            assert!(moves(&plan).is_empty(), "{mode}: {:?}", moves(&plan));
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn macos_sidecars_never_travel() {
        let base = scratch("sidecar");
        let proj = base.join("Show");
        let remote = base.join("USB/Show");
        write(&proj.join("Show.toe"), "toe", 1_790_000_001, 0);
        write(&remote.join("Show.toe"), "toe", 1_790_000_001, 0);
        write(&remote.join("._Show.toe"), "xattr", 1_790_000_001, 0);
        write(&remote.join("media/._clip.mov"), "xattr", 1_790_000_001, 0);
        let p = proj.join("Show.toe").to_string_lossy().to_string();
        let over = remote.to_string_lossy().to_string();
        for mode in ["restore", "sync"] {
            let plan = backup_plan(&p, "", mode, Some(&over), &filters()).unwrap();
            assert!(moves(&plan).is_empty(), "{mode}: {:?}", moves(&plan));
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn td_backup_folders_only_skipped_when_asked() {
        let base = scratch("tdbackup");
        let proj = base.join("Show");
        write(&proj.join("Show.toe"), "toe", 1_790_000_001, 0);
        write(&proj.join("Backup/Show.12.toe"), "old", 1_790_000_001, 0);
        let root = base.join("Backups");
        fs::create_dir_all(&root).unwrap();
        let p = proj.join("Show.toe").to_string_lossy().to_string();
        let r = root.to_string_lossy().to_string();
        let kept = backup_plan(&p, &r, "backup", None, &filters()).unwrap();
        assert!(moves(&kept).contains(&"to_remote Backup/Show.12.toe".to_string()));
        let skipping = filters().skipping_td_backups(true);
        let skipped = backup_plan(&p, &r, "backup", None, &skipping).unwrap();
        assert_eq!(moves(&skipped), vec!["to_remote Show.toe"]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn nested_destinations_are_refused() {
        let base = scratch("nested");
        let proj = base.join("Projects/Show");
        write(&proj.join("Show.toe"), "toe", 1_790_000_001, 0);
        let p = proj.join("Show.toe").to_string_lossy().to_string();
        let parent = base.join("Projects").to_string_lossy().to_string();
        let inside = proj.join("bk").to_string_lossy().to_string();
        let same_other_case = proj.to_string_lossy().to_uppercase();
        for over in [parent, inside, same_other_case] {
            assert!(
                backup_plan(&p, "", "sync", Some(&over), &filters()).is_err(),
                "accepted {over}"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }
}
