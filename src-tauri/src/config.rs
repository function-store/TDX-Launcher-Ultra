//! Configuration management - schema shared with the companion utility TOX.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathEntry {
    Path(String),
    Rich {
        path: String,
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        last_opened: Option<f64>,
    },
}

impl PathEntry {
    pub fn path(&self) -> &str {
        match self {
            PathEntry::Path(p) => p,
            PathEntry::Rich { path, .. } => path,
        }
    }

    pub fn into_rich(self, source: &str) -> RecentEntry {
        match self {
            PathEntry::Path(path) => RecentEntry {
                path,
                source: Some(source.to_string()),
                last_opened: Some(0.0),
            },
            PathEntry::Rich {
                path,
                source: s,
                last_opened,
            } => RecentEntry {
                path,
                source: s.or_else(|| Some(source.to_string())),
                last_opened: last_opened.or(Some(0.0)),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened: Option<f64>,
}

/// A Patreon creator the user added by URL. Stored as a snapshot so the list
/// renders without a round-trip per creator; refreshed whenever it's re-added.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatreonCreatorEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// A user-authored quick-launch preset: an alias over a registered tool
/// command with a label and baked argument values. `target` is the
/// project-stable `tool#id` identity, optionally pinned to one copy of a
/// multi-instance tool as `tool#id@instance` (the instance label is project
/// data, so a pinned preset is dormant wherever that label is absent);
/// `kwargs` values ride as strings and
/// the registry coerces them by the command's declared param styles. A
/// preset whose target isn't live in any session is dormant, never stale.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickCommandPreset {
    pub label: String,
    pub target: String,
    #[serde(default)]
    pub kwargs: std::collections::HashMap<String, String>,
}

/// One tool command the quick palette has ever seen -- the historical catalog
/// the Settings curation list renders. Kept in config (not just the palette's
/// own memory) so a command stays curatable with no session live, and so the
/// catalog travels with a settings export: an imported command can be hidden,
/// shown, or given a preset *before* it ever registers on this machine.
/// `identity` (`tool#id`) is the key; every other field is display data from
/// the last sighting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickSeenCommand {
    /// `tool#id` -- stable across projects, unlike wire keys.
    pub identity: String,
    pub tool: String,
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// Tool-declared default visibility at last sighting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    /// Built-in TD/system command (not a third-party tool's) at last sighting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
    /// Number of declared arguments at last sighting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub param_count: Option<usize>,
    /// Declared-argument specs at last sighting, passed through opaque --
    /// lets the Settings preset editor render real fields offline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<Value>>,
    /// Instance labels of the live copies at last sighting, for tools that
    /// exist as several copies (registry >= 1.11.0). Display data for the
    /// Settings preset editor, which can pin a preset to one copy
    /// (`tool#id@instance`). Curation itself stays keyed on `identity`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instances: Option<Vec<String>>,
    /// Unix seconds of the last sighting (0 when unknown, e.g. an old export).
    #[serde(default)]
    pub last_seen: f64,
}

/// What a settings import actually changed, for the status line.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SettingsImportCounts {
    pub prefs_applied: usize,
    pub tools_added: usize,
    pub categories_added: usize,
    pub commands_added: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub launcher_recents: Vec<PathEntry>,
    #[serde(default)]
    pub td_recents: Vec<PathEntry>,
    #[serde(default)]
    pub td_recents_timestamp: f64,
    #[serde(default)]
    pub templates: Vec<PathEntry>,
    #[serde(default = "default_max_recent")]
    pub max_recent_files: u32,
    #[serde(default = "default_true")]
    pub confirm_remove_from_list: bool,
    #[serde(default)]
    pub show_icons: bool,
    #[serde(default)]
    pub show_readme: bool,
    // Default ON since variant families (variants.rs): one card per project.
    #[serde(default = "default_true")]
    pub collapse_versions: bool,
    #[serde(default = "default_true")]
    pub show_full_history: bool,
    #[serde(default)]
    pub has_prompted_file_assoc: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    /// `"list"` | `"gallery"`
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
    /// Keep a tray icon while the app is running.
    #[serde(default = "default_true")]
    pub show_tray: bool,
    /// Close (X) hides to tray instead of quitting.
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// Enable the secondary global OS hotkey, which opens the quick-launch
    /// overlay. Applied at startup.
    #[serde(default = "default_true")]
    pub global_hotkey_enabled: bool,
    /// Global OS hotkey that opens the quick-launch overlay (accelerator
    /// string, e.g. "Alt+Shift+D"). Applied at startup.
    #[serde(default = "default_global_hotkey")]
    pub global_hotkey: String,
    /// Optional ALTERNATE combo for the quick-launch overlay — same action,
    /// second binding. Empty = unbound; follows `global_hotkey_enabled`.
    #[serde(default)]
    pub global_hotkey_alt: String,
    /// Ignore the global hotkeys while a FULLSCREEN app that is not
    /// TouchDesigner owns the foreground — a game, a fullscreen video. Stops
    /// the overlay stealing focus mid-game. TD in Perform Mode is fullscreen
    /// too, so it is matched by process and always allowed through.
    #[serde(default = "default_true")]
    pub hotkey_skip_fullscreen: bool,
    /// Enable the primary global OS hotkey, which shows/hides the main
    /// launcher window. Applied at startup.
    #[serde(default = "default_true")]
    pub global_hotkey_main_enabled: bool,
    /// Global OS hotkey that shows/hides the main launcher window
    /// (accelerator string). Empty = unbound.
    #[serde(default = "default_global_hotkey_main")]
    pub global_hotkey_main: String,
    /// Optional ALTERNATE combo for the main window — same action, second
    /// binding. Empty = unbound; follows `global_hotkey_main_enabled`.
    #[serde(default)]
    pub global_hotkey_main_alt: String,
    /// Enable the third global OS hotkey, which shows/hides the main
    /// launcher window jumped straight to the Palette tab. Applied at startup.
    #[serde(default)]
    pub global_hotkey_palette_enabled: bool,
    /// Global OS hotkey that shows/hides the main launcher window on the
    /// Palette tab (accelerator string). Empty = unbound.
    #[serde(default)]
    pub global_hotkey_palette: String,
    /// Legacy: what the single hotkey used to open, "quick" or "window".
    /// Migrated on load into the two hotkeys above, then dropped.
    #[serde(default, skip_serializing)]
    pub global_hotkey_target: Option<String>,
    /// Quick-palette filter prefixes (single characters). Invalid or
    /// colliding values fall back to the defaults frontend-side.
    #[serde(default = "default_qp_commands")]
    pub quick_prefix_commands: String,
    #[serde(default = "default_qp_components")]
    pub quick_prefix_components: String,
    #[serde(default = "default_qp_category")]
    pub quick_prefix_category: String,
    #[serde(default = "default_qp_tag")]
    pub quick_prefix_tag: String,
    #[serde(default = "default_qp_tools")]
    pub quick_prefix_tools: String,
    /// Tool-command curation for the quick palette, as `tool#id` identities
    /// (COMP name + command id — stable across projects, unlike wire keys).
    /// Sparse overrides of each command's own default visibility: `hidden`
    /// hides a default-visible command, `shown` surfaces a tool-declared
    /// hidden one. Unknown identities are dormant, never stale.
    #[serde(default)]
    pub quick_hidden_commands: Vec<String>,
    #[serde(default)]
    pub quick_shown_commands: Vec<String>,
    /// Favourite commands (`tool#id`): pinned first in the quick-launch
    /// `>` / `?` lists and the in-TD palette's Commands tab, and nudged up on
    /// typed queries. Independent of visibility. Edited from the quick-launch
    /// (Ctrl+D / the star), Settings, and the palette page alike.
    #[serde(default)]
    pub quick_favorite_commands: Vec<String>,
    /// Rank frequently run commands higher in the quick-launch (a bounded
    /// tie-breaker from the shared `command-usage.json`, see
    /// `command_usage.rs`). Off = no bonus; usage is still recorded, so
    /// switching it on later finds history. Per machine; default on.
    #[serde(default = "default_true")]
    pub quick_rank_by_usage: bool,
    /// User-authored command presets (see [`QuickCommandPreset`]).
    #[serde(default)]
    pub quick_command_presets: Vec<QuickCommandPreset>,
    /// Historical tool-command catalog (see [`QuickSeenCommand`]) -- merged,
    /// never replaced, and carried by settings export/import.
    #[serde(default)]
    pub quick_seen_commands: Vec<QuickSeenCommand>,
    /// Exit the launcher after launching a project.
    #[serde(default)]
    pub quit_after_launch: bool,
    /// Hide the launcher window (to tray) after launching a project.
    /// Default OFF — the launcher stays where it is unless the user opts in.
    #[serde(default)]
    pub hide_after_launch: bool,
    /// Switch to the Current tab after launching a project. Default on.
    #[serde(default = "default_true")]
    pub switch_to_current_after_launch: bool,
    /// Tab shown when the app opens on its own (not with a .toe to launch):
    /// recent | current | templates | palette | fns | patreon, or `last` for
    /// wherever it was left. Anything else reads as `recent`.
    #[serde(default = "default_startup_tab")]
    pub startup_tab: String,
    /// Which build to auto-launch when a project opened from Finder/Explorer
    /// was saved with one that is not installed.
    ///
    /// `"latest"` uses the newest mainline install, `"closest"` the nearest
    /// one, `"ask"` never auto-launches, and any other non-empty value pins a
    /// specific install key (`"TouchDesigner.2025.30060"`) — see
    /// `resolveCliFallbackVersion`.
    ///
    /// Empty is the default and means *not answered*: the setup wizard offers
    /// the choice but nobody has to make it there, so the first file-open that
    /// actually hits a missing build asks once and stores the answer. That also
    /// keeps the question off the upgrade path — an install predating this
    /// setting has no key, so it gets asked rather than silently switched to a
    /// policy it never chose.
    ///
    /// Only affects the file-open countdown; the Launch button always offers
    /// every install.
    #[serde(default)]
    pub cli_fallback_version: String,
    /// One-time: the bundled companion TOX has been copied into the user's
    /// Palette. Set after the first successful auto-install so we never re-add
    /// it (respects a user who deletes it).
    #[serde(default)]
    pub utility_palette_installed: bool,
    /// User overrides for editable keyboard shortcuts: action id -> accelerator
    /// string (e.g. "tab.current" -> "Alt+2"). Missing ids use their default.
    #[serde(default)]
    pub keybindings: HashMap<String, String>,
    /// GitHub username (display / HTTPS auth).
    #[serde(default)]
    pub github_username: String,
    /// GitHub personal access token (stored locally in config.json).
    #[serde(default)]
    pub github_token: String,
    /// Patreon `session_id` cookie (stored locally). Full account access — used
    /// only by the optional cookie-based Patreon import; empty when unused.
    #[serde(default)]
    pub patreon_session_cookie: String,
    /// Destination folder for Patreon .tox/.toe/.zip downloads (always grouped
    /// into a per-creator subfolder). Empty = ~/Documents/TDXLU/Patreon Downloads.
    #[serde(default)]
    pub patreon_download_root: String,
    /// Creators added by hand from a URL. Patreon exposes no way to list free
    /// follows reliably, so this is how a creator you merely follow (or one the
    /// follow feed hasn't surfaced) stays in the list.
    #[serde(default)]
    pub patreon_creators: Vec<PatreonCreatorEntry>,
    /// Function Store's own creator page, offered first in every user's list
    /// until dismissed — resolved once and cached here so the list needs no
    /// extra request (see `commands::add_featured_creator`).
    #[serde(default)]
    pub patreon_featured: Option<PatreonCreatorEntry>,
    /// The user hid the featured creator with its ×. Permanent.
    #[serde(default)]
    pub patreon_featured_dismissed: bool,
    /// Acknowledged the "a downloaded .tox runs the creator's code" warning.
    /// Deliberately shared between the launcher's Patreon tab and the in-TD
    /// palette page (over `/api/palette/patreon_ack`) so the banner is shown
    /// once per install, not once per surface. Never travels in an exported
    /// settings file -- importing someone else's settings must not silently
    /// pre-dismiss a safety warning.
    #[serde(default)]
    pub patreon_trust_ack: bool,
    /// Default destination folder for project backups (USB / OneDrive / Drive folder).
    #[serde(default)]
    pub backup_root: String,
    /// Base folder on cloud remotes; projects back up into
    /// `{remote}:{cloud_backup_root}/{project_folder_name}`. Empty = remote root.
    #[serde(default = "crate::rclone::default_cloud_backup_root")]
    pub cloud_backup_root: String,
    /// Exclude globs (one per line). FreeFileSync-style path filters.
    #[serde(default = "crate::backup::default_backup_exclude")]
    pub backup_exclude: String,
    /// Include globs (one per line). Empty = all non-excluded files.
    #[serde(default)]
    pub backup_include: String,
    /// Skip files larger than this many MB (0 = no limit).
    #[serde(default)]
    pub backup_max_file_mb: u64,
    /// Also skip files the project's .gitignore matches (repos only).
    #[serde(default)]
    pub backup_respect_gitignore: bool,
    /// Also skip TouchDesigner's Backup/ folders (numbered saves). Off by
    /// default — some people work straight out of them.
    #[serde(default)]
    pub backup_skip_td_backups: bool,
    /// Extra palette folders (one path per line). Always also scans Documents/Derivative/Palette.
    #[serde(default)]
    pub palette_extra_folders: String,
    /// Base URL of the package index (Warehouse/PyPI-compatible: serves
    /// `{base}/simple/` PEP 691 + `{base}/pypi/{name}/json`). Default PyPI.
    #[serde(default = "default_package_index")]
    pub package_index_url: String,
    /// Name filter for the package browser. On a big shared index (PyPI) this
    /// narrows to relevant packages; empty lists everything the index serves
    /// (fine for a small/curated index). Default `tdp-`.
    #[serde(default = "default_package_prefix")]
    pub package_index_prefix: String,
    /// Base URL of the FNSTools bucket: `{base}/manifest.json` is
    /// the rolling release manifest and artifact URLs inside it are absolute.
    /// Empty resets to the default bucket.
    #[serde(default = "default_fns_base_url")]
    pub fns_base_url: String,
    /// HTTP port for the browser control panel server.
    #[serde(default = "default_control_port")]
    pub control_server_port: u16,
    /// Bind the control server on all interfaces so other devices on the LAN
    /// can open the panel (token still required). Off = 127.0.0.1 only.
    #[serde(default)]
    pub control_server_lan: bool,
    /// Persisted bearer token for the control panel. Empty until first use,
    /// then generated once and kept — so a phone's home-screen bookmark keeps
    /// working across app restarts. "Regenerate" clears it (server mints a new
    /// one), invalidating every previously shared link.
    #[serde(default)]
    pub control_token: String,
    /// Client-tier bearer token for the control server: links carrying this
    /// token see ONLY the authored control parameters (schema/values/set) —
    /// no session verbs, no component browsing, no launching. For handing a
    /// restricted remote to a client/operator. Cleared with control_token on
    /// Regenerate.
    #[serde(default)]
    pub control_client_token: String,
    /// Hand every companion (utility ≥ 0.21.0) the loopback palette page so
    /// TouchDesigner's Palette Browser grows TDXLU / Patreon tabs
    /// (docs/palette-tabs.md). Off = sessions keep the stock palette.
    #[serde(default = "default_true")]
    pub palette_tabs_enabled: bool,
    /// Run the automatic update checks (at most once a day, never while a TD
    /// session runs). Off means nothing is announced; a manual "Check for
    /// updates" still works. Unlike a skipped version this IS a portable
    /// preference.
    #[serde(default = "default_true")]
    pub auto_update_check: bool,
    /// Show the FNSTools tab. Off hides the tab, its shortcut and its
    /// startup-tab choice for this user; the Palette tab's FNS shelf stays.
    #[serde(default = "default_true")]
    pub show_fns_tab: bool,
    /// App version the user chose to skip. The startup check stays silent for
    /// exactly this version; a newer one prompts again, and a manual "Check for
    /// updates" always shows regardless. Deliberately NOT in the portable
    /// settings export — a skip on one machine should not silence another.
    #[serde(default)]
    pub skipped_app_version: String,
    /// Companion TOX version the user chose to skip. Same rules as above.
    #[serde(default)]
    pub skipped_utility_version: String,
    /// RETIRED (D7, 2026-08-31): gated the client-tier link's reach to the
    /// phone touch pad, back when this app relayed touch into the companion.
    /// Touch moved into the FNS_Remote package, which serves the phone
    /// itself, so nothing reads this. Kept as a field so an existing
    /// config.json still deserialises; drop it once configs have rolled.
    #[serde(default)]
    pub control_touch_client: bool,
    /// TCP port for heartbeat watchdog (localhost).
    #[serde(default = "default_watch_port")]
    pub watch_tcp_port: u16,
    /// Seconds without heartbeat before restart.
    #[serde(default = "default_watch_timeout")]
    pub watch_timeout_secs: u32,
    /// Seconds after launch before heartbeats are required.
    #[serde(default = "default_watch_grace")]
    pub watch_launch_grace_secs: u32,
    /// Max automatic relaunches before giving up.
    #[serde(default = "default_watch_restarts")]
    pub watch_max_restarts: u32,
    /// Capture desktop screenshot on stall/crash.
    #[serde(default = "default_true")]
    pub watch_screenshot_on_crash: bool,
    /// Reboot machine after N crashes (0 = never).
    #[serde(default)]
    pub watch_reboot_after_crashes: u32,

