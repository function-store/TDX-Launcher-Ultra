// Fetch the FNSTools bootstrap the launcher bundles, from the release bucket.
//
//   node scripts/fetch-fns-bootstrap.mjs [--force] [--base <url>]
//
// WHY THIS EXISTS. The launcher ships `release/FNSTools.tox` as a Tauri
// resource so a machine that has never synced the FNS palette store can still
// install the toolkit (that tox carries FNS_Installer AND FNS_Updater — with
// no bootstrap there is no installer and no updater, only a dropped file that
// can never be maintained). See fns_store::effective_bootstrap.
//
// The artifact is NOT in git, deliberately: the only copy that belongs in a
// build is a real released one, and hand-copying invites shipping a dev build
// off somebody's working branch. So the build fetches it from the same rolling
// manifest the app reads, verifies the sha256 the manifest pins, and records
// WHICH release landed in release/FNSTools.json.
//
// Always asks the bucket what is current. A local copy is kept ONLY when the
// bucket still publishes the same bytes (digest match against the live
// manifest, not against our own record) — so the toolkit cutting a release
// is picked up by the next build, without anyone remembering `--force`.
// Offline, a recorded local copy is kept and the build goes on; --force
// re-downloads even a matching copy.
//
// (It used to short-circuit on "local file matches OUR record", which made the
// first fetch on a machine permanent: 0.20.2 shipped a v3.2.15 bootstrap while
// the bucket was at v3.2.45, and nothing in the build said so.)

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fail, releaseBase, sha256File } from "./release-lib.mjs";

const TOX_NAME = "FNSTools.tox";
const OUT_TOX = join("release", TOX_NAME);
const OUT_REC = join("release", "FNSTools.json");
/// Capability artifacts bundled beside the bootstrap (a Tauri resource dir).
const SEED_DIR = join("release", "fns");
// The app's own default bucket (config.rs `fns_base_url`). Overridable so a
// mirror or a staging bucket can be pointed at without editing this file.
const DEFAULT_BASE = "https://storage.functionstore.tools/fnstools";

const args = process.argv.slice(2);
const force = args.includes("--force");
const baseIdx = args.indexOf("--base");
const base = (baseIdx >= 0 ? args[baseIdx + 1] : process.env.FNS_BASE_URL || DEFAULT_BASE).replace(
  /\/+$/,
  "",
);

function readRecord() {
  try {
    return JSON.parse(readFileSync(OUT_REC, "utf8"));
  } catch {
    return null;
  }
}

const rec = readRecord();
const localSha = existsSync(OUT_TOX) ? sha256File(OUT_TOX) : null;

const manifestUrl = `${base}/manifest.json`;
console.log(`fetch-fns-bootstrap: reading ${manifestUrl}`);

let manifest;
try {
  const res = await fetch(manifestUrl, {
    headers: { "User-Agent": "TDXLU-build", "Cache-Control": "no-cache" },
  });
  if (!res.ok) fail(`manifest HTTP ${res.status} (${manifestUrl})`);
  manifest = await res.json();
} catch (e) {
  // Offline: a recorded local copy is better than a failed build (the record
  // proves it is released bytes, not a dev export); a missing one is not, and
  // must fail loudly rather than ship the resource absent.
  if (localSha && rec?.sha256 && localSha === rec.sha256) {
    console.warn(
      `fetch-fns-bootstrap: could not reach the bucket (${e.message}); keeping the recorded ${rec.release} copy of ${OUT_TOX}`,
    );
    process.exit(0);
  }
  fail(`could not reach the bucket and no recorded local copy exists: ${e.message}`);
}

const rail = manifest?.rails?.[TOX_NAME];
if (!rail?.url) fail(`release ${manifest?.release ?? "?"} publishes no ${TOX_NAME} rail`);

mkdirSync("release", { recursive: true });
let got;
let bytes;
if (!force && localSha && rail.sha256 && localSha === rail.sha256) {
  // The bucket still publishes exactly these bytes — current, whatever our
  // record said. Fall through so the record and the seeds are still brought
  // up to this manifest.
  console.log(`fetch-fns-bootstrap: ${OUT_TOX} is current at ${manifest.release} — not re-downloading`);
  got = localSha;
  bytes = statSync(OUT_TOX).size;
} else {
  if (rec?.release && rec.release !== manifest.release) {
    console.log(`fetch-fns-bootstrap: bucket moved ${rec.release} → ${manifest.release}`);
  }
  console.log(`fetch-fns-bootstrap: ${manifest.release} → ${rail.url}`);
  const bin = Buffer.from(
    await (await fetch(rail.url, { headers: { "User-Agent": "TDXLU-build" } })).arrayBuffer(),
  );
  writeFileSync(OUT_TOX, bin);

  // Verify AFTER writing, against the manifest's pinned digest. `.tox` export is
  // not reproducible, so the digest is the only thing that proves these are the
  // published bytes rather than a rebuild.
  got = sha256File(OUT_TOX);
  if (rail.sha256 && got !== rail.sha256) {
    fail(`digest mismatch for ${TOX_NAME}: manifest says ${rail.sha256}, downloaded ${got}`);
  }
  bytes = bin.length;
  console.log(
    `fetch-fns-bootstrap: wrote ${OUT_TOX} (${(bytes / 1e6).toFixed(3)} MB, ${manifest.release})`,
  );
}

