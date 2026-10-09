---
status: agreed -- accepted with conditions by the gate side 2026-08-29 (FNSTools docs/TDXLUGateIntegration.md: G1-G5 accepted, G6 conditional on §4). AMENDED 2026-08-30 -- the trial AND the Gumroad/license-key surface are DROPPED from TDXLU (§3.2): pro capability is headed for delivery through FNSTools Plus (work order to come), and any Gumroad-entitled product is an FNSTools package on the toolkit's rail. G2 (/trial/start) and G3's GUMROAD_PRODUCTS row are no longer requested by this product; TDXLU is Patreon-only. ADDED same day: the device token becomes a SHARED machine session between FNSTools and TDXLU (§5) -- one sign-in on a machine serves both; toolkit-side rules are work item G7 (landed & accepted same day — ExtAuth and its acceptance landed on the FNSTools side; the joint adopt/sign-out walk folds into L5).
summary: Point TDXLU's licensing at the FNSTools entitlement gate instead of its own baked-in secrets -- the same Patreon client, the same Worker, the same Ed25519 keypair, with one new route (/entitlement), a per-product KV namespace, and an optional gated-delivery rail for companion tools. Patreon-only; no trial, no license keys.
since: branch paletting, 2026-08-28 -- written out of the ship audit (SEC-02, SEC-03)
canonical: FunctionStore_tools_PUB `worker/` -- the gate is the source of truth for every route below. This document specifies only what TDXLU needs from it and what TDXLU must change to consume it. Nothing here belongs in a second Worker.
blocked-on: RESOLVED 2026-08-29 -- the gate is deployed and the paid path was walked end to end on a customer-shaped install. Worker-side TDXLU routes may be built and tested any time; TDXLU goes LIVE on the gate only after the FNS funnel plan's 0.5 (bootstrap in-pass download wedge) is closed and v3.0.x has survived its first strangers.
---

# Contract: TDXLU on the FNSTools gate

The launcher currently ships its own licensing stack: a Patreon OAuth flow
that holds the client secret in the executable, an HMAC-signed local auth
file, and a Firebase Functions deployment for the 14-day trial. The FNSTools
gate already solves the first two properly; the third is simply **dropped**
(2026-08-30) — TDXLU offers no trial, and pro capability is headed for
delivery through FNSTools Plus (work order to come). This document is how
the launcher moves onto the gate.

**Nothing has shipped yet.** There are no installs carrying the old auth file,
no users mid-trial, no migration to write. This is the cheapest this change
will ever be, and every week of delay adds installs that would need a
migration path.

## 1. What this retires

Three findings from the ship audit, closed by one integration:

| Retired | Today | After |
|---|---|---|
| `PATREON_CLIENT_SECRET` in the binary | Recoverable with `strings` on the shipped `.exe`; the *same* client as TDMap, so a leak compromises both | Lives only as a `wrangler secret`. The launcher becomes a public client that holds nothing |
| `AUTH_INTEGRITY_KEY` (HMAC) in the binary | Anyone holding it forges a signed, machine-bound auth file — permanent free Pro, offline, no server contact | Ed25519. The launcher ships only a **public** key; verifying mints nothing |
| The trial backend | Own Firebase project, public invoker, client-supplied fingerprint, no rate limit, no cap | Gone entirely — the trial is dropped, not migrated (§3.2) |

A fourth, unlisted in the audit and worth naming: the local auth file today
stores the Patreon **`access_token` and `refresh_token`** in plaintext
(`licensing.rs` ~line 855). Under the gate the refresh token never leaves the
Worker's KV; the client holds an opaque device token that can be revoked.

## 2. What already exists — do not rebuild any of it

The gate lives at `gate.functionstore.tools` (storage at
`storage.functionstore.tools`). It already answers these paths, and TDXLU uses
them **unchanged**:

| Route | Method | Used by TDXLU |
|---|---|---|
| `/health` | GET | reachability probe |
| `/pubkey` | GET | `{ok, alg: "EdDSA", spki}` — the exact SPKI claims verify against (cache 1 h); canonical source for `GATE_PUBLIC_KEY` |
| `/patreon/start?port=&cn=` | GET | opens the consent page; the gate holds the secret |
| `/patreon/callback` | GET | Patreon redirects here; the gate exchanges the code and redirects back to `http://127.0.0.1:<port>/fns-auth?code=<grant>&cn=<nonce>` |
| `/session/claim` | POST | `{code}` → `{ok, device_token}`, exactly once |
| `/gumroad/redeem` | POST | **not used** — dropped 2026-08-30 with the key surface. Any Gumroad-entitled product is an FNSTools package on the toolkit's rail |
| `/session/recheck` | POST | Bearer = device token; forces past the 6 h entitlement cache (throttled). Its answer carries structure the client must honour — see §6 |
| `/session/revoke` | POST | Bearer = the device token revoking itself |
| `/token/download` | POST | device token → a short-lived signed download token. Used **only** if gated companion tools happen (§4); unused otherwise |
| `/fnstools/plus/...` | GET | **not used** — that prefix is the toolkit's. The launcher's own gated prefix is §4 |

