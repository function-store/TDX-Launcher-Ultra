// Stage a UTILITY TOX release into ./dist-release/ mirroring the R2 bucket.
//
//   node scripts/prepare-utility-release.mjs [--notes <file>]
//
// This channel is deliberately independent of the app: it needs no compiler, no
// signing key and no installer — bump utility/UTILITY_VERSION, run this, upload.
// Launchers already in the field pick the new TOX up on their next check.
//
// Output: dist-release/utility/v<ver>/TDXLauncherUtility.tox
//         dist-release/utility/latest.json

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { utilityVersion, releaseBase, sha256File, STAGE_DIR } from "./release-lib.mjs";

const TOX_NAME = "TDXLauncherUtility.tox";
// Embody's Releaseall exports land in release/ — that export IS the shipped file.
const TOX_SRC = join("release", TOX_NAME);

const args = process.argv.slice(2);
const notesIdx = args.indexOf("--notes");
const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : null;

if (!existsSync(TOX_SRC)) {
  console.error(`prepare-utility-release: ${TOX_SRC} not found`);
  process.exit(1);
}

const version = utilityVersion();
if (!/^\d+(\.\d+)*$/.test(version)) {
  console.error(
    `prepare-utility-release: utility/UTILITY_VERSION is "${version}" — expected a dotted numeric version`,
  );
  process.exit(1);
}

// The version the running utility reports over the TCP bus comes from the
// extension constant, not this file. If they disagree, every launcher decides
// a freshly-installed utility is still out of date and re-offers the update
// forever, so treat a mismatch as a release blocker rather than a warning.
const EXT_SRC = join("utility", "TDXLauncherUtility", "TDXLUUtilityExt.py");
if (existsSync(EXT_SRC)) {
  const ext = readFileSync(EXT_SRC, "utf8");
  const m = ext.match(/^\s*UTILITY_VERSION\s*=\s*['"]([^'"]+)['"]/m);
  if (!m) {
    console.warn(`  ! could not find UTILITY_VERSION in ${EXT_SRC} — skipping the cross-check`);
  } else if (m[1].trim() !== version) {
    console.error(
      `prepare-utility-release: version mismatch\n` +
        `    utility/UTILITY_VERSION            = ${version}\n` +
        `    TDXLUUtilityExt.UTILITY_VERSION = ${m[1].trim()}\n` +
        `  Bump both, re-export the .tox, then release.`,
    );
    process.exit(1);
  }
}

