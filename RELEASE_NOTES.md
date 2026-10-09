<!--
This file IS the release notes users read: prepare-release.mjs puts it in
latest.json and the app shows it in the update dialog, rendered as MARKDOWN
(builds after 0.8.0). Headings, lists, bold, and code all work.

One caveat: the dialog doing the rendering is the OLD build the user is
updating FROM. Anyone on 0.8.0 or earlier sees this text raw (plain text,
line breaks preserved), so for the first markdown-rendered release keep the
formatting degradable — `### NEW` or `**bold**` arrives literally for them.
Plain `NEW` section labels + `- ` lists read fine in both renderers.

HTML comments like this one are stripped before publishing, so notes to the
next editor are safe here and nowhere else in the file.

Rewrite it for each release. It described 0.5.0 while the version said 0.6.0,
which would have announced last release's features as new.

This file describes 0.22.3, everything since 0.22.2 (2026-10-06). App and
companion move together: this installer bundles companion 0.23.8. The
previous release's notes live in git history (0.22.2: commit 64ee2af).
-->

FIXED

- Focus brings the TouchDesigner window up right away. After the launcher had
  been running a while next to a busy TouchDesigner, Focus, Escape in Quick
  Launch and other clicks could wait up to a minute: stuck requests to busy
  sessions piled up until nothing else could run. Requests to a session no
  longer hold anything else up, and the session and performance polls never
  overlap.
- A preview you just captured or recorded shows everywhere. Recent kept the old
  still, and Sessions went back to it after switching tabs; this also covers
  captures made from inside TouchDesigner.
- A session you just opened is in Quick Launch straight away, companion or not.
- No more "Envoy down" on projects that never use Envoy. The Envoy chip shows
  once Envoy has answered for that session.

CHANGED

- The companion's parameters are regrouped (companion 0.23.8): Launcher (the
  link to the app, menu bar, recents), Media (icon and preview), Palette, then
  Heartbeat, Control, Envoy and About. Capture Icon replaces the two icon
  buttons, Save Project is gone (Ctrl+S does it), and the component opens on
  its first page.
