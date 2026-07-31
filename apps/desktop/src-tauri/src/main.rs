// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The whole Rust side. ohmail Desktop is a window around a static bundle:
// there are no commands to register, so the webview has nothing to call and
// capabilities/main.json grants it nothing. Window geometry, title, CSP and
// icons are declarative in tauri.conf.json — code here would only be a second
// place for them to disagree.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("ohmail: failed to start the Tauri runtime");
}
