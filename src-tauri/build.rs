fn main() {
    for name in [
        "GITTY_GITHUB_CLIENT_ID",
        "GITTY_GITLAB_CLIENT_ID",
        "GITTY_AZURE_CLIENT_ID",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    // Icons are embedded at compile time; without this, edited icons never trigger a rebuild.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
