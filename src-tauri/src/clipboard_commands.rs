//! The OS clipboard, reached natively.
//!
//! The renderer first used `navigator.clipboard`, which the WebView refuses in ordinary
//! situations — the document must be focused and the origin trusted, and a refusal arrives as a
//! rejected promise, so a copy that never happened looked exactly like one that did. Going
//! through the OS removes the permission surface entirely and works the same on Windows and
//! macOS. Errors are returned, never swallowed, so a failure can be shown.

use arboard::Clipboard;

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
    let buffer: image::RgbaImage = image::ImageBuffer::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| "clipboard image had an unexpected size".to_string())?;

    let directory = std::env::temp_dir().join("talkak-clipboard");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the image directory: {error}"))?;
    // Named by content time so repeated pastes of the same screenshot do not pile up unbounded,
    // while two different screenshots never collide.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let path = directory.join(format!("clipboard-{stamp}.png"));
    buffer
        .save(&path)
        .map_err(|error| format!("could not save the image: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
