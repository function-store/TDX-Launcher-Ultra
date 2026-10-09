//! Install TDP / uv packages into a project's TDPyEnvManager vEnv and resolve ToxFile.
//!
//! Downloads and `uv` run in TDXLU (not on the TD main thread). Utility only gets a local
//! .tox path for `load_tox`.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_TDP_BROWSER_SPEC: &str =
    "git+https://github.com/PlusPlusOneGmbH/tdp-tdpbrowser";
const DEFAULT_TDP_BROWSER_MODULE: &str = "tdptdpbrowser.Browser";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpEnvStatus {
    pub project_dir: String,
    pub has_context: bool,
    pub context_source: Option<String>,
    pub venv_path: Option<String>,
    pub python_path: Option<String>,
    pub uv_path: Option<String>,
    pub uv_available: bool,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpInstallResult {
    pub spec: String,
    pub module: String,
    pub tox_path: String,
    pub venv_path: String,
    pub already_installed: bool,
    pub uv_log: String,
}

/// Project directory for a .toe path (parent folder).
pub fn project_dir_from_toe(toe_path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(toe_path.trim());
    if p.is_dir() {
        return Ok(p);
    }
    p.parent()
        .map(|x| x.to_path_buf())
        .filter(|x| !x.as_os_str().is_empty())
        .ok_or_else(|| format!("cannot resolve project dir from {toe_path}"))
}

pub fn env_status(toe_path: &str) -> Result<TdpEnvStatus, String> {
    let project_dir = project_dir_from_toe(toe_path)?;
    let (has_context, context_source, venv) = detect_venv(&project_dir);
    let python = venv.as_ref().and_then(|v| venv_python(v));
    let uv = find_uv();
    // uv is optional (see `install_with_env`): an env with Python is ready.
    let ready = python.is_some();
    Ok(TdpEnvStatus {
        project_dir: project_dir.to_string_lossy().replace('\\', "/"),
        has_context,
        context_source,
        venv_path: venv.map(|p| p.to_string_lossy().replace('\\', "/")),
        python_path: python.map(|p| p.to_string_lossy().replace('\\', "/")),
        uv_path: uv.as_ref().map(|p| p.to_string_lossy().replace('\\', "/")),
        uv_available: uv.is_some(),
        ready,
    })
}

/// Install `spec` into the project vEnv and resolve a ToxFile path.
///
/// Spec forms:
/// - `git+https://github.com/PlusPlusOneGmbH/tdp-tdpbrowser`
/// - `tdp-tdpbrowser` (PyPI name, if published)
/// - `spec#module.path` to force which module's ToxFile to use
pub fn install_and_resolve(
    toe_path: &str,
    spec: &str,
    index_base: &str,
) -> Result<TdpInstallResult, String> {
    let project_dir = project_dir_from_toe(toe_path)?;
    let (_ctx, _src, venv) = detect_venv(&project_dir);
    let venv = venv.ok_or_else(|| {
        format!(
            "no project Python env under {} - use Set up Python env on the session card first",
            project_dir.display()
        )
    })?;
    let python = venv_python(&venv).ok_or_else(|| {
        format!(
            "vEnv found at {} but python executable missing",
            venv.display()
        )
    })?;

    let (pip_spec, module_hint) = split_module_hint(spec);
    let pip_spec = if pip_spec.trim().is_empty() {
        DEFAULT_TDP_BROWSER_SPEC.to_string()
    } else {
        normalize_spec(pip_spec)
    };
    let package_name = package_name_from_spec(&pip_spec).ok_or_else(|| {
        format!("could not determine package name from spec `{pip_spec}`")
    })?;

    // Install only if this distribution is missing — never "succeed" via another package's ToxFile.
    let already = dist_is_installed(&python, &package_name)?;
    let uv_log = if already {
        "distribution already installed".to_string()
    } else {
        truncate(&install_with_env(&python, &pip_spec, index_base)?, 800)
    };

    let hint = module_hint
        .filter(|h| !h.is_empty())
        .or_else(|| {
            let g = guess_module(&pip_spec);
            if g.is_empty() {
                None
            } else {
                Some(g)
            }
        });

    let (module, tox_path) =
        resolve_dist_toxfile(&python, &package_name, hint.as_deref()).map_err(|e| {
            format!(
                "installed `{package_name}` but could not resolve its ToxFile: {e}\n\
                 Tip: pass spec#module.path (e.g. tdp-TauCeti#tdpTauCeti.PresetManager)"
            )
        })?;

    Ok(TdpInstallResult {
        spec: pip_spec,
        module,
        tox_path: tox_path.to_string_lossy().replace('\\', "/"),
        venv_path: venv.to_string_lossy().replace('\\', "/"),
        already_installed: already,
        uv_log,
    })
}

fn normalize_spec(spec: &str) -> String {
    let s = spec.trim();
    // Bare github owner/repo -> git+https
    if !s.contains("://") && !s.starts_with("git+") && s.matches('/').count() == 1 {
        let lower = s.to_ascii_lowercase();
        if !lower.contains('.') || lower.ends_with(".git") {
            // owner/repo
            let s = s.trim_end_matches(".git");
            return format!("git+https://github.com/{s}");
        }
    }
    if s.starts_with("https://github.com/") && !s.contains(".tox") && !s.contains("/releases/") {
        // https://github.com/org/repo[.git]
        let rest = s.trim_end_matches('/').trim_end_matches(".git");
        return format!("git+{rest}");
    }
    s.to_string()
}

fn split_module_hint(spec: &str) -> (&str, Option<String>) {
    // Prefer last #module for git URLs that might contain fragments - TDP convention:
    // only treat as module hint if it looks like a python module (has letter, no .tox)
    if let Some((left, right)) = spec.rsplit_once('#') {
        let hint = right.trim();
        if !hint.is_empty()
            && !hint.to_ascii_lowercase().ends_with(".tox")
            && hint
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        {
            return (left.trim(), Some(hint.to_string()));
        }
    }
    (spec.trim(), None)
}

fn guess_module(spec: &str) -> String {
    let lower = spec.to_ascii_lowercase();
    // Only hardcode known dotted import paths. Flat guesses (tdptauceti) are wrong
    // for real packages and used to make the old site-packages scanner pick browser.tox.
    if lower.contains("tdp-tdpbrowser") || lower.contains("tdptdpbrowser") {
        return DEFAULT_TDP_BROWSER_MODULE.to_string();
    }
    String::new()
}

fn package_name_from_spec(spec: &str) -> Option<String> {
    let s = spec.trim().trim_end_matches(".git");
    if let Some(rest) = s.strip_prefix("git+https://github.com/") {
        return rest.split('/').nth(1).map(|x| x.to_string());
    }
    if let Some(rest) = s.strip_prefix("https://github.com/") {
        return rest.split('/').nth(1).map(|x| x.to_string());
    }
    if !s.contains("://") && !s.contains('/') {
        return Some(s.to_string());
    }
    None
}

fn detect_venv(project_dir: &Path) -> (bool, Option<String>, Option<PathBuf>) {
    // 1) pyproject.toml [tool.touchdesigner.TDPyEnvManagerContext]
    let pyproject = project_dir.join("pyproject.toml");
    if pyproject.is_file() {
        if let Ok(text) = fs::read_to_string(&pyproject) {
            if let Some(venv) = venv_from_pyproject(&text, project_dir) {
                return (true, Some("pyproject.toml".into()), Some(venv));
            }
        }
    }
    // 2) TDPyEnvManagerContext.yaml / .json
    for name in ["TDPyEnvManagerContext.yaml", "TDPyEnvManagerContext.yml"] {
        let p = project_dir.join(name);
        if p.is_file() {
            if let Ok(text) = fs::read_to_string(&p) {
                if let Some(venv) = venv_from_context_yaml(&text, project_dir) {
                    return (true, Some(name.into()), Some(venv));
                }
            }
        }
    }
    // 3) Heuristic folders
    for name in [".venv", "venv", ".tdvenv"] {
        let p = project_dir.join(name);
        if venv_python(&p).is_some() {
            return (false, None, Some(p));
        }
    }
    // *_vEnv
    if let Ok(rd) = fs::read_dir(project_dir) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if name.ends_with("_vEnv") || name.ends_with("_venv") {
                let p = ent.path();
                if venv_python(&p).is_some() {
                    return (false, None, Some(p));
                }
            }
        }
    }
    (false, None, None)
}

