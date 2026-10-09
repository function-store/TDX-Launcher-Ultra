# Releasing from local machines (the normal path)

Since 2026-09-08 releases are built and published from local machines: the
hosted builds were slow and burned Actions minutes, so both workflows in
`.github/workflows/` are manual-dispatch only and a tag push starts nothing.
The app channel is two commands on the Mac and the same two on the Windows
box, in either order, with nothing copied between them — each machine
uploads its own platform and the second one to finish flips the manifest live.

Companion doc: [releases-r2.md](releases-r2.md) covers the bucket layout,
one-time setup, token creation, and how clients consume releases. This doc is
just the "no CI" runbook.

## Prerequisites (both machines)

- Node 20 and Rust stable (same as the runners).
- The repo checked out at the **same commit** — the release commit with the
  version bump.
- `npm ci` run.
- For the app channel only: the updater signing key (see below).

Publishing needs the Cloudflare credentials on each machine. Set them ONCE
in a gitignored `.env.release` at the repo root (copy `.env.release.example`
and fill in the token); every release script reads it, on macOS and Windows
alike, and a variable exported in the shell still overrides it:

```
CLOUDFLARE_API_TOKEN=...            # account-level "Workers R2 Storage → Edit" token
CLOUDFLARE_ACCOUNT_ID=...           # R2 overview sidebar
# R2_BUCKET=tdxgl-releases          # optional: publish-r2 defaults to it
```

The same file can carry `TAURI_SIGNING_PRIVATE_KEY` (a path) and, on the
Mac, the `APPLE_*` notarization variables, so `release:build` needs no
`source` step either.