    /// Show live performance stats (process CPU/RAM + companion Perform CHOP)
    /// for the selected running session in the Current tab. Off = no sampling,
    /// no bus traffic, no UI.
    #[serde(default)]
    pub perf_monitor_enabled: bool,
    /// Poll interval (seconds) for session performance sampling.
    #[serde(default = "default_perf_poll_secs")]
    pub perf_poll_secs: u32,

    /// Send SMTP email on watch events.
    #[serde(default)]
    pub alert_email_enabled: bool,
    #[serde(default)]
    pub alert_email_to: String,
    #[serde(default)]
    pub alert_email_from: String,
    #[serde(default)]
    pub alert_smtp_host: String,
    #[serde(default = "default_smtp_port")]
    pub alert_smtp_port: u16,
    /// `starttls` | `tls` | `none`
    #[serde(default = "default_smtp_security")]
    pub alert_smtp_security: String,
    #[serde(default)]
    pub alert_smtp_username: String,
    #[serde(default)]
    pub alert_smtp_password: String,
    #[serde(default = "default_true")]
    pub alert_on_stall: bool,
    #[serde(default = "default_true")]
    pub alert_on_relaunch: bool,
    #[serde(default = "default_true")]
    pub alert_on_gave_up: bool,
    #[serde(default = "default_true")]
    pub alert_on_reboot: bool,
    #[serde(default = "default_true")]
    pub alert_attach_screenshot: bool,
    /// Min seconds between emails for the same project+event (0 = no limit).
    #[serde(default = "default_alert_cooldown")]
    pub alert_cooldown_secs: u32,

    /// One-time: the bundled companion TOX has been pinned into the Toolbox.
    /// Set after the first seed so we never re-add it (respects removal).
    #[serde(default)]
    pub toolbox_utility_seeded: bool,
    /// Ordered category names for the palette Toolbox section.
    #[serde(default)]
    pub toolbox_categories: Vec<String>,
    /// Pinned tools shown in the palette Toolbox section (render order).
    #[serde(default)]
    pub toolbox_tools: Vec<ToolboxTool>,

    /// Legacy field - migrated on load
    #[serde(default, skip_serializing)]
    pub recent_files: Option<Vec<PathEntry>>,
}

/// A user-pinned tool in the palette Toolbox: a `.tox` the user reaches for
/// often, from a local file, a URL / GitHub release, or a package index spec.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolboxTool {
    pub id: String,
    /// Display name (defaults from the source when omitted at add time).
    pub label: String,
    /// `"local"` | `"url"` | `"package"`
    pub kind: String,
    /// local: absolute `.tox` path; url: direct URL / `owner/repo` spec;
    /// package: pip spec for the configured package index.
    pub source: String,
    /// Category name; empty = top level of the Toolbox.
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub notes: String,
    /// Local copy of a `url` tool after a successful fetch (tox_cache path).
    #[serde(default)]
    pub cached_path: Option<String>,
    #[serde(default)]
    pub added_at: f64,
}

pub const TOOLBOX_KINDS: [&str; 3] = ["local", "url", "package"];

/// Cap on the historical tool-command catalog -- newest sightings survive.
const QUICK_SEEN_COMMANDS_MAX: usize = 300;
/// A sighting that changes nothing but `last_seen` only rewrites config once
/// this far apart; the palette merges its catalog on every summon.
const QUICK_SEEN_TOUCH_SECS: f64 = 3600.0;

fn default_version() -> u32 {
    1
}
fn default_max_recent() -> u32 {
    100
}
/// Accepted `startup_tab` values (see AppConfig::startup_tab).
const STARTUP_TABS: [&str; 7] = ["recent", "current", "templates", "palette", "fns", "patreon", "last"];

fn default_startup_tab() -> String {
    "recent".into()
}

fn default_true() -> bool {
    true
}
fn default_theme() -> String {
    "classic".into()
}
fn default_view_mode() -> String {
    "gallery".into()
}
fn default_watch_port() -> u16 {
    11999
}
fn default_control_port() -> u16 {
    11997
}
fn default_qp_commands() -> String {
    ">".into()
}
fn default_qp_components() -> String {
    "=".into()
}
fn default_qp_category() -> String {
    "/".into()
}
fn default_qp_tag() -> String {
    "#".into()
}
fn default_qp_tools() -> String {
    "?".into()
}

fn default_global_hotkey() -> String {
    // Secondary combo: the quick-launch overlay. Pairs with the flagship
    // Ctrl/Cmd+Shift+D and is unclaimed by the OS on both platforms
    // (Ctrl+Alt+D would collide with macOS's Dock toggle as Cmd+Alt+D).
    "Alt+Shift+D".to_string()
}
fn default_global_hotkey_main() -> String {
    // The flagship combo: shows/hides the main launcher window.
    "CommandOrControl+Shift+D".to_string()
}
fn default_package_index() -> String {
    "https://pypi.org".to_string()
}
fn default_fns_base_url() -> String {
    "https://storage.functionstore.tools/fnstools".to_string()
}
/// Every path a bucket URL can enter the config through (load, pref patch,
/// settings import) funnels here. Empty resets to the official bucket, and
/// the PRE-MIGRATION host is coerced too: `functionstr.com` no longer even
/// resolves, so any stale copy of it — persisted, imported, or pushed by an
/// out-of-date frontend — would silently kill every FNS fetch while looking
/// like a configured mirror.
fn normalize_fns_base(v: &str) -> String {
    let t = v.trim().trim_end_matches('/');
    if t.is_empty() || t.contains("functionstr.com") {
        default_fns_base_url()
    } else {
        t.to_string()
    }
}
fn default_package_prefix() -> String {
    "tdp-".to_string()
}
fn default_watch_timeout() -> u32 {
    60
}

fn default_perf_poll_secs() -> u32 {
    4
}
fn default_watch_grace() -> u32 {
    45
}
fn default_watch_restarts() -> u32 {
    5
}
fn default_smtp_port() -> u16 {
    587
}
fn default_smtp_security() -> String {
    "starttls".into()
}
fn default_alert_cooldown() -> u32 {
    300
}

/// Adopt the pre-rename config once, so an update is not a factory reset.
///
/// Returns Ok(true) when the legacy file was adopted.
///
/// Only runs when the new location holds nothing the LAUNCHER wrote. The test
/// is the `version` key: every `ConfigManager::save` emits it, while the
/// companion TOX's recents merge creates a file containing only `td_recents`.
/// Treating that stub as "already configured" is precisely what made an
/// updated install come up with default settings while the user's real config
/// sat untouched in the old directory.
///
/// The legacy file is never modified or deleted — downgrading keeps working.
fn adopt_legacy_config(new_path: &Path, legacy_path: &Path) -> Result<bool, String> {
    let read_obj = |p: &Path| -> Option<serde_json::Map<String, Value>> {
        let text = fs::read_to_string(p).ok()?;
        match serde_json::from_str::<Value>(&text).ok()? {
            Value::Object(m) => Some(m),
            _ => None,
        }
    };

    let existing = read_obj(new_path);
    if existing.as_ref().is_some_and(|m| m.contains_key("version")) {
        return Ok(false); // Already a launcher-written config; leave it alone.
    }
    let Some(mut legacy) = read_obj(legacy_path) else {
        return Ok(false);
    };
    if !legacy.contains_key("version") {
        return Ok(false); // Not a launcher config either — nothing to adopt.
    }

    // The stub may hold fresher TD recents than the legacy file: the companion
    // TOX keeps writing them to the new path regardless of which build ran.
    if let Some(stub) = existing {
        let stamp = |m: &serde_json::Map<String, Value>| {
            m.get("td_recents_timestamp").and_then(Value::as_f64).unwrap_or(0.0)
        };
        if stub.contains_key("td_recents") && stamp(&stub) > stamp(&legacy) {
            if let Some(v) = stub.get("td_recents") {
                legacy.insert("td_recents".into(), v.clone());
            }
            if let Some(v) = stub.get("td_recents_timestamp") {
                legacy.insert("td_recents_timestamp".into(), v.clone());
            }
        }
    }

    if let Some(dir) = new_path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(legacy)).map_err(|e| e.to_string())?;
    fs::write(new_path, text).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Canonicalize a hotkey accelerator the way a person would type it.
