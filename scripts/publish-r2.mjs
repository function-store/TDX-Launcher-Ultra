// Upload ./dist-release/ to the R2 bucket, preserving keys verbatim.
//
//   node scripts/publish-r2.mjs [--bucket <name>] [--dry-run] [--only app|utility]
//
// Auth comes from the environment (never flags, so nothing lands in shell
// history or CI logs):
//   CLOUDFLARE_API_TOKEN    token with "Object Read & Write" on the bucket
//   CLOUDFLARE_ACCOUNT_ID   account the bucket belongs to
//   R2_BUCKET               bucket name, unless --bucket is given
//
// Manifests are uploaded LAST and only after every artifact they reference has
// landed. latest.json is the switch that makes a release live: publishing it
// first would point clients at objects that do not exist yet.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { walk, contentTypeFor, cacheControlFor, loadReleaseEnv, STAGE_DIR } from "./release-lib.mjs";

// Per-machine secrets from .env.release (gitignored); the shell still wins.
loadReleaseEnv();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bucketIdx = args.indexOf("--bucket");
// The bucket kept the product's old name (see `gh variable list`); it is not
// a secret, so default it and leave only the credentials to the environment.
const DEFAULT_BUCKET = "tdxgl-releases";
const bucket = (bucketIdx >= 0 ? args[bucketIdx + 1] : process.env.R2_BUCKET) ?? DEFAULT_BUCKET;
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

if (!bucket) {
  console.error("publish-r2: no bucket — pass --bucket <name> or set R2_BUCKET");
  process.exit(1);
}
if (only && !["app", "utility"].includes(only)) {
  console.error(`publish-r2: --only must be "app" or "utility", got "${only}"`);
  process.exit(1);
}
if (!existsSync(STAGE_DIR)) {
  console.error(`publish-r2: ${STAGE_DIR}/ not found — run a prepare-* script first`);
  process.exit(1);
}
if (!dryRun && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
  console.error(
    "publish-r2: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set " +
      "(see docs/releases-r2.md)",
  );
  process.exit(1);
}

const all = walk(STAGE_DIR)
  .map((p) => ({ path: p, key: relative(STAGE_DIR, p).split(sep).join("/") }))
  .filter((f) => (only ? f.key.startsWith(`${only}/`) : true));

if (all.length === 0) {
  console.error(`publish-r2: nothing to upload${only ? ` for --only ${only}` : ""}`);
  process.exit(1);
}

// Artifacts first, manifests last — see the header note.
const manifests = all.filter((f) => f.key.endsWith("latest.json"));
const artifacts = all.filter((f) => !f.key.endsWith("latest.json"));

function put({ path, key }) {
  const size = statSync(path).size;
  const argv = [
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--file",
    path,
    "--remote",
    "--content-type",
    contentTypeFor(key),
    "--cache-control",
    cacheControlFor(key),
  ];
  if (dryRun) {
    console.log(`  [dry-run] ${key}  (${size} bytes, ${contentTypeFor(key)})`);
    return;
  }
  // Windows has to go through the shell to resolve npx.cmd, and with
  // shell:true node joins the arguments WITHOUT quoting -- so a file name
  // with spaces or the "no-cache, must-revalidate" cache-control value would
  // arrive at wrangler as several words ("Unknown arguments: Launcher, Ultra,
  // Setup.exe, must-revalidate"). Quote every argument that needs it.
  const win = process.platform === "win32";
  const quoted = win ? argv.map((a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : argv;
  const r = spawnSync("npx", quoted, { stdio: "inherit", shell: win });
  if (r.status !== 0) {
    console.error(`publish-r2: upload failed for ${key}`);
    process.exit(r.status ?? 1);
  }
  console.log(`  ↑ ${key}  (${size} bytes)`);
}

console.log(`publish-r2: ${all.length} object(s) → r2://${bucket}${dryRun ? "  (dry run)" : ""}`);
for (const f of artifacts) put(f);
for (const f of manifests) put(f);
console.log(
  dryRun
    ? "publish-r2: dry run complete — nothing was uploaded"
    : `publish-r2: done (${manifests.map((m) => m.key).join(", ") || "no manifest"} is now live)`,
);
