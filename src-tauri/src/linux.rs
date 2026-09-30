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

/// Detects the GTK window and titlebar header bar for the given WebviewWindow,
/// clearing hardcoded button layouts to adhere to desktop environment preferences.
pub fn configure_linux_window(window: &tauri::WebviewWindow) {
    if let Ok(gtk_window) = window.gtk_window() {
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
}
