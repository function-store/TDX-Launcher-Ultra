// Point both release channels at a host, in the two places that hardcode it.
//
//   node scripts/set-release-host.mjs https://dl.example.com
//   node scripts/set-release-host.mjs            # print the current host
//
// The app channel's endpoint is compiled into the binary from tauri.conf.json;
// the utility channel's base lives in src-tauri/src/updates.rs. They must name
// the same bucket — updates.rs has a unit test that fails the build otherwise,
// which is why this writes both or neither.

import { readFileSync, writeFileSync } from "node:fs";

const CONF = "src-tauri/tauri.conf.json";
const RS = "src-tauri/src/updates.rs";
const RS_RE = /(pub const DEFAULT_RELEASE_BASE: &str = ")([^"]*)(";)/;

const conf = readFileSync(CONF, "utf8");
const rs = readFileSync(RS, "utf8");

const current = JSON.parse(conf).plugins?.updater?.endpoints?.[0] ?? "(unset)";
const rsCurrent = rs.match(RS_RE)?.[2] ?? "(unparsed)";

const input = process.argv[2];
if (!input) {
  console.log(`tauri.conf.json endpoint : ${current}`);
  console.log(`updates.rs  release base : ${rsCurrent}`);
  console.log(`\nUsage: npm run set-release-host <https://your-host>`);
  process.exit(0);
}

let host;
try {
  host = new URL(input);
} catch {
  console.error(`set-release-host: not a valid URL: ${input}`);
  process.exit(1);
}
if (host.protocol !== "https:") {
  // The updater refuses plain HTTP, and the utility digest check is only as
  // good as the manifest it came from.
  console.error(`set-release-host: must be https, got ${host.protocol}//`);
  process.exit(1);
}
const base = `${host.origin}${host.pathname}`.replace(/\/+$/, "");

// tauri.conf.json is edited as text, not re-serialized, so formatting and key
// order stay exactly as authored.
const nextConf = conf.replace(
  /("endpoints"\s*:\s*\[\s*")([^"]*)("\s*\])/,
  (_m, a, _old, c) => `${a}${base}/app/latest.json${c}`,
);
if (nextConf === conf) {
  console.error(`set-release-host: could not find the updater endpoint in ${CONF}`);
  process.exit(1);
}

const nextRs = rs.replace(RS_RE, (_m, a, _old, c) => `${a}${base}${c}`);
if (nextRs === rs) {
  console.error(`set-release-host: could not find DEFAULT_RELEASE_BASE in ${RS}`);
  process.exit(1);
}

writeFileSync(CONF, nextConf);
writeFileSync(RS, nextRs);
console.log(`set-release-host: ${base}`);
console.log(`  ${CONF}  → ${base}/app/latest.json`);
console.log(`  ${RS}    → ${base}  (utility/latest.json)`);
console.log(`\nRebuild and re-release for shipped clients to use the new host.`);
