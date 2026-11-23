//! Colour themes: the terminal's own palette, plus ports of the desktop app's built-in themes.
use ratatui::style::Color;
use std::{cell::Cell, sync::OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Theme {
    pub id: &'static str,
    pub name: &'static str,
    /// Painted behind everything; `None` keeps the terminal's own background.
    pub bg: Option<Color>,
    pub text: Color,
    pub on_accent: Color,
    pub accent: Color,
    pub muted: Color,
    pub faint: Color,
    pub border: Color,
    pub select: Color,
    pub bar: Color,
    pub green: Color,
    pub red: Color,
    pub yellow: Color,
    pub gold: Color,
    pub purple: Color,
    pub cyan: Color,
    pub remote: Color,
    pub add_bg: Color,
    pub del_bg: Color,
    pub add_word: Color,
    pub del_word: Color,
    pub hunk_bg: Color,
    pub lanes: [Color; 7],
}

// 256-colour indices so terminals without truecolor still match.
const TERMINAL: Theme = {
    use Color::Indexed as I;
    Theme {
        id: "terminal",
        name: "Terminal",
        bg: None,
        text: Color::Reset,
        on_accent: Color::Black,
        accent: I(75),
        muted: I(245),
        faint: I(240),
        border: I(238),
        select: I(236),
        bar: I(235),
        green: I(114),
        red: I(204),
        yellow: I(179),
        gold: I(137),
        purple: I(141),
        cyan: I(80),
        remote: I(174),
        add_bg: I(22),
        del_bg: I(52),
        add_word: I(28),
        del_word: I(88),
        hunk_bg: I(235),
        lanes: [I(75), I(176), I(114), I(179), I(80), I(204), I(141)],
    }
};

/// Generated from `BUILTIN_THEMES` in `src/model/themes.ts`, in this order: bg, chrome, subtle,
/// borderStrong, text, secondary, muted, accent, buttonForeground, selected, green, greenWash,
/// red, redWash, graphLane1..7.
const DESKTOP: [(&str, &str, [u32; 21]); 8] = [
    (
        "gitty-dark",
        "Gitty Dark",
        [
            0x141416, 0x0e0e10, 0x212125, 0x3f3f46, 0xededef, 0xb4b4bc, 0x8f8f99, 0xf07a3d,
            0x1a0c04, 0x40271a, 0x86d19a, 0x1a2e21, 0xfb7c93, 0x3a1d25, 0x6ea8f0, 0x5cc7b5,
            0xb39cf5, 0xf07ab0, 0xe6c166, 0x95d17e, 0x5fc4dc,
        ],
    ),
    (
        "gitty-light",
        "Gitty Light",
        [
            0xfafafa, 0xf3f3f4, 0xeeeef0, 0xc6c6cc, 0x18181b, 0x4f4f57, 0x62626a, 0xc2410c,
            0xffffff, 0xf9e1d4, 0x23704a, 0xe0f0e5, 0xbe123c, 0xfce4e8, 0x2563a8, 0x0f7a6e,
            0x6d4fc2, 0xb42359, 0x92660a, 0x3f7d2a, 0x0e7490,
        ],
    ),
    (
        "gruvbox-dark",
        "Gruvbox Dark",
        [
            0x282828, 0x1d2021, 0x343330, 0x635e51, 0xebdbb2, 0xbdae93, 0xbdae93, 0x8ec07c,
            0x282828, 0x3c4639, 0xb8bb26, 0x3b3b28, 0xfb4934, 0x432c2a, 0x8ec07c, 0xfb4934,
            0xb8bb26, 0xf07ab0, 0xe6c166, 0x95d17e, 0x5fc4dc,
        ],
    ),
    (
        "gruvbox-light",
        "Gruvbox Light",
        [
            0xfbf1c7, 0xebdbb2, 0xf0e6be, 0xc2ba9b, 0x3c3836, 0x665c54, 0x665c54, 0x076678,
            0xfbf1c7, 0xcad5b7, 0x427b58, 0xe3e2b9, 0x9d0006, 0xefd2ae, 0x076678, 0x9d0006,
            0x427b58, 0xb42359, 0x92660a, 0x3f7d2a, 0x0e7490,
        ],
    ),
    (
        "dracula",
        "Dracula",
        [
            0x282a36, 0x21222c, 0x343641, 0x66686e, 0xf8f8f2, 0xbfc2d5, 0xbfc2d5, 0xbd93f9,
            0x282a36, 0x463f5d, 0x50fa7b, 0x2d453f, 0xff5555, 0x44303a, 0xbd93f9, 0xff5555,
            0x50fa7b, 0xf07ab0, 0xe6c166, 0x95d17e, 0x5fc4dc,
        ],
    ),
    (
        "nord",
        "Nord",
        [
            0x2e3440, 0x272d38, 0x393f4b, 0x676c76, 0xeceff4, 0xd8dee9, 0xd8dee9, 0x88c0d0,
            0x2e3440, 0x40505d, 0xa3be8c, 0x3d464a, 0xbf616a, 0x413a45, 0x88c0d0, 0xbf616a,
            0xa3be8c, 0xf07ab0, 0xe6c166, 0x95d17e, 0x5fc4dc,
        ],
    ),
    (
        "catppuccin-mocha",
        "Catppuccin Mocha",
        [
            0x1e1e2e, 0x181825, 0x29293a, 0x535569, 0xcdd6f4, 0xbac2de, 0xbac2de, 0xcba6f7,
            0x1e1e2e, 0x413956, 0xa6e3a1, 0x30383d, 0xf38ba8, 0x3a2c3e, 0xcba6f7, 0xf38ba8,
            0xa6e3a1, 0xf07ab0, 0xe6c166, 0x95d17e, 0x5fc4dc,
        ],
    ),
    (
        "catppuccin-latte",
        "Catppuccin Latte",
        [
            0xeff1f5, 0xe6e9ef, 0xe5e7ed, 0xbec0cb, 0x4c4f69, 0x5c5f77, 0x5c5f77, 0x8839ef,
            0xeff1f5, 0xdaccf4, 0x40722f, 0xd8e0db, 0xd20f39, 0xebd4dd, 0x8839ef, 0xd20f39,
            0x40722f, 0xb42359, 0x92660a, 0x3f7d2a, 0x0e7490,
        ],
    ),
];

pub(super) fn truecolor() -> bool {
    static TRUECOLOR: OnceLock<bool> = OnceLock::new();
    *TRUECOLOR.get_or_init(|| {
        std::env::var("COLORTERM").is_ok_and(|v| matches!(v.as_str(), "truecolor" | "24bit"))
    })
}

/// `weight` of `a` over `b`, per channel.
fn mix(a: u32, b: u32, weight: f32) -> u32 {
    [16, 8, 0].iter().fold(0, |out, shift| {
        let (x, y) = ((a >> shift & 0xff) as f32, (b >> shift & 0xff) as f32);
        out | ((x * weight + y * (1.0 - weight)).round() as u32) << shift
    })
}

/// The closest xterm 256-colour cube or grey entry.
fn indexed(hex: u32) -> u8 {
    const STEPS: [i32; 6] = [0, 95, 135, 175, 215, 255];
    let rgb = [
        (hex >> 16) as i32 & 0xff,
        (hex >> 8) as i32 & 0xff,
        hex as i32 & 0xff,
    ];
    let level = |v: i32| match v {
        0..48 => 0,
        48..115 => 1,
        _ => ((v - 35) / 40) as usize,
    };
    let cube = rgb.map(level);
    let gray = ((rgb.iter().sum::<i32>() / 3 - 3).max(0) / 10).min(23);
    let distance = |c: [i32; 3]| -> i32 { (0..3).map(|i| (c[i] - rgb[i]).pow(2)).sum() };
    let g = 8 + 10 * gray;
    if distance([g, g, g]) < distance(cube.map(|l| STEPS[l])) {
        232 + gray as u8
    } else {
        16 + (36 * cube[0] + 6 * cube[1] + cube[2]) as u8
    }
}

fn desktop(id: &'static str, name: &'static str, c: [u32; 21], truecolor: bool) -> Theme {
    let [bg, chrome, subtle, border, text, secondary, muted, accent, on_accent, selected, green, green_wash, red, red_wash, l1, l2, l3, l4, l5, l6, l7] =
        c;
    let col = |hex: u32| {
        if truecolor {
            Color::Rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
        } else {
            Color::Indexed(indexed(hex))
        }
    };
    Theme {
        id,
        name,
        bg: Some(col(bg)),
        text: col(text),
        on_accent: col(on_accent),
        accent: col(accent),
        muted: col(secondary),
        faint: col(mix(muted, bg, 0.7)),
        border: col(border),
        select: col(selected),
        bar: col(chrome),
        green: col(green),
        red: col(red),
        yellow: col(l5),
        gold: col(mix(l5, muted, 0.6)),
        purple: col(l3),
        cyan: col(l7),
        remote: col(l4),
        add_bg: col(green_wash),
        del_bg: col(red_wash),
        add_word: col(mix(green, bg, 0.32)),
        del_word: col(mix(red, bg, 0.32)),
        hunk_bg: col(subtle),
        lanes: [l1, l2, l3, l4, l5, l6, l7].map(col),
    }
}

pub(super) fn themes() -> &'static [Theme] {
    static THEMES: OnceLock<Vec<Theme>> = OnceLock::new();
    THEMES.get_or_init(|| {
        let truecolor = truecolor();
        std::iter::once(TERMINAL)
            .chain(
                DESKTOP
                    .iter()
                    .map(|&(id, name, c)| desktop(id, name, c, truecolor)),
            )
            .collect()
    })
}

thread_local! {
    static CURRENT: Cell<Theme> = const { Cell::new(TERMINAL) };
}

/// The theme of the frame being drawn.
pub(super) fn t() -> Theme {
    CURRENT.get()
}

pub(super) fn set(index: usize) {
    CURRENT.set(themes().get(index).copied().unwrap_or(TERMINAL));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgb_maps_to_the_nearest_256_colour() {
        assert_eq!(indexed(0x000000), 16);
        assert_eq!(indexed(0xffffff), 231);
        assert_eq!(indexed(0x808080), 244);
        assert_eq!(indexed(0xff0000), 196);
        assert_eq!(indexed(0x5fafff), 75);
        assert_eq!(mix(0xffffff, 0x000000, 0.5), 0x808080);
    }

    #[test]
    fn other_themes_have_a_background() {
        assert!(themes()
            .iter()
            .all(|t| t.id == "terminal" || t.bg.is_some()));
    }
}
