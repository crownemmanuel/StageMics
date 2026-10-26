//! StageMics desktop shell. The app itself is the service in app/server (the dLive link, the show,
//! OSC from LiveStage, the backstage page for phones), built into one executable that ships next to this
//! one (`mics-server`, see scripts/build-sidecar.ts). This shell starts it, shows its operator screen in
//! the window, and stops it when the app quits. It also carries the updater (the screen asks for it).
//!
//! If a copy of the service is already answering on the port (a previous run that did not stop, or
//! `pnpm serve` on a development computer), the window uses that one and leaves it running on quit.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, Url};

const HTTP_PORT: u16 = 1450;

/// The service this app started (None when it uses one that was already running).
struct Service(Mutex<Option<Child>>);

/// Does the service answer on this port? (GET /api/ping, a few hundred ms at most)
fn ping(port: u16) -> bool {
  let addr = SocketAddr::from(([127, 0, 0, 1], port));
  let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else { return false };
  let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
  if s.write_all(b"GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
    return false;
  }
  let mut body = String::new();
  let _ = s.read_to_string(&mut body);
  body.contains("\"stagemics\"")
}

/// The `mics-server` executable that the bundle puts next to this one.
fn sidecar_path() -> PathBuf {
  let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
  dir.join(if cfg!(windows) { "mics-server.exe" } else { "mics-server" })
}

/// Tell the start-up page in the window what is happening (it shows the text; `error` turns it red).
fn status(app: &AppHandle, text: &str, error: bool) {
  if let Some(w) = app.get_webview_window("main") {
    let js = format!("window.__micsStatus && window.__micsStatus({}, {})", serde_json::to_string(text).unwrap_or_default(), error);
    let _ = w.eval(&js);
  }
}

fn open_screen(app: &AppHandle, url: &str) {
  if let (Some(w), Ok(u)) = (app.get_webview_window("main"), Url::parse(url)) {
    let _ = w.navigate(u);
  }
}

fn start_service(app: AppHandle) {
  let local = format!("http://127.0.0.1:{HTTP_PORT}/");
  if ping(HTTP_PORT) {
    open_screen(&app, &local);
    return;
  }
  let dist = app.path().resource_dir().map(|d| d.join("dist")).unwrap_or_default();
  let mut cmd = Command::new(sidecar_path());
  cmd
    // The OSC port (network control) is a setting inside the app: Build → Settings → Network control.
    .args(["--dist", &dist.to_string_lossy(), "--http-port", &HTTP_PORT.to_string()])
    .env("SOUND_APP_VERSION", app.package_info().version.to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  }
  let mut child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      status(&app, &format!("Could not start the mic service ({}): {e}", sidecar_path().display()), true);
      return;
    }
  };
  let stdout = child.stdout.take();
  *app.state::<Service>().0.lock().unwrap() = Some(child);

  // Read the service's output: wait for its "ready" line, then keep draining it so it never blocks.
  let mut ready = false;
  if let Some(out) = stdout {
    for line in BufReader::new(out).lines().map_while(Result::ok) {
      if !ready && line.starts_with("SOUND_READY ") {
        ready = true;
        open_screen(&app, &local);
      }
    }
  }
  // Output closed: the service stopped.
  let code = app.state::<Service>().0.lock().unwrap().as_mut().and_then(|c| c.wait().ok()).and_then(|s| s.code());
  if !ready {
    let why = match code {
      Some(2) => format!("Port {HTTP_PORT} is in use by another program. Close it and start StageMics again."),
      _ => format!("The mic service stopped while starting (exit {code:?})."),
    };
    status(&app, &why, true);
  } else if !app.state::<Service>().0.lock().unwrap().is_none() {
    status(&app, "The mic service stopped. Quit and start StageMics again.", true);
  }
}

/// Stop the service this app started: a polite stop first (it saves the show), then a hard one.
fn stop_service(app: &AppHandle) {
  let Some(mut child) = app.state::<Service>().0.lock().unwrap().take() else { return };
  #[cfg(unix)]
  {
    let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
      if let Ok(Some(_)) = child.try_wait() {
        return;
      }
      std::thread::sleep(Duration::from_millis(50));
    }
  }
  let _ = child.kill();
  let _ = child.wait();
}

/// The screen calls this right before an update installs, so the installer can replace `mics-server`.
#[tauri::command]
fn stop_for_update(app: AppHandle) {
  stop_service(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
      }
    }))
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(Service(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![stop_for_update])
    .setup(|app| {
      let handle = app.handle().clone();
      std::thread::spawn(move || start_service(handle));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building StageMics")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        stop_service(app);
      }
    });
}
