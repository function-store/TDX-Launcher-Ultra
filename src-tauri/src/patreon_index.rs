//! A name-searchable index of every Patreon `.tox` this launcher has seen.
//!
//! Browsing Patreon is creator-at-a-time: pick a creator, wait for their post
//! list, read the attachment names. That is fine when you know whose component
//! you want and useless when you only remember the filename. This module is
//! the other half - "where is `God_Rays.tox`?" answered without picking a
//! creator first, and without touching the network.
//!
//! It merges two corpora into one result list:
//!
//! 1. **Cached listings.** Every creator's post list is snapshotted to disk the
//!    moment it is fetched (see [`record`]), trimmed to what a name search
//!    needs - no post bodies, no teaser HTML. So a creator opened once stays
//!    searchable forever, including attachments never downloaded.
//! 2. **Downloaded files.** A walk of the Patreon download root, which finds
//!    `.tox`/`.toe` no listing can describe: files pulled out of a `.zip`, and
//!    anything fetched before this index existed. Without it the feature would
//!    come up empty on first run despite a full download folder.
//!
//! Entries already on disk are marked (`localPath`), so the caller can say
//! which hits are instant and which still need a download. A file both corpora
//! know about appears once, from the listing, which has the richer context.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::config::ConfigManager;
use crate::patreon::PatreonToxPost;

/// Cap on returned hits. Generous enough that a real search never truncates,
/// low enough that a one-letter query cannot flood the UI.
const MAX_HITS: usize = 300;

/// How deep the download-root walk goes. The layout is
/// `<root>/<creator>/<hash>/[extracted/...]/file.tox`, so 6 clears it with room
/// to spare while still refusing to walk an arbitrary tree the user may have
/// pointed the download root at.
const MAX_WALK_DEPTH: usize = 6;

// ---------------------------------------------------------------------------
// On-disk shape

/// One creator's post listing, trimmed to what a name search needs.
#[derive(Serialize, Deserialize)]
struct CampaignIndex {
    id: String,
    name: String,
    /// Unix seconds. Informational - the index is never expired on age; a
    /// stale listing is still a true record of what that creator once posted.
    fetched_at: u64,
    posts: Vec<IndexedPost>,
}

#[derive(Serialize, Deserialize)]
struct IndexedPost {
    id: String,
    title: String,
    url: String,
    published_at: Option<String>,
    can_view: bool,
    files: Vec<IndexedFile>,
}

#[derive(Serialize, Deserialize)]
struct IndexedFile {
    name: String,
    url: String,
    kind: String,
}

/// One search result. `url` is absent for a file only the disk knows about
/// (extracted from a zip, or downloaded before this index existed);
/// `localPath` is absent for one that would still have to be downloaded.
/// At least one of the two is always present.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexHit {
    pub name: String,
    /// `"tox"`, `"toe"` or `"zip"`.
    pub kind: String,
    pub url: Option<String>,
    pub local_path: Option<String>,
    pub campaign_id: Option<String>,
    pub campaign_name: String,
    pub post_id: Option<String>,
    pub post_title: Option<String>,
    pub published_at: Option<String>,
    /// False only when a cached listing recorded the post as locked. A file
    /// already on disk is viewable by definition, whatever the tier says now.
    pub can_view: bool,
    /// The `.zip` this came out of, when it was found inside one.
    pub from_zip: Option<String>,
}

// ---------------------------------------------------------------------------
// Paths

fn index_dir() -> PathBuf {
    ConfigManager::config_dir().join("patreon_index")
}

