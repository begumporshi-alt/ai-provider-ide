//! Crate root.
//!
//! Split into [`core`] (Tauri-independent) and [`tauri`] (desktop glue) so the gateway can also
//! be built as a standalone service — see `src/bin/aiproviderd.rs`.
//!
//! The `app` feature (on by default) *is* the desktop application. With it off, `tauri` is not in
//! the dependency graph at all and only the service builds:
//! `cargo build --bin aiproviderd --no-default-features`.

pub mod core;

#[cfg(feature = "app")]
pub mod tauri;

#[cfg(feature = "app")]
pub use crate::tauri::app::run;
