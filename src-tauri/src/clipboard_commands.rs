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
