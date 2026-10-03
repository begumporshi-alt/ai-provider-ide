fn main() {
    // `CARGO_FEATURE_<NAME>` is the documented way for a build script to see the package's
    // enabled features. Gating the *call* rather than making `tauri-build` optional keeps this
    // simple, and it is what stops `cargo build --bin aiproviderd --no-default-features` from
    // running Tauri's codegen — the point being that build must not need Tauri, or WebKitGTK on
    // Linux. `tauri-build` itself is a pure-Rust build helper and links no system libraries.
    if std::env::var_os("CARGO_FEATURE_APP").is_some() {
        tauri_build::build()
    }
    emit_build_identity();
}

/// Bake the identity of this build into the binary.
///
/// `CARGO_PKG_VERSION` cannot tell a stale companion binary from a fresh one — both say `1.2.0` —
/// so the discriminator has to be something that moves when the sources do. The commit is one such
/// thing; a fingerprint of the Rust sources is the other, and it is the one that matters while
/// working, because rebuilding one binary and not the other from a *dirty* tree still yields two
/// different fingerprints.
///
/// This is what lets the app say "the gateway answering you is older code", which is otherwise
/// invisible: a stale `aiproviderd` answers every request normally, with no error and no warning.
fn emit_build_identity() {
    let manifest = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let repo = manifest.join("../../..");

    let commit = std::process::Command::new("git")
        .args(["-C", &repo.to_string_lossy(), "rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=AIP_BUILD_COMMIT={commit}");

    let fingerprint = source_fingerprint(&manifest.join("src"));
    println!("cargo:rustc-env=AIP_SOURCE_FP={fingerprint:016x}");

    // Re-run when the sources or the checked-out commit move. Without this the baked value would
    // outlive a commit, and two genuinely different builds could carry the same identity — a
    // false "up to date", which is the one outcome this exists to prevent.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", repo.join(".git/HEAD").display());
}

/// FNV-1a over the relative path, byte length and mtime of every `.rs` file under `src`.
///
/// Content hashing would be stricter, but path/length/mtime is what cargo itself uses to decide
/// whether to rebuild, so the fingerprint moves exactly when cargo would rebuild — which is the
/// property being asked for. Paths are relative to `src` so the value depends on the sources alone
/// and not on where the checkout happens to live.
fn source_fingerprint(src: &std::path::Path) -> u64 {
    let mut entries: Vec<(String, u64, u64)> = Vec::new();
    collect_rs(src, src, &mut entries);
    entries.sort();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (name, len, mtime) in &entries {
        eat(&mut hash, name.as_bytes());
        eat(&mut hash, &len.to_le_bytes());
        eat(&mut hash, &mtime.to_le_bytes());
    }
    hash
}

fn collect_rs(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, u64, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs(root, &path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos() as u64);
            let name = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
            out.push((name, meta.len(), mtime));
        }
    }
}

fn eat(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
}