///
/// The underlying parser already trims and uppercases each token, so `ctrl`,
/// `Control`, `Cmd` and `command` all parse as-is. What it does NOT accept is
/// `Win` / `Windows` / `Meta` for the Super key, and it only splits on `+`.
/// This maps the spellings people actually use onto the ones it understands,
/// accepts spaces as separators, and tidies the casing so the stored value
/// reads back cleanly.
///
/// Note `Cmd`/`Command` means the SUPER key (Windows key on Windows), not
/// Ctrl — `CommandOrControl` is the one that means "Cmd on macOS, Ctrl
/// elsewhere". Both are preserved rather than silently reinterpreted.
pub fn normalize_accelerator(input: &str) -> String {
    let parts: Vec<String> = input
        .split(|c: char| c == '+' || c.is_whitespace())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| match t.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => "Control".to_string(),
            "cmd" | "command" => "Command".to_string(),
            "alt" | "option" | "opt" => "Alt".to_string(),
            "shift" => "Shift".to_string(),
            "win" | "windows" | "meta" | "super" => "Super".to_string(),
            "cmdorctrl" | "cmdorcontrol" | "commandorctrl" | "commandorcontrol" => {
                "CommandOrControl".to_string()
            }
            _ => {
                // A key name: single characters upper-case ("d" -> "D"),
                // longer ones Title-case ("space" -> "Space", "f1" -> "F1").
                let mut c = t.chars();
                match c.next() {
                    Some(f) if t.chars().count() == 1 => f.to_uppercase().to_string(),
                    Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                    None => String::new(),
                }
            }
        })
        .collect();
    parts.join("+")
}

fn normalize_theme(theme: &str) -> String {
    match theme {
        "ocean" | "amber" | "ember" | "frost" | "violet" | "mono" => theme.to_string(),
        _ => "classic".into(),
    }
}