Along with them come the decisions already paid for and already tested
(70+ offline checks in `gate.test.mjs`, grown four times during the deploy
weekend), which TDXLU inherits rather than re-litigates:

* The claim is a **product list, never a boolean** — the DOTsimulate failure.
* Gumroad is **perpetual and never re-checked**; Patreon re-checks every 6 h.
  (Gumroad is the toolkit's concern — TDXLU redeems no keys — but the cadence
  shapes the shared session model.)
* A 4xx from Patreon is permanent and clears the tiers; a 5xx is transient and
  keeps the last answer with a shorter retry. `verified_at` sits beside
  `checked_at` so a session unverified for 30 days stops being trusted.
* The loopback listener receives a **one-time grant code**, never the device
  token — a token in a query string lands in browser history.
* **The manifest carries a routes projection**: the toolkit block ships the
  tier ladder *with labels* (Base/Pro/Coaching), `support_url`, and per-package
  `key_available`. UI copy like "unlocks at the Pro tier" reads that
  projection instead of hardcoding labels.

## 3. What TDXLU adds — the only new server code

One route and one config entry (the trial route was dropped — §3.2 — and
the Gumroad row with the key surface). Everything else is reuse.

### 3.1 `POST /entitlement`

`/token/download` generalised: same session load, same `refreshEntitlement`,
but it returns a **signed entitlement claim** instead of a download token, and
it does not require a non-empty product list (a lapsed session must be able to
learn that it has lapsed).

```
Authorization: Bearer <device_token>
{ machine: "<sha256 of the client machine fingerprint>" }   // opaque passthrough
-> 200 { ok: true, claim: "<JWT>", products: [...], kind: "patreon"|"gumroad"|"trial" }
-> 401 { ok: false, error: "signed_out", message: ... }
```

The JWT payload, signed `EdDSA` with the existing keypair:

```json
{ "iss": "fnstools", "sub": "<sha256 of device token>",
  "machine": "<sha256 of the client machine fingerprint>",
  "kind": "patreon", "products": ["TDXLU_Pro"],
  "trial_expires_at": null, "iat": 0, "exp": 0 }
```

**`exp` is per kind, and this is the part that must not be got wrong.** The
launcher's promise is *activate once per machine, day-to-day paid use never
phones home* — a 15-minute token like `/token/download`'s would break it:

| kind | `exp` | Why |
|---|---|---|
| `gumroad` | far future (10 y) | FNSTools' concern; TDXLU sessions are never this kind (no key surface) |
| `patreon` | +180 d, renewed on any successful re-check (a `/session/recheck` success is the natural trigger — refresh the cached claim via `/entitlement`) | Matches `PATREON_SESSION_TTL`; an install in use never expires, an abandoned one ages out |
| `trial` | the trial end instant | FNSTools' concern if it ever mints trials; TDXLU sends none (§3.2) |

`machine` binds the claim to the install, so copying the cached file to another
PC fails exactly as the HMAC scheme intended — but now unforgeably. The value
is a hash of a **client-computed** fingerprint the gate cannot verify and
treats as opaque, by design — honesty-box, the same tier of protection as the
HMAC scheme it replaces.

**An issued claim outlives revocation until its `exp`.** Revoking the session
stops *new* claims being minted, never outstanding ones. That is consistent
with "purchase gate, not DRM" (§4.4), and it is stated here so it is a
decision, not a surprise. (For TDXLU the window is at most 180 d of Patreon
claim; the sharp 10-year case is the toolkit's Gumroad kind.)

> This route also answers **`EntitlementLifecycle.md §2.2`**, which is open on
> the FNS side ("how literal is offline?"). A signed perpetual claim verified
> against the pinned public key with no round trip is the shape that document
> says is "different and better", and it dissolves §3.1's durability problem
> for Gumroad: the KV row stops being the only copy of the licence.

### 3.2 `POST /trial/start` — DROPPED (2026-08-30)

TDXLU no longer offers a trial, so this route is **no longer requested** —
the gate side's G2 (Turnstile-gated `/trial/start`, the `trial:<fingerprint>`
KV anchor) can be skipped or built for another family product on its own
merits; the design as reviewed lives in the git history of this file and in
`TDXLUGateIntegration.md`. The decision: pro capability is headed for
delivery **through FNSTools Plus** (a work order for integrating that back
into the TDXLU app will follow), so a TDXLU-minted trial window would be a
second entitlement surface for a product boundary that is about to move.
With it go the Firebase backend (dropped, not migrated), the Turnstile
sitekey, and the trial's whole client machinery.

