// Stage an APP release into ./dist-release/ mirroring the R2 bucket layout.
//
//   node scripts/prepare-release.mjs <artifacts-dir> [--notes <file>]
//
// <artifacts-dir> holds one subdirectory per build, named for its Tauri
// platform key — that is what the release workflow's download-artifact step
// produces:
//
//   artifacts/windows-x86_64/...  (TDX Launcher Ultra_0.3.0_x64-setup.exe + .sig, .msi)
//   artifacts/darwin-aarch64/...  (TDX Launcher Ultra.app.tar.gz + .sig, .dmg)
//
// Within a platform directory the updater artifact is identified by having a
// sibling `.sig` — no filename patterns to keep in step with Tauri's naming.
// Everything else that is an installer is uploaded as a plain human download.
//
// Output: dist-release/app/v<ver>/<platform>/<files> (+ platform.json) and,
// once every shipped platform is accounted for, dist-release/app/latest.json.
// Nothing is uploaded here; run publish-r2.mjs for that.
//
// Two machines, no file shuffling. Each machine stages and publishes only its
// OWN platform, plus a small platform.json fragment (signature + url) beside
// the artifacts. Before writing latest.json this script fetches the fragment
// of every other shipped platform from the bucket; a platform still missing
// means the manifest is NOT written and the publish only lands artifacts.
// Whichever machine runs second finds the other's fragment, writes the merged
// manifest and flips the release live. Re-running on either machine is
// idempotent. CI (both platforms in one artifacts dir) needs no fetch at all.
//
//   --platforms a,b   the platforms this release must have before latest.json
//                     is written (default: every SHIPPED_PLATFORMS entry). Use
//                     it for a deliberate single-platform release.

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  appVersion,
  releaseBase,
  sha256File,
  utilityVersion,
  walk,
  isInstaller,
  PLATFORM_KEYS,
  SHIPPED_PLATFORMS,
  PLATFORM_FRAGMENT,
  BUNDLE_INFO,
  STAGE_DIR,
} from "./release-lib.mjs";

const args = process.argv.slice(2);
const artifactsDir = args.find((a) => !a.startsWith("--")) ?? "artifacts";
const notesIdx = args.indexOf("--notes");
const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : null;
const platformsIdx = args.indexOf("--platforms");
const requiredPlatforms = platformsIdx >= 0 ? args[platformsIdx + 1].split(",").map((s) => s.trim()) : SHIPPED_PLATFORMS;
for (const p of requiredPlatforms) {
  if (!PLATFORM_KEYS.includes(p)) {
    console.error(`prepare-release: --platforms names "${p}", not a known platform key (${PLATFORM_KEYS.join(", ")})`);
    process.exit(1);
  }
}

if (!existsSync(artifactsDir)) {
  console.error(`prepare-release: no such directory: ${artifactsDir}`);
  process.exit(1);
}

const version = appVersion();
const base = releaseBase();

// Stage from scratch: whatever an earlier run left here (another platform
// copied over by hand, a previous version, a manifest that is no longer
// complete) would otherwise be re-uploaded as if it were this release.
rmSync(join(STAGE_DIR, "app"), { recursive: true, force: true });
// The notes file goes into latest.json verbatim and the app shows it to every
// user in the update dialog, so an HTML comment is the only way to leave a note
// for whoever edits it next without shipping that note to the field.
const rawNotes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "";
const notes = rawNotes.replace(/<!--[\s\S]*?-->/g, "").trim();

// website/index.html links its download buttons directly at these fixed,
// overwritten-every-release keys rather than the versioned paths below —
// same "stable pointer" idea as latest.json, mirroring how
// tdmap.functionstore.xyz links straight to an overwritten R2 object. Only
// Windows + Apple Silicon macOS get a website download link.
const STABLE_DOWNLOADS = {
  "windows-x86_64": { match: (f) => f.toLowerCase().endsWith(".exe"), name: "TDX Launcher Ultra Setup.exe" },
  "darwin-aarch64": { match: (f) => f.toLowerCase().endsWith(".dmg"), name: "TDX Launcher Ultra.dmg" },
};

const platforms = {};
// platform key -> {sha256, version} of the companion TOX that build bundles
// (from release-build's bundle-info.json; absent for builds made another way).
const bundledUtility = {};
const ignoreUtilityMismatch = args.includes("--ignore-utility-mismatch");
const stagedKeys = new Set();
let staged = 0;

