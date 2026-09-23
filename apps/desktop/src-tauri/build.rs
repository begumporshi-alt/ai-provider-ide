fn main() {
    // `CARGO_FEATURE_<NAME>` is the documented way for a build script to see the package's
    // enabled features. Gating the *call* rather than making `tauri-build` optional keeps this
    // simple, and it is what stops `cargo build --bin aiproviderd --no-default-features` from
    // running Tauri's codegen — the point being that build must not need Tauri, or WebKitGTK on
    // Linux. `tauri-build` itself is a pure-Rust build helper and links no system libraries.
    if std::env::var_os("CARGO_FEATURE_APP").is_some() {
        tauri_build::build()
    }
}
