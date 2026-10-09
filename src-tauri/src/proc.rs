//! Child processes that stay invisible on Windows.
//!
//! A built Tauri app is a GUI-subsystem binary with no console attached, so
//! every console program it spawns (`tasklist`, `powershell`, `git`, `where`,
//! `uv`, ...) gets Windows to allocate one — a black window that blinks on
//! screen. Discovery on first launch spawns these in bursts, which reads as a
//! storm of popups. `CREATE_NO_WINDOW` suppresses it.
//!
//! Use [`command`] for anything whose output we consume. Skip it only when the
//! window is the point (a shell the user explicitly asked to open).

use std::ffi::OsStr;
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// `Command::new`, minus the console window on Windows.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    hide(&mut cmd);
    cmd
}

/// `Command::output`, but gives up after `timeout` instead of blocking forever.
///
/// A plain `.output()` waits on the child's own exit, and some children (most
/// notably `taskkill /F` / `kill -9` against a process wedged in a kernel-mode
/// wait — a GPU driver TDR, a hung device I/O) never return: the OS's own
/// terminate call can't complete until the stuck wait resolves, so the
/// termination tool just sits there. Without a bound here, that hangs
/// whichever caller is waiting on us — e.g. a Tauri command holding a mutex
/// the rest of the UI needs, freezing everything downstream of it, not just
/// the kill. On timeout we kill *our own* child (the taskkill/kill process),
/// not the original target, and surface a clear error instead of wedging.
pub fn output_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("timed out after {:.1}s", timeout.as_secs_f64()));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_end(&mut stdout);
    }
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_end(&mut stderr);
    }
    Ok(Output { status, stdout, stderr })
}

/// Run blocking work on a plain OS thread, outside any tokio runtime context.
///
/// `#[tauri::command(async)]` executes a command body on the async runtime.
/// `reqwest::blocking` owns an inner runtime that it must drop when the client
/// goes away, and dropping a runtime from inside an async context panics with
/// "Cannot drop a runtime in a context where blocking is not allowed". A plain
/// thread has no ambient runtime, so the blocking client is safe there.
///
/// Wrap the whole client lifecycle — build, request, and drop — not just the
/// construction, since the panic fires on drop.
pub fn off_runtime<T, F>(f: F) -> T
where
    F: FnOnce() -> T + Send,
    T: Send,
{
    std::thread::scope(|s| match s.spawn(f).join() {
        Ok(v) => v,
        // Propagate the worker's own panic payload rather than masking it
        Err(payload) => std::panic::resume_unwind(payload),
    })
}

/// Apply the no-console flag to a `Command` built elsewhere.
///
/// No-op off Windows, so callers need no `cfg` of their own.
pub fn hide(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Start a program that outlives the launcher, returning its pid.
///
/// A plain `Command::spawn` makes the program a child of this process, and
/// Windows ends process *trees*: `tauri dev` restarting the launcher, or
/// "End task" on it in Task Manager, took every TouchDesigner it had started
/// down with it — no save prompt. Here the new process is created with the
/// desktop shell (explorer.exe) as its parent instead, via
/// `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, so nothing that kills the
/// launcher's tree reaches it. Unlike spawning through `cmd /c start`, the
/// real pid still comes back, which every session feature depends on.
///
/// The new process takes the shell's token too: an elevated launcher starts
/// TouchDesigner at normal integrity, the same as double-clicking a .toe.
///
/// Any failure along the way (no shell window, access denied) falls back to a
/// plain spawn — reparenting must never be the reason a launch fails.
pub fn spawn_outside_launcher_tree(
    program: &std::path::Path,
    args: &[String],
) -> Result<u32, String> {
    #[cfg(windows)]
    {
        match win_reparent::spawn(program, args) {
            Ok(pid) => return Ok(pid),
            Err(e) => {
                log::warn!("launch: reparenting to the shell failed ({e}); spawning as a child")
            }
        }
    }
    let child = Command::new(program)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(child.id())
}

/// Quote one argument for a Windows command line the way the MSVC runtime
/// (and Rust's own `Command`) parses it back.
#[cfg_attr(not(windows), allow(dead_code))]
fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Backslashes right before the closing quote must be doubled, or the last
    // one escapes the quote and the argument runs on.
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
    out
}

#[cfg(windows)]
mod win_reparent {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        OpenProcess, UpdateProcThreadAttribute, CREATE_NEW_CONSOLE, EXTENDED_STARTUPINFO_PRESENT,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_CREATE_PROCESS, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, STARTUPINFOEXW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn spawn(program: &std::path::Path, args: &[String]) -> Result<u32, String> {
        unsafe {
            let shell = GetShellWindow();
            if shell.is_null() {
                return Err("no desktop shell window".into());
            }
            let mut shell_pid = 0u32;
            GetWindowThreadProcessId(shell, &mut shell_pid);
            if shell_pid == 0 {
                return Err("no desktop shell process".into());
            }
            let parent: HANDLE = OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid);
            if parent.is_null() {
                return Err(format!(
                    "OpenProcess(shell pid {shell_pid}) failed: {}",
                    std::io::Error::last_os_error()
                ));
            }

