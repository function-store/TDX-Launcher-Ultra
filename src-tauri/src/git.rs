//! Git authoring helpers for project folders (via system `git` CLI).
//!
//! Uses the installed Git binary and its credential helpers (Git Credential Manager,
//! `gh auth`, OS keychain, etc.). An optional GitHub PAT in Settings only overrides
//! HTTPS auth for github.com when set.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
pub struct GitChange {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    /// Working-tree size; None for deleted files (nothing on disk to measure).
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub project_dir: String,
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: i32,
    pub behind: i32,
    pub has_upstream: bool,
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
    pub remote_urls: Vec<String>,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub changes: Vec<GitChange>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitDiff {
    pub path: String,
    pub staged: bool,
    pub binary: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitHubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitToolInfo {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub credential_helper: Option<String>,
    pub note: String,
}

fn project_dir_from_path(project_path: &str) -> Result<PathBuf, String> {
    let p = Path::new(project_path);
    if !p.exists() {
        return Err(format!("Project path not found: {project_path}"));
    }
    let dir = if p.is_file() {
        p.parent()
            .ok_or_else(|| "Project has no parent directory".to_string())?
            .to_path_buf()
    } else {
        p.to_path_buf()
    };
    Ok(dir)
}

/// Resolve the system `git` executable (PATH, then common install locations).
pub fn find_git() -> Option<PathBuf> {
    static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    GIT.get_or_init(discover_git).clone()
}

fn discover_git() -> Option<PathBuf> {
    if let Ok(p) = which_git_on_path() {
        if p.is_file() {
            return Some(p);
        }
    }
    for candidate in known_git_paths() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn which_git_on_path() -> Result<PathBuf, ()> {
    #[cfg(windows)]
    {
        let output = crate::proc::command("where")
            .arg("git")
            .output()
            .map_err(|_| ())?;
        if !output.status.success() {
            return Err(());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            let p = PathBuf::from(t);
            if p.is_file() {
                return Ok(p);
            }
        }
        Err(())
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("sh")
            .args(["-lc", "command -v git"])
            .output()
            .map_err(|_| ())?;
        if !output.status.success() {
            return Err(());
        }
        let t = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if t.is_empty() {
            return Err(());
        }
        let p = PathBuf::from(t);
        if p.is_file() {
            Ok(p)
        } else {
            Err(())
        }
    }
}

fn known_git_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let pf86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        for base in [pf, pf86, local].into_iter().flatten() {
            out.push(base.join("Git").join("cmd").join("git.exe"));
            out.push(base.join("Git").join("bin").join("git.exe"));
            out.push(
                base.join("Programs")
                    .join("Git")
                    .join("cmd")
                    .join("git.exe"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from("/opt/homebrew/bin/git"));
        out.push(PathBuf::from("/usr/local/bin/git"));
        out.push(PathBuf::from("/usr/bin/git"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        out.push(PathBuf::from("/usr/bin/git"));
        out.push(PathBuf::from("/usr/local/bin/git"));
    }
    out
}

fn git_command() -> Result<Command, String> {
    let exe = find_git().ok_or_else(|| {
        "git was not found. Install Git for Windows (or ensure git is on PATH) and restart the app."
            .to_string()
    })?;
    Ok(crate::proc::command(exe))
}

pub fn git_tool_info() -> GitToolInfo {
    let Some(path) = find_git() else {
        return GitToolInfo {
            available: false,
            path: None,
            version: None,
            credential_helper: None,
            note: "System git not found - install Git to enable the panel.".into(),
        };
    };
    let version = crate::proc::command(&path)
        .args(["--version"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });
    let helper = crate::proc::command(&path)
        .args(["config", "--global", "--get", "credential.helper"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            } else {
                None
            }
        })
        .or_else(|| {
            // System / default helper (e.g. manager-core on Git for Windows)
            crate::proc::command(&path)
                .args(["config", "--system", "--get", "credential.helper"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        if s.is_empty() {
                            None
                        } else {
                            Some(s)
                        }
                    } else {
                        None
                    }
                })
        });

    let note = if helper
        .as_deref()
        .map(|h| {
            let l = h.to_lowercase();
            l.contains("manager") || l.contains("gcm") || l == "osxkeychain" || l.contains("gh")
        })
        .unwrap_or(false)
    {
        "Push/pull use your existing Git credentials (Credential Manager / helper). App token is optional."
            .into()
    } else if helper.is_some() {
        "Push/pull use system git and its credential helper. App token is optional override."
            .into()
    } else {
        "Using system git. Stored OS/git credentials apply; or set an optional GitHub token in Settings."
            .into()
    };

    GitToolInfo {
        available: true,
        path: Some(path.to_string_lossy().to_string()),
        version,
        credential_helper: helper,
        note,
    }
}

fn run_git_env(
    cwd: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    configs: &[(&str, &str)],
) -> Result<(i32, String, String), String> {
    let mut cmd = git_command()?;
    for (k, v) in configs {
        cmd.args(["-c", &format!("{k}={v}")]);
    }
    cmd.args(args).current_dir(cwd);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // Avoid interactive *terminal* prompts hanging the UI. GUI credential managers
    // (GCM) and already-stored credentials still work.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let output = cmd.output().map_err(|e| format!("Failed to run git: {e}"))?;
    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((code, stdout, stderr))
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<(i32, String, String), String> {
    run_git_env(cwd, args, &[], &[])
}

fn run_git_ok(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let (code, stdout, stderr) = run_git(cwd, args)?;
    if code != 0 {
        let msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git {} failed (exit {code})", args.join(" "))
        };
        return Err(msg);
    }
    Ok(stdout)
}

fn empty_status(project_dir: &Path) -> GitStatus {
    GitStatus {
        project_dir: project_dir.to_string_lossy().to_string(),
        is_repo: false,
        root: None,
        branch: None,
        dirty: false,
        ahead: 0,
        behind: 0,
        has_upstream: false,
        branches: vec![],
        remotes: vec![],
        remote_urls: vec![],
        staged: 0,
        unstaged: 0,
        untracked: 0,
        changes: vec![],
        summary: "Not a git repository".into(),
    }
}

fn parse_branch_list(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let name = line.trim().trim_start_matches('*').trim();
        if name.is_empty() || name.contains(" -> ") {
            continue;
        }
        if !out.iter().any(|b| b == name) {
            out.push(name.to_string());
        }
    }
    out
}

fn parse_porcelain(raw: &str) -> Vec<GitChange> {
    let mut changes = Vec::new();
    for line in raw.lines() {
        if line.len() < 3 {
            continue;
        }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        let rest = line[2..].trim_start();

        if x == '?' && y == '?' {
            changes.push(GitChange {
                path: rest.to_string(),
                old_path: None,
                index_status: "?".into(),
                worktree_status: "?".into(),
                staged: false,
                unstaged: false,
                untracked: true,
                bytes: None,
            });
            continue;
        }

        let (old_path, path) = if rest.contains(" -> ") {
            let mut parts = rest.splitn(2, " -> ");
            let a = parts.next().unwrap_or("").to_string();
            let b = parts.next().unwrap_or("").to_string();
            (Some(a), b)
        } else {
            (None, rest.to_string())
        };

        let staged = x != ' ' && x != '?';
        let unstaged = y != ' ' && y != '?';
        changes.push(GitChange {
            path,
            old_path,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            staged,
            unstaged,
            untracked: false,
            bytes: None,
        });
    }
    changes
}

/// Stat each changed file so the UI can show sizes (spotting the accidental
/// 2 GB render before committing it). Deleted paths simply stay None.
fn fill_change_sizes(root: &Path, changes: &mut [GitChange]) {
    for c in changes.iter_mut() {
        let p = root.join(c.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        c.bytes = std::fs::metadata(&p)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len());
    }
}

fn count_from_changes(changes: &[GitChange]) -> (usize, usize, usize) {
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut untracked = 0usize;
    for c in changes {
        if c.untracked {
            untracked += 1;
        } else {
            if c.staged {
                staged += 1;
            }
            if c.unstaged {
                unstaged += 1;
            }
        }
    }
    (staged, unstaged, untracked)
}

fn ahead_behind(cwd: &Path) -> (bool, i32, i32) {
    let (code, _, _) = match run_git(cwd, &["rev-parse", "--abbrev-ref", "@{upstream}"]) {
        Ok(v) => v,
        Err(_) => return (false, 0, 0),
    };
    if code != 0 {
        return (false, 0, 0);
    }
    match run_git_ok(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]) {
        Ok(s) => {
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() >= 2 {
                let ahead = parts[0].parse().unwrap_or(0);
                let behind = parts[1].parse().unwrap_or(0);
                (true, ahead, behind)
            } else {
                (true, 0, 0)
            }
        }
        Err(_) => (true, 0, 0),
    }
}

fn repo_root(project_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let project_dir = project_dir_from_path(project_path)?;
    let (code, root, _) = run_git(&project_dir, &["rev-parse", "--show-toplevel"])?;
    if code != 0 || root.is_empty() {
        return Err("Not a git repository - create one first".into());
    }
    Ok((project_dir, PathBuf::from(root)))
}

pub fn git_status(project_path: &str) -> Result<GitStatus, String> {
    let project_dir = project_dir_from_path(project_path)?;
    let (code, root, _) = run_git(&project_dir, &["rev-parse", "--show-toplevel"])?;
    if code != 0 || root.is_empty() {
        return Ok(empty_status(&project_dir));
    }
    let root_path = PathBuf::from(&root);
    let cwd = if root_path.is_dir() {
        &root_path
    } else {
        &project_dir
    };

    let branch = run_git_ok(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let branches_raw = run_git_ok(cwd, &["branch", "--list"]).unwrap_or_default();
    let mut branches = parse_branch_list(&branches_raw);
    if let Some(b) = &branch {
        if !b.is_empty() && b != "HEAD" && !branches.iter().any(|x| x == b) {
            branches.insert(0, b.clone());
        }
    }
    let remotes_raw = run_git_ok(cwd, &["remote"]).unwrap_or_default();
    let remotes: Vec<String> = remotes_raw
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut remote_urls = Vec::new();
    for r in &remotes {
        if let Ok(url) = run_git_ok(cwd, &["remote", "get-url", r]) {
            remote_urls.push(url);
        }
    }

    let porcelain = run_git_ok(cwd, &["status", "--porcelain"]).unwrap_or_default();
    let mut changes = parse_porcelain(&porcelain);
    fill_change_sizes(&root_path, &mut changes);
    let (staged, unstaged, untracked) = count_from_changes(&changes);
    let dirty = staged + unstaged + untracked > 0;
    let (has_upstream, ahead, behind) = ahead_behind(cwd);

    let mut parts = Vec::new();
    if let Some(b) = &branch {
        parts.push(format!("On {b}"));
    }
    if dirty {
        let mut dirty_bits = Vec::new();
        if staged > 0 {
            dirty_bits.push(format!("{staged} staged"));
        }
        if unstaged > 0 {
            dirty_bits.push(format!("{unstaged} modified"));
        }
        if untracked > 0 {
            dirty_bits.push(format!("{untracked} untracked"));
        }
        parts.push(dirty_bits.join(", "));
    } else {
        parts.push("clean".into());
    }
    if has_upstream {
        if ahead > 0 || behind > 0 {
            parts.push(format!("^{ahead} v{behind}"));
        } else {
            parts.push("up to date".into());
        }
    } else if !remotes.is_empty() {
        parts.push("no upstream".into());
    }

    Ok(GitStatus {
        project_dir: project_dir.to_string_lossy().to_string(),
        is_repo: true,
        root: Some(root),
        branch,
        dirty,
        ahead,
        behind,
        has_upstream,
        branches,
        remotes,
        remote_urls,
        staged,
        unstaged,
        untracked,
        changes,
        summary: parts.join(" | "),
    })
}

/// Starting-point `.gitignore` for a TouchDesigner project.
///
/// Covers what TD itself writes beside a project — the `Backup/` folder,
/// `Project.N.toe` increments and `CrashAutoSave.Project.toe` files (the same
/// copies the launcher's version drawer prunes) — plus the usual Python, OS,
/// and editor noise. Heavy media is listed but left commented: ignoring it is
/// a per-project call, and a silent ignore hides work the user meant to keep.
pub const TD_GITIGNORE: &str = r#"# TouchDesigner project — starting point written by TDXLPP.
# Everything here is editable; nothing below is required by git or by TD.
# Note that .toe/.tox are binary: git stores them fine but cannot diff or
# merge them, so externalized DATs/scripts are what actually review well.

# --- TouchDesigner save copies -------------------------------------------
# Auto-backup folder (Preferences -> "On and Copy to Backup Folder")
Backup/
# Incremental saves beside the project: Project.1.toe ... Project.300.toe
# (three digits max on purpose — a year-named Show.2024.toe stays tracked)
*.[0-9].toe
*.[0-9][0-9].toe
*.[0-9][0-9][0-9].toe
# Autosave written after an unclean exit, and crash dumps
CrashAutoSave.*
*.dmp
# .tdc caches of imported FBX/USD assets — TD rebuilds them from the source
# file whenever they are missing
TDImportCache/

# Expanded ASCII copies, if you run toeexpand for review and keep the
# binary as the source of truth:
# *.toe.dir/
# *.tox.dir/

# --- Heavy media and renders ---------------------------------------------
# Uncomment what your project treats as regenerable output. Keep media
# tracked (or on Git LFS) when the patch is useless without it.
# Render/
# Renders/
# Export/
# Exports/
# Recordings/
# Cache/
# *.mov
# *.mp4

# --- Python ---------------------------------------------------------------
__pycache__/
*.py[cod]
.venv/
venv/

# --- Tooling ---------------------------------------------------------------
# Per-machine MCP / AI config (Embody + Envoy regenerate these)
.mcp.json
.claude/settings.local.json
.vscode/
.idea/

# --- OS --------------------------------------------------------------------
.DS_Store
Thumbs.db
desktop.ini
$RECYCLE.BIN/
*.tmp
*~
*.log
"#;

/// Writes [`TD_GITIGNORE`] into `root` when it has no `.gitignore` yet.
/// Returns true when a file was created — an existing one is never touched.
pub fn write_td_gitignore(root: &Path) -> Result<bool, String> {
    let path = root.join(".gitignore");
    if path.exists() {
        return Ok(false);
    }
    std::fs::write(&path, TD_GITIGNORE).map_err(|e| format!("Write .gitignore: {e}"))?;
    Ok(true)
}

/// Creates a repo in the project's folder. With `gitignore`, seeds a
/// TouchDesigner `.gitignore` so the first commit skips TD's save copies.
pub fn git_init(project_path: &str, gitignore: bool) -> Result<GitStatus, String> {
    let project_dir = project_dir_from_path(project_path)?;
    let existing = git_status(project_path)?;
    if existing.is_repo {
        return Err(format!(
            "Already a git repository at {}",
            existing
                .root
                .unwrap_or_else(|| project_dir.display().to_string())
        ));
    }
    run_git_ok(&project_dir, &["init"])?;
    let _ = run_git_ok(&project_dir, &["branch", "-M", "main"]);
    if gitignore {
        // A repo without an ignore file still beats failing the whole init.
        if let Err(e) = write_td_gitignore(&project_dir) {
            eprintln!("git_init: {e}");
        }
    }
    git_status(project_path)
}

/// True when `dir` sits inside a git work tree (false when git is missing).
pub fn is_git_repo_dir(dir: &Path) -> bool {
    let Ok(mut cmd) = git_command() else {
        return false;
    };
    cmd.current_dir(dir)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Subset of `rels` (slash-relative to `dir`) that git ignores, via one
/// `git check-ignore --stdin -z` call. Works for paths that do not exist
/// locally (remote-only files in a restore plan). Empty when `dir` is not
/// in a repo or git is unavailable.
pub fn ignored_among(dir: &Path, rels: &[String]) -> std::collections::HashSet<String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut out = std::collections::HashSet::new();
    if rels.is_empty() {
        return out;
    }
    let Ok(mut cmd) = git_command() else {
        return out;
    };
    let Ok(mut child) = cmd
        .current_dir(dir)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return out;
    };
    // Feed stdin from a thread: with many matches the stdout pipe fills while
    // we are still writing, and a single-threaded write→read would deadlock.
    let stdin = child.stdin.take();
    let mut payload = Vec::with_capacity(rels.iter().map(|r| r.len() + 1).sum());
    for r in rels {
        payload.extend_from_slice(r.as_bytes());
        payload.push(0);
    }
    let writer = std::thread::spawn(move || {
        if let Some(mut s) = stdin {
            let _ = s.write_all(&payload);
        }
    });
    // Exit status 1 just means "nothing ignored"; parse stdout either way.
    if let Ok(o) = child.wait_with_output() {
        for p in String::from_utf8_lossy(&o.stdout).split('\0') {
            if !p.is_empty() {
                out.insert(p.replace('\\', "/"));
            }
        }
    }
    let _ = writer.join();
    out
}

/// Untracked paths under `dir` that git ignores (`ls-files -oi
/// --exclude-standard --directory`); fully-ignored folders come back as one
/// entry with a trailing `/`. Empty when not a repo or git is unavailable.
pub fn ignored_untracked(dir: &Path) -> Vec<String> {
    let Ok(mut cmd) = git_command() else {
        return Vec::new();
    };
    let Ok(o) = cmd
        .current_dir(dir)
        .args([
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ])
        .output()
    else {
        return Vec::new();
    };
    if !o.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&o.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect()
}

/// Append a pattern to the repo root `.gitignore` (created if missing).
/// Returns `false` when an equivalent line is already present.
pub fn git_ignore_add(project_path: &str, pattern: &str) -> Result<bool, String> {
    let (_project_dir, root) = repo_root(project_path)?;
    let pat = pattern.trim();
    if pat.is_empty() {
        return Err("Empty ignore pattern".into());
    }
    let path = root.join(".gitignore");
    let existing = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| format!("Read .gitignore: {e}"))?
    } else {
        String::new()
    };
    let norm = |l: &str| l.trim().replace('\\', "/").to_string();
    if existing.lines().any(|l| norm(l) == norm(pat)) {
        return Ok(false);
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(pat);
    next.push('\n');
    std::fs::write(&path, next).map_err(|e| format!("Write .gitignore: {e}"))?;
    Ok(true)
}