fn normalize_view_mode(mode: &str) -> String {
    match mode {
        "list" => "list".into(),
        _ => "gallery".into(),
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 1,
            launcher_recents: vec![],
            td_recents: vec![],
            td_recents_timestamp: 0.0,
            templates: vec![],
            max_recent_files: 100,
            confirm_remove_from_list: true,
            show_icons: false,
            show_readme: false,
            collapse_versions: true,
            show_full_history: true,
            has_prompted_file_assoc: false,
            theme: default_theme(),
            view_mode: default_view_mode(),
            show_tray: true,
            close_to_tray: true,
            global_hotkey_enabled: true,
            global_hotkey: default_global_hotkey(),
            global_hotkey_alt: String::new(),
            hotkey_skip_fullscreen: true,
            global_hotkey_main_enabled: true,
            global_hotkey_main: default_global_hotkey_main(),
            global_hotkey_main_alt: String::new(),
            global_hotkey_palette_enabled: false,
            global_hotkey_palette: String::new(),
            global_hotkey_target: None,
            quick_prefix_commands: default_qp_commands(),
            quick_prefix_components: default_qp_components(),
            quick_prefix_category: default_qp_category(),
            quick_prefix_tag: default_qp_tag(),
            quick_prefix_tools: default_qp_tools(),
            quick_hidden_commands: Vec::new(),
            quick_shown_commands: Vec::new(),
            quick_favorite_commands: Vec::new(),
            quick_rank_by_usage: true,
            quick_command_presets: Vec::new(),
            quick_seen_commands: Vec::new(),
            quit_after_launch: false,
            hide_after_launch: false,
            switch_to_current_after_launch: true,
            startup_tab: default_startup_tab(),
            cli_fallback_version: String::new(),
            utility_palette_installed: false,
            keybindings: HashMap::new(),
            github_username: String::new(),
            github_token: String::new(),
            patreon_session_cookie: String::new(),
            patreon_download_root: String::new(),
            patreon_creators: Vec::new(),
            patreon_featured: None,
            patreon_featured_dismissed: false,
            patreon_trust_ack: false,
            backup_root: String::new(),
            cloud_backup_root: crate::rclone::default_cloud_backup_root(),
            backup_exclude: crate::backup::default_backup_exclude(),
            backup_include: String::new(),
            backup_max_file_mb: 0,
            backup_respect_gitignore: false,
            backup_skip_td_backups: false,
            palette_extra_folders: String::new(),
            package_index_url: default_package_index(),
            package_index_prefix: default_package_prefix(),
            fns_base_url: default_fns_base_url(),
            control_server_port: default_control_port(),
            control_server_lan: false,
            control_token: String::new(),
            control_client_token: String::new(),
            palette_tabs_enabled: true,
            auto_update_check: true,
            show_fns_tab: true,
            skipped_app_version: String::new(),
            skipped_utility_version: String::new(),
            control_touch_client: false,
            watch_tcp_port: default_watch_port(),
            watch_timeout_secs: default_watch_timeout(),
            watch_launch_grace_secs: default_watch_grace(),
            watch_max_restarts: default_watch_restarts(),
            watch_screenshot_on_crash: true,
            watch_reboot_after_crashes: 0,
            perf_monitor_enabled: false,
            perf_poll_secs: default_perf_poll_secs(),
            alert_email_enabled: false,
            alert_email_to: String::new(),
            alert_email_from: String::new(),
            alert_smtp_host: String::new(),
            alert_smtp_port: default_smtp_port(),
            alert_smtp_security: default_smtp_security(),
            alert_smtp_username: String::new(),
            alert_smtp_password: String::new(),
            alert_on_stall: true,
            alert_on_relaunch: true,
            alert_on_gave_up: true,
            alert_on_reboot: true,
            alert_attach_screenshot: true,
            alert_cooldown_secs: default_alert_cooldown(),
            toolbox_utility_seeded: false,
            toolbox_categories: vec![],
            toolbox_tools: vec![],
            recent_files: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PrefsUpdate {
    pub max_recent_files: Option<u32>,
    pub confirm_remove_from_list: Option<bool>,
    pub show_icons: Option<bool>,
    pub show_readme: Option<bool>,
    pub collapse_versions: Option<bool>,
    pub show_full_history: Option<bool>,
    pub has_prompted_file_assoc: Option<bool>,
    pub theme: Option<String>,
    pub view_mode: Option<String>,
    pub show_tray: Option<bool>,
    pub close_to_tray: Option<bool>,
    pub global_hotkey_enabled: Option<bool>,
    pub global_hotkey: Option<String>,
    pub global_hotkey_alt: Option<String>,
    pub hotkey_skip_fullscreen: Option<bool>,
    pub global_hotkey_main_enabled: Option<bool>,
    pub global_hotkey_main: Option<String>,
    pub global_hotkey_main_alt: Option<String>,
    pub global_hotkey_palette_enabled: Option<bool>,
    pub global_hotkey_palette: Option<String>,
    pub quick_prefix_commands: Option<String>,
    pub quick_prefix_components: Option<String>,
    pub quick_prefix_category: Option<String>,
    pub quick_prefix_tag: Option<String>,
    pub quick_prefix_tools: Option<String>,
    pub quick_hidden_commands: Option<Vec<String>>,
    pub quick_shown_commands: Option<Vec<String>>,
    pub quick_favorite_commands: Option<Vec<String>>,
    pub quick_rank_by_usage: Option<bool>,
    pub quick_command_presets: Option<Vec<QuickCommandPreset>>,
    pub hide_after_launch: Option<bool>,
    pub switch_to_current_after_launch: Option<bool>,
    pub startup_tab: Option<String>,
    pub cli_fallback_version: Option<String>,
    pub keybindings: Option<HashMap<String, String>>,
    pub quit_after_launch: Option<bool>,
    pub github_username: Option<String>,
    pub github_token: Option<String>,
    pub patreon_session_cookie: Option<String>,
    pub patreon_download_root: Option<String>,
    pub patreon_trust_ack: Option<bool>,
    pub backup_root: Option<String>,
    pub cloud_backup_root: Option<String>,
    pub backup_exclude: Option<String>,
    pub backup_include: Option<String>,
    pub backup_max_file_mb: Option<u64>,
    pub backup_respect_gitignore: Option<bool>,
    pub backup_skip_td_backups: Option<bool>,
    pub palette_extra_folders: Option<String>,
    pub package_index_url: Option<String>,
    pub package_index_prefix: Option<String>,
    pub fns_base_url: Option<String>,
    pub control_server_port: Option<u16>,
    pub control_touch_client: Option<bool>,
    pub auto_update_check: Option<bool>,
    pub show_fns_tab: Option<bool>,
    pub skipped_app_version: Option<String>,
    pub skipped_utility_version: Option<String>,
    pub control_server_lan: Option<bool>,
    pub palette_tabs_enabled: Option<bool>,
    pub watch_tcp_port: Option<u16>,
    pub watch_timeout_secs: Option<u32>,
    pub watch_launch_grace_secs: Option<u32>,
    pub watch_max_restarts: Option<u32>,
    pub watch_screenshot_on_crash: Option<bool>,
    pub watch_reboot_after_crashes: Option<u32>,
    pub perf_monitor_enabled: Option<bool>,
    pub perf_poll_secs: Option<u32>,
    pub alert_email_enabled: Option<bool>,
    pub alert_email_to: Option<String>,
    pub alert_email_from: Option<String>,
    pub alert_smtp_host: Option<String>,
    pub alert_smtp_port: Option<u16>,
    pub alert_smtp_security: Option<String>,
    pub alert_smtp_username: Option<String>,
    pub alert_smtp_password: Option<String>,
    pub alert_on_stall: Option<bool>,
    pub alert_on_relaunch: Option<bool>,
    pub alert_on_gave_up: Option<bool>,
    pub alert_on_reboot: Option<bool>,
    pub alert_attach_screenshot: Option<bool>,
    pub alert_cooldown_secs: Option<u32>,
}

pub struct ConfigManager {
    config_dir: PathBuf,
    config_file: PathBuf,
    pub config: AppConfig,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlusTemplatesImport {
    pub imported: u32,
    pub total: u32,
    pub source: String,
}

#[derive(Debug, Deserialize)]
struct PlusConfigSlice {
    #[serde(default)]
    templates: Vec<PathEntry>,
    #[serde(default)]
    launcher_recents: Vec<PathEntry>,
    #[serde(default)]
    recent_files: Option<Vec<PathEntry>>,
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn normalize_path(p: &str) -> String {
    let path = Path::new(p);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(path)
    };
    let canon = abs.canonicalize().unwrap_or(abs);
    let s = canon.to_string_lossy().to_string();
    // Strip Windows \\?\ prefix
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    #[cfg(windows)]
    {
        s.to_lowercase().replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        s
    }
}

impl ConfigManager {
    pub fn new() -> Self {
        let config_dir = Self::config_dir();
        let config_file = config_dir.join("config.json");
        let mut mgr = Self {
            config_dir,
            config_file,
            config: AppConfig::default(),
        };
        // Before the first load: a pre-rename install keeps its settings.
        match adopt_legacy_config(&mgr.config_file, &Self::legacy_config_dir().join("config.json")) {
            Ok(true) => log::info!(
                "Adopted settings from the pre-rename config at {}",
                Self::legacy_config_dir().display()
            ),
            Err(e) => log::warn!("Legacy config adoption failed: {e}"),
            _ => {}
        }
        mgr.load();
        match mgr.seed_templates_from_plus_if_empty() {
            Ok(n) if n > 0 => {
                log::info!("Seeded {n} template(s) from TD Launcher Plus config");
            }
            Err(e) => {
                log::debug!("Plus template seed skipped: {e}");
            }
            _ => {}
        }
        match mgr.seed_recents_from_plus_if_empty() {
            Ok(n) if n > 0 => {
                log::info!("Seeded {n} recent(s) from TD Launcher Plus config");
            }
            Err(e) => {
                log::debug!("Plus recent seed skipped: {e}");
            }
            _ => {}
        }
        mgr
    }

    /// Where the app stored its config before the TDXLU rename.
    ///
    /// Still read (never written, never deleted) so an update is not a silent
    /// factory reset — and so downgrading to an older build keeps working.
    pub fn legacy_config_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("TDXLPP")
        }
        #[cfg(not(target_os = "windows"))]
        {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
                .join("tdxlpp")
        }
    }

    pub fn config_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("TDXLU")
        }
        #[cfg(not(target_os = "windows"))]
        {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
                .join("tdxlu")
        }
    }

    /// TD Launcher Plus config.json (sibling app - templates/recents live here).
    pub fn plus_config_path() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("TD Launcher Plus")
                .join("config.json")
        }
        #[cfg(not(target_os = "windows"))]
        {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
                .join("td-launcher")
                .join("config.json")
        }
    }

    fn read_plus_config_slice() -> Result<PlusConfigSlice, String> {
        let path = Self::plus_config_path();
        if !path.is_file() {
            return Err(format!(
                "TD Launcher Plus config not found:\n{}",
                path.display()
            ));
        }
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    fn read_plus_templates() -> Result<Vec<PathEntry>, String> {
        Ok(Self::read_plus_config_slice()?.templates)
    }

    fn read_plus_launcher_recents() -> Result<Vec<PathEntry>, String> {
        let slice = Self::read_plus_config_slice()?;
        if !slice.launcher_recents.is_empty() {
            return Ok(slice.launcher_recents);
        }
        Ok(slice.recent_files.unwrap_or_default())
    }

    /// If our templates list is empty, copy from Plus once and save.
    pub fn seed_templates_from_plus_if_empty(&mut self) -> Result<u32, String> {
        if !self.config.templates.is_empty() {
            return Ok(0);
        }
        let plus = Self::read_plus_templates()?;
        if plus.is_empty() {
            return Ok(0);
        }
        let n = plus.len() as u32;
        self.config.templates = plus;
        self.save()?;
        Ok(n)
    }

    /// If our launcher recents list is empty, copy from Plus once and save.
    pub fn seed_recents_from_plus_if_empty(&mut self) -> Result<u32, String> {
        if !self.config.launcher_recents.is_empty() {
            return Ok(0);
        }
        let plus = Self::read_plus_launcher_recents()?;
        if plus.is_empty() {
            return Ok(0);
        }
        let max = self.config.max_recent_files as usize;
        let mut seeded = plus;
        seeded.truncate(max);
        let n = seeded.len() as u32;
        self.config.launcher_recents = seeded;
        self.save()?;
        Ok(n)
    }

    /// Merge templates from Plus (skip paths we already have). Returns how many were added.
    pub fn import_templates_from_plus(&mut self) -> Result<PlusTemplatesImport, String> {
        let source = Self::plus_config_path()
            .to_string_lossy()
            .to_string();
        let plus = Self::read_plus_templates()?;
        let mut imported = 0u32;
        for entry in plus {
            let norm = normalize_path(entry.path());
            if self
                .config
                .templates
                .iter()
                .any(|t| normalize_path(t.path()) == norm)
            {
                continue;
            }
            self.config.templates.push(entry);
            imported += 1;
        }
        if imported > 0 {
            self.save()?;
        }
        Ok(PlusTemplatesImport {
            imported,
            total: self.config.templates.len() as u32,
            source,
        })
    }

    pub fn load(&mut self) {
        if let Ok(text) = fs::read_to_string(&self.config_file) {
            if let Ok(mut loaded) = serde_json::from_str::<AppConfig>(&text) {
                if loaded.launcher_recents.is_empty() {
                    if let Some(legacy) = loaded.recent_files.take() {
                        loaded.launcher_recents = legacy;
                    }
                }
                if let Some(legacy_target) = loaded.global_hotkey_target.take() {
                    if legacy_target.trim().eq_ignore_ascii_case("window") {
                        // Old behavior: the single hotkey opened the main
                        // window. Move it to the new dedicated main-window
                        // hotkey; leave the quick-launch hotkey at its
                        // default, disabled, so it doesn't newly collide
                        // with the same combo.
                        loaded.global_hotkey_main = loaded.global_hotkey.clone();
                        loaded.global_hotkey_main_enabled = loaded.global_hotkey_enabled;
                        loaded.global_hotkey = default_global_hotkey();
                        loaded.global_hotkey_enabled = false;
                    }
                }
                // 0.7.1: the flagship combo (Ctrl/⌘+Shift+D) now shows the
                // main window, and Quick Launch moved to a secondary default.
                // Configs still on the old default scheme (Quick Launch on
                // the flagship combo, main-window hotkey unbound) follow the
                // swap; deliberate custom bindings are left alone.
                if loaded.global_hotkey.trim() == default_global_hotkey_main()
                    && loaded.global_hotkey_main.trim().is_empty()
                    && !loaded.global_hotkey_main_enabled
                {
                    loaded.global_hotkey_main = default_global_hotkey_main();
                    loaded.global_hotkey_main_enabled = loaded.global_hotkey_enabled;
                    loaded.global_hotkey = default_global_hotkey();
                }
                // Same combo on both (e.g. a pre-split config whose missing
                // main-window fields were filled with the new defaults): the
                // main window wins the combo, Quick Launch falls back to its
                // secondary default.
                if loaded.global_hotkey_enabled
                    && loaded.global_hotkey_main_enabled
                    && !loaded.global_hotkey.trim().is_empty()
                    && loaded.global_hotkey.trim() == loaded.global_hotkey_main.trim()
                {
                    loaded.global_hotkey = default_global_hotkey();
                }
                // The dead pre-migration bucket host never survives a load,
                // wherever the value came from.
                loaded.fns_base_url = normalize_fns_base(&loaded.fns_base_url);
                self.config = loaded;
                return;
            }
        }
        self.config = AppConfig::default();
    }

    pub fn save(&self) -> Result<(), String> {
        fs::create_dir_all(&self.config_dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(&self.config).map_err(|e| e.to_string())?;
        fs::write(&self.config_file, text).map_err(|e| e.to_string())
    }

    pub fn apply_prefs(&mut self, prefs: PrefsUpdate) -> Result<(), String> {
        if let Some(v) = prefs.max_recent_files {
            self.config.max_recent_files = v.clamp(5, 200);
        }
        if let Some(v) = prefs.confirm_remove_from_list {
            self.config.confirm_remove_from_list = v;
        }
        if let Some(v) = prefs.show_icons {
            self.config.show_icons = v;
        }
        if let Some(v) = prefs.show_readme {
            self.config.show_readme = v;
        }
        if let Some(v) = prefs.collapse_versions {
            self.config.collapse_versions = v;
        }
        if let Some(v) = prefs.show_full_history {
            self.config.show_full_history = v;
        }
        if let Some(v) = prefs.has_prompted_file_assoc {
            self.config.has_prompted_file_assoc = v;
        }
        if let Some(v) = prefs.theme {
            self.config.theme = normalize_theme(&v);
        }
        if let Some(v) = prefs.view_mode {
            self.config.view_mode = normalize_view_mode(&v);
        }
        if let Some(v) = prefs.show_tray {
            self.config.show_tray = v;
        }
        if let Some(v) = prefs.close_to_tray {
            self.config.close_to_tray = v;
        }
        if let Some(v) = prefs.global_hotkey_enabled {
            self.config.global_hotkey_enabled = v;
        }
        if let Some(v) = prefs.global_hotkey {
            self.config.global_hotkey = normalize_accelerator(&v);
        }
        if let Some(v) = prefs.global_hotkey_alt {
            self.config.global_hotkey_alt = normalize_accelerator(&v);
        }
        if let Some(v) = prefs.hotkey_skip_fullscreen {
            self.config.hotkey_skip_fullscreen = v;
        }
        if let Some(v) = prefs.global_hotkey_main_enabled {
            self.config.global_hotkey_main_enabled = v;
        }
        if let Some(v) = prefs.global_hotkey_main {
            self.config.global_hotkey_main = normalize_accelerator(&v);
        }
        if let Some(v) = prefs.global_hotkey_main_alt {
            self.config.global_hotkey_main_alt = normalize_accelerator(&v);
        }
        if let Some(v) = prefs.global_hotkey_palette_enabled {
            self.config.global_hotkey_palette_enabled = v;
        }
        if let Some(v) = prefs.global_hotkey_palette {
            self.config.global_hotkey_palette = normalize_accelerator(&v);
        }
        // Prefix chars: accept exactly one non-whitespace character each.
        let valid_prefix = |v: &str| v.chars().count() == 1 && !v.chars().any(char::is_whitespace);
        if let Some(v) = prefs.quick_prefix_commands {
            let v = v.trim().to_string();
            if valid_prefix(&v) {
                self.config.quick_prefix_commands = v;
            }
        }
        if let Some(v) = prefs.quick_prefix_components {
            let v = v.trim().to_string();
            if valid_prefix(&v) {
                self.config.quick_prefix_components = v;
            }
        }
        if let Some(v) = prefs.quick_prefix_category {
            let v = v.trim().to_string();
            if valid_prefix(&v) {
                self.config.quick_prefix_category = v;
            }
        }
        if let Some(v) = prefs.quick_prefix_tag {
            let v = v.trim().to_string();
            if valid_prefix(&v) {
                self.config.quick_prefix_tag = v;
            }
        }
        if let Some(v) = prefs.quick_prefix_tools {
            let v = v.trim().to_string();
            if valid_prefix(&v) {
                self.config.quick_prefix_tools = v;
            }
        }
        // Curation lists: normalized (trimmed, non-empty, deduped) — the
        // frontend sends the whole list on every toggle.
        let clean_list = |list: Vec<String>| {
            let mut seen = std::collections::HashSet::new();
            list.into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && seen.insert(s.clone()))
                .collect::<Vec<_>>()
        };
        if let Some(v) = prefs.quick_hidden_commands {
            self.config.quick_hidden_commands = clean_list(v);
        }
        if let Some(v) = prefs.quick_shown_commands {
            self.config.quick_shown_commands = clean_list(v);
        }
        if let Some(v) = prefs.quick_favorite_commands {
            self.config.quick_favorite_commands = clean_list(v);
        }
        if let Some(v) = prefs.quick_rank_by_usage {
            self.config.quick_rank_by_usage = v;
        }
        if let Some(v) = prefs.quick_command_presets {
            // Keep only well-formed presets; the frontend sends the whole
            // list on every edit, so this fully replaces.
            self.config.quick_command_presets = v
                .into_iter()
                .map(|mut p| {
                    p.label = p.label.trim().to_string();
                    p.target = p.target.trim().to_string();
                    p.kwargs.retain(|_, val| !val.trim().is_empty());
                    p
                })
                .filter(|p| !p.label.is_empty() && !p.target.is_empty())
                .take(100)
                .collect();
        }
        if let Some(v) = prefs.quit_after_launch {
            self.config.quit_after_launch = v;
        }
        if let Some(v) = prefs.hide_after_launch {
            self.config.hide_after_launch = v;
        }
        if let Some(v) = prefs.startup_tab {
            let v = v.trim().to_ascii_lowercase();
            if STARTUP_TABS.contains(&v.as_str()) {
                self.config.startup_tab = v;
            }
        }
        if let Some(v) = prefs.switch_to_current_after_launch {
            self.config.switch_to_current_after_launch = v;
        }
        if let Some(v) = prefs.cli_fallback_version {
            self.config.cli_fallback_version = v;
        }
        if let Some(v) = prefs.keybindings {
            // Full replacement of the override map (frontend sends the whole set).
            self.config.keybindings = v;
        }
        if let Some(v) = prefs.github_username {
            self.config.github_username = v.trim().to_string();
        }
        if let Some(v) = prefs.github_token {
            self.config.github_token = v.trim().to_string();
        }
        if let Some(v) = prefs.patreon_session_cookie {
            self.config.patreon_session_cookie = v.trim().to_string();
        }
        if let Some(v) = prefs.patreon_download_root {
            self.config.patreon_download_root = v.trim().to_string();
        }
        if let Some(v) = prefs.patreon_trust_ack {
            self.config.patreon_trust_ack = v;
        }
        if let Some(v) = prefs.backup_root {
            self.config.backup_root = v.trim().to_string();
        }
        if let Some(v) = prefs.cloud_backup_root {
            // A ':' would switch rclone remotes; '/'-normalize and keep it a
            // plain sub-path. Empty is valid (project folders at remote root).
            let cleaned = v.replace('\\', "/");
            let cleaned = cleaned.trim().trim_matches('/');
            if cleaned.contains(':') {
                return Err("Cloud backup root cannot contain ':'".into());
            }
            self.config.cloud_backup_root = cleaned.to_string();
        }
        if let Some(v) = prefs.backup_exclude {
            self.config.backup_exclude = v;
        }
        if let Some(v) = prefs.backup_include {
            self.config.backup_include = v;
        }
        if let Some(v) = prefs.backup_max_file_mb {
            self.config.backup_max_file_mb = v;
        }
        if let Some(v) = prefs.backup_respect_gitignore {
            self.config.backup_respect_gitignore = v;
        }
        if let Some(v) = prefs.backup_skip_td_backups {
            self.config.backup_skip_td_backups = v;
        }
        if let Some(v) = prefs.palette_extra_folders {
            self.config.palette_extra_folders = v;
        }
        if let Some(v) = prefs.package_index_url {
            let t = v.trim();
            self.config.package_index_url = if t.is_empty() {
                default_package_index()
            } else {
                t.trim_end_matches('/').to_string()
            };
        }
        if let Some(v) = prefs.package_index_prefix {
            // Empty is valid (list everything) — store trimmed as-is.
            self.config.package_index_prefix = v.trim().to_string();
        }
        if let Some(v) = prefs.fns_base_url {
            self.config.fns_base_url = normalize_fns_base(&v);
        }
        if let Some(v) = prefs.control_server_port {
            self.config.control_server_port = if v == 0 { default_control_port() } else { v };
        }
        if let Some(v) = prefs.control_server_lan {
            self.config.control_server_lan = v;
        }
        if let Some(v) = prefs.palette_tabs_enabled {
            self.config.palette_tabs_enabled = v;
        }
        if let Some(v) = prefs.control_touch_client {
            self.config.control_touch_client = v;
        }
        if let Some(v) = prefs.auto_update_check {
            self.config.auto_update_check = v;
        }
        if let Some(v) = prefs.show_fns_tab {
            self.config.show_fns_tab = v;
        }
        if let Some(v) = prefs.skipped_app_version {
            self.config.skipped_app_version = v.trim().to_string();
        }
        if let Some(v) = prefs.skipped_utility_version {
            self.config.skipped_utility_version = v.trim().to_string();
        }
        if let Some(v) = prefs.watch_tcp_port {
            self.config.watch_tcp_port = if v == 0 { 11999 } else { v };
        }
        if let Some(v) = prefs.watch_timeout_secs {
            self.config.watch_timeout_secs = v.clamp(5, 3600);
        }
        if let Some(v) = prefs.watch_launch_grace_secs {
            self.config.watch_launch_grace_secs = v.clamp(5, 3600);
        }
        if let Some(v) = prefs.watch_max_restarts {
            self.config.watch_max_restarts = v.clamp(0, 100);
        }
        if let Some(v) = prefs.watch_screenshot_on_crash {
            self.config.watch_screenshot_on_crash = v;
        }
        if let Some(v) = prefs.watch_reboot_after_crashes {
            self.config.watch_reboot_after_crashes = v;
        }
        if let Some(v) = prefs.alert_email_enabled {
            self.config.alert_email_enabled = v;
        }
        if let Some(v) = prefs.alert_email_to {
            self.config.alert_email_to = v.trim().to_string();
        }
        if let Some(v) = prefs.alert_email_from {
            self.config.alert_email_from = v.trim().to_string();
        }
        if let Some(v) = prefs.alert_smtp_host {
            self.config.alert_smtp_host = v.trim().to_string();
        }
        if let Some(v) = prefs.alert_smtp_port {
            self.config.alert_smtp_port = if v == 0 { 587 } else { v };
        }
        if let Some(v) = prefs.alert_smtp_security {
            let s = v.trim().to_ascii_lowercase();
            self.config.alert_smtp_security = match s.as_str() {
                "tls" | "ssl" | "wrapper" => "tls".into(),
                "none" | "off" | "plain" => "none".into(),
                _ => "starttls".into(),
            };
        }
        if let Some(v) = prefs.alert_smtp_username {
            self.config.alert_smtp_username = v.trim().to_string();
        }
        if let Some(v) = prefs.alert_smtp_password {
            self.config.alert_smtp_password = v; // allow spaces in app passwords rarely
        }
        if let Some(v) = prefs.alert_on_stall {
            self.config.alert_on_stall = v;
        }
        if let Some(v) = prefs.alert_on_relaunch {
            self.config.alert_on_relaunch = v;
        }
        if let Some(v) = prefs.alert_on_gave_up {
            self.config.alert_on_gave_up = v;
        }
        if let Some(v) = prefs.alert_on_reboot {
            self.config.alert_on_reboot = v;
        }
        if let Some(v) = prefs.alert_attach_screenshot {
            self.config.alert_attach_screenshot = v;
        }
        if let Some(v) = prefs.alert_cooldown_secs {
            self.config.alert_cooldown_secs = v.clamp(0, 86_400);
        }
        if let Some(v) = prefs.perf_monitor_enabled {
            self.config.perf_monitor_enabled = v;
        }
        if let Some(v) = prefs.perf_poll_secs {
            self.config.perf_poll_secs = v.clamp(2, 60);
        }
        self.save()
    }

    pub fn add_recent_file(&mut self, file_path: &str) -> Result<(), String> {
        let abs = Path::new(file_path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(file_path));
        let abs_str = abs
            .to_string_lossy()
            .strip_prefix(r"\\?\")
            .map(|s| s.to_string())
            .unwrap_or_else(|| abs.to_string_lossy().to_string());
        let norm = normalize_path(&abs_str);

        self.config.launcher_recents.retain(|e| normalize_path(e.path()) != norm);
        self.config.launcher_recents.insert(
            0,
            PathEntry::Rich {
                path: abs_str,
                source: Some("launcher".into()),
                last_opened: Some(now_secs()),
            },
        );
        let max = self.config.max_recent_files as usize;
        self.config.launcher_recents.truncate(max);
        self.save()
    }

    pub fn remove_recent_file(&mut self, file_path: &str) -> Result<(), String> {
        let norm = normalize_path(file_path);
        self.config
            .launcher_recents
            .retain(|e| normalize_path(e.path()) != norm);
        self.config
            .td_recents
            .retain(|e| normalize_path(e.path()) != norm);

        #[cfg(windows)]
        {
            blank_windows_td_recent(file_path);
        }

        self.save()
    }

    pub fn clear_recents(&mut self) -> Result<(), String> {
        self.config.launcher_recents.clear();
        self.config.td_recents.clear();
        self.save()
    }

    pub fn clear_missing_files(&mut self) -> Result<u32, String> {
        let mut removed = 0u32;

        let before = self.config.launcher_recents.len();
        self.config
            .launcher_recents
            .retain(|e| Path::new(e.path()).exists());
        removed += (before - self.config.launcher_recents.len()) as u32;

        let before = self.config.td_recents.len();
        self.config
            .td_recents
            .retain(|e| Path::new(e.path()).exists());
        removed += (before - self.config.td_recents.len()) as u32;

        #[cfg(windows)]
        {
            for entry in read_windows_td_recents() {
                if !Path::new(&entry.path).exists() {
                    blank_windows_td_recent(&entry.path);
                    removed += 1;
                }
            }
        }

        let before = self.config.templates.len();
        self.config
            .templates
            .retain(|e| Path::new(e.path()).exists());
        removed += (before - self.config.templates.len()) as u32;

        self.save()?;
        Ok(removed)
    }

    pub fn get_merged_recents(&self) -> Vec<RecentEntry> {
        let launcher: Vec<RecentEntry> = self
            .config
            .launcher_recents
            .iter()
            .cloned()
            .map(|e| e.into_rich("launcher"))
            .collect();

        #[cfg(windows)]
        let td_recents = read_windows_td_recents();

        #[cfg(target_os = "macos")]
        let td_recents = {
            let mut list = read_mac_td_recents();
            let sfl_paths: std::collections::HashSet<String> =
                list.iter().map(|e| normalize_path(&e.path)).collect();
            for entry in &self.config.td_recents {
                let p = entry.path().to_string();
                if !p.is_empty() && !sfl_paths.contains(&normalize_path(&p)) {
                    list.push(RecentEntry {
                        path: p,
                        source: Some("td".into()),
                        last_opened: None,
                    });
                }
            }
            list
        };

        #[cfg(not(any(windows, target_os = "macos")))]
        let td_recents: Vec<RecentEntry> = self
            .config
            .td_recents
            .iter()
            .cloned()
            .map(|e| e.into_rich("td"))
            .collect();

        let mut seen = std::collections::HashSet::new();
        let mut merged = Vec::new();

        let mut append = |items: Vec<RecentEntry>, force_source: Option<&str>| {
            for mut item in items {
                let norm = normalize_path(&item.path);
                if item.path.is_empty() || seen.contains(&norm) {
                    continue;
                }
                if let Some(s) = force_source {
                    item.source = Some(s.to_string());
                }
                seen.insert(norm);
                merged.push(item);
            }
        };

        #[cfg(target_os = "macos")]
        {
            let ts = self.config.td_recents_timestamp;
            let mut recent_launcher = Vec::new();
            let mut older_launcher = Vec::new();
            for item in launcher {
                if item.last_opened.unwrap_or(0.0) > ts {
                    recent_launcher.push(item);
                } else {
                    older_launcher.push(item);
                }
            }
            recent_launcher.sort_by(|a, b| {
                b.last_opened
                    .partial_cmp(&a.last_opened)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            append(recent_launcher, None);
            append(td_recents, Some("td"));
            append(older_launcher, None);
        }

        #[cfg(not(target_os = "macos"))]
        {
            append(td_recents, Some("td"));
            append(launcher, None);
        }

        merged
    }

    pub fn get_launcher_recents_only(&self) -> Vec<RecentEntry> {
        self.config
            .launcher_recents
            .iter()
            .cloned()
            .map(|e| e.into_rich("launcher"))
            .collect()
    }

    pub fn get_templates(&self) -> Vec<String> {
        self.config
            .templates
            .iter()
            .map(|e| e.path().to_string())
            .collect()
    }

    pub fn add_template(&mut self, file_path: &str) -> Result<(), String> {
        let abs = Path::new(file_path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(file_path));
        let abs_str = abs
            .to_string_lossy()
            .strip_prefix(r"\\?\")
            .map(|s| s.to_string())
            .unwrap_or_else(|| abs.to_string_lossy().to_string());
        let norm = normalize_path(&abs_str);
        if self
            .config
            .templates
            .iter()
            .any(|t| normalize_path(t.path()) == norm)
        {
            return Ok(());
        }
        self.config.templates.insert(0, PathEntry::Path(abs_str));
        self.save()
    }

    pub fn remove_template(&mut self, file_path: &str) -> Result<(), String> {
        let norm = normalize_path(file_path);
        self.config
            .templates
            .retain(|t| normalize_path(t.path()) != norm);
        self.save()
    }

    pub fn move_template(&mut self, file_path: &str, direction: &str) -> Result<(), String> {
        let norm = normalize_path(file_path);
        let idx = self
            .config
            .templates
            .iter()
            .position(|t| normalize_path(t.path()) == norm)
            .ok_or_else(|| "Template not found".to_string())?;
        let len = self.config.templates.len();
        if len == 0 {
            return Ok(());
        }
        match direction {
            "up" => {
                if idx == 0 {
                    let item = self.config.templates.remove(0);
                    self.config.templates.push(item);
                } else {
                    self.config.templates.swap(idx, idx - 1);
                }
            }
            "down" => {
                if idx >= len - 1 {
                    let item = self.config.templates.remove(idx);
                    self.config.templates.insert(0, item);
                } else {
                    self.config.templates.swap(idx, idx + 1);
                }
            }
            _ => return Err("direction must be up or down".into()),
        }
        self.save()
    }

    // ----- Toolbox (pinned palette tools) -----

    fn toolbox_tool_index(&self, id: &str) -> Result<usize, String> {
        self.config
            .toolbox_tools
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| "Toolbox tool not found".to_string())
    }

    /// Register `name` as a category if it's new. Empty = top level, ignored.
    fn toolbox_ensure_category(&mut self, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        if !self
            .config
            .toolbox_categories
            .iter()
            .any(|c| c.eq_ignore_ascii_case(name))
        {
            self.config.toolbox_categories.push(name.to_string());
        }
    }

    /// Canonical stored spelling of a category (case-insensitive match).
    fn toolbox_canonical_category(&self, name: &str) -> String {
        let name = name.trim();
        self.config
            .toolbox_categories
            .iter()
            .find(|c| c.eq_ignore_ascii_case(name))
            .cloned()
            .unwrap_or_else(|| name.to_string())
    }

    /// Portable settings snapshot for export. Allowlist-based so secrets
    /// (tokens, cookies, passwords) can never leak into the file; the
    /// machine-local path settings are opt-in via `include_paths`.
    /// Upsert sightings into the historical tool-command catalog (see
    /// [`QuickSeenCommand`]). Display data from the newer side wins and
    /// `last_seen` keeps the max, so a live sighting refreshes an imported
    /// entry while importing an older catalog never clobbers fresher local
    /// data. Returns the number of identities new to this machine. Saves only
    /// on a material change -- the palette merges on every summon and must
    /// not rewrite config each time.
    pub fn merge_quick_seen_commands(
        &mut self,
        cmds: Vec<QuickSeenCommand>,
    ) -> Result<usize, String> {
        if cmds.is_empty() {
            return Ok(0);
        }
        let mut added = 0usize;
        let mut dirty = false;
        for mut c in cmds {
            c.tool = c.tool.trim().to_string();
            c.id = c.id.trim().to_string();
            c.identity = c.identity.trim().to_string();
            if c.identity.is_empty() {
                c.identity = format!("{}#{}", c.tool, c.id);
            }
            if c.id.is_empty() || c.tool.is_empty() {
                continue;
            }
            if c.label.trim().is_empty() {
                c.label = c.id.clone();
            }
            match self
                .config
                .quick_seen_commands
                .iter_mut()
                .find(|e| e.identity == c.identity)
            {
                Some(e) => {
                    if c.last_seen < e.last_seen {
                        continue;
                    }
                    let material = e.label != c.label
                        || e.help != c.help
                        || e.hidden != c.hidden
                        || e.builtin != c.builtin
                        || e.param_count != c.param_count
                        || e.params != c.params
                        || e.instances != c.instances
                        || c.last_seen - e.last_seen >= QUICK_SEEN_TOUCH_SECS;
                    *e = c;
                    dirty = dirty || material;
                }
                None => {
                    self.config.quick_seen_commands.push(c);
                    added += 1;
                    dirty = true;
                }
            }
        }
        if !dirty {
            // Only `last_seen` moved, and not far. The in-memory bump stands;
            // skipping the write is the whole point of the touch threshold.
            return Ok(0);
        }
        self.config
            .quick_seen_commands
            .sort_by(|a, b| b.last_seen.partial_cmp(&a.last_seen).unwrap_or(std::cmp::Ordering::Equal));
        self.config
            .quick_seen_commands
            .truncate(QUICK_SEEN_COMMANDS_MAX);
        self.save()?;
        Ok(added)
    }

    pub fn export_settings(&self, include_paths: bool) -> Result<serde_json::Value, String> {
        const PREF_KEYS: &[&str] = &[
            "max_recent_files",
            "confirm_remove_from_list",
            "show_icons",
            "show_readme",
            "collapse_versions",
            "show_full_history",
            "theme",
            "view_mode",
            "show_tray",
            "close_to_tray",
            "global_hotkey_enabled",
            "global_hotkey",
            "global_hotkey_alt",
            "hotkey_skip_fullscreen",
            "global_hotkey_main_enabled",
            "global_hotkey_main",
            "global_hotkey_main_alt",
            "global_hotkey_palette_enabled",
            "global_hotkey_palette",
            "quick_prefix_commands",
            "quick_prefix_components",
            "quick_prefix_category",
            "quick_prefix_tag",
            "quick_prefix_tools",
            "quick_hidden_commands",
            "quick_shown_commands",
            "quick_favorite_commands",
            "quick_command_presets",
            "quit_after_launch",
            "hide_after_launch",
            "switch_to_current_after_launch",
            "startup_tab",
            "quick_rank_by_usage",
            "cli_fallback_version",
            "keybindings",
            "github_username",
            "backup_exclude",
            "backup_include",
            "backup_max_file_mb",
            "backup_respect_gitignore",
            "backup_skip_td_backups",
            "cloud_backup_root",
            "package_index_url",
            "package_index_prefix",
            "fns_base_url",
            "control_server_port",
            "control_server_lan",
            "control_touch_client",
            "auto_update_check",
            "show_fns_tab",
            "watch_tcp_port",
            "watch_timeout_secs",
            "watch_launch_grace_secs",
            "watch_max_restarts",
            "watch_screenshot_on_crash",
            "watch_reboot_after_crashes",
            "alert_email_enabled",
            "alert_email_to",
            "alert_email_from",
            "alert_smtp_host",
            "alert_smtp_port",
            "alert_smtp_security",
            "alert_smtp_username",
            "alert_on_stall",
            "alert_on_relaunch",
            "alert_on_gave_up",
            "alert_on_reboot",
            "alert_attach_screenshot",
            "alert_cooldown_secs",
        ];
        const PATH_KEYS: &[&str] = &["backup_root", "patreon_download_root", "palette_extra_folders"];

        let full = serde_json::to_value(&self.config).map_err(|e| e.to_string())?;
        let obj = full
            .as_object()
            .ok_or_else(|| "Config did not serialize to an object".to_string())?;
        let mut prefs = serde_json::Map::new();
        for k in PREF_KEYS {
            if let Some(v) = obj.get(*k) {
                prefs.insert((*k).to_string(), v.clone());
            }
        }
        if include_paths {
            for k in PATH_KEYS {
                if let Some(v) = obj.get(*k) {
                    prefs.insert((*k).to_string(), v.clone());
                }
            }
        }
        // Tools travel without id / cached_path / added_at — regenerated on import.
        let tools: Vec<serde_json::Value> = self
            .config
            .toolbox_tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "label": t.label,
                    "kind": t.kind,
                    "source": t.source,
                    "category": t.category,
                    "notes": t.notes,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "format": "tdxlu-settings",
            "version": 1,
            "prefs": prefs,
            "toolbox": {
                "categories": self.config.toolbox_categories,
                "tools": tools,
            },
            // The historical command catalog rides along so curation and
            // presets can be authored on the new machine before the tools
            // that register those commands ever run there.
            "quick_seen_commands": self.config.quick_seen_commands,
        }))
    }

    /// Merge an exported settings file: known prefs through the normal
    /// apply-prefs path (absent fields stay untouched), toolbox unioned by
    /// (kind, source), seen-commands catalog unioned by identity.
    pub fn import_settings(
        &mut self,
        value: &serde_json::Value,
    ) -> Result<SettingsImportCounts, String> {
        let obj = value
            .as_object()
            .ok_or_else(|| "Not a settings file (expected a JSON object)".to_string())?;
        if let Some(f) = obj.get("format").and_then(|f| f.as_str()) {
            if f != "tdxlu-settings" {
                return Err(format!("Not a TDXLU settings export (format: {f})"));
            }
        }

        let mut prefs_applied = 0usize;
        if let Some(prefs_v) = obj.get("prefs") {
            let prefs: PrefsUpdate = serde_json::from_value(prefs_v.clone())
                .map_err(|e| format!("Bad prefs section: {e}"))?;
            prefs_applied = serde_json::to_value(&prefs)
                .ok()
                .and_then(|v| v.as_object().map(|m| m.values().filter(|v| !v.is_null()).count()))
                .unwrap_or(0);
            if prefs_applied > 0 {
                self.apply_prefs(prefs)?;
            }
        }

        let mut tools_added = 0usize;
        let mut categories_added = 0usize;
        if let Some(tb) = obj.get("toolbox").and_then(|t| t.as_object()) {
            if let Some(cats) = tb.get("categories").and_then(|c| c.as_array()) {
                for c in cats.iter().filter_map(|c| c.as_str()) {
                    let before = self.config.toolbox_categories.len();
                    self.toolbox_ensure_category(c);
                    if self.config.toolbox_categories.len() > before {
                        categories_added += 1;
                    }
                }
            }
            if let Some(tools) = tb.get("tools").and_then(|t| t.as_array()) {
                let tool_key = |kind: &str, source: &str| {
                    format!(
                        "{}\n{}",
                        kind.to_ascii_lowercase(),
                        source.trim().replace('\\', "/").to_ascii_lowercase()
                    )
                };
                let mut have: std::collections::HashSet<String> = self
                    .config
                    .toolbox_tools
                    .iter()
                    .map(|t| tool_key(&t.kind, &t.source))
                    .collect();
                for t in tools {
                    let Some(o) = t.as_object() else { continue };
                    let s = |k: &str| o.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let (kind, source) = (s("kind"), s("source"));
                    if source.trim().is_empty() {
                        continue;
                    }
                    let k = tool_key(&kind, &source);
                    if have.contains(&k) {
                        continue;
                    }
                    // Malformed entries (unknown kind etc.) are skipped, not fatal.
                    if self
                        .toolbox_add_tool(&s("label"), &kind, &source, &s("category"), &s("notes"))
                        .is_ok()
                    {
                        have.insert(k);
                        tools_added += 1;
                    }
                }
            }
        }
        // The seen-commands catalog is history, so it unions rather than
        // replaces -- and it lands even when the exporting machine had
        // commands this one has never registered. That is the point: the
        // curation and presets imported above can now be edited here first
        // and simply take effect when the tool eventually shows up.
        let mut commands_added = 0usize;
        if let Some(seen) = obj.get("quick_seen_commands") {
            let cmds: Vec<QuickSeenCommand> = serde_json::from_value(seen.clone())
                .map_err(|e| format!("Bad quick_seen_commands section: {e}"))?;
            commands_added = self.merge_quick_seen_commands(cmds)?;
        }

        // Category adds don't save on their own (prefs/tools do); make sure
        // they land even when nothing else changed after them.
        if categories_added > 0 {
            self.save()?;
        }
        Ok(SettingsImportCounts {
            prefs_applied,
            tools_added,
            categories_added,
            commands_added,
        })
    }

    pub fn toolbox_add_tool(
        &mut self,
        label: &str,
        kind: &str,
        source: &str,
        category: &str,
        notes: &str,
    ) -> Result<String, String> {
        if !TOOLBOX_KINDS.contains(&kind) {
            return Err(format!("Unknown tool kind: {kind}"));
        }
        let source = source.trim();
        if source.is_empty() {
            return Err("Tool source is empty".into());
        }
        if kind == "local" && !source.to_ascii_lowercase().ends_with(".tox") {
            return Err("Local tools must point at a .tox file".into());
        }
        let label = {
            let l = label.trim();
            if l.is_empty() {
                default_toolbox_label(kind, source)
            } else {
                l.to_string()
            }
        };
        self.toolbox_ensure_category(category);
        let category = self.toolbox_canonical_category(category);
        let id = format!(
            "tbx-{}-{}",
            (now_secs() * 1000.0) as u64,
            self.config.toolbox_tools.len()
        );
        self.config.toolbox_tools.push(ToolboxTool {
            id: id.clone(),
            label,
            kind: kind.to_string(),
            source: source.to_string(),
            category,
            notes: notes.trim().to_string(),
            cached_path: None,
            added_at: now_secs(),
        });
        self.save()?;
        Ok(id)
    }

    pub fn toolbox_update_tool(
        &mut self,
        id: &str,
        label: Option<&str>,
        category: Option<&str>,
        source: Option<&str>,
        notes: Option<&str>,
    ) -> Result<(), String> {
        if let Some(cat) = category {
            self.toolbox_ensure_category(cat);
        }
        let canonical = category.map(|c| self.toolbox_canonical_category(c));
        let idx = self.toolbox_tool_index(id)?;
        let tool = &mut self.config.toolbox_tools[idx];
        if let Some(l) = label {
            let l = l.trim();
            if !l.is_empty() {
                tool.label = l.to_string();
            }
        }
        if let Some(cat) = canonical {
            tool.category = cat;
        }
        if let Some(s) = source {
            let s = s.trim();
            if s.is_empty() {
                return Err("Tool source is empty".into());
            }
            if tool.kind == "local" && !s.to_ascii_lowercase().ends_with(".tox") {
                return Err("Local tools must point at a .tox file".into());
            }
            if s != tool.source {
                tool.source = s.to_string();
                // A different source invalidates any fetched copy.
                tool.cached_path = None;
            }
        }
        if let Some(n) = notes {
            tool.notes = n.trim().to_string();
        }
        self.save()
    }

    pub fn toolbox_set_cached_path(&mut self, id: &str, path: &str) -> Result<(), String> {
        let idx = self.toolbox_tool_index(id)?;
        self.config.toolbox_tools[idx].cached_path = Some(path.to_string());
        self.save()
    }

    /// Pin or unpin one command (`tool#id`) as a favourite. Returns whether
    /// anything changed; saves only then. Identities are not validated
    /// against the seen-commands catalog — a favourite set before the
    /// command first registers (an import, a fresh machine) is dormant, not
    /// wrong, exactly like the hidden/shown overrides.
    pub fn set_command_favorite(&mut self, identity: &str, favorite: bool) -> Result<bool, String> {
        let identity = identity.trim();
        if identity.is_empty() {
            return Err("empty command identity".into());
        }
        let has = self.config.quick_favorite_commands.iter().any(|i| i == identity);
        if has == favorite {
            return Ok(false);
        }
        if favorite {
            self.config.quick_favorite_commands.push(identity.to_string());
        } else {
            self.config.quick_favorite_commands.retain(|i| i != identity);
        }
        self.save()?;
        Ok(true)
    }

    /// Repoint every `local` tool whose source is `old_path` at `new_path`.
    ///
    /// Used when the companion utility moves between the bundled resource and a
    /// downloaded release — a pinned tool stores an absolute path, so without
    /// this the Toolbox drag handle would keep serving the superseded copy.
    /// Saves only when something actually changed; returns how many moved.
    pub fn toolbox_retarget_local(
        &mut self,
        old_path: &str,
        new_path: &str,
    ) -> Result<usize, String> {
        let norm = |p: &str| p.replace('\\', "/").to_lowercase();
        let want = norm(old_path);
        let mut moved = 0usize;
        for tool in &mut self.config.toolbox_tools {
            if tool.kind == "local" && norm(&tool.source) == want {
                tool.source = new_path.to_string();
                moved += 1;
            }
        }
        if moved > 0 {
            self.save()?;
        }
        Ok(moved)
    }

    pub fn toolbox_remove_tool(&mut self, id: &str) -> Result<(), String> {
        let before = self.config.toolbox_tools.len();
        self.config.toolbox_tools.retain(|t| t.id != id);
        if self.config.toolbox_tools.len() == before {
            return Err("Toolbox tool not found".into());
        }
        self.save()
    }

    /// Move a tool up/down among the tools of the SAME category.
    pub fn toolbox_move_tool(&mut self, id: &str, direction: &str) -> Result<(), String> {
        let idx = self.toolbox_tool_index(id)?;
        let category = self.config.toolbox_tools[idx].category.clone();
        let peers: Vec<usize> = self
            .config
            .toolbox_tools
            .iter()
            .enumerate()
            .filter(|(_, t)| t.category == category)
            .map(|(i, _)| i)
            .collect();
        let pos = peers.iter().position(|&i| i == idx).unwrap_or(0);
        let swap_with = match direction {
            "up" if pos > 0 => peers[pos - 1],
            "down" if pos + 1 < peers.len() => peers[pos + 1],
            "up" | "down" => return Ok(()),
            _ => return Err("direction must be up or down".into()),
        };
        self.config.toolbox_tools.swap(idx, swap_with);
        self.save()
    }

    pub fn toolbox_add_category(&mut self, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Category name is empty".into());
        }
        self.toolbox_ensure_category(name);
        self.save()
    }

    pub fn toolbox_rename_category(&mut self, old: &str, new: &str) -> Result<(), String> {
        let old = old.trim();
        let new = new.trim();
        if new.is_empty() {
            return Err("Category name is empty".into());
        }
        let idx = self
            .config
            .toolbox_categories
            .iter()
            .position(|c| c.eq_ignore_ascii_case(old))
            .ok_or_else(|| "Category not found".to_string())?;
        let clash = self
            .config
            .toolbox_categories
            .iter()
            .enumerate()
            .any(|(i, c)| i != idx && c.eq_ignore_ascii_case(new));
        if clash {
            return Err(format!("Category \"{new}\" already exists"));
        }
        let old_canonical = self.config.toolbox_categories[idx].clone();
        self.config.toolbox_categories[idx] = new.to_string();
        for tool in &mut self.config.toolbox_tools {
            if tool.category == old_canonical {
                tool.category = new.to_string();
            }
        }
        self.save()
    }

    /// Remove a category; its tools move to the Toolbox top level.
    pub fn toolbox_remove_category(&mut self, name: &str) -> Result<(), String> {
        let idx = self
            .config
            .toolbox_categories
            .iter()
            .position(|c| c.eq_ignore_ascii_case(name.trim()))
            .ok_or_else(|| "Category not found".to_string())?;
        let removed = self.config.toolbox_categories.remove(idx);
        for tool in &mut self.config.toolbox_tools {
            if tool.category == removed {
                tool.category = String::new();
            }
        }
        self.save()
    }

    pub fn toolbox_move_category(&mut self, name: &str, direction: &str) -> Result<(), String> {
        let idx = self
            .config
            .toolbox_categories
            .iter()
            .position(|c| c.eq_ignore_ascii_case(name.trim()))
            .ok_or_else(|| "Category not found".to_string())?;
        let len = self.config.toolbox_categories.len();
        match direction {
            "up" if idx > 0 => self.config.toolbox_categories.swap(idx, idx - 1),
            "down" if idx + 1 < len => self.config.toolbox_categories.swap(idx, idx + 1),
            "up" | "down" => return Ok(()),
            _ => return Err("direction must be up or down".into()),
        }
        self.save()
    }
}

