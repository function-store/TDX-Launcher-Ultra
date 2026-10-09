# Releases on Cloudflare R2

Both update channels are served from one R2 bucket, and they move
**independently**:

| Channel | What ships | Trigger | Needs a build? |
|---|---|---|---|
| **App** | Installers + Tauri updater manifest | tag `v0.3.1` | yes (Windows + macOS) |
| **Utility** | `TDXLauncherUtility.tox` + its manifest | tag `utility-v0.3.1` | no |

That split is the point: fixing something in the companion TOX is an upload,
not an app release. Launchers already installed pick it up on their next check
and never touch the app binary.

> **Why not GitHub Releases?** The repo is private, so release assets there need
> an auth token — the in-app updater could never reach them. R2 objects are
> public and unauthenticated.
>
> (The GitHub remote is still `function-store/TDXLPP`; only the product was
> renamed to TDX Launcher Ultra. Nothing in the release path depends on the repo
> name, so renaming it later is safe.)

## Bucket layout

```
app/latest.json                                    Tauri updater manifest
app/v0.3.1/windows-x86_64/TDX Launcher Ultra_0.3.1_x64-setup.exe
app/v0.3.1/windows-x86_64/TDX Launcher Ultra_0.3.1_x64_en-US.msi
app/v0.3.1/darwin-aarch64/TDX Launcher Ultra.app.tar.gz
utility/latest.json                                version + url + sha256
utility/v0.3.1/TDXLauncherUtility.tox
```

Artifacts sit under a **platform directory**, not flat under the version. Tauri
names a macOS updater bundle `<productName>.app.tar.gz` with no architecture in
the filename — the directory is what disambiguates it, which mattered when
this shipped both arm64 and x64 macOS builds (still relevant if Intel is ever
added back). `.sig` files are not uploaded; their contents are inlined into
`latest.json`, which is what the updater reads.

Only `darwin-aarch64` (Apple Silicon) ships for macOS as of the release after
v0.5.0 — the Intel leg (`darwin-x86_64`) was dropped since Apple hasn't
shipped an Intel Mac since 2023 and GitHub is retiring Intel macOS runners
around Fall 2027. Existing Intel Mac installs stop seeing updates; nothing
else about the release path changes.

Versioned paths are immutable and cached for a year. The two `latest.json`
manifests are uploaded `no-cache` and **last**, after every object they
reference — publishing a manifest is what makes a release live, so it must
never point at something that has not landed yet.

## One-time setup

### 1. Create the bucket

Cloudflare dashboard → **R2** → *Create bucket*. Any name; `tdxlu-releases`
below. Location: Automatic.

### 2. Make it publicly readable

R2 → your bucket → **Settings** → *Public access*. Either:

- **Custom domain** (recommended) — *Connect Domain*, e.g.
  `dl.functionstore.xyz`. Needs the zone on your Cloudflare account. You get a
  stable host you can re-point later, and Cloudflare CDN caching.
- **r2.dev subdomain** — *Allow Access*, giving
  `https://pub-<hash>.r2.dev`. Zero setup, but the hostname is not yours: if
  you ever move providers, every shipped launcher keeps polling a dead host.

No CORS rules are needed. The updater and the utility downloader are native
HTTP clients, not browser fetches.

### 3. Point the app at the host

```bash
npm run set-release-host https://dl.functionstore.xyz
```

This writes the host into **both** places that hardcode it — the updater
endpoint in `src-tauri/tauri.conf.json` and `DEFAULT_RELEASE_BASE` in
`src-tauri/src/updates.rs`. A unit test (`endpoint_matches_release_base`) fails
`cargo test` if they ever drift apart. Commit the change.

Until this is run, both files read `https://REPLACE-ME.r2.dev` and the release
scripts refuse to stage anything.

### 4. Create an R2 API token

**Use the account-level token flow, not the R2-specific one.** Cloudflare
profile icon → **My Profile** → **API Tokens** → *Create Token* → *Custom
Token* → permission **Account → Workers R2 Storage → Edit**, scoped to your
account. Copy the token value — it is shown once.

