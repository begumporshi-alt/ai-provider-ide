//! The identity of the build this process is running.
//!
//! One crate produces two binaries — the app and the headless `aiproviderd` — and only one of them
//! serves the gateway. Rebuilding one and not the other leaves a gateway running older code that
//! answers every request normally: no error, no warning, just the old behaviour. That is
//! indistinguishable from "the change did nothing", which is how a built, tested, green change
//! looks broken on first run.
//!
//! `CARGO_PKG_VERSION` cannot settle it — both binaries say `1.2.0`. What can is the source
//! fingerprint baked in at compile time (`build.rs`), because it moves whenever the sources do.

/// Short commit this binary was compiled from, or `unknown` when git was not available.
pub const COMMIT: &str = match option_env!("AIP_BUILD_COMMIT") {
    Some(value) => value,
    None => "unknown",
};

/// Fingerprint of the Rust sources at compile time. Two binaries built from the same sources share
/// it even on a dirty tree; a binary left behind by an earlier edit does not.
pub const SOURCE_FP: &str = match option_env!("AIP_SOURCE_FP") {
    Some(value) => value,
    None => "unknown",
};

/// Whether a process reporting `other` was built from different sources than this one.
pub fn is_stale(other: &str) -> bool {
    differs(SOURCE_FP, other)
}

/// `unknown` on either side is not evidence of a mismatch.
///
/// A binary too old to carry a fingerprint cannot be compared, and calling that "different" would
/// fire the warning on every build until it is rebuilt — which is how a diagnostic gets trained
/// out of the person reading it. Unknown stays quiet; the two known values are what get compared.
fn differs(this: &str, other: &str) -> bool {
    this != "unknown" && other != "unknown" && this != other
}

#[cfg(test)]
mod build_id_tests {
    use super::*;

    #[test]
    fn unknown_never_reads_as_a_mismatch() {
        assert!(!differs("unknown", "abc"), "an unidentifiable other is not a mismatch");
        assert!(!differs("abc", "unknown"), "an unidentifiable self is not a mismatch");
        assert!(!differs("unknown", "unknown"));
    }

    #[test]
    fn two_known_different_fingerprints_are_stale() {
        assert!(differs("abc", "def"));
    }

    #[test]
    fn the_same_fingerprint_is_not_stale() {
        assert!(!differs("abc", "abc"));
    }

    /// The real values, so a missing `cargo:rustc-env` in `build.rs` surfaces here rather than as
    /// a Control screen that has silently stopped being able to tell.
    #[test]
    fn this_binary_carries_a_usable_identity() {
        assert_ne!(SOURCE_FP, "unknown", "build.rs did not bake a fingerprint");
        assert!(!is_stale(SOURCE_FP), "a build must not report itself as stale");
    }
}