pub fn git_stage(project_path: &str, paths: &[String]) -> Result<GitStatus, String> {
    let (_project_dir, root) = repo_root(project_path)?;
    if paths.is_empty() {
        run_git_ok(&root, &["add", "-A"])?;
    } else {
        let mut args: Vec<&str> = vec!["add", "--"];
        let owned: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(owned);
        run_git_ok(&root, &args)?;
    }
    git_status(project_path)
}

pub fn git_unstage(project_path: &str, paths: &[String]) -> Result<GitStatus, String> {
    let (_project_dir, root) = repo_root(project_path)?;
    if paths.is_empty() {
        // Unstage everything
        let (code, _, stderr) = run_git(&root, &["restore", "--staged", "."])?;
        if code != 0 {
            // Older repos / no HEAD yet
            let _ = run_git_ok(&root, &["reset", "HEAD"]);
            if code != 0 && !stderr.is_empty() {
                let (c2, _, e2) = run_git(&root, &["rm", "-r", "--cached", "."])?;
                if c2 != 0 {
                    return Err(if e2.is_empty() { stderr } else { e2 });
                }
            }
        }
    } else {
        let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
        let owned: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(owned.clone());
        let (code, _, stderr) = run_git(&root, &args)?;
        if code != 0 {
            let mut args2: Vec<&str> = vec!["reset", "HEAD", "--"];
            args2.extend(owned);
            run_git_ok(&root, &args2).map_err(|_| stderr)?;
        }
    }
    git_status(project_path)
}

