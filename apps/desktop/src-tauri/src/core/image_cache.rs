//! The session image cache (2026-10-16).
//!
//! A browser screenshot, a generated image, a read file — the tool result's `READ_IMAGE` marker
//! names a path *in the workspace*, and the transcript keeps only that path. When the workspace
//! copy is later cleaned (revert, git clean, a new run), a replayed transcript's inline preview
//! had nothing to load and silently vanished. This cache is the second copy: the agent loop
//! deposits the image bytes here at marker time (content-addressed, so replays and re-runs
//! dedupe), and the UI falls back to it when the workspace file is gone.
//!
//! It lives under `{app_data_dir}/image-cache/` — outside every workspace sandbox on purpose:
//! the cache's job is to outlive workspace changes. The directory is capped (oldest evicted
//! first) so years of screenshots cannot quietly eat the disk.

use std::io::Read as _;
use std::path::PathBuf;

const CACHE_DIR_NAME: &str = "image-cache";
/// 200 MB of 8 MB-capped images is ~25 captures; enough history to be useful, small enough
/// that the cap is real.
const CACHE_CAP_BYTES: u64 = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

pub fn cache_dir(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join(CACHE_DIR_NAME)
}

fn ext_for(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

/// Store one image. Returns the cache file's *name* (not the path) — the receipt carries the
/// name and the read command takes it, so the UI never needs to know where the cache lives.
/// Content-addressed: the same bytes always land on the same name, so a replayed transcript
/// finds its image even after the cache dir was partially evicted.
pub fn write(app_data_dir: &std::path::Path, media_type: &str, base64: &str) -> Result<String, String> {
    let ext = ext_for(media_type)
        .ok_or_else(|| format!("\"{media_type}\" is not an image type the cache stores"))?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("the image was not valid base64: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("the image is over the 8 MB image cap".into());
    }
    let dir = cache_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create the image cache: {e}"))?;
    let name = format!("{}.{ext}", hash_of(&bytes));
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::write(&path, &bytes).map_err(|e| format!("cannot write the cached image: {e}"))?;
    }
    enforce_cap(&dir);
    Ok(name)
}

/// Read one cached image back as the same `READ_IMAGE` marker the workspace tools produce, so
/// the UI's parser stays single-shaped. `name` is validated: a name is `{hex}.{ext}`, nothing
/// that could point outside the cache dir.
pub fn read(app_data_dir: &std::path::Path, name: &str) -> Result<String, String> {
    let ok_name = !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.rsplit('.').next().is_some();
    if !ok_name {
        return Err(format!("\"{name}\" is not a cache image name"));
    }
    let path = cache_dir(app_data_dir).join(name);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| format!("\"{name}\" has no extension"))?;
    let media = match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return Err(format!("\"{name}\" is not a stored image type")),
    };
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|_| format!("no cached image named \"{name}\" — it may have been evicted"))?;
    use base64::Engine as _;
    Ok(format!(
        "READ_IMAGE:{media};base64,{}\npath: (cache) {name}\nbytes: {}",
        base64::engine::general_purpose::STANDARD.encode(&bytes),
        bytes.len()
    ))
}

/// Keep the directory under its cap, oldest first. Best-effort: an eviction failure is not
/// worth failing the write that triggered it.
fn enforce_cap(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf, u64)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                e.path(),
                meta.len(),
            ))
        })
        .collect();
    let total: u64 = files.iter().map(|(_, _, len)| *len).sum();
    if total <= CACHE_CAP_BYTES {
        return;
    }
    files.sort_by_key(|(t, _, _)| *t);
    let mut total = total;
    for (_, path, len) in files {
        if total <= CACHE_CAP_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

fn hash_of(bytes: &[u8]) -> String {
    use std::hash::Hasher;
    let mut h = std::hash::DefaultHasher::new();
    h.write(bytes);
    // The std hasher's u64 is plenty for a dedupe cache; a collision overwrites one screenshot,
    // and the workspace file remains the primary source either way.
    format!("{:016x}", h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aiprovider-imgcache-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn write_is_content_addressed_and_read_returns_the_marker() {
        let dir = tmp_dir("roundtrip");
        let name = write(&dir, "image/png", PNG_B64).unwrap();
        assert!(name.ends_with(".png"), "the name carries the type: {name}");
        assert_eq!(write(&dir, "image/png", PNG_B64).unwrap(), name, "same bytes, same name");

        let marker = read(&dir, &name).unwrap();
        assert!(marker.starts_with("READ_IMAGE:image/png;base64,"), "got: {marker}");
        assert!(marker.contains(&format!("path: (cache) {name}")));

        let miss = read(&dir, "0000000000000000.png");
        assert!(miss.is_err(), "an absent name must not read");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_refuses_names_that_leave_the_cache_dir() {
        let dir = tmp_dir("escape");
        assert!(read(&dir, "../escape.png").is_err());
        assert!(read(&dir, "sub/dir.png").is_err());
        assert!(read(&dir, "").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_image_types_and_bad_base64_are_refused() {
        let dir = tmp_dir("refuse");
        assert!(write(&dir, "text/plain", "aGk=").is_err());
        assert!(write(&dir, "image/png", "!!!not base64!!!").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
