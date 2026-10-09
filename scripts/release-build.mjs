// One command per machine for a local (no-CI) app release: build the signed
// bundles for THIS machine, make sure every updater artifact has its .sig, and
// drop the shippable files into the artifacts/<platform>/ layout that
// prepare-release.mjs reads. See docs/releases-local.md.
//
//   node scripts/release-build.mjs [--collect-only] [--key <path>]
//
//   --collect-only   skip the build; just (re)sign if needed and collect what
//                    a previous `tauri build` left under src-tauri/target/
//   --key <path>     updater private key; default is TAURI_SIGNING_PRIVATE_KEY
//                    from the environment, else ~/.tauri/tdxlpp_updater.key
//
// macOS also needs the Apple signing/notarization variables in the
// environment (`source scripts/local-signing-env.sh`); without them the build
// still succeeds but the .app/.dmg are not notarized -- fine for a test, not
// for a release, and the script says so.
//
// The updater .sig is NOT code signing. It is the minisign signature the
// in-app updater verifies against plugins.updater.pubkey, produced from the
// key file with an empty password. prepare-release refuses a platform without
// it, so this script signs any bundle that came out of the build unsigned
// (the PowerShell empty-password trap in the runbook is the usual cause).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { appVersion, fail, loadReleaseEnv, sha256File, utilityVersion, BUNDLE_INFO } from "./release-lib.mjs";

// .env.release may carry TAURI_SIGNING_PRIVATE_KEY (path or contents) and, on
// macOS, the APPLE_* notarization variables, so neither needs a shell setup.
loadReleaseEnv();

const args = process.argv.slice(2);
const collectOnly = args.includes("--collect-only");
const keyIdx = args.indexOf("--key");

// ---- which machine is this --------------------------------------------------
const HOST = {
  darwin: { platform: "darwin-aarch64", triple: "aarch64-apple-darwin", arch: "arm64" },
  win32: { platform: "windows-x86_64", triple: "x86_64-pc-windows-msvc", arch: "x64" },
}[process.platform];
if (!HOST) fail(`release-build: no release platform for ${process.platform}`);
if (process.arch !== HOST.arch) {
  fail(`release-build: this is a ${process.arch} machine, the ${HOST.platform} release is built on ${HOST.arch}`);
}

const version = appVersion();

// ---- the updater key -------------------------------------------------------
let keyPath = keyIdx >= 0 ? args[keyIdx + 1] : null;
let keyValue = process.env.TAURI_SIGNING_PRIVATE_KEY || null;
if (!keyPath && !keyValue) {
  const candidates = [join(homedir(), ".tauri", "tdxlpp_updater.key"), join(homedir(), "Downloads", "tdxlpp_updater.key")];
  keyPath = candidates.find((p) => existsSync(p)) ?? null;
  if (!keyPath) {
    fail(
      "release-build: no updater key.\n" +
        `  Put tdxlpp_updater.key at ${candidates[0]}, or pass --key <path>,\n` +
        "  or export TAURI_SIGNING_PRIVATE_KEY. It is the updater's PRIVATE key --\n" +
        "  move it between machines privately, never through chat or the repo.",
    );
  }
}
if (keyPath && !existsSync(keyPath)) fail(`release-build: key file not found: ${keyPath}`);
// TAURI_SIGNING_PRIVATE_KEY accepts a path or the key contents; a path that
// exists is treated as a path by the CLI, so hand it over as-is.
if (keyValue && existsSync(keyValue)) {
  keyPath = keyValue;
  keyValue = null;
}

// ---- helpers ---------------------------------------------------------------
const TAURI_CLI = join("node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(TAURI_CLI)) fail("release-build: @tauri-apps/cli not installed -- run npm ci");

/** Run a node script / the Tauri CLI without a shell, so paths with spaces survive on Windows. */
function run(label, argv, env = {}) {
  console.log(`\nrelease-build: ${label}`);
  const r = spawnSync(process.execPath, argv, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) fail(`release-build: ${label} failed (exit ${r.status ?? r.signal})`);
}

function signerArgs() {
  return keyPath ? ["--private-key-path", keyPath] : ["--private-key", keyValue];
}

function ensureSigned(file) {
  const sig = `${file}.sig`;
  if (existsSync(sig) && statSync(sig).mtimeMs >= statSync(file).mtimeMs) return false;
  run(`signing ${basename(file)}`, [TAURI_CLI, "signer", "sign", ...signerArgs(), "--password", "", file]);
  if (!existsSync(sig)) fail(`release-build: signer produced no ${basename(sig)}`);
  return true;
}

// ---- 1. build --------------------------------------------------------------
if (!collectOnly) {
  run("fetching the FNSTools bootstrap", ["scripts/fetch-fns-bootstrap.mjs"]);
  const signingEnv = {
    TAURI_SIGNING_PRIVATE_KEY: keyPath ?? keyValue,
    // Set here, in node's environment, so the signer never prompts -- the
    // runbook's PowerShell trap is exactly this variable going missing.
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  };
  run(`building ${HOST.platform} v${version}`, [TAURI_CLI, "build", "--target", HOST.triple], signingEnv);
  if (process.platform === "darwin") {
    const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH } = process.env;
    if (APPLE_API_KEY && APPLE_API_ISSUER && APPLE_API_KEY_PATH) {
      run("notarizing the dmg", ["scripts/notarize-dmg.mjs", HOST.triple]);
    } else {
      console.warn(
        "\nrelease-build: WARNING -- no Apple notarization credentials in the environment;\n" +
          "  the .app/.dmg are NOT notarized. For a release: source scripts/local-signing-env.sh first.",
      );
    }
  }
}