fn venv_from_pyproject(text: &str, project_dir: &Path) -> Option<PathBuf> {
    let value: toml::Value = toml::from_str(text).ok()?;
    let ctx = value
        .get("tool")?
        .get("touchdesigner")?
        .get("TDPyEnvManagerContext")?;
    let env_name = ctx
        .get("envName")
        .and_then(|v| v.as_str())
        .unwrap_or(".venv");
    let install_path = ctx
        .get("installPath")
        .and_then(|v| v.as_str())
        .unwrap_or(".");
    let active = ctx
        .get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !active {
        return None;
    }
    Some(resolve_install_env(project_dir, install_path, env_name))
}

fn venv_from_context_yaml(text: &str, project_dir: &Path) -> Option<PathBuf> {
    let mut env_name = ".venv".to_string();
    let mut install_path = ".".to_string();
    let mut active = true;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            let v = v.trim().trim_matches('"').trim_matches('\'');
            match k {
                "envName" => env_name = v.to_string(),
                "installPath" => install_path = v.to_string(),
                "active" => {
                    active = matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "1")
                }
                _ => {}
            }
        }
    }
    if !active {
        return None;
    }
    Some(resolve_install_env(project_dir, &install_path, &env_name))
}

fn resolve_install_env(project_dir: &Path, install_path: &str, env_name: &str) -> PathBuf {
    let base = if Path::new(install_path).is_absolute() {
        PathBuf::from(install_path)
    } else {
        project_dir.join(install_path)
    };
    // envName may be ".venv" (folder name) or a full relative path
    if env_name.contains('/') || env_name.contains('\\') {
        if Path::new(env_name).is_absolute() {
            PathBuf::from(env_name)
        } else {
            project_dir.join(env_name)
        }
    } else {
        base.join(env_name)
    }
}

