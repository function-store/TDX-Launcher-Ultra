//! Download .tox files into `%APPDATA%/TDXLU/tox_cache` (or XDG config on Unix).
//!
//! Accepts:
//! - Direct `.tox` URL (any host)
//! - GitHub release asset URL (`.../releases/download/.../Foo.tox`)
//! - `owner/repo` or `https://github.com/owner/repo` -> latest release `*.tox`
//! - Optional `#AssetName.tox` to pick among multiple assets

use crate::config::ConfigManager;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const USER_AGENT: &str = "TDXLU";
const MAX_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB safety cap

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToxCacheResult {
    pub path: String,
    pub source: String,
    pub filename: String,
    pub from_cache: bool,
    pub resolved_url: String,
}

#[derive(Debug, Clone)]
struct ResolvedDownload {
    /// Public browser URL (or direct URL).
    url: String,
    filename: String,
    cache_key: String,
    /// When set, prefer GitHub releases/assets API (private + reliable).
    github: Option<GithubAssetRef>,
}

#[derive(Debug, Clone)]
struct GithubAssetRef {
    owner: String,
    repo: String,
    asset_id: u64,
}

pub fn tox_cache_dir() -> PathBuf {
    ConfigManager::config_dir().join("tox_cache")
}

pub fn cache_tox_from_source(
    source: &str,
    github_token: Option<&str>,
) -> Result<ToxCacheResult, String> {
    // Blocking HTTP must not run on the async runtime — see proc::off_runtime.
    crate::proc::off_runtime(move || cache_tox_from_source_blocking(source, github_token))
}

fn cache_tox_from_source_blocking(
    source: &str,
    github_token: Option<&str>,
) -> Result<ToxCacheResult, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("source is empty".into());
    }
    let resolved = resolve_source(source, github_token)?;
    ensure_cache_dir()?;

    let dest = tox_cache_dir()
        .join(&resolved.cache_key)
        .join(&resolved.filename);
    if dest.is_file() {
        let meta = fs::metadata(&dest).map_err(|e| e.to_string())?;
        if meta.len() > 0 {
            return Ok(ToxCacheResult {
                path: dest.to_string_lossy().replace('\\', "/"),
                source: source.to_string(),
                filename: resolved.filename,
                from_cache: true,
                resolved_url: resolved.url,
            });
        }
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    download_to_file(&resolved, github_token, &dest)?;

    Ok(ToxCacheResult {
        path: dest.to_string_lossy().replace('\\', "/"),
        source: source.to_string(),
        filename: resolved.filename.clone(),
        from_cache: false,
        resolved_url: resolved.url,
    })
}

fn ensure_cache_dir() -> Result<(), String> {
    fs::create_dir_all(tox_cache_dir()).map_err(|e| e.to_string())
}

fn resolve_source(source: &str, token: Option<&str>) -> Result<ResolvedDownload, String> {
    let (base, asset_hint) = split_asset_hint(source);

    if looks_like_direct_tox_url(base) {
        let filename = filename_from_url(base)?;
        let key = cache_key_for(base, &filename);
        return Ok(ResolvedDownload {
            url: base.to_string(),
            filename,
            cache_key: key,
            github: None,
        });
    }

    if let Some((owner, repo)) = parse_github_repo(base) {
        return resolve_github_latest(&owner, &repo, asset_hint.as_deref(), token);
    }

    Err(format!(
        "unsupported source (want .tox URL or GitHub owner/repo): {source}"
    ))
}

fn split_asset_hint(source: &str) -> (&str, Option<String>) {
    if let Some((left, right)) = source.split_once('#') {
        let hint = right.trim();
        if !hint.is_empty() {
            return (left.trim(), Some(hint.to_string()));
        }
        return (left.trim(), None);
    }
    (source.trim(), None)
}

fn looks_like_direct_tox_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && lower.split('?').next().unwrap_or("").ends_with(".tox")
}

fn filename_from_url(url: &str) -> Result<String, String> {
    let path = url.split('?').next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or("").trim();
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".tox") {
        return Err(format!("URL does not end with .tox: {url}"));
    }
    Ok(sanitize_filename(name))
}

fn sanitize_filename(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out = "download.tox".into();
    }
    if !out.to_ascii_lowercase().ends_with(".tox") {
        out.push_str(".tox");
    }
    out
}

