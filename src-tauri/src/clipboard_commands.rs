//! The OS clipboard, reached natively.
//!
//! The renderer first used `navigator.clipboard`, which the WebView refuses in ordinary
//! situations — the document must be focused and the origin trusted, and a refusal arrives as a
//! rejected promise, so a copy that never happened looked exactly like one that did. Going
//! through the OS removes the permission surface entirely and works the same on Windows and
//! macOS. Errors are returned, never swallowed, so a failure can be shown.

use arboard::Clipboard;
use std::time::{Duration, SystemTime};

fn clipboard() -> Result<Clipboard, String> {
    Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))
}

#[tauri::command]
pub(crate) fn clipboard_write_text(text: String) -> Result<(), String> {
    clipboard()?
        .set_text(text)
        .map_err(|error| format!("could not copy: {error}"))
}

#[tauri::command]
pub(crate) fn clipboard_read_text() -> Result<String, String> {
    match clipboard()?.get_text() {
        Ok(text) => Ok(text),
        // An empty clipboard, or one holding an image, is not an error to report at a keystroke.
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(error) => Err(format!("could not paste: {error}")),
    }
}

/// A screenshot on the clipboard, written to a file and answered as a path.
///
/// A PTY carries bytes, so an image cannot be pasted into a terminal as an image — and an agent
/// CLI running inside one cannot reach the clipboard the way it would in its own window. What it
/// can do is read a file. Pasting the path is the thing that actually works, and it is what the
/// agent wanted anyway. Returns None when the clipboard holds no image, which is the common case
/// and not an error.
#[tauri::command]
pub(crate) fn clipboard_read_image_path() -> Result<Option<String>, String> {
    let image = match clipboard()?.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(error) => return Err(format!("could not read the image: {error}")),
    };
    let width = u32::try_from(image.width).map_err(|_| "image is too wide".to_string())?;
    let height = u32::try_from(image.height).map_err(|_| "image is too tall".to_string())?;
    let buffer: image::RgbaImage =
        image::ImageBuffer::from_raw(width, height, image.bytes.into_owned())
            .ok_or_else(|| "clipboard image had an unexpected size".to_string())?;

    let directory = std::env::temp_dir().join("talkak-clipboard");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the image directory: {error}"))?;

    // Named by CONTENT, so pasting the same screenshot into three panes writes one file instead of
    // three. The previous name was the wall clock at paste time, which made every paste a new
    // multi-megabyte file — and the comment above it claimed the opposite.
    let path = directory.join(format!("clipboard-{}.png", digest(buffer.as_raw())));
    if !path.exists() {
        buffer
            .save(&path)
            .map_err(|error| format!("could not save the image: {error}"))?;
    }
    // Nothing else ever deletes these. The app cannot know when an agent is finished reading one,
    // so age is the only safe signal: a file older than a day belongs to a session that is over.
    prune_older_than(&directory, Duration::from_secs(60 * 60 * 24));
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// A stable name for a block of pixels. Not cryptographic — it only has to keep two different
/// screenshots apart, and `DefaultHasher` is fixed-key, so the same image gets the same name across
/// runs of the same build.
fn digest(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn prune_older_than(directory: &std::path::Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|data| data.modified())
            .map(|modified| {
                now.duration_since(modified)
                    .map(|elapsed| elapsed > age)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if stale {
            // A file another process still holds simply stays; the next paste tries again.
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
