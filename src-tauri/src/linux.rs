use gtk::prelude::*;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct WindowButtonLayout(pub Mutex<String>);

/// Read GTK settings on the UI thread and forward desktop preference changes.
pub fn configure_button_layout(app: &tauri::AppHandle) {
    let settings = gtk::Settings::default();
    let layout = settings
        .as_ref()
        .and_then(|s| s.gtk_decoration_layout())
        .map(|layout| layout.to_string())
        .unwrap_or_else(|| ":minimize,maximize,close".into());
    app.manage(WindowButtonLayout(Mutex::new(layout)));
    if let Some(settings) = settings {
        let app = app.clone();
        settings.connect_gtk_decoration_layout_notify(move |settings| {
            let layout = settings
                .gtk_decoration_layout()
                .map(|layout| layout.to_string())
                .unwrap_or_else(|| ":minimize,maximize,close".into());
            *app.state::<WindowButtonLayout>().0.lock().unwrap() = layout.clone();
            let _ = app.emit("window-button-layout-changed", layout);
        });
    }
}

/// Ensures that a FreeDesktop `.desktop` file and hicolor icon exist in the given
/// user data directory (typically `~/.local/share`) if not already installed system-wide.
/// On Wayland (GNOME Shell, Mutter, KDE Plasma), compositors display taskbar/dock icons
/// exclusively by matching the window's `app_id` to an installed `.desktop` entry.
pub fn ensure_desktop_entry_in(
    data_home: &std::path::Path,
    system_installed: bool,
    exe_path: &std::path::Path,
) -> std::io::Result<()> {
    if system_installed {
        return Ok(());
    }

    let icons_dir = data_home.join("icons/hicolor/512x512/apps");
    // A new icon name also invalidates the compositor's cached light artwork.
    let icon_path = icons_dir.join("gitty-dark.png");
    let icon = include_bytes!("../icons/icon.png");
    if std::fs::read(&icon_path).ok().as_deref() != Some(icon.as_slice()) {
        std::fs::create_dir_all(&icons_dir)?;
        std::fs::write(&icon_path, icon)?;
    }

    let apps_dir = data_home.join("applications");
    let desktop_path = apps_dir.join("gitty.desktop");

    std::fs::create_dir_all(&apps_dir)?;
    let desktop_content = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Gitty\n\
         GenericName=Git Client\n\
         Comment=A little clarity for your Git history\n\
         Exec={}\n\
         Icon=gitty-dark\n\
         StartupWMClass=gitty\n\
         Terminal=false\n\
         Categories=Development;RevisionControl;\n",
        exe_path.display()
    );
    if std::fs::read_to_string(&desktop_path).ok().as_deref() != Some(&desktop_content) {
        std::fs::write(desktop_path, desktop_content)?;
    }
    Ok(())
}

/// Dispatches desktop entry and icon registration for the current user environment.
pub fn ensure_desktop_entry() {
    let system_installed = std::path::Path::new("/usr/share/applications/gitty.desktop").exists()
        || std::path::Path::new("/usr/local/share/applications/gitty.desktop").exists();

    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))
        });

    if let Some(data_home) = data_home {
        let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("gitty"));
        let _ = ensure_desktop_entry_in(&data_home, system_installed, &exe);
    }
}

/// Sets application/window icons for the undecorated Linux window.
pub fn configure_linux_window(window: &tauri::WebviewWindow) {
    ensure_desktop_entry();

    if let Ok(gtk_window) = window.gtk_window() {
        gtk_window.set_icon_name(Some("gitty-dark"));
        gtk::Window::set_default_icon_name("gitty-dark");

        if let Ok(pixbuf) = gtk::gdk_pixbuf::Pixbuf::from_read(std::io::Cursor::new(
            include_bytes!("../icons/icon.png"),
        )) {
            gtk_window.set_icon(Some(&pixbuf));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ensure_desktop_entry_behavior() {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_home = temp_dir.path().to_path_buf();
        let fake_exe = std::path::PathBuf::from("/opt/gitty/bin/gitty");

        // 1. If system_installed is true, do not create any user files
        ensure_desktop_entry_in(&data_home, true, &fake_exe).unwrap();
        assert!(!data_home.join("applications/gitty.desktop").exists());
        assert!(!data_home
            .join("icons/hicolor/512x512/apps/gitty-dark.png")
            .exists());

        // 2. If system_installed is false, write icon and desktop entry
        ensure_desktop_entry_in(&data_home, false, &fake_exe).unwrap();
        let desktop_file = data_home.join("applications/gitty.desktop");
        let icon_file = data_home.join("icons/hicolor/512x512/apps/gitty-dark.png");

        assert!(desktop_file.exists());
        assert!(icon_file.exists());

        let content = std::fs::read_to_string(&desktop_file).unwrap();
        assert!(content.contains("Exec=/opt/gitty/bin/gitty"));
        assert!(content.contains("Icon=gitty-dark\n"));
        assert!(content.contains("StartupWMClass=gitty"));

        // 3. Repeated call with same exe does not fail and keeps content
        ensure_desktop_entry_in(&data_home, false, &fake_exe).unwrap();
        let content2 = std::fs::read_to_string(&desktop_file).unwrap();
        assert_eq!(content, content2);

        // Refresh stale icons even when the desktop entry is already current.
        std::fs::write(&icon_file, b"old light icon").unwrap();
        ensure_desktop_entry_in(&data_home, false, &fake_exe).unwrap();
        assert_eq!(
            std::fs::read(&icon_file).unwrap(),
            include_bytes!("../icons/icon.png")
        );

        // Migrate the old icon reference even when Exec has not changed.
        std::fs::write(
            &desktop_file,
            content.replace("Icon=gitty-dark", "Icon=gitty"),
        )
        .unwrap();
        ensure_desktop_entry_in(&data_home, false, &fake_exe).unwrap();
        assert_eq!(std::fs::read_to_string(&desktop_file).unwrap(), content);

        // 4. Call with new exe updates Exec path
        let new_exe = std::path::PathBuf::from("/usr/local/bin/gitty");
        ensure_desktop_entry_in(&data_home, false, &new_exe).unwrap();
        let content3 = std::fs::read_to_string(&desktop_file).unwrap();
        assert!(content3.contains("Exec=/usr/local/bin/gitty"));
    }
}
