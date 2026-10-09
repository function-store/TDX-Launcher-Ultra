//! Project variant families.
//!
//! TouchDesigner projects accumulate sibling files of one logical project:
//! incremental saves (`Project.2.toe` … — TD's incremental-filename setting,
//! the plain `Project.toe` stays the head), retained backups
//! (`Backup/Project.30.toe`), and crash autosaves (`CrashAutoSave.Project.toe`).
//! This module groups them deterministically — filesystem conventions only, no
//! stored state — so the UI can show one card per project with a versions
//! drawer, restore a variant as the new head, and prune old copies.
//!
//! Guard rule: a numeric suffix counts as an increment only when the plain
//! head exists or at least two files share the base with different numeric
//! suffixes. A lone `Show.2024.toe` stays its own project (the "year in the
//! name" false positive).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const CRASH_PREFIX: &str = "CrashAutoSave.";
const BACKUP_DIR: &str = "Backup";

/// One recent entry as the frontend knows it — path + last-opened stamp.
#[derive(Debug, Clone, Deserialize)]
pub struct FamilyScanEntry {
    pub path: String,
    #[serde(default)]
    pub last_opened: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VariantKind {
    Head,
    Increment,
    Backup,
    Crash,
}

#[derive(Debug, Clone, Serialize)]
pub struct VariantInfo {
    pub path: String,
    pub kind: VariantKind,
    /// The `N` in `Name.N.toe`, when present.
    pub ordinal: Option<u32>,
    /// File mtime, epoch seconds. `None` if the file vanished mid-scan.
    pub modified: Option<f64>,
    pub size: u64,
    /// Joined from the launcher/TD recents, when this exact file appears there.
    pub last_opened: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectFamily {
    /// Stable grouping key: normalized family dir + base stem, both lowercased.
    pub key: String,
    /// Base stem, e.g. `Project` (casing from the head when it exists).
    pub display_name: String,
    pub dir: String,
    /// Path of `Base.toe` when it exists on disk — the canonical head.
    pub head: Option<String>,
    /// Newest activity across variants: max(mtime, last_opened). Sort key.
    pub latest_activity: f64,
    /// Variant with the newest recents stamp, when any member has one.
    pub last_opened_variant: Option<String>,
    /// A crash autosave exists and is newer than the head (or no head exists).
    pub crash_newer_than_head: bool,
    /// Total bytes of increments + backups + crash files (prunable copies).
    pub reclaimable_bytes: u64,
    /// Head first, then increments (desc), backups (desc), crash last.
    pub variants: Vec<VariantInfo>,
    /// Normalized member paths (scanned variants ∪ seed entries) — the
    /// frontend joins list rows to families through this.
    pub member_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreResult {
    /// The head path the variant now lives at.
    pub head: String,
    /// Where the previous head was preserved (next free increment), if one existed.
    pub preserved_as: Option<String>,
}

/// Forward slashes + lowercase — the same normalization the frontend uses.
fn norm(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// `Name.toe` → `("Name", None)`; `Name.7.toe` → `("Name", Some(7))`.
/// `None` for non-`.toe` names. Extension check is case-insensitive.
///
/// All fixed-offset slicing in this module goes through `str::get` — file
/// names are arbitrary UTF-8 (Cyrillic, emoji, …), and a direct byte-index
/// slice panics when the boundary lands mid-character.
fn parse_toe_name(file_name: &str) -> Option<(String, Option<u32>)> {
    let ext_at = file_name.len().checked_sub(4)?;
    if !file_name.get(ext_at..)?.eq_ignore_ascii_case(".toe") {
        return None;
    }
    // The last 4 bytes are ASCII ".toe", so ext_at is a char boundary.
    let stem = &file_name[..ext_at];
    if stem.is_empty() {
        return None;
    }
    if let Some((base, digits)) = stem.rsplit_once('.') {
        if !base.is_empty() && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(n) = digits.parse::<u32>() {
                return Some((base.to_string(), Some(n)));
            }
        }
    }
    Some((stem.to_string(), None))
}

/// `CrashAutoSave.Project.toe` → `Project.toe`. `None` when not crash-prefixed.
fn strip_crash_prefix(file_name: &str) -> Option<&str> {
    let prefix = file_name.get(..CRASH_PREFIX.len())?;
    if file_name.len() > CRASH_PREFIX.len() && prefix.eq_ignore_ascii_case(CRASH_PREFIX) {
        // The prefix is ASCII, so the boundary after it is a char boundary.
        Some(&file_name[CRASH_PREFIX.len()..])
    } else {
        None
    }
}

fn is_backup_dir_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(BACKUP_DIR)
}

/// One directory read, cached per scan: file names and dir names, no metadata.
#[derive(Default)]
struct DirListing {
    files: Vec<String>,
    dirs: Vec<String>,
}

#[derive(Default)]
struct ListingCache(HashMap<PathBuf, DirListing>);

impl ListingCache {
    fn get(&mut self, dir: &Path) -> &DirListing {
        if !self.0.contains_key(dir) {
            let mut listing = DirListing::default();
            if let Ok(rd) = fs::read_dir(dir) {
                for entry in rd.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    match entry.file_type() {
                        Ok(t) if t.is_dir() => listing.dirs.push(name),
                        Ok(_) => listing.files.push(name),
                        Err(_) => {}
                    }
                }
            }
            self.0.insert(dir.to_path_buf(), listing);
        }
        &self.0[dir]
    }