/// Fallback display name derived from a tool's source.
fn default_toolbox_label(kind: &str, source: &str) -> String {
    match kind {
        "local" => Path::new(source)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(source)
            .to_string(),
        "url" => {
            // Last path segment without .tox, else the owner/repo spec as-is.
            let trimmed = source.split(['?', '#']).next().unwrap_or(source);
            let seg = trimmed.trim_end_matches('/').rsplit('/').next().unwrap_or(source);
            let seg = seg.strip_suffix(".tox").or_else(|| seg.strip_suffix(".TOX")).unwrap_or(seg);
            if seg.is_empty() {
                source.to_string()
            } else {
                seg.to_string()
            }
        }
        _ => {
            // Package spec: name before any version/extras marker.
            source
                .split(['=', '<', '>', '[', '@', ' '])
                .next()
                .unwrap_or(source)
                .trim()
                .to_string()
        }
    }
}

#[cfg(windows)]
fn read_windows_td_recents() -> Vec<RecentEntry> {
    use winreg::enums::*;
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey(r"Software\Derivative\recent files") {
        Ok(k) => k,
        Err(_) => return vec![],
    };

    let mut raw: Vec<(u32, String)> = vec![];
    for (name, value) in key.enum_values().filter_map(|x| x.ok()) {
        if !name.starts_with("file") {
            continue;
        }
        let Ok(path) = String::from_reg_value(&value) else {
            continue;
        };
        if path.trim().is_empty() {
            continue;
        }
        let idx: u32 = name[4..].parse().unwrap_or(9999);
        raw.push((idx, path));
    }
    raw.sort_by_key(|(i, _)| *i);
    raw.into_iter()
        .map(|(_, path)| RecentEntry {
            path,
            source: Some("td".into()),
            last_opened: None,
        })
        .collect()
}

