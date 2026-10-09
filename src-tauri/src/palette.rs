//! TouchDesigner palette (.tox) folder scanning.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct PaletteItem {
    pub path: String,
    pub name: String,
    /// Folder path relative to the scan root (forward slashes), empty if at root.
    pub folder: String,
    /// Absolute root this item was found under.
    pub root: String,
    /// Short label for the root (folder name or "User Palette").
    pub root_label: String,
}

/// macOS keeps per-generation app support under a stable product-line folder
/// name ("TouchDesigner099") shared by every installed 099-generation build
/// (TouchDesigner.app, TouchDesigner 2.app, ... DEV, LATEST) — NOT under
/// Documents like Windows. Older/unversioned installs used a bare
/// "TouchDesigner" folder; check both before falling back.
#[cfg(target_os = "macos")]
pub fn default_user_palette_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        let support = home.join("Library/Application Support/Derivative");
        let versioned = support.join("TouchDesigner099/Palette");
        if versioned.is_dir() {
            return versioned;
        }
        let unversioned = support.join("TouchDesigner/Palette");
        if unversioned.is_dir() {
            return unversioned;
        }
        // Broader fallback if Palette hasn't been created yet, but TD has run.
        if support.join("TouchDesigner099").is_dir() {
            return support.join("TouchDesigner099");
        }
        if support.join("TouchDesigner").is_dir() {
            return support.join("TouchDesigner");
        }
    }
    // TD has never run on this machine — nothing to prefer yet.
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Derivative")
}

#[cfg(not(target_os = "macos"))]
pub fn default_user_palette_dir() -> PathBuf {
    let docs = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let palette = docs.join("Derivative").join("Palette");
    if palette.is_dir() {
        return palette;
    }
    // Broader fallback if Palette hasn't been created yet
    docs.join("Derivative")
}

/// Shipped Derivative palette under a TD install root or macOS `.app` bundle.
pub fn factory_palette_dir(install_or_app: &Path) -> Option<PathBuf> {
    let candidates = [
        install_or_app.join("Samples").join("Palette"),
        install_or_app.join("Palette"),
        // macOS application bundle layouts
        install_or_app
            .join("Contents")
            .join("Resources")
            .join("Samples")
            .join("Palette"),
        install_or_app
            .join("Contents")
            .join("Samples")
            .join("Palette"),
        install_or_app
            .join("Contents")
            .join("Resources")
            .join("Palette"),
        // Current macOS bundle layout: Contents/Resources/tfs/Samples/Palette
        install_or_app
            .join("Contents")
            .join("Resources")
            .join("tfs")
            .join("Samples")
            .join("Palette"),
    ];
    if let Some(hit) = candidates.into_iter().find(|p| p.is_dir()) {
        return Some(hit);
    }
    // Layout drift (notably macOS bundles): bounded search for a Palette dir,
    // preferring one under a Samples parent. Directories only, shallow.
    find_palette_dir(install_or_app, 0)
}

/// Depth-limited (≤4) directory walk for a `Palette` folder; `Samples/Palette`
/// wins over a bare `Palette` at the same level. 4 covers the deepest known
/// layout, `<app>/Contents/Resources/tfs/Samples/Palette`.
fn find_palette_dir(dir: &Path, depth: u32) -> Option<PathBuf> {
    if depth > 4 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    let mut bare_hit = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.eq_ignore_ascii_case("Palette") {
            if dir
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("Samples"))
                .unwrap_or(false)
            {
                return Some(path);
            }
            bare_hit.get_or_insert(path);
        } else if !name.starts_with('.') && !name.eq_ignore_ascii_case("Frameworks") {
            subdirs.push(path);
        }
    }
    for sub in subdirs {
        if let Some(hit) = find_palette_dir(&sub, depth + 1) {
            return Some(hit);
        }
    }
    bare_hit
}

/// Parse extra roots from a newline/semicolon-separated prefs string.
pub fn parse_extra_folders(raw: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for line in raw.lines() {
        for part in line.split(';') {
            let t = part.trim().trim_matches('"');
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            out.push(PathBuf::from(t));
        }
    }
    out
}

