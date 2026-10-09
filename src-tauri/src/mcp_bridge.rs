//! TD AI / MCP bridge lifecycle - provider-agnostic session manager.
//!
//! First provider: Embody/Envoy (`.embody/envoy.json` + `.mcp.json`).
//! TDXLU prepares and monitors the env; it does not host MCP or speak TDN.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

const PROVIDER_EMBODY: &str = "embody";

#[derive(Debug, Clone, Serialize)]
pub struct McpBridgeStatus {
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub detected: bool,
    pub project_root: Option<String>,
    pub envoy_json: Option<String>,
    pub mcp_json: Option<String>,
    pub active_instance: Option<String>,
    pub port: Option<u16>,
    pub toe_path: Option<String>,
    pub td_executable: Option<String>,
    pub td_pid: Option<u32>,
    pub td_alive: bool,
    pub port_open: bool,
    pub envoy_reachable: bool,
    pub mcp_server_keys: Vec<String>,
    pub mcp_snippet: Option<String>,
    pub bridge_command: Option<String>,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct EnvoyFile {
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    td_executable: Option<String>,
    #[serde(default)]
    instances: serde_json::Map<String, Value>,
}

fn normalize_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Walk up from a `.toe` or folder looking for `.embody` / `.mcp.json`.
pub fn find_project_root(start: &Path) -> Option<PathBuf> {
    let mut cur = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    for _ in 0..8 {
        let embody = cur.join(".embody");
        let mcp = cur.join(".mcp.json");
        if embody.is_dir() || mcp.is_file() {
            return Some(cur);
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        crate::proc::command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| {
                let s = String::from_utf8_lossy(&o.stdout);
                s.contains(&pid.to_string())
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
            || crate::proc::command("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
    }
}

pub fn port_is_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn port_open(port: u16) -> bool {
    port_is_open(port)
}

fn ping_envoy(port: u16) -> bool {
    crate::proc::off_runtime(move || ping_envoy_blocking(port))
}

fn ping_envoy_blocking(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "tdxlu-ping",
        "method": "ping"
    });
    match client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&body)
        .send()
    {
        Ok(resp) => {
            // Any HTTP response from /mcp means Envoy (or a peer) is up.
            // JSON-RPC may return result or method-not-found error.
            if let Ok(v) = resp.json::<Value>() {
                v.get("result").is_some() || v.get("error").is_some() || v.get("jsonrpc").is_some()
            } else {
                true
            }
        }
        Err(_) => false,
    }
}

/// Call Envoy `execute_python` and return the tool result payload.
pub fn execute_python(port: u16, code: &str) -> Result<Value, String> {
    crate::proc::off_runtime(move || execute_python_blocking(port, code))
}

fn execute_python_blocking(port: u16, code: &str) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "tdxlu-exec",
        "method": "tools/call",
        "params": {
            "name": "execute_python",
            "arguments": { "code": code }
        }
    });
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    // Streamable HTTP may wrap as SSE: "event: message\ndata: {...}\n\n"
    let json_text = if text.trim_start().starts_with('{') {
        text
    } else {
        text
            .lines()
            .find_map(|l| l.strip_prefix("data:").map(|s| s.trim().to_string()))
            .ok_or_else(|| format!("Unexpected Envoy response ({status}): {}", text.chars().take(200).collect::<String>()))?
    };
    let v: Value = serde_json::from_str(&json_text).map_err(|e| format!("Envoy JSON: {e}"))?;
    if let Some(err) = v.get("error") {
        return Err(err.to_string());
    }
    // MCP tools/call result: { result: { content: [{type,text}], isError? } }
    if let Some(result) = v.get("result") {
        if result.get("isError").and_then(|b| b.as_bool()) == Some(true) {
            let msg = result
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("execute_python failed");
            return Err(msg.to_string());
        }
        // Prefer structured text content that looks like JSON from `result = ...`
        if let Some(text) = result
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|t| t.as_str())
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                return unwrap_exec_envelope(parsed);
            }
            return Ok(Value::String(text.to_string()));
        }
        return Ok(result.clone());
    }
    Ok(v)
}