    /// The `Backup` subdir of `dir` with its actual on-disk casing, if present.
    fn backup_subdir(&mut self, dir: &Path) -> Option<PathBuf> {
        let name = self
            .get(dir)
            .dirs
            .iter()
            .find(|d| is_backup_dir_name(d))
            .cloned()?;
        Some(dir.join(name))
    }
}

/// Full stem equals base (`Show.2024.toe` matches base `Show.2024`) — the
/// head test that also works for bases containing dots.
fn stem_is_base(file_name: &str, base: &str) -> bool {
    let Some(ext_at) = file_name.len().checked_sub(4) else {
        return false;
    };
    let Some(ext) = file_name.get(ext_at..) else {
        return false;
    };
    // ext being ASCII ".toe" makes ext_at a valid boundary for the stem slice.
    !base.is_empty()
        && ext.eq_ignore_ascii_case(".toe")
        && file_name[..ext_at].eq_ignore_ascii_case(base)
}

/// `(head_present, numbered_count)` for `base` among `dir`'s direct files.
fn dir_members(cache: &mut ListingCache, dir: &Path, base: &str) -> (bool, usize) {
    let mut head = false;
    let mut numbered = 0usize;
    for f in &cache.get(dir).files {
        if stem_is_base(f, base) {
            head = true;
        } else if let Some((b, Some(_))) = parse_toe_name(f) {
            if b.eq_ignore_ascii_case(base) {
                numbered += 1;
            }
        }
    }
    (head, numbered)
}

/// Does `dir` hold evidence that `base` is a real family — a plain head, or
/// ≥2 numeric increments (counting its `Backup/`)? Drives the guard rule.
fn family_evidence(cache: &mut ListingCache, dir: &Path, base: &str) -> bool {
    let (head, mut numbered) = dir_members(cache, dir, base);
    if head {
        return true;
    }
    if let Some(backup) = cache.backup_subdir(dir) {
        numbered += dir_members(cache, &backup, base).1;
    }
    numbered >= 2
}

/// Any member of `base` among `dir`'s own files (Backup/ NOT counted) —
/// decides whether a Backup-dir seed hoists up to `dir`.
fn parent_has_member(cache: &mut ListingCache, dir: &Path, base: &str) -> bool {
    let (head, numbered) = dir_members(cache, dir, base);
    head || numbered > 0
}

/// Where a recent entry's family lives: `(family_dir, base_stem)`.
fn resolve_seed(cache: &mut ListingCache, path: &Path) -> Option<(PathBuf, String)> {
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let parent = path.parent()?.to_path_buf();

    let effective_name = strip_crash_prefix(&file_name).unwrap_or(&file_name);
    let is_crash = effective_name.len() != file_name.len();
    let (base, ordinal) = parse_toe_name(effective_name)?;

    // A file inside `Backup/` belongs to the project one level up — but only
    // when the parent actually shows family members there. A project that just
    // happens to live in a folder named Backup stays where it is.
    let mut family_dir = parent.clone();
    if parent
        .file_name()
        .map(|n| is_backup_dir_name(&n.to_string_lossy()))
        .unwrap_or(false)
    {
        if let Some(grand) = parent.parent() {
            if parent_has_member(cache, grand, &base) {
                family_dir = grand.to_path_buf();
            }
        }
    }

    // Guard rule: numeric suffix = increment only with corroborating evidence.
    // Crash files skip it — the prefix already marks them unambiguously.
    if ordinal.is_some() && !is_crash && !family_evidence(cache, &family_dir, &base) {
        // Lone `Show.2024.toe` — its own family under the full stem.
        let full_stem = &effective_name[..effective_name.len() - 4];
        return Some((parent, full_stem.to_string()));
    }

    Some((family_dir, base))
}

fn file_facts(path: &Path) -> (Option<f64>, u64) {
    match fs::metadata(path) {
        Ok(md) => {
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64());
            (mtime, md.len())
        }
        Err(_) => (None, 0),
    }
}

