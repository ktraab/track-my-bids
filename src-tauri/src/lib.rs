use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_fs::FsExt;
use tauri_plugin_opener::OpenerExt;

const TICK_EVERY: Duration = Duration::from_secs(60);
const DOC_EXTENSIONS: [&str; 3] = ["pdf", "docx", "xlsx"];

/// The bid document most recently dropped on the window or picked in the dialog: the only file
/// "Open file" may hand to the default app (dropped files often live in temp folders, e.g. Mail's).
#[derive(Default)]
struct LastDocument(Mutex<Option<PathBuf>>);

/// A regular file with a bid-document extension (.pdf / .docx / .xlsx, any case).
fn is_document(p: &Path) -> bool {
    p.is_file()
        && p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| DOC_EXTENSIONS.iter().any(|d| e.eq_ignore_ascii_case(d)))
}

/// A document picked in the dialog (which already let the app read it) becomes the one "Open file" opens.
#[tauri::command]
fn register_document(app: AppHandle, last: State<'_, LastDocument>, path: PathBuf) -> Result<(), String> {
    if !is_document(&path) || !app.fs_scope().is_allowed(&path) {
        return Err("That file can't be opened from here.".into());
    }
    *last.0.lock().map_err(|e| e.to_string())? = Some(path);
    Ok(())
}

/// Open the last dropped/picked document with its default app — only when it is the one asked for.
#[tauri::command]
fn open_document(app: AppHandle, last: State<'_, LastDocument>, path: PathBuf) -> Result<(), String> {
    let current = last.0.lock().map_err(|e| e.to_string())?.clone();
    match current {
        Some(p) if p == path && is_document(&p) => app
            .opener()
            .open_path(p.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string()),
        _ => Err("That file can't be opened from here.".into()),
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open TrackMyBids", true, None::<&str>)?;
    let add = MenuItem::with_id(app, "quick_add", "New bid…", true, None::<&str>)?;
    let digest = MenuItem::with_id(app, "digest", "Today's briefing", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TrackMyBids", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &add, &digest, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main");
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }
    builder
        .tooltip("TrackMyBids")
        .menu(&menu)
        // macOS shows the menu on left click; on Windows left click opens the window and right click the menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_tray_icon_event(|tray, event| {
            if !cfg!(target_os = "macos")
                && let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
            {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quick_add" => {
                show_main(app);
                let _ = app.emit("tray-quick-add", ());
            }
            "digest" => {
                show_main(app);
                let _ = app.emit("tray-digest", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch focuses the running instance instead of starting another scheduler.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(LastDocument::default())
        .invoke_handler(tauri::generate_handler![register_document, open_document])
        .setup(|app| {
            build_tray(app)?;
            // The window is created hidden (no flash at login); show it unless launched at login.
            if !std::env::args().any(|a| a == "--minimized")
                && let Some(w) = app.get_webview_window("main")
            {
                let _ = w.show();
            }
            // Hidden webviews throttle JS timers, so the clock lives here.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(TICK_EVERY);
                let _ = handle.emit("scheduler-tick", ());
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the window keeps the app (and its reminders) running in the tray.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // A bid document dropped on the window: let the frontend read exactly that file — the first
            // regular .pdf/.docx/.xlsx among those dropped, the same one the frontend imports (the fs scope is
            // otherwise only the app cache; picked files are allowed by the dialog).
            WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                if let Some(p) = paths.iter().find(|p| is_document(p)) {
                    let _ = window.fs_scope().allow_file(p);
                    if let Ok(mut last) = window.state::<LastDocument>().0.lock() {
                        *last = Some(p.clone());
                    }
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}
