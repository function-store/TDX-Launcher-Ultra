// Shared helpers for the R2 release scripts.
//
// Bucket layout produced by prepare-release / prepare-utility-release:
//
//   app/latest.json                                Tauri updater manifest
//   app/v<ver>/<installer>            (+ .sig)     NSIS .exe, .app.tar.gz, .msi, .dmg
//   utility/latest.json                            {version, notes, pub_date, url, sha256}
//   utility/v<ver>/TDXLauncherUtility.tox
//
// Both scripts stage into a local `dist-release/` tree that mirrors the bucket
// exactly, so publish-r2.mjs is a dumb recursive upload and you can inspect
// precisely what is about to go public before it does.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

export const STAGE_DIR = "dist-release";

/**
 * Load `.env.release` from the repo root into process.env -- the per-machine
 * release secrets (Cloudflare token + account id, optionally the updater key
 * path), so nobody has to export them in every shell. Plain KEY=VALUE lines,
 * `#` comments, optional surrounding quotes. Variables already in the
 * environment WIN, so a one-off override still works. The file is gitignored;
 * `.env.release.example` documents the keys.
 */
export function loadReleaseEnv(file = ".env.release") {
  if (!existsSync(file)) return [];
  const loaded = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

/**
 * Abort with a readable message. These are CLI scripts run by a human mid
 * release — a misconfigured host should read as one line, not a stack trace.
 */
export function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Version from tauri.conf.json — the one the updater actually compares against. */
export function appVersion() {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  if (!conf.version) fail("src-tauri/tauri.conf.json has no version");
  return String(conf.version).trim();
}

/** Version of the companion TOX — moves independently of the app version. */
export function utilityVersion() {
  return readFileSync("utility/UTILITY_VERSION", "utf8").trim();
}

/** Release host, without a trailing slash. Kept in sync by set-release-host.mjs. */
export function releaseBase() {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const endpoint = conf.plugins?.updater?.endpoints?.[0];
  if (!endpoint) fail("no updater endpoint in src-tauri/tauri.conf.json");
  const base = endpoint.replace(/\/app\/latest\.json$/, "");
  if (base === endpoint) {
    fail(`updater endpoint should end with /app/latest.json, got: ${endpoint}`);
  }
  // Case-insensitive: URL normalization lowercases hostnames, so a placeholder
  // round-tripped through set-release-host comes back as `replace-me`.
  if (/replace-me/i.test(base)) {
    fail(
      "Release host is not configured yet.\n" +
        "  Run:  npm run set-release-host https://your-bucket-host\n" +
        "  See:  docs/releases-r2.md",
    );
  }
  return base.replace(/\/+$/, "");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // .app is an opaque macOS package boundary — its contents (e.g. a
      // toeexpand.exe helper under Contents/Resources/) are already shipped
      // inside the sibling .app.tar.gz and must never surface as a top-level
      // release file.
      if (name.toLowerCase().endsWith(".app")) continue;
      walk(p, acc);
    } else acc.push(p);
  }
  return acc;
}

/**
 * Tauri platform keys for `latest.json`. The platform is taken from the CI
 * artifact directory name, never guessed from the filename — Tauri names the
 * macOS updater bundle `<productName>.app.tar.gz` with no architecture in it,
 * so an arm64 and an x64 build are indistinguishable by name.
 */
export const PLATFORM_KEYS = ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"];

/**
 * The platforms a release actually ships. `latest.json` is written only once
 * every one of these has its artifacts in the bucket (see prepare-release's
 * platform.json merge), so listing a platform here that no machine builds
 * would hold every release hostage.
 */
export const SHIPPED_PLATFORMS = ["windows-x86_64", "darwin-aarch64"];

/** The per-platform fragment each machine publishes beside its artifacts. */
export const PLATFORM_FRAGMENT = "platform.json";

/** Written by release-build into artifacts/<platform>/: what the build bundled. */
export const BUNDLE_INFO = "bundle-info.json";

/**
 * Is this a file a human downloads directly (as opposed to a signature, or an
 * intermediate)? The NSIS `.exe` is both this *and* the Windows updater
 * artifact — Tauri v2 reuses the installer rather than zipping it (that is the
 * older "v1Compatible" mode).
 */
export function isInstaller(filename) {
  const n = filename.toLowerCase();
  return (
    n.endsWith(".exe") ||
    n.endsWith(".msi") ||
    n.endsWith(".dmg") ||
    n.endsWith(".appimage") ||
    n.endsWith(".deb") ||
    n.endsWith(".app.tar.gz")
  );
}

/** Content-Type for keys we upload; R2 does not infer one. */
export function contentTypeFor(key) {
  switch (extname(key).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".exe":
    case ".msi":
      return "application/octet-stream";
    case ".gz":
      return "application/gzip";
    case ".dmg":
      return "application/x-apple-diskimage";
    case ".tox":
      return "application/octet-stream";
    case ".sig":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

/**
 * Cache policy. Versioned paths never change, so they can be cached forever;
 * the manifests and the stable app/downloads/ copies (same object overwritten
 * every release, linked to directly from the website) are the opposite —
 * their whole point is that the content behind a fixed URL changes.
 */
export function cacheControlFor(key) {
  // platform.json sits on a versioned path but is re-read by the OTHER
  // machine's prepare step and rewritten by a rebuild, so it must not be
  // cached as immutable.
  return key.endsWith("latest.json") || key.endsWith(`/${PLATFORM_FRAGMENT}`) || key.startsWith("app/downloads/")
    ? "no-cache, must-revalidate"
    : "public, max-age=31536000, immutable";
}
