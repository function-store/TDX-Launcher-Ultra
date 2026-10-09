//! Watch alert notifications (SMTP email).

use crate::config::AppConfig;
use lettre::message::{Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AlertKind {
    Stall,
    Relaunch,
    GaveUp,
    Reboot,
    LaunchFailed,
}

impl AlertKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stall => "stall",
            Self::Relaunch => "relaunch",
            Self::GaveUp => "gave_up",
            Self::Reboot => "reboot",
            Self::LaunchFailed => "launch_failed",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Stall => "Heartbeat stall",
            Self::Relaunch => "Project relaunched",
            Self::GaveUp => "Gave up watching",
            Self::Reboot => "Reboot triggered",
            Self::LaunchFailed => "Launch failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct EmailConfig {
    pub enabled: bool,
    pub to: String,
    pub from: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    /// `starttls` (587), `tls` (465), or `none`
    pub smtp_security: String,
    pub smtp_username: String,
    pub smtp_password: String,
    pub on_stall: bool,
    pub on_relaunch: bool,
    pub on_gave_up: bool,
    pub on_reboot: bool,
    pub attach_screenshot: bool,
    pub cooldown_secs: u64,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            to: String::new(),
            from: String::new(),
            smtp_host: String::new(),
            smtp_port: 587,
            smtp_security: "starttls".into(),
            smtp_username: String::new(),
            smtp_password: String::new(),
            on_stall: true,
            on_relaunch: true,
            on_gave_up: true,
            on_reboot: true,
            attach_screenshot: true,
            cooldown_secs: 300,
        }
    }
}

impl EmailConfig {
    pub fn from_app(c: &AppConfig) -> Self {
        Self {
            enabled: c.alert_email_enabled,
            to: c.alert_email_to.clone(),
            from: c.alert_email_from.clone(),
            smtp_host: c.alert_smtp_host.clone(),
            smtp_port: if c.alert_smtp_port == 0 {
                587
            } else {
                c.alert_smtp_port
            },
            smtp_security: {
                let s = c.alert_smtp_security.trim().to_ascii_lowercase();
                match s.as_str() {
                    "tls" | "ssl" | "wrapper" => "tls".into(),
                    "none" | "off" | "plain" => "none".into(),
                    _ => "starttls".into(),
                }
            },
            smtp_username: c.alert_smtp_username.clone(),
            smtp_password: c.alert_smtp_password.clone(),
            on_stall: c.alert_on_stall,
            on_relaunch: c.alert_on_relaunch,
            on_gave_up: c.alert_on_gave_up,
            on_reboot: c.alert_on_reboot,
            attach_screenshot: c.alert_attach_screenshot,
            cooldown_secs: c.alert_cooldown_secs as u64,
        }
    }

