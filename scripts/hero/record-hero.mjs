// Record the landing-page hero video: gallery beat, the Patreon tab, then the
// launcher shrinks to a PIP over a mocked-up TouchDesigner network and a
// Patreon component "drags" in (demo/hero-stage.html does the compositing).
// Encodes website/hero.mp4 + website/hero-poster.jpg.
//
//   npm i --no-save playwright ffmpeg-static && npx playwright install chromium
//   npm run dev:demo          # demo dev server on :5188, separate terminal
//   node scripts/hero/record-hero.mjs
import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, "../../website");
const W = 1280, H = 800;
// Keep in sync with body.pip in demo/hero-stage.html.
const PIP = { scale: 0.44, x: 22, y: 22 };

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: here, size: { width: W, height: H } },
  colorScheme: "dark",
});
const page = await context.newPage();

// Quiet first-run UI + hints. The stage page owns the single recorded-cursor
// dot and forwards iframe mouse events into it — no per-frame dots here.
await page.addInitScript(() => {
  localStorage.setItem("tdxlu.ui.tourSeen", "1");
  localStorage.setItem("tdxlu.ui.wizardSeen", "1");
  localStorage.setItem("tdxlu.ui.hintsDisabled", "1");
});

await page.goto("http://localhost:5188/hero-stage.html");
const app = page.frame({ url: /localhost:5188\/$/ }) ?? page.frames()[1];
await app.addStyleTag({ content: "#demo-banner{display:none!important}" });
await app.waitForSelector(".gallery-card", { timeout: 15000 });
await page.waitForTimeout(1500);

const sleep = (ms) => page.waitForTimeout(ms);
const glide = async (x, y, ms = 550) => {
  await page.mouse.move(x, y, { steps: Math.max(12, Math.round(ms / 16)) });
};
const click = async () => { await page.mouse.down(); await page.mouse.up(); };

/** Viewport-space center of the first app-frame element containing `text`. */
async function appPoint(selector, text, dy = 0) {
  return app.evaluate(([sel, txt, dy]) => {
    const el = [...document.querySelectorAll(sel)].find((c) => c.textContent.includes(txt));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 + dy };
  }, [selector, text, dy]);
}

/** A point inside the app, mapped into the shrunken PIP. */
const pipPt = (pt) => ({ x: PIP.x + pt.x * PIP.scale, y: PIP.y + pt.y * PIP.scale });

// ── 1 · Recent gallery: a hasty sweep, previews lighting up (~2.5 s) ────
let p = await appPoint(".gallery-card", "AuroraSet", -20);
await glide(p.x, p.y, 450); await sleep(900);
p = await appPoint(".gallery-card", "KinectRig", -20);
await glide(p.x, p.y, 400); await sleep(750);

// ── 2 · Current: perf readouts, session facts, the Companion bar ────────
p = await appPoint(".tab", "Current");
await glide(p.x, p.y, 450); await click();
await sleep(700);
p = await appPoint(".gallery-card", "AuroraSet", -20);
await glide(p.x, p.y, 400); await click();
await sleep(2000);

// ── 3 · Patreon: the creator shelf, then Function Store's feed ──────────
p = await appPoint(".tab", "Patreon");
await glide(p.x, p.y, 500); await click();
await app.waitForFunction(() => document.body.textContent.includes("Torin Blankensmith"), null, { timeout: 8000 });
await sleep(1500);
p = await appPoint("button, [role=button], .patreon-list *", "Function Store");
if (p) { await glide(p.x, p.y, 500); await click(); }
await app.waitForSelector(".patreon-post-row", { timeout: 8000 });
await sleep(700);
p = await appPoint(".patreon-post-row", "TDMap");
await glide(p.x, p.y, 500); await click();
await sleep(1500);

// ── 4 · PIP: drag Function Store's component into the network ───────────
await page.evaluate(() => window.stage.pip());
await sleep(1100);
let row = await appPoint(".patreon-post-row", "TDMap");
let start = pipPt(row);
await glide(start.x, start.y, 600);
await sleep(250);
await page.evaluate(([x, y]) => window.stage.beginDrag("⠿ TDMap.tox", x, y), [start.x, start.y]);
await glide(600, 320, 600);
await glide(682, 262, 550);
await sleep(200);
await page.evaluate(() => window.stage.drop("drop1"));
await sleep(1300);