**The Gumroad/license-key surface is dropped too** (same day): pro applies
through the Patreon ladder only, and any Gumroad-entitled product is an
**FNSTools package governed by the toolkit's rail** (§4.1 already sends it
there). TDXLU redeems no keys — the key input, the gate-routed redeem, the
friend code, and the activation-failure guard are all gone. An install is
signed in with Patreon or it is on the free tier.

### 3.3 Config

`TIERS` in `wrangler.toml` gains the launcher's product against the campaign
tier ids the launcher already gates on (`licensing.rs`
`PATREON_ENTITLING_TIER_IDS`):

```toml
TIERS = """
{
  "8323905": ["FNS_TimelineTools", "TDXLU_Pro"],
  "8291595": ["FNS_TimelineTools", "TDXLU_Pro"],
  "9796651": ["FNS_TimelineTools", "TDXLU_Pro"]
}
"""
```

No `GUMROAD_PRODUCTS` row: the key surface is dropped (§3.2), so the gate
side's G3 shrinks to the `TIERS` rows above plus the second KV namespace.

## 4. Gated companion tools — optional, and separable from the rest

Everything above stands whether or not any launcher tool is ever gated. This
section is the delivery mechanism if some are (the standing example: the media
tools). It is deliberately its own section because it is the one part with a
real cost, and it should be possible to decide against it without unpicking the
licensing work.

### 4.1 The decision rule: which rail a tool belongs on

**Does the tool make sense in TouchDesigner without the launcher?**

* **Yes** → it is an **FNSTools package**. Author it in the toolkit
  project, mark it `access: <tier id>`, and it ships on the toolkit's existing
  rail with nothing new built anywhere. `fns_store.rs` is already a client of
  that manifest.
* **No** → it is a **launcher companion module** and ships on the
  launcher's own rail (§4.2). Do not push a launcher-only tool into the
  toolkit picker: FNSTools users who do not have the launcher would see it,
  and it would have to work standalone, which a tool driving a session over the
  companion's TCP bus does not.

The media tools are the second case. They act on a *running session* through
the companion, so they are launcher-owned and stay where they are authored.

### 4.2 The launcher's own gated prefix

`updates.rs` already fetches `utility/latest.json`, verifies SHA-256 and stores
the result; `fns_store.rs` already does the same against the toolkit manifest.
Neither needs replacing. The manifest gains modules:

```json
{ "version": "0.21.0",
  "url":     "<base>/utility/v0.21.0/TDXLauncherUtility.tox",
  "sha256":  "...",
  "modules": [
    { "name": "TDXLUMedia", "access": "8323905",
      "url": "<base>/utility/plus/v0.21.0/TDXLUMedia.tox",
      "sha256": "...", "min_td_build": "2025.30060" }
  ] }
```

**Gated modules sit under `utility/plus/` on the SAME host as the free rail.**
This is not a preference. Artifact paths are derived by stripping the base off
the pinned URL and re-basing onto the configured base, which is what makes
mirror and `file://` rails work; a second host breaks that stripping for gated
rows only — the worst possible place for it to break. The gate serves that
prefix exactly as it serves `fnstools/plus/`, and its fail-closed rule applies
unchanged: a module the claim does not name is refused, never assumed free.

**One rail, and it is the launcher app. The utility never authenticates and
never downloads.** This is the sentence most likely to be implemented the wrong
way, so it is stated flatly: the desktop app holds the device token, makes every
gate call, verifies every digest, and hands the companion a **local path** over
the bus it already speaks. `load_tox` is an existing companion action and
`commands.rs` already carries the precedent — the free-tier exemption "extends
to `load_tox` WHEN the artifact lives in the FNS palette store (the shelf's
place action)". A gated module is that same motion with an authenticated fetch
in front. Nothing new goes inside TouchDesigner.

