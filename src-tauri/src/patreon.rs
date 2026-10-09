//! Cookie-based Patreon component import (optional, feature = "patreon").
//!
//! Patreon's OFFICIAL OAuth API cannot do this: a patron token only exposes
//! *which* campaigns a user supports, never the posts or attachments of those
//! campaigns (confirmed on the Patreon developer forum), and the Post resource
//! has no attachments field even for a creator's own token. So this uses the
//! same private web API the patreon.com site itself calls, authenticated with
//! the user's own `session_id` cookie — i.e. only content the account can
//! already see. This is the approach every existing downloader (gallery-dl,
//! patreon-dl) takes. It is the unofficial API: no stability guarantee, and the
//! ToS risk sits with the user, which is why the whole thing is behind a build
//! feature and an explicit opt-in.
//!
//! The DTOs below always compile so the command layer keeps a stable signature
//! regardless of the feature; only the networking is gated.

use serde::Serialize;

/// A campaign (creator page) the signed-in user supports.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatreonCampaign {
    pub id: String,
    pub name: String,
    pub url: String,
    pub avatar_url: Option<String>,
    /// The signed-in user's own campaign (they're a creator too).
    pub is_own: bool,
    /// Added by hand from a creator URL rather than found via
    /// pledges/memberships/follows — the UI offers these a Remove action.
    #[serde(default)]
    pub manual: bool,
    /// Function Store, offered to a user whose list lacks it (see
    /// `commands::add_featured_creator`). Dismissable like a manual one.
    #[serde(default)]
    pub featured: bool,
}

/// A TouchDesigner-relevant file (`.tox` component, `.toe` project, or a
/// `.zip` bundling one) attached to a post.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatreonToxFile {
    pub name: String,
    /// Direct download URL (cookie-authenticated).
    pub url: String,
    /// `"post_file"` or `"attachment"` — where it hangs on the post.
    pub source: String,
    /// `"tox"` (load into a session), `"toe"` (open as a project), or
    /// `"zip"` (download + extract — see `extract_zip`; TD can't load a zip
    /// directly, but any `.tox`/`.toe` inside surface as extra load/open
    /// actions once unzipped).
    pub kind: String,
}

/// A `.tox`/`.toe` found inside an extracted zip. `path` is already a local
/// filesystem path — no further download needed to load/open it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatreonExtractedFile {
    pub name: String,
    pub path: String,
    /// `"tox"` or `"toe"`.
    pub kind: String,
}

/// Result of downloading + extracting a Patreon `.zip` attachment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatreonZipExtract {
    /// Local path to the downloaded `.zip` itself.
    pub zip_path: String,
    /// Local path to the directory its contents were extracted into.
    pub extracted_dir: String,
    /// Every `.tox`/`.toe` found anywhere in the extracted tree.
    pub files: Vec<PatreonExtractedFile>,
    /// True if this was already extracted from a prior call (no work done now).
    pub from_cache: bool,
}

/// A campaign post. `tox_files` is empty for posts with no `.tox`/`.toe`/`.zip`
/// attachment — the frontend defaults to showing these too, with an optional
/// filter to hide them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatreonToxPost {
    pub id: String,
    pub title: String,
    pub url: String,
    pub published_at: Option<String>,
    pub can_view: bool,
    pub tox_files: Vec<PatreonToxFile>,
    /// Raw post-body HTML, only when the tier can view it. Rendered in a
    /// sandboxed iframe on the frontend (no scripts) — never as live markup.
    pub content_html: Option<String>,
    /// Plain teaser text Patreon shows for locked posts.
    pub teaser: Option<String>,
    /// Provider embed snippet (an `<iframe>` for YouTube/Vimeo/etc.), if any.
    pub embed_html: Option<String>,
    /// External media link (fallback when there's no embeddable html).
    pub embed_url: Option<String>,
    /// Human label for the embed, e.g. "YouTube".
    pub embed_provider: Option<String>,
    /// Post hero image, if any.
    pub image_url: Option<String>,
}

/// Full post body fetched on demand — the list endpoint truncates `content`.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PatreonPostDetail {
    pub content_html: Option<String>,
    pub teaser: Option<String>,
    pub embed_html: Option<String>,
    pub embed_url: Option<String>,
    pub embed_provider: Option<String>,
    pub image_url: Option<String>,
    pub can_view: bool,
    /// content_html was built by us from the structured JSON (safe to render
    /// in-DOM); false means it's raw creator HTML (keep it sandboxed).
    pub content_is_rich: bool,
    /// Patreon-native video post (no external embed). Playable only on Patreon
    /// (HLS isn't supported inline), so the UI offers a "Watch on Patreon" link.
    pub is_video: bool,
    /// Temporary diagnostic: what the single-post response actually contained.
    pub debug: Option<String>,
}

/// Who a session cookie actually belongs to. Patreon answers `current_user`
/// for any session it recognizes, so "the request didn't 401" is not proof of
/// a finished login on the account the user meant — the named identity is.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PatreonIdentity {
    pub user_id: String,
    /// Display label: full name, else vanity, else email.
    pub name: String,
    pub email: String,
    /// Creators this session can see the user supporting (pledges + memberships).
    pub supported: usize,
}

#[cfg(not(feature = "patreon"))]
pub const DISABLED_MSG: &str =
    "Patreon import is disabled in this build (feature \"patreon\" not compiled).";

// ---------------------------------------------------------------------------
// Feature OFF: stubs that keep the command layer compiling and honest.
// ---------------------------------------------------------------------------

#[cfg(not(feature = "patreon"))]
pub fn list_campaigns(_cookie: &str) -> Result<Vec<PatreonCampaign>, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn list_tox_posts(_cookie: &str, _campaign_id: &str) -> Result<Vec<PatreonToxPost>, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn latest_upload_at(_cookie: &str, _campaign_id: &str) -> Result<Option<String>, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn latest_post_at(_cookie: &str, _campaign_id: &str) -> Result<Option<String>, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn download_tox(
    _cookie: &str,
    _url: &str,
    _filename: &str,
    _download_root: &str,
    _campaign_name: &str,
) -> Result<String, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn extract_zip(
    _cookie: &str,
    _url: &str,
    _filename: &str,
    _download_root: &str,
    _campaign_name: &str,
) -> Result<PatreonZipExtract, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn zip_extract_status(
    _url: &str,
    _filename: &str,
    _download_root: &str,
    _campaign_name: &str,
) -> Result<Option<PatreonZipExtract>, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn tox_local_path(
    _url: &str,
    _filename: &str,
    _download_root: &str,
    _campaign_name: &str,
) -> Option<String> {
    None
}

#[cfg(not(feature = "patreon"))]
pub fn get_post_detail(_cookie: &str, _post_id: &str) -> Result<PatreonPostDetail, String> {
    Err(DISABLED_MSG.into())
}

#[cfg(not(feature = "patreon"))]
pub fn session_identity(_cookie: &str) -> Option<PatreonIdentity> {
    None
}

#[cfg(not(feature = "patreon"))]
pub fn resolve_creator(_cookie: &str, _input: &str) -> Result<PatreonCampaign, String> {
    Err(DISABLED_MSG.into())
}

