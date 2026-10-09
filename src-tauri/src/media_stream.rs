//! Custom `media://` URI scheme with HTTP Range support for local video playback.
//!
//! Tauri's built-in `asset` protocol is fine for images, but WebView `<video>`
//! clients rely on Range / 206 Partial Content. Serving through this protocol
//! (via `convertFileSrc(path, "media")`) fixes blank / non-playing MP4 previews.

use http::{header::*, response::Builder as ResponseBuilder, status::StatusCode, Request, Response};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_CHUNK: u64 = 1024 * 1024; // 1 MiB per range response

pub fn handle_request(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match build_response(request) {
        Ok(resp) => resp,
        Err(status) => ResponseBuilder::new()
            .status(status)
            .header(CONTENT_TYPE, "text/plain")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new())),
    }
}

fn build_response(request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, StatusCode> {
    let path = path_from_request(&request).ok_or(StatusCode::BAD_REQUEST)?;
    if !is_allowed_media(&path) {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut file = File::open(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let len = file_len(&mut file).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mime = mime_for_path(&path);

    if let Some(range_header) = request.headers().get(RANGE) {
        let range_str = range_header.to_str().map_err(|_| StatusCode::BAD_REQUEST)?;
        let (start, end) = parse_single_range(range_str, len).ok_or(StatusCode::RANGE_NOT_SATISFIABLE)?;
        let end = start
            .saturating_add(MAX_CHUNK.saturating_sub(1))
            .min(end)
            .min(len.saturating_sub(1));
        if start >= len || end < start {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        let bytes_to_read = end + 1 - start;
        let mut buf = vec![0_u8; bytes_to_read as usize];
        file.seek(SeekFrom::Start(start))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        file.read_exact(&mut buf)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        return ResponseBuilder::new()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(CONTENT_TYPE, mime)
            .header(ACCEPT_RANGES, "bytes")
            .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(CONTENT_LENGTH, bytes_to_read)
            // Preview clips are rewritten in place under a stable path, so a
            // cached response would keep serving the previous recording.
            .header(CACHE_CONTROL, "no-store")
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(buf)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    // No Range header: return the whole file (fine for short preview clips).
    let mut buf = Vec::with_capacity(len as usize);
    file.seek(SeekFrom::Start(0))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    file.read_to_end(&mut buf)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    ResponseBuilder::new()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, len)
        .header(CACHE_CONTROL, "no-store")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(buf)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn path_from_request(request: &Request<Vec<u8>>) -> Option<PathBuf> {
    let raw = request.uri().path();
    let trimmed = raw.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let decoded = percent_decode(trimmed);
    // Windows: URI may be "C:/Users/..." or "C|/Users/..." (some WebViews).
    let normalized = decoded.replace('|', ":").replace('\\', "/");
    Some(PathBuf::from(normalized))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn file_len(file: &mut File) -> std::io::Result<u64> {
    let pos = file.stream_position()?;
    let len = file.seek(SeekFrom::End(0))?;
    file.seek(SeekFrom::Start(pos))?;
    Ok(len)
}

fn parse_single_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let s = header.trim();
    let s = s.strip_prefix("bytes=")?.trim();
    // Only handle a single range (what video elements send).
    let first = s.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;
    if start_s.is_empty() {
        // suffix: bytes=-N
        let n: u64 = end_s.parse().ok()?;
        if n == 0 || len == 0 {
            return None;
        }
        let start = len.saturating_sub(n);
        return Some((start, len - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    let end = if end_s.is_empty() {
        len.saturating_sub(1)
    } else {
        end_s.parse().ok()?
    };
    Some((start, end))
}

/// One HTTP body for a local media file — what the `media://` protocol builds
/// for the desktop WebView, in the shape the control server's tiny_http
/// handler needs (the in-TD palette page renders the SAME files, but it is
/// served over HTTP, so it cannot use a Tauri URI scheme).
pub(crate) struct MediaBody {
    pub status: u16,
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    /// `bytes start-end/total` when this is a 206.
    pub content_range: Option<String>,
}

/// Whether this file is one the browser can render — the gate for minting a
/// preview ticket, so an unsupported type fails at mint time, not at load.
pub(crate) fn is_previewable(path: &Path) -> bool {
    is_allowed_media(path)
}

/// Read (part of) a media file for an HTTP GET. `range` is the raw Range
/// header. Refuses anything outside the extension allow-list — the same list
/// the desktop protocol uses, so a format the browser cannot decode is an
/// honest "no preview" rather than a player that never plays.
pub(crate) fn http_body(path: &Path, range: Option<&str>) -> Result<MediaBody, (u16, String)> {
    if !is_allowed_media(path) {
        return Err((403, "not a previewable media file".into()));
    }
    let mut file = File::open(path).map_err(|e| (404, e.to_string()))?;
    let len = file_len(&mut file).map_err(|e| (500, e.to_string()))?;
    let mime = mime_for_path(path);
    if let Some(raw) = range {
        let (start, end) =
            parse_single_range(raw, len).ok_or((416, "unsatisfiable range".to_string()))?;
        let end = start
            .saturating_add(MAX_CHUNK.saturating_sub(1))
            .min(end)
            .min(len.saturating_sub(1));
        if start >= len || end < start {
            return Err((416, "unsatisfiable range".into()));
        }
        let mut buf = vec![0_u8; (end + 1 - start) as usize];
        file.seek(SeekFrom::Start(start))
            .map_err(|e| (500, e.to_string()))?;
        file.read_exact(&mut buf).map_err(|e| (500, e.to_string()))?;
        return Ok(MediaBody {
            status: 206,
            bytes: buf,
            mime,
            content_range: Some(format!("bytes {start}-{end}/{len}")),
        });
    }
    // No Range: whole file. An <img> asks for exactly this; a <video> asks
    // for a range on the second request, so a huge clip is never read whole
    // here — but cap it anyway, since a page can request any allowed file.
    if len > MAX_WHOLE {
        return Err((413, format!("{len} bytes is too large to send whole")));
    }
    let mut buf = Vec::with_capacity(len as usize);
    file.seek(SeekFrom::Start(0))
        .map_err(|e| (500, e.to_string()))?;
    file.read_to_end(&mut buf).map_err(|e| (500, e.to_string()))?;
    Ok(MediaBody {
        status: 200,
        bytes: buf,
        mime,
        content_range: None,
    })
}

/// Whole-file cap for a range-less GET (see [`http_body`]).
const MAX_WHOLE: u64 = 64 * 1024 * 1024;

fn is_allowed_media(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp4" | "webm" | "mov" | "m4v" | "avi" | "ogg" | "ogv" | "mkv"
            | "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
            // Audio, for previewing a project's sound refs in the media
            // browser. Deliberately only the formats a Chromium WebView
            // actually decodes: aif / aiff are left out even though TD reads
            // them, because serving one would produce a player that silently
            // fails instead of an honest "no preview".
            | "mp3" | "wav" | "m4a" | "flac" | "oga" | "opus" | "aac"
    )
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ogg" | "ogv" => "video/ogg",
        "mkv" => "video/x-matroska",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        // `ogg` stays video/ogg above; `oga` is the audio-only spelling.
        "oga" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Audio previews are only worth serving for what the WebView can play.
    /// aif / aiff are readable by TD but not reliably by Chromium, so they
    /// must stay unsupported here - the media browser then says "no preview"
    /// instead of rendering a player that never sounds.
    #[test]
    fn audio_mime_types_and_aiff_exclusion() {
        assert_eq!(mime_for_path(Path::new("a/loop.mp3")), "audio/mpeg");
        assert_eq!(mime_for_path(Path::new("a/loop.wav")), "audio/wav");
        assert_eq!(mime_for_path(Path::new("a/loop.flac")), "audio/flac");
        assert_eq!(mime_for_path(Path::new("a/loop.oga")), "audio/ogg");
        // `ogg` keeps its existing video mapping; only `oga` is audio-only.
        assert_eq!(mime_for_path(Path::new("a/clip.ogg")), "video/ogg");
        assert_eq!(
            mime_for_path(Path::new("a/loop.aiff")),
            "application/octet-stream"
        );
    }

    #[test]
    fn range_suffix_and_open() {
        assert_eq!(parse_single_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_single_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_single_range("bytes=-50", 1000), Some((950, 999)));
    }

    #[test]
    fn decode_windows_path() {
        let decoded = percent_decode("C%3A/Users/Dan/clip.mp4");
        assert_eq!(decoded, "C:/Users/Dan/clip.mp4");
    }
}
