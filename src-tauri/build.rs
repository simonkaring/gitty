fn main() {
    // Icons are embedded at compile time; without this, edited icons never trigger a rebuild.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
