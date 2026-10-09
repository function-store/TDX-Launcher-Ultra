//! TouchDesigner version discovery, toeexpand inspection, and launch helpers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

pub const DEFAULT_TEMPLATE: &str = "__default__";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionInfo {
    pub key: String,
    pub executable: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoverResult {
    pub versions: Vec<VersionInfo>,
    pub players: Vec<VersionInfo>,
}

#[derive(Default)]
pub struct TDManager {
    pub versions: HashMap<String, VersionInfo>,
    pub players: HashMap<String, VersionInfo>,
}

impl TDManager {
    pub fn new() -> Self {
        let mut mgr = Self::default();
        mgr.discover();
        mgr
    }

    pub fn discover(&mut self) -> DiscoverResult {
        #[cfg(windows)]
        {
            self.versions = query_windows_registry("TouchDesigner");
            self.players = derive_windows_players(&self.versions);
        }
        #[cfg(target_os = "macos")]
        {
            self.versions = query_mac_applications("TouchDesigner");
            self.players = query_mac_applications("TouchPlayer");
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            self.versions.clear();
            self.players.clear();
        }
        self.to_result()
    }

    pub fn to_result(&self) -> DiscoverResult {
        DiscoverResult {
            versions: sorted_values(&self.versions),
            players: sorted_values(&self.players),
        }
    }

    /// Parse version into (year, build, branch). Branch defaults to 0 when absent.
    /// Accepts `TouchDesigner.2026.21212`, `TouchPlayer.2026.21212.2`, or `2026.21212.2`.
    pub fn parse_version(version_str: &str) -> (i64, i64, i64) {
        let mut s = version_str;
        for prefix in ["TouchDesigner.", "TouchPlayer."] {
            if let Some(rest) = s.strip_prefix(prefix) {
                s = rest;
                break;
            }
        }
        let parts: Vec<&str> = s.split('.').collect();
        let year = parts.first().and_then(|p| p.parse().ok()).unwrap_or(-1);
        let build = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(-1);
        let branch = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
        (year, build, branch)
    }

    pub fn is_version_installed(&self, version: &str) -> bool {
        if self.versions.contains_key(version) {
            return true;
        }
        let target = Self::parse_version(version);
        self.versions
            .keys()
            .any(|k| Self::parse_version(k) == target)
    }

    pub fn is_player_installed(&self, version: &str) -> bool {
        let target = Self::parse_version(version);
        self.players
            .keys()
            .any(|k| Self::parse_version(k) == target)
    }

    pub fn get_executable(&self, version: &str, use_player: bool) -> Option<&VersionInfo> {
        if use_player {
            let target = Self::parse_version(version);
            self.players
                .values()
                .find(|v| Self::parse_version(&v.key) == target)
                .or_else(|| self.players.get(version))
        } else {
            self.versions.get(version).or_else(|| {
                let target = Self::parse_version(version);
                self.versions
                    .values()
                    .find(|v| Self::parse_version(&v.key) == target)
            })
        }
    }

    pub fn get_toeexpand_path(&self, resource_dir: Option<&Path>) -> Option<PathBuf> {
        #[cfg(windows)]
        {
            let mut candidates = toeexpand_candidates_windows();
            if let Some(dir) = resource_dir {
                candidates.insert(0, dir.join("toeexpand").join("toeexpand.exe"));
                candidates.insert(0, dir.join("toeexpand.exe"));
            }
            for candidate in candidates {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
            None
        }
        #[cfg(target_os = "macos")]
        {
            let _ = resource_dir;
            let mut keys: Vec<_> = self.versions.keys().cloned().collect();
            keys.sort_by_key(|k| Self::parse_version(k));
            for key in keys.into_iter().rev() {
                if let Some(info) = self.versions.get(&key) {
                    if let Some(app) = &info.app_path {
                        let p = Path::new(app).join("Contents/MacOS/toeexpand");
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
            None
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = resource_dir;
            None
        }
    }

    pub fn inspect_toe_file(&self, file_path: &str, resource_dir: Option<&Path>) -> Option<String> {
        if !Path::new(file_path).exists() {
            return None;
        }
        let toeexpand = self.get_toeexpand_path(resource_dir)?;
        let mut cmd = crate::proc::command(&toeexpand);
        cmd.arg("-b").arg(file_path);
        let output = cmd.output().ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let cleaned = stdout.replace('\r', "");
        let lines: Vec<&str> = cleaned
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if lines.len() < 2 {
            return None;
        }
        let version_number = lines[1].split_whitespace().last()?;
        Some(format!("TouchDesigner.{version_number}"))
    }

    pub fn generate_download_url(build_option: &str) -> Option<String> {
        let parts: Vec<&str> = build_option.split('.').collect();
        if parts.len() < 3 {
            return None;
        }
        let product = parts[0];
        let year = parts[1];
        let build = parts[2];
        // Optional experimental/branch suffix: TouchDesigner.2026.21212.2
        let branch = parts.get(3).filter(|p| p.chars().all(|c| c.is_ascii_digit()));
        let version_core = match branch {
            Some(b) => format!("{year}.{build}.{b}"),
            None => format!("{year}.{build}"),
        };

        #[cfg(windows)]
        let (extension, arch_suffix) = (".exe", "");
        #[cfg(target_os = "macos")]
        let (extension, arch_suffix) = {
            let machine = std::env::consts::ARCH;
            let arch = match machine {
                "aarch64" => ".arm64",
                _ => ".intel",
            };
            (".dmg", arch)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let (extension, arch_suffix) = (".exe", "");

        #[cfg(windows)]
        {
            if year == "2017" || year == "2018" {
                return Some(format!(
                    "https://download.derivative.ca/TouchDesigner099.{year}.{build}.64-Bit{extension}"
                ));
            }
            if year == "2019" {
                return Some(format!(
                    "https://download.derivative.ca/TouchDesigner099.{year}.{build}{extension}"
                ));
            }
        }

        let url_product = if product == "TouchPlayer" && !cfg!(windows) {
            "TouchPlayer"
        } else {
            "TouchDesigner"
        };
        Some(format!(
            "https://download.derivative.ca/{url_product}.{version_core}{arch_suffix}{extension}"
        ))
    }

    /// Start TouchDesigner.
    ///
    /// `source` names the caller and is required rather than optional: it is
    /// the only way to tell WHICH path spawned an instance when several
    /// appear unexpectedly, and making it a parameter means a new call site
    /// cannot forget to identify itself.
    pub fn launch(
        &self,
        file_path: &str,
        version_key: &str,
        use_touchplayer: bool,
        source: &str,
    ) -> Result<Option<u32>, String> {
        let is_default = file_path == DEFAULT_TEMPLATE;
        let info = self
            .get_executable(version_key, use_touchplayer)
            .ok_or_else(|| {
                format!(
                    "Could not find {} for version {version_key}",
                    if use_touchplayer {
                        "TouchPlayer"
                    } else {
                        "TouchDesigner"
                    }
                )
            })?;

        let abs_file = if is_default {
            None
        } else {
            Some(
                Path::new(file_path)
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .strip_prefix(r"\\?\")
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        Path::new(file_path)
                            .canonicalize()
                            .unwrap()
                            .to_string_lossy()
                            .to_string()
                    }),
            )
        };

        #[cfg(target_os = "macos")]
        {
            if let Some(app_path) = &info.app_path {
                let mut cmd = Command::new("open");
                cmd.args(["-n", "-a", app_path]);
                if let Some(file) = &abs_file {
                    cmd.args(["--args", file]);
                }
                cmd.spawn().map_err(|e| e.to_string())?;
                // `open` does not return the TD process id
                log::info!("launch: source={source} path={file_path} pid=none (via opener)");
                return Ok(None);
            }
            let mut cmd = Command::new(&info.executable);
            if let Some(file) = &abs_file {
                cmd.arg(file);
            }
            let child = cmd.spawn().map_err(|e| e.to_string())?;
            log::info!("launch: source={source} path={file_path} pid={}", child.id());
            return Ok(Some(child.id()));
        }

        #[cfg(not(target_os = "macos"))]
        {
            // Affinity flags go ahead of the file, the way the wiki's launch
            // .bat does it.
            let project = if is_default { None } else { Some(file_path) };
            let mut args: Vec<String> = gpu_affinity_args(project, &info.key);
            if let Some(file) = &abs_file {
                args.push(file.clone());
            }
            // Not a child of the launcher: restarting or killing the launcher
            // must never take a running project with it (see proc.rs).
            let pid =
                crate::proc::spawn_outside_launcher_tree(Path::new(&info.executable), &args)?;
            log::info!("launch: source={source} path={file_path} pid={pid}");
            Ok(Some(pid))
        }
    }
}

/// Command-line flags binding this launch to one GPU, from the project's
/// sidecar (`gpu` block). Empty unless the platform and the TD build both
/// support GPU affinity.
///
/// Windows-only by design: affinity binds one process to one card in a
/// multi-GPU machine, which is a Windows scenario, and the flags are what the
/// wiki documents for it. A sidecar written on a Windows show machine can
/// travel to a Mac untouched - it is simply not applied there.
/// <https://docs.derivative.ca/Using_Multiple_Graphic_Cards>
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn gpu_affinity_args(file_path: Option<&str>, version_key: &str) -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    affinity_args_for(file_path, version_key)
}

/// The platform-independent half of [`gpu_affinity_args`]: version gate plus
/// sidecar lookup, split out so both are testable off Windows.
fn affinity_args_for(file_path: Option<&str>, version_key: &str) -> Vec<String> {
    // No project, no sidecar - the default-template launch takes no affinity.
    let Some(file_path) = file_path else {
        return Vec::new();
    };
    // GPU Affinity is supported starting with the 2022.20000 series.
    if TDManager::parse_version(version_key) < (2022, 20000, 0) {
        return Vec::new();
    }
    crate::project_meta::gpu_affinity_for(file_path)
        .map(|g| g.launch_args())
        .unwrap_or_default()
}

#[cfg(test)]
mod gpu_affinity_tests {
    use super::*;
    use std::fs;

    fn project_with_sidecar(tag: &str, sidecar: Option<&str>) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "tdxlu-affinity-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let toe = dir.join("Show.toe");
        fs::write(&toe, b"x").unwrap();
        if let Some(json) = sidecar {
            fs::write(dir.join("Show.tdxlu.json"), json).unwrap();
        }
        (dir, toe)
    }

    #[test]
    fn sidecar_monitor_reaches_the_command_line() {
        let (dir, toe) = project_with_sidecar("apply", Some(r#"{"version":1,"gpu":{"monitor":1}}"#));
        assert_eq!(
            affinity_args_for(Some(toe.to_str().unwrap()), "TouchDesigner.2025.30000"),
            vec!["-gpuformonitor".to_string(), "1".to_string()]
        );
        // TouchPlayer keys parse the same way.
        assert_eq!(
            affinity_args_for(Some(toe.to_str().unwrap()), "TouchPlayer.2023.11600"),
            vec!["-gpuformonitor".to_string(), "1".to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Affinity landed in the 2022.20000 series; older builds get no flags
    /// rather than an unrecognised argument.
    #[test]
    fn builds_older_than_2022_20000_get_no_flags() {
        let (dir, toe) = project_with_sidecar("oldbuild", Some(r#"{"version":1,"gpu":{"monitor":1}}"#));
        let path = toe.to_str().unwrap();
        assert!(affinity_args_for(Some(path), "TouchDesigner.2021.39010").is_empty());
        assert!(affinity_args_for(Some(path), "TouchDesigner.2022.19000").is_empty());
        assert!(!affinity_args_for(Some(path), "TouchDesigner.2022.20000").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_sidecar_and_default_template_take_no_flags() {
        let (dir, toe) = project_with_sidecar("bare", None);
        assert!(affinity_args_for(Some(toe.to_str().unwrap()), "TouchDesigner.2025.30000").is_empty());
        assert!(affinity_args_for(None, "TouchDesigner.2025.30000").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// A sidecar with an empty gpu block is the same as none - no stray flag.
    #[test]
    fn empty_gpu_block_takes_no_flags() {
        let (dir, toe) = project_with_sidecar("emptyblock", Some(r#"{"version":1,"gpu":{}}"#));
        assert!(affinity_args_for(Some(toe.to_str().unwrap()), "TouchDesigner.2025.30000").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}

fn sorted_values(map: &HashMap<String, VersionInfo>) -> Vec<VersionInfo> {
    let mut v: Vec<_> = map.values().cloned().collect();
    v.sort_by_key(|info| TDManager::parse_version(&info.key));
    v
}

#[cfg(windows)]
fn derive_windows_players(versions: &HashMap<String, VersionInfo>) -> HashMap<String, VersionInfo> {
    let mut players = HashMap::new();
    for (td_key, info) in versions {
        let install = info.install_path.clone().unwrap_or_default();
        let player_exe = Path::new(&install).join("bin").join("TouchPlayer.exe");
        if player_exe.exists() {
            let numeric = td_key.split_once('.').map(|(_, n)| n).unwrap_or(td_key);
            let player_key = format!("TouchPlayer.{numeric}");
            players.insert(
                player_key.clone(),
                VersionInfo {
                    key: player_key,
                    executable: player_exe.to_string_lossy().to_string(),
                    install_path: Some(install),
                    app_path: None,
                    bundle_version: None,
                },
            );
        }
    }
    players
}

#[cfg(windows)]
fn query_windows_registry(product: &str) -> HashMap<String, VersionInfo> {
    use regex::Regex;
    use winreg::enums::*;
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    let mut td_dict = HashMap::new();
    let ver_re = Regex::new(r"^\d{4}\.\d+(?:\.\d+)?$").unwrap();

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key_path = format!(r"SOFTWARE\Derivative\{product}");
    let mut versions: Vec<String> = Vec::new();
    let mut paths: HashMap<String, String> = HashMap::new();

    if let Ok(key) = hklm.open_subkey(&key_path) {
        for (name, value) in key.enum_values().filter_map(|x| x.ok()) {
            let Ok(s) = String::from_reg_value(&value) else {
                continue;
            };
            if name.starts_with("Path") {
                paths.insert(name, s);
            } else if ver_re.is_match(&name) {
                versions.push(name);
            }
        }

        for version in &versions {
            let install_path = paths.values().find(|p| p.contains(version));
            if let Some(install_path) = install_path {
                let exe_path = Path::new(install_path)
                    .join("bin")
                    .join(format!("{product}.exe"));
                if exe_path.exists() {
                    let td_key = format!("{product}.{version}");
                    td_dict.insert(
                        td_key.clone(),
                        VersionInfo {
                            key: td_key,
                            executable: exe_path.to_string_lossy().to_string(),
                            install_path: Some(install_path.clone()),
                            app_path: None,
                            bundle_version: None,
                        },
                    );
                }
            }
        }
    }

    let resolved: std::collections::HashSet<_> = td_dict
        .keys()
        .filter_map(|k| k.split_once('.').map(|(_, n)| n.to_string()))
        .collect();

    for version in &versions {
        if resolved.contains(version) {
            continue;
        }
        let hkcr_path = format!(r"{product}.{version}\shell\open\command");
        let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
        if let Ok(key) = hkcr.open_subkey(&hkcr_path) {
            if let Ok(command_val) = key.get_value::<String, _>("") {
                if let Some(start) = command_val.find('"') {
                    if let Some(end) = command_val[start + 1..].find('"') {
                        let exe_path = &command_val[start + 1..start + 1 + end];
                        if Path::new(exe_path).exists() {
                            let install_path = Path::new(exe_path)
                                .parent()
                                .and_then(|p| p.parent())
                                .map(|p| p.to_string_lossy().to_string());
                            let td_key = format!("{product}.{version}");
                            td_dict.insert(
                                td_key.clone(),
                                VersionInfo {
                                    key: td_key,
                                    executable: exe_path.to_string(),
                                    install_path,
                                    app_path: None,
                                    bundle_version: None,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    td_dict
}

#[cfg(windows)]
fn toeexpand_candidates_windows() -> Vec<PathBuf> {
    let mut c = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            c.push(dir.join("toeexpand").join("toeexpand.exe"));
            c.push(dir.join("resources").join("toeexpand").join("toeexpand.exe"));
            // Dev: tauri-app/src-tauri/target/... -> repo root
            if let Some(repo) = dir
                .ancestors()
                .find(|p| p.join("toeexpand").join("toeexpand.exe").exists())
            {
                c.push(repo.join("toeexpand").join("toeexpand.exe"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        c.push(cwd.join("toeexpand").join("toeexpand.exe"));
        c.push(cwd.join("..").join("toeexpand").join("toeexpand.exe"));
        c.push(
            cwd.join("..")
                .join("..")
                .join("toeexpand")
                .join("toeexpand.exe"),
        );
    }
    c
}

#[cfg(target_os = "macos")]
fn query_mac_applications(product: &str) -> HashMap<String, VersionInfo> {
    use std::fs;

    let mut td_dict = HashMap::new();
    let applications = Path::new("/Applications");
    let entries = match fs::read_dir(applications) {
        Ok(e) => e,
        Err(_) => return td_dict,
    };

    for entry in entries.flatten() {
        let app_path = entry.path();
        let name = app_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if !name.starts_with(product) || !name.ends_with(".app") {
            continue;
        }
        let plist_path = app_path.join("Contents/Info.plist");
        let plist_data: plist::Value = match plist::from_file(&plist_path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let bundle_version = plist_data
            .as_dictionary()
            .and_then(|d| d.get("CFBundleVersion"))
            .and_then(|v| v.as_string())
            .unwrap_or("")
            .to_string();
        if bundle_version.is_empty() {
            continue;
        }
        let parts: Vec<&str> = bundle_version.split('.').collect();
        if parts.len() < 2 {
            continue;
        }
        // Keep full year.build[.branch] from CFBundleVersion
        let version_core = parts
            .iter()
            .take_while(|p| p.chars().all(|c| c.is_ascii_digit()))
            .copied()
            .collect::<Vec<_>>()
            .join(".");
        if version_core.is_empty() {
            continue;
        }
        let td_key = format!("{product}.{version_core}");
        let executable = app_path
            .join("Contents/MacOS")
            .join(product)
            .to_string_lossy()
            .to_string();
        td_dict.insert(
            td_key.clone(),
            VersionInfo {
                key: td_key,
                executable,
                install_path: None,
                app_path: Some(app_path.to_string_lossy().to_string()),
                bundle_version: Some(bundle_version),
            },
        );
    }
    td_dict
}