// ── 5 · Still in the PIP: over to Lake Heckaman, grab a second one ──────
p = pipPt(await appPoint(".patreon-crumbs *", "Creators"));
await glide(p.x, p.y, 550); await click();
await app.waitForFunction(() => document.body.textContent.includes("Lake Heckaman"), null, { timeout: 8000 });
await sleep(400);
p = pipPt(await appPoint("button, [role=button], .patreon-list *", "Lake Heckaman"));
await glide(p.x, p.y, 550); await click();
await app.waitForSelector(".patreon-post-row", { timeout: 8000 });
await sleep(500);
row = await appPoint(".patreon-post-row", "GSOPs");
p = pipPt(row);
await glide(p.x, p.y, 500); await click();
await sleep(900);
start = pipPt(await appPoint(".patreon-post-row", "GSOPs"));
await glide(start.x, start.y, 300);
await sleep(200);
await page.evaluate(([x, y]) => window.stage.beginDrag("⠿ GSOPs.tox", x, y), [start.x, start.y]);
await glide(690, 340, 550);
await glide(857, 262, 600);
await sleep(200);
await page.evaluate(() => window.stage.drop("drop2"));
await glide(880, 340, 350); // settle under the second landed node
await sleep(1200);

// ── 6 · The phone remote slides in — and gets used ──────────────────────
await page.evaluate(() => window.stage.phone());
await sleep(1200);

const phone = page.frame({ url: /control\.html/ });
/** Map a point inside the phone's page to viewport coords (through its transform). */
async function phonePt(inner) {
  const box = await page.evaluate(() => {
    const ifr = document.querySelector("#phone iframe");
    const r = ifr.getBoundingClientRect();
    return { left: r.left, top: r.top, scale: r.width / ifr.offsetWidth };
  });
  return { x: box.left + inner.x * box.scale, y: box.top + inner.y * box.scale };
}

// Drag the Brightness slider: press at its current fill, pull it up high.
const slider = await phone.evaluate(() => {
  const row = [...document.querySelectorAll(".control-par-row")]
    .find((r) => r.textContent.includes("Brightness"));
  const inp = row?.querySelector('input[type="range"]');
  if (!inp) return null;
  const r = inp.getBoundingClientRect();
  const frac = (Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min));
  return { left: r.left, width: r.width, cy: r.y + r.height / 2, frac };
});
if (slider) {
  let pt = await phonePt({ x: slider.left + slider.width * slider.frac, y: slider.cy });
  await glide(pt.x, pt.y, 800);
  await sleep(250);
  await page.mouse.down();
  pt = await phonePt({ x: slider.left + slider.width * 0.22, y: slider.cy });
  await glide(pt.x, pt.y, 700);
  pt = await phonePt({ x: slider.left + slider.width * 0.94, y: slider.cy });
  await glide(pt.x, pt.y, 900);
  await page.mouse.up();
  await sleep(700);
}

// Tap over to the other session, then back — the whole panel follows.
const tab = await phone.evaluate(() => {
  const el = [...document.querySelectorAll("button, [role=tab]")]
    .find((b) => b.textContent.includes("StageMapping"));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (tab) {
  const pt = await phonePt(tab);
  await glide(pt.x, pt.y, 600); await click();
  await sleep(1500);
}
const back = await phone.evaluate(() => {
  const el = [...document.querySelectorAll("button, [role=tab]")]
    .find((b) => b.textContent.includes("AuroraSet"));
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const bpt = await phonePt(back);
await glide(bpt.x, bpt.y, 500); await click();
await sleep(2200);

const video = page.video();
await context.close();
const raw = await video.path();
await browser.close();

execFileSync(ffmpegPath, [
  "-y", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24",
  "-preset", "slow", "-movflags", "+faststart", "-an", resolve(SITE, "hero.mp4"),
], { stdio: "pipe" });
execFileSync(ffmpegPath, [
  "-y", "-i", raw, "-ss", "3", "-frames:v", "1", "-q:v", "3", resolve(SITE, "hero-poster.jpg"),
], { stdio: "pipe" });
rmSync(raw);
console.log("wrote website/hero.mp4 + website/hero-poster.jpg");