Do **not** use R2 → *Manage R2 API Tokens* for this. That flow issues a
bucket-scoped "Object Read & Write" token plus S3-compatible credentials —
it looks equivalent and is what an earlier version of this doc pointed at,
but `wrangler r2 object put` (what `publish-r2.mjs` shells out to) rejects
it with a generic `403 Authentication error [code: 10000]` regardless of
the account ID or how many times the token is rolled. Only the account-level
Workers R2 Storage token works with wrangler's non-interactive, token-in-env
auth path. (S3-compatible clients using the Access Key ID/Secret from the
R2-specific flow would work fine — this project just doesn't use one.)

### 5. Add the repo secrets and variable

`gh` from the repo root, or Settings → Secrets and variables → Actions:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh variable set R2_BUCKET --body tdxgl-releases   # the live value: the bucket kept the old product name
```

`CLOUDFLARE_ACCOUNT_ID` is in the R2 overview sidebar.

### 6. Confirm the signing key

The app channel needs `TAURI_SIGNING_PRIVATE_KEY` — the minisign key whose
public half is the `pubkey` compiled into `tauri.conf.json`. **Check before you
touch anything**; for this repo the answer is already yes on all three:

```bash
gh secret list | grep TAURI_SIGNING_PRIVATE_KEY   # secret present?
ls ~/.tauri/*.key                                 # local copy present?
```

Confirm the local key is *the* key — its `.pub` must match `pubkey` exactly:

```bash
node -e "const c=require('./src-tauri/tauri.conf.json');console.log(c.plugins.updater.pubkey)"
cat ~/.tauri/tdxlpp_updater.key.pub
```

(The file is still named `tdxlpp_updater.key` — the filename is cosmetic and the
rename deliberately left it alone. What matters is the key material.)

If all three check out, **there is nothing to do here.** Skip to releasing.

<details>
<summary>Only if the key is genuinely lost</summary>

Regenerating produces a **different** keypair. Every installed copy verifies
against the public key baked into the binary it is already running, so a new key
means those copies can never accept another update — users must reinstall by
hand. You must also replace `pubkey` in `tauri.conf.json` with the new public
half, or *nothing* will verify, including fresh installs.

```bash
npx tauri signer generate -w ~/.tauri/tdxlu.key -p ""
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/tdxlu.key
# then paste the contents of ~/.tauri/tdxlu.key.pub into tauri.conf.json → plugins.updater.pubkey
```

`-p ""` sets an empty passphrase, which is what `release.yml` expects
(`TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""`). Without `-p`, minisign prompts
interactively — pressing Enter twice is the same thing. Choosing a real
passphrase means adding it as its own secret and wiring it into the workflow.

</details>

The utility channel needs no signing key; it is verified by SHA-256 from the
manifest.

## Releasing the app

```bash
# 1. Bump the version in all three places (they must agree)
#    src-tauri/tauri.conf.json  ·  src-tauri/Cargo.toml  ·  package.json
# 2. Commit, then tag
git tag v0.4.0
git push origin v0.4.0
```

`release.yml` builds on `windows-latest` and `macos-latest` (Apple Silicon
only — the Intel leg was dropped, see the note in the "Bucket layout"
section above), signs each bundle, then a publish job merges both into one
`app/latest.json` and uploads. Watch it with `gh run watch`.

Update `RELEASE_NOTES.md` at the repo root before tagging — `release.yml`
passes it to `prepare-release.mjs --notes`, so its contents become the
`notes` field in `app/latest.json` and are what the in-app updater shows.

Each build job uploads its bundles under an artifact named for its Tauri
platform key (`windows-x86_64`, `darwin-aarch64`), because Tauri names the
macOS updater bundle `<productName>.app.tar.gz` with no architecture in it —
the filename cannot say which build it is, so the directory does.

## Releasing the utility TOX

No app release, no signing key, no compiler:

```bash
# 1. Bump BOTH, to the same value:
#      utility/UTILITY_VERSION
#      utility/TDXLauncherUtility/TDXLUUtilityExt.py  → UTILITY_VERSION
# 2. Re-export the .tox from TouchDesigner so it contains the new extension,
#    with its FIRST parameter page current (see below)
# 3. Commit, then tag
git tag utility-v0.4.0
git push origin utility-v0.4.0
```

Step 2 is the one that gets forgotten, so the staging script blocks on it twice.

**The tox opens on the page it was exported on.** TouchDesigner saves the
COMP's current parameter page inside the `.tox`, so whatever page was last
open in the dev project is what every user sees first (0.23.7 shipped on
Envoy). Make the first page current right before exporting, and check it in
the `/sys/quiet` verification load:

```python
u = op('/TDXLauncherUtility')
u.currentPage = u.customPages[0]          # Launcher
# ... ExportPortableTox(u, save_path=...) ...
# verify: the loaded copy's currentPage.name == u.customPages[0].name
```

`ExportPortableTox` keeps the page (measured 2026-10-06), so setting it
before the export is enough.

**Both text versions must agree.** `utility/UTILITY_VERSION` and the extension's
`UTILITY_VERSION` are cross-checked; a mismatch fails the release.

**The `.tox` must not predate the bump.** The version a *running* utility reports
over the TCP bus is baked into the extension copy **inside the .tox**, and only a
TouchDesigner re-export updates it — editing the `.py` on disk does not. That
version can't be read back to verify (a `.tox` is TD's own compressed binary
container, not a zip), so git is used as the proxy: if the version files were
committed more recently than the `.tox` — or are dirty while the `.tox` is
clean — the release is blocked.

Both checks guard the same failure: the launcher compares the manifest version
against what the running utility reports. If the manifest says 0.4.0 but the
shipped `.tox` still says 0.3.0, every launcher installs it, sees 0.3.0 again,
and re-offers the identical update **forever**.

`--skip-tox-check` overrides the staleness check for the case where the `.tox` is
genuinely current but git can't tell (e.g. re-exported byte-identical). Do not
reach for it to make a red release go green.

## Manual / local publishing

The same scripts run locally. Set `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` and `R2_BUCKET` in your shell first.
For a **full release with no CI at all** (e.g. out of Actions minutes) —
including building the app channel on local Mac + Windows machines and merging
the artifacts — see [releases-local.md](releases-local.md).

```bash
npm run release:prepare-utility        # stage into ./dist-release/
npm run release:publish -- --only utility --dry-run
npm run release:publish -- --only utility
```

For the app, `--only app` after staging with
`npm run release:prepare -- <artifacts-dir>`. A local run only produces
artifacts for the OS you are on, so a full app release still wants CI.

`--dry-run` prints every key, size and content type without uploading. `npm run
set-release-host` with no argument prints the currently configured host.

## Testing against a staging bucket

A dev build reads `TDXLU_RELEASE_BASE` at runtime and prefers it over the
compiled-in host, so you can point the **utility** channel somewhere else
without rebuilding:

```bash
TDXLU_RELEASE_BASE=https://pub-staging.r2.dev npm run tauri:dev
```

The app updater endpoint is compiled into the binary by Tauri and does **not**
honour this — testing the app channel needs a real build with the staging host
set via `npm run set-release-host`.

## How clients consume it

**App** — `tauri-plugin-updater` fetches `app/latest.json` 4s after launch and
on *About → Check for updates*, matches the `platforms` key for the running
OS/arch, verifies the minisign signature against the compiled-in public key,
then downloads and relaunches.

**Utility** — `src-tauri/src/updates.rs` fetches `utility/latest.json`, compares
against the *effective* utility version, and on accept downloads the `.tox`,
verifies its SHA-256, and stores it in `<config>/utility/`. From then on the
effective utility — what *Install to Palette* copies and what the Toolbox drag
handle serves — is that download rather than the copy inside the installer.

The manifest is re-fetched inside the install command rather than passed in
from the frontend, so the digest that gets enforced is always the one the
server published.

A newer app reclaims the channel automatically: if an installer ever bundles a
TOX newer than the last download, the bundled copy wins the comparison again
and the stale download stops being used.

The channel is also the **first-install** path, not only the update path. A
build holding no TOX at all — a dev build, or one where the bundled resource
was stripped — reports `available` regardless of how the versions compare, and
*Download Utility TOX* in Help and the Setup Wizard fetches through it. (Those
buttons used to open a GitHub release of the predecessor project,
`TD-Launcher-Plus`, which post-rename pointed at an asset that does not exist.)
