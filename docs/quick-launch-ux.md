# Quick Launch — functionality and UX

What the quick-launch overlay *is to use*: what appears in it, how it ranks,
what the keys do, and how the drill-ins behave.

This is the **consumer** half of the story. The registry contract — how a tool
announces commands, `params`, `surface`, the decorator — lives in
[fns-command-registry.md](fns-command-registry.md) and is assumed known here.
Implementation: `src/quick.tsx` (one file, the overlay is its own frameless
always-on-top window built in `lib.rs`).

## The shape of it

One input, one list, one footer hint. Summoned by a global hotkey
(`Alt+Shift+D` by default), dismissed with Esc or on blur.

Two things happen at summon that shape everything after:

- **The foreground TD pid is captured before the overlay steals focus.** That
  session is "the one you were just in": its rows sort first, it receives
  ambiguous actions, and it is what a tool command runs in unless you say
  otherwise.
- **The hotkey is passed through while a non-TouchDesigner fullscreen app is
  in front** (a game, a fullscreen video, a presentation), so the overlay can't
  yank focus and the app still receives its key combination. TD in Perform Mode
  is fullscreen too, so it is exempt by process name. On Windows the launcher
  does this by temporarily releasing its native hotkey registrations, then
  restoring them after fullscreen exits. Switchable in Settings.

  The fullscreen question goes to `SHQueryUserNotificationState` — the signal
  Windows itself uses before showing a notification — not to window geometry. A
  maximized window is *not* fullscreen, but with an auto-hidden taskbar the work
  area equals the whole monitor, so a maximized window fills the monitor rect
  exactly and no size comparison can tell the two apart.

## What is in the list

| Row type | Badge | Enter does |
|---|---|---|
| Running session | `SESSION` | Focus it |
| Session verb | `COMMAND` | Focus / Save / Snapshot / Relaunch / Kill that session |
| Project (recent, not running) | `PROJECT` | Launch it |
| New default project | `NEW` | Launch TD with default startup |
| Template | `TEMPLATE` | Launch it |
| Component (.tox) | `TOOLBOX` / `PALETTE` / `PATREON` | Place into a session — or drag the row into a TD network |
| Tool command | `TOOL` | Run it in a session |
| Preset | `PRESET` | Run a tool command with baked-in arguments |
| App action | `COMMAND` | Open TDXLU / Settings / About / Upgrade |
| Window | `WINDOW` | Raise that one OS window |

**Running a command or placing a component hands the front to its session.**
Both act *inside* TouchDesigner — a command opens a dialog, a panel or a
viewer; a placed `.tox` lands in a network you are not looking at — so a
success raises that session's windows as the overlay dismisses. A failure does
not: the overlay stays up carrying the error, which it could not do if TD had
taken the front (the overlay's blur dismiss is enforced in Rust, so the focus
hand-off has to come after the reply). Dragging a row into TD is unaffected —
the drop already puts you there.

Freemium line: sessions and all session verbs are **free**; Toolbox / Patreon
component rows and window management are **Pro**. Pro-gated rows are absent
rather than shown locked — the palette is a keyboard-speed surface, and an
upsell that eats a keystroke there is worse than the row not existing.

## Prefixes

A leading character scopes the whole query. All five are single characters and
user-remappable (Settings → Quick Launch); config wins only if each is one
non-space char and none collide.

| Prefix | Scope |
|---|---|
| `>` | Commands only — session verbs, tool commands, presets, app actions |
| `?` | Tool commands only (what `FNS_CommandRegistry` announced) |
| `=` | Components only (Toolbox / Palette / Patreon `.tox`) |
| `/` | Browse a folder / category — results group under folder headers |
| `#` | Filter by project tag |

Bare `>` and `=` are *browse* modes, not searches: bare `>` lists every command
with session verbs first, bare `=` lists the whole component library grouped by
where it lives.

## The untyped list

With nothing typed, the list is ordered by what you are most likely to want:

```
running sessions           ← the summoned-over one first
New default project
recent projects            ← by recency, capped at 8
app actions                ← Open TDXLU, Settings, About
```

Enter with **nothing typed and no row selected** raises the main launcher
window — the palette doubles as "show me the app".

## Ranking

Typed queries are fuzzy-scored, then nudged. The formula that decides row order:

```
score + TYPE_WEIGHT[type] + (focused ? 8) + (preset ? 5) + (favourite ? 12) + usage
```

- **Fuzzy score** matches the title first; category and tags at 0.85; the file
  path at 0.5 and **only as a substring** — subsequence matching over a long
  path matches almost anything and buries real hits.
