// THE COMMANDS THE WINDOW MAY CALL — declared here, or no capability can grant them.
//
// Tauri resolves a capability against a manifest built at compile time, and a command that is not
// named here has no `allow-…` permission for anything to reference. That makes this list the real
// boundary rather than the capability files: it is not possible to grant what was never declared.
//
// It is conditional on the same feature that compiles the engine's lifetime in, and the two halves
// have to agree. With the feature off this declares nothing, `main.rs` registers no handler and no
// capability is added, so the published shell's window can still call nothing at all — a property
// of the binary rather than of a list somebody could edit. A build script reads a feature as
// `CARGO_FEATURE_<NAME>`, upper-cased with hyphens turned into underscores.
fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var_os("CARGO_FEATURE_LOCAL_ENGINE").is_some() {
        attributes = attributes.app_manifest(
            tauri_build::AppManifest::new().commands(&["engine_status", "engine_request"]),
        );
    }
    tauri_build::try_build(attributes).expect("ohmail: failed to build the Tauri context");
}