pub fn git_commit(project_path: &str, message: &str, add_all: bool) -> Result<GitStatus, String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("Commit message is required".into());
    }
    let status = git_status(project_path)?;
    if !status.is_repo {
        return Err("Not a git repository - create one first".into());
    }
    let root = PathBuf::from(status.root.as_ref().unwrap_or(&status.project_dir));
    if add_all {
        run_git_ok(&root, &["add", "-A"])?;
    }
    let porcelain = run_git_ok(&root, &["status", "--porcelain"]).unwrap_or_default();
    let (staged, unstaged, untracked) = count_from_changes(&parse_porcelain(&porcelain));
    if staged == 0 {
        if unstaged + untracked == 0 {
            return Err("Nothing to commit - working tree clean".into());
        }
        return Err("Nothing staged to commit - stage files first".into());
    }
    run_git_ok(&root, &["commit", "-m", msg])?;
    git_status(project_path)
}

pub fn git_checkout(project_path: &str, branch: &str, create: bool) -> Result<GitStatus, String> {
    let name = branch.trim();
    if name.is_empty() {
        return Err("Branch name is required".into());
    }
    if name.contains("..") || name.contains(' ') || name.starts_with('-') {
        return Err("Invalid branch name".into());
    }
    let (_project_dir, root) = repo_root(project_path)?;
    if create {
        run_git_ok(&root, &["checkout", "-b", name])?;
    } else {
        run_git_ok(&root, &["checkout", name])?;
    }
    git_status(project_path)
}