    pub fn wants(&self, kind: AlertKind) -> bool {
        if !self.enabled {
            return false;
        }
        match kind {
            AlertKind::Stall => self.on_stall,
            AlertKind::Relaunch => self.on_relaunch,
            AlertKind::GaveUp => self.on_gave_up,
            AlertKind::Reboot => self.on_reboot,
            AlertKind::LaunchFailed => self.on_gave_up, // treat like hard failure
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.to.trim().is_empty() {
            return Err("Alert email To address is empty".into());
        }
        if self.from.trim().is_empty() {
            return Err("Alert email From address is empty".into());
        }
        if self.smtp_host.trim().is_empty() {
            return Err("SMTP host is empty".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Alert {
    pub kind: AlertKind,
    pub project_id: String,
    pub project_path: String,
    pub message: String,
    pub crash_count: u32,
    pub screenshot: Option<PathBuf>,
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".into())
}

fn basename(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
}

static COOLDOWN: Mutex<Option<HashMap<(String, String), Instant>>> = Mutex::new(None);

fn cooldown_ok(project_id: &str, kind: AlertKind, secs: u64) -> bool {
    if secs == 0 {
        return true;
    }
    let key = (project_id.to_string(), kind.as_str().to_string());
    let mut guard = COOLDOWN.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    if let Some(prev) = map.get(&key) {
        if now.duration_since(*prev) < Duration::from_secs(secs) {
            return false;
        }
    }
    map.insert(key, now);
    true
}

fn build_transport(cfg: &EmailConfig) -> Result<SmtpTransport, String> {
    let host = cfg.smtp_host.trim();
    let port = cfg.smtp_port;
    let security = cfg.smtp_security.as_str();

    let mut builder = match security {
        "none" => SmtpTransport::builder_dangerous(host).port(port),
        "tls" => {
            let tls = TlsParameters::new(host.to_string()).map_err(|e| e.to_string())?;
            SmtpTransport::relay(host)
                .map_err(|e| e.to_string())?
                .port(port)
                .tls(Tls::Wrapper(tls))
        }
        _ => {
            // STARTTLS (typical submission port 587)
            SmtpTransport::starttls_relay(host)
                .map_err(|e| e.to_string())?
                .port(port)
        }
    };

    let user = cfg.smtp_username.trim();
    let pass = cfg.smtp_password.as_str();
    if !user.is_empty() {
        builder = builder.credentials(Credentials::new(user.to_string(), pass.to_string()));
    }

    Ok(builder.build())
}

pub fn send_email_alert(cfg: &EmailConfig, alert: &Alert) -> Result<(), String> {
    cfg.validate()?;

    let host = host_name();
    let project = basename(&alert.project_path);
    let subject = format!(
        "[TDXLU] {} - {} @ {}",
        alert.kind.label(),
        project,
        host
    );

    let body = format!(
        "TDXLU Watch alert\n\
         \n\
         Event:        {kind}\n\
         Host:         {host}\n\
         Project:      {project}\n\
         Path:         {path}\n\
         Id:           {id}\n\
         Crash count:  {crashes}\n\
         \n\
         {message}\n\
         \n\
         - TDXLU\n",
        kind = alert.kind.label(),
        host = host,
        project = project,
        path = alert.project_path,
        id = alert.project_id,
        crashes = alert.crash_count,
        message = alert.message,
    );

    let from = cfg.from.trim().parse().map_err(|e| format!("From address: {e}"))?;
    let to = cfg.to.trim().parse().map_err(|e| format!("To address: {e}"))?;

    let builder = Message::builder().from(from).to(to).subject(subject);

    let email = if cfg.attach_screenshot {
        if let Some(path) = alert.screenshot.as_ref().filter(|p| p.is_file()) {
            let bytes = std::fs::read(path).map_err(|e| format!("Read screenshot: {e}"))?;
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("screenshot.png")
                .to_string();
            let attachment = Attachment::new(name).body(
                bytes,
                "image/png".parse().map_err(|e| format!("MIME: {e}"))?,
            );
            builder
                .multipart(
                    MultiPart::mixed()
                        .singlepart(SinglePart::plain(body))
                        .singlepart(attachment),
                )
                .map_err(|e| e.to_string())?
        } else {
            builder.body(body).map_err(|e| e.to_string())?
        }
    } else {
        builder.body(body).map_err(|e| e.to_string())?
    };

    let mailer = build_transport(cfg)?;
    mailer.send(&email).map_err(|e| format!("SMTP send failed: {e}"))?;
    Ok(())
}

/// Fire-and-forget email (respects enabled flags + cooldown). Logs result.
pub fn spawn_email_alert(cfg: EmailConfig, alert: Alert, log_dir: Option<PathBuf>) {
    if !cfg.wants(alert.kind) {
        return;
    }
    if !cooldown_ok(&alert.project_id, alert.kind, cfg.cooldown_secs) {
        log::info!(
            "[alert] skipped {} for {} (cooldown {}s)",
            alert.kind.as_str(),
            alert.project_id,
            cfg.cooldown_secs
        );
        return;
    }

    thread::spawn(move || {
        let kind = alert.kind.as_str();
        let id = alert.project_id.clone();
        match send_email_alert(&cfg, &alert) {
            Ok(()) => {
                log::info!("[alert] emailed {kind} for {id}");
                if let Some(dir) = log_dir {
                    append_alert_log(&dir, &format!("[{id}] Email alert sent ({kind})"));
                }
            }
            Err(e) => {
                log::warn!("[alert] email failed ({kind} / {id}): {e}");
                if let Some(dir) = log_dir {
                    append_alert_log(&dir, &format!("[{id}] Email alert failed: {e}"));
                }
            }
        }
    });
}

fn append_alert_log(log_dir: &Path, msg: &str) {
    use std::fs::OpenOptions;
    use std::io::Write;
    let day = chrono::Local::now().format("%Y-%m-%d");
    let path = log_dir.join(format!("watch_{day}.log"));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            f,
            "[{}] {msg}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
    }
}

/// Send a one-off test message using current settings (bypasses cooldown / event toggles).
pub fn send_test_email(cfg: &EmailConfig) -> Result<(), String> {
    let mut test_cfg = cfg.clone();
    test_cfg.enabled = true;
    test_cfg.validate()?;
    let alert = Alert {
        kind: AlertKind::Stall,
        project_id: "test".into(),
        project_path: "test.toe".into(),
        message: "This is a TDXLU test alert. Watch email delivery is working.".into(),
        crash_count: 0,
        screenshot: None,
    };
    // Bypass cooldown / wants() by calling send directly
    send_email_alert(&test_cfg, &alert)
}