/// Envoy's execute_python wraps payloads as {"success": bool, "result"|"error": ...}
/// with `result` carrying a STRING when the script set one (our utility calls
/// json.dumps their dict). Unwrap so callers get the actual payload, not the
/// envelope — the control panel reads `.ok` off it and must not see the wrapper.
fn unwrap_exec_envelope(parsed: Value) -> Result<Value, String> {
    let Some(success) = parsed.get("success").and_then(|b| b.as_bool()) else {
        return Ok(parsed);
    };
    if !success {
        let msg = parsed
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("execute_python failed");
        return Err(msg.to_string());
    }
    match parsed.get("result") {
        Some(Value::String(s)) => {
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                Ok(v)
            } else {
                Ok(Value::String(s.clone()))
            }
        }
        Some(inner) => Ok(inner.clone()),
        None => Ok(parsed),
    }
}

fn utility_action_code(action: &str, payload: Option<&Value>) -> Result<String, String> {
    let call = match action {
        "save" => "u.SaveProject()".to_string(),
        "pulse" => "u.PulseIcon()".to_string(),
        "record" => "u.RecordPreview()".to_string(),
        "ensure_tdpyenv" | "ensure_tdpyenvmanager" => "u.EnsureTdPyEnvManager()".to_string(),
        "collect_save" | "collectsave" => {
            let dry = payload
                .and_then(|p| p.get("dry_run"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // None lets the utility's Collectexpr toggle decide.
            let expressions = match payload
                .and_then(|p| p.get("expressions"))
                .and_then(|v| v.as_bool())
            {
                Some(true) => "True",
                Some(false) => "False",
                None => "None",
            };
            // Confirmed source list from the dry-run dialog; double-encode
            // like control_set so JSON tokens never appear as bare Python.
            let include = match payload.and_then(|p| p.get("include")) {
                Some(v) if v.is_array() => {
                    let json = serde_json::to_string(v).map_err(|e| e.to_string())?;
                    let lit = serde_json::to_string(&json).map_err(|e| e.to_string())?;
                    format!("__import__('json').loads({lit})")
                }
                _ => "None".to_string(),
            };
            format!(
                "u.CollectAndSave(dry_run={}, expressions={expressions}, include={include})",
                if dry { "True" } else { "False" }
            )
        }
        "collect_status" | "collectstatus" => "u.CollectStatus()".to_string(),
        "repoint_assets" | "repointassets" => {
            let dry = payload
                .and_then(|p| p.get("dry_run"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // Confirmed ref list ('<op path>.<par>') from the dry-run dialog;
            // double-encoded like collect_save so JSON tokens never reach the
            // companion as bare Python.
            let include = match payload.and_then(|p| p.get("include")) {
                Some(v) if v.is_array() => {
                    let json = serde_json::to_string(v).map_err(|e| e.to_string())?;
                    let lit = serde_json::to_string(&json).map_err(|e| e.to_string())?;
                    format!("__import__('json').loads({lit})")
                }
                _ => "None".to_string(),
            };
            format!(
                "u.RepointAssets(dry_run={}, include={include})",
                if dry { "True" } else { "False" }
            )
        }
        "media_list" | "medialist" => "u.MediaList()".to_string(),
        "media_replace" | "mediareplace" => {
            // Both arguments are arbitrary user data - a '<op path>.<par>'
            // reference and a filesystem path that can hold quotes, spaces or
            // backslashes. Encode each as a JSON string literal rather than
            // interpolating, so nothing in a filename can close the string and
            // run as Python.
            let lit = |key: &str| -> Result<String, String> {
                let s = payload
                    .and_then(|p| p.get(key))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                serde_json::to_string(s).map_err(|e| e.to_string())
            };
            format!("u.MediaReplace({}, {})", lit("ref")?, lit("path")?)
        }
        "media_sync" | "mediasync" => {
            let ref_lit = serde_json::to_string(
                payload
                    .and_then(|p| p.get("ref"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            )
            .map_err(|e| e.to_string())?;
            // Same closed set the TCP dispatch enforces; anything else falls
            // back to the utility's default rather than reaching Python raw.
            let timeline = match payload
                .and_then(|p| p.get("timeline"))
                .and_then(|v| v.as_str())
            {
                Some("global") => "global",
                _ => "local",
            };
            format!("u.MediaSyncTimeline({ref_lit}, timeline='{timeline}')")
        }
        "media_probe" | "mediaprobe" => {
            let ref_lit = serde_json::to_string(
                payload
                    .and_then(|p| p.get("ref"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            )
            .map_err(|e| e.to_string())?;
            format!("u.MediaProbe({ref_lit})")
        }
        "media_unreferenced" | "mediaunreferenced" => {
            match payload
                .and_then(|p| p.get("subfolder"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                Some(sub) => {
                    let lit = serde_json::to_string(sub).map_err(|e| e.to_string())?;
                    format!("u.MediaUnreferenced(subfolder={lit})")
                }
                None => "u.MediaUnreferenced()".to_string(),
            }
        }
        "sidecar_get" | "sidecarget" => "u.SidecarGet()".to_string(),
        "sidecar_set" | "sidecarset" => {
            let fields = payload
                .and_then(|p| p.get("fields"))
                .ok_or_else(|| String::from("sidecar_set requires payload.fields"))?;
            let json = serde_json::to_string(fields).map_err(|e| e.to_string())?;
            // Double-encode like control_set so JSON tokens never appear as
            // bare Python.
            let lit = serde_json::to_string(&json).map_err(|e| e.to_string())?;
            format!("u.SidecarSet(__import__('json').loads({lit}))")
        }
        "sidecar_hero" | "sidecarhero" => "u.SidecarHeroFromPreview()".to_string(),
        "perf" => "u.PerfStats()".to_string(),
        "control_schema" | "controlschema" => "u.ControlSchema()".to_string(),
        "control_get" | "controlget" => "u.ControlGet()".to_string(),
        "control_comps" | "controlcomps" => "u.ControlComps()".to_string(),
        "control_add" | "controladd" => {
            let comp = payload
                .and_then(|p| p.get("comp").or_else(|| p.get("path")))
                .and_then(|v| v.as_str())
                .ok_or_else(|| String::from("control_add requires payload.comp"))?;
            let lit = serde_json::to_string(comp).map_err(|e| e.to_string())?;
            format!("u.ControlAddComp({lit})")
        }
        "control_remove" | "controlremove" => {
            let key = payload
                .and_then(|p| p.get("key"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| String::from("control_remove requires payload.key"))?;
            let lit = serde_json::to_string(key).map_err(|e| e.to_string())?;
            format!("u.ControlRemoveComp({lit})")
        }
        "control_set" | "controlset" => {
            let sets = payload
                .and_then(|p| p.get("sets"))
                .ok_or_else(|| String::from("control_set requires payload.sets"))?;
            let sets_json = serde_json::to_string(sets).map_err(|e| e.to_string())?;
            // Double-encode: embed the JSON as a Python string literal and parse
            // it in-process, so true/false/null never appear as bare Python tokens.
            let sets_lit = serde_json::to_string(&sets_json).map_err(|e| e.to_string())?;
            format!("u.ControlSet(__import__('json').loads({sets_lit}))")
        }
        "windows" | "get_windows" | "getwindows" => "u.GetWindows()".to_string(),
        "window_set" | "windowset" => {
            let path = payload
                .and_then(|p| p.get("path"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| String::from("window_set requires payload.path"))?;
            let path_lit = serde_json::to_string(path).map_err(|e| e.to_string())?;
            // Double-encoded like control_set, so JSON true/false/null never
            // reach Python as bare tokens.
            let fields = payload
                .and_then(|p| p.get("fields"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let fields_json = serde_json::to_string(&fields).map_err(|e| e.to_string())?;
            let fields_lit = serde_json::to_string(&fields_json).map_err(|e| e.to_string())?;
            let show = match payload.and_then(|p| p.get("open")).and_then(|v| v.as_bool()) {
                Some(true) => "True",
                Some(false) => "False",
                None => "None",
            };
            format!(
                "u.SetWindow({path_lit}, __import__('json').loads({fields_lit}), show={show})"
            )
        }
        "window_apply" | "windowapply" => {
            let items = match payload.and_then(|p| p.get("items")) {
                Some(v) if v.is_array() => {
                    let json = serde_json::to_string(v).map_err(|e| e.to_string())?;
                    let lit = serde_json::to_string(&json).map_err(|e| e.to_string())?;
                    format!("__import__('json').loads({lit})")
                }
                // None lets the utility fall back to the sidecar's layout.
                _ => "None".to_string(),
            };
            format!("u.ApplyWindowLayout({items})")
        }
        "window_save" | "windowsave" => {
            let paths = match payload.and_then(|p| p.get("paths")) {
                Some(v) if v.is_array() => {
                    let json = serde_json::to_string(v).map_err(|e| e.to_string())?;
                    let lit = serde_json::to_string(&json).map_err(|e| e.to_string())?;
                    format!("__import__('json').loads({lit})")
                }
                _ => "None".to_string(),
            };
            let apply_on_load = match payload
                .and_then(|p| p.get("apply_on_load"))
                .and_then(|v| v.as_bool())
            {
                Some(false) => "False",
                _ => "True",
            };
            let include_all = match payload
                .and_then(|p| p.get("include_all"))
                .and_then(|v| v.as_bool())
            {
                Some(true) => "True",
                _ => "False",
            };
            format!(
                "u.SaveWindowLayout({paths}, apply_on_load={apply_on_load}, include_all={include_all})"
            )
        }
        "window_clear" | "windowclear" => "u.ClearWindowLayout()".to_string(),
        "load_tox" | "loadtox" => {
            let tox = payload
                .and_then(|p| {
                    p.get("tox_path")
                        .or_else(|| p.get("path"))
                        .or_else(|| p.get("tox"))
                })
                .and_then(|v| v.as_str())
                .ok_or_else(|| String::from("load_tox requires payload.path"))?;
            let persist = payload
                .and_then(|p| p.get("persist"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let parent = payload
                .and_then(|p| p.get("parent"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let externaltox = payload
                .and_then(|p| p.get("externaltox"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let toxfile_module = payload
                .and_then(|p| {
                    p.get("toxfile_module")
                        .or_else(|| p.get("toxfileModule"))
                        .or_else(|| p.get("module"))
                })
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tox_lit = serde_json::to_string(tox).unwrap_or_else(|_| "\"\"".into());
            let parent_lit = if parent.is_empty() {
                "None".into()
            } else {
                serde_json::to_string(parent).unwrap_or_else(|_| "None".into())
            };
            let module_lit = if toxfile_module.is_empty() {
                "None".into()
            } else {
                serde_json::to_string(toxfile_module).unwrap_or_else(|_| "None".into())
            };
            format!(
                "u.LoadTox({tox_lit}, persist={persist}, parent={parent_lit}, externaltox={externaltox}, toxfile_module={module_lit})"
            )
        }
        "fns_install" | "fnsinstall" => {
            let sel = payload
                .and_then(|p| p.get("selection").or_else(|| p.get("selection_path")))
                .and_then(|v| v.as_str())
                .ok_or_else(|| String::from("fns_install requires payload.selection"))?;
            let sel_lit = serde_json::to_string(sel).map_err(|e| e.to_string())?;
            let boot = payload
                .and_then(|p| p.get("bootstrap").or_else(|| p.get("bootstrap_path")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let boot_lit = if boot.is_empty() {
                "None".into()
            } else {
                serde_json::to_string(boot).map_err(|e| e.to_string())?
            };
            let parent = payload
                .and_then(|p| p.get("parent"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let parent_lit = if parent.is_empty() {
                "None".into()
            } else {
                serde_json::to_string(parent).map_err(|e| e.to_string())?
            };
            format!("u.FnsInstall({sel_lit}, bootstrap_path={boot_lit}, parent={parent_lit})")
        }
        "autosave_get" | "autosaveget" => "u.AutosaveGet()".to_string(),
        "autosave_set" | "autosaveset" => {
            // Accept the fields nested or flat, the same two shapes the bus
            // action takes.
            let fields = payload
                .and_then(|p| p.get("fields").filter(|v| v.is_object()).cloned())
                .or_else(|| payload.cloned())
                .ok_or_else(|| String::from("autosave_set requires payload fields"))?;
            let fields_json = serde_json::to_string(&fields).map_err(|e| e.to_string())?;
            // Double-encode like control_set, so JSON true/false/null never
            // reach Python as bare tokens.
            let fields_lit = serde_json::to_string(&fields_json).map_err(|e| e.to_string())?;
            format!("u.AutosaveSet(__import__('json').loads({fields_lit}))")
        }
        "autosave_now" | "autosavenow" => "u.AutosaveNow()".to_string(),
        "fns_status" | "fnsstatus" => "u.FnsStatus()".to_string(),
        "fns_commands" | "fnscommands" => "u.ListCommands()".to_string(),
        "fns_run_command" | "fnsruncommand" => {
            let key = payload
                .and_then(|p| p.get("key").or_else(|| p.get("command")))
                .and_then(|v| v.as_str())
                .ok_or_else(|| String::from("fns_run_command requires payload.key"))?;
            let key_lit = serde_json::to_string(key).map_err(|e| e.to_string())?;
            // args/kwargs double-encode like autosave_set, so JSON tokens
            // never reach Python bare.
            let args = payload.and_then(|p| p.get("args")).filter(|v| v.is_array());
            let args_lit = match args {
                Some(v) => {
                    let j = serde_json::to_string(v).map_err(|e| e.to_string())?;
                    let l = serde_json::to_string(&j).map_err(|e| e.to_string())?;
                    format!("__import__('json').loads({l})")
                }
                None => "None".into(),
            };
            let kwargs = payload
                .and_then(|p| p.get("kwargs"))
                .filter(|v| v.is_object());
            let kwargs_lit = match kwargs {
                Some(v) => {
                    let j = serde_json::to_string(v).map_err(|e| e.to_string())?;
                    let l = serde_json::to_string(&j).map_err(|e| e.to_string())?;
                    format!("__import__('json').loads({l})")
                }
                None => "None".into(),
            };
            format!("u.RunCommand({key_lit}, args={args_lit}, kwargs={kwargs_lit})")
        }
        "fns_settings_url" | "fnssettingsurl" => {
            let ensure = payload
                .and_then(|p| p.get("ensure"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            format!(
                "u.FnsSettingsUrl(ensure={})",
                if ensure { "True" } else { "False" }
            )
        }
        "palette_url" | "paletteurl" => {
            let url = payload
                .and_then(|p| p.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let lit = serde_json::to_string(url).map_err(|e| e.to_string())?;
            format!("u.PaletteSetUrl({lit})")
        }
        "palette_status" | "palettestatus" => "u.PaletteStatus()".to_string(),
        "selection" | "get_selection" | "selected" => "u.Selection()".to_string(),
        "media_pick_replace" | "mediapickreplace" => {
            let r = payload
                .and_then(|p| p.get("ref"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            format!("u.MediaPickReplace({})", serde_json::to_string(r).map_err(|e| e.to_string())?)
        }
        "media_pick_status" | "mediapickstatus" => "u.MediaPickStatus()".to_string(),
        "toolbox_save_selected" | "toolboxsaveselected" => {
            let dir = payload
                .and_then(|p| p.get("dir"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let name = payload
                .and_then(|p| p.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let d = serde_json::to_string(dir).map_err(|e| e.to_string())?;
            let n = serde_json::to_string(name).map_err(|e| e.to_string())?;
            format!("u.ToolboxSaveSelected({d}, name={n} or None)")
        }
        _ => return Err(format!("Unknown utility action: {action}")),
    };
    // json.dumps so the payload crosses Envoy as real JSON, not a Python repr
    // string — unwrap_exec_envelope parses it back on this side.
    Ok(format!(
        r#"
u = getattr(op, 'TDXLU', None)
if u is None:
    result = {{'ok': False, 'error': 'op.TDXLU shortcut not found (utility not loaded in this project)'}}
else:
    result = {call}
result = __import__('json').dumps(result)
"#
    ))
}

pub fn run_utility_action_ex(
    port: u16,
    action: &str,
    payload: Option<&Value>,
) -> Result<Value, String> {
    let code = utility_action_code(action, payload)?;
    execute_python(port, &code)
}

fn resolve_toe(root: &Path, toe_rel: &str) -> PathBuf {
    let p = PathBuf::from(toe_rel);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

fn read_mcp_snippet(mcp_path: &Path) -> (Vec<String>, Option<String>, Option<String>) {
    let Ok(text) = fs::read_to_string(mcp_path) else {
        return (vec![], None, None);
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (vec![], Some(text), None);
    };
    let mut keys = Vec::new();
    let mut bridge_cmd = None;
    if let Some(servers) = v.get("mcpServers").and_then(|s| s.as_object()) {
        for (k, server) in servers {
            keys.push(k.clone());
            if bridge_cmd.is_none() {
                let cmd = server.get("command").and_then(|c| c.as_str()).unwrap_or("");
                let args = server
                    .get("args")
                    .and_then(|a| a.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                if !cmd.is_empty() {
                    bridge_cmd = Some(format!("{cmd} {args}").trim().to_string());
                }
            }
        }
    }
    let pretty = serde_json::to_string_pretty(&v).ok().or(Some(text));
    (keys, pretty, bridge_cmd)
}

fn empty_status(message: &str) -> McpBridgeStatus {
    McpBridgeStatus {
        provider_id: None,
        provider_label: None,
        detected: false,
        project_root: None,
        envoy_json: None,
        mcp_json: None,
        active_instance: None,
        port: None,
        toe_path: None,
        td_executable: None,
        td_pid: None,
        td_alive: false,
        port_open: false,
        envoy_reachable: false,
        mcp_server_keys: vec![],
        mcp_snippet: None,
        bridge_command: None,
        status: "none".into(),
        message: message.into(),
    }
}

/// Inspect MCP/Embody setup for a selected `.toe` or project folder.
pub fn inspect_path(path: &str) -> McpBridgeStatus {
    let start = PathBuf::from(path);
    if path.is_empty() || (!start.exists() && start.extension().is_none()) {
        return empty_status("Select a project to inspect MCP bridges");
    }

    let Some(root) = find_project_root(&start) else {
        return empty_status("No .embody / .mcp.json found walking up from this path");
    };

    let embody_dir = root.join(".embody");
    let envoy_path = embody_dir.join("envoy.json");
    let mcp_path = root.join(".mcp.json");

    let has_embody = envoy_path.is_file();
    let has_mcp = mcp_path.is_file();
    if !has_embody && !has_mcp {
        return empty_status("Project root found but no Envoy/MCP config");
    }

    let (mcp_keys, mcp_snippet, bridge_command) = if has_mcp {
        read_mcp_snippet(&mcp_path)
    } else {
        (vec![], None, None)
    };

    let mut st = McpBridgeStatus {
        provider_id: Some(PROVIDER_EMBODY.into()),
        provider_label: Some("Embody / Envoy".into()),
        detected: true,
        project_root: Some(normalize_slash(&root)),
        envoy_json: has_embody.then(|| normalize_slash(&envoy_path)),
        mcp_json: has_mcp.then(|| normalize_slash(&mcp_path)),
        active_instance: None,
        port: None,
        toe_path: None,
        td_executable: None,
        td_pid: None,
        td_alive: false,
        port_open: false,
        envoy_reachable: false,
        mcp_server_keys: mcp_keys,
        mcp_snippet,
        bridge_command,
        status: "detected".into(),
        message: String::new(),
    };

    if has_embody {
        if let Ok(text) = fs::read_to_string(&envoy_path) {
            if let Ok(cfg) = serde_json::from_str::<EnvoyFile>(&text) {
                st.td_executable = cfg.td_executable.clone();
                let active = cfg
                    .active
                    .clone()
                    .or_else(|| cfg.instances.keys().next().cloned());
                st.active_instance = active.clone();
                if let Some(name) = active {
                    if let Some(inst) = cfg.instances.get(&name) {
                        if let Some(port) = inst.get("port").and_then(|p| p.as_u64()) {
                            st.port = Some(port as u16);
                        }
                        if let Some(toe) = inst.get("toe_path").and_then(|t| t.as_str()) {
                            st.toe_path = Some(normalize_slash(&resolve_toe(&root, toe)));
                        }
                        if let Some(pid) = inst.get("td_pid").and_then(|p| p.as_u64()) {
                            let pid = pid as u32;
                            st.td_pid = Some(pid);
                            st.td_alive = pid_alive(pid);
                        }
                    }
                }
            }
        }
    }

    // Prefer port from mcp.json args if envoy.json missing it
    if st.port.is_none() {
        if let Some(cmd) = &st.bridge_command {
            if let Some(i) = cmd.find("--port") {
                let rest = cmd[i + 6..].trim();
                if let Some(tok) = rest.split_whitespace().next() {
                    if let Ok(p) = tok.parse::<u16>() {
                        st.port = Some(p);
                    }
                }
            }
        }
    }

    if let Some(port) = st.port {
        st.port_open = port_open(port);
        st.envoy_reachable = if st.port_open {
            ping_envoy(port)
        } else {
            false
        };
    }

    st.status = if st.envoy_reachable {
        "online".into()
    } else if st.td_alive {
        "td_up_envoy_down".into()
    } else if st.detected {
        "offline".into()
    } else {
        "none".into()
    };

    st.message = match st.status.as_str() {
        "online" => format!(
            "Envoy reachable on :{}",
            st.port.unwrap_or(0)
        ),
        "td_up_envoy_down" => "TD process alive but Envoy not responding".into(),
        "offline" => {
            if st.port.is_some() {
                format!(
                    "Embody project ready - Envoy offline (port {})",
                    st.port.unwrap_or(0)
                )
            } else {
                "Embody/MCP config found - no port yet".into()
            }
        }
        _ => st.message.clone(),
    };

    st
}

pub fn open_mcp_folder(path: &str) -> Result<(), String> {
    let st = inspect_path(path);
    let target = st
        .project_root
        .or(st.mcp_json)
        .or(st.envoy_json)
        .ok_or_else(|| "No MCP project root to open".to_string())?;
    crate::project::open_in_file_manager(&target)
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text + "\n").map_err(|e| e.to_string())
}

fn update_mcp_json_port(mcp_path: &Path, port: u16) -> Result<bool, String> {
    if !mcp_path.is_file() {
        return Ok(false);
    }
    let text = fs::read_to_string(mcp_path).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let Some(servers) = v.get_mut("mcpServers").and_then(|s| s.as_object_mut()) else {
        return Ok(false);
    };
    let mut changed = false;
    for (_name, server) in servers.iter_mut() {
        if let Some(args) = server.get_mut("args").and_then(|a| a.as_array_mut()) {
            let mut i = 0;
            while i + 1 < args.len() {
                if args[i].as_str() == Some("--port") {
                    let next = port.to_string();
                    if args[i + 1].as_str() != Some(next.as_str()) {
                        args[i + 1] = Value::String(next);
                        changed = true;
                    }
                    break;
                }
                i += 1;
            }
        }
        if let Some(url) = server.get("url").and_then(|u| u.as_str()) {
            // http://127.0.0.1:9870/mcp or localhost
            if let Some(rest) = url.strip_prefix("http://") {
                let hostport_path = rest;
                if let Some((hostport, path_rest)) = hostport_path.split_once('/') {
                    if let Some((host, _old_port)) = hostport.rsplit_once(':') {
                        let new_url = format!("http://{host}:{port}/{path_rest}");
                        if url != new_url {
                            server
                                .as_object_mut()
                                .map(|o| o.insert("url".into(), Value::String(new_url)));
                            changed = true;
                        }
                    }
                }
            }
        }
    }
    if changed {
        write_json_pretty(mcp_path, &v)?;
    }
    Ok(changed)
}

fn update_envoy_json_port(envoy_path: &Path, port: u16) -> Result<bool, String> {
    if !envoy_path.is_file() {
        return Ok(false);
    }
    let text = fs::read_to_string(envoy_path).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let active = v
        .get("active")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string());
    let Some(instances) = v.get_mut("instances").and_then(|i| i.as_object_mut()) else {
        return Ok(false);
    };
    let key = active
        .filter(|k| instances.contains_key(k.as_str()))
        .or_else(|| instances.keys().next().cloned());
    let Some(key) = key else {
        return Ok(false);
    };
    let Some(inst) = instances.get_mut(&key).and_then(|i| i.as_object_mut()) else {
        return Ok(false);
    };
    let old = inst.get("port").and_then(|p| p.as_u64()).map(|p| p as u16);
    if old == Some(port) {
        return Ok(false);
    }
    inst.insert("port".into(), Value::Number(port.into()));
    write_json_pretty(envoy_path, &v)?;
    Ok(true)
}

fn update_embody_config_port(config_path: &Path, port: u16) -> Result<bool, String> {
    if !config_path.is_file() {
        return Ok(false);
    }
    let text = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let Some(params) = v.get_mut("params").and_then(|p| p.as_object_mut()) else {
        return Ok(false);
    };
    let entry = params
        .entry("Envoyport".to_string())
        .or_insert_with(|| serde_json::json!({ "val": port }));
    let old = entry.get("val").and_then(|x| x.as_u64()).map(|x| x as u16);
    if old == Some(port) {
        return Ok(false);
    }
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("val".into(), Value::Number(port.into()));
    } else {
        *entry = serde_json::json!({ "val": port });
    }
    write_json_pretty(config_path, &v)?;
    Ok(true)
}

/// Update Embody/Envoy port across `.embody/envoy.json`, `.embody/config.json`, and `.mcp.json`.
/// Returns refreshed status. TD Utility (or Embody) must apply `Envoyport` live if TD is open.
pub fn set_port(path: &str, port: u16) -> Result<McpBridgeStatus, String> {
    if !(1024..=65535).contains(&port) {
        return Err("Port must be between 1024 and 65535".into());
    }
    let start = PathBuf::from(path);
    let root = find_project_root(&start)
        .ok_or_else(|| "No .embody / .mcp.json project root found".to_string())?;

    let envoy_path = root.join(".embody").join("envoy.json");
    let config_path = root.join(".embody").join("config.json");
    let mcp_path = root.join(".mcp.json");

    let mut notes = Vec::new();
    if update_envoy_json_port(&envoy_path, port)? {
        notes.push("envoy.json");
    }
    if update_embody_config_port(&config_path, port)? {
        notes.push("config.json");
    }
    if update_mcp_json_port(&mcp_path, port)? {
        notes.push(".mcp.json");
    }
    if notes.is_empty() {
        // Still rewrite mcp/envoy if files missing one side - ensure at least mcp exists intent
        if !envoy_path.is_file() && !mcp_path.is_file() && !config_path.is_file() {
            return Err("No Embody MCP config files to update".into());
        }
        notes.push("unchanged (already set)");
    }

    let mut st = inspect_path(path);
    st.message = format!(
        "Port set to {} ({}) - Utility/Embody applies live if TD is open; restart AI MCP client to pick up .mcp.json",
        port,
        notes.join(", ")
    );
    Ok(st)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway project tree of exactly the shape `inspect_path` walks up
    /// to find: `.embody/envoy.json` + `.mcp.json` beside a stub `.toe`.
    fn fixture(tag: &str, port: u16) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tdxlu-mcp-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".embody")).unwrap();
        fs::write(
            root.join(".embody").join("envoy.json"),
            serde_json::json!({
                "active": "main",
                "td_executable": "C:/TD/TouchDesigner.exe",
                "instances": { "main": { "port": port, "toe_path": "show.toe" } }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join(".mcp.json"),
            serde_json::json!({
                "mcpServers": {
                    "envoy": {
                        "command": "python",
                        "args": ["bridge.py", "--port", port.to_string()]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(root.join("show.toe"), b"stub").unwrap();
        root
    }

    /// Was `inspect_tdxlpp_repo`, which pointed at this repo's own checkout.
    /// Its `.toe` guard passed (the file is tracked) but the assertions then
    /// needed `.mcp.json` and `.embody/envoy.json` — both gitignored — so the
    /// test only passed on a machine that already had local Embody config, and
    /// failed on every clean clone. Owning the tree makes it run anywhere.
    #[test]
    fn inspect_reads_port_and_paths_from_a_project_tree() {
        let root = fixture("inspect", 59_873);
        let st = inspect_path(&root.join("show.toe").to_string_lossy());
        assert!(st.detected, "{}", st.message);
        assert_eq!(st.provider_id.as_deref(), Some(PROVIDER_EMBODY));
        assert_eq!(st.active_instance.as_deref(), Some("main"));
        assert_eq!(st.port, Some(59_873), "port must come from envoy.json");
        assert!(st.envoy_json.is_some());
        assert!(st.mcp_json.is_some());
        assert_eq!(st.mcp_server_keys, vec!["envoy".to_string()]);
        let _ = fs::remove_dir_all(&root);
    }

    /// `.mcp.json` alone still detects — the port then has to come out of the
    /// bridge command line rather than `envoy.json`.
    #[test]
    fn port_falls_back_to_the_mcp_bridge_args() {
        let root = fixture("fallback", 59_874);
        fs::remove_dir_all(root.join(".embody")).unwrap();
        let st = inspect_path(&root.to_string_lossy());
        assert!(st.detected, "{}", st.message);
        assert!(st.envoy_json.is_none());
        assert_eq!(
            st.port,
            Some(59_874),
            "port must come from --port in .mcp.json"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// A folder with neither file reports "not detected" rather than claiming
    /// a bridge that isn't there.
    #[test]
    fn folder_without_config_is_not_detected() {
        let root = std::env::temp_dir().join(format!("tdxlu-mcp-bare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let st = inspect_path(&root.to_string_lossy());
        assert!(!st.detected, "{}", st.message);
        let _ = fs::remove_dir_all(&root);
    }
}