fn venv_python(venv: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let p = venv.join("Scripts").join("python.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(not(windows))]
    {
        let p = venv.join("bin").join("python");
        if p.is_file() {
            return Some(p);
        }
        let p3 = venv.join("bin").join("python3");
        if p3.is_file() {
            return Some(p3);
        }
    }
    None
}

fn find_uv() -> Option<PathBuf> {
    // PATH lookup
    if let Ok(path) = which("uv") {
        return Some(path);
    }
    // Common Windows locations
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let winget = PathBuf::from(&local)
                .join("Microsoft")
                .join("WinGet")
                .join("Packages");
            if let Ok(rd) = fs::read_dir(&winget) {
                for ent in rd.flatten() {
                    let name = ent.file_name().to_string_lossy().to_string();
                    if name.to_ascii_lowercase().contains("astral-sh.uv") {
                        let cand = ent.path().join("uv.exe");
                        if cand.is_file() {
                            return Some(cand);
                        }
                        // nested
                        if let Ok(rd2) = fs::read_dir(ent.path()) {
                            for e2 in rd2.flatten() {
                                let c = e2.path().join("uv.exe");
                                if c.is_file() {
                                    return Some(c);
                                }
                            }
                        }
                    }
                }
            }
            let cargo = PathBuf::from(&local).join("cargo").join("bin").join("uv.exe");
            if cargo.is_file() {
                return Some(cargo);
            }
        }
        if let Ok(user) = std::env::var("USERPROFILE") {
            let c = PathBuf::from(user)
                .join(".local")
                .join("bin")
                .join("uv.exe");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    // macOS / Linux: where uv's own installer and Homebrew put it. An app
    // started from Finder or the Dock gets a minimal PATH (/usr/bin:/bin:...),
    // so `which uv` misses every one of these even when uv is installed.
    #[cfg(not(windows))]
    {
        for c in unix_uv_candidates(std::env::var_os("HOME").map(PathBuf::from)) {
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

/// Where uv lands outside PATH on macOS/Linux: the standalone installer
/// (`~/.local/bin`), cargo, Homebrew on Apple silicon and on Intel.
#[cfg_attr(windows, allow(dead_code))]
fn unix_uv_candidates(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = home {
        v.push(h.join(".local").join("bin").join("uv"));
        v.push(h.join(".cargo").join("bin").join("uv"));
    }
    v.push(PathBuf::from("/opt/homebrew/bin/uv"));
    v.push(PathBuf::from("/usr/local/bin/uv"));
    v
}

fn which(cmd: &str) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let output = crate::proc::command("where.exe").arg(cmd).output();
    #[cfg(not(windows))]
    let output = crate::proc::command("which").arg(cmd).output();
    let output = output.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("not found".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        return Err("not found".into());
    }
    Ok(PathBuf::from(first))
}

/// Install `spec` into the env that owns `python`, with whatever this machine
/// has. uv when it is found -- faster, one shared download cache across every
/// project env, and it needs no pip inside the env. Otherwise the env's own
/// pip, so nothing has to be installed first. See README, "Python env and
/// packages".
fn install_with_env(python: &Path, spec: &str, index_base: &str) -> Result<String, String> {
    match find_uv() {
        Some(uv) => uv_pip_install(&uv, python, spec, index_base),
        None => pip_install(python, spec, index_base),
    }
}

/// `python -m pip install` into the env, bootstrapping pip first when the env
/// has none. A plain `python -m venv` env -- what TouchDesigner's
/// TDPyEnvManager builds -- ships with pip; an env made by uv does not, and
/// `ensurepip` installs pip offline from the Python that built the env.
fn pip_install(python: &Path, spec: &str, index_base: &str) -> Result<String, String> {
    let mut log = String::new();
    if !env_has_pip(python) {
        let out = crate::proc::command(python)
            .args(["-m", "ensurepip", "--default-pip"])
            .output()
            .map_err(|e| format!("failed to run the env's Python: {e}"))?;
        log.push_str(&String::from_utf8_lossy(&out.stdout));
        log.push_str(&String::from_utf8_lossy(&out.stderr));
        if !out.status.success() {
            return Err(format!(
                "the project env has no pip, and bootstrapping it failed:\n{}",
                truncate(&log, 1200)
            ));
        }
    }
    let base = crate::tdp_catalog::normalize_index_base(index_base);
    let args = pip_install_args(spec, &format!("{base}/simple/"));
    let out = crate::proc::command(python)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run pip: {e}"))?;
    log.push_str(&String::from_utf8_lossy(&out.stdout));
    log.push_str(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(format!("pip install failed:\n{}", truncate(&log, 1200)));
    }
    Ok(log)
}

/// The pip command line, same index as the uv path. Never prompts (there is
/// no terminal to answer), never nags about its own version.
fn pip_install_args(spec: &str, index_url: &str) -> Vec<String> {
    [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--index-url",
        index_url,
        spec,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn env_has_pip(python: &Path) -> bool {
    crate::proc::command(python)
        .args(["-m", "pip", "--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn uv_pip_install(uv: &Path, python: &Path, spec: &str, index_base: &str) -> Result<String, String> {
    // Resolve from the configured index. `git+`/URL specs ignore the index but
    // their dependencies still resolve through it. Normalized to `{base}/simple/`.
    let base = crate::tdp_catalog::normalize_index_base(index_base);
    let index_url = format!("{base}/simple/");
    let output = crate::proc::command(uv)
        .args([
            "pip",
            "install",
            "--python",
            &python.to_string_lossy(),
            "--index-url",
            &index_url,
            spec,
        ])
        .output()
        .map_err(|e| format!("failed to spawn uv: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");
    if !output.status.success() {
        return Err(format!(
            "uv pip install failed:\n{}",
            truncate(&combined, 1200)
        ));
    }
    Ok(combined)
}

fn dist_is_installed(python: &Path, package_name: &str) -> Result<bool, String> {
    let code = format!(
        r#"
import importlib.metadata, sys
name = {package_name:?}
try:
    importlib.metadata.distribution(name)
    print("1")
except importlib.metadata.PackageNotFoundError:
    # PEP 503 normalized retry
    norm = name.lower().replace("_", "-")
    try:
        importlib.metadata.distribution(norm)
        print("1")
    except importlib.metadata.PackageNotFoundError:
        print("0")
"#
    );
    let output = crate::proc::command(python)
        .args(["-c", &code])
        .output()
        .map_err(|e| format!("python: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed checking installed dist: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "1")
}

/// Resolve ToxFile belonging to `package_name` only (never another dist like tdp-tdpbrowser).
/// Prints: `<module>\t<path>`
fn resolve_dist_toxfile(
    python: &Path,
    package_name: &str,
    module_hint: Option<&str>,
) -> Result<(String, PathBuf), String> {
    let hint = module_hint.unwrap_or("");
    let code = format!(
        r#"
import importlib
import importlib.metadata
import pathlib
import sys

name = {package_name:?}
hint = {hint:?}

def get_dist(n):
    try:
        return importlib.metadata.distribution(n)
    except importlib.metadata.PackageNotFoundError:
        return importlib.metadata.distribution(n.lower().replace("_", "-"))

def module_tox(mod_name):
    try:
        m = importlib.import_module(mod_name)
    except Exception:
        return None
    tf = getattr(m, "ToxFile", None)
    if tf is None:
        return None
    p = pathlib.Path(tf)
    return p.resolve() if p.is_file() else None

def candidates_from_dist(dist):
    out = []
    files = dist.files or []
    for f in files:
        s = str(f).replace("\\", "/")
        if not s.lower().endswith(".tox"):
            continue
        parts = pathlib.PurePosixPath(s).parts
        if len(parts) < 2:
            continue
        stem = pathlib.PurePosixPath(parts[-1]).stem
        parent = parts[-2]
        # Prefer package toxes named like their folder (PresetManager/PresetManager.tox);
        # skip nested assets (ui.tox, curves.tox).
        if stem.lower() != parent.lower():
            continue
        mod = ".".join(parts[:-1])
        p = pathlib.Path(dist.locate_file(f))
        if p.is_file():
            out.append((mod, p.resolve()))
    # de-dupe by module
    seen = set()
    uniq = []
    for mod, p in out:
        if mod in seen:
            continue
        seen.add(mod)
        uniq.append((mod, p))
    return uniq

def score(mod, package):
    last = mod.rsplit(".", 1)[-1].lower()
    pkg = package.lower().replace("-", "").replace("_", "")
    s = 0
    if last in ("browser", "manager", "presetmanager", "main", "app"):
        s += 50
    if last.replace("_", "") in pkg or pkg.endswith(last.replace("_", "")):
        s += 20
    s -= mod.count(".")  # shallower preferred
    return s

try:
    dist = get_dist(name)
except Exception as e:
    sys.stderr.write(f"distribution not found: {{e}}\n")
    sys.exit(2)

if hint:
    p = module_tox(hint)
    if p is not None:
        print(f"{{hint}}\t{{p}}")
        sys.exit(0)

cands = candidates_from_dist(dist)
# Also try importing each candidate module for ToxFile (authoritative)
resolved = []
for mod, p in cands:
    rp = module_tox(mod)
    resolved.append((mod, rp if rp is not None else p))

if not resolved:
    sys.stderr.write("no ToxFile-bearing modules in distribution\n")
    sys.exit(3)

if len(resolved) == 1:
    mod, p = resolved[0]
    print(f"{{mod}}\t{{p}}")
    sys.exit(0)

resolved.sort(key=lambda item: (-score(item[0], name), item[0].lower()))
mod, p = resolved[0]
print(f"{{mod}}\t{{p}}")
"#
    );
    let output = crate::proc::command(python)
        .args(["-c", &code])
        .output()
        .map_err(|e| format!("python: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(err.trim().to_string());
    }
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let (module, path) = line.split_once('\t').ok_or_else(|| {
        format!("unexpected ToxFile resolve output: {line}")
    })?;
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(format!("ToxFile not a file: {path}"));
    }
    Ok((module.to_string(), p))
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.len() <= max {
        t.to_string()
    } else {
        format!("{}...", &t[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pip_fallback_uses_the_same_index_and_never_prompts() {
        let a = pip_install_args("tdp-foo", "https://pypi.org/simple/");
        assert_eq!(&a[..3], ["-m", "pip", "install"]);
        assert!(a.contains(&"--no-input".to_string()));
        assert!(a.contains(&"--disable-pip-version-check".to_string()));
        let i = a.iter().position(|s| s == "--index-url").unwrap();
        assert_eq!(a[i + 1], "https://pypi.org/simple/");
        assert_eq!(a.last().unwrap(), "tdp-foo");
    }

    #[test]
    fn uv_is_looked_for_where_mac_installers_put_it() {
        let c = unix_uv_candidates(Some(PathBuf::from("/Users/me")));
        for want in [
            "/Users/me/.local/bin/uv",
            "/Users/me/.cargo/bin/uv",
            "/opt/homebrew/bin/uv",
            "/usr/local/bin/uv",
        ] {
            assert!(
                c.iter().any(|p| p.to_string_lossy().replace('\\', "/") == want),
                "{want} missing from {c:?}"
            );
        }
        // No HOME: the fixed locations still count.
        assert_eq!(unix_uv_candidates(None).len(), 2);
    }

    /// The real fallback, end to end, on an env with NO pip (what uv makes):
    /// ensurepip bootstraps it, then pip installs from the index. Needs a
    /// Python and the network, so it runs on demand:
    /// `TDXLU_TEST_PYTHON=<TD>/bin/python.exe cargo test --lib -- --ignored pip_fallback_end_to_end`
    #[test]
    #[ignore]
    fn pip_fallback_end_to_end() {
        let Ok(py) = std::env::var("TDXLU_TEST_PYTHON") else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("tdxlu-pipfb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let made = crate::proc::command(&py)
            .args(["-m", "venv", "--without-pip"])
            .arg(&dir)
            .status()
            .expect("run python -m venv");
        assert!(made.success());
        let python = venv_python(&dir).expect("env python");
        assert!(!env_has_pip(&python), "test env should start without pip");
        let log = pip_install(&python, "six", "https://pypi.org").expect("pip fallback");
        assert!(env_has_pip(&python), "ensurepip bootstrapped pip");
        assert!(dist_is_installed(&python, "six").unwrap(), "{log}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_github() {
        assert_eq!(
            normalize_spec("PlusPlusOneGmbH/tdp-tdpbrowser"),
            "git+https://github.com/PlusPlusOneGmbH/tdp-tdpbrowser"
        );
        assert_eq!(
            normalize_spec("https://github.com/PlusPlusOneGmbH/tdp-tdpbrowser"),
            "git+https://github.com/PlusPlusOneGmbH/tdp-tdpbrowser"
        );
    }

    #[test]
    fn module_hint() {
        let (s, m) = split_module_hint(
            "git+https://github.com/PlusPlusOneGmbH/tdp-tdpbrowser#tdptdpbrowser.Browser",
        );
        assert!(s.contains("tdp-tdpbrowser"));
        assert_eq!(m.as_deref(), Some("tdptdpbrowser.Browser"));
    }

    #[test]
    fn guess_browser_module() {
        assert_eq!(
            guess_module("git+https://github.com/PlusPlusOneGmbH/tdp-tdpbrowser"),
            DEFAULT_TDP_BROWSER_MODULE
        );
    }
}