#[cfg(windows)]
fn blank_windows_td_recent(file_path: &str) -> bool {
    use winreg::enums::*;
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    let norm = normalize_path(file_path);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(
        r"Software\Derivative\recent files",
        KEY_READ | KEY_SET_VALUE,
    ) {
        Ok(k) => k,
        Err(_) => return false,
    };

    for (name, value) in key.enum_values().filter_map(|x| x.ok()) {
        if !name.starts_with("file") {
            continue;
        }
        let Ok(path) = String::from_reg_value(&value) else {
            continue;
        };
        if !path.is_empty() && normalize_path(&path) == norm {
            let _ = key.set_value(&name, &"");
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn read_mac_td_recents() -> Vec<RecentEntry> {
    use std::collections::HashSet;

    let sfl_path = dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Application Support/com.apple.sharedfilelist")
        .join("com.apple.LSSharedFileList.ApplicationRecentDocuments")
        .join("ca.derivative.touchdesigner.sfl4");

    if !sfl_path.exists() {
        return vec![];
    }

    let data = match fs::read(&sfl_path) {
        Ok(d) => d,
        Err(_) => return vec![],
    };

    let plist_data: plist::Value = match plist::from_bytes(&data) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let objects = match plist_data.as_dictionary().and_then(|d| d.get("$objects")) {
        Some(plist::Value::Array(arr)) => arr,
        _ => return vec![],
    };

    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    for obj in objects {
        if let plist::Value::Data(bytes) = obj {
            if bytes.starts_with(b"book") {
                if let Some(path) = extract_path_from_bookmark(bytes) {
                    if seen.insert(path.clone()) {
                        entries.push(RecentEntry {
                            path,
                            source: Some("td".into()),
                            last_opened: None,
                        });
                    }
                }
            }
        }
    }
    entries
}

#[cfg(target_os = "macos")]
fn extract_path_from_bookmark(bookmark_data: &[u8]) -> Option<String> {
    let decoded: String = bookmark_data.iter().map(|&b| b as char).collect();
    let re = regex::Regex::new(r"[^\x20-\x7e]+").ok()?;
    let parts: Vec<&str> = re
        .split(&decoded)
        .filter(|p| !p.is_empty() && !p.to_lowercase().starts_with("book"))
        .collect();

    let candidates: Vec<&str> = if let Some(idx) = parts.iter().position(|p| *p == "file:///") {
        parts[..idx].to_vec()
    } else {
        parts
    };

    let mut filename_idx = None;
    for i in (0..candidates.len()).rev() {
        let comp = candidates[i];
        if let Some(ext) = comp.rsplit('.').next() {
            if ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) && comp.contains('.')
            {
                filename_idx = Some(i);
                break;
            }
        }
    }
    let filename_idx = filename_idx?;

    let root_dirs = [
        "Users", "Volumes", "Applications", "Library", "System", "private", "tmp", "var", "opt",
        "usr", "etc", "Network", "bin", "sbin", "cores", "dev",
    ];
    let mut start_idx = None;
    for i in 0..filename_idx {
        if root_dirs.contains(&candidates[i]) {
            start_idx = Some(i);
            break;
        }
    }
    let start_idx = start_idx?;
    let path_parts = &candidates[start_idx..=filename_idx];
    if path_parts.len() >= 2 {
        Some(format!("/{}", path_parts.join("/")))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A manager writing into a temp dir — never touches the user's config.
    fn temp_manager(tag: &str) -> ConfigManager {
        let dir = std::env::temp_dir().join(format!("tdxlu-cfg-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        ConfigManager {
            config_file: dir.join("config.json"),
            config_dir: dir,
            config: AppConfig::default(),
        }
    }

    /// A config written before this setting existed has no such key, and must
    /// load as *unanswered* rather than as any particular policy — that is what
    /// makes the first file-open ask instead of silently auto-launching in a
    /// build the user never chose.
    #[test]
    fn config_without_the_key_is_unanswered() {
        let mut m = temp_manager("cli-fallback-default");
        fs::create_dir_all(&m.config_dir).unwrap();
        fs::write(&m.config_file, serde_json::json!({}).to_string()).unwrap();

        m.load();

        assert_eq!(m.config.cli_fallback_version, "");
    }

    /// An explicit choice always survives a load — including "ask", which is
    /// how a user turns the auto-launch back off.
    #[test]
    fn an_explicit_fallback_choice_is_preserved() {
        for choice in ["ask", "closest", "TouchDesigner.2025.30060"] {
            let mut m = temp_manager("cli-fallback-explicit");
            fs::create_dir_all(&m.config_dir).unwrap();
            fs::write(
                &m.config_file,
                serde_json::json!({ "cli_fallback_version": choice }).to_string(),
            )
            .unwrap();

            m.load();

            assert_eq!(m.config.cli_fallback_version, choice);
        }
    }

    /// One catalog sighting, spelled the way the palette sends them.
    fn seen(tool: &str, id: &str, label: &str, last_seen: f64) -> QuickSeenCommand {
        QuickSeenCommand {
            identity: format!("{tool}#{id}"),
            tool: tool.into(),
            id: id.into(),
            label: label.into(),
            help: None,
            hidden: None,
            builtin: None,
            param_count: None,
            params: None,
            instances: None,
            last_seen,
        }
    }

    #[test]
    fn export_omits_secrets_and_machine_state() {
        let mut m = temp_manager("secrets");
        m.config.github_token = "ghp_secret".into();
        m.config.patreon_session_cookie = "cookie_secret".into();
        m.config.alert_smtp_password = "pw_secret".into();
        m.config.backup_root = "D:/backups".into();
        m.config.backup_exclude = "*.tmp\nRender/".into();

        let v = m.export_settings(false).unwrap();
        let text = serde_json::to_string(&v).unwrap();
        assert!(!text.contains("secret"), "export leaked a secret: {text}");

        let prefs = v["prefs"].as_object().unwrap();
        assert_eq!(prefs["backup_exclude"], "*.tmp\nRender/");
        // Machine-local paths and list state stay out unless asked for.
        assert!(!prefs.contains_key("backup_root"));
        assert!(!prefs.contains_key("launcher_recents"));
        assert!(!prefs.contains_key("templates"));

        let with_paths = m.export_settings(true).unwrap();
        assert_eq!(with_paths["prefs"]["backup_root"], "D:/backups");
    }

    #[test]
    fn import_merges_and_leaves_absent_fields_alone() {
        let mut src = temp_manager("src");
        src.config.backup_exclude = "*.mov".into();
        src.config.backup_respect_gitignore = true;
        src.config.theme = "ocean".into();
        let exported = src.export_settings(false).unwrap();

        let mut dst = temp_manager("dst");
        dst.config.backup_exclude = "old".into();
        dst.config.max_recent_files = 42;
        dst.config.github_token = "keep_me".into();

        let counts = dst.import_settings(&exported).unwrap();
        assert!(counts.prefs_applied > 0);
        assert_eq!(dst.config.backup_exclude, "*.mov");
        assert!(dst.config.backup_respect_gitignore);
        assert_eq!(dst.config.theme, "ocean");
        // Not in the export → untouched (and the local token survives).
        assert_eq!(dst.config.github_token, "keep_me");
    }

    #[test]
    fn import_unions_toolbox_without_duplicating() {
        let mut src = temp_manager("tbx-src");
        src.toolbox_add_tool("Alpha", "local", "C:/tools/alpha.tox", "Gen", "")
            .unwrap();
        src.toolbox_add_tool("Beta", "url", "owner/repo", "", "").unwrap();
        let exported = src.export_settings(false).unwrap();

        let mut dst = temp_manager("tbx-dst");
        // Same tool, different case/separators — must not duplicate.
        dst.toolbox_add_tool("Alpha local", "local", r"c:\tools\alpha.tox", "", "")
            .unwrap();

        let counts = dst.import_settings(&exported).unwrap();
        assert_eq!(counts.tools_added, 1, "only the unseen tool should be added");
        assert_eq!(counts.categories_added, 1, "the Gen category should come across");
        assert_eq!(dst.config.toolbox_tools.len(), 2);
        assert!(dst.config.toolbox_tools.iter().any(|t| t.source == "owner/repo"));
    }

    /// The catalog is history, not a live listing: it survives the export and
    /// lands on a machine where those tools have never run, so curation and
    /// presets can be authored before the command first registers there.
    #[test]
    fn seen_commands_travel_and_are_curatable_before_they_register() {
        let mut src = temp_manager("seen-src");
        src.merge_quick_seen_commands(vec![seen("HydroHomie", "reset", "Reset sim", 100.0)])
            .unwrap();
        let exported = src.export_settings(false).unwrap();

        let mut dst = temp_manager("seen-dst");
        let counts = dst.import_settings(&exported).unwrap();
        assert_eq!(counts.commands_added, 1);
        assert_eq!(dst.config.quick_seen_commands[0].identity, "HydroHomie#reset");

        // Curate it here even though no session has ever registered it.
        dst.apply_prefs(PrefsUpdate {
            quick_hidden_commands: Some(vec!["HydroHomie#reset".into()]),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(dst.config.quick_hidden_commands, vec!["HydroHomie#reset"]);

        // Re-importing the same file is a no-op, not a duplicate.
        let counts = dst.import_settings(&exported).unwrap();
        assert_eq!(counts.commands_added, 0);
        assert_eq!(dst.config.quick_seen_commands.len(), 1);
    }

    /// Favourites are one list, toggled idempotently from any surface, and
    /// travel with a settings export like the other curation lists.
    #[test]
    fn favorites_toggle_idempotently_and_travel_with_settings() {
        let mut m = temp_manager("fav-src");
        assert!(m.set_command_favorite("HydroHomie#reset", true).unwrap());
        assert!(!m.set_command_favorite("HydroHomie#reset", true).unwrap());
        assert_eq!(m.config.quick_favorite_commands, vec!["HydroHomie#reset"]);
        assert!(m.set_command_favorite("  ", true).is_err());

        let exported = m.export_settings(false).unwrap();
        let mut dst = temp_manager("fav-dst");
        dst.import_settings(&exported).unwrap();
        assert_eq!(dst.config.quick_favorite_commands, vec!["HydroHomie#reset"]);

        assert!(m.set_command_favorite("HydroHomie#reset", false).unwrap());
        assert!(m.config.quick_favorite_commands.is_empty());
        assert!(!m.set_command_favorite("HydroHomie#reset", false).unwrap());
    }

    /// An import carries another machine's clock; it must not roll back
    /// display data this machine saw more recently.
    #[test]
    fn an_older_sighting_never_clobbers_fresher_local_data() {
        let mut m = temp_manager("seen-clock");
        m.merge_quick_seen_commands(vec![seen("Tool", "go", "Fresh label", 500.0)])
            .unwrap();
        let added = m
            .merge_quick_seen_commands(vec![seen("Tool", "go", "Stale label", 100.0)])
            .unwrap();
        assert_eq!(added, 0);
        assert_eq!(m.config.quick_seen_commands[0].label, "Fresh label");

        // A newer sighting does refresh it.
        m.merge_quick_seen_commands(vec![seen("Tool", "go", "Renamed", 900.0)])
            .unwrap();
        assert_eq!(m.config.quick_seen_commands[0].label, "Renamed");
        assert_eq!(m.config.quick_seen_commands.len(), 1);
    }

    #[test]
    fn import_rejects_a_foreign_file() {
        let mut m = temp_manager("foreign");
        let v = serde_json::json!({ "format": "something-else", "prefs": {} });
        assert!(m.import_settings(&v).is_err());
    }

    #[test]
    fn startup_tab_takes_known_tabs_only() {
        let mut m = temp_manager("startuptab");
        assert_eq!(m.config.startup_tab, "recent");
        for (input, want) in [
            ("templates", "templates"),
            (" Last ", "last"),
            ("bogus", "last"), // refused: keeps the previous value
            ("current", "current"),
        ] {
            m.apply_prefs(PrefsUpdate {
                startup_tab: Some(input.into()),
                ..Default::default()
            })
            .unwrap();
            assert_eq!(m.config.startup_tab, want, "after {input:?}");
        }
    }

    /// A skip is machine-local state, not a portable preference: carrying it
    /// into an exported settings file would silence a colleague's update
    /// prompt for a version they never declined.
    #[test]
    fn skipped_versions_round_trip_but_stay_out_of_the_export() {
        let mut m = temp_manager("skipver");
        m.apply_prefs(PrefsUpdate {
            skipped_app_version: Some("  0.6.0  ".into()),
            skipped_utility_version: Some("0.5.1".into()),
            ..Default::default()
        })
        .unwrap();

        assert_eq!(m.config.skipped_app_version, "0.6.0", "trimmed on the way in");
        assert_eq!(m.config.skipped_utility_version, "0.5.1");

        let text = serde_json::to_string(&m.export_settings(true).unwrap()).unwrap();
        assert!(
            !text.contains("skipped_app_version") && !text.contains("skipped_utility_version"),
            "a skip must not travel with exported settings: {text}"
        );
    }

    /// Every spelling below must end up as something the global-hotkey parser
    /// accepts — nobody should have to know the string is `CommandOrControl`.
    #[test]
    fn accelerators_accept_the_spellings_people_actually_type() {
        for (typed, want) in [
            ("ctrl+alt+d", "Control+Alt+D"),
            ("Control + Alt + D", "Control+Alt+D"),
            ("CTRL ALT D", "Control+Alt+D"),
            ("Cmd+Shift+E", "Command+Shift+E"),
            ("command+shift+e", "Command+Shift+E"),
            ("Win+D", "Super+D"),
            ("Windows+D", "Super+D"),
            ("meta+d", "Super+D"),
            ("option+f1", "Alt+F1"),
            ("CmdOrCtrl+D", "CommandOrControl+D"),
            ("ctrl+space", "Control+Space"),
            ("   ", ""),
        ] {
            assert_eq!(normalize_accelerator(typed), want, "input {typed:?}");
        }
    }

    /// The normalizer is only useful if its output actually binds.
    #[test]
    fn normalized_accelerators_parse_as_shortcuts() {
        use tauri_plugin_global_shortcut::Shortcut;
        for typed in [
            "ctrl+alt+d",
            "Control + Alt + D",
            "Cmd+Shift+E",
            "Win+D",
            "meta+d",
            "option+f1",
            "CmdOrCtrl+D",
            "ctrl+space",
        ] {
            let norm = normalize_accelerator(typed);
            assert!(
                norm.parse::<Shortcut>().is_ok(),
                "{typed:?} normalized to {norm:?}, which does not parse"
            );
        }
    }

    /// Scratch pair of config paths that never touches the user's real ones.
    fn migration_paths(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("tdxlu-mig-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("new")).unwrap();
        fs::create_dir_all(dir.join("old")).unwrap();
        (dir.join("new/config.json"), dir.join("old/config.json"))
    }

    fn write_json(p: &Path, v: Value) {
        fs::write(p, serde_json::to_string(&v).unwrap()).unwrap();
    }

    #[test]
    fn legacy_config_is_adopted_when_the_new_one_is_absent() {
        let (new, old) = migration_paths("absent");
        write_json(&old, json!({"version": 1, "global_hotkey": "Super+Shift+E"}));

        assert!(adopt_legacy_config(&new, &old).unwrap());
        let got: Value = serde_json::from_str(&fs::read_to_string(&new).unwrap()).unwrap();
        assert_eq!(got["global_hotkey"], "Super+Shift+E");
    }

    /// The case that actually bit: the companion TOX writes a td_recents-only
    /// stub to the NEW path, which must not be mistaken for a real config.
    #[test]
    fn a_utility_written_stub_does_not_block_adoption() {
        let (new, old) = migration_paths("stub");
        write_json(&new, json!({"td_recents": ["a.toe"], "td_recents_timestamp": 10.0}));
        write_json(
            &old,
            json!({"version": 1, "global_hotkey": "Super+Shift+E",
                   "td_recents": ["old.toe"], "td_recents_timestamp": 5.0}),
        );

        assert!(adopt_legacy_config(&new, &old).unwrap());
        let got: Value = serde_json::from_str(&fs::read_to_string(&new).unwrap()).unwrap();
        assert_eq!(got["global_hotkey"], "Super+Shift+E", "settings carried over");
        // The stub's recents were newer, so they survive the adoption.
        assert_eq!(got["td_recents"][0], "a.toe");
        assert_eq!(got["td_recents_timestamp"], 10.0);
    }

    #[test]
    fn a_real_new_config_is_never_overwritten() {
        let (new, old) = migration_paths("keep");
        write_json(&new, json!({"version": 1, "global_hotkey": "Ctrl+Alt+D"}));
        write_json(&old, json!({"version": 1, "global_hotkey": "Super+Shift+E"}));

        assert!(!adopt_legacy_config(&new, &old).unwrap(), "must not adopt");
        let got: Value = serde_json::from_str(&fs::read_to_string(&new).unwrap()).unwrap();
        assert_eq!(got["global_hotkey"], "Ctrl+Alt+D");
    }

    #[test]
    fn adoption_is_a_no_op_with_nothing_to_adopt() {
        let (new, old) = migration_paths("none");
        assert!(!adopt_legacy_config(&new, &old).unwrap());
        assert!(!new.exists());
        // A legacy file that is itself only a stub is not a config either.
        write_json(&old, json!({"td_recents": []}));
        assert!(!adopt_legacy_config(&new, &old).unwrap());
    }

    #[test]
    fn fns_base_normalization_coerces_dead_host() {
        assert_eq!(normalize_fns_base(""), default_fns_base_url());
        assert_eq!(normalize_fns_base("  "), default_fns_base_url());
        // The pre-migration host is coerced wherever it comes from.
        assert_eq!(
            normalize_fns_base("https://storage.functionstr.com/fnstools"),
            default_fns_base_url()
        );
        // A genuine mirror survives, trailing slash trimmed.
        assert_eq!(
            normalize_fns_base("https://mirror.example.com/fns/"),
            "https://mirror.example.com/fns"
        );
    }

    #[test]
    fn load_migrates_legacy_window_target_to_main_hotkey() {
        let mut m = temp_manager("hotkey-migrate-window");
        fs::create_dir_all(&m.config_dir).unwrap();
        fs::write(
            &m.config_file,
            serde_json::json!({
                "global_hotkey_enabled": true,
                "global_hotkey": "Ctrl+Alt+E",
                "global_hotkey_target": "window",
            })
            .to_string(),
        )
        .unwrap();

        m.load();

        // The old single hotkey (which opened the main window) becomes the
        // dedicated main-window hotkey, enabled.
        assert_eq!(m.config.global_hotkey_main, "Ctrl+Alt+E");
        assert!(m.config.global_hotkey_main_enabled);
        // The quick-launch hotkey resets to its default, disabled, so it
        // doesn't newly collide with the same combo.
        assert_eq!(m.config.global_hotkey, default_global_hotkey());
        assert!(!m.config.global_hotkey_enabled);
    }

    #[test]
    fn load_leaves_default_quick_target_unmigrated() {
        let mut m = temp_manager("hotkey-migrate-quick");
        fs::create_dir_all(&m.config_dir).unwrap();
        fs::write(
            &m.config_file,
            serde_json::json!({
                "global_hotkey_enabled": true,
                "global_hotkey": "Ctrl+Alt+E",
                "global_hotkey_target": "quick",
            })
            .to_string(),
        )
        .unwrap();

        m.load();

        // Already the default target — nothing moves, quick keeps the combo.
        assert_eq!(m.config.global_hotkey, "Ctrl+Alt+E");
        assert!(m.config.global_hotkey_enabled);
        // The pre-split config has no main-window fields, so they fill with
        // the 0.7.1 defaults: the flagship combo, enabled. It doesn't collide
        // with the custom quick combo, so nothing is pushed aside.
        assert_eq!(m.config.global_hotkey_main, default_global_hotkey_main());
        assert!(m.config.global_hotkey_main_enabled);
    }
}
