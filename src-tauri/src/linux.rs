use gtk::prelude::*;

/// Recursively searches a widget tree for a `gtk::HeaderBar`.
/// On Wayland, Tao embeds the `HeaderBar` within a `gtk::EventBox` set as the window's titlebar.
pub fn find_header_bar(widget: &gtk::Widget) -> Option<gtk::HeaderBar> {
    if let Ok(hb) = widget.clone().downcast::<gtk::HeaderBar>() {
        return Some(hb);
    }
    if let Ok(container) = widget.clone().downcast::<gtk::Container>() {
        for child in container.children() {
            if let Some(hb) = find_header_bar(&child) {
                return Some(hb);
            }
        }
    }
    None
}

/// Configures the header bar to respect system window button layout.
/// Tao hardcodes `decoration_layout("menu:minimize,maximize,close")` in its Wayland backend,
/// which forces controls to the right side even when the desktop environment specifies
/// left-side buttons (e.g. `close,minimize,maximize:appmenu`).
/// Setting decoration_layout to `None` resets `decoration-layout-set` to false, letting
/// GTK's HeaderBar track the desktop's `gtk-decoration-layout` setting automatically.
pub fn configure_header_bar(header: &gtk::HeaderBar, window: &gtk::ApplicationWindow) {
    header.set_decoration_layout(None);

    let header_weak = header.downgrade();
    window.connect_resizable_notify(move |_| {
        if let Some(h) = header_weak.upgrade() {
            h.set_decoration_layout(None);
        }
    });
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

/// Detects the GTK window and titlebar header bar for the given WebviewWindow,
/// setting application/window icons and clearing hardcoded button layouts
/// to adhere to desktop environment preferences.
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

        if let Some(titlebar) = gtk_window.titlebar() {
            if let Some(header) = find_header_bar(&titlebar) {
                configure_header_bar(&header, &gtk_window);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linux_header_bar_configuration() {
        if gtk::init().is_err() {
            return;
        }

        // 1. Direct HeaderBar lookup
        let hb_direct = gtk::HeaderBar::new();
        assert!(find_header_bar(hb_direct.upcast_ref()).is_some());

        // 2. Nested HeaderBar lookup in EventBox (matching Tao's WlHeader structure)
        let event_box = gtk::EventBox::new();
        let hb_nested = gtk::HeaderBar::new();
        event_box.add(&hb_nested);
        assert!(find_header_bar(event_box.upcast_ref()).is_some());

        // 3. HeaderBar configuration clears hardcoded layout and maintains None on resizable toggle
        let window = gtk::ApplicationWindow::builder().build();
        let test_box = gtk::EventBox::new();
        let hb = gtk::HeaderBar::builder()
            .show_close_button(true)
            .decoration_layout("menu:minimize,maximize,close")
            .build();
        test_box.add(&hb);
        window.set_titlebar(Some(&test_box));

        assert_eq!(
            hb.decoration_layout().as_deref(),
            Some("menu:minimize,maximize,close")
        );
        assert!(hb.is_decoration_layout_set());

        configure_header_bar(&hb, &window);

        // After clearing, decoration_layout should be None and decoration-layout-set false
        assert_eq!(hb.decoration_layout(), None);
        assert!(!hb.is_decoration_layout_set());

        // Triggering resizable notify should keep it None
        window.set_resizable(!window.is_resizable());
        assert_eq!(hb.decoration_layout(), None);
        assert!(!hb.is_decoration_layout_set());
    }

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
        std::fs::write(&desktop_file, content.replace("Icon=gitty-dark", "Icon=gitty")).unwrap();
        ensure_desktop_entry_in(&data_home, false, &fake_exe).unwrap();
        assert_eq!(std::fs::read_to_string(&desktop_file).unwrap(), content);

        // 4. Call with new exe updates Exec path
        let new_exe = std::path::PathBuf::from("/usr/local/bin/gitty");
        ensure_desktop_entry_in(&data_home, false, &new_exe).unwrap();
        let content3 = std::fs::read_to_string(&desktop_file).unwrap();
        assert!(content3.contains("Exec=/usr/local/bin/gitty"));
    }
}