*Why not a rail in the companion, when FNSTools has one?* `ExtAuth.py` gives
its own reason: "the updater is the only thing in TouchDesigner that touches
the network, so the credential belongs beside it and nowhere else." FNSTools
has no desktop app, so TD is the only client it could put the credential in.
The launcher does have one, already holding the token and already speaking the
manifest. And the asymmetry that settles it: **the companion is dragged into a
`.toe` and that file travels.** FNSTools components are installed per machine
from the palette; ours ship inside projects users hand to each other. A sign-in
client in the companion would mean every copy in the wild phoning the gate, and
a user asking why their *project* wants a Patreon login. Not a leaked-credential
problem — the token would sit in the OS keystore, and a stranger's copy simply
reads as signed out — but a second sign-in surface for no gain.

**The exception that would flip this:** a gated tool that must work with the
launcher not running. That is not a companion module at all; by §4.1 it is an
FNSTools package, and it rides the toolkit's rail with `ExtAuth` already built.
What must never exist is a *third* implementation. If one is ever written
anyway, take two things from `ExtAuth` rather than re-earning them: transport is
TD's **Web Client DAT, not urllib on a worker** (async by construction, cannot
block the frame — DOTsimulate froze TD with a blocking token exchange inline in
a Web Server callback), and a Web Server DAT with a **blank Local Address
listens on every interface**, not loopback, which briefly made their
`/fns-auth` network-reachable and it handed whatever `token` arrived straight
to the keystore.

**Two motions, and only one of them touches the network.** Conflating them is
the mistake this paragraph exists to prevent — a gated module must not mean a
fetch, or a valid session, every time the companion is dropped into a project.

| | Stocking | Using |
|---|---|---|
| When | sign-in, and when a version changes | every drop into a project |
| Network | yes | **never** |
| Gate session | required | **not consulted** |
| What happens | `POST /token/download` → short-lived signed token → `Authorization: Bearer` → fetch → verify digest → write to the store | read the store, hand the companion a local path |

**This is not a new lifecycle — it is the one the companion already has.**
`downloaded_utility()` reads a stored `.tox` plus its version from the app
config dir and `effective_utility()` prefers it over the bundled copy, so every
drop is already a local file copy with no network. `fns_store.rs` already
skips any download whose store digest matches the manifest, so a refresh moves
changed bytes only. Gated modules join that existing behaviour; they do not
introduce a second one. Stock once per version, drop offline forever.

**What a lapsed or offline user keeps.** Everything already in the store. The
toolkit's rule is explicit — *"A Patreon session may expire; the artifacts it
already fetched may not. A lapsed supporter correctly gets nothing new and
correctly keeps everything installed. The store is theirs."* Combined with §7's
fail-open rule, that gives the concrete guarantee: **a drop must never be
refused because the gate was unreachable, the claim had expired, or the user
signed out.** The only thing a lapsed session loses is the *next* version.

Surface the gate's refusal codes rather than inventing new copy —
`no_entitlement` already names the missing tier, which is why `refuse()`
returns a code *and* a message. Those refusals belong to stocking; nothing in
the using path should be able to produce one.

### 4.3 Rules inherited from the toolkit — do not rediscover these

Each was paid for once already (`PackagingScheme.md §5`,
`GatedDeliveryResearch.md`):

* **`access` names a TIER, not a boolean.** The gate is multi-tier, and the
  tier → packages map lives in the Worker and nowhere else, so no client
  can be edited into granting itself something. The field is safe to publish:
  the picker must show what is paid to be honest about what exists. What is not
  published is any means of getting the bytes.
* **`sha256` is pinned per release, not recomputed.** `.tox` export is **not
  reproducible** — one untouched component exported three times gave three
  hashes, diverging at byte 9, in the container header.
* **`min_td_build` per module.** An older TD loading a newer-build `.tox`
  returns nothing **silently** — no exception, no error flag — so without this
  the failure only surfaces after the installer has replaced the working copy.
* **Version is read live off the component**, never from a record of what was
  installed. It is the only thing that works for a package embedded in a
  `.toe`: no file to hash, no artifact to consult, but the component still
  declares what it is. The launcher already does this — `peer_utility_version`
  over the companion bus is the same idea; keep it, per module.
* **An absent module is a dormant slot, not an error.** The base companion must
  load, register and run with any gated module missing. RegistryScheme already
  gives this shape; it is still the part most likely to fail quietly, so it
  wants a test that loads the base with everything gated absent.

### 4.4 What this does not buy

**Gating controls distribution, not redistribution** — the toolkit's stated
position, and it applies here with extra force. The companion is copied into
the user's palette folder and dragged into a `.toe`, so a gated module ends up
inside a project file that travels to whoever the user hands it to. This is a
**purchase gate, not DRM**, which is the same thing `licensing.rs` already says
about the licence file.

Do not try to close it with per-user watermarked artifacts. Per-user bytes mean
a per-user hash, and the whole update scheme rests on the manifest pinning one
`sha256` to compare against — watermarking would break the integrity rail to
slow a leak it cannot stop.

