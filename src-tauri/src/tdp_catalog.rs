//! Package-index catalog for the "From package…" browser.
//!
//! Index-agnostic: works against any Warehouse/PyPI-compatible index (default
//! PyPI). Discovery uses the PEP 691 simple index; details + README come from
//! the `/pypi/{name}/json` metadata API. A configurable name prefix (default
//! `tdp-`) narrows a big shared index; empty lists a small/curated index whole.

use crate::config::ConfigManager;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const USER_AGENT: &str = "TDXLU";
const CACHE_TTL_SECS: u64 = 60 * 60; // 1 hour
const DETAIL_CONCURRENCY_CHUNK: usize = 8;
/// Safety cap: one HTTP call per package for details, so never fetch a whole
/// unfiltered index (an empty prefix on PyPI would be catastrophic).
const MAX_PACKAGES: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpRemotePackage {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub version: String,
    pub tags: Vec<String>,
    pub home_page: String,
    pub project_url: String,
    pub spec: String,
    pub module: String,
    pub yanked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpRemoteCatalog {
    pub source: String,
    pub fetched_at: u64,
    pub packages: Vec<TdpRemotePackage>,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpReadme {
    pub name: String,
    pub markdown: String,
    pub source_url: String,
}

#[derive(Debug, Deserialize)]
struct SimpleIndex {
    projects: Vec<SimpleProject>,
}

#[derive(Debug, Deserialize)]
struct SimpleProject {
    name: String,
}

#[derive(Debug, Deserialize)]
struct PypiProject {
    info: PypiInfo,
}

#[derive(Debug, Deserialize)]
struct PypiInfo {
    name: String,
    version: Option<String>,
    summary: Option<String>,
    keywords: Option<String>,
    description: Option<String>,
    home_page: Option<String>,
    project_url: Option<String>,
    package_url: Option<String>,
    yanked: Option<bool>,
    classifiers: Option<Vec<String>>,
}

pub fn catalog_cache_path() -> PathBuf {
    ConfigManager::config_dir().join("tdp_pypi_catalog_cache.json")
}

/// Normalize an index base URL (trim, drop trailing slash, default to PyPI).
pub fn normalize_index_base(url: &str) -> String {
    let t = url.trim().trim_end_matches('/');
    if t.is_empty() {
        "https://pypi.org".to_string()
    } else {
        t.to_string()
    }
}

fn simple_index_url(base: &str) -> String {
    format!("{base}/simple/")
}
fn project_json_url(base: &str, name: &str) -> String {
    format!("{base}/pypi/{}/json", encode_name(name))
}
fn project_page_url(base: &str, name: &str) -> String {
    format!("{base}/project/{name}/")
}

pub fn fetch_pypi_catalog(
    index_base: String,
    prefix: String,
    force_refresh: bool,
) -> Result<TdpRemoteCatalog, String> {
    crate::proc::off_runtime(move || fetch_pypi_catalog_blocking(&index_base, &prefix, force_refresh))
}

fn fetch_pypi_catalog_blocking(
    index_base: &str,
    prefix: &str,
    force_refresh: bool,
) -> Result<TdpRemoteCatalog, String> {
    let base = normalize_index_base(index_base);
    // Cache key = index + prefix, so changing either refetches.
    let cache_key = format!("{base}|{prefix}");
    if !force_refresh {
        if let Some(cached) = load_cache(&cache_key) {
            return Ok(cached);
        }
    }

    let client = http_client()?;
    let names = list_package_names(&client, &base, prefix)?;
    let mut packages = Vec::with_capacity(names.len());

    for chunk in names.chunks(DETAIL_CONCURRENCY_CHUNK) {
        for name in chunk {
            match fetch_package_info(&client, &base, name) {
                Ok(pkg) => packages.push(pkg),
                Err(e) => {
                    log::warn!("tdp catalog skip {name}: {e}");
                }
            }
        }
    }

    packages.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));

    let catalog = TdpRemoteCatalog {
        source: cache_key,
        fetched_at: now_secs(),
        packages,
        from_cache: false,
    };
    let _ = save_cache(&catalog);
    Ok(catalog)
}

pub fn fetch_pypi_readme(index_base: String, name: String) -> Result<TdpReadme, String> {
    crate::proc::off_runtime(move || fetch_pypi_readme_blocking(&index_base, &name))
}

fn fetch_pypi_readme_blocking(index_base: &str, name: &str) -> Result<TdpReadme, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("package name empty".into());
    }
    let base = normalize_index_base(index_base);
    let client = http_client()?;
    let url = project_json_url(&base, name);
    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("PyPI json: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("PyPI json HTTP {}", resp.status()));
    }
    let project: PypiProject = resp.json().map_err(|e| e.to_string())?;
    let info = project.info;
    let markdown = info.description.unwrap_or_else(|| "_No description on PyPI._".into());
    let source_url = info
        .project_url
        .or(info.package_url)
        .unwrap_or_else(|| project_page_url(&base, &info.name));
    Ok(TdpReadme {
        name: info.name,
        markdown,
        source_url,
    })
}