fn cache_key_for(url: &str, filename: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    url.hash(&mut h);
    filename.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn parse_github_repo(s: &str) -> Option<(String, String)> {
    let s = s.trim().trim_end_matches('/');
    let lower = s.to_ascii_lowercase();

    let rest = if lower.starts_with("https://github.com/") {
        &s["https://github.com/".len()..]
    } else if lower.starts_with("http://github.com/") {
        &s["http://github.com/".len()..]
    } else if lower.starts_with("github.com/") {
        &s["github.com/".len()..]
    } else if !s.contains("://") && s.matches('/').count() == 1 {
        s
    } else {
        return None;
    };

    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches(".git").to_string();
    if let Some(n) = parts.next() {
        let n_l = n.to_ascii_lowercase();
        // Allow .../releases[/latest|/tag/...]
        if n_l != "releases" {
            return None;
        }
    }
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

#[derive(Debug, serde::Deserialize)]
struct GhRelease {
    tag_name: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, serde::Deserialize)]
struct GhAsset {
    id: u64,
    name: String,
    browser_download_url: String,
}

fn resolve_github_latest(
    owner: &str,
    repo: &str,
    asset_hint: Option<&str>,
    token: Option<&str>,
) -> Result<ResolvedDownload, String> {
    let client = http_client()?;
    let api = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let mut req = client
        .get(&api)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json");
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    let resp = req.send().map_err(|e| format!("GitHub API: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err(format!(
            "no latest release for {owner}/{repo} (404) - publish a release with a .tox asset"
        ));
    }
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!(
            "GitHub API HTTP {status} for {owner}/{repo}: {}",
            truncate(&body, 200)
        ));
    }
    let release: GhRelease = resp.json().map_err(|e| e.to_string())?;
    let tox_assets: Vec<&GhAsset> = release
        .assets
        .iter()
        .filter(|a| a.name.to_ascii_lowercase().ends_with(".tox"))
        .collect();
    if tox_assets.is_empty() {
        return Err(format!(
            "latest release of {owner}/{repo} has no .tox assets"
        ));
    }

    let chosen = if let Some(hint) = asset_hint {
        tox_assets
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(hint))
            .copied()
            .ok_or_else(|| {
                let names: Vec<&str> = tox_assets.iter().map(|a| a.name.as_str()).collect();
                format!(
                    "asset `{hint}` not in latest release; available: {}",
                    names.join(", ")
                )
            })?
    } else if tox_assets.len() == 1 {
        tox_assets[0]
    } else {
        tox_assets
            .iter()
            .find(|a| {
                let stem = a
                    .name
                    .trim_end_matches(".tox")
                    .trim_end_matches(".TOX");
                stem.eq_ignore_ascii_case(repo)
            })
            .copied()
            .unwrap_or(tox_assets[0])
    };

    let filename = sanitize_filename(&chosen.name);
    let tag = release.tag_name.as_deref().unwrap_or("latest");
    let key = cache_key_for(
        &format!("github:{owner}/{repo}@{tag}/{}", chosen.name),
        &filename,
    );

    Ok(ResolvedDownload {
        url: chosen.browser_download_url.clone(),
        filename,
        cache_key: key,
        github: Some(GithubAssetRef {
            owner: owner.to_string(),
            repo: repo.to_string(),
            asset_id: chosen.id,
        }),
    })
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

fn download_to_file(
    resolved: &ResolvedDownload,
    token: Option<&str>,
    dest: &Path,
) -> Result<(), String> {
    let tmp = dest.with_extension("tox.partial");
    let _ = fs::remove_file(&tmp);

    let resp = download_response(resolved, token)?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!(
            "download HTTP {status}: {}",
            truncate(&body, 240)
        ));
    }

    let len = resp.content_length().unwrap_or(0);
    if len > MAX_BYTES {
        return Err(format!("tox too large ({len} bytes; max {MAX_BYTES})"));
    }

    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!(
            "tox too large ({} bytes; max {MAX_BYTES})",
            bytes.len()
        ));
    }
    if bytes.len() < 16 {
        return Err("downloaded file too small to be a .tox".into());
    }

    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