**Cost to price in.** The `utility-v*` channel stays public and untouched,
which is the win over splitting the companion itself. But gated modules then
live on a different rail from the companion they extend, so "where did this
come from" has two answers, and the base-tolerates-absent-modules contract is
new surface that fails quietly when it fails.

## 5. Shared, and deliberately not shared

**One Worker.** Two would mean two copies of the Patreon secret, two keypairs,
two sets of throttles and two things to get right during a rotation. The whole
value here is that the hard part exists once.

**Two KV namespaces.** TDXLU binds its own, not `SESSIONS`.
`EntitlementLifecycle.md §3.1` is the reason: under §2 the KV row *is* the
licence, unreplicated, with no backup and no recovery path. A launcher
session row must not be able to land in the namespace that holds FNSTools'
perpetual licences. Share the code; isolate the data. (The trial rows that
made this argument sharpest are gone with §3.2, but the isolation stands —
two products' sessions in one namespace is still one `wrangler kv` mistake
away from cross-product damage.)

**One machine session, two consumers — agreed 2026-08-30 (pre-release, so
day-one contract rather than retrofit).** The Patreon grant is already
shared (one `TIERS` map; a claim lists every product its tiers reach), so
making a supporter sign in twice on one machine is pure friction. The
device token becomes a **machine** session both clients can present:

* **Location**: `<user palette>/FNSTools/config/gate-session.json` —
  beside `FNStools_config.json` in the config area the toolkit already
  owns. Deliberately NOT under `store/`: the store is contractually a
  bucket mirror where anything stale is purged, and a credential must
  never live somewhere a cleaner is allowed to delete.
* **Path caveat — RESOLVED 2026-08-30** (FNSTools side): the
  shared file's location is ALWAYS the machine-default user palette, on
  both sides — never a relocated Storefolder override. A Storefolder
  move affects the store only; the session file stays put, so sharing
  cannot silently diverge. (Same commit: ExtAuth's Sign-in now
  adopts-before-browser, mirroring the launcher — a TD session started
  signed-out picks up a later launcher sign-in at the click.)
* **Format**: `{ "schema": 1, "device_token": "...", "written_by":
  "fnstools"|"tdxlu", "written_at": <epoch> }`. The token and nothing
  else — claims stay per-client (each app calls `/entitlement` with its
  own machine hash and caches its own claim in its own config).
* **Rules, identical for both clients**: write it (atomically) on every
  successful sign-in; when you hold no session of your own, ADOPT it —
  present the token to `/entitlement` and cache the claim; if the gate
  answers `signed_out`, the token is dead — delete the file so the other
  client stops retrying too. On sign-out, revoke, then delete the file
  **only if it still holds the token you just revoked** (a different
  token means the other product re-signed-in; leave theirs alone).
* **A redeem publishes too** (mirrored from the landed ExtAuth
  implementation, 2026-08-30): any event that mints or extends a session
  writes the file — for the toolkit that includes a Gumroad key REDEEM,
  which is a sign-in for sharing purposes. TDXLU has no redeem surface
  (§3.2); its only minting event is Patreon sign-in.
* **Adoption may briefly show generic identity** (same mirror): an
  adopting client stores a placeholder label (`'supporter'`) until its
  first token response corrects the record — a freshly adopting product
  may momentarily display generic identity rather than the supporter's
  name or tier.
* **The file carries the opaque revocable device token in plaintext
  JSON — accepted pre-release.** Revocability is the backstop, and each
  product's own at-rest copy (the launcher's config, ExtAuth's DPAPI
  keystore) remains that product's own concern; the shared file does not
  change either side's at-rest posture.
* **Sign-out signs the machine out of both products.** That is the
  chosen semantics, stated so it is a decision and not a surprise: the
  token is shared, so revoking it revokes it everywhere. Precisely
  (walk-confirmed 2026-08-30): sign-out can only revoke the token it
  HOLDS — a product running on its own divergent token keeps its own
  session, and signs out separately. And propagation is bounded, not
  instant: the other product notices at its next gate contact — the
  toolkit's next token/recheck call, the launcher's next claim refresh
  (≤24 h cadence, or next launch) — where a definitive `signed_out`
  clears its local record. An outage never does; only the gate's own
  answer.
* **Backfill (both sides, 2026-08-30 — ExtAuth `70f5403`, launcher
  mirror):** an install already signed in when the shared file is absent
  publishes its held token, once per process/extension lifetime, so
  sessions predating G7 join the machine session without a fresh
  sign-in. This can republish a DEAD token (knowing would cost a gate
  round-trip); any adopter's first `signed_out` answer runs the guarded
  delete and the file self-heals.