fn build_family(
    cache: &mut ListingCache,
    family_dir: &Path,
    base: &str,
    last_opened: &HashMap<String, f64>,
    seed_paths: &[String],
) -> ProjectFamily {
    let mut variants: Vec<VariantInfo> = Vec::new();

    let mut push = |path: PathBuf, kind: VariantKind, ordinal: Option<u32>| {
        let (modified, size) = file_facts(&path);
        let path_str = path.to_string_lossy().to_string();
        let lo = last_opened.get(&norm(&path_str)).copied();
        variants.push(VariantInfo {
            path: path_str,
            kind,
            ordinal,
            modified,
            size,
            last_opened: lo,
        });
    };

    // Family dir: head, increments, crash autosaves.
    let files = cache.get(family_dir).files.clone();
    for f in &files {
        if let Some(rest) = strip_crash_prefix(f) {
            if let Some((b, ord)) = parse_toe_name(rest) {
                if b.eq_ignore_ascii_case(base) {
                    push(family_dir.join(f), VariantKind::Crash, ord);
                }
            }
            continue;
        }
        if stem_is_base(f, base) {
            push(family_dir.join(f), VariantKind::Head, None);
        } else if let Some((b, Some(n))) = parse_toe_name(f) {
            if b.eq_ignore_ascii_case(base) {
                push(family_dir.join(f), VariantKind::Increment, Some(n));
            }
        }
    }

    // Backup subdir: everything base-matching is a backup, numbered or not.
    if let Some(backup) = cache.backup_subdir(family_dir) {
        let bfiles = cache.get(&backup).files.clone();
        for f in &bfiles {
            if stem_is_base(f, base) {
                push(backup.join(f), VariantKind::Backup, None);
            } else if let Some((b, Some(n))) = parse_toe_name(f) {
                if b.eq_ignore_ascii_case(base) {
                    push(backup.join(f), VariantKind::Backup, Some(n));
                }
            }
        }
    }

    // Head, increments desc, backups desc, crash last.
    let rank = |k: &VariantKind| match k {
        VariantKind::Head => 0u8,
        VariantKind::Increment => 1,
        VariantKind::Backup => 2,
        VariantKind::Crash => 3,
    };
    variants.sort_by(|a, b| {
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then(b.ordinal.unwrap_or(0).cmp(&a.ordinal.unwrap_or(0)))
    });

    let head = variants
        .iter()
        .find(|v| v.kind == VariantKind::Head)
        .map(|v| v.path.clone());
    // Casing from the head's actual file name when it exists (full stem — a
    // dotted base like `Show.2024` must not be re-split), else the seed base.
    let display_name = head
        .as_deref()
        .and_then(|h| Path::new(h).file_name().map(|n| n.to_string_lossy().to_string()))
        .map(|n| n[..n.len() - 4].to_string())
        .unwrap_or_else(|| base.to_string());

    let latest_activity = variants
        .iter()
        .flat_map(|v| [v.modified.unwrap_or(0.0), v.last_opened.unwrap_or(0.0)])
        .fold(0.0f64, f64::max);
    let last_opened_variant = variants
        .iter()
        .filter(|v| v.last_opened.is_some())
        .max_by(|a, b| {
            a.last_opened
                .partial_cmp(&b.last_opened)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|v| v.path.clone());

    let head_mtime = variants
        .iter()
        .find(|v| v.kind == VariantKind::Head)
        .and_then(|v| v.modified);
    let crash_newer_than_head = variants
        .iter()
        .filter(|v| v.kind == VariantKind::Crash)
        .any(|c| match (c.modified, head_mtime) {
            (Some(cm), Some(hm)) => cm > hm,
            (Some(_), None) => true,
            _ => false,
        });

    let reclaimable_bytes = variants
        .iter()
        .filter(|v| v.kind != VariantKind::Head)
        .map(|v| v.size)
        .sum();

    let mut member_paths: Vec<String> = variants.iter().map(|v| norm(&v.path)).collect();
    for s in seed_paths {
        let n = norm(s);
        if !member_paths.contains(&n) {
            member_paths.push(n);
        }
    }

    ProjectFamily {
        key: format!("{}|{}", norm(&family_dir.to_string_lossy()), base.to_lowercase()),
        display_name,
        dir: family_dir.to_string_lossy().to_string(),
        head,
        latest_activity,
        last_opened_variant,
        crash_newer_than_head,
        reclaimable_bytes,
        variants,
        member_paths,
    }
}

/// Group recent entries into families and scan each family's disk state.
/// Families come back in first-seen seed order (recents are recency-ordered,
/// so a family sits at its newest member's position).
pub fn scan_families(entries: &[FamilyScanEntry]) -> Vec<ProjectFamily> {
    let mut cache = ListingCache::default();
    let last_opened: HashMap<String, f64> = entries
        .iter()
        .filter_map(|e| e.last_opened.map(|t| (norm(&e.path), t)))
        .collect();

    // Seed order + per-family seed paths (for member_paths of vanished files).
    let mut order: Vec<(PathBuf, String)> = Vec::new();
    let mut seeds: HashMap<String, Vec<String>> = HashMap::new();
    for e in entries {
        let path = PathBuf::from(&e.path);
        let Some((dir, base)) = resolve_seed(&mut cache, &path) else {
            continue;
        };
        let key = format!("{}|{}", norm(&dir.to_string_lossy()), base.to_lowercase());
        if !seeds.contains_key(&key) {
            order.push((dir, base));
        }
        seeds.entry(key).or_default().push(e.path.clone());
    }

    order
        .into_iter()
        .map(|(dir, base)| {
            let key = format!("{}|{}", norm(&dir.to_string_lossy()), base.to_lowercase());
            let seed_paths = seeds.get(&key).cloned().unwrap_or_default();
            build_family(&mut cache, &dir, &base, &last_opened, &seed_paths)
        })
        .collect()
}

/// Family home of an on-disk variant: `(family_dir, base)`. Unlike
/// [`resolve_seed`] this hoists out of `Backup/` unconditionally — invoking a
/// restore on `Backup/X.toe` states the intent.
fn variant_home(path: &Path) -> Result<(PathBuf, String), String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "Not a file path".to_string())?
        .to_string_lossy()
        .to_string();
    let effective = strip_crash_prefix(&file_name).unwrap_or(&file_name);
    let (base, _) =
        parse_toe_name(effective).ok_or_else(|| format!("Not a .toe file: {file_name}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "No parent directory".to_string())?
        .to_path_buf();
    let family_dir = if parent
        .file_name()
        .map(|n| is_backup_dir_name(&n.to_string_lossy()))
        .unwrap_or(false)
    {
        parent.parent().map(|p| p.to_path_buf()).unwrap_or(parent)
    } else {
        parent
    };
    Ok((family_dir, base))
}

/// Highest numeric suffix in use for `base` across the family dir and its
/// `Backup/` — the next increment lands above every number the user has seen.
fn max_ordinal(cache: &mut ListingCache, family_dir: &Path, base: &str) -> u32 {
    let mut max = 0u32;
    let mut scan = |listing: &DirListing| {
        for f in &listing.files {
            let eff = strip_crash_prefix(f).unwrap_or(f);
            if let Some((b, Some(n))) = parse_toe_name(eff) {
                if b.eq_ignore_ascii_case(base) && n > max {
                    max = n;
                }
            }
        }
    };
    scan(cache.get(family_dir));
    if let Some(backup) = cache.backup_subdir(family_dir) {
        scan(cache.get(&backup));
    }
    max
}

/// Copy `source_path` into a fresh, never-colliding increment (`Base.N.toe`)
/// next to the project — the same numbering TD's own incremental save uses,
/// so the new copy folds straight into the next family scan. Works from any
/// existing variant (head, an old increment, a backup, a crash autosave);
/// the source file is only ever read, never touched.
pub fn create_variant(source_path: &str) -> Result<VariantInfo, String> {
    let source = Path::new(source_path);
    if !source.is_file() {
        return Err(format!("File not found: {source_path}"));
    }
    let (family_dir, base) = variant_home(source)?;
    let mut cache = ListingCache::default();
    let mut n = max_ordinal(&mut cache, &family_dir, &base) + 1;
    let mut target = family_dir.join(format!("{base}.{n}.toe"));
    while target.exists() {
        n += 1;
        target = family_dir.join(format!("{base}.{n}.toe"));
    }
    fs::copy(source, &target).map_err(|e| format!("Copy failed: {e}"))?;
    let (modified, size) = file_facts(&target);
    Ok(VariantInfo {
        path: target.to_string_lossy().to_string(),
        kind: VariantKind::Increment,
        ordinal: Some(n),
        modified,
        size,
        last_opened: None,
    })
}

/// Make `variant_path` the family head (`Base.toe`). The current head, when
/// present, is preserved first as the next free increment — nothing is ever
/// overwritten or deleted. The variant file itself is copied, not moved.
pub fn restore_variant_as_head(variant_path: &str) -> Result<RestoreResult, String> {
    let variant = Path::new(variant_path);
    if !variant.is_file() {
        return Err(format!("File not found: {variant_path}"));
    }
    let (family_dir, base) = variant_home(variant)?;
    let head = family_dir.join(format!("{base}.toe"));

    if norm(&head.to_string_lossy()) == norm(variant_path) {
        return Err("This file already is the project head".into());
    }

    let mut preserved_as: Option<String> = None;
    if head.exists() {
        let mut cache = ListingCache::default();
        let mut n = max_ordinal(&mut cache, &family_dir, &base) + 1;
        let mut target = family_dir.join(format!("{base}.{n}.toe"));
        while target.exists() {
            n += 1;
            target = family_dir.join(format!("{base}.{n}.toe"));
        }
        fs::rename(&head, &target)
            .map_err(|e| format!("Could not preserve current head: {e}"))?;
        preserved_as = Some(target.to_string_lossy().to_string());

        if let Err(e) = fs::copy(variant, &head) {
            // Roll the head back so the family is left exactly as found.
            let _ = fs::rename(&target, &head);
            return Err(format!("Copy failed: {e}"));
        }
    } else {
        fs::copy(variant, &head).map_err(|e| format!("Copy failed: {e}"))?;
    }

    Ok(RestoreResult {
        head: head.to_string_lossy().to_string(),
        preserved_as,
    })
}

/// Is this a copy the prune UI may delete — an increment, a backup-folder
/// file, or a crash autosave? Plain heads outside `Backup/` are refused.
fn prunable(path: &Path) -> Result<(), String> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if strip_crash_prefix(&file_name).is_some() {
        return Ok(());
    }
    let (_, ordinal) =
        parse_toe_name(&file_name).ok_or_else(|| format!("Not a .toe file: {file_name}"))?;
    if ordinal.is_some() {
        return Ok(());
    }
    let in_backup = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| is_backup_dir_name(&n.to_string_lossy()))
        .unwrap_or(false);
    if in_backup {
        return Ok(());
    }
    Err(format!(
        "Refusing to delete {file_name}: it is a project head, not a version copy"
    ))
}

