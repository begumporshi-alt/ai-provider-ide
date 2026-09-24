//! Tauri-independent half of the crate: the HTTP gateway, the SQLite store, the keychain
//! vault, and the store helpers they call.
//!
//! Split for the headless service (`src/bin/aiproviderd.rs`). Two rules, and they are different
//! strengths:
//!
//! 1. **No `core` module may name `crate::tauri::*`** in code that is not `cfg(test)`.
//! 2. **Every mention of the `tauri` *crate* is behind `#[cfg(feature = "app")]`.** This is the
//!    stronger claim and it is the one that makes the dependency split real: with
//!    `--no-default-features` the `tauri` runtime crate, `wry` and WebKitGTK leave the graph
//!    entirely, so `cargo build --bin aiproviderd --no-default-features` compiles no Tauri at
//!    all. The mentions are the 28 `#[tauri::command]` attributes in `persist`, its
//!    `use tauri::State;`, `egress::stream`'s `tauri::ipc::Channel`, and the app-only helpers
//!    those wrappers reach — gated so that "the service is Tauri-free" is a property of the
//!    build, not just of the source.
//!
//! `Cargo.toml` declares `default = ["app"]` and makes `tauri`/`tauri-plugin-opener` optional, so
//! a plain `cargo build`/`test`/`clippy` behaves exactly as before. `tauri-build` is the one
//! exception that cannot be gated: Cargo has no optional build-dependencies, so it is compiled
//! even when the feature is off. `build.rs` reads `CARGO_FEATURE_APP` and skips
//! `tauri_build::build()` in that case, which is what keeps the build script itself Tauri-free.
//!
//! One `cfg(test)` edge points back at `tauri/`: `gateway_tests` constructs a
//! `gateway_cmds::GatewayState` in five functions, each carrying the same gate. That is fine for
//! `cargo build --bin aiproviderd` (tests are not compiled) and harmless for `cargo test` (the
//! whole crate is), and it is recorded rather than hidden.

pub mod adapter;
pub mod adapter_runtime;
pub mod assistant_stream;
pub mod bridge_policy;
pub mod capture;
pub mod code_adapter;
pub mod compress;
pub mod context;
pub mod crash_report;
pub mod egress;
pub mod egress_port;
pub mod engine;
pub mod error;
pub mod gateway;
pub mod gateway_normalizer;
pub mod http_port;
pub mod injection_log;
pub mod interpreter;
pub mod js_host;
pub mod jsonpath;
pub mod ledger;
pub mod limiter;
pub mod manifest;
pub mod manifest_view;
pub mod memory;
pub mod modality;
pub mod orchestrator;
pub mod persist;
pub mod planner;
pub mod pricing;
pub mod router;
pub mod router_bridge;
pub mod sandbox;
pub mod skills;
pub mod store;
pub mod template;
pub mod tool_registry;
pub mod tool_wire;
pub mod tools;
pub mod usage;
pub mod vault;