* **ExtAuth's doctrine amends, not breaks**: "the credential belongs
  beside the updater and nowhere else" was written when the updater was
  the only consumer on the machine. With a second first-party product it
  becomes "the credential lives in ONE place both consumers know" — same
  principle, one secret location, no copies.
* **Toolkit-side work item** (theirs, call it G7) — **LANDED &
  ACCEPTED 2026-08-30**: ExtAuth writes / adopts / conditionally-deletes
  this file by the same rules (ExtAuth on the FNSTools side, acceptance
  recorded in `TDXLUGateIntegration.md`). Sandbox-verified: schema
  round-trip, foreign-token drop refusal, matching-token drop, adoption.
  Adoption there is once per extension lifetime, with entitlements
  filled via a deferred token request. **Still open to close G7 for
  real**: a joint live walk — adopt in both directions plus
  machine-wide sign-out. The launcher's side (L3+L4) is already live in
  `licensing.rs`, so that walk waits only on the gate's G1
  (`/entitlement` is what adoption presents the token to) and the
  `GATE_PUBLIC_KEY` fill — fold it into L5.
* **G7 sequencing (noted 2026-08-30):** G7 postdates the gate side's
  G1–G6 acceptance, but no formal acceptance round is required first —
  both products are pre-release with one maintainer, and both repos are
  local. The ExtAuth patch may be drafted from either side whenever
  convenient and offered as a proposal against this §5; acceptance is
  recorded in `TDXLUGateIntegration.md` when it lands, not before.
  Neither product depends on the other's timing: the launcher degrades
  gracefully without the file, and the toolkit is unaffected until
  ExtAuth opts in. *(This sequencing was exercised the same day it was
  written: drafted toolkit-side, landed `1f9fec5`, accepted `e1ef582`.)*

**One Patreon client, two redirect URIs.** Confirmed: the launcher and
FNSTools use the same registered client. Patreon permits multiple redirect
URIs per client, and the gate's `https://gate.functionstore.tools/patreon/callback`
is **already registered and live** (sign-ins ran through it 2026-08-29)
alongside the existing `http://localhost:16669/auth/callback` —
**TDMap, which shares this client and that loopback URI, is unaffected.** Do
not remove the loopback URI while TDMap still uses it. With three registered
redirect URIs on one client, a secret leak in ANY consumer compromises all —
retiring the launcher's embedded copy makes the gate the only secret holder,
which is the point.

One consequence to hold in view, from `EntitlementLifecycle.md §5.1`: getting a
`PATREON_CLIENT_SECRET` rotation wrong silently freezes every session at its
last known entitlement, and presents as "everything is fine". With two products
behind one gate, that blast radius covers both. This is an argument for one
carefully-managed secret over two casual ones — but it makes the gate
production infrastructure from the day the second product lands on it.

## 6. The client side — what changes in `licensing.rs`

> **Implemented 2026-08-30** (worklist L3+L4; trial and key surface dropped
> same day). Everything below is live in `licensing.rs`: the claim-based
> auth file with atomic writes, the `/fns-auth` loopback, recheck
> consumption, revoke-before-clear, and the shared machine session (§5:
> adopt-before-browser, write-on-sign-in, conditional delete on sign-out).
> No trial and no license-key machinery exists (§3.2) — Patreon sign-in is
> the ONLY activation path.
> `GATE_PUBLIC_KEY` was filled 2026-08-30 from the gate's `GET /pubkey`
> (live since worker 9ea13ff8, alongside G1 and the TIERS-only G3 —
> `TDXLU_Pro` rides all three tiers). Nothing waits on the gate any
> more: L5's walk is unblocked and is the last step before cutover.

**Deleted constants:** `PATREON_CLIENT_SECRET`, `PATREON_REDIRECT_URI`,
`AUTH_INTEGRITY_KEY`, `DEMO_API_BASE_URL`, `DEMO_API_KEY`,
`DEMO_API_KEY_HEADER`, `DEMO_FINGERPRINT_PREFIX`, `GUMROAD_VERIFY_URL` —
and with the key-surface drop, `FRIEND_LICENSE_KEY` and the `GUARD_*`
activation-failure limiter. `PATREON_CLIENT_ID` moved server-side with the
rest; the client no longer needs it.

