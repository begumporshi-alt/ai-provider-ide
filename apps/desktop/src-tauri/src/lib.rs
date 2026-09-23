//! Crate root.
//!
//! Split into [`core`] (Tauri-independent) and [`tauri`] (desktop glue) so the gateway can also
//! be built as a standalone service — see `src/bin/aiproviderd.rs`.

pub mod core;
pub mod tauri;

pub use crate::tauri::app::run;