/// A campaign id is a Patreon numeric id in practice, but it arrives from the
/// network - never let it choose a path. Anything outside `[A-Za-z0-9._-]` is
/// replaced, so the result is always one harmless filename segment.
fn slug(campaign_id: &str) -> String {
    let cleaned: String = campaign_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "unknown".into()
    } else {
        trimmed
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Writing

/// Snapshot a freshly fetched post list. Best-effort by design: this rides on
/// the back of a listing the user actually asked for, and a failed cache write
/// must never turn that into an error they see.
pub fn record(campaign_id: &str, campaign_name: &str, posts: &[PatreonToxPost]) {
    let id = campaign_id.trim();
    if id.is_empty() {
        return;
    }
    let idx = CampaignIndex {
        id: id.to_string(),
        name: campaign_name.trim().to_string(),
        fetched_at: now_secs(),
        posts: posts
            .iter()
            // Text-only posts carry nothing to search for.
            .filter(|p| !p.tox_files.is_empty())
            .map(|p| IndexedPost {
                id: p.id.clone(),
                title: p.title.clone(),
                url: p.url.clone(),
                published_at: p.published_at.clone(),
                can_view: p.can_view,
                files: p
                    .tox_files
                    .iter()
                    .map(|f| IndexedFile {
                        name: f.name.clone(),
                        url: f.url.clone(),
                        kind: f.kind.clone(),
                    })
                    .collect(),
            })
            .collect(),
    };
    let dir = index_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(body) = serde_json::to_vec(&idx) else {
        return;
    };
    let path = dir.join(format!("{}.json", slug(id)));
    let tmp = path.with_extension("json.partial");
    if std::fs::write(&tmp, &body).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// A search plus the shape of the cache it ran against. `cached_creators` is
/// what lets the UI tell "no creator has been opened yet" apart from "nothing
/// here is called that" - two empty results that mean opposite things.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<IndexHit>,
    pub cached_creators: usize,
    /// Unix seconds of the freshest snapshot; 0 when nothing is cached.
    pub newest_at: u64,
    /// True when the hit list was cut off at [`MAX_HITS`].
    pub truncated: bool,
}

pub fn search_result(query: &str, download_root: &str) -> SearchResult {
    let all = load_all();
    let hits = search(query, download_root);
    SearchResult {
        truncated: hits.len() >= MAX_HITS,
        hits,
        cached_creators: all.len(),
        newest_at: all.iter().map(|i| i.fetched_at).max().unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// Reading

fn load_all() -> Vec<CampaignIndex> {
    let Ok(entries) = std::fs::read_dir(index_dir()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(idx) = serde_json::from_slice::<CampaignIndex>(&bytes) {
                out.push(idx);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Matching

/// Case-insensitive, all-terms substring match - the same contract as the
/// frontends' own filter boxes, so a query behaves identically whether it is
/// narrowing the visible list or searching the cache behind it.
fn matches_all(haystack: &str, terms: &[String]) -> bool {
    let hay = haystack.to_lowercase();
    terms.iter().all(|t| hay.contains(t.as_str()))
}

fn terms_of(query: &str) -> Vec<String> {
    query
        .trim()
        .to_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

/// Filename matches outrank ones that only matched the post title or creator.
fn rank(name: &str, terms: &[String]) -> u8 {
    if matches_all(name, terms) {
        2
    } else {
        1
    }
}

// ---------------------------------------------------------------------------
// Search

/// Find every known `.tox`/`.toe`/`.zip` whose filename - or, failing that,
/// its post title or creator name - matches every term in `query`.
///
/// Purely local: no cookie, no network, safe to call on every keystroke. There
/// is deliberately no per-creator variant - with a creator open, both frontends
/// already filter that creator's loaded posts in memory, which is live and free.
pub fn search(query: &str, download_root: &str) -> Vec<IndexHit> {
    let terms = terms_of(query);
    if terms.is_empty() {
        return Vec::new();
    }

    let mut hits: Vec<(u8, IndexHit)> = Vec::new();
    // Local paths already accounted for, so the download-root walk does not
    // repeat a file the listings already described with post context.
    let mut seen_paths: HashSet<String> = HashSet::new();
    for idx in &load_all() {
        for post in &idx.posts {
            for file in &post.files {
                let local =
                    crate::patreon::tox_local_path(&file.url, &file.name, download_root, &idx.name);
                // An unpacked zip contributes its contents, which is where the
                // actually-loadable .tox usually lives.
                if file.kind == "zip" {
                    if let Ok(Some(extract)) = crate::patreon::zip_extract_status(
                        &file.url,
                        &file.name,
                        download_root,
                        &idx.name,
                    ) {
                        for inner in &extract.files {
                            seen_paths.insert(inner.path.to_lowercase());
                            if !matches_all(
                                &format!("{} {} {}", inner.name, post.title, idx.name),
                                &terms,
                            ) {
                                continue;
                            }
                            hits.push((
                                rank(&inner.name, &terms),
                                IndexHit {
                                    name: inner.name.clone(),
                                    kind: inner.kind.clone(),
                                    url: None,
                                    local_path: Some(inner.path.clone()),
                                    campaign_id: Some(idx.id.clone()),
                                    campaign_name: idx.name.clone(),
                                    post_id: Some(post.id.clone()),
                                    post_title: Some(post.title.clone()),
                                    published_at: post.published_at.clone(),
                                    can_view: true,
                                    from_zip: Some(file.name.clone()),
                                },
                            ));
                        }
                    }
                }
                if let Some(p) = local.as_deref() {
                    seen_paths.insert(p.to_lowercase());
                }
                if !matches_all(&format!("{} {} {}", file.name, post.title, idx.name), &terms) {
                    continue;
                }
                hits.push((
                    rank(&file.name, &terms),
                    IndexHit {
                        name: file.name.clone(),
                        kind: file.kind.clone(),
                        url: Some(file.url.clone()),
                        local_path: local,
                        campaign_id: Some(idx.id.clone()),
                        campaign_name: idx.name.clone(),
                        post_id: Some(post.id.clone()),
                        post_title: Some(post.title.clone()),
                        published_at: post.published_at.clone(),
                        can_view: post.can_view,
                        from_zip: None,
                    },
                ));
            }
        }
    }

    // Second corpus: what is actually on disk, minus everything a listing
    // already claimed above.
    add_local_hits(&mut hits, &seen_paths, walk_downloads(download_root), &terms);

    // Filename matches above title/creator-only ones, newest first inside each
    // band, then by name so identical runs come back in the same order.
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| {
                b.1.published_at
                    .as_deref()
                    .unwrap_or("")
                    .cmp(a.1.published_at.as_deref().unwrap_or(""))
            })
            .then_with(|| a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()))
    });
    hits.into_iter().map(|(_, h)| h).take(MAX_HITS).collect()
}

/// Fold the on-disk corpus into hits already gathered from the listings.
///
/// Split out from [`search`] because this is where the two corpora meet: a
/// file both know about must appear once, and the listing wins - it carries
/// the post and the campaign id, which a bare file on disk cannot.
fn add_local_hits(
    hits: &mut Vec<(u8, IndexHit)>,
    seen_paths: &HashSet<String>,
    local: Vec<(String, String, String, String)>,
    terms: &[String],
) {
    for (creator, path, name, kind) in local {
        if seen_paths.contains(&path.to_lowercase()) {
            continue;
        }
        if !matches_all(&format!("{name} {creator}"), terms) {
            continue;
        }
        hits.push((
            rank(&name, terms),
            IndexHit {
                name,
                kind,
                url: None,
                local_path: Some(path),
                campaign_id: None,
                campaign_name: creator,
                post_id: None,
                post_title: None,
                published_at: None,
                can_view: true,
                from_zip: None,
            },
        ));
    }
}

/// Every `.tox`/`.toe` under the Patreon download root, as
/// `(creator, path, filename, kind)`. The creator is the first path segment
/// below the root - the layout `download_tox` writes.
fn walk_downloads(download_root: &str) -> Vec<(String, String, String, String)> {
    let root = download_root_path(download_root);
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize, String)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let creator = entry.file_name().to_string_lossy().to_string();
            stack.push((path, 1, creator));
        }
    }
    while let Some((dir, depth, creator)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < MAX_WALK_DEPTH {
                    stack.push((path, depth + 1, creator.clone()));
                }
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext != "tox" && ext != "toe" {
                continue;
            }
            out.push((
                creator.clone(),
                path.to_string_lossy().replace('\\', "/"),
                name,
                ext,
            ));
        }
    }
    out
}