**Added:** `GATE_BASE_URL` and `GATE_PUBLIC_KEY` (base64 SPKI Ed25519 — the
same value as the Worker's `JWT_PUBLIC_KEY`; publishing it mints nothing).
**The key is pinned at build time and NEVER fetched at runtime.** `/pubkey`
is a provisioning source for filling the constant; a client that fetched its
trust anchor live would let whoever controls the host mint claims for every
existing install, which is precisely what pinning exists to prevent. A key
rotation is therefore an app release, by design.

**Sign-in flow.** The loopback listener stays, and gets simpler — it no longer
handles an OAuth code:

0. **Adopt first** (§5): with no session of its own, present the shared
   machine session's token to `/entitlement` — an entitled claim means no
   browser at all. Only fall through to the dance below when there is
   nothing to adopt (or the adopted session is not entitled — a different
   account may be wanted).
1. Mint a client nonce `cn`, bind `127.0.0.1:<port>`.
2. Open `<gate>/patreon/start?port=<port>&cn=<cn>`.
3. The listener must answer **`/fns-auth`** (the path the gate redirects to),
   not today's `/auth/callback`.
4. Verify the returned `cn` matches — the gate's own `state` nonce protects the
   gate, not the listener.
5. `POST <gate>/session/claim {code}` → device token. Store it.
6. `POST <gate>/entitlement` → signed claim. Cache it.

The existing `state` check, the 300 s deadline, the "port busy — close TDMap's
sign-in" error and the `oauth_in_progress` guard all survive unchanged.

**Auth file.** Becomes: `{ device_token, claim, cached_at }`. No HMAC, no
`_sig`, no `_machine` (the claim carries it), no `access_token`, no
`refresh_token`. Verification is `Ed25519 verify` against `GATE_PUBLIC_KEY`,
then `exp` and `machine` checks. **Write it atomically** — see the ship audit's
DATA-01; a truncated auth file currently reads as unlicensed.

**`LicenseStatus`.** `entitled: bool` becomes derived, not stored:
`products.contains("TDXLU_Pro")`. *(Amended 2026-10-02: the launcher went free
in full and `TDXLU_Pro` retired; `entitled` is now "the claim names any
product", read as an active paid membership. The gate drops `TDXLU_Pro` from
`TIERS` only after the free release has shipped — 0.21.0 and older still
require it to sign in and to unlock their Pro surface.)* The gate's first design rule is that the
claim is a product list; the launcher should not re-flatten it to a boolean at
the boundary. Keep `block_reason`, and map the gate's `error` codes onto it —
`signed_out` and `no_entitlement` already name what is wrong, which is the
whole reason `refuse()` returns a code and a message.

**Re-check.** `/session/recheck` forces past the 6 h entitlement cache
(throttled), and its answer carries structure `LicenseStatus` consumes
verbatim, not re-derives:

* `connected: false` — the Patreon grant is dead and only a re-sign-in helps.
  Route the user to sign-in; do **not** keep offering "check again".
* `stale: true` + `verified_at` — this is the last known answer served during
  a Patreon outage, not a real "no". Surface it as staleness, never as a
  refusal.
* A successful recheck renews the cached claim via `/entitlement` (§3.1).

**`SignOut`.** Must `POST /session/revoke` before clearing the local file,
then delete the shared machine-session file if it still holds the revoked
token (§5). `EntitlementLifecycle.md §4` is explicit that not doing so means
signing out does not sign you out.

## 7. What must not change

* **The free tier never phones home.** Everything above is the *pro* path. The
  launcher's free feature set stays fully offline, activation-free, and
  unaffected by any gate outage. `enforced()` / `require_entitled()` keep their
  current shape.
* **A gate outage must not lock a paid user out.** The cached signed claim is
  valid until its `exp`; a failed re-check is not a revocation. This is the
  same rule as §5.1, and the client side of it is simply: never discard a claim
  because a request failed.
* **A drop is never gated at drop time.** Stocking the store needs a session;
  using what is stored does not, ever (§4.2). An offline, lapsed or signed-out
  user keeps dropping everything already fetched.
* **An issued claim outlives revocation until its `exp`** (§3.1) — revocation
  stops new claims, never outstanding ones. Purchase gate, not DRM.
* **The companion TOX channel stays ungated**, as today.

## 8. Open

1. **Deploy order — precondition met 2026-08-29; G1+G3 LIVE 2026-08-30**
   (worker 9ea13ff8): `/entitlement` answers with per-kind `exp` (a lapsed
   session gets 200 with `products: []`, never a refusal; no bearer →
   401 `signed_out`), `/pubkey` serves the SPKI, and `TIERS` carries
   `TDXLU_Pro` on all three tiers — the creator account is entitled via
   the ladder, so L5 can run creator-authenticated end to end. TDXLU
   still goes LIVE on the gate only after the FNS funnel plan's 0.5 is
   closed and v3.0.x has survived its first strangers.
2. **Fingerprint derivation.** The launcher's machine fingerprint now feeds
   only the claim's `machine` binding (the trial anchor went with §3.2). It
   must at minimum be stable across app updates and not reset on a
   reinstall. The gate treats it as **opaque and unverifiable by design** —
   the binding is honesty-box (§3.1), so the derivation is entirely the
   launcher's call.
3. **Walk every leg before ship — a numbered step, not an assumption.** The
   ladder grants upward and the creator holds the top tier, so the moment
   `TDXLU_Pro` enters `TIERS` the creator account is entitled to it: the whole
   flow can be walked by its builder before any customer. With the creator
   account, against the deployed gate: sign-in, claim, `/entitlement`,
   recheck, revoke — then the G7 legs: adopt in BOTH directions and
   machine-wide sign-out. The leg to watch is **TD adopting a
   launcher-written file**: ExtAuth's adopt path is tested against the
   file format but has never seen a file `licensing.rs` wrote, and vice
   versa — two writers, both format-tested, neither cross-tested. The
   first real walk of the FNS client flow found three
   measured-not-assumed platform bugs, every one in a leg that had never
   executed; `licensing.rs`'s reworked legs have also never executed. Budget
   for finding bugs. Results get a closing entry both here and in
   `TDXLUGateIntegration.md` §8 (which stages this ladder as of `1a45620`).
4. **~~Turnstile UX in a desktop app~~ — moot.** The trial is dropped (§3.2);
   no Turnstile surface is needed anywhere in the launcher.
5. **~~`TDXLU_Pro` as the product name~~ — retired 2026-10-02.** The launcher
   gates nothing; membership pays for FNSTools Plus only.
6. **~~Whether any launcher tool is gated at all~~ — resolved 2026-10-02: none is.** §4 is a mechanism, not a
   commitment; §1–§3 stand on their own and should ship first regardless.
   Gating is far cheaper pointed at capability that does not exist yet than
   at surfaces already built, because the second case also has to answer
   "where did this go" for anyone who saw an earlier build.
7. **What happens to the Firebase project.** Out of scope here and not this
   document's call. The launcher simply stops pointing at it (and with the
   trial dropped, nothing will again).