for (const entry of readdirSync(artifactsDir)) {
  const dir = join(artifactsDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  if (!PLATFORM_KEYS.includes(entry)) {
    console.warn(`  ! skipping ${entry}/ — not a known platform key`);
    continue;
  }

  const files = walk(dir);
  const sigs = files.filter((f) => f.toLowerCase().endsWith(".sig"));
  if (sigs.length === 0) {
    console.error(
      `prepare-release: ${entry}/ has no .sig — was the build run without ` +
        `TAURI_SIGNING_PRIVATE_KEY, or with createUpdaterArtifacts disabled?`,
    );
    process.exit(1);
  }
  // Windows with bundle.targets:"all" builds both NSIS (.exe) and MSI (.msi)
  // installers, and createUpdaterArtifacts signs both — but NSIS is the one
  // updater artifact (it reuses the installer rather than zipping it), so
  // prefer it when more than one .sig shows up. The .msi still ships as a
  // plain download via isInstaller() below, just not as the updater target.
  let sigPath = sigs[0];
  if (sigs.length > 1) {
    const nsisSig = sigs.find((s) => s.toLowerCase().endsWith(".exe.sig"));
    if (!nsisSig) {
      console.error(
        `prepare-release: ${entry}/ has ${sigs.length} .sig files and none is the ` +
          `expected NSIS .exe.sig:\n` + sigs.map((s) => `    ${basename(s)}`).join("\n"),
      );
      process.exit(1);
    }
    sigPath = nsisSig;
  }
  const updaterPath = sigPath.replace(/\.sig$/i, "");
  if (!existsSync(updaterPath)) {
    console.error(`prepare-release: ${basename(sigPath)} has no matching artifact`);
    process.exit(1);
  }

  // Artifacts are namespaced by platform, never flat under the version. Tauri
  // names BOTH macOS updater bundles `<productName>.app.tar.gz`, so a flat
  // layout has the arm64 and x64 builds overwrite each other and both platform
  // entries resolve to one file — an architecture would then download a bundle
  // signed for the other and fail verification.
  const outDir = join(STAGE_DIR, "app", `v${version}`, entry);
  mkdirSync(outDir, { recursive: true });

  const toCopy = new Set([updaterPath, ...files.filter((f) => isInstaller(basename(f)))]);
  for (const src of toCopy) {
    const key = `app/v${version}/${entry}/${basename(src)}`;
    if (stagedKeys.has(key)) {
      console.error(`prepare-release: two artifacts collide on ${key}`);
      process.exit(1);
    }
    stagedKeys.add(key);
    copyFileSync(src, join(outDir, basename(src)));
    console.log(`  + ${key}`);
    staged++;
  }

  platforms[entry] = {
    signature: readFileSync(sigPath, "utf8").trim(),
    url: `${base}/app/v${version}/${entry}/${encodeURIComponent(basename(updaterPath))}`,
  };

  // The fragment the OTHER machine merges from. Same shape as the manifest's
  // platform entry, plus the version so a stale fragment from an earlier
  // release at the same path can never be mistaken for this one.
  const infoPath = join(dir, BUNDLE_INFO);
  if (existsSync(infoPath)) {
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    if (info.version !== version) {
      console.error(`prepare-release: ${entry}/${BUNDLE_INFO} is from a v${info.version} build, not v${version} -- rebuild`);
      process.exit(1);
    }
    bundledUtility[entry] = info.bundled_utility;
  } else {
    console.warn(`  ! ${entry}: no ${BUNDLE_INFO} (not built by release-build) -- bundled utility unknown`);
  }
  const fragment = {
    version,
    platform: entry,
    ...platforms[entry],
    bundled_utility: bundledUtility[entry] ?? null,
    staged_at: new Date().toISOString(),
  };
  writeFileSync(join(outDir, PLATFORM_FRAGMENT), JSON.stringify(fragment, null, 2) + "\n");
  console.log(`  + app/v${version}/${entry}/${PLATFORM_FRAGMENT}`);

  const stable = STABLE_DOWNLOADS[entry];
  if (stable) {
    const stableSrc = [...toCopy].find((f) => stable.match(basename(f)));
    if (!stableSrc) {
      console.error(`prepare-release: ${entry}/ has no file matching the stable-download pattern for ${stable.name}`);
      process.exit(1);
    }
    const dlDir = join(STAGE_DIR, "app", "downloads");
    mkdirSync(dlDir, { recursive: true });
    copyFileSync(stableSrc, join(dlDir, stable.name));
    console.log(`  + app/downloads/${stable.name} (stable)`);
    staged++;
  }
}

if (Object.keys(platforms).length === 0) {
  console.error(`prepare-release: no platform directories found under ${artifactsDir}/`);
  process.exit(1);
}

// Platforms built on another machine: their fragments are already in the
// bucket if that machine has run its publish. Fetched from the public host,
// exactly the way a client would read the manifest, so "present" here means
// "reachable by an updater".
const missing = [];
for (const key of requiredPlatforms) {
  if (platforms[key]) continue;
  const url = `${base}/app/v${version}/${key}/${PLATFORM_FRAGMENT}?t=${Date.now()}`;
  let fragment = null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) fragment = await res.json();
    else if (res.status !== 404) console.warn(`  ! ${key}: fragment fetch returned HTTP ${res.status}`);
  } catch (e) {
    console.warn(`  ! ${key}: fragment fetch failed: ${e.message}`);
  }
  if (fragment && fragment.version === version && fragment.signature && fragment.url) {
    platforms[key] = { signature: fragment.signature, url: fragment.url };
    if (fragment.bundled_utility) bundledUtility[key] = fragment.bundled_utility;
    console.log(`  = ${key}: already in the bucket (published ${fragment.staged_at ?? "earlier"})`);
  } else {
    missing.push(key);
  }
}

