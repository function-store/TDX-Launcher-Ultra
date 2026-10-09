// Copy built installers out of the deep cargo bundle path into a shallow
// top-level ./installers/ folder. Runs after `tauri build`.
import {
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, extname, basename } from "node:path";

const BUNDLE_DIR = "src-tauri/target/release/bundle";
const OUT_DIR = "installers";
// File installers only (not the .app bundle dir).
const EXTS = new Set([".exe", ".msi", ".dmg", ".deb", ".appimage", ".rpm"]);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      // Treat .app as an opaque package boundary — its contents (e.g. the
      // toeexpand.exe helper under Contents/Resources/) are already shipped
      // inside the .app.tar.gz and must not be collected as top-level installers.
      if (name.toLowerCase().endsWith(".app")) continue;
      walk(p, acc);
      // hdiutil's writable staging image for the dmg it's building, left
      // behind under bundle/macos/ alongside the real bundle/dmg/ output --
      // unsigned, uncompressed, and not a real installer.
    } else if (
      EXTS.has(extname(name).toLowerCase()) &&
      !name.toLowerCase().startsWith("rw.")
    )
      acc.push(p);
  }
  return acc;
}

const found = walk(BUNDLE_DIR);
if (found.length === 0) {
  console.log(`collect-installers: nothing found under ${BUNDLE_DIR}`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
// The bundle folder keeps every version ever built, so most of these are
// already collected: skip a copy that is already current. A locked old
// installer (open in Explorer, being scanned) is warned about, never fatal:
// it used to abort the run before the fresh build's own files were copied.
let copied = 0;
let skipped = 0;
const failed = [];
for (const f of found) {
  const dest = join(OUT_DIR, basename(f));
  try {
    if (existsSync(dest)) {
      const s = statSync(f);
      const d = statSync(dest);
      if (d.size === s.size && d.mtimeMs >= s.mtimeMs) {
        skipped++;
        continue;
      }
    }
    copyFileSync(f, dest);
    copied++;
    console.log(`  → ${dest}`);
  } catch (e) {
    failed.push(dest);
    console.warn(`  ! could not copy ${dest}: ${e.code ?? e.message}`);
  }
}
console.log(
  `collect-installers: ${copied} copied, ${skipped} already current` +
    `${failed.length ? `, ${failed.length} failed` : ""} in ./${OUT_DIR}/`,
);
