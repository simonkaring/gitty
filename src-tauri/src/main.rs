#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mode = std::env::args().nth(1);
    let direct_askpass = mode.as_deref().is_some_and(|value| value != "editor")
        && std::env::var_os("GITTY_ASKPASS_PORT").is_some()
        && std::env::var_os("GITTY_ASKPASS_TOKEN").is_some();
    if mode.as_deref() == Some("askpass") || direct_askpass {
        std::process::exit(if run_askpass().is_ok() { 0 } else { 1 });
    }
    if mode.as_deref() == Some("editor") {
        std::process::exit(if run_editor().is_ok() { 0 } else { 1 });
    }

    gitty_lib::run();
}

fn run_askpass() -> std::io::Result<()> {
    gitty_core::helper::askpass_from_env(&std::env::args().skip(1).collect::<Vec<_>>())
}

fn run_editor() -> std::io::Result<()> {
    gitty_core::helper::editor_from_env(&std::env::args().skip(1).collect::<Vec<_>>())
}