fn list_package_names(
    client: &reqwest::blocking::Client,
    base: &str,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let resp = client
        .get(simple_index_url(base))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.pypi.simple.v1+json")
        .send()
        .map_err(|e| format!("index /simple/: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("index /simple/ HTTP {}", resp.status()));
    }
    let index: SimpleIndex = resp.json().map_err(|e| {
        format!("index /simple/ JSON parse failed (need a PEP 691 index): {e}")
    })?;

    let mut names: Vec<String> = index
        .projects
        .into_iter()
        .map(|p| p.name)
        .filter(|n| matches_prefix(n, prefix))
        .collect();
    names.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));

    if names.len() > MAX_PACKAGES {
        log::warn!(
            "package index returned {} names for prefix {:?}; capping at {MAX_PACKAGES}. \
             Set a narrower prefix in Settings → Packages.",
            names.len(),
            prefix
        );
        names.truncate(MAX_PACKAGES);
    }
    Ok(names)
}

/// Empty prefix = accept everything (curated index); otherwise a normalized
/// (`_`→`-`, case-insensitive) prefix match.
fn matches_prefix(name: &str, prefix: &str) -> bool {
    let p = prefix.trim();
    if p.is_empty() {
        return true;
    }
    let n = name.to_ascii_lowercase().replace('_', "-");
    let p = p.to_ascii_lowercase().replace('_', "-");
    n.starts_with(&p)
}

fn fetch_package_info(
    client: &reqwest::blocking::Client,
    base: &str,
    name: &str,
) -> Result<TdpRemotePackage, String> {
    let url = project_json_url(base, name);
    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let project: PypiProject = resp.json().map_err(|e| e.to_string())?;
    let info = project.info;
    let mut tags = parse_keywords(info.keywords.as_deref().unwrap_or(""));
    if let Some(classifiers) = &info.classifiers {
        for c in classifiers {
            // Keep short topical classifiers only
            if let Some(rest) = c.strip_prefix("Topic :: ") {
                tags.push(rest.to_string());
            }
        }
    }
    // Always expose the TDP convention tags when present in keywords
    tags.sort();
    tags.dedup();

    let normalized = info.name.clone();
    Ok(TdpRemotePackage {
        id: normalized.to_ascii_lowercase(),
        name: normalized.clone(),
        summary: info.summary.unwrap_or_default(),
        version: info.version.unwrap_or_default(),
        tags,
        home_page: info.home_page.unwrap_or_default(),
        project_url: info
            .project_url
            .or(info.package_url)
            .unwrap_or_else(|| project_page_url(base, &normalized)),
        spec: normalized.clone(),
        module: guess_module(&normalized),
        yanked: info.yanked.unwrap_or(false),
    })
}

fn parse_keywords(raw: &str) -> Vec<String> {
    raw.split(&[',', ';', ' '][..])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn guess_module(package_name: &str) -> String {
    let lower = package_name.to_ascii_lowercase().replace('_', "-");
    // Only return known dotted import paths. Flat name guesses are frequently
    // wrong (tdp-TauCeti → tdpTauCeti.*, not tdptauceti) and poison install.
    if lower == "tdp-tdpbrowser" {
        return "tdptdpbrowser.Browser".into();
    }
    String::new()
}

fn encode_name(name: &str) -> String {
    // PyPI JSON accepts normalized names; keep path-safe
    name.trim().replace(' ', "-")
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_cache(cache_key: &str) -> Option<TdpRemoteCatalog> {
    let text = fs::read_to_string(catalog_cache_path()).ok()?;
    let mut cached: TdpRemoteCatalog = serde_json::from_str(&text).ok()?;
    // Invalidate when the index or prefix changed (also drops old caches).
    if cached.source != cache_key {
        return None;
    }
    let age = now_secs().saturating_sub(cached.fetched_at);
    if age > CACHE_TTL_SECS {
        return None;
    }
    cached.from_cache = true;
    Some(cached)
}

fn save_cache(catalog: &TdpRemoteCatalog) -> Result<(), String> {
    fs::create_dir_all(ConfigManager::config_dir()).map_err(|e| e.to_string())?;
    let mut to_store = catalog.clone();
    to_store.from_cache = false;
    let text = serde_json::to_string_pretty(&to_store).map_err(|e| e.to_string())?;
    fs::write(catalog_cache_path(), text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_filter() {
        // Default tdp- prefix (normalized, case-insensitive).
        assert!(matches_prefix("tdp-tdpbrowser", "tdp-"));
        assert!(matches_prefix("TDP_Foo", "tdp-"));
        assert!(!matches_prefix("requests", "tdp-"));
        assert!(!matches_prefix("my-tdp-tool", "tdp-"));
        // Empty prefix accepts everything (curated index).
        assert!(matches_prefix("requests", ""));
        assert!(matches_prefix("anything", "   "));
        // Custom prefix.
        assert!(matches_prefix("td-widgets", "td-"));
        assert!(!matches_prefix("tdp-x", "td-widgets"));
    }

    #[test]
    fn module_guess() {
        assert_eq!(guess_module("tdp-tdpbrowser"), "tdptdpbrowser.Browser");
        assert_eq!(guess_module("tdp-QrCodeCOMP"), "");
        assert_eq!(guess_module("tdp-TauCeti"), "");
    }
}
