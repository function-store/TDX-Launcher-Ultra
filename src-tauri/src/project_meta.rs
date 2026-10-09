//! Per-project sidecar metadata (`.tdxlu.json`) - tags, hero, media gallery.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::project::find_project_icon;

pub const META_VERSION: u32 = 1;
pub const META_SUFFIX: &str = ".tdxlu.json";

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov", "m4v", "avi"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MediaItem {
    /// Path relative to the `.toe` directory (or absolute).
    pub path: String,
    /// `"image"` | `"video"` (default image if omitted on load).
    #[serde(default = "default_media_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

fn default_media_kind() -> String {
    "image".into()
}

/// Optional GPU affinity for this project: bind the TouchDesigner process to
/// one graphics card at launch.
///
/// Mirrors TD's two command-line forms (see
/// <https://docs.derivative.ca/Using_Multiple_Graphic_Cards>):
/// `monitor` -> `-gpuformonitor <index>` (portable between machines),
/// `bus_id` -> `-gpubusid <domain:bus:device:function>` (exact card, not
/// portable). `monitor` wins when both are set.
///
/// Sidecars travel with downloaded projects, so both values are treated as
/// untrusted input and validated before they ever reach a command line -
/// see [`GpuAffinity::launch_args`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GpuAffinity {
    /// Monitor index as the Monitors DAT counts them (left to right, bottom to
    /// top) - NOT the index the OS shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<u32>,
    /// PCI bus id, `domain:bus:device:function`, e.g. `0:1:0:0`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bus_id: Option<String>,
}

impl GpuAffinity {
    /// True when neither form is set - an empty block, same as no block.
    pub fn is_empty(&self) -> bool {
        self.monitor.is_none() && self.bus_id.as_deref().unwrap_or("").trim().is_empty()
    }

    /// The TD command-line flags for this affinity, or empty when it specifies
    /// nothing usable.
    ///
    /// Rejects anything that is not a plain monitor index or a four-field hex
    /// bus id: the sidecar is a file that can arrive with a shared project, and
    /// these strings are spliced into an argv.
    pub fn launch_args(&self) -> Vec<String> {
        if let Some(index) = self.monitor {
            // TD tolerates a wrong index gracefully, but a wild one is a sign
            // the sidecar was hand-edited badly; 64 displays is far past real.
            if index < 64 {
                return vec!["-gpuformonitor".into(), index.to_string()];
            }
            return vec![];
        }
        let raw = self.bus_id.as_deref().unwrap_or("").trim();
        if raw.is_empty() {
            return vec![];
        }
        let fields: Vec<&str> = raw.split(':').collect();
        let valid = fields.len() == 4
            && fields.iter().all(|f| {
                !f.is_empty() && f.len() <= 4 && f.chars().all(|c| c.is_ascii_hexdigit())
            });
        if valid {
            vec!["-gpubusid".into(), raw.to_string()]
        } else {
            vec![]
        }
    }
}

/// Sidecar written next to a `.toe` as `{stem}.tdxlu.json`.
/// Tags may be hierarchical with `/` (e.g. `show/live`, `client/acme`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    #[serde(default = "default_meta_version")]
    pub version: u32,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Preferred hero image/video relative to project dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hero: Option<String>,
    /// Optional folder (relative to project dir) to scan for media.
    /// If omitted, common names are tried: `preview`, `{stem}_media`, `media`, `gallery`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_dir: Option<String>,
    #[serde(default)]
    pub media: Vec<MediaItem>,
    /// Bind this project's TD process to one GPU at launch. Windows only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuAffinity>,
    /// Every other key in the file, carried through untouched.
    ///
    /// The sidecar is co-owned: the companion TOX writes `windows` (window
    /// placement), future builds will write more. Without this, a typed save
    /// from the launcher - adding a tag, say - would serialize only the
    /// fields this struct knows and silently drop the rest.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_meta_version() -> u32 {
    META_VERSION
}