// Third source of truth, and the one the TOOLKIT trusts: FNS_About.Pkgversion.
// FNSTools' packaging contract makes the FNS_About child the version authority
// -- FNS_CommandRegistry reads it (via the owner's mirrored par) to arbitrate
// commands that declare the same canonical id. If it disagrees with the two
// text files, a released companion loses or wins arbitration on a stale number
// while every text file looks correct.
//
// The par is a constant in the utility's .tdn, so it IS checkable from disk,
// unlike the version baked into the .tox. Unlike the cross-check above, a
// PARSE failure here is fatal rather than a warning: a check that silently
// skips when it stops matching is the failure mode this file already has once.
const TDN_SRC = join("utility", "TDXLauncherUtility.tdn");
if (existsSync(TDN_SRC)) {
  const tdn = readFileSync(TDN_SRC, "utf8");
  // Every Pkgversion par in the tree looks alike; the AUTHORITY is the only one
  // whose help says so. Find that block, then its `default:`.
  const blocks = tdn.split(/^\s*-\s/m);
  const authority = blocks.find(
    (b) => /name:\s*Pkgversion/.test(b) && /help:.*Authoritative version of this package/s.test(b),
  );
  if (!authority) {
    console.error(
      [
        "prepare-utility-release: could not find the authoritative FNS_About.Pkgversion",
        `  in ${TDN_SRC}. Either the par is gone or the export format changed;`,
        "  fix the check rather than shipping an unverified version.",
      ].join("\n"),
    );
    process.exit(1);
  }
  const dm = authority.match(/default:\s*'?([0-9][^'\s]*)'?/);
  if (!dm || dm[1].trim() !== version) {
    console.error(
      [
        "prepare-utility-release: version mismatch",
        `    utility/UTILITY_VERSION      = ${version}`,
        `    FNS_About.Pkgversion (.tdn)  = ${dm ? dm[1].trim() : "unreadable"}`,
        "  FNS_About is the authority. Bump it in TouchDesigner, save, re-export.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`  ✓ FNS_About.Pkgversion agrees (${version})`);
}

// The registry files are MIRRORS of FNSTools masters and must never be edited
// here. Run FunctionStore's checker when their repo is beside ours; absence is
// not a failure (the launcher must stay releasable on its own), but drift is.
const MIRROR_CHECK = join("..", "FNSTools_PRIV", "scripts", "check_launcher_mirror.py");
if (existsSync(MIRROR_CHECK)) {
  // macOS ships no bare `python`, only `python3`; a spawn that fails to launch
  // would otherwise read as "drifted" with an empty report.
  const python = process.platform === "win32" ? "python" : "python3";
  const r = spawnSync(python, [MIRROR_CHECK, process.cwd()], { encoding: "utf8" });
  if (r.error) {
    console.error(`prepare-utility-release: could not run ${python} for the mirror check: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(
      [
        "prepare-utility-release: command-registry mirror has drifted",
        (r.stdout || "") + (r.stderr || ""),
        "  Those files are copied FROM FNSTools, never edited here.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`  ✓ ${(r.stdout || "").trim()}`);
} else {
  console.log("  ! FNSTools_PRIV not beside this repo — skipped the registry mirror check");
}

// Both version strings above live in TEXT files. The thing that actually ships
// is the .tox, and the version it reports at runtime is baked into the copy of
// the extension INSIDE it — which only a TouchDesigner re-export updates.
//
// That version cannot be read back here: a .tox is TD's own compressed binary
// container (not a zip), so the string is not recoverable from disk. Git is the
// proxy — if the version files changed more recently than the .tox, the .tox
// predates the bump and would ship reporting the previous version, putting every
// launcher in the re-offer loop described above.
function lastCommitTime(path) {
  const r = spawnSync("git", ["log", "-1", "--format=%ct", "--", path], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const t = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(t) ? t : null;
}
function isDirty(path) {
  const r = spawnSync("git", ["status", "--porcelain", "--", path], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

const skipToxCheck = args.includes("--skip-tox-check");
if (!skipToxCheck && spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).status === 0) {
  const versionFiles = ["utility/UTILITY_VERSION", EXT_SRC.split(/[\\/]/).join("/")];
  const toxPath = TOX_SRC.split(/[\\/]/).join("/");
  const staleReason = (() => {
    // Uncommitted case: version bumped on disk but the .tox untouched.
    if (versionFiles.some(isDirty) && !isDirty(toxPath)) {
      return "the version files have uncommitted changes but the .tox does not";
    }
    // Committed case: version files landed in a later commit than the .tox.
    const toxAt = lastCommitTime(toxPath);
    const versionAt = Math.max(...versionFiles.map((f) => lastCommitTime(f) ?? 0));
    if (toxAt !== null && versionAt > toxAt) {
      return "the version files were committed more recently than the .tox";
    }
    return null;
  })();

  if (staleReason) {
    console.error(
      `prepare-utility-release: the .tox looks stale for v${version} —\n` +
        `  ${staleReason}.\n\n` +
        `  The version a running utility reports is baked into the .tox and only\n` +
        `  changes when you re-export it from TouchDesigner. Releasing as-is would\n` +
        `  ship a .tox reporting the OLD version, so every launcher would install\n` +
        `  it and immediately re-offer the same update, forever.\n\n` +
        `  Fix: open the project in TD, re-export ${TOX_NAME}, then re-run.\n` +
        `  Override (you are certain the .tox is current): --skip-tox-check`,
    );
    process.exit(1);
  }
}

const base = releaseBase();
const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";

const outDir = join(STAGE_DIR, "utility", `v${version}`);
mkdirSync(outDir, { recursive: true });
copyFileSync(TOX_SRC, join(outDir, TOX_NAME));

const sha256 = sha256File(TOX_SRC);
const size = statSync(TOX_SRC).size;

// Consumed by src-tauri/src/updates.rs::UtilityManifest. The launcher enforces
// this digest against the bytes it downloads and refuses a mismatch.
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  url: `${base}/utility/v${version}/${TOX_NAME}`,
  sha256,
};
writeFileSync(
  join(STAGE_DIR, "utility", "latest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`  + utility/v${version}/${TOX_NAME} (${size} bytes)`);
console.log(`  + utility/latest.json  sha256=${sha256}`);
console.log(`prepare-utility-release: utility v${version} staged in ${STAGE_DIR}/`);