fn download_response(
    resolved: &ResolvedDownload,
    token: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    let client = http_client()?;
    let token = token.filter(|t| !t.is_empty());

    if let Some(gh) = &resolved.github {
        if let Some(t) = token {
            let api = format!(
                "https://api.github.com/repos/{}/{}/releases/assets/{}",
                gh.owner, gh.repo, gh.asset_id
            );
            let resp = client
                .get(&api)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/octet-stream")
                .bearer_auth(t)
                .send()
                .map_err(|e| format!("download: {e}"))?;
            if resp.status().is_success() {
                return Ok(resp);
            }
            // Fall through to browser URL
        }
    }

    let mut req = client
        .get(&resolved.url)
        .header("User-Agent", USER_AGENT);
    if let Some(t) = token {
        req = req
            .header("Accept", "application/octet-stream")
            .bearer_auth(t);
    }
    req.send().map_err(|e| format!("download: {e}"))
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim().replace('\n', " ");
    if t.len() <= max {
        t
    } else {
        format!("{}...", &t[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_owner_repo() {
        assert_eq!(
            parse_github_repo("PlusPlusOneGmbH/tdp-tdpbrowser"),
            Some(("PlusPlusOneGmbH".into(), "tdp-tdpbrowser".into()))
        );
        assert_eq!(
            parse_github_repo("https://github.com/foo/bar"),
            Some(("foo".into(), "bar".into()))
        );
        assert_eq!(
            parse_github_repo("https://github.com/foo/bar/releases/latest"),
            Some(("foo".into(), "bar".into()))
        );
    }

    #[test]
    fn direct_tox_url() {
        assert!(looks_like_direct_tox_url(
            "https://github.com/o/r/releases/download/v1/Foo.tox"
        ));
        assert!(!looks_like_direct_tox_url("https://github.com/o/r"));
    }

    /// Any host serving a .tox counts — object storage, a CDN, a plain web
    /// server. Nothing here is GitHub-specific.
    #[test]
    fn direct_tox_url_from_any_host() {
        for url in [
            "https://pub-6d70b11fbdda47e1bbbb33f079ca8a7d.r2.dev/TDMap.tox",
            "https://bucket.s3.amazonaws.com/nested/path/Thing.TOX",
            "http://192.168.1.10:8080/share/Rig.tox",
            // presigned / cache-busted: query string must not defeat the check
            "https://pub-abc.r2.dev/TDMap.tox?X-Amz-Signature=deadbeef&v=2",
        ] {
            assert!(looks_like_direct_tox_url(url), "should accept {url}");
            let name = filename_from_url(url).expect("filename");
            assert!(name.to_ascii_lowercase().ends_with(".tox"), "{url} -> {name}");
        }
    }

    /// Two different buckets serving the same filename must not collide.
    #[test]
    fn same_filename_different_hosts_get_distinct_cache_keys() {
        let a = resolve_source("https://pub-aaa.r2.dev/TDMap.tox", None).expect("a");
        let b = resolve_source("https://pub-bbb.r2.dev/TDMap.tox", None).expect("b");
        assert_eq!(a.filename, "TDMap.tox");
        assert_eq!(b.filename, "TDMap.tox");
        assert_ne!(a.cache_key, b.cache_key);
    }

    #[test]
    fn asset_hint_split() {
        let (b, h) = split_asset_hint("owner/repo#Thing.tox");
        assert_eq!(b, "owner/repo");
        assert_eq!(h.as_deref(), Some("Thing.tox"));
    }

    /// Exercises the generic downloader against a real host. The URL is the
    /// predecessor project's public release asset, kept deliberately: it is a
    /// stable third-party fixture, NOT this app's utility channel (which lives
    /// in updates.rs and is served from R2). Not a rename leftover.
    #[test]
    #[ignore = "network"]
    fn smoke_download_direct_tox() {
        let url = "https://github.com/function-store/TD-Launcher-Plus/releases/latest/download/TDLauncherPlusUtility.tox";
        let r = cache_tox_from_source(url, None).expect("cache");
        assert!(Path::new(&r.path).is_file(), "{}", r.path);
        assert!(r.filename.to_ascii_lowercase().ends_with(".tox"));
        let r2 = cache_tox_from_source(url, None).expect("cache2");
        assert!(r2.from_cache);
    }
}