if (missing.length > 0) {
  console.log(
    `prepare-release: app v${version} staged in ${STAGE_DIR}/ ` +
      `(${staged} file(s), platforms: ${Object.keys(platforms).join(", ")})\n` +
      `  latest.json NOT written -- still waiting for: ${missing.join(", ")}.\n` +
      `  Publishing now uploads this platform's artifacts only. Run the same\n` +
      `  release on the ${missing.join(" / ")} machine and its publish will flip the\n` +
      `  release live with every platform. (Deliberately shipping without it:\n` +
      `  --platforms ${Object.keys(platforms).join(",")})`,
  );
  process.exit(0);
}

// Every installer in a release must bundle the SAME companion TOX, and it must
// be the one in the tree -- otherwise one platform's fresh installs get a
// companion update prompt on first launch (0.20.0 shipped that way).
{
  const treeTox = join("release", "TDXLauncherUtility.tox");
  const expect = existsSync(treeTox) ? { sha256: sha256File(treeTox), version: utilityVersion() } : null;
  const problems = [];
  for (const key of Object.keys(platforms)) {
    const got = bundledUtility[key];
    if (!got) continue; // warned above; a build made outside release-build
    if (expect && got.sha256 !== expect.sha256) {
      problems.push(`${key} bundles utility ${got.version} (${got.sha256.slice(0, 8)}…) but the tree has ${expect.version} (${expect.sha256.slice(0, 8)}…)`);
    }
  }
  const digests = new Set(Object.values(bundledUtility).map((b) => b.sha256));
  if (digests.size > 1) {
    problems.push(
      "platforms disagree: " +
        Object.entries(bundledUtility).map(([k, b]) => `${k}=${b.version} (${b.sha256.slice(0, 8)}…)`).join(", "),
    );
  }
  if (problems.length > 0) {
    const lines = problems.map((p) => `  - ${p}`).join("\n");
    if (ignoreUtilityMismatch) {
      console.warn(`prepare-release: WARNING bundled-utility mismatch ignored (--ignore-utility-mismatch):\n${lines}`);
    } else {
      console.error(
        `prepare-release: bundled companion mismatch -- latest.json NOT written\n${lines}\n` +
          "  Rebuild the platform(s) that carry the wrong TOX (npm run release:build), then ship again.\n" +
          "  Override only if you mean it: --ignore-utility-mismatch",
      );
      process.exit(1);
    }
  }
}

// Schema per https://v2.tauri.app/plugin/updater/ — version/notes/pub_date plus
// a platforms map of {signature, url}.
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(STAGE_DIR, "app", "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`  + app/latest.json`);
console.log(
  `prepare-release: app v${version} staged in ${STAGE_DIR}/ ` +
    `(${staged} file(s), platforms: ${Object.keys(platforms).join(", ")}) -- complete, publish makes it live`,
);
