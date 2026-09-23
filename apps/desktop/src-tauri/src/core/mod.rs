//! Tauri-independent half of the crate: the HTTP gateway, the SQLite store, the keychain
//! vault, and the store helpers they call.
//!
//! Split for the headless service (`src/bin/aiproviderd.rs`). The rule is **module-level, not
//! crate-level**: nothing here may name `crate::tauri::*`. Importing the `tauri` *crate* is
//! still tolerated and still happens — `persist` carries `#[tauri::command]` handlers and
//! `egress::stream` takes a `tauri::ipc::Channel`, because those annotations sit on functions
//! that are otherwise just store queries. `Cargo.toml` makes `tauri` an unconditional
//! dependency either way, so the binary links it regardless. Removing those *types* from this
//! half is Phase 2 work, not Phase 1.
//!
//! One `cfg(test)` edge does point back at `tauri/`: `gateway_tests` constructs a
//! `gateway_cmds::GatewayState`. That is fine for `cargo build --bin aiproviderd` (tests are
//! not compiled) and harmless for `cargo test` (the whole crate is), and it is recorded rather
//! than hidden.

pub mod capture;
pub mod context;
pub mod crash_report;
pub mod egress;
pub mod error;
pub mod gateway;
pub mod injection_log;
pub mod memory;
pub mod orchestrator;
pub mod persist;
pub mod skills;
pub mod store;
pub mod vault;
