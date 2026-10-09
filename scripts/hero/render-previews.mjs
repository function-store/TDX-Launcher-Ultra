// Render the generative demo-gallery preview loops (scenes.html) into
// demo/mock/previews/: one seamless 6 s 640×360 h264 loop + poster per scene.
//
//   npm i --no-save playwright ffmpeg-static && npx playwright install chromium
//   node scripts/hero/render-previews.mjs
//
// Deterministic — same frames every run, so re-rendering only changes bytes
// when scenes.html changes.
import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || resolve(here, "../../demo/mock/previews");
const FRAMES = 180; // 6 s at 30 fps; every scene loops on t in [0,1)
const SCENES = ["aurora", "particleWall", "kinect", "stage", "audio"];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 660, height: 380 } });
await page.goto("file://" + join(here, "scenes.html"));

for (const scene of SCENES) {
  const dir = join(OUT, "_frames_" + scene);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < FRAMES; i++) {
    await page.evaluate(([s, i, n]) => window.renderFrame(s, i, n), [scene, i, FRAMES]);
    const dataUrl = await page.evaluate(() => window.grabPNG());
    writeFileSync(
      join(dir, String(i).padStart(4, "0") + ".png"),
      Buffer.from(dataUrl.split(",")[1], "base64"),
    );
  }
  execFileSync(ffmpegPath, [
    "-y", "-framerate", "30", "-i", join(dir, "%04d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow",
    "-movflags", "+faststart", "-an", join(OUT, scene + ".mp4"),
  ], { stdio: "pipe" });
  execFileSync(ffmpegPath, [
    "-y", "-i", join(dir, "0045.png"), "-q:v", "4", join(OUT, scene + "-poster.jpg"),
  ], { stdio: "pipe" });
  rmSync(dir, { recursive: true });
  console.log("rendered", scene);
}

await browser.close();
console.log("done ->", OUT);
