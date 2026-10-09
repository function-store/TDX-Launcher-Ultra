// Generated SVG artwork for the demo — icons, heroes, avatars as data URLs.
// Deterministic per name so the same project always looks the same.

function hashHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function svgUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Square project icon: two-tone gradient + initial letter. */
export function projectIcon(name: string): string {
  const hue = hashHue(name);
  const initial = (name[0] || "?").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},45%,26%)"/>
<stop offset="1" stop-color="hsl(${(hue + 50) % 360},50%,14%)"/>
</linearGradient></defs>
<rect width="64" height="64" rx="10" fill="url(#g)"/>
<circle cx="46" cy="18" r="20" fill="hsl(${(hue + 30) % 360},60%,45%)" opacity="0.25"/>
<text x="32" y="42" font-family="Segoe UI,system-ui,sans-serif" font-size="30" font-weight="700" fill="hsl(${hue},70%,82%)" text-anchor="middle">${initial}</text>
</svg>`;
  return svgUrl(svg);
}

/** Wide hero image for gallery tiles and the media browser. */
export function heroArt(name: string, caption?: string): string {
  const hue = hashHue(name);
  const h2 = (hue + 70) % 360;
  const blobs = [0, 1, 2, 3]
    .map((i) => {
      const bx = ((hashHue(name + i) % 100) / 100) * 640;
      const by = 40 + ((hashHue(name + "y" + i) % 100) / 100) * 280;
      const r = 60 + (hashHue(name + "r" + i) % 90);
      const bh = (hue + i * 40) % 360;
      return `<circle cx="${bx.toFixed(0)}" cy="${by.toFixed(0)}" r="${r}" fill="hsl(${bh},70%,55%)" opacity="0.18"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},40%,16%)"/>
<stop offset="1" stop-color="hsl(${h2},45%,9%)"/>
</linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/>
${blobs}
<text x="24" y="332" font-family="Segoe UI,system-ui,sans-serif" font-size="22" font-weight="600" fill="hsl(${hue},50%,85%)" opacity="0.85">${caption ?? name}</text>
</svg>`;
  return svgUrl(svg);
}

/** Round-ish avatar for mock Patreon creators. */
export function avatarArt(name: string): string {
  const hue = hashHue(name);
  const initial = (name[0] || "?").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
<rect width="80" height="80" rx="40" fill="hsl(${hue},50%,30%)"/>
<circle cx="58" cy="24" r="26" fill="hsl(${(hue + 40) % 360},60%,50%)" opacity="0.35"/>
<text x="40" y="52" font-family="Segoe UI,system-ui,sans-serif" font-size="34" font-weight="700" fill="hsl(${hue},60%,88%)" text-anchor="middle">${initial}</text>
</svg>`;
  return svgUrl(svg);
}