impl Default for ProjectMeta {
    fn default() -> Self {
        Self {
            version: META_VERSION,
            tags: vec![],
            title: None,
            description: None,
            hero: None,
            media_dir: None,
            media: vec![],
            gpu: None,
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedMedia {
    pub path: String,
    pub kind: String,
    pub caption: Option<String>,
    /// `"sidecar"` | `"folder"`
    pub source: String,
    /// Last-modified time in ms since the epoch. The UI puts it in the file's
    /// URL: a capture rewrites preview.png / preview.mp4 under the same path,
    /// and without something that changes with the bytes the WebView keeps
    /// serving the copy it cached.
    pub mtime: Option<u64>,
}

/// Aggregated view for the UI.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectMetaInfo {
    pub project_path: String,
    pub sidecar_path: Option<String>,
    pub meta: ProjectMeta,
    /// Absolute path to best hero still (for gallery cards).
    pub hero_path: Option<String>,
    /// The hero file's last-modified time in ms (see `ResolvedMedia::mtime`).
    pub hero_mtime: Option<u64>,
    /// Absolute path of the discovered media folder (if any).
    pub media_folder: Option<String>,
    pub media: Vec<ResolvedMedia>,
}

/// A file's last-modified time in ms since the epoch, if it can be read.
fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

fn strip_toe(name: &str) -> &str {
    name.strip_suffix(".toe")
        .or_else(|| name.strip_suffix(".TOE"))
        .unwrap_or(name)
}

/// Candidate sidecar stems: full stem, then unversioned base (`project.7` -> `project`).
fn sidecar_stems(project_path: &Path) -> Vec<String> {
    let filename = project_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let stem = strip_toe(&filename).to_string();
    let mut stems = vec![stem.clone()];
    if let Some((base, ver)) = stem.rsplit_once('.') {
        if ver.chars().all(|c| c.is_ascii_digit()) {
            stems.push(base.to_string());
        }
    }
    stems
}

pub fn sidecar_path_for(project_path: &str) -> Option<PathBuf> {
    let p = Path::new(project_path);
    let dir = p.parent()?;
    for stem in sidecar_stems(p) {
        let candidate = dir.join(format!("{stem}{META_SUFFIX}"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let stem = sidecar_stems(p).into_iter().next()?;
    Some(dir.join(format!("{stem}{META_SUFFIX}")))
}

fn media_kind_for(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if IMAGE_EXTS.iter().any(|e| *e == ext) {
        Some("image")
    } else if VIDEO_EXTS.iter().any(|e| *e == ext) {
        Some("video")
    } else {
        None
    }
}

/// Resolve which folder to scan for extra assets.
fn discover_media_folder(project_dir: &Path, project_path: &Path, meta: &ProjectMeta) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(rel) = &meta.media_dir {
        let trimmed = rel.trim();
        if !trimmed.is_empty() {
            candidates.push(resolve_path(project_dir, trimmed)?);
        }
    }

    // What the Utility TOX writes. First so a fresh capture wins over any
    // legacy folder left beside the project.
    candidates.push(project_dir.join("preview"));

    // Legacy / hand-rolled layouts, kept so existing projects keep resolving.
    for stem in sidecar_stems(project_path) {
        candidates.push(project_dir.join(format!("{stem}_media")));
        candidates.push(project_dir.join(format!("{stem}.media")));
    }
    candidates.push(project_dir.join("media"));
    candidates.push(project_dir.join("gallery"));
    candidates.push(project_dir.join("_media"));

    candidates.into_iter().find(|p| p.is_dir())
}

fn scan_media_folder(folder: &Path) -> Vec<ResolvedMedia> {
    let Ok(entries) = fs::read_dir(folder) else {
        return vec![];
    };
    let mut items: Vec<(String, ResolvedMedia)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(kind) = media_kind_for(&path) else {
            continue;
        };
        let abs = path.to_string_lossy().to_string();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| abs.clone());
        items.push((
            name.to_lowercase(),
            ResolvedMedia {
                mtime: mtime_ms(&path),
                path: abs,
                kind: kind.into(),
                caption: Some(name),
                source: "folder".into(),
            },
        ));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items.into_iter().map(|(_, m)| m).collect()
}

fn merge_media(sidecar: Vec<ResolvedMedia>, folder: Vec<ResolvedMedia>) -> Vec<ResolvedMedia> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for m in sidecar.into_iter().chain(folder) {
        let key = m.path.replace('\\', "/").to_lowercase();
        if seen.insert(key) {
            out.push(m);
        }
    }
    out
}

/// The project's sidecar, parsed - `None` when there is no file on disk (or it
/// is unparseable, which is treated the same way readers always have).
pub fn read_sidecar(project_path: &str) -> Option<(PathBuf, ProjectMeta)> {
    let path = sidecar_path_for(project_path)?;
    if !path.exists() {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let meta = serde_json::from_str::<ProjectMeta>(&text).ok()?;
    Some((path, meta))
}

/// This project's GPU affinity, if its sidecar declares a usable one.
pub fn gpu_affinity_for(project_path: &str) -> Option<GpuAffinity> {
    let (_, meta) = read_sidecar(project_path)?;
    meta.gpu.filter(|g| !g.is_empty())
}

/// Write just the `gpu` block, merging into whatever else the sidecar holds.
///
/// A key-level merge, not a `ProjectMeta` round-trip: the sidecar is co-owned
/// with the companion TOX (and future launcher versions), so a write that only
/// means to set one key must leave keys this build does not know untouched.
/// `None` removes the block.
pub fn set_gpu_affinity(
    project_path: &str,
    affinity: Option<GpuAffinity>,
) -> Result<String, String> {
    let p = Path::new(project_path);
    let dir = p.parent().ok_or_else(|| "No parent dir".to_string())?;
    let write_path = match sidecar_path_for(project_path) {
        Some(path) if path.exists() => path,
        _ => {
            let stem = sidecar_stems(p)
                .into_iter()
                .next()
                .ok_or_else(|| "No stem".to_string())?;
            dir.join(format!("{stem}{META_SUFFIX}"))
        }
    };

    let mut root = if write_path.exists() {
        let text = fs::read_to_string(&write_path).map_err(|e| e.to_string())?;
        let parsed: serde_json::Value = serde_json::from_str(&text)
            // Never overwrite a sidecar we could not read - it is user data.
            .map_err(|e| format!("{}: {e} - not overwritten", write_path.display()))?;
        match parsed {
            serde_json::Value::Object(map) => serde_json::Value::Object(map),
            _ => {
                return Err(format!(
                    "{}: sidecar is not a JSON object - not overwritten",
                    write_path.display()
                ))
            }
        }
    } else {
        serde_json::json!({})
    };

    let map = root.as_object_mut().expect("object");
    match affinity.filter(|g| !g.is_empty()) {
        Some(g) => {
            map.insert(
                "gpu".into(),
                serde_json::to_value(&g).map_err(|e| e.to_string())?,
            );
        }
        None => {
            map.remove("gpu");
        }
    }
    map.entry("version")
        .or_insert(serde_json::json!(META_VERSION));

    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(&write_path, format!("{text}\n")).map_err(|e| e.to_string())?;
    Ok(write_path.to_string_lossy().to_string())
}

pub fn load_project_meta(project_path: &str) -> ProjectMetaInfo {
    let p = Path::new(project_path);
    let dir = p
        .parent()
        .map(|d| d.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let (sidecar_path, meta) = match read_sidecar(project_path) {
        Some((path, meta)) => (Some(path.to_string_lossy().to_string()), meta),
        None => (None, ProjectMeta::default()),
    };

    let sidecar_media: Vec<ResolvedMedia> = meta
        .media
        .iter()
        .filter_map(|m| {
            let abs = resolve_path(&dir, &m.path)?;
            if !abs.exists() {
                return None;
            }
            Some(ResolvedMedia {
                mtime: mtime_ms(&abs),
                path: abs.to_string_lossy().to_string(),
                kind: if m.kind.eq_ignore_ascii_case("video") {
                    "video".into()
                } else {
                    "image".into()
                },
                caption: m.caption.clone(),
                source: "sidecar".into(),
            })
        })
        .collect();

    let media_folder = discover_media_folder(&dir, p, &meta);
    let folder_media = media_folder
        .as_ref()
        .map(|f| scan_media_folder(f))
        .unwrap_or_default();

    let media = merge_media(sidecar_media, folder_media);

    let hero_path = resolve_hero(&dir, &meta, &media).or_else(|| find_project_icon(project_path));

    let hero_mtime = hero_path.as_deref().and_then(|h| mtime_ms(Path::new(h)));

    ProjectMetaInfo {
        project_path: project_path.to_string(),
        sidecar_path,
        meta,
        hero_path,
        hero_mtime,
        media_folder: media_folder.map(|p| p.to_string_lossy().to_string()),
        media,
    }
}

pub fn load_projects_meta(paths: &[String]) -> Vec<ProjectMetaInfo> {
    paths.iter().map(|p| load_project_meta(p)).collect()
}

/// Collect unique tags across projects, sorted. Hierarchy preserved as full paths.
pub fn collect_tags(infos: &[ProjectMetaInfo]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for info in infos {
        for t in &info.meta.tags {
            let trimmed = t.trim();
            if !trimmed.is_empty() {
                set.insert(trimmed.to_string());
            }
        }
    }
    set.into_iter().collect()
}

fn resolve_path(dir: &Path, rel_or_abs: &str) -> Option<PathBuf> {
    let p = Path::new(rel_or_abs);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        dir.join(p)
    };
    Some(abs)
}

fn resolve_hero(dir: &Path, meta: &ProjectMeta, media: &[ResolvedMedia]) -> Option<String> {
    if let Some(hero) = &meta.hero {
        let abs = resolve_path(dir, hero)?;
        if abs.exists() {
            return Some(abs.to_string_lossy().to_string());
        }
    }
    for m in media {
        if m.kind == "image" {
            return Some(m.path.clone());
        }
    }
    None
}

pub fn save_project_meta(project_path: &str, meta: &ProjectMeta) -> Result<String, String> {
    let _path = sidecar_path_for(project_path).ok_or_else(|| "Invalid project path".to_string())?;
    let p = Path::new(project_path);
    let dir = p.parent().ok_or_else(|| "No parent dir".to_string())?;
    let stem = sidecar_stems(p)
        .into_iter()
        .next()
        .ok_or_else(|| "No stem".to_string())?;
    let write_path = dir.join(format!("{stem}{META_SUFFIX}"));
    let mut out = meta.clone();
    out.version = META_VERSION;
    let text = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    fs::write(&write_path, text).map_err(|e| e.to_string())?;
    Ok(write_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tdxlu-sidecar-gpu-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn affinity(monitor: Option<u32>, bus: Option<&str>) -> GpuAffinity {
        GpuAffinity {
            monitor,
            bus_id: bus.map(|b| b.to_string()),
        }
    }

    #[test]
    fn monitor_index_becomes_gpuformonitor() {
        assert_eq!(
            affinity(Some(1), None).launch_args(),
            vec!["-gpuformonitor".to_string(), "1".to_string()]
        );
        assert_eq!(
            affinity(Some(0), None).launch_args(),
            vec!["-gpuformonitor".to_string(), "0".to_string()]
        );
    }

    #[test]
    fn monitor_wins_over_bus_id() {
        assert_eq!(
            affinity(Some(2), Some("0:1:0:0")).launch_args(),
            vec!["-gpuformonitor".to_string(), "2".to_string()]
        );
    }

    #[test]
    fn bus_id_becomes_gpubusid() {
        assert_eq!(
            affinity(None, Some("0:1:0:0")).launch_args(),
            vec!["-gpubusid".to_string(), "0:1:0:0".to_string()]
        );
        // Hex fields are legal in a PCI address.
        assert_eq!(
            affinity(None, Some("0:0a:1f:0")).launch_args(),
            vec!["-gpubusid".to_string(), "0:0a:1f:0".to_string()]
        );
    }

    /// A sidecar can arrive with a downloaded project, so a malformed value is
    /// dropped rather than spliced into the command line.
    #[test]
    fn junk_bus_id_yields_no_args() {
        for bad in [
            "0:1:0",                    // too few fields
            "0:1:0:0:0",                // too many
            "0:1:0:",                   // empty field
            "0:1:0:0 -someotherflag",   // smuggled second flag
            "-gpubusid",
            "; shutdown",
            "zz:1:0:0",
            "00000:1:0:0",              // field too wide
            "  ",
        ] {
            assert!(
                affinity(None, Some(bad)).launch_args().is_empty(),
                "expected no args for {bad:?}"
            );
        }
        assert!(affinity(None, None).launch_args().is_empty());
        assert!(affinity(Some(999), None).launch_args().is_empty());
    }

    #[test]
    fn empty_block_reads_as_no_affinity() {
        assert!(affinity(None, None).is_empty());
        assert!(affinity(None, Some("   ")).is_empty());
        assert!(!affinity(Some(0), None).is_empty());
    }

    #[test]
    fn set_gpu_affinity_merges_and_clears() {
        let dir = temp_root("merge");
        let toe = dir.join("Show.toe");
        fs::write(&toe, b"x").unwrap();
        let sidecar = dir.join("Show.tdxlu.json");
        fs::write(
            &sidecar,
            r#"{"version":1,"tags":["show/live"],"future_key":"keep me"}"#,
        )
        .unwrap();

        let written =
            set_gpu_affinity(toe.to_str().unwrap(), Some(affinity(Some(1), None))).unwrap();
        assert_eq!(Path::new(&written), sidecar.as_path());

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&sidecar).unwrap()).unwrap();
        assert_eq!(raw["gpu"]["monitor"], 1);
        assert_eq!(raw["future_key"], "keep me");
        assert_eq!(raw["tags"][0], "show/live");

        // The typed reader sees it, and the launch path resolves it.
        let meta = read_sidecar(toe.to_str().unwrap()).unwrap().1;
        assert_eq!(meta.gpu, Some(affinity(Some(1), None)));
        assert_eq!(
            gpu_affinity_for(toe.to_str().unwrap())
                .unwrap()
                .launch_args(),
            vec!["-gpuformonitor".to_string(), "1".to_string()]
        );

        // Clearing drops the key and leaves everything else in place.
        set_gpu_affinity(toe.to_str().unwrap(), None).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&sidecar).unwrap()).unwrap();
        assert!(raw.get("gpu").is_none());
        assert_eq!(raw["future_key"], "keep me");
        assert!(gpu_affinity_for(toe.to_str().unwrap()).is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_gpu_affinity_creates_sidecar_when_absent() {
        let dir = temp_root("create");
        let toe = dir.join("Fresh.toe");
        fs::write(&toe, b"x").unwrap();

        set_gpu_affinity(toe.to_str().unwrap(), Some(affinity(None, Some("0:1:0:0")))).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("Fresh.tdxlu.json")).unwrap())
                .unwrap();
        assert_eq!(raw["version"], META_VERSION);
        assert_eq!(raw["gpu"]["bus_id"], "0:1:0:0");
        assert!(raw["gpu"].get("monitor").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// The companion TOX owns `windows`; a typed save from the launcher must
    /// carry it (and anything else it does not know) straight back out.
    #[test]
    fn typed_save_preserves_keys_this_build_does_not_own() {
        let dir = temp_root("passthrough");
        let toe = dir.join("Show.toe");
        fs::write(&toe, b"x").unwrap();
        let sidecar = dir.join("Show.tdxlu.json");
        fs::write(
            &sidecar,
            r#"{"version":1,"tags":["a"],"windows":{"apply_on_load":true,
                "items":[{"path":"/perform","display":1}]},"future":"keep"}"#,
        )
        .unwrap();

        let mut meta = read_sidecar(toe.to_str().unwrap()).unwrap().1;
        assert!(meta.extra.contains_key("windows"));
        meta.tags = vec!["a".into(), "b".into()];
        save_project_meta(toe.to_str().unwrap(), &meta).unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&sidecar).unwrap()).unwrap();
        assert_eq!(raw["tags"][1], "b");
        assert_eq!(raw["windows"]["items"][0]["path"], "/perform");
        assert_eq!(raw["future"], "keep");

        let _ = fs::remove_dir_all(&dir);
    }

    /// An unparseable sidecar is user data: refuse, never overwrite.
    #[test]
    fn broken_sidecar_is_not_overwritten() {
        let dir = temp_root("broken");
        let toe = dir.join("Bad.toe");
        fs::write(&toe, b"x").unwrap();
        let sidecar = dir.join("Bad.tdxlu.json");
        fs::write(&sidecar, "{ not json").unwrap();

        assert!(set_gpu_affinity(toe.to_str().unwrap(), Some(affinity(Some(0), None))).is_err());
        assert_eq!(fs::read_to_string(&sidecar).unwrap(), "{ not json");

        let _ = fs::remove_dir_all(&dir);
    }
}
