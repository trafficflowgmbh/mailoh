// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The whole Rust side. ohmail Desktop is a window around a static bundle:
// there are no commands to register, so the webview has nothing to call and
// capabilities/main.json grants it nothing. Window geometry, title, CSP and
// icons are declarative in tauri.conf.json — code here would only be a second
// place for them to disagree.
//
// ── THE ONE THING THIS FILE DOES BEYOND OPENING A WINDOW ──────────────────────
//
// Under the `local-engine` feature — OFF by default, and off in every build
// published so far — the shell also owns the lifetime of the local engine: it
// starts it with the app and makes certain it is gone when the app is. That is
// process lifecycle, not a capability the webview gains: the permission list
// stays empty, because the frontend still calls nothing and no command is
// registered for it to call. `engine.rs` carries the reasoning; the three lines
// here are the only places it is hooked up.
//
// The hooks are BOTH of the ones that exist, and they are not redundant.
// Destroying the last window ends the app on Windows and Linux, so `Exit`
// covers a quit; it does not on macOS, where a closed window can leave the
// process running — and an engine outliving the window it belonged to is
// exactly the stray process this exists to prevent. `Engine::stop` is
// idempotent, so a platform that fires both pays nothing for it.

#[cfg(feature = "local-engine")]
mod engine;

fn main() {
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("ohmail: failed to start the Tauri runtime");

    #[cfg(feature = "local-engine")]
    let engine = engine::Engine::start(&app);

    app.run(move |_app, _event| {
        #[cfg(feature = "local-engine")]
        match &_event {
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. }
                if label == "main" =>
            {
                engine.stop()
            }
            tauri::RunEvent::Exit => engine.stop(),
            _ => {}
        }
    });
}
