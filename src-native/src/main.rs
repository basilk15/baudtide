// The backend is intentionally shared with the Tauri host during the migration.
// `src-tauri` enables `tauri-app`; this standalone crate does not, selecting the
// NDJSON sidecar host at the bottom of the shared module.
#[path = "../../src-tauri/src/main.rs"]
mod backend;

fn main() {
    backend::sidecar_entry();
}