/// Move variant copies to the OS trash (recoverable). Validates every path
/// before touching any — all or nothing. Returns the bytes reclaimed.
pub fn trash_variants(paths: &[String]) -> Result<u64, String> {
    let mut bytes = 0u64;
    for p in paths {
        let path = Path::new(p);
        if !path.is_file() {
            return Err(format!("File not found: {p}"));
        }
        prunable(path)?;
        bytes += fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    trash::delete_all(paths).map_err(|e| format!("Move to trash failed: {e}"))?;
    Ok(bytes)
}

#[cfg(test)]
pub(crate) mod tests_support {
    pub use super::tests::{entry, temp_root, touch};
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tdxlu-variants-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn touch(path: &Path, bytes: usize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    pub fn entry(p: &Path) -> FamilyScanEntry {
        FamilyScanEntry {
            path: p.to_string_lossy().to_string(),
            last_opened: None,
        }
    }

    #[test]
    fn parses_toe_names() {
        assert_eq!(parse_toe_name("Project.toe"), Some(("Project".into(), None)));
        assert_eq!(
            parse_toe_name("Project.7.toe"),
            Some(("Project".into(), Some(7)))
        );
        assert_eq!(
            parse_toe_name("Show.2024.toe"),
            Some(("Show".into(), Some(2024)))
        );
        assert_eq!(
            parse_toe_name("My.Project.3.toe"),
            Some(("My.Project".into(), Some(3)))
        );
        assert_eq!(parse_toe_name("Project.TOE"), Some(("Project".into(), None)));
        assert_eq!(parse_toe_name("Project.tox"), None);
        assert_eq!(parse_toe_name(".toe"), None);
    }

    #[test]
    fn non_ascii_names_do_not_panic() {
        // "Аудио-визуал реактив.toe": Cyrillic 'а' spans bytes 13..15 — exactly
        // the byte-slice panic seen in the field (CRASH_PREFIX is 14 bytes).
        let name = "Аудио-визуал реактив.toe";
        assert_eq!(parse_toe_name(name), Some(("Аудио-визуал реактив".into(), None)));
        assert_eq!(strip_crash_prefix(name), None);
        assert!(stem_is_base(name, "Аудио-визуал реактив"));
        assert!(!stem_is_base(name, "Аудио"));
        // Short and multi-byte-only names survive every helper too.
        for n in ["ü.toe", "é", "проект.7.toe", "日本語.toe", "🎛️.toe", ".toe"] {
            let _ = parse_toe_name(n);
            let _ = strip_crash_prefix(n);
            let _ = stem_is_base(n, "x");
        }
        assert_eq!(
            parse_toe_name("проект.7.toe"),
            Some(("проект".into(), Some(7)))
        );
        assert_eq!(
            strip_crash_prefix("CrashAutoSave.проект.toe"),
            Some("проект.toe")
        );

        // End-to-end: a scan over a non-ASCII family must not panic.
        let root = temp_root("utf8");
        let head = root.join("Аудио-визуал реактив.toe");
        touch(&head, 10);
        touch(&root.join("Аудио-визуал реактив.2.toe"), 5);
        touch(&root.join("CrashAutoSave.Аудио-визуал реактив.toe"), 7);
        let fams = scan_families(&[entry(&head)]);
        assert_eq!(fams.len(), 1);
        assert_eq!(fams[0].display_name, "Аудио-визуал реактив");
        assert_eq!(fams[0].variants.len(), 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn groups_head_increments_backups_and_crash() {
        let root = temp_root("group");
        let head = root.join("Project.toe");
        touch(&head, 100);
        touch(&root.join("Project.2.toe"), 10);
        touch(&root.join("Project.5.toe"), 20);
        touch(&root.join("Backup").join("Project.30.toe"), 30);
        touch(&root.join("CrashAutoSave.Project.toe"), 40);
        touch(&root.join("Other.toe"), 5);

        let fams = scan_families(&[entry(&head), entry(&root.join("Project.5.toe"))]);
        assert_eq!(fams.len(), 1, "both seeds resolve to one family");
        let f = &fams[0];
        assert_eq!(f.display_name, "Project");
        assert_eq!(f.head.as_deref(), Some(head.to_string_lossy().as_ref()));
        assert_eq!(f.variants.len(), 5);
        assert_eq!(f.variants[0].kind, VariantKind::Head);
        // Increments descend: 5 before 2.
        assert_eq!(f.variants[1].ordinal, Some(5));
        assert_eq!(f.variants[2].ordinal, Some(2));
        assert_eq!(f.variants[3].kind, VariantKind::Backup);
        assert_eq!(f.variants[4].kind, VariantKind::Crash);
        // Reclaimable = everything but the head.
        assert_eq!(f.reclaimable_bytes, 10 + 20 + 30 + 40);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lone_numeric_suffix_is_not_an_increment() {
        let root = temp_root("lone");
        let show = root.join("Show.2024.toe");
        touch(&show, 10);

        let fams = scan_families(&[entry(&show)]);
        assert_eq!(fams.len(), 1);
        assert_eq!(fams[0].display_name, "Show.2024");
        assert_eq!(fams[0].variants.len(), 1);
        assert_eq!(fams[0].variants[0].kind, VariantKind::Head);

        // Evidence flips it: with Show.toe present, Show.2024.toe is an increment.
        touch(&root.join("Show.toe"), 10);
        let fams = scan_families(&[entry(&show)]);
        assert_eq!(fams[0].display_name, "Show");
        assert_eq!(fams[0].variants.len(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_numbered_siblings_are_evidence() {
        let root = temp_root("siblings");
        let a = root.join("Piece.3.toe");
        touch(&a, 10);
        touch(&root.join("Piece.4.toe"), 10);

        let fams = scan_families(&[entry(&a)]);
        assert_eq!(fams[0].display_name, "Piece");
        assert_eq!(fams[0].variants.len(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn backup_seed_hoists_to_parent_family() {
        let root = temp_root("hoist");
        touch(&root.join("Live.toe"), 10);
        let backup = root.join("Backup").join("Live.12.toe");
        touch(&backup, 10);

        let fams = scan_families(&[entry(&backup)]);
        assert_eq!(fams.len(), 1);
        assert_eq!(
            fams[0].head.as_deref(),
            Some(root.join("Live.toe").to_string_lossy().as_ref())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_living_in_a_backup_folder_stays_put() {
        let root = temp_root("bkhome");
        // No family members one level up — this "Backup" is just a folder name.
        let toe = root.join("Backup").join("Standalone.toe");
        touch(&toe, 10);

        let fams = scan_families(&[entry(&toe)]);
        assert_eq!(fams.len(), 1);
        assert!(norm(&fams[0].dir).ends_with("/backup"));
        assert_eq!(fams[0].variants[0].kind, VariantKind::Head);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_variant_makes_a_fresh_increment_from_the_head() {
        let root = temp_root("createvariant");
        let head = root.join("Project.toe");
        touch(&head, 50);
        touch(&root.join("Project.2.toe"), 10);

        let v = create_variant(&head.to_string_lossy()).unwrap();
        assert_eq!(v.kind, VariantKind::Increment);
        assert_eq!(v.ordinal, Some(3));
        assert_eq!(v.size, 50, "copied the head's bytes");
        assert!(Path::new(&v.path).exists());
        assert!(head.exists(), "source untouched");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_variant_from_an_old_increment_copies_that_files_bytes() {
        let root = temp_root("createvariant2");
        touch(&root.join("Project.toe"), 50);
        let inc = root.join("Project.2.toe");
        touch(&inc, 20);

        let v = create_variant(&inc.to_string_lossy()).unwrap();
        assert_eq!(v.ordinal, Some(3));
        assert_eq!(v.size, 20, "copied from the increment, not the head");
        assert!(inc.exists(), "source untouched");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_variant_from_a_backup_lands_in_the_family_dir_not_backup() {
        let root = temp_root("createvariant3");
        touch(&root.join("Project.toe"), 50);
        let bak = root.join("Backup").join("Project.9.toe");
        touch(&bak, 30);

        let v = create_variant(&bak.to_string_lossy()).unwrap();
        assert_eq!(v.ordinal, Some(10));
        assert!(
            !v.path.replace('\\', "/").to_lowercase().contains("/backup/"),
            "landed beside the project, not inside Backup/: {}",
            v.path
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_variant_rejects_a_missing_source() {
        assert!(create_variant("C:/definitely/not/a/real/path/Project.toe").is_err());
    }

    #[test]
    fn restore_preserves_head_as_next_increment() {
        let root = temp_root("restore");
        let head = root.join("Project.toe");
        touch(&head, 100);
        touch(&root.join("Project.2.toe"), 10);
        let backup = root.join("Backup").join("Project.30.toe");
        touch(&backup, 33);

        let res = restore_variant_as_head(&backup.to_string_lossy()).unwrap();
        // Next free ordinal above every number in dir + Backup: 31.
        assert_eq!(
            res.preserved_as.as_deref(),
            Some(root.join("Project.31.toe").to_string_lossy().as_ref())
        );
        assert_eq!(fs::metadata(&head).unwrap().len(), 33, "backup became head");
        assert_eq!(
            fs::metadata(root.join("Project.31.toe")).unwrap().len(),
            100,
            "old head preserved"
        );
        assert!(backup.exists(), "source copy untouched");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_without_head_just_copies() {
        let root = temp_root("nohead");
        touch(&root.join("Solo.2.toe"), 10);
        touch(&root.join("Solo.3.toe"), 12);

        let res = restore_variant_as_head(&root.join("Solo.3.toe").to_string_lossy()).unwrap();
        assert!(res.preserved_as.is_none());
        assert_eq!(fs::metadata(root.join("Solo.toe")).unwrap().len(), 12);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_refuses_the_head_itself() {
        let root = temp_root("selfhead");
        let head = root.join("Project.toe");
        touch(&head, 10);
        assert!(restore_variant_as_head(&head.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_refuses_heads_allows_copies() {
        let root = temp_root("prune");
        let head = root.join("Project.toe");
        let inc = root.join("Project.2.toe");
        let bak = root.join("Backup").join("Project.9.toe");
        let crash = root.join("CrashAutoSave.Project.toe");
        touch(&head, 1);
        touch(&inc, 1);
        touch(&bak, 1);
        touch(&crash, 1);

        assert!(prunable(&head).is_err());
        assert!(prunable(&inc).is_ok());
        assert!(prunable(&bak).is_ok());
        assert!(prunable(&crash).is_ok());
        // Validation happens before any deletion: a head in the batch fails the lot.
        let batch = vec![
            inc.to_string_lossy().to_string(),
            head.to_string_lossy().to_string(),
        ];
        assert!(trash_variants(&batch).is_err());
        assert!(inc.exists(), "nothing deleted on refused batch");
        let _ = fs::remove_dir_all(&root);
    }
}

/// Outcome of a Safe Mode copy request.
#[derive(Debug, Clone, Serialize)]
pub struct SafeModeCopy {
    /// The `CrashAutoSave.` sibling — created, or the existing file when
    /// `needs_confirm` is set.
    pub path: String,
    /// Nothing was written: a file already sits there and the caller has not
    /// confirmed replacing it.
    pub needs_confirm: bool,
    /// mtime of the file in the way, so the prompt can date it.
    pub existing_modified: Option<f64>,
    /// An existing copy was replaced.
    pub replaced: bool,
}

/// Copy `source_path` to a Safe Mode sibling: `CrashAutoSave.<file name>`.
///
/// TouchDesigner opens any project whose file name begins with
/// `CrashAutoSave` in [Safe Mode](https://docs.derivative.ca/Safe_Mode),
/// where nothing cooks — the way into a project that crashes or hangs on
/// load. The copy lands beside the source, so the family scan already
/// classifies it as [`VariantKind::Crash`].
///
/// Never overwrites without `overwrite`: TD writes REAL crash autosaves under
/// exactly this name, and those are recovery data, not scratch. The source
/// file is only ever read.
pub fn create_safe_mode_copy(source_path: &str, overwrite: bool) -> Result<SafeModeCopy, String> {
    let source = Path::new(source_path);
    if !source.is_file() {
        return Err(format!("File not found: {source_path}"));
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "Not a file path".to_string())?
        .to_string_lossy()
        .to_string();
    if parse_toe_name(strip_crash_prefix(&file_name).unwrap_or(&file_name)).is_none() {
        return Err(format!("Not a .toe file: {file_name}"));
    }
    if strip_crash_prefix(&file_name).is_some() {
        return Err(format!("{file_name} already opens in Safe Mode"));
    }
    let parent = source
        .parent()
        .ok_or_else(|| "No parent directory".to_string())?;
    let target = parent.join(format!("{CRASH_PREFIX}{file_name}"));

    let existing = target.is_file();
    if existing && !overwrite {
        let (modified, _) = file_facts(&target);
        return Ok(SafeModeCopy {
            path: target.to_string_lossy().to_string(),
            needs_confirm: true,
            existing_modified: modified,
            replaced: false,
        });
    }
    fs::copy(source, &target).map_err(|e| format!("Copy failed: {e}"))?;
    Ok(SafeModeCopy {
        path: target.to_string_lossy().to_string(),
        needs_confirm: false,
        existing_modified: None,
        replaced: existing,
    })
}

#[cfg(test)]
mod deleted_member {
    use super::tests_support::*;
    use super::*;

    /// The reported scenario: a project was being worked on as `Project.7.toe`
    /// (Increment Filename left on), that file is deleted, and the plain
    /// `Project.toe` should take its place.
    #[test]
    fn deleting_the_open_increment_leaves_the_head_as_the_family() {
        let root = temp_root("deleted-open-increment");
        let head = root.join("Project.toe");
        let inc = root.join("Project.7.toe");
        touch(&head, 10);
        touch(&inc, 20);

        // Recents remembers the increment — that is the file that was open.
        let fams = scan_families(&[entry(&inc), entry(&head)]);
        assert_eq!(fams.len(), 1, "one family");
        assert_eq!(fams[0].variants.len(), 2);

        fs::remove_file(&inc).unwrap();

        let after = scan_families(&[entry(&inc), entry(&head)]);
        assert_eq!(after.len(), 1, "family survives the deletion");
        let f = &after[0];
        assert_eq!(
            f.head.as_deref().map(norm),
            Some(norm(&head.to_string_lossy())),
            "the plain .toe is still the head"
        );
        assert_eq!(f.variants.len(), 1, "only the file still on disk is a variant");
        assert!(
            f.member_paths.iter().any(|m| *m == norm(&inc.to_string_lossy())),
            "the deleted path stays a MEMBER so its recents row still maps to this family"
        );
    }
}
