import { convertFileSrc } from "@tauri-apps/api/core";

/** Normalize Windows paths for Tauri URI schemes. */
export function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * What the WebView can actually decode, by extension.
 *
 * MUST stay in sync with `is_allowed_media` in `src-tauri/src/media_stream.rs`
 * — the Rust side 403s anything outside its list, so a type listed here but
 * not there renders as a broken element rather than an honest "no preview".
 *
 * This is deliberately NARROWER than what TouchDesigner reads. TD decodes tif,
 * exr, dds, hdr, dpx, mxf, r3d and every geometry format; a Chromium WebView
 * decodes none of them. Those refs are listed with a "no preview" note rather
 * than guessed at.
 */
const PREVIEW_IMAGE = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const PREVIEW_VIDEO = new Set([
  "mp4",
  "webm",
  "mov",
  "m4v",
  "avi",
  "ogg",
  "ogv",
  "mkv",
]);
// aif / aiff are absent on purpose: TD reads them, Chromium does not.
const PREVIEW_AUDIO = new Set(["mp3", "wav", "m4a", "flac", "oga", "opus", "aac"]);

export type PreviewKind = "image" | "video" | "audio" | null;

/** How (or whether) this file can be previewed in the WebView. */
export function previewKind(path: string): PreviewKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (PREVIEW_IMAGE.has(ext)) return "image";
  if (PREVIEW_VIDEO.has(ext)) return "video";
  if (PREVIEW_AUDIO.has(ext)) return "audio";
  return null;
}

/**
 * Local file URL for UI.
 * Videos use the custom `media` protocol (Range / 206) — `asset` often fails in WebView `<video>`.
 * Audio goes the same way: `<audio>` seeking needs Range just as `<video>` does.
 */
export function mediaSrc(
  path: string,
  kind: "image" | "video" | "audio" = "image",
  version?: number,
): string {
  const normalized = normalizeFsPath(path);
  const url =
    kind === "video" || kind === "audio"
      ? convertFileSrc(normalized, "media")
      : convertFileSrc(normalized);
  // preview.png / preview.mp4 are rewritten under a stable path, so the URL
  // alone can't tell the WebView the bytes changed. Bump `version` after a
  // capture to force a reload. Both protocols ignore the query string.
  if (version === undefined) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
}
