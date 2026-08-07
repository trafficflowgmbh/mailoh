//! THE MENU BAR — the one piece of user interface this process owns.
//!
//! Everything else a person sees is React inside the webview, deliberately: one design system,
//! one set of screens, and no second look-and-feel to keep in step. A menu bar is the exception
//! because it cannot be anything else — it is drawn by the operating system, it is where a Mac
//! user looks for an application's commands, and its accelerators have to work before the page
//! has focus.
//!
//! ── ONE OWNER, BECAUSE `Builder::setup` REPLACES AND DOES NOT COMPOSE ───────────────────────
//!
//! The menu is installed from `setup`, and a second `setup` on the same builder silently
//! overwrites the first — so a file that installed a menu of its own would delete this one with
//! nothing failing to say so. This module is therefore the only place `app.set_menu` is called.
//! `updater.rs` still owns the updater: it contributes the id of its item and handles the event
//! for it, on its own `on_menu_event`, which unlike `setup` genuinely appends.
//!
//! ── WHAT IS IN THE BAR, AND WHY EACH PART IS THERE ─────────────────────────────────────────
//!
//!   * **ohmail** — "Check for Updates…" and Quit. Unchanged; the updater's only trigger.
//!   * **Edit** — the platform's own undo/cut/copy/paste/select-all items. These are not
//!     decoration. On macOS a webview gets ⌘C and ⌘V from the menu bar, so an app with no Edit
//!     menu is an app where you cannot copy a line out of your own mail. They are the system's
//!     items rather than commands of ours: the webview is never told about them.
//!   * **View** — the five places mail lives, on ⌘1…⌘5. Compiled only into the engine-bearing
//!     build, because it is the only one whose window is permitted to hear the event: the
//!     published preview grants the webview nothing, so a View menu there would be five items
//!     that do nothing.
//!
//! ── HOW A MENU ITEM BECOMES A NAVIGATION ───────────────────────────────────────────────────
//!
//! It does not navigate. It EMITS — one event carrying a view id — and the frontend listens and
//! calls the same navigation function its rail, its command palette and its bare number keys
//! call. That is the whole reason the payload is a view id rather than a position or a route:
//! the shell knows the names of the places, and the client knows what going to one means.
//!
//! The alternative — the shell driving the webview's location — would be a second implementation
//! of routing, in a language that cannot see the client's own rules about where a view lives.

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// The event a chosen navigation item emits. The frontend's `native.ts` listens for this name.
pub const MENU_NAVIGATE_EVENT: &str = "menu:navigate";

/// What a navigation item's id starts with, so one prefix test tells them from every other item.
pub const NAVIGATE_PREFIX: &str = "view:";

/// The navigable places, in menu order — id, label, accelerator.
///
/// FIVE, and the same five the client's rail lists first: the three streams, the Screener and the
/// triage piles. Search has its own key, Settings is not somewhere anybody flicks to, and tags
/// are the user's own and change while the app is open — a menu rebuilt from them would be a
/// menu that moves under the pointer.
///
/// The ids are the frontend's route names. They are written down in two languages, here and in
/// `src/native.ts`, because a Rust binary and a TypeScript bundle share no artifact to import
/// one from; what keeps them in step is that the frontend REFUSES a payload it does not
/// recognise, so a name that drifts is an item that does nothing rather than an item that lands
/// somewhere wrong.
#[cfg(feature = "local-engine")]
pub const VIEWS: [(&str, &str, &str); 5] = [
    ("ohbox", "Ohbox", "CmdOrCtrl+1"),
    ("reads", "Reads", "CmdOrCtrl+2"),
    ("receipts", "Receipts", "CmdOrCtrl+3"),
    ("screener", "Screener", "CmdOrCtrl+4"),
    ("triage", "Answer Later", "CmdOrCtrl+5"),
];

/// The view a menu id names, or `None` for every other item in the bar.
///
/// Split out from the handler so the rule can be tested without starting a windowing system. It
/// is deliberately a prefix test and not a list membership test: the ids are composed from
/// [`VIEWS`] at build time, and a second enumeration here would be a second place for the list to
/// be wrong.
pub fn navigate_target(id: &str) -> Option<&str> {
    id.strip_prefix(NAVIGATE_PREFIX).filter(|view| !view.is_empty())
}

/// Install the menu, and route the items this module owns.
///
/// Called from `main.rs` in EVERY build. `on_menu_event` appends rather than replaces, so this
/// handler and the updater's coexist; `setup` does not, which is why this is the only file that
/// installs a menu.
pub fn attach<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .on_menu_event(|app, event| {
            if let Some(view) = navigate_target(event.id().as_ref()) {
                // A failed emit is not worth taking the app down for: the window may be closing,
                // and the cost is one menu item that did not navigate.
                let _ = app.emit(MENU_NAVIGATE_EVENT, view);
            }
        })
        .setup(|app| {
            install(app.handle())?;
            Ok(())
        })
}

/// Build and install the bar.
fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let check_item =
        MenuItemBuilder::with_id(crate::updater::CHECK_FOR_UPDATES_ID, "Check for Updates…")
            .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "ohmail")
        .item(&check_item)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // The system's own editing items. Nothing here is a command of ours and nothing reaches the
    // webview as one — the platform applies them to whatever has focus, which is the page.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let menu = MenuBuilder::new(app).item(&app_menu).item(&edit_menu);

    // Shadowed rather than mutated, so the default build declares no `mut` it never uses — the
    // View submenu exists only where a window is permitted to hear about a chosen item.
    #[cfg(feature = "local-engine")]
    let menu = {
        let mut view = SubmenuBuilder::new(app, "View");
        for (id, label, accelerator) in VIEWS {
            let item = MenuItemBuilder::with_id(format!("{NAVIGATE_PREFIX}{id}"), label)
                .accelerator(accelerator)
                .build(app)?;
            view = view.item(&item);
        }
        menu.item(&view.build()?)
    };

    app.set_menu(menu.build()?)?;
    Ok(())
}

#[cfg(test)]
#[path = "menu_tests.rs"]
mod tests;