pub fn git_set_remote(project_path: &str, name: &str, url: &str) -> Result<GitStatus, String> {
    let remote = name.trim();
    let remote_url = url.trim();
    if remote.is_empty() {
        return Err("Remote name is required".into());
    }
    if remote_url.is_empty() {
        return Err("Remote URL is required".into());
    }
    let status = git_status(project_path)?;
    if !status.is_repo {
        return Err("Not a git repository - create one first".into());
    }
    let root = PathBuf::from(status.root.as_ref().unwrap_or(&status.project_dir));
    if status.remotes.iter().any(|r| r == remote) {
        run_git_ok(&root, &["remote", "set-url", remote, remote_url])?;
    } else {
        run_git_ok(&root, &["remote", "add", remote, remote_url])?;
    }
    git_status(project_path)
}

fn github_auth_header(token: &str) -> String {
    let raw = format!("x-access-token:{token}");
    format!("AUTHORIZATION: basic {}", B64.encode(raw.as_bytes()))
}

fn push_configs(token: Option<&str>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(t) = token.map(str::trim).filter(|s| !s.is_empty()) {
        out.push((
            "http.https://github.com/.extraheader".into(),
            github_auth_header(t),
        ));
    }
    out
}

pub fn git_push(
    project_path: &str,
    remote: Option<&str>,
    set_upstream: bool,
    github_token: Option<&str>,
) -> Result<GitStatus, String> {
    let status = git_status(project_path)?;
    if !status.is_repo {
        return Err("Not a git repository - create one first".into());
    }
    let root = PathBuf::from(status.root.as_ref().unwrap_or(&status.project_dir));
    let remote_name = remote
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("origin")
        .to_string();

    if !status.remotes.iter().any(|r| r == &remote_name) {
        return Err(format!(
            "Remote '{remote_name}' not set - add a remote URL first"
        ));
    }

    let branch = status
        .branch
        .clone()
        .ok_or_else(|| "Detached HEAD - checkout a branch before pushing".to_string())?;

    let mut args: Vec<&str> = vec!["push"];
    if set_upstream || !status.has_upstream {
        args.push("-u");
    }
    args.push(&remote_name);
    args.push(&branch);

    let configs = push_configs(github_token);
    let cfg_refs: Vec<(&str, &str)> = configs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let (code, stdout, stderr) = run_git_env(&root, &args, &[], &cfg_refs)?;
    if code != 0 {
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        if msg.to_lowercase().contains("authentication")
            || msg.to_lowercase().contains("could not read username")
            || msg.contains("403")
            || msg.contains("401")
        {
            return Err(format!(
                "{msg}\n\nTip: sign in via Git Credential Manager / `gh auth login`, or add an optional GitHub token in Settings."
            ));
        }
        return Err(msg);
    }
    git_status(project_path)
}