// ---- 2. find what the build produced ---------------------------------------
// `tauri build --target <triple>` writes under target/<triple>/; a plain build
// under target/. Take whichever holds the newer updater bundle, so a
// --collect-only after either kind of build finds the right one.
const BUNDLE_DIRS = [
  join("src-tauri", "target", HOST.triple, "release", "bundle"),
  join("src-tauri", "target", "release", "bundle"),
];
const VERSIONED = new RegExp(`_${version.replace(/\./g, "\\.")}_`);

function candidates(bundleDir) {
  if (!existsSync(bundleDir)) return null;
  if (process.platform === "darwin") {
    const macos = join(bundleDir, "macos");
    const dmg = join(bundleDir, "dmg");
    const tarball = existsSync(macos) ? readdirSync(macos).find((f) => f.endsWith(".app.tar.gz")) : null;
    const dmgs = existsSync(dmg) ? readdirSync(dmg).filter((f) => f.endsWith(".dmg") && VERSIONED.test(f)) : [];
    if (!tarball || dmgs.length === 0) return null;
    return { updater: [join(macos, tarball)], installers: dmgs.map((f) => join(dmg, f)) };
  }
  const nsis = join(bundleDir, "nsis");
  const msi = join(bundleDir, "msi");
  const exes = existsSync(nsis) ? readdirSync(nsis).filter((f) => f.endsWith(".exe") && VERSIONED.test(f)) : [];
  const msis = existsSync(msi) ? readdirSync(msi).filter((f) => f.endsWith(".msi") && VERSIONED.test(f)) : [];
  if (exes.length === 0) return null;
  // Both are updater-signed by the build; prepare-release picks the NSIS .exe
  // as the updater target and ships the .msi as a plain download.
  return { updater: [...exes.map((f) => join(nsis, f)), ...msis.map((f) => join(msi, f))], installers: [] };
}

const found = BUNDLE_DIRS.map((d) => ({ dir: d, files: candidates(d) }))
  .filter((c) => c.files)
  .sort((a, b) => statSync(b.files.updater[0]).mtimeMs - statSync(a.files.updater[0]).mtimeMs)[0];
if (!found) {
  fail(
    `release-build: no v${version} bundles under ${BUNDLE_DIRS.join(" or ")}\n` +
      "  (run without --collect-only to build them)",
  );
}
console.log(`\nrelease-build: collecting from ${found.dir}`);

// ---- 3. sign anything the build left unsigned, then collect ----------------
const OUT = join("artifacts", HOST.platform);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const shipped = [];
for (const file of found.files.updater) {
  const signedNow = ensureSigned(file);
  for (const src of [file, `${file}.sig`]) {
    copyFileSync(src, join(OUT, basename(src)));
    shipped.push(basename(src) + (signedNow && src.endsWith(".sig") ? "  (signed just now)" : ""));
  }
}
for (const file of found.files.installers) {
  copyFileSync(file, join(OUT, basename(file)));
  shipped.push(basename(file));
}

// The .sig must verify against the key the shipped app trusts. The public
// half is derivable from the private key only by the CLI, so the check here
// is the cheap one: the .sig names the file it signs.
for (const name of shipped.filter((n) => n.endsWith(".sig"))) {
  const sig = Buffer.from(readFileSync(join(OUT, name), "utf8").trim(), "base64").toString();
  const expect = name.replace(/\.sig$/, "");
  if (!sig.includes(`file:${expect}`)) fail(`release-build: ${name} does not name ${expect} in its trusted comment`);
}

// Record which companion TOX this build bundles, so prepare-release can refuse
// a release whose two installers carry different utilities (0.20.0 shipped
// that way: the Mac was built minutes before the utility bump, Windows after).
// macOS: read it out of the built .app. Windows: the resource is inside the
// installer, so take the tree's copy -- it is the file `tauri build` just
// bundled, and a --collect-only after a utility bump is the one case that
// could misreport, which is why the message names the file.
const bundledToxDigest = (() => {
  if (process.platform === "darwin") {
    const app = readdirSync(join(found.dir, "macos")).find((f) => f.endsWith(".app"));
    const inApp = app && join(found.dir, "macos", app, "Contents", "Resources", "_up_", "release", "TDXLauncherUtility.tox");
    if (inApp && existsSync(inApp)) return sha256File(inApp);
  }
  return sha256File(join("release", "TDXLauncherUtility.tox"));
})();
const bundleInfo = {
  version,
  platform: HOST.platform,
  bundled_utility: { sha256: bundledToxDigest, version: utilityVersion() },
  built_at: new Date().toISOString(),
};
writeFileSync(join(OUT, BUNDLE_INFO), JSON.stringify(bundleInfo, null, 2) + "\n");
shipped.push(`${BUNDLE_INFO}  (bundled utility ${bundleInfo.bundled_utility.version}, ${bundledToxDigest.slice(0, 8)}…)`);

console.log(`\nrelease-build: ${HOST.platform} v${version} ready in ${OUT}/`);
for (const n of shipped) console.log(`  + ${n}`);
console.log(
  "\nNext: `npm run release:ship` (needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / R2_BUCKET).\n" +
    "  It uploads this platform; the release goes live once both machines have shipped.",
);