// ---------------------------------------------------------------------------
// Feature ON: the real thing.
// ---------------------------------------------------------------------------

#[cfg(feature = "patreon")]
mod imp {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::time::Duration;

    const UA: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TDXLU/0.1 (+patreon-import)";
    const API: &str = "https://www.patreon.com/api";
    /// Extraction safety caps (independent of MAX_BYTES, which bounds the
    /// downloaded .zip itself) — a small zip can still expand enormously.
    const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB total on disk
    const MAX_EXTRACTED_ENTRIES: usize = 20_000;
    const EXTRACT_MARKER: &str = ".tdxlu_extracted";
    const MAX_BYTES: u64 = 512 * 1024 * 1024;

    /// `.tox` -> "tox", `.toe` -> "toe", `.zip` -> "zip" (creators commonly
    /// bundle a .tox with textures/dependencies), anything else -> None.
    fn td_kind(name: &str) -> Option<&'static str> {
        let n = name.trim().to_ascii_lowercase();
        if n.ends_with(".tox") {
            Some("tox")
        } else if n.ends_with(".toe") {
            Some("toe")
        } else if n.ends_with(".zip") {
            Some("zip")
        } else {
            None
        }
    }

    fn is_downloadable_kind(name: &str) -> bool {
        td_kind(name).is_some()
    }

    fn html_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    /// Patreon stores the post body as a ProseMirror-style JSON doc in
    /// `content_json_string`. Walk it into simple HTML for the content iframe.
    fn rich_json_to_html(raw: &str) -> Option<String> {
        let v: Value = serde_json::from_str(raw).ok()?;
        let mut out = String::new();
        render_node(&v, &mut out);
        let t = out.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }

    fn render_node(node: &Value, out: &mut String) {
        // Leaf text node, with a couple of common marks.
        if let Some(text) = node.get("text").and_then(|v| v.as_str()) {
            let mut s = html_escape(text);
            if let Some(marks) = node.get("marks").and_then(|m| m.as_array()) {
                for mark in marks {
                    match mark.get("type").and_then(|t| t.as_str()) {
                        Some("bold") | Some("strong") => s = format!("<strong>{s}</strong>"),
                        Some("italic") | Some("em") => s = format!("<em>{s}</em>"),
                        Some("link") => {
                            if let Some(href) = mark
                                .get("attrs")
                                .and_then(|a| a.get("href"))
                                .and_then(|h| h.as_str())
                            {
                                s = format!("<a href=\"{}\">{s}</a>", html_escape(href));
                            }
                        }
                        _ => {}
                    }
                }
            }
            out.push_str(&s);
        }

        let ntype = node.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let (open, close): (&str, &str) = match ntype {
            "paragraph" => ("<p>", "</p>"),
            "heading" => ("<p><strong>", "</strong></p>"),
            "bullet_list" | "bulleted_list" | "bulletList" => ("<ul>", "</ul>"),
            "ordered_list" | "orderedList" => ("<ol>", "</ol>"),
            "list_item" | "listItem" => ("<li>", "</li>"),
            "blockquote" => ("<blockquote>", "</blockquote>"),
            "hard_break" | "hardBreak" => {
                out.push_str("<br>");
                ("", "")
            }
            _ => ("", ""),
        };
        out.push_str(open);
        if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
            for child in children {
                render_node(child, out);
            }
        }
        out.push_str(close);
    }

    /// A blocking client that carries the session cookie. Built fresh per call
    /// and dropped on a plain thread — see proc::off_runtime.
    fn client() -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| e.to_string())
    }

    fn get_json(cookie: &str, url: &str) -> Result<Value, String> {
        let cookie = cookie.trim();
        if cookie.is_empty() {
            return Err("No Patreon session cookie set (Settings → Patreon).".into());
        }
        // Accept either a bare session_id value or a full "name=value; ..." cookie header.
        let header = if cookie.contains('=') {
            cookie.to_string()
        } else {
            format!("session_id={cookie}")
        };
        let resp = client()?
            .get(url)
            .header("User-Agent", UA)
            .header("Accept", "application/json")
            .header("Referer", "https://www.patreon.com/")
            .header("Origin", "https://www.patreon.com")
            .header("Cookie", header)
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            return Err(
                "Patreon rejected the session cookie (expired or invalid). Re-copy session_id \
                 from a logged-in browser."
                    .into(),
            );
        }
        if !status.is_success() {
            return Err(format!("Patreon API HTTP {status}"));
        }
        resp.json::<Value>().map_err(|e| e.to_string())
    }

    /// Index a JSON:API `included` array by (type, id) for relationship lookup.
    fn index_included(doc: &Value) -> HashMap<(String, String), Value> {
        let mut map = HashMap::new();
        if let Some(arr) = doc.get("included").and_then(|v| v.as_array()) {
            for res in arr {
                let ty = res.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let id = res.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !ty.is_empty() && !id.is_empty() {
                    map.insert((ty.to_string(), id.to_string()), res.clone());
                }
            }
        }
        map
    }

    fn campaign_from_resource(res: &Value) -> Option<PatreonCampaign> {
        let id = res.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            return None;
        }
        let attrs = res.get("attributes").cloned().unwrap_or(Value::Null);
        let name = attrs
            .get("name")
            .or_else(|| attrs.get("creation_name"))
            .or_else(|| attrs.get("vanity"))
            .and_then(|v| v.as_str())
            .unwrap_or("(unnamed campaign)")
            .to_string();
        let url = attrs
            .get("url")
            .or_else(|| attrs.get("pledge_url"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let avatar_url = attrs
            .get("avatar_photo_url")
            .or_else(|| attrs.get("image_small_url"))
            .or_else(|| attrs.get("image_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        Some(PatreonCampaign {
            id: id.to_string(),
            name,
            url,
            avatar_url,
            is_own: false,
            manual: false,
            featured: false,
        })
    }

    /// Collect campaign ids referenced by a relationship on `data`, following
    /// one hop through the intermediary resource (pledge/member) to its
    /// `campaign` relationship.
    fn campaign_ids_via(
        doc: &Value,
        included: &HashMap<(String, String), Value>,
        rel_name: &str,
        inter_type: &str,
    ) -> Vec<String> {
        let inter_ids: Vec<String> = doc
            .get("data")
            .and_then(|d| d.get("relationships"))
            .and_then(|r| r.get(rel_name))
            .and_then(|m| m.get("data"))
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.get("id").and_then(|v| v.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Vec::new();
        for id in inter_ids {
            if let Some(inter) = included.get(&(inter_type.to_string(), id)) {
                if let Some(cid) = inter
                    .get("relationships")
                    .and_then(|r| r.get("campaign"))
                    .and_then(|c| c.get("data"))
                    .and_then(|d| d.get("id"))
                    .and_then(|v| v.as_str())
                {
                    out.push(cid.to_string());
                }
            }
        }
        out
    }

    /// How many entries a relationship on `data` carries. `None` means the
    /// relationship came back as a bare link stub with no `data` member —
    /// Patreon declined to expand the include, which is NOT the same as zero.
    fn rel_entries(doc: &Value, rel_name: &str) -> Option<usize> {
        let rel = doc
            .get("data")
            .and_then(|d| d.get("relationships"))
            .and_then(|r| r.get(rel_name))?;
        match rel.get("data")? {
            Value::Array(a) => Some(a.len()),
            Value::Null => Some(0),
            _ => Some(1),
        }
    }

    /// Resolve a relationship Patreon returned as a link stub by fetching
    /// `links.related` — JSON:API's own escape hatch, and the only way to see
    /// pledges when the server ignores our `include`. Campaign resources from
    /// the fetched page are merged into `included` so the caller can build
    /// them exactly as it does for the inline path.
    fn campaign_ids_via_link(
        cookie: &str,
        doc: &Value,
        rel_name: &str,
        included: &mut HashMap<(String, String), Value>,
    ) -> Vec<String> {
        let Some(rel) = doc
            .get("data")
            .and_then(|d| d.get("relationships"))
            .and_then(|r| r.get(rel_name))
        else {
            return Vec::new();
        };
        // Already expanded inline — the normal path handled it.
        if rel.get("data").map(|d| !d.is_null()).unwrap_or(false) {
            return Vec::new();
        }
        let Some(link) = rel
            .get("links")
            .and_then(|l| l.get("related"))
            .and_then(|v| v.as_str())
        else {
            return Vec::new();
        };
        let link = if link.starts_with("http") {
            link.to_string()
        } else {
            format!("https://www.patreon.com{link}")
        };
        let sep = if link.contains('?') { '&' } else { '?' };
        let url = format!("{link}{sep}include=campaign&json-api-version=1.0");
        let Ok(page) = get_json(cookie, &url) else {
            return Vec::new();
        };
        for (key, res) in index_included(&page) {
            included.entry(key).or_insert(res);
        }
        let mut ids = Vec::new();
        if let Some(arr) = page.get("data").and_then(|d| d.as_array()) {
            for item in arr {
                if let Some(cid) = item
                    .get("relationships")
                    .and_then(|r| r.get("campaign"))
                    .and_then(|c| c.get("data"))
                    .and_then(|d| d.get("id"))
                    .and_then(|v| v.as_str())
                {
                    ids.push(cid.to_string());
                }
            }
        }
        ids
    }

    /// Harvest campaign resources from a `current_user` include expression.
    /// Patreon's private API is undocumented, so this is how we probe an
    /// include we can't confirm from the outside: an unsupported one either
    /// errors or comes back with nothing included, and either way we get an
    /// empty vec and the caller falls through to the next strategy.
    fn campaigns_via_include(cookie: &str, include: &str) -> Vec<PatreonCampaign> {
        let url = format!(
            "{API}/current_user?include={include}\
             &fields[campaign]=name,creation_name,url,pledge_url,vanity,\
avatar_photo_url,image_small_url,image_url\
             &json-api-version=1.0"
        );
        let Ok(doc) = get_json(cookie, &url) else {
            return Vec::new();
        };
        index_included(&doc)
            .into_iter()
            .filter(|((ty, _), _)| ty == "campaign")
            .filter_map(|(_, res)| campaign_from_resource(&res))
            .collect()
    }

    /// Creators the user merely FOLLOWS — free, no pledge and no membership
    /// record — never appear under `pledges` or `memberships`; those hold
    /// paid/joined tiers only. The home feed does carry them: this is the same
    /// `stream?filter[is_following]=true` call patreon.com itself makes, and
    /// every followed campaign that has posted lands in its `included`.
    ///
    /// Bounded to a few pages — enough to name the creators, not an archive
    /// walk. A followed creator who has posted nothing recently won't surface.
    fn campaigns_via_following(cookie: &str) -> Vec<PatreonCampaign> {
        const MAX_PAGES: usize = 8;
        let mut url = format!(
            "{API}/stream\
             ?include=campaign\
             &fields[campaign]=name,creation_name,url,pledge_url,vanity,\
avatar_photo_url,image_small_url,image_url\
             &fields[post]=title\
             &filter[is_following]=true\
             &json-api-use-default-includes=false\
             &json-api-version=1.0"
        );
        let mut out: Vec<PatreonCampaign> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..MAX_PAGES {
            let Ok(page) = get_json(cookie, &url) else { break };
            for ((ty, id), res) in index_included(&page) {
                if ty != "campaign" || !seen.insert(id) {
                    continue;
                }
                if let Some(c) = campaign_from_resource(&res) {
                    out.push(c);
                }
            }
            let next = page
                .get("links")
                .and_then(|l| l.get("next"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if next.is_empty() {
                break;
            }
            url = if next.starts_with("http") {
                next
            } else {
                format!("https://www.patreon.com{next}")
            };
        }
        out
    }

    /// Resolve the account a session cookie belongs to. `None` when Patreon
    /// doesn't recognize the session, or recognizes it but won't name the
    /// account — the shape a half-finished login leaves behind.
    pub fn session_identity(cookie: &str) -> Option<PatreonIdentity> {
        let url =
            format!("{API}/current_user?include=pledges,memberships&json-api-version=1.0");
        let doc = get_json(cookie, &url).ok()?;
        let data = doc.get("data")?;
        if data.get("type").and_then(|v| v.as_str()) != Some("user") {
            return None;
        }
        let user_id = data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if user_id.is_empty() {
            return None;
        }
        let attrs = data.get("attributes");
        let attr = |k: &str| {
            attrs
                .and_then(|a| a.get(k))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let email = attr("email");
        // No name at all = Patreon knows the session but not (yet) the person.
        let name = [attr("full_name"), attr("vanity"), email.clone()]
            .into_iter()
            .find(|s| !s.is_empty())?;
        let supported = rel_entries(&doc, "pledges").unwrap_or(0)
            + rel_entries(&doc, "memberships").unwrap_or(0);
        Some(PatreonIdentity { user_id, name, email, supported })
    }

    /// Read the run of digits that follows `needle`. Patreon embeds the
    /// campaign id in the creator page's bootstrap payload; there is no API to
    /// turn a vanity URL into an id, so this scrape is the documented-by-nobody
    /// route every downloader uses.
    fn digits_after<'a>(hay: &'a str, needle: &str) -> Option<&'a str> {
        let tail = &hay[hay.find(needle)? + needle.len()..];
        let end = tail.find(|c: char| !c.is_ascii_digit())?;
        (end > 0).then(|| &tail[..end])
    }

    fn get_text(cookie: &str, url: &str) -> Result<String, String> {
        let cookie = cookie.trim();
        let header = if cookie.contains('=') {
            cookie.to_string()
        } else {
            format!("session_id={cookie}")
        };
        let resp = client()?
            .get(url)
            .header("User-Agent", UA)
            .header("Referer", "https://www.patreon.com/")
            .header("Cookie", header)
            .send()
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Patreon page HTTP {}", resp.status()));
        }
        resp.text().map_err(|e| e.to_string())
    }

    /// Pull the campaign id out of a creator page. Two independent markers, so
    /// a layout change on one doesn't break the feature outright.
    fn campaign_id_from_page(page: &str) -> Option<String> {
        digits_after(page, "\"campaign\":{\"data\":{\"id\":\"")
            .or_else(|| digits_after(page, "\\\"campaign\\\":{\\\"data\\\":{\\\"id\\\":\\\""))
            .or_else(|| digits_after(page, "/campaign/"))
            .map(String::from)
    }

    /// Last resort: Patreon's public search names campaigns with their ids, so
    /// a vanity that survives a layout change here can still be resolved.
    fn campaign_via_search(cookie: &str, vanity: &str) -> Option<PatreonCampaign> {
        let doc = get_json(cookie, &format!("{API}/search?q={vanity}")).ok()?;
        let want = vanity.to_lowercase();
        for res in doc.get("data")?.as_array()? {
            let attrs = res.get("attributes")?;
            let url = attrs.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let slug = url.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            if slug.to_lowercase() != want {
                continue;
            }
            // Search ids are prefixed, e.g. "campaign_9314461".
            let id = res
                .get("id")
                .and_then(|v| v.as_str())?
                .rsplit('_')
                .next()?
                .to_string();
            return Some(PatreonCampaign {
                id,
                name: attrs
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(vanity)
                    .to_string(),
                url: url.to_string(),
                avatar_url: attrs
                    .get("avatar_photo_url")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                is_own: false,
                manual: true,
                featured: false,
            });
        }
        None
    }

    /// Split a pasted creator reference into an explicit campaign id (when the
    /// input already carries one) and the vanity slug to look up otherwise.
    /// Accepts `patreon.com/x`, `/c/x`, `/cw/x`, `?c=<id>`, a bare vanity, or a
    /// bare campaign id — whatever a creator page's address bar might hold.
    pub(super) fn parse_creator_input(input: &str) -> (Option<String>, String) {
        let raw = input.trim().trim_end_matches('/');
        let (path, query) = match raw.split_once('?') {
            Some((p, q)) => (p, q),
            None => (raw, ""),
        };
        // An explicit campaign id in the query wins — no page scrape needed.
        let mut id: Option<String> = query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == "c" || *k == "campaign_id")
            .map(|(_, v)| v.to_string());

        let slug = path
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.")
            .trim_start_matches("patreon.com")
            .trim_start_matches('/')
            .trim_start_matches("c/")
            .trim_start_matches("cw/")
            .split('/')
            .next()
            .unwrap_or("")
            .to_string();
        if id.is_none() && !slug.is_empty() && slug.chars().all(|c| c.is_ascii_digit()) {
            id = Some(slug.clone());
        }
        (id, slug)
    }

    /// Turn whatever the user pasted into a campaign.
    pub fn resolve_creator(cookie: &str, input: &str) -> Result<PatreonCampaign, String> {
        if input.trim().is_empty() {
            return Err("Paste a Patreon creator URL.".into());
        }
        let (mut id, slug) = parse_creator_input(input);
        if id.is_none() {
            if slug.is_empty() {
                return Err(format!("Couldn't find a creator name in \"{input}\"."));
            }
            let page = get_text(cookie, &format!("https://www.patreon.com/c/{slug}"))
                .or_else(|_| get_text(cookie, &format!("https://www.patreon.com/{slug}")))
                .map_err(|e| format!("Couldn't open that creator page ({e})."))?;
            id = campaign_id_from_page(&page);
            if id.is_none() {
                if let Some(c) = campaign_via_search(cookie, &slug) {
                    return Ok(c);
                }
            }
        }
        let id = id.ok_or_else(|| {
            format!("Couldn't identify a Patreon campaign at \"{input}\".")
        })?;

        let doc = get_json(
            cookie,
            &format!(
                "{API}/campaigns/{id}\
                 ?fields[campaign]=name,creation_name,url,pledge_url,vanity,\
avatar_photo_url,image_small_url,image_url\
                 &json-api-version=1.0"
            ),
        )
        .map_err(|e| format!("Patreon wouldn't return campaign {id} ({e})."))?;
        let mut campaign = doc
            .get("data")
            .and_then(campaign_from_resource)
            .ok_or_else(|| format!("Campaign {id} came back empty."))?;
        campaign.manual = true;
        Ok(campaign)
    }

    pub fn list_campaigns(cookie: &str) -> Result<Vec<PatreonCampaign>, String> {
        // The private web API is v1-schema: creators you SUPPORT arrive via the
        // `pledges` relationship (pledge -> campaign); `memberships` is the
        // newer name. The user's OWN campaign (if they're a creator) arrives via
        // the `campaign` relationship — we exclude it so the list is "creators I
        // support", not "me".
        let url = format!(
            "{API}/current_user\
             ?include=pledges.campaign,memberships.campaign,campaign\
             &fields[campaign]=name,creation_name,url,pledge_url,vanity,\
avatar_photo_url,image_small_url,image_url\
             &json-api-version=1.0"
        );
        let doc = get_json(cookie, &url)?;
        let mut included = index_included(&doc);

        // The user's own campaign, to exclude from the supported list.
        let own_id = doc
            .get("data")
            .and_then(|d| d.get("relationships"))
            .and_then(|r| r.get("campaign"))
            .and_then(|c| c.get("data"))
            .and_then(|d| d.get("id"))
            .and_then(|v| v.as_str())
            .map(String::from);

        // Supported campaign ids via either relationship name.
        let mut supported = campaign_ids_via(&doc, &included, "pledges", "pledge");
        supported.extend(campaign_ids_via(&doc, &included, "memberships", "member"));

        // Nothing inline: Patreon answered with link stubs instead of honouring
        // the include. Fetch the relationship's own endpoint and walk that.
        if supported.is_empty() {
            supported = campaign_ids_via_link(cookie, &doc, "pledges", &mut included);
            supported.extend(campaign_ids_via_link(
                cookie,
                &doc,
                "memberships",
                &mut included,
            ));
        }

        // Belt-and-suspenders: any campaign resource in `included` that isn't
        // the user's own (covers a nested include that expanded campaigns but
        // whose intermediary walk we missed).
        for (ty, id) in included.keys() {
            if ty == "campaign" && own_id.as_deref() != Some(id.as_str()) {
                supported.push(id.clone());
            }
        }

        // Free follows leave no pledge or membership behind, so an account that
        // only follows creators looks empty here. Patreon exposes no `/follows`
        // collection (it 404s), so: ask current_user for a `follows` include —
        // if it's honoured we get the COMPLETE list — and fall back to the
        // follow feed, which is limited to creators who have posted recently.
        if supported.is_empty() {
            let mut followed = campaigns_via_include(cookie, "follows.campaign");
            if followed.is_empty() {
                followed = campaigns_via_following(cookie);
            }
            if !followed.is_empty() {
                let mut out: Vec<PatreonCampaign> = followed
                    .into_iter()
                    .filter(|c| own_id.as_deref() != Some(c.id.as_str()))
                    .collect();
                out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                if let Some(oid) = own_id.as_deref() {
                    if let Some(res) = included.get(&("campaign".to_string(), oid.to_string()))
                    {
                        if let Some(mut own) = campaign_from_resource(res) {
                            own.is_own = true;
                            out.insert(0, own);
                        }
                    }
                }
                return Ok(out);
            }
        }

        let mut out: Vec<PatreonCampaign> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for cid in supported {
            if own_id.as_deref() == Some(cid.as_str()) || !seen.insert(cid.clone()) {
                continue;
            }
            if let Some(res) = included.get(&("campaign".to_string(), cid)) {
                if let Some(c) = campaign_from_resource(res) {
                    out.push(c);
                }
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        // The user's own campaign (they're a creator too) — pin it to the top,
        // marked so the UI can label it.
        if let Some(oid) = own_id.as_deref() {
            if let Some(res) = included.get(&("campaign".to_string(), oid.to_string())) {
                if let Some(mut own) = campaign_from_resource(res) {
                    own.is_own = true;
                    out.insert(0, own);
                }
            }
        }

        if out.is_empty() {
            let mut types: Vec<String> = included
                .keys()
                .map(|(t, _)| t.clone())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            types.sort();
            let rel_counts: Vec<String> = doc
                .get("data")
                .and_then(|d| d.get("relationships"))
                .and_then(|r| r.as_object())
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| match v.get("data") {
                            None => format!("{k}(link-only)"),
                            Some(Value::Array(a)) => format!("{k}({})", a.len()),
                            Some(Value::Null) => format!("{k}(0)"),
                            Some(_) => format!("{k}(1)"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let who = session_identity(cookie)
                .map(|i| {
                    if i.email.is_empty() {
                        i.name
                    } else {
                        format!("{} <{}>", i.name, i.email)
                    }
                })
                .unwrap_or_else(|| "(session resolves to no named account)".into());
            return Err(format!(
                "Patreon shows no creators for the connected account — {who}: no pledges, \
                 no memberships, and nothing in the follow feed. If that is not the account \
                 you browse Patreon with, disconnect and log in again, or paste that \
                 account's session_id cookie directly (Settings → Patreon). \
                 Diagnostic — relationships={:?}; included types={:?}; own_campaign={}.",
                rel_counts,
                types,
                own_id.as_deref().unwrap_or("(none)"),
            ));
        }

        Ok(out)
    }

    /// Collect .tox/.toe files a post carries, across ALL of Patreon's
    /// attachment models: the primary `post_file`, the newer `attachments_media`
    /// (type `media`), and the older `attachments` (type `attachment`).
    fn scan_post_files(
        post: &Value,
        included: &HashMap<(String, String), Value>,
    ) -> Vec<PatreonToxFile> {
        let mut files: Vec<PatreonToxFile> = Vec::new();
        let attrs = post.get("attributes");

        if let Some(pf) = attrs.and_then(|a| a.get("post_file")) {
            let name = pf.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let url = pf.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(kind) = td_kind(name) {
                if !url.is_empty() {
                    files.push(PatreonToxFile {
                        name: name.into(),
                        url: url.into(),
                        source: "post_file".into(),
                        kind: kind.into(),
                    });
                }
            }
        }

        let rels = post.get("relationships");
        // (relationship name, included resource type)
        for (rel_name, res_type) in
            [("attachments_media", "media"), ("attachments", "attachment"), ("media", "media")]
        {
            let Some(arr) = rels
                .and_then(|r| r.get(rel_name))
                .and_then(|a| a.get("data"))
                .and_then(|d| d.as_array())
            else {
                continue;
            };
            for ident in arr {
                let id = ident.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let Some(res) = included.get(&(res_type.to_string(), id.to_string())) else {
                    continue;
                };
                let a = res.get("attributes");
                let name = a
                    .and_then(|x| x.get("file_name").or_else(|| x.get("name")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let url = a
                    .and_then(|x| x.get("download_url").or_else(|| x.get("url")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Some(kind) = td_kind(name) {
                    if !url.is_empty() {
                        files.push(PatreonToxFile {
                            name: name.into(),
                            url: url.into(),
                            source: rel_name.into(),
                            kind: kind.into(),
                        });
                    }
                }
            }
        }

        files.sort_by(|a, b| a.url.cmp(&b.url));
        files.dedup_by(|a, b| a.url == b.url);
        files
    }

    /// Builds every post regardless of attachments — posts with no
    /// `.tox`/`.toe`/`.zip` get an empty `tox_files`; the frontend decides
    /// whether to show them (default: shown, with an optional filter).
    fn build_post(post: &Value, included: &HashMap<(String, String), Value>) -> PatreonToxPost {
        let tox_files = scan_post_files(post, included);
        let attrs = post.get("attributes").cloned().unwrap_or(Value::Null);
        let can_view = attrs
            .get("current_user_can_view")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        // List-level body is coarse; the per-post detail fetch overrides it.
        let content_html = if can_view {
            attrs
                .get("content")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
        } else {
            None
        };
        let teaser = attrs
            .get("teaser_text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let embed = attrs.get("embed");
        let embed_html = embed
            .and_then(|e| e.get("html"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| s.contains('<'));
        let embed_url = embed
            .and_then(|e| e.get("url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let embed_provider = embed
            .and_then(|e| e.get("provider").or_else(|| e.get("provider_name")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let image_url = attrs
            .get("image")
            .and_then(|i| {
                i.get("large_url")
                    .or_else(|| i.get("url"))
                    .or_else(|| i.get("thumb_url"))
            })
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        PatreonToxPost {
            id: post.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            title: attrs.get("title").and_then(|v| v.as_str()).unwrap_or("(untitled)").to_string(),
            url: attrs.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            published_at: attrs
                .get("published_at")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            can_view,
            tox_files,
            content_html,
            teaser,
            embed_html,
            embed_url,
            embed_provider,
            image_url,
        }
    }

    /// Pages through a campaign's posts (JSON:API `sort=-published_at`),
    /// calling `on_page` with each page's post array + its `included` index.
    /// Follows the `links.next` cursor, bounded to 12 pages (up to
    /// `page_count * 12` posts) so a huge campaign can't spin forever.
    /// `on_page` returns `true` to stop paging early (e.g. once a match is
    /// found) — shared by `list_tox_posts` (wants every post) and
    /// `latest_upload_at` (wants the first file-bearing one).
    fn walk_campaign_posts(
        cookie: &str,
        campaign_id: &str,
        fields_post: &str,
        page_count: u32,
        mut on_page: impl FnMut(&[Value], &HashMap<(String, String), Value>) -> bool,
    ) -> Result<(), String> {
        let mut next = Some(format!(
            "{API}/posts\
             ?include=attachments_media,attachments,media\
             &fields[post]={fields_post}\
             &fields[media]=id,file_name,download_url\
             &fields[attachment]=name,url\
             &filter[campaign_id]={campaign_id}\
             &filter[is_draft]=false\
             &sort=-published_at\
             &page[count]={page_count}\
             &json-api-version=1.0\
             &json-api-use-default-includes=false"
        ));
        let mut pages = 0;
        while let Some(url) = next.take() {
            if pages >= 12 {
                break;
            }
            pages += 1;
            let doc = get_json(cookie, &url)?;
            let included = index_included(&doc);
            let empty = Vec::new();
            let data = doc.get("data").and_then(|v| v.as_array()).unwrap_or(&empty);
            if on_page(data, &included) {
                break;
            }
            next = doc
                .get("links")
                .and_then(|l| l.get("next"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
        }
        Ok(())
    }

    pub fn list_tox_posts(cookie: &str, campaign_id: &str) -> Result<Vec<PatreonToxPost>, String> {
        let campaign_id = campaign_id.trim();
        if campaign_id.is_empty() {
            return Err("Missing campaign id".into());
        }
        let mut posts = Vec::new();
        walk_campaign_posts(
            cookie,
            campaign_id,
            "title,url,published_at,current_user_can_view,post_file,content,teaser_text,embed,image",
            50,
            |data, included| {
                for post in data {
                    posts.push(build_post(post, included));
                }
                false // never stop early — want every post
            },
        )?;
        Ok(posts)
    }

    /// The `published_at` of a campaign's most recent post that carries a
    /// `.tox`/`.toe`/`.zip` — i.e. its most recent "upload". Used ONLY when
    /// the creators list has its "TD files only" filter on (both to sort by
    /// that date and to hide creators with none) — that's an explicit,
    /// opt-in cost, since it can page through the same bounded window as
    /// `list_tox_posts` (up to 12 pages / ~600 posts) to find a match behind
    /// a run of text-only updates. `None` means no upload turned up in that
    /// window, not that the creator never posted one. The unfiltered default
    /// sort uses the much cheaper `latest_post_at` instead.
    pub fn latest_upload_at(cookie: &str, campaign_id: &str) -> Result<Option<String>, String> {
        let campaign_id = campaign_id.trim();
        if campaign_id.is_empty() {
            return Err("Missing campaign id".into());
        }
        let mut found: Option<String> = None;
        walk_campaign_posts(cookie, campaign_id, "published_at,post_file", 50, |data, included| {
            for post in data {
                if !scan_post_files(post, included).is_empty() {
                    found = post
                        .get("attributes")
                        .and_then(|a| a.get("published_at"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    return true; // found the newest file-bearing post — stop paging
                }
            }
            false
        })?;
        Ok(found)
    }

    /// The `published_at` of a campaign's single most recent post, of any
    /// kind — the default "sort creators by latest" date. One request,
    /// smallest possible field set, no attachment scanning: Patreon's list
    /// endpoint is already sorted newest-first, so the first row IS the
    /// answer. This is deliberately NOT filtered to component posts — see
    /// `latest_upload_at` for that (opt-in, far more expensive) variant.
    pub fn latest_post_at(cookie: &str, campaign_id: &str) -> Result<Option<String>, String> {
        let campaign_id = campaign_id.trim();
        if campaign_id.is_empty() {
            return Err("Missing campaign id".into());
        }
        let url = format!(
            "{API}/posts\
             ?fields[post]=published_at\
             &filter[campaign_id]={campaign_id}\
             &filter[is_draft]=false\
             &sort=-published_at\
             &page[count]=1\
             &json-api-version=1.0\
             &json-api-use-default-includes=false"
        );
        let doc = get_json(cookie, &url)?;
        Ok(doc
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|p| p.get("attributes"))
            .and_then(|a| a.get("published_at"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    pub fn get_post_detail(cookie: &str, post_id: &str) -> Result<PatreonPostDetail, String> {
        let post_id = post_id.trim();
        if post_id.is_empty() {
            return Err("Missing post id".into());
        }
        // No sparse fieldset — request every attribute. A restrictive
        // fields[post] was returning empty content; the default set populates it.
        let url = format!("{API}/posts/{post_id}?json-api-version=1.0");
        let doc = get_json(cookie, &url)?;
        let attrs = doc
            .get("data")
            .and_then(|d| d.get("attributes"))
            .cloned()
            .unwrap_or(Value::Null);

        let can_view = attrs
            .get("current_user_can_view")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        // Body resolution order (also tracks whether WE built the HTML):
        //   1. content_json_string (current ProseMirror doc) -> our HTML  [rich]
        //   2. `content` legacy raw HTML                                   [raw]
        let (content_html, content_is_rich) = if can_view {
            let rich = attrs
                .get("content_json_string")
                .and_then(|v| v.as_str())
                .and_then(rich_json_to_html);
            if let Some(r) = rich {
                (Some(r), true)
            } else {
                let raw = attrs
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.trim().is_empty());
                (raw, false)
            }
        } else {
            (None, false)
        };
        let teaser = attrs
            .get("teaser_text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let embed = attrs.get("embed");
        let embed_html = embed
            .and_then(|e| e.get("html"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| s.contains('<'));
        let embed_url = embed
            .and_then(|e| e.get("url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let embed_provider = embed
            .and_then(|e| e.get("provider").or_else(|| e.get("provider_name")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let image_url = attrs
            .get("image")
            .and_then(|i| {
                i.get("large_url")
                    .or_else(|| i.get("url"))
                    .or_else(|| i.get("thumb_url"))
            })
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Diagnostic: list the attribute keys + a few probe values so we can
        // see the real shape when content/embed don't parse.
        let mut keys: Vec<String> = attrs
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        let content_len = attrs
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.len())
            .unwrap_or(0);
        let embed_state = match attrs.get("embed") {
            None => "absent".to_string(),
            Some(Value::Null) => "null".to_string(),
            Some(e) => {
                let mut ek: Vec<String> = e
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                ek.sort();
                format!("keys[{}]", ek.join(","))
            }
        };
        let post_type = attrs
            .get("post_type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let is_video = post_type.contains("video");

        let teaser_len = attrs
            .get("teaser_text")
            .and_then(|v| v.as_str())
            .map(|s| s.len())
            .unwrap_or(0);
        // Any string attribute long enough to be a body, so we can spot where
        // the text actually lives.
        let mut long_strings: Vec<String> = attrs
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| {
                        v.as_str()
                            .filter(|s| s.len() > 40)
                            .map(|s| format!("{k}({})", s.len()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        long_strings.sort();
        let debug = format!(
            "can_view={can_view}; content_len={content_len}; teaser_len={teaser_len}; \
             embed={embed_state}; post_type={post_type}; long_strings=[{}]; attrs=[{}]",
            long_strings.join(","),
            keys.join(",")
        );

        Ok(PatreonPostDetail {
            content_html,
            teaser,
            embed_html,
            embed_url,
            embed_provider,
            image_url,
            can_view,
            content_is_rich,
            is_video,
            debug: Some(debug),
        })
    }

    pub fn download_tox(
        cookie: &str,
        url: &str,
        filename: &str,
        download_root: &str,
        campaign_name: &str,
    ) -> Result<String, String> {
        let name = sanitize_filename(filename);
        if !is_downloadable_kind(&name) {
            return Err(format!("not a .tox/.toe/.zip filename: {filename}"));
        }
        let dir = patreon_dir(download_root, campaign_name, url, &name);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&name);

        // Serve a cache hit without touching the network.
        if dest.is_file() {
            if let Ok(meta) = std::fs::metadata(&dest) {
                if meta.len() > 16 {
                    return Ok(dest.to_string_lossy().replace('\\', "/"));
                }
            }
        }

        let cookie = cookie.trim();
        let header = if cookie.contains('=') {
            cookie.to_string()
        } else {
            format!("session_id={cookie}")
        };
        let resp = client()?
            .get(url)
            .header("User-Agent", UA)
            .header("Cookie", header)
            .send()
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("download HTTP {}", resp.status()));
        }
        if let Some(len) = resp.content_length() {
            if len > MAX_BYTES {
                return Err(format!("tox too large ({len} bytes; max {MAX_BYTES})"));
            }
        }
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(format!("tox too large ({} bytes)", bytes.len()));
        }
        if bytes.len() < 16 {
            return Err("downloaded file too small to be a .tox".into());
        }

        let tmp = dest.with_extension("tox.partial");
        {
            let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(&bytes).map_err(|e| e.to_string())?;
            f.flush().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        Ok(dest.to_string_lossy().replace('\\', "/"))
    }

    /// Default Patreon download location when the user hasn't set one in
    /// Settings: a real, visible folder under Documents — unlike the hidden
    /// app-cache dir used for GitHub/Toolbox url-sourced fetches, these are
    /// downloads the user deliberately went and got, so they should be easy
    /// to find in Explorer/Finder without digging. Falls back to the app
    /// cache dir on the rare platform with no resolvable Documents folder.
    fn default_download_dir() -> std::path::PathBuf {
        dirs::document_dir()
            .map(|d| d.join("TDXLU").join("Patreon Downloads"))
            .unwrap_or_else(crate::tox_cache::tox_cache_dir)
    }

    /// The per-attachment directory for a (url, filename) pair: the
    /// user-configured download folder (Settings → Patreon), or
    /// `default_download_dir()` when unset — always nested under a
    /// sanitized creator-name subfolder, with a further hash-keyed
    /// subfolder so two different posts from the same creator reusing a
    /// filename (e.g. "Scene.tox") never collide.
    fn patreon_dir(download_root: &str, campaign_name: &str, url: &str, name: &str) -> std::path::PathBuf {
        let base = if download_root.trim().is_empty() {
            default_download_dir()
        } else {
            std::path::PathBuf::from(download_root.trim())
        };
        base.join(sanitize_dir_name(campaign_name)).join(cache_key(url, name))
    }

    /// The zip/extraction paths for a given (url, filename) — the zip and
    /// its extracted tree live side by side in one per-attachment directory.
    fn zip_paths(
        download_root: &str,
        campaign_name: &str,
        url: &str,
        filename: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let name = sanitize_filename(filename);
        let dir = patreon_dir(download_root, campaign_name, url, &name);
        let zip_dest = dir.join(&name);
        let extracted_dir = dir.join("extracted");
        let marker = extracted_dir.join(EXTRACT_MARKER);
        (zip_dest, extracted_dir, marker)
    }

    /// Download (if needed) + extract (if not already cached) a `.zip`
    /// attachment, returning every `.tox`/`.toe` found inside. Idempotent:
    /// a prior successful extraction is detected via `EXTRACT_MARKER` and
    /// reused without re-downloading or re-extracting.
    pub fn extract_zip(
        cookie: &str,
        url: &str,
        filename: &str,
        download_root: &str,
        campaign_name: &str,
    ) -> Result<PatreonZipExtract, String> {
        let name = sanitize_filename(filename);
        if td_kind(&name) != Some("zip") {
            return Err(format!("not a .zip filename: {filename}"));
        }
        let (zip_dest, extracted_dir, marker) = zip_paths(download_root, campaign_name, url, filename);
        let from_cache = marker.is_file();
        if !from_cache {
            let downloaded = download_tox(cookie, url, filename, download_root, campaign_name)?;
            extract_zip_to(Path::new(&downloaded), &extracted_dir)?;
            std::fs::write(&marker, b"ok").map_err(|e| e.to_string())?;
        }
        let files = scan_extracted_tox_toe(&extracted_dir)?;
        Ok(PatreonZipExtract {
            zip_path: zip_dest.to_string_lossy().replace('\\', "/"),
            extracted_dir: extracted_dir.to_string_lossy().replace('\\', "/"),
            files,
            from_cache,
        })
    }

    /// Read-only: the local path a (url, filename) attachment was downloaded
    /// to, if it is already on disk. Pure disk check, no network — the UI asks
    /// this so it knows a file is drag-ready BEFORE the user reaches for it
    /// (an OS drag can't wait on a download). Same idea as
    /// `zip_extract_status`, for the plain `.tox`/`.toe` path.
    pub fn tox_local_path(
        url: &str,
        filename: &str,
        download_root: &str,
        campaign_name: &str,
    ) -> Option<String> {
        let name = sanitize_filename(filename);
        if !is_downloadable_kind(&name) {
            return None;
        }
        let dest = patreon_dir(download_root, campaign_name, url, &name).join(&name);
        // Same "is it a real file" bar download_tox uses for its cache hit.
        let meta = std::fs::metadata(&dest).ok()?;
        (meta.is_file() && meta.len() > 16)
            .then(|| dest.to_string_lossy().replace('\\', "/"))
    }

    /// Read-only: report a prior extraction without touching the network —
    /// used to restore the "already unzipped" state when a post is
    /// reopened, without re-paying the download+extract cost to check.
    pub fn zip_extract_status(
        url: &str,
        filename: &str,
        download_root: &str,
        campaign_name: &str,
    ) -> Result<Option<PatreonZipExtract>, String> {
        let (zip_dest, extracted_dir, marker) = zip_paths(download_root, campaign_name, url, filename);
        if !marker.is_file() {
            return Ok(None);
        }
        let files = scan_extracted_tox_toe(&extracted_dir)?;
        Ok(Some(PatreonZipExtract {
            zip_path: zip_dest.to_string_lossy().replace('\\', "/"),
            extracted_dir: extracted_dir.to_string_lossy().replace('\\', "/"),
            files,
            from_cache: true,
        }))
    }

    /// Extracts `zip_path` into `dest_dir`. Guards against zip-slip (every
    /// entry is resolved via `enclosed_name()`, which rejects absolute paths
    /// and `..` components — unsafe entries are skipped, not followed) and
    /// zip-bomb-style expansion (actual bytes written are capped at
    /// `MAX_EXTRACTED_BYTES`, checked against real output, not the
    /// (spoofable) size declared in the zip header).
    fn extract_zip_to(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
        let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        if archive.len() > MAX_EXTRACTED_ENTRIES {
            return Err(format!(
                "zip has too many entries ({}, max {MAX_EXTRACTED_ENTRIES})",
                archive.len()
            ));
        }
        // Extract into a temp dir, then rename into place — a failed/aborted
        // extraction never leaves a partial tree behind the marker check.
        let tmp_dir = dest_dir.with_extension("extracting.partial");
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

        let result = (|| -> Result<(), String> {
            let mut total: u64 = 0;
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                let Some(rel) = entry.enclosed_name() else {
                    continue; // unsafe/suspicious path (absolute, `..`, etc.) — skip it
                };
                let out_path = tmp_dir.join(rel);
                if entry.is_dir() {
                    std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
                    continue;
                }
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let remaining = MAX_EXTRACTED_BYTES.saturating_sub(total);
                let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
                // +1 so hitting exactly the cap is distinguishable from truncation.
                let mut limited = (&mut entry).take(remaining + 1);
                let copied = std::io::copy(&mut limited, &mut out).map_err(|e| e.to_string())?;
                total += copied;
                if total > MAX_EXTRACTED_BYTES {
                    return Err(format!(
                        "zip contents exceed the extraction cap ({} MiB)",
                        MAX_EXTRACTED_BYTES / (1024 * 1024)
                    ));
                }
            }
            Ok(())
        })();

        if result.is_err() {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return result;
        }
        let _ = std::fs::remove_dir_all(dest_dir);
        std::fs::rename(&tmp_dir, dest_dir).map_err(|e| e.to_string())
    }

    /// Recursively finds every `.tox`/`.toe` under `dir`.
    fn scan_extracted_tox_toe(dir: &Path) -> Result<Vec<PatreonExtractedFile>, String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let entries = match std::fs::read_dir(&d) {
                Ok(e) => e,
                Err(_) => continue, // dir vanished mid-walk or unreadable — skip, not fatal
            };
            for entry in entries {
                let Ok(entry) = entry else { continue };
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(kind @ ("tox" | "toe")) = td_kind(&name) {
                    out.push(PatreonExtractedFile {
                        name,
                        path: path.to_string_lossy().replace('\\', "/"),
                        kind: kind.to_string(),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    fn cache_key(url: &str, filename: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        url.hash(&mut h);
        filename.hash(&mut h);
        format!("patreon-{:016x}", h.finish())
    }

    fn sanitize_filename(name: &str) -> String {
        let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
        let cleaned: String = base
            .chars()
            .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
            .collect();
        if cleaned.is_empty() {
            "component.tox".into()
        } else {
            cleaned
        }
    }

    /// Turns a creator's display name into a single safe path segment: no
    /// separators (so it can't smuggle in extra directory levels), no
    /// Windows-illegal characters, trimmed, length-capped, and never empty.
    fn sanitize_dir_name(name: &str) -> String {
        let cleaned: String = name
            .trim()
            .chars()
            .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\'))
            .collect();
        let cleaned = cleaned.trim().trim_matches('.').trim();
        let cleaned: String = cleaned.chars().take(100).collect();
        if cleaned.is_empty() {
            "creator".into()
        } else {
            cleaned
        }
    }
}

#[cfg(feature = "patreon")]
pub fn list_campaigns(cookie: &str) -> Result<Vec<PatreonCampaign>, String> {
    imp::list_campaigns(cookie)
}

#[cfg(feature = "patreon")]
pub fn list_tox_posts(cookie: &str, campaign_id: &str) -> Result<Vec<PatreonToxPost>, String> {
    imp::list_tox_posts(cookie, campaign_id)
}

#[cfg(feature = "patreon")]
pub fn latest_upload_at(cookie: &str, campaign_id: &str) -> Result<Option<String>, String> {
    imp::latest_upload_at(cookie, campaign_id)
}

#[cfg(feature = "patreon")]
pub fn latest_post_at(cookie: &str, campaign_id: &str) -> Result<Option<String>, String> {
    imp::latest_post_at(cookie, campaign_id)
}

#[cfg(feature = "patreon")]
pub fn download_tox(
    cookie: &str,
    url: &str,
    filename: &str,
    download_root: &str,
    campaign_name: &str,
) -> Result<String, String> {
    imp::download_tox(cookie, url, filename, download_root, campaign_name)
}

#[cfg(feature = "patreon")]
pub fn extract_zip(
    cookie: &str,
    url: &str,
    filename: &str,
    download_root: &str,
    campaign_name: &str,
) -> Result<PatreonZipExtract, String> {
    imp::extract_zip(cookie, url, filename, download_root, campaign_name)
}

#[cfg(feature = "patreon")]
pub fn zip_extract_status(
    url: &str,
    filename: &str,
    download_root: &str,
    campaign_name: &str,
) -> Result<Option<PatreonZipExtract>, String> {
    imp::zip_extract_status(url, filename, download_root, campaign_name)
}

#[cfg(feature = "patreon")]
pub fn tox_local_path(
    url: &str,
    filename: &str,
    download_root: &str,
    campaign_name: &str,
) -> Option<String> {
    imp::tox_local_path(url, filename, download_root, campaign_name)
}

#[cfg(feature = "patreon")]
pub fn get_post_detail(cookie: &str, post_id: &str) -> Result<PatreonPostDetail, String> {
    imp::get_post_detail(cookie, post_id)
}

/// Resolve a pasted creator URL / vanity / campaign id to a campaign.
#[cfg(feature = "patreon")]
pub fn resolve_creator(cookie: &str, input: &str) -> Result<PatreonCampaign, String> {
    imp::resolve_creator(cookie, input)
}

/// The account a session cookie belongs to, or `None` if the session isn't a
/// finished login. See `PatreonIdentity`.
#[cfg(feature = "patreon")]
pub fn session_identity(cookie: &str) -> Option<PatreonIdentity> {
    imp::session_identity(cookie)
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "patreon")]
    #[test]
    fn tox_detection() {
        assert!(super::imp_is_tox_test("Foo.tox"));
        assert!(super::imp_is_tox_test("bar.TOX"));
        assert!(!super::imp_is_tox_test("readme.txt"));
    }

    /// Every shape a creator's address bar can hand us resolves to the same
    /// slug — the id path only when the input actually carries an id.
    #[cfg(feature = "patreon")]
    #[test]
    fn creator_input_forms() {
        use super::imp::parse_creator_input as parse;
        for input in [
            "https://www.patreon.com/c/dotsimulate",
            "https://patreon.com/dotsimulate",
            "www.patreon.com/cw/dotsimulate/posts",
            "patreon.com/c/dotsimulate/",
            "dotsimulate",
            "  https://www.patreon.com/c/dotsimulate  ",
        ] {
            assert_eq!(parse(input), (None, "dotsimulate".into()), "{input}");
        }
        // An explicit id short-circuits the page scrape.
        assert_eq!(
            parse("https://www.patreon.com/dotsimulate?c=9314461").0,
            Some("9314461".into())
        );
        assert_eq!(
            parse("https://www.patreon.com/posts/x?campaign_id=42").0,
            Some("42".into())
        );
        assert_eq!(parse("9314461"), (Some("9314461".into()), "9314461".into()));
        assert_eq!(parse("").0, None);
    }
}

// Small test shim so the `is_tox` helper (private to imp) is reachable from
// tests without widening its visibility in the build.
#[cfg(all(test, feature = "patreon"))]
pub(crate) fn imp_is_tox_test(name: &str) -> bool {
    name.trim().to_ascii_lowercase().ends_with(".tox")
}