pub fn git_pull(
    project_path: &str,
    remote: Option<&str>,
    github_token: Option<&str>,
) -> Result<GitStatus, String> {
    let status = git_status(project_path)?;
    if !status.is_repo {
        return Err("Not a git repository - create one first".into());
    }
    let root = PathBuf::from(status.root.as_ref().unwrap_or(&status.project_dir));
    let remote_name = remote
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("origin")
        .to_string();

    let configs = push_configs(github_token);
    let cfg_refs: Vec<(&str, &str)> = configs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let args = ["pull", &remote_name];
    let (code, stdout, stderr) = run_git_env(&root, &args, &[], &cfg_refs)?;
    if code != 0 {
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }
    git_status(project_path)
}

pub fn git_diff(project_path: &str, file: &str, staged: bool) -> Result<GitDiff, String> {
    let file = file.trim();
    if file.is_empty() {
        return Err("File path is required".into());
    }
    let (_project_dir, root) = repo_root(project_path)?;
    let status = git_status(project_path)?;
    let change = status.changes.iter().find(|c| c.path == file);

    // Untracked: show file as all additions (capped)
    if change.map(|c| c.untracked).unwrap_or(false) {
        let full = root.join(file);
        let text = match std::fs::read(&full) {
            Ok(bytes) => {
                if bytes.iter().any(|&b| b == 0) {
                    return Ok(GitDiff {
                        path: file.into(),
                        staged: false,
                        binary: true,
                        text: "(binary file)".into(),
                    });
                }
                let content = String::from_utf8_lossy(&bytes);
                let mut out = format!("--- /dev/null\n+++ b/{file}\n");
                let mut lines = 0usize;
                for line in content.lines() {
                    lines += 1;
                    if lines > 400 {
                        out.push_str(&format!("\n... truncated ({lines}+ lines)\n"));
                        break;
                    }
                    out.push('+');
                    out.push_str(line);
                    out.push('\n');
                }
                if content.is_empty() {
                    out.push_str("+");
                }
                out
            }
            Err(e) => format!("(could not read file: {e})"),
        };
        return Ok(GitDiff {
            path: file.into(),
            staged: false,
            binary: false,
            text,
        });
    }

    let args: Vec<&str> = if staged {
        vec!["diff", "--cached", "--", file]
    } else {
        vec!["diff", "--", file]
    };
    let (code, stdout, stderr) = run_git(&root, &args)?;
    if code != 0 && !stderr.is_empty() {
        return Err(stderr);
    }
    let text = if stdout.is_empty() {
        if staged {
            "(no staged diff for this file)".into()
        } else {
            // Fall back to staged if worktree clean for this path
            let (c2, staged_out, _) = run_git(&root, &["diff", "--cached", "--", file])?;
            if c2 == 0 && !staged_out.is_empty() {
                return Ok(GitDiff {
                    path: file.into(),
                    staged: true,
                    binary: staged_out.contains("Binary files"),
                    text: staged_out,
                });
            }
            "(no diff)".into()
        }
    } else {
        stdout
    };

    Ok(GitDiff {
        path: file.into(),
        staged,
        binary: text.contains("Binary files") || text.contains("GIT binary patch"),
        text,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub relative_time: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommitFile {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommitDetail {
    pub commit: GitCommit,
    pub body: String,
    pub parents: Vec<String>,
    pub files: Vec<GitCommitFile>,
    pub diff: GitDiff,
}

/// Recent commits on HEAD (newest first).
pub fn git_log(project_path: &str, limit: u32) -> Result<Vec<GitCommit>, String> {
    let (_project_dir, root) = repo_root(project_path)?;
    let n = limit.clamp(1, 500).to_string();
    // Record sep \x1e, field sep \x1f - body may contain newlines.
    let pretty = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ar%x1f%s%x1e";
    let raw = run_git_ok(&root, &["log", &format!("-n{n}"), &format!("--pretty=format:{pretty}")])?;
    let mut out = Vec::new();
    for rec in raw.split('\u{1e}') {
        let rec = rec.trim();
        if rec.is_empty() {
            continue;
        }
        let parts: Vec<&str> = rec.split('\u{1f}').collect();
        if parts.len() < 7 {
            continue;
        }
        out.push(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            email: parts[3].to_string(),
            timestamp: parts[4].parse().unwrap_or(0),
            relative_time: parts[5].to_string(),
            subject: parts[6].to_string(),
        });
    }
    Ok(out)
}

/// Commit message, changed files, and patch (optionally for one file).
pub fn git_show(
    project_path: &str,
    rev: &str,
    file: Option<&str>,
) -> Result<GitCommitDetail, String> {
    let (_project_dir, root) = repo_root(project_path)?;
    let rev = rev.trim();
    if rev.is_empty() {
        return Err("Commit hash is empty".into());
    }

    let meta = run_git_ok(
        &root,
        &[
            "show",
            "-s",
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ar%x1f%s%x1f%b%x1f%P",
            rev,
        ],
    )?;
    let parts: Vec<&str> = meta.split('\u{1f}').collect();
    if parts.len() < 8 {
        return Err(format!("Could not parse commit {rev}"));
    }
    let commit = GitCommit {
        hash: parts[0].to_string(),
        short_hash: parts[1].to_string(),
        author: parts[2].to_string(),
        email: parts[3].to_string(),
        timestamp: parts[4].parse().unwrap_or(0),
        relative_time: parts[5].to_string(),
        subject: parts[6].to_string(),
    };
    let body = parts[7].trim().to_string();
    let parents: Vec<String> = parts
        .get(8)
        .unwrap_or(&"")
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    let name_status = run_git_ok(
        &root,
        &["show", "--name-status", "--format=", "--no-renames", rev],
    )
    .unwrap_or_default();
    let mut files = Vec::new();
    for line in name_status.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split('\t');
        let status = it.next().unwrap_or("M").chars().next().unwrap_or('M').to_string();
        let path = it.next().unwrap_or("").to_string();
        if !path.is_empty() {
            files.push(GitCommitFile { path, status });
        }
    }

    let (code, stdout, stderr) = if let Some(f) = file.map(str::trim).filter(|s| !s.is_empty()) {
        run_git(
            &root,
            &["show", "--format=", "--patch", "--find-renames", rev, "--", f],
        )?
    } else {
        run_git(
            &root,
            &["show", "--format=", "--patch", "--find-renames", rev],
        )?
    };
    if code != 0 && stdout.is_empty() {
        return Err(if !stderr.is_empty() {
            stderr
        } else {
            format!("git show failed for {rev}")
        });
    }
    let text = if stdout.is_empty() {
        "(no diff)".into()
    } else {
        stdout
    };
    let path_label = file
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("*")
        .to_string();

    Ok(GitCommitDetail {
        commit,
        body,
        parents,
        files,
        diff: GitDiff {
            path: path_label,
            staged: false,
            binary: text.contains("Binary files") || text.contains("GIT binary patch"),
            text,
        },
    })
}

pub fn verify_github_token(token: &str) -> Result<GitHubUser, String> {
    crate::proc::off_runtime(move || verify_github_token_blocking(token))
}

fn verify_github_token_blocking(token: &str) -> Result<GitHubUser, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token is empty".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.github.com/user")
        .header("User-Agent", "TDXLU")
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .map_err(|e| e.to_string())?;
    if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
        return Err("GitHub rejected the token (unauthorized)".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub API error: HTTP {}", resp.status()));
    }
    #[derive(serde::Deserialize)]
    struct ApiUser {
        login: String,
        name: Option<String>,
        avatar_url: Option<String>,
    }
    let user: ApiUser = resp.json().map_err(|e| e.to_string())?;
    Ok(GitHubUser {
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tdxlu-git-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn seeds_gitignore_but_never_clobbers_one() {
        let dir = temp_root("ignore-seed");
        assert!(write_td_gitignore(&dir).unwrap());
        assert!(std::fs::read_to_string(dir.join(".gitignore"))
            .unwrap()
            .contains("Backup/"));

        std::fs::write(dir.join(".gitignore"), "mine\n").unwrap();
        assert!(!write_td_gitignore(&dir).unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "mine\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The patterns are only worth anything if git agrees, so ask git: TD's
    /// save copies drop out, the project and its components stay tracked.
    #[test]
    fn td_gitignore_hides_save_copies_only() {
        if find_git().is_none() {
            eprintln!("skipping: no system git");
            return;
        }
        let dir = temp_root("ignore-match");
        run_git_ok(&dir, &["init"]).unwrap();
        write_td_gitignore(&dir).unwrap();
        for rel in [
            "Show.toe",
            "Show.tox",
            "Show.2024.toe",
            "Show.1.toe",
            "Show.300.toe",
            "CrashAutoSave.Show.toe",
            "Backup/Show.12.toe",
            "TDImportCache/stage.tdc",
            "__pycache__/x.pyc",
            ".mcp.json",
            "run.log",
            "media/clip.mov",
        ] {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"x").unwrap();
        }
        let listed = run_git_ok(&dir, &["status", "--porcelain", "-uall"]).unwrap();
        let visible = |rel: &str| listed.lines().any(|l| l.contains(rel));

        // Kept: the project, its components, a year-named file, media.
        for rel in ["Show.toe", "Show.tox", "Show.2024.toe", "media/clip.mov"] {
            assert!(visible(rel), "{rel} should stay tracked\n{listed}");
        }
        // Dropped: increments, crash autosave, Backup/, tooling noise.
        for rel in [
            "Show.1.toe",
            "Show.300.toe",
            "CrashAutoSave.Show.toe",
            "Backup/",
            "TDImportCache/",
            "__pycache__/",
            ".mcp.json",
            "run.log",
        ] {
            assert!(!visible(rel), "{rel} should be ignored\n{listed}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