// --- the half this script does NOT do yet --------------------------------
//
// The bootstrap is what we install WITH; it is not what we install FROM. An
// offline user needs the capability artifact locally too, or they get a
// working installer that cannot reach the package and are told to go online
// anyway. That artifact cannot be fetched until the toolkit RELEASES and
// catalogues it free — a released artifact is the only kind this script will
// take, and `seedable` is false for anything uncatalogued.
//
// So rather than carry a fetcher that silently does nothing, detect the day
// the condition changes and say so. Same predicate as
// fns_store::package_bundleable: free FIRST (it is the half that, if wrong,
// puts paid bytes in a public installer), launcher-capable second.
const gated = (p) => {
  const a = p?.access;
  return typeof a === "string" && a !== "" && a.toLowerCase() !== "free";
};
// The toolkit nests this inside the launcher block (measured live on
// v3.0.13); top level is the fallback. Same order as the Rust predicate.
const declaredSeedable = (p) => {
  const nested = p?.launcher?.seedable;
  if (typeof nested === "boolean") return nested;
  return typeof p?.seedable === "boolean" ? p.seedable : undefined;
};
const bundleable = (p) => {
  const declared = declaredSeedable(p);
  if (typeof declared === "boolean") return declared && !gated(p);
  return !gated(p) && !!p?.launcher && typeof p.launcher === "object";
};

const seedablePkgs = (manifest.packages ?? []).filter(bundleable);

// --- the capability artifacts -------------------------------------------
//
// The bootstrap is what an offline machine installs WITH; these are what it
// installs FROM. Same fetch-and-verify contract: released bytes only, digest
// pinned by the manifest, and a record of what landed.
//
// ONLY free packages reach this list (see `bundleable`), so a gated artifact
// can never end up inside a freely-downloadable installer. That is the whole
// reason the free check runs first and a `seedable` that disagrees with
// `access` is refused rather than trusted.
mkdirSync(SEED_DIR, { recursive: true });
const seeded = [];
for (const pkg of seedablePkgs) {
  const art = pkg.artifact;
  if (!art?.url) {
    console.warn(`fetch-fns-bootstrap: ${pkg.name} is seedable but publishes no artifact — skipped`);
    continue;
  }
  const out = join(SEED_DIR, `${pkg.name}.tox`);
  if (!force && existsSync(out) && art.sha256 && sha256File(out) === art.sha256) {
    console.log(`fetch-fns-bootstrap: ${pkg.name} already current — skipped`);
    seeded.push({ name: pkg.name, version: pkg.version, sha256: art.sha256 });
    continue;
  }
  const buf = Buffer.from(
    await (await fetch(art.url, { headers: { "User-Agent": "TDXLU-build" } })).arrayBuffer(),
  );
  writeFileSync(out, buf);
  const digest = sha256File(out);
  if (art.sha256 && digest !== art.sha256) {
    fail(`digest mismatch for ${pkg.name}: manifest says ${art.sha256}, downloaded ${digest}`);
  }
  console.log(
    `fetch-fns-bootstrap: bundled ${pkg.name} ${pkg.version} (${(buf.length / 1e6).toFixed(3)} MB)`,
  );
  seeded.push({ name: pkg.name, version: pkg.version, sha256: digest });
}

// Anything in the seed dir that the manifest no longer says is seedable must
// GO. A package that went gated, or lost its launcher block, would otherwise
// keep shipping inside the installer from a stale local copy — the exact leak
// the free check exists to prevent, arriving by the back door.
for (const f of readdirSync(SEED_DIR)) {
  if (!f.endsWith(".tox")) continue;
  if (!seeded.some((p) => `${p.name}.tox` === f)) {
    rmSync(join(SEED_DIR, f));
    console.log(`fetch-fns-bootstrap: removed ${f} — no longer seedable in ${manifest.release}`);
  }
}

writeFileSync(
  OUT_REC,
  JSON.stringify(
    {
      release: manifest.release,
      sha256: got,
      bytes,
      url: rail.url,
      seeded,
      fetched_at: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);

if (!seeded.length) {
  console.log("fetch-fns-bootstrap: no seedable packages in this release — bootstrap only");
}
