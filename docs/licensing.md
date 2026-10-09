# Licensing & membership

**The launcher is free in full** (decision 2026-10-02): no feature checks an
entitlement, in the UI or in a command. There is no Pro tier, no trial and no
licence key. What a Function Store Patreon membership pays for is the
**FNSTools Plus** packages, which the launcher lists, installs and updates.

The machinery lives in [`src-tauri/src/licensing.rs`](../src-tauri/src/licensing.rs);
the gate contract it speaks is [fns-gate.md](fns-gate.md).

## How membership works

- The launcher is a **public client** of the FNSTools entitlement gate. It holds
  no Patreon secret. Signing in with Patreon gets an opaque, revocable **device
  token** and a signed **Ed25519 entitlement claim**; the local auth file
  (`tdxlu-license.json` in the config dir) holds just those two values.
- The claim is a **product list**. `products` decides which Plus packages
  unlock: a gated package the claim does not name renders locked, in the
  desktop FNSTools tab and on the in-TD palette page alike. `entitled` (the claim
  names at least one product — the gate's `TIERS` map lists products for paid
  tiers only) reads as "an active paid membership"; it drives the header chip
  and the membership modal, nothing else. The launcher has no product of its
  own: `TDXLU_Pro` retired 2026-10-02.
- **Once per machine.** The cached claim is valid until its `exp` (180 days,
  renewed on any successful re-check); a failed request never revokes it.
- **Shared with FNSTools** (fns-gate.md §5): one sign-in on a machine serves
  both. An install with no session of its own adopts the toolkit's shared token
  before opening a browser.
- **Sign-out** (About dialog) revokes the token at the gate, then clears the
  file — and the shared file when it still holds that token.
- Purchase gate, not DRM: a project file carrying a Plus package works for
  whoever opens it.

The companion utility TOX channel is not gated.

## In the app

- **Header "Plus" chip** — shown when the build is licensed; accent when a
  membership is active. Opens the **FNSTools Plus** modal: sign in with
  Patreon, check again (a pledge that just landed), or open the Patreon page.
- **About dialog** — the membership line and Sign out.
- **FNSTools tab / palette page** — Plus rows are locked or unlocked from
  `products`; a locked row links to the toolkit's support page.

## Build toggle

Cargo feature `licensing` (in `default`). Built without it, `license_status`
reports provider `"disabled"` and the membership chip is hidden. **Release
builds must keep default features.**

## Surface map

| Piece | File |
|---|---|
| Gate client (auth file, claim, sign-in, adopt, re-check, sign-out) | `src-tauri/src/licensing.rs` |
| Command wrappers (`license_*_cmd`) | `src-tauri/src/commands.rs` |
| Membership modal (opened from Settings → Accounts → FNSTools Plus and the FNSTools tab's "Sign in for Plus…" — no header chip: the launcher has no Plus features), About line, update-time re-check | `src/App.tsx` |
| Plus rows on the palette page (`products` from `/api/palette/catalog`) | `src/palette-standalone.tsx` |
| `LicenseStatus` DTO | `src/types.ts` / `src/api.ts` |

Note: `src-tauri/src/patreon.rs` is the **content-import** feature (cookie-based
post/tox browser of creators you support) — free, and not licensing code.