            let mut size = 0usize;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
            let mut attr_buf = vec![0u8; size.max(1)];
            let attrs = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
                CloseHandle(parent);
                return Err("InitializeProcThreadAttributeList failed".into());
            }
            let parent_value: HANDLE = parent;
            let updated = UpdateProcThreadAttribute(
                attrs,
                0,
                PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                &parent_value as *const HANDLE as *const core::ffi::c_void,
                std::mem::size_of::<HANDLE>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if updated == 0 {
                DeleteProcThreadAttributeList(attrs);
                CloseHandle(parent);
                return Err("UpdateProcThreadAttribute failed".into());
            }

            let mut line = super::quote_windows_arg(&program.to_string_lossy());
            for a in args {
                line.push(' ');
                line.push_str(&super::quote_windows_arg(a));
            }
            let mut line_w = wide(std::ffi::OsStr::new(&line));
            let app_w = wide(program.as_os_str());

            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.lpAttributeList = attrs;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();

            let created = CreateProcessW(
                app_w.as_ptr(),
                line_w.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                // A console program inherits its console from the PARENT,
                // and the shell has none, so without a console of its own it
                // exits at once. The shell asks for a new console when it
                // starts one itself; GUI programs such as TouchDesigner
                // ignore the flag.
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NEW_CONSOLE,
                std::ptr::null(),
                std::ptr::null(),
                &si.StartupInfo,
                &mut pi,
            );
            let create_err = std::io::Error::last_os_error();
            DeleteProcThreadAttributeList(attrs);
            CloseHandle(parent);
            if created == 0 {
                return Err(format!("CreateProcessW failed: {create_err}"));
            }
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            Ok(pi.dwProcessId)
        }
    }
}

#[cfg(all(test, windows))]
mod reparent_probe {
    /// Manual probe: start a hidden stand-in through the real launch path and
    /// print its pid and parent. The spawned process is left running on
    /// purpose, so the caller can confirm from OUTSIDE that it outlived this
    /// test process (and kill it afterwards). Ignored by default.
    ///
    ///   cargo test --lib reparent_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn spawned_process_is_parented_to_the_shell() {
        let args: Vec<String> = ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "Start-Sleep -Seconds 45"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let exe = std::path::Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        let direct = super::win_reparent::spawn(exe, &args);
        println!("REPARENT direct_spawn={direct:?}");
        let pid = direct.expect("reparented spawn");
        std::thread::sleep(std::time::Duration::from_secs(2));

        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let proc_ = sys.process(Pid::from_u32(pid)).expect("still running after 2s: args parsed");
        let parent = proc_.parent().map(|p| p.as_u32());
        let parent_name = parent
            .and_then(|pp| sys.process(Pid::from_u32(pp)))
            .map(|p| p.name().to_string_lossy().to_string());
        println!(
            "REPARENT child_pid={pid} parent_pid={parent:?} parent_name={parent_name:?} test_pid={}",
            std::process::id()
        );
        assert_ne!(parent, Some(std::process::id()), "must not be a child of the spawner");
        assert_eq!(parent_name.as_deref().map(str::to_ascii_lowercase).as_deref(), Some("explorer.exe"));
    }
}

#[cfg(test)]
mod quote_tests {
    use super::quote_windows_arg as q;

    #[test]
    fn plain_args_are_left_alone() {
        assert_eq!(q("-gpuformonitor"), "-gpuformonitor");
        assert_eq!(q(r"C:\VJ\TD\Show.toe"), r"C:\VJ\TD\Show.toe");
    }

    #[test]
    fn spaces_and_empty_get_quoted() {
        assert_eq!(
            q(r"C:\Program Files\Derivative\bin\TouchDesigner.exe"),
            r#""C:\Program Files\Derivative\bin\TouchDesigner.exe""#
        );
        assert_eq!(q(""), "\"\"");
    }

    #[test]
    fn trailing_backslash_before_closing_quote_is_doubled() {
        assert_eq!(q(r"C:\My Projects\"), r#""C:\My Projects\\""#);
    }

    #[test]
    fn embedded_quotes_are_escaped() {
        assert_eq!(q(r#"a "b" c"#), r#""a \"b\" c""#);
    }
}

#[cfg(test)]
mod tests {
    /// Regression: building a blocking client inside an async context panics
    /// with "Cannot drop a runtime in a context where blocking is not allowed".
    /// Every `#[tauri::command(async)]` body runs in exactly that context.
    #[test]
    fn blocking_http_client_survives_async_context() {
        tauri::async_runtime::block_on(async {
            super::off_runtime(|| {
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_millis(50))
                    .build();
                assert!(client.is_ok());
                // drop happens here, on a thread with no ambient runtime
            });
        });
    }

    /// Proves the test above is not vacuous: the same work WITHOUT
    /// `off_runtime` is exactly what crashed the built app.
    #[test]
    #[should_panic(expected = "Cannot drop a runtime")]
    fn blocking_http_client_panics_on_the_async_runtime() {
        tauri::async_runtime::block_on(async {
            let _client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_millis(50))
                .build();
        });
    }

    fn sleep_cmd(secs: u32) -> super::Command {
        #[cfg(windows)]
        {
            let mut c = super::command("powershell");
            c.args(["-NoProfile", "-Command", &format!("Start-Sleep -Seconds {secs}")]);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = super::command("sh");
            c.args(["-c", &format!("sleep {secs}")]);
            c
        }
    }

    /// A child that exits well inside the deadline returns normally.
    #[test]
    fn output_with_timeout_returns_fast_child() {
        let out = super::output_with_timeout(sleep_cmd(0), std::time::Duration::from_secs(5)).unwrap();
        assert!(out.status.success());
    }

    /// Regression: a child stuck past the deadline (our stand-in for a
    /// process wedged in a kernel-mode wait that a forceful kill can't
    /// interrupt) must return an error within roughly the deadline, not hang
    /// the caller indefinitely.
    #[test]
    fn output_with_timeout_gives_up_on_hung_child() {
        let start = std::time::Instant::now();
        let res = super::output_with_timeout(sleep_cmd(30), std::time::Duration::from_secs(1));
        assert!(res.is_err());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "took {:?}, should have given up near the 1s deadline",
            start.elapsed()
        );
    }
}
