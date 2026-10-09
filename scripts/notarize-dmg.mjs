// Notarizes and staples the built .dmg. `tauri build` notarizes+staples the
// .app bundle automatically, but never submits the outer .dmg container --
// so a downloaded .dmg still fails Gatekeeper's own check ("Unnotarized
// Developer ID", no stapled ticket) the moment it's opened, even though the
// .app inside is fully clean. Apple's guidance is to notarize the outermost
// distributed artifact, so this closes that gap. No-op off macOS or without
// notarization credentials (local unsigned dev builds, Windows CI leg).
//
// Usage: node scripts/notarize-dmg.mjs [target-triple]
// target-triple matches `tauri build --target <triple>`'s output dir; omit
// for a plain (no --target) local build.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
const BUNDLE_DIR = target
  ? `src-tauri/target/${target}/release/bundle/dmg`
  : "src-tauri/target/release/bundle/dmg";

const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH } = process.env;

if (process.platform !== "darwin") {
  console.log("notarize-dmg: not macOS, skipping");
  process.exit(0);
}
if (!APPLE_API_KEY || !APPLE_API_ISSUER || !APPLE_API_KEY_PATH) {
  console.log(
    "notarize-dmg: no Apple notarization credentials in env, skipping",
  );
  process.exit(0);
}
if (!existsSync(BUNDLE_DIR)) {
  console.log(`notarize-dmg: ${BUNDLE_DIR} not found, skipping`);
  process.exit(0);
}

const dmgs = readdirSync(BUNDLE_DIR).filter((f) =>
  f.toLowerCase().endsWith(".dmg"),
);
if (dmgs.length === 0) {
  console.log(`notarize-dmg: no .dmg in ${BUNDLE_DIR}, skipping`);
  process.exit(0);
}

for (const name of dmgs) {
  const dmgPath = join(BUNDLE_DIR, name);
  console.log(`notarize-dmg: submitting ${name} (this can take a while)`);
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      dmgPath,
      "--key-id",
      APPLE_API_KEY,
      "--key",
      APPLE_API_KEY_PATH,
      "--issuer",
      APPLE_API_ISSUER,
      "--wait",
    ],
    { stdio: "inherit" },
  );
  console.log(`notarize-dmg: stapling ${name}`);
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
}