- **Type weight** is why a session outranks a palette component for the same
  word: session 30, project 25, tox 12, template 8, toolcmd 7, verb 6, action 5.
- **The nudges are deliberately small** — enough to win a tie, never enough to
  bury a clearly better match. A favourite gets the biggest (12) because the
  user explicitly said "this one".
- **Usage** is 0..8 from the shared `command-usage.json` (Settings → Quick
  Launch → *Rank by usage*, on by default): commands you run often win ties
  and near-ties, never a better match or a favourite on their own. The file
  is shared with FNSTools' command palette inside TD — a run in either place
  counts in both, decaying with a 14-day half-life. Only a successful tool
  command or preset records (a preset against its target's `tool#id`); runs
  record even while ranking is off. *Clear usage* forgets the launcher's own
  history only. Contract: [CommandUsage.md](https://github.com/function-store/FNSTools/blob/main/docs/CommandUsage.md); code:
  `src-tauri/src/command_usage.rs`.
- In the bare `>` / `?` lists usage orders rows *within* their group: session
  verbs still lead `>`, and on `?` it comes after favourites and presets,
  with unused commands still grouped by tool.
- Ties break on recency. The list is capped at 12 rows.

## Keys

| Key | Effect |
|---|---|
| `↑` / `↓` | Move selection; arrowing off the top returns to "nothing selected" |
| `Enter` | Act on the selected row |
| `Ctrl`/`Cmd` + `Enter` | Launch with TouchPlayer instead of TouchDesigner |
| `→` | Drill in (see below) — only with the caret at the end, so it still edits text |
| `←` | Back out of a drill-in — only with the caret at the start |
| `Esc` | Back out of a drill-in or disarm a confirm; otherwise dismiss |
| `Alt` + `↑`/`↓` | Cycle executed-query history, shell style; survives a restart |
| `Ctrl`/`Cmd` + `D` | Toggle favourite on the selected command |

## Drill-ins

Both reuse one mechanism (`pending`), so filtering, backing out, the
placeholder and the footer behave identically in each.

**A tool command offered by several sessions** → `→` (or Enter, when focus
can't disambiguate) lists the candidate sessions. Typing filters by project
name. The row carries a count badge.

**A session with more than one window** → `→` lists its OS windows: title,
pane type, pane path, display, and whether it is minimized. Enter raises that
one window rather than the whole session, restoring it if minimized. Sessions
with more than one window advertise this with a `→ N` badge — the number says
there is something to choose, the arrow says which key opens it.

## Arguments

Tool commands with declared `params` show them as ghost chips after the label.
Two ways to fill them:

- **Inline** — trailing tokens in the query map onto the declared params in
  order, so `? rec 2` is already recording. The row previews the mapping in its
  chips and Enter skips the prompt. Inline args score as exact structural
  matches (+90 per consumed token) so a row that incidentally contains the
  digits can't outrank the command the arguments were typed for.
- **Prompted** — Enter walks the params one at a time; menu and toggle params
  become pick rows, the rest a text field. `←` steps back a param.

**Presets** are user-authored aliases over a command with arguments baked in —
they appear as their own row with a `PRESET` badge, and resolve against the
unfiltered command set, so a preset over a hidden command still works
(authoring the preset *is* the opt-in).

**Multi-instance tools** (registry 1.11.0): copies of one tool register the
same `tool#id` under different paths, each with an `instance` label. Every
copy is its own row titled `label · instance`, and the label is searchable. A
preset targets `tool#id` (one row per live copy) or `tool#id@instance` (that
copy only, dormant where the label is absent). Favourites and visibility stay
on `tool#id` and cover every copy. Contract:
[fns-command-registry.md](fns-command-registry.md).

## Safety

- **Destructive verbs arm.** Kill needs a second Enter; the row says so, and
  the footer warns that unsaved work is lost. Anything that changes what Enter
  would hit disarms it.
- **Hidden commands** — a tool can declare `hidden`, and the user can hide
  commands themselves (`quick_hidden_commands`). The user's choice beats the
  tool's declared default in both directions.
- The footer hint line is **selection-specific**: it always states what Enter
  will do to the row you are on, and which extra keys apply to it.

## Where the same commands surface elsewhere

Commands can declare a `surface` token. The overlay serves `quick`; the
launcher's Current-tab companion bar serves `session`; its session right-click
menu serves `context-menu`. Consumers ignore tokens they don't serve, so new
surfaces are additive. Favourites are shared between the overlay, Settings, and
TD's own palette Commands tab through `quick_favorite_commands`.