pub fn effective_roots(extra_folders: &str) -> Vec<(PathBuf, String)> {
    let mut roots = Vec::new();
    let default = default_user_palette_dir();
    if default.exists() {
        // Always "User Palette", regardless of what the folder is actually
        // named — root_label()'s name/parent guess is for extra folders only.
        // default_user_palette_dir() falls back to the bare "Derivative"
        // folder when "Derivative/Palette" hasn't been created yet, which
        // root_label() would otherwise mislabel with the folder's own name.
        roots.push((default, "User Palette".to_string()));
    }
    for r in parse_extra_folders(extra_folders) {
        if !r.exists() {
            continue;
        }
        let already = roots.iter().any(|(x, _)| paths_equal(x, &r));
        if !already {
            let label = root_label(&r);
            roots.push((r, label));
        }
    }
    roots
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    #[cfg(windows)]
    {
        ca.to_string_lossy().eq_ignore_ascii_case(&cb.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        ca == cb
    }
}

fn root_label(root: &Path) -> String {
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Palette");
    let parent = root
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if name.eq_ignore_ascii_case("Palette") && parent.eq_ignore_ascii_case("Derivative") {
        "User Palette".into()
    } else if name.eq_ignore_ascii_case("Palette") && parent.eq_ignore_ascii_case("Samples") {
        "Factory".into()
    } else {
        name.into()
    }
}

fn rel_folder(root: &Path, file: &Path) -> String {
    let parent = file.parent().unwrap_or(file);
    match parent.strip_prefix(root) {
        Ok(rel) if rel.as_os_str().is_empty() => String::new(),
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => String::new(),
    }
}

/// Recursively collect `.tox` files under user/extra roots and optional factory install.
///
/// `factory_install` is a TD install root (`install_path`) or macOS `.app` path.
pub fn scan_palette_roots(
    extra_folders: &str,
    factory_install: Option<&str>,
) -> Vec<PaletteItem> {
    let mut items = Vec::new();
    let mut roots = effective_roots(extra_folders);

    if let Some(raw) = factory_install {
        let install = PathBuf::from(raw.trim());
        if !install.as_os_str().is_empty() {
            if let Some(factory) = factory_palette_dir(&install) {
                let already = roots.iter().any(|(x, _)| paths_equal(x, &factory));
                if !already {
                    roots.push((factory, "Factory".into()));
                }
            }
        }
    }

    for (root, label) in roots {
        let root_str = root.to_string_lossy().to_string();
        walk_tox(&root, &root, &label, &root_str, &mut items);
    }
    items.sort_by(|a, b| {
        // User Palette first, then Factory, then extras
        root_sort_key(&a.root_label)
            .cmp(&root_sort_key(&b.root_label))
            .then_with(|| a.root_label.cmp(&b.root_label))
            .then_with(|| a.folder.cmp(&b.folder))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    items
}

fn root_sort_key(label: &str) -> u8 {
    if label == "User Palette" {
        0
    } else if label == "Factory" {
        1
    } else {
        2
    }
}

fn walk_tox(
    root: &Path,
    dir: &Path,
    label: &str,
    root_str: &str,
    out: &mut Vec<PaletteItem>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            dirs.push(path);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("tox"))
            .unwrap_or(false)
        {
            files.push(path);
        }
    }
    dirs.sort();
    files.sort();
    for path in files {
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("tox")
            .to_string();
        out.push(PaletteItem {
            path: path.to_string_lossy().to_string(),
            name,
            folder: rel_folder(root, &path),
            root: root_str.to_string(),
            root_label: label.to_string(),
        });
    }
    for d in dirs {
        walk_tox(root, &d, label, root_str, out);
    }
}

/// One scan root with why-is-it-empty diagnostics (shown in the UI empty state).
#[derive(Debug, Clone, Serialize)]
pub struct PaletteScanRoot {
    pub label: String,
    pub path: String,
    pub exists: bool,
    /// Directory listing succeeded (false on macOS TCC denial, permissions).
    pub readable: bool,
    pub tox_count: usize,
}

fn scan_root_info(label: &str, path: &Path) -> PaletteScanRoot {
    let exists = path.is_dir();
    let readable = exists && fs::read_dir(path).is_ok();
    let tox_count = if readable {
        let mut items = Vec::new();
        let s = path.to_string_lossy().to_string();
        walk_tox(path, path, label, &s, &mut items);
        items.len()
    } else {
        0
    };
    PaletteScanRoot {
        label: label.to_string(),
        path: path.to_string_lossy().replace('\\', "/"),
        exists,
        readable,
        tox_count,
    }
}

/// Diagnostics for every configured root — including ones that DON'T exist,
/// unlike `scan_palette_roots` which silently skips them.
pub fn palette_scan_info(extra_folders: &str, factory_install: Option<&str>) -> Vec<PaletteScanRoot> {
    let mut out = Vec::new();
    let default = default_user_palette_dir();
    out.push(scan_root_info("User Palette", &default));
    for r in parse_extra_folders(extra_folders) {
        if paths_equal(&r, &default) {
            continue;
        }
        let label = root_label(&r);
        out.push(scan_root_info(&label, &r));
    }
    if let Some(raw) = factory_install {
        let install = PathBuf::from(raw.trim());
        if !install.as_os_str().is_empty() {
            match factory_palette_dir(&install) {
                Some(factory) => out.push(scan_root_info("Factory", &factory)),
                None => out.push(PaletteScanRoot {
                    label: "Factory".into(),
                    path: install.to_string_lossy().replace('\\', "/"),
                    exists: false,
                    readable: false,
                    tox_count: 0,
                }),
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct PaletteImportResult {
    pub copied: Vec<String>,
    pub skipped: Vec<String>,
    pub dest_dir: String,
    pub palette_data_updated: bool,
}

fn skip_palette_dir_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || lower == "node_modules"
        || lower == "__pycache__"
        || lower == "tdimportcache"
        || lower == ".venv"
        || lower == "venv"
}

fn palette_data_rel_path(rel: &Path) -> String {
    let s = rel.to_string_lossy().replace('/', "\\");
    if s.is_empty() {
        String::new()
    } else if s.starts_with('\\') {
        s
    } else {
        format!("\\{s}")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaletteDataNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<PaletteDataNode>>,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_root: Option<String>,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    palette: Option<String>,
    path: String,
    #[serde(rename = "type")]
    node_type: String,
}

fn build_palette_data_node(dir: &Path, id: &str, rel: &Path) -> PaletteDataNode {
    let mut kids = Vec::new();
    let mut entries: Vec<(String, PathBuf, bool)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if skip_palette_dir_name(&name) && path.is_dir() {
                continue;
            }
            // Skip hidden files at root of rebuild (keep visible files TD cares about)
            if name.starts_with('.') && !path.is_dir() {
                continue;
            }
            entries.push((name, path, entry.file_type().map(|t| t.is_dir()).unwrap_or(false)));
        }
    }
    entries.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    let mut idx = 0usize;
    for (name, path, is_dir) in entries {
        idx += 1;
        let child_id = format!("{id}.{idx}");
        let child_rel = rel.join(&name);
        let path_str = palette_data_rel_path(&child_rel);
        if is_dir {
            let mut node = build_palette_data_node(&path, &child_id, &child_rel);
            node.name = name;
            node.path = path_str;
            node.id = child_id;
            kids.push(node);
        } else {
            kids.push(PaletteDataNode {
                children: None,
                id: child_id,
                local_root: None,
                name,
                palette: None,
                path: path_str,
                node_type: "file".into(),
            });
        }
    }
    PaletteDataNode {
        children: Some(kids),
        id: id.to_string(),
        local_root: None,
        name: dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Palette")
            .to_string(),
        palette: None,
        path: palette_data_rel_path(rel),
        node_type: "directory".into(),
    }
}

/// Rebuild `paletteData.json` so TouchDesigner picks up newly added files
/// (same idea as right-click -> Refresh Folder in the TD palette).
pub fn rebuild_user_palette_data(user_root: &Path) -> Result<(), String> {
    if !user_root.is_dir() {
        return Err(format!(
            "User palette folder not found: {}",
            user_root.display()
        ));
    }
    let mut root = build_palette_data_node(user_root, "2", Path::new(""));
    root.name = "My Components".into();
    root.local_root = Some("app.userPaletteFolder".into());
    root.palette = Some("My Components".into());
    root.path = "app.userPaletteFolder".into();
    root.node_type = "directory".into();

    let out_path = user_root.join("paletteData.json");
    let json = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize paletteData.json: {e}"))?;
    fs::write(&out_path, json).map_err(|e| format!("Failed to write paletteData.json: {e}"))?;
    Ok(())
}

fn unique_dest_path(dir: &Path, file_name: &str) -> PathBuf {
    let dest = dir.join(file_name);
    if !dest.exists() {
        return dest;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("component");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("tox");
    for n in 1..10_000 {
        let candidate = dir.join(format!("{stem}_{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}_{}.{}", std::process::id(), ext))
}

/// Copy `.tox` files into the user palette (optional subfolder) and refresh paletteData.json.
pub fn import_tox_to_user_palette(
    sources: &[String],
    dest_folder_rel: Option<&str>,
) -> Result<PaletteImportResult, String> {
    let user_root = default_user_palette_dir();
    if !user_root.is_dir() {
        fs::create_dir_all(&user_root)
            .map_err(|e| format!("Could not create user palette folder: {e}"))?;
    }

    let rel = dest_folder_rel
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '/' || c == '\\');
    let dest_dir = if rel.is_empty() {
        user_root.clone()
    } else {
        let mut d = user_root.clone();
        for part in rel.split(|c| c == '/' || c == '\\').filter(|s| !s.is_empty()) {
            if part == ".." || part == "." {
                continue;
            }
            d.push(part);
        }
        d
    };
    // Stay inside user palette
    let user_canon = user_root
        .canonicalize()
        .unwrap_or_else(|_| user_root.clone());
    fs::create_dir_all(&dest_dir).map_err(|e| format!("Could not create destination folder: {e}"))?;
    let dest_canon = dest_dir
        .canonicalize()
        .map_err(|e| format!("Invalid destination: {e}"))?;
    if !dest_canon.starts_with(&user_canon) {
        return Err("Destination must be inside the user palette folder".into());
    }

    let mut copied = Vec::new();
    let mut skipped = Vec::new();

    for src_raw in sources {
        let src = PathBuf::from(src_raw.trim());
        if !src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("tox"))
            .unwrap_or(false)
        {
            skipped.push(format!("{} (not a .tox)", src.display()));
            continue;
        }
        if !src.is_file() {
            skipped.push(format!("{} (missing)", src.display()));
            continue;
        }
        let src_canon = src.canonicalize().unwrap_or_else(|_| src.clone());
        // Already inside dest dir with same name - skip copy
        if src_canon.starts_with(&dest_canon)
            && src_canon.parent().map(|p| p == dest_canon.as_path()).unwrap_or(false)
        {
            skipped.push(format!("{} (already in folder)", src.display()));
            continue;
        }
        let file_name = src
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("component.tox");
        let dest = unique_dest_path(&dest_dir, file_name);
        match fs::copy(&src, &dest) {
            Ok(_) => copied.push(dest.to_string_lossy().to_string()),
            Err(e) => skipped.push(format!("{} ({e})", src.display())),
        }
    }

    let mut palette_data_updated = false;
    if !copied.is_empty() || sources.is_empty() {
        // Always rebuild after successful copies so TD sees new toxes
        if !copied.is_empty() {
            rebuild_user_palette_data(&user_root)?;
            palette_data_updated = true;
        }
    }

    Ok(PaletteImportResult {
        copied,
        skipped,
        dest_dir: dest_dir.to_string_lossy().to_string(),
        palette_data_updated,
    })
}

/// Moves a `.tox` out of the User Palette into the OS trash/recycle bin
/// (recoverable, unlike a permanent delete) and refreshes `paletteData.json`
/// so TD stops showing it. The frontend only offers this for files the tree
/// already marked `acceptImports` (i.e. under the user palette root), but
/// that's UI-side convenience, not a security boundary — the containment
/// check here is what actually prevents trashing an arbitrary path.
pub fn remove_user_palette_file(path: &str) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if !target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("tox"))
        .unwrap_or(false)
    {
        return Err("Only .tox files can be removed from the palette".into());
    }
    if !target.is_file() {
        return Err(format!("File not found: {}", target.display()));
    }

    let user_root = default_user_palette_dir();
    let user_canon = user_root
        .canonicalize()
        .map_err(|e| format!("User palette folder not found: {e}"))?;
    let target_canon = target.canonicalize().map_err(|e| format!("Invalid path: {e}"))?;
    if !target_canon.starts_with(&user_canon) {
        return Err("That file isn't inside the user palette folder".into());
    }

    trash::delete(&target_canon).map_err(|e| format!("Could not move to trash: {e}"))?;
    rebuild_user_palette_data(&user_root)
}