8. **FNSTools Plus integration.** Pro capability is headed for delivery
   through FNSTools Plus; a work order for integrating that back into the
   TDXLU app is coming later. This document's §1–§3 licensing rail stands
   regardless — it is the sign-in and claim machinery any such integration
   would ride. **Work order written 2026-08-30:**
   [fns-plus-capabilities.md](fns-plus-capabilities.md) — registry-driven
   capability injection into the Current view, gating flipped to
   possession-at-stocking, mobile control as a standalone package under
   §4.1's exception clause, the launcher's control server rescoped to
   fleet + hand-off.

## 9. Sources

* `FunctionStore_tools_PUB/worker/src/index.js` — the gate; every route above
* `FunctionStore_tools_PUB/worker/wrangler.toml` — bindings, vars, secrets
* [GatedDeliveryResearch.md](https://github.com/function-store/FNSTools/blob/main/docs/GatedDeliveryResearch.md) §2 — why a broker is mandatory: Patreon's token exchange requires `client_secret` and **has no PKCE**
* [EntitlementLifecycle.md](https://github.com/function-store/FNSTools/blob/main/docs/EntitlementLifecycle.md) — §2 perpetual Gumroad, §3 what session lifetime forbids, §4 revocation, §5 the two lifecycle holes
* [DistributionComparison.md](https://github.com/function-store/FNSTools/blob/main/docs/DistributionComparison.md) — the outages these rules were bought with
* `FunctionStore_tools_PUB/FNSTools/FNS_Updater/ExtAuth.py` — the in-TD credential
  pattern §4.2 deliberately does NOT copy, and the two traps to take from it if it
  ever is copied
* [PackagingScheme.md](https://github.com/function-store/FNSTools/blob/main/docs/PackagingScheme.md) §5 — the
  artifact and TouchDesigner traps inherited in §4.3
* `packaging/build_manifest.py` — where `access` is written and what it means
* `src-tauri/src/licensing.rs` — the launcher side described in §6;
  `fns_store.rs` and `updates.rs` — the download rails §4.2 reuses
* [TDXLUGateIntegration.md](https://github.com/function-store/FNSTools/blob/main/docs/TDXLUGateIntegration.md) — the gate side's 2026-08-29
  assessment of this contract: the G1–G6 action plan it accepts, the
  conditions attached, and the facts refresh folded into this revision