> **Token gotcha:** you cannot read `CLOUDFLARE_API_TOKEN` back out of GitHub
> secrets. If it isn't saved locally, create a fresh one — and it must be the
> **account-level** Workers R2 Storage token (My Profile → API Tokens → Custom
> Token), *not* the R2 → "Manage R2 API Tokens" flow, which wrangler rejects
> with a generic `403 Authentication error [code: 10000]`. Details in
> [releases-r2.md](releases-r2.md#4-create-an-r2-api-token).

## Bundled FNSTools bootstrap (automatic — but know when it bites)

The app bundles `release/FNSTools.tox` as a Tauri resource. It is **not in
git**: `npm run tauri:build`, `tauri:build:signed` and `release:prepare` all
run `scripts/fetch-fns-bootstrap.mjs` first, which pulls the rail the ROLLING
manifest currently pins, verifies its sha256, and records what landed in
`release/FNSTools.json`.

You normally do nothing. The three cases where you must think:

| Situation | What happens | What to do |
|---|---|---|
| Toolkit cut a new release and you want it | Nothing — a matching local copy is a no-op | `npm run fns:bootstrap -- --force` |
| Building offline, copy already present | Keeps the existing file, warns | Nothing |
| Building offline, **no** copy | **Build fails** | Get online once, or copy `release/FNSTools.tox` + `.json` from a machine that has them |

**Why it is fetched and not committed.** The only copy that belongs in a build
is a real released artifact. Hand-placing invites shipping a dev build off
somebody's working branch — which is exactly what happened while this was
being written, and is silent when it goes wrong. Fetching makes the released
artifact the *only* thing that can end up in the bundle, and the digest check
makes a wrong file loud.

**What it is for.** The bootstrap carries `FNS_Installer` AND `FNS_Updater`.
Without it a project has no installer and no updater — only a dropped file
that can never be maintained. Bundling it is what lets a machine that has
never synced the FNS palette store install the toolkit at all. At runtime
`fns_store::effective_bootstrap()` prefers the STORE's rail and falls back to
the bundle; the bundle is never copied into the store.

### The joint release sequence (both repos)

Agreed with the toolkit side (their `docs/LauncherToolkitBoundary.md`,
commit 6d5572c). Order matters, and two of these steps fail SILENTLY when
skipped — they are marked.

| # | Whose | Step |
|---|---|---|
| 1 | Toolkit | Catalogue + docs page + tier for all four packages |
| 2 | Toolkit | **Rebuild the rails** — silent if skipped, see below |
| 3 | Toolkit | Release, stage, upload |
| 4 | Ours | `npm run fns:bootstrap -- --force` — **silent if skipped**: a matching local copy is a deliberate no-op, so without `--force` the installer keeps bundling the older bootstrap |
| 5 | Ours | Bundle `FNS_Autosave.tox` (released and free by then; the build's NOTE will name it) |
| 6 | Both | Verify stocking against the REAL manifest, not the mock |
| 7 | Ours | Only then, the companion release |

**If step 2 is skipped, it looks like our bug.** The toolkit's installer
extension and its bootstrap builder both changed on the boundary branch, so a
published bootstrap built before a rails rebuild carries none of the command
rail — no `fns.install`, no `minimal`, no `source`. We would fetch with
`--force`, get a *correct digest for the wrong contents*, load it, see no
`fns.install` in the registry, and reasonably conclude the toolkit had not
shipped.

So: **if a forced fetch succeeds and a freshly loaded bootstrap still shows no
`fns.install`, suspect the rails rebuild before suspecting anything here.**
The digest proves the bytes are the published ones; it says nothing about
whether those bytes were rebuilt from current source.

### The offline path, and what it bundles

Two artifacts, both fetched and digest-verified by the same script:

* `release/FNSTools.tox` — the bootstrap. What an offline machine installs
  **with**: it carries `FNS_Installer` and `FNS_Updater`.
* `release/fns/*.tox` — capability artifacts. What it installs **from**.

**Only free, launcher-capable packages are ever bundled.** The predicate is
free-FIRST (`fns_store::package_bundleable`, mirrored in the script), because
that is the half which, if wrong, puts paid bytes inside a freely-downloadable
installer. A `seedable: true` that disagrees with `access` is refused, not
trusted — the toolkit's fail-closed default and this check are belt and
braces, not two copies of one belt.

The script also **removes** anything in `release/fns/` the current manifest no
longer calls seedable. A package that went gated, or lost its launcher block,
would otherwise keep shipping from a stale local copy — the same leak arriving
by the back door.

As of v3.0.14 that is exactly one package: `FNS_Autosave` (0.015 MB), beside
the 0.325 MB bootstrap. `release/FNSTools.json` records both, so what a given
installer carries is answerable from git — read it rather than this sentence,
which is a snapshot and will age.

### Verifying a gated stock (step 6)

The one leg no amount of reading settles: does a real entitled claim actually
fetch gated bytes? There is a harness for it — it needs the network AND a
signed-in machine, so it never runs in an ordinary `cargo test`:

```bash
cargo test --manifest-path src-tauri/Cargo.toml gated_stock_check -- --ignored --nocapture
```

It runs that chain against **every gated package the manifest declares**,
not a chosen one. `gate_package` on the toolkit side APPENDS to the worker's
tier map and never prunes, so a package RENAME can leave the old product
still granting entitlement to bytes that no longer exist AND the new name
missing from the map — and a single-package check sees neither. (v3.0.14
renamed `FNS_Media` to `FNS_MediaBrowser`, its map edited by hand, which is
exactly the shape that pays for the sweep.)

Per package, in order, and each step matters:

1. the claim carries the products (`entitled=true products=[...]`)
2. the artifact URL **refuses** an unauthenticated request — without this the
   200 below proves nothing
3. `download_token()` mints against the real gate
4. the Bearer is accepted **on the manifest's own URL** (no host rewriting —
   `storage.functionstore.tools/fnstools/plus/*` is a route on the same
   worker as the gate)
5. the bytes hash to the digest the manifest pins

It writes nothing: bytes are hashed in memory, so a failed run cannot leave a
half-file in the palette store.

**Passed 2026-08-31** on v3.0.14 — all four gated packages (`FNS_Collect`,
`FNS_MediaBrowser`, `FNS_Remote`, `FNS_TimelineTools`), each 401 without a
token and 200 with a matching digest. Re-run it after any rename or tier edit
on the toolkit side; it costs about four seconds.

### Re-importing FNS_CommandRegistry (when FunctionStore re-releases it)

The utility carries FunctionStore's released `FNS_CommandRegistry` package
VERBATIM -- built-ins, FNS_About and all -- and keeps a byte-identical copy at
`utility/TDXLauncherUtility/FNS_CommandRegistry.tox`. Their
`scripts/check_launcher_mirror.py` hashes that copy against
FNSTools `packaging/launcher_mirror.json`, and this release script runs
it, so a drifted copy blocks the release. Never edit the registry here; only
re-import. Their side records the same motion in `launcher_mirror.json`.

**Which artifact: the PUBLISHED store one, since 0.1.2 (2026-09-08).** Take
the `FNS_CommandRegistry` entry of the rolling manifest
(`packages[].artifact.url` + `sha256`), not the toolkit's `modules/release/`
PI-Release build. The two are the same source, but PI Release does not bump
`Pkgversion` while Publish does, so a PI build made before the publish
reports the previous package version -- and the launcher's built-ins then
lose arbitration to a store install of the very same commands. The store
build keeps `pi_suspect` tags on the root, the built-ins COMP and the three
ext DATs: strip them on import along with the strategy tags. The record's
`artifact` is `packaging/dist/...` and carries the bucket `url`;
`launcher_mirror.json` is hand-written (no script produces it), so rewrite
it as part of this step or the checker blocks staging.

The same rule covers `FNS_MainMenuRegistry` (the menu-bar icon host in
`ui_mod`, repo copy `utility/TDXLauncherUtility/FNS_MainMenuRegistry.tox`):
take the published artifact, never a PI-Release build of the same version,
because a tox export is not reproducible and two byte streams of one
`Pkgversion` would exist. It is nested, so `tdn_exclude` does not apply and
its interior is serialized into the `.tdn`; on re-import re-stamp the
Registration page (Comp `ui_mod/select1`, canonical `TDXLU`, Align right),
bind `Displayed` UP to the companion's `Menubaricon`, set `FNS_About.Owner`
to `parent()`, and PULSE `Register`.

**Why the pulse, and why it must stay even though a save would hide the
need for it.** `Autoregister` is already on inside the tox, so that parameter
never CHANGES and `onParAutoregister` never fires -- nothing self-triggers.
The toolkit does compensate: `RegistryBase._reapplyAutoregisterHosts()` sweeps
for hosts the global has no entry for and asks them to republish. But it runs
only on the `/sys` global and only `BOOT_SWEEPS = 6` times, because it is a
project-wide `findChildren` that cannot run forever -- so it is a BOOT window,
and a host destroyed and re-loaded mid-session arrives long after those six
ticks are spent (FunctionStore traced this 2026-09-11; their backlog item 28,
commit 69359224, is the real fix: publish from the host's own init).

The trap is the counter: it is an instance attribute reseeded by any extension
reinit wave, and `project.save()` causes one. So load-then-save gets picked up
with no pulse, while load-then-verify does not. Our order is pulse, verify,
save -- someone who reorders it will see registration "work" without the pulse
and conclude it is unnecessary, then be wrong the next time the order changes.
Pulse explicitly: it is deterministic, and a save side effect is not something
a release recipe should lean on.

Without it the entry stays with the DESTROYED host -- `Regstatus` reads "Idle"
and the global's entry still carries the dead host's `source_registry_id`.
Reproduced twice, on two package versions.

1. **Verify the artifact first**: sha256 against `launcher_mirror.json`, then
   load it into `/sys/quiet` (cooking OFF) and check no `file` bindings, no
   PI tags, `externaltox` empty. A cooking-disabled load proves it PARSES,
   not that it WORKS -- extensions do not init there. Step 4 is the real test.
2. **Copy** it to `utility/TDXLauncherUtility/FNS_CommandRegistry.tox`.
3. **Destroy, let frames pass, then load** -- in SEPARATE calls. Destroying
   the promoted registry's master and `loadTox`ing the replacement in the
   same script crashed TD outright (the extension was mid-teardown while the
   `/sys` incumbent still pointed at it). Load FROM the repo copy, at the
   old position, same name `FNS_CommandRegistry`.
4. **Verify live, cooking-enabled**, a few hundred frames later:
   `op.FNS_COMMANDREGISTRY` resolves, `Version()` as recorded, 38 built-ins
   with 38 canonical ids, `Shadowed() == []`, owners' `Pkgversion` equal to
   FNS_About's, utility `errors(recurse=True) == []`.
5. **Make it opaque to Embody** -- three things, all needed:
   - tag the COMP `tdn_exclude`. Works ONLY on a direct child of the TDN
     boundary (which this is): the subtree is skipped outright and preserved
     through the save's strip/clear. Nested, the tag is ignored with a warning.
   - strip Embody strategy tags (`py`, `txt`, `tsv`, `json`, `xml`, `glsl`,
     `tdn`, `dat`) AND `pi_suspect` from every op inside it, and clear any
     `file`/`syncfile`. Do it in the SAME call as the load, before any
     save: the 0.1.1 import left the two owner DATs tagged `py` and the
     next save externalised them into this repo again.
     The artifact's DATs arrive tagged `py` from THEIR Embody, and ours
     honours the tag by externalising them into this repo on the next save.
   - `externaltox = 'TDXLauncherUtility/FNS_CommandRegistry.tox'` with
     `enableexternaltox` OFF. TD must never reload or re-save that file, or
     the sha the checker compares stops meaning anything.
6. **Save**, then confirm: the `.tdn` contains none of the artifact's
   interior, `externalizations.tsv` has no `FNS_CommandRegistry` rows, the
   repo copy's sha is unchanged. Remove any orphaned `.py` a previous import
   left under `utility/TDXLauncherUtility/FNS_CommandRegistry/`.
7. **Re-export the companion** (`ExportPortableTox`), load the result into
   `/sys/quiet` and confirm the registry, both owners and `FNS_About` are
   inside it; then stage. `ExportPortableTox` clears `externaltox` in the
   shipped tox, which is correct -- a user's project has no repo copy.

### Two things that look like breakage and are not

* **The toolkit's REPO `manifest.json` has an empty `rails` block.** Rails are
  hashed in when the toolkit stages a release, so only the staged/published
  manifest carries them. This script reads the ROLLING published manifest and
  is unaffected — but someone eyeballing the repo copy will see no rails and
  conclude the fetch is broken.
* **`launcher` arrives in two shapes.** The published manifest OMITS the key
  for a package that has no launcher surface; the installer's live
  `available()` always EMITS it, as `null`. Both mean "not launcher-capable",
  and both are covered by tests — but a client that only tolerates one will
  break on the other.

**`release/FNSTools.json` is the record of what shipped** — release tag, sha,
size, URL, fetch time. Read it when asking "which toolkit does this installer
carry?".

## Utility channel (TOX only)

No build, no compiler, no signing key — one machine does everything. After the
usual bump / TD re-export / commit sequence (see
[releases-r2.md](releases-r2.md#releasing-the-utility-tox) for the staleness
gates):

```bash
npm run release:prepare-utility
npm run release:publish -- --only utility --dry-run
npm run release:publish -- --only utility
```

## App channel

Two machines, two commands each, no files moved between them. Each machine
builds and uploads its own platform; the manifest goes live only when both
have shipped.

### 1. Release commit

Bump the version in all three places (`src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, `package.json` — they must agree), update
`RELEASE_NOTES.md` (it becomes the `notes` field the in-app updater shows),
commit, and check out that exact commit on both machines. Tag it
(`git tag v0.x.y && git push origin v0.x.y`) — since 2026-09-08 the tag no
longer triggers a CI build, it is history only.

### 2. On each machine

Both need the updater private key at `~/.tauri/tdxlpp_updater.key` (or
`TAURI_SIGNING_PRIVATE_KEY` exported), and the R2 variables from the
Prerequisites section. macOS also sources its Apple credentials first.

macOS:

```bash
source scripts/local-signing-env.sh
npm run release:build
npm run release:ship
```

Windows (Git Bash or PowerShell — the script sets the empty signing password
itself, so the PowerShell trap below cannot bite):

```powershell
npm run release:build
npm run release:ship
```

`release:build` fetches the FNSTools bootstrap, runs the signed
`tauri build --target <this machine>`, notarizes the dmg on macOS, signs any
bundle the build left without a `.sig`, and collects the shippable files into
`artifacts/<platform>/`. `release:ship` stages that platform, uploads it, and
publishes a `platform.json` fragment (signature + url) beside the artifacts.

Whichever machine ships **second** finds the other platform's fragment in the
bucket, writes the merged `latest.json` with both platforms, and uploads it
last — that upload is what makes the release live. The first machine's ship
prints `latest.json NOT written -- still waiting for: <platform>` and exits 0;
that is the expected state, not a failure. Order does not matter, and
re-running on either machine is safe.

Publishing deliberately without a platform:
`node scripts/prepare-release.mjs artifacts --notes RELEASE_NOTES.md --platforms darwin-aarch64`
then `npm run release:publish -- --only app`. Installs on the omitted
platform stay on their current version; their manual update check shows an
error until a manifest with their platform lands.

### What the scripts guard

- `prepare-release` refuses a platform directory with no `.sig`, and a
  Windows directory whose `.sig`s do not include the NSIS `.exe` — the `.exe`
  is both the updater target (existing installs came from NSIS) and the
  website's stable download. An `.msi` alone is not a Windows release.
- `latest.json` is uploaded last, after every artifact it references.
- Do not use `npm run tauri:build` for a release — that is the CI-overlay
  build (`tauri.ci-artifacts.conf.json`), which disables updater artifacts.

### Signing by hand (only if a build hung or was made another way)

`release:build --collect-only` re-signs and re-collects whatever an earlier
`tauri build` produced. The manual equivalent, once per `.exe`/`.msi`:

```bash
npx tauri signer sign --private-key-path "C:/Users/<you>/.tauri/tdxlpp_updater.key" --password "" "<bundle>"
```

> **PowerShell trap** (for anyone running `tauri build` directly):
> `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""` REMOVES the variable, so the
> signer prompts and an unattended build hangs after "Finished 2 bundles".
> `release:build` avoids this by setting the variable inside node.

`TAURI_SIGNING_PRIVATE_KEY` accepts either a file path or the key contents.
The Windows machine needs its own copy of the key — it is the updater's
**private** signing key, so move it privately (AirDrop, USB stick, password
manager attachment), never through chat, email, or the repo. Its `.pub` must
match `plugins.updater.pubkey` in `tauri.conf.json` (see
[releases-r2.md](releases-r2.md#6-confirm-the-signing-key)).

## Afterwards

- **Still tag.** `git tag v0.x.y && git push origin v0.x.y` keeps the release
  history intact. With zero minutes the tag-triggered workflow simply won't
  run — harmless. If the failure emails annoy you, disable the workflows
  under repo Settings → Actions until minutes reset.
- **Verify like a client would:** fetch
  `https://<release-host>/app/latest.json` (or `utility/latest.json`) and
  check the version, then run *About → Check for updates* in an installed
  build.
