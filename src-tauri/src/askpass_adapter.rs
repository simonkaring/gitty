use gitty_core::askpass::{self, AskpassPromptPayload, AskpassRegistry};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub fn init(app: AppHandle) -> std::io::Result<()> {
    let (listener, registry) = askpass::bind()?;
    app.manage(registry.clone());
    let prompt_app = app.clone();
    let expired_app = app;
    std::thread::spawn(move || {
        askpass::serve(
            listener,
            registry,
            move |request_id, prompt, context| {
                prompt_app
                    .emit(
                        "git_askpass_prompt",
                        AskpassPromptPayload {
                            request_id,
                            prompt,
                            context,
                        },
                    )
                    .map_err(|_| ())
            },
            move |request_id| {
                let _ = expired_app.emit("git_askpass_expired", request_id);
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub fn repository_provide_password(
    registry: State<'_, Arc<AskpassRegistry>>,
    request_id: usize,
    password: Option<String>,
) -> Result<(), String> {
    registry.reply(request_id, password)
}
