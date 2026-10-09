// -- Tour demo art ------------------------------------------------------------
// Thumbnails for the tour's stand-in projects, so its cards and lists look like
// a working library instead of a wall of "TD" placeholders. Each one is a tiny
// animated SVG built here as a data URL: noise from SVG's own feTurbulence
// (Perlin noise, the same family as TD's Noise TOP) and gradient ramps scrolled
// with SMIL. Nothing ships in the installer, nothing loads from disk or the
// network, and SMIL keeps animating inside a plain <img>.

/** Palette pairs per look — dark base, bright accent, in TD's usual moods. */
const PALETTES: Array<[string, string, string]> = [
  ["#0b1026", "#2fd3c6", "#7b5cff"], // aurora: navy, teal, violet
  ["#140a1f", "#ff5ca8", "#ffb347"], // magenta into amber
  ["#06140f", "#3cff9a", "#1a8cff"], // green into blue
  ["#1a0d05", "#ff7a2f", "#ffe066"], // ember
  ["#0d0d12", "#e8e8f0", "#5c6cff"], // mono with a blue edge
];

/** A small stable hash, so a project always gets the same art. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Finalize (murmur3's mix) so names differing in one letter land far apart.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const W = 160;
const H = 90;

/** Flowing noise: fractal turbulence breathing slowly, tinted through a ramp. */
function noise(seed: number, [bg, a, b]: [string, string, string]): string {
  const f1 = (0.008 + (seed % 5) * 0.002).toFixed(3);
  const f2 = (Number(f1) * 1.8).toFixed(3);
  return `
<defs>
  <linearGradient id="r" x1="0" x2="1" y1="0" y2="1">
    <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
  </linearGradient>
  <filter id="n" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="${f1} ${f2}" numOctaves="3" seed="${seed % 97}">
      <animate attributeName="baseFrequency" dur="14s" repeatCount="indefinite"
        values="${f1} ${f2};${f2} ${f1};${f1} ${f2}"/>
    </feTurbulence>
    <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.6 0 0 0 -0.95"/>
    <feComposite in="SourceGraphic" operator="in"/>
  </filter>
</defs>
<rect width="${W}" height="${H}" fill="${bg}"/>
<rect width="${W}" height="${H}" fill="url(#r)" filter="url(#n)"/>`;
}

/** A Ramp TOP with its phase animated: repeating bands scrolling diagonally. */
function ramp(seed: number, [bg, a, b]: [string, string, string]): string {
  const angle = [0, 30, 60, 90, 135][seed % 5];
  return `
<defs>
  <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="60" y2="0"
    spreadMethod="reflect" gradientTransform="rotate(${angle} 80 45)">
    <stop offset="0" stop-color="${bg}"/>
    <stop offset="0.5" stop-color="${a}"/>
    <stop offset="1" stop-color="${b}"/>
    <animateTransform attributeName="gradientTransform" type="translate"
      from="0 0" to="120 0" dur="6s" repeatCount="indefinite" additive="sum"/>
  </linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>`;
}

/** A radial ramp pulsing outward, like a circle Ramp TOP fed by an LFO. */
function pulse(seed: number, [bg, a, b]: [string, string, string]): string {
  const cx = 50 + (seed % 60);
  return `
<defs>
  <radialGradient id="p" gradientUnits="userSpaceOnUse" cx="${cx}" cy="45" r="20" spreadMethod="repeat">
    <stop offset="0" stop-color="${a}"/>
    <stop offset="0.5" stop-color="${bg}"/>
    <stop offset="1" stop-color="${b}"/>
    <animate attributeName="r" values="14;28;14" dur="5s" repeatCount="indefinite"/>
  </radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#p)"/>`;
}

/** Noise displacing a ramp: the bands warp and drift, a classic TD feedback look. */
function warp(seed: number, [bg, a, b]: [string, string, string]): string {
  return `
<defs>
  <linearGradient id="w" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="30" spreadMethod="reflect">
    <stop offset="0" stop-color="${bg}"/>
    <stop offset="0.6" stop-color="${a}"/>
    <stop offset="1" stop-color="${b}"/>
    <animateTransform attributeName="gradientTransform" type="translate"
      from="0 0" to="0 60" dur="8s" repeatCount="indefinite"/>
  </linearGradient>
  <filter id="d" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="turbulence" baseFrequency="0.02" numOctaves="2" seed="${seed % 89}" result="t">
      <animate attributeName="baseFrequency" values="0.018;0.03;0.018" dur="11s" repeatCount="indefinite"/>
    </feTurbulence>
    <feDisplacementMap in="SourceGraphic" in2="t" scale="26" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</defs>
<rect x="-20" y="-20" width="${W + 40}" height="${H + 40}" fill="url(#w)" filter="url(#d)"/>`;
}

const LOOKS = [noise, ramp, warp, pulse];

/**
 * The animated thumbnail for a stand-in project, as an SVG data URL. `index`
 * is the row's place in its list and picks the look, so neighbours never
 * repeat one; the palette and seed come from the name, so each project keeps
 * its own colors.
 */
export function demoArt(key: string, index: number): string {
  const h = hash(key);
  const look = LOOKS[index % LOOKS.length];
  const palette = PALETTES[(h + index) % PALETTES.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
    `preserveAspectRatio="xMidYMid slice">${look(h >>> 5, palette)}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s*\n\s*/g, " "))}`;
}