/// The configured download root, or the same Documents default `download_tox`
/// falls back to when Settings leaves it blank.
fn download_root_path(download_root: &str) -> PathBuf {
    let trimmed = download_root.trim();
    if !trimmed.is_empty() {
        return PathBuf::from(trimmed);
    }
    dirs::document_dir()
        .map(|d| d.join("TDXLU").join("Patreon Downloads"))
        .unwrap_or_else(crate::tox_cache::tox_cache_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn campaign_ids_cannot_escape_the_index_folder() {
        assert_eq!(slug("12345"), "12345");
        assert_eq!(slug(""), "unknown");
        assert_eq!(slug("..."), "unknown");
        // Traversal has to come out as one inert segment, whatever it was.
        let s = slug("../../etc/passwd");
        assert!(!s.contains('/') && !s.contains('\\'));
        assert!(!s.starts_with('.'));
        assert_eq!(Path::new(&s).components().count(), 1);
    }

    #[test]
    fn every_term_must_appear_somewhere() {
        let terms = terms_of("  God   RAYS ");
        assert_eq!(terms, vec!["god", "rays"]);
        assert!(matches_all("God_Rays.tox", &terms));
        assert!(matches_all("rays of god", &terms));
        assert!(!matches_all("God_Beams.tox", &terms));
    }

    #[test]
    fn a_filename_hit_outranks_a_title_only_hit() {
        let terms = terms_of("rays");
        assert_eq!(rank("God_Rays.tox", &terms), 2);
        assert_eq!(rank("Scene.tox", &terms), 1);
    }

    fn local(creator: &str, path: &str, name: &str) -> (String, String, String, String) {
        (
            creator.into(),
            path.into(),
            name.into(),
            "tox".into(),
        )
    }

    #[test]
    fn a_file_both_corpora_know_about_is_listed_once() {
        let mut hits: Vec<(u8, IndexHit)> = Vec::new();
        let mut seen = HashSet::new();
        seen.insert("c:/dl/sarv/abc/god_rays.tox".to_string());
        add_local_hits(
            &mut hits,
            &seen,
            vec![
                // Already described by a listing - must not be repeated.
                local("SARV", "C:/dl/SARV/abc/God_Rays.tox", "God_Rays.tox"),
                // Never listed (unzipped, or predates the index) - must appear.
                local("Polyhop", "C:/dl/Polyhop/x/extracted/rays_helper.tox", "rays_helper.tox"),
            ],
            &terms_of("rays"),
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].1.name, "rays_helper.tox");
        assert!(hits[0].1.url.is_none());
        assert_eq!(hits[0].1.campaign_name, "Polyhop");
    }

    #[test]
    fn the_creator_name_is_searchable_alongside_the_filename() {
        let mut hits: Vec<(u8, IndexHit)> = Vec::new();
        add_local_hits(
            &mut hits,
            &HashSet::new(),
            vec![local("Polyhop", "C:/dl/Polyhop/b/TubeTrails.tox", "TubeTrails.tox")],
            &terms_of("polyhop tube"),
        );
        assert_eq!(hits.len(), 1);
        // Matched partly on the creator, so it ranks below a pure filename hit.
        assert_eq!(hits[0].0, 1);
    }

    #[test]
    fn an_empty_query_matches_nothing_rather_than_everything() {
        assert!(terms_of("   ").is_empty());
        assert!(search("   ", "").is_empty());
    }
}
