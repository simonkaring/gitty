use gitty_core::editor::{self, EditorPromptPayload, EditorRegistry};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub fn init(app: AppHandle) -> std::io::Result<()> {
    let (listener, registry) = editor::bind()?;
    app.manage(registry.clone());
    let prompt_app = app.clone();
    let expired_app = app;
    std::thread::spawn(move || {
        editor::serve(
            listener,
            registry,
            move |request_id, file_name, content| {
                prompt_app
                    .emit(
                        "editor_prompt",
                        EditorPromptPayload {
                            request_id,
                            file_name,
                            content,
                        },
                    )
                    .map_err(|_| ())
            },
            move |request_id| {
                let _ = expired_app.emit("editor_expired", request_id);
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub fn editor_reply(
    registry: State<'_, Arc<EditorRegistry>>,
    request_id: usize,
    content: Option<String>,
) -> Result<(), String> {
    registry.reply(request_id, content)
}
