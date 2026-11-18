//! Rendering only: every function reads `App` and draws; none of them change state.
use super::{Action, App, Confirm, GraphCell, Hit, Prompt, Tone, View, WRITES};
use gitty_core::{
    dto::{CommitDetail, DiffFile, FileDiff, StatusEntry},
    remote::TerminalSync,
};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Clear, Padding, Paragraph, Wrap},
    Frame,
};
use std::cell::Cell;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

// 256-colour indices so terminals without truecolor still match.
const ACCENT: Color = Color::Indexed(75);
const MUTED: Color = Color::Indexed(245);
const FAINT: Color = Color::Indexed(240);
const BORDER: Color = Color::Indexed(238);
const SELECT: Color = Color::Indexed(236);
const BAR: Color = Color::Indexed(235);
const GREEN: Color = Color::Indexed(114);
const RED: Color = Color::Indexed(204);
const YELLOW: Color = Color::Indexed(179);
const GOLD: Color = Color::Indexed(137);
const PURPLE: Color = Color::Indexed(141);
const CYAN: Color = Color::Indexed(80);
const LANES: [Color; 7] = [
    ACCENT,
    Color::Indexed(176),
    GREEN,
    YELLOW,
    CYAN,
    RED,
    PURPLE,
];

/// Escapes control and bidirectional characters from repository-controlled text.
pub(super) fn safe(s: &str) -> String {
    let mut text = String::new();
    for c in s.chars() {
        if c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
            text.extend(c.escape_default());
        } else {
            text.push(c);
        }
    }
    text
}

fn fg(color: Color) -> Style {
    Style::new().fg(color)
}

fn bold(color: Color) -> Style {
    fg(color).add_modifier(Modifier::BOLD)
}

/// Cuts `text` to `width` display columns, marking the cut with an ellipsis.
fn clip(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.into();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = c.width().unwrap_or(0);
        if used + w + 1 > width {
            break;
        }
        used += w;
        out.push(c);
    }
    if width > 0 {
        out.push('…');
    }
    out
}

/// Keeps the end of a path, which is the part that identifies the file.
fn clip_left(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.into();
    }
    let mut tail: Vec<char> = Vec::new();
    let mut used = 1;
    for c in text.chars().rev() {
        let w = c.width().unwrap_or(0);
        if used + w > width {
            break;
        }
        used += w;
        tail.push(c);
    }
    std::iter::once('…').chain(tail.into_iter().rev()).collect()
}

fn pad(width: usize) -> Span<'static> {
    Span::raw(" ".repeat(width))
}

fn ago(timestamp: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let s = (now - timestamp).max(0);
    match s {
        0..60 => "now".into(),
        60..3600 => format!("{}m", s / 60),
        3600..86_400 => format!("{}h", s / 3600),
        86_400..604_800 => format!("{}d", s / 86_400),
        604_800..2_629_800 => format!("{}w", s / 604_800),
        2_629_800..31_557_600 => format!("{}mo", s / 2_629_800),
        _ => format!("{}y", s / 31_557_600),
    }
}

fn spinner() -> &'static str {
    const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let tick = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() / 80);
    FRAMES[(tick % 10) as usize]
}

fn panel(title: impl Into<String>, focused: bool) -> Block<'static> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(fg(if focused { ACCENT } else { BORDER }))
        .title(Line::from(vec![
            Span::raw(" "),
            Span::styled(title.into(), bold(if focused { ACCENT } else { MUTED })),
            Span::raw(" "),
        ]))
        .padding(Padding::horizontal(1))
}

/// Scrolls a list only when the selection nears an edge, so the view does not jump.
fn window(top: &Cell<usize>, selected: usize, len: usize, height: usize) -> usize {
    if height == 0 {
        return 0;
    }
    let margin = (height / 4).min(3);
    let mut start = top.get();
    if selected < start + margin {
        start = selected.saturating_sub(margin);
    } else if selected + margin >= start + height {
        start = selected + margin + 1 - height;
    }
    start = start.min(len.saturating_sub(height));
    top.set(start);
    start
}

/// Places a dimmed backdrop and returns a centred, cleared area for a dialog.
fn modal(frame: &mut Frame, width: u16, height: u16) -> Rect {
    let area = frame.area();
    frame
        .buffer_mut()
        .set_style(area, Style::new().fg(FAINT).remove_modifier(Modifier::BOLD));
    let w = width.min(area.width.saturating_sub(2));
    let h = height.min(area.height.saturating_sub(2));
    let rect = Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    );
    frame.render_widget(Clear, rect);
    rect
}

fn dialog(title: impl Into<String>) -> Block<'static> {
    panel(title, true).padding(Padding::new(2, 2, 1, 0))
}

/// Lays out key hints, tightening the separators and then dropping hints so the row fits.
fn hints(keys: &[(&str, &str)], width: usize) -> Line<'static> {
    let full: usize = keys.iter().map(|(k, l)| k.width() + l.width() + 6).sum();
    let gap = if full <= width { "  ·  " } else { "   " };
    let mut spans = vec![Span::raw(" ")];
    let mut used = 1;
    for (i, (key, label)) in keys.iter().enumerate() {
        let sep = if i > 0 { gap.width() } else { 0 };
        let w = sep + key.width() + 1 + label.width();
        if used + w > width {
            break;
        }
        used += w;
        if i > 0 {
            spans.push(Span::styled(gap, fg(BORDER)));
        }
        spans.push(Span::styled(key.to_string(), bold(ACCENT)));
        spans.push(Span::styled(format!(" {label}"), fg(MUTED)));
    }
    Line::from(spans)
}

fn empty(frame: &mut Frame, area: Rect, text: &str, color: Color) {
    let y = area.y + area.height / 2;
    if area.height > 0 {
        frame.render_widget(
            Paragraph::new(Span::styled(text.to_string(), fg(color))).centered(),
            Rect::new(area.x, y, area.width, 1),
        );
    }
}

/// Records a click target for the frame being drawn.
fn target(app: &App, rect: Rect, hit: Hit) {
    app.hits.borrow_mut().push((rect, hit));
}

pub(super) fn render(frame: &mut Frame, app: &App, prompt: Option<&Prompt>) {
    app.hits.borrow_mut().clear();
    let area = frame.area();
    if area.width < 40 || area.height < 10 {
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled("Gitty needs a larger terminal", bold(ACCENT)),
                Line::styled("at least 40 × 10 · Ctrl-C quits", fg(MUTED)),
            ])
            .centered()
            .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }
    let status = status_line(app);
    let [top, bar, body, note, bottom] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(u16::from(status.is_some())),
        Constraint::Length(1),
    ])
    .areas(area);
    header(frame, top, app);
    toolbar(frame, bar, app);
    let base = match app.view {
        View::Confirm => app.back,
        View::Composer => View::History,
        View::Publish => View::Remote,
        view => view,
    };
    match base {
        View::Files => inspect(frame, body, app),
        View::Working => working(frame, body, app),
        View::Diff => full_diff(frame, body, app),
        View::Remote => sync(frame, body, app),
        _ => history(frame, body, app),
    }
    if let Some(status) = status {
        frame.render_widget(Paragraph::new(status), note);
    }
    frame.render_widget(
        Paragraph::new(footer(app, prompt.is_some(), usize::from(area.width)))
            .style(Style::new().bg(BAR)),
        bottom,
    );
    match app.view {
        View::Composer => composer(frame, app),
        View::Confirm => confirm(frame, app),
        View::Publish => publish(frame, app),
        _ => {}
    }
    if let Some(prompt) = prompt {
        credentials(frame, prompt);
    }
}

fn header(frame: &mut Frame, area: Rect, app: &App) {
    frame.render_widget(Block::new().style(Style::new().bg(BAR)), area);
    let mut left = vec![Span::styled(
        format!(
            " {} ",
            app.state
                .as_ref()
                .map_or("gitty".into(), |s| safe(&s.session.name))
        ),
        Style::new()
            .fg(Color::Black)
            .bg(ACCENT)
            .add_modifier(Modifier::BOLD),
    )];
    if let Some(state) = &app.state {
        left.push(pad(2));
        match state.session.head_ref.as_deref() {
            Some(head) => left.push(Span::styled(
                safe(head.strip_prefix("refs/heads/").unwrap_or(head)),
                bold(GREEN),
            )),
            None => left.push(Span::styled(
                format!(
                    "detached @ {}",
                    state
                        .session
                        .head
                        .as_deref()
                        .map_or("—", |h| &h[..h.len().min(7)])
                ),
                bold(YELLOW),
            )),
        }
        if let Some(sync) = app.sync.as_ref().filter(|s| s.upstream.is_some()) {
            let (ahead, behind) = (sync.ahead.unwrap_or(0), sync.behind.unwrap_or(0));
            left.push(pad(1));
            left.push(Span::styled(
                format!("↑{ahead}"),
                fg(if ahead > 0 { YELLOW } else { FAINT }),
            ));
            left.push(Span::styled(
                format!(" ↓{behind}"),
                fg(if behind > 0 { CYAN } else { FAINT }),
            ));
        }
        left.push(pad(3));
        left.push(match (state.session.bare, app.changes) {
            (true, _) => Span::styled("bare repository", fg(MUTED)),
            (_, Some(0)) => Span::styled("✓ clean", fg(GREEN)),
            (_, Some(n)) => Span::styled(format!("● {n} changed"), fg(YELLOW)),
            (_, None) => Span::raw(""),
        });
    }
    frame.render_widget(Paragraph::new(Line::from(left)), area);

    let active = match app.view {
        View::Working => 1,
        View::Remote | View::Publish => 2,
        View::Diff | View::Confirm if app.back == View::Working => 1,
        View::Confirm if app.back == View::Remote => 2,
        _ => 0,
    };
    let mut right = Vec::new();
    if app.busy && !app.writing {
        right.push(Span::styled(format!("{} ", spinner()), fg(ACCENT)));
    }
    let mut tabs = Vec::new();
    for (i, (name, key)) in [("History", "h"), ("Changes", "w"), ("Sync", "m")]
        .into_iter()
        .enumerate()
    {
        let start: usize = right.iter().map(|s: &Span| s.content.width()).sum();
        if i == active {
            right.push(Span::styled(
                format!(" {name} "),
                bold(ACCENT).add_modifier(Modifier::UNDERLINED),
            ));
        } else {
            right.push(Span::styled(format!(" {name}"), fg(MUTED)));
            right.push(Span::styled(format!(" {key} "), fg(FAINT)));
        }
        let end: usize = right.iter().map(|s| s.content.width()).sum();
        tabs.push((start, end - start, i as u8));
    }
    right.push(pad(1));
    let total: usize = right.iter().map(|s| s.content.width()).sum();
    let left_edge = area.right().saturating_sub(total as u16);
    for (start, width, tab) in tabs {
        target(
            app,
            Rect::new(left_edge + start as u16, area.y, width as u16, 1),
            Hit::Tab(tab),
        );
    }
    frame.render_widget(Paragraph::new(Line::from(right)).right_aligned(), area);
}

/// Clickable sync and stash buttons; unavailable ones stay visible but faint.
fn toolbar(frame: &mut Frame, area: Rect, app: &App) {
    let sync = app.sync.as_ref();
    let upstream = sync.is_some_and(|s| s.upstream.is_some());
    let count = |n: Option<u64>| {
        n.filter(|n| *n > 0)
            .map_or(String::new(), |n| format!(" {n}"))
    };
    let buttons = [
        (Action::Fetch, "↻ Fetch".to_string(), "f"),
        (
            Action::Pull,
            format!("↓ Pull{}", count(sync.and_then(|s| s.behind))),
            "l",
        ),
        (
            Action::Push,
            if upstream || sync.is_none() {
                format!("↑ Push{}", count(sync.and_then(|s| s.ahead)))
            } else {
                "↑ Publish".to_string()
            },
            "p",
        ),
        (Action::Stash, "▾ Stash".to_string(), "z"),
        (
            Action::Pop,
            format!("▴ Pop{}", count(Some(app.stashes.len() as u64))),
            "Z",
        ),
    ];
    let mut spans = vec![pad(1)];
    let mut x = area.x + 1;
    for (action, label, key) in buttons {
        let enabled = app.unavailable(action).is_none() && !app.writing;
        let label = format!(" {label} ");
        let width = label.width() as u16;
        if x + width + 3 > area.right() {
            break;
        }
        let style = if enabled {
            Style::new().fg(Color::Reset).bg(SELECT)
        } else {
            fg(FAINT)
        };
        target(app, Rect::new(x, area.y, width, 1), Hit::Action(action));
        spans.push(Span::styled(label, style));
        spans.push(Span::styled(
            format!(" {key} "),
            fg(if enabled { MUTED } else { BORDER }),
        ));
        spans.push(pad(1));
        x += width + 4;
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn status_line(app: &App) -> Option<Line<'static>> {
    if app.quit {
        return Some(Line::from(vec![
            Span::styled(format!(" {} ", spinner()), fg(YELLOW)),
            Span::styled(
                "Finishing the running Git action before exit — cancelling is not a rollback.",
                fg(YELLOW),
            ),
        ]));
    }
    if app.writing {
        return Some(Line::from(vec![
            Span::styled(format!(" {} ", spinner()), fg(YELLOW)),
            Span::styled("Running Git…", fg(YELLOW)),
        ]));
    }
    if app.notice.is_empty() {
        return None;
    }
    let (mark, color) = match app.tone {
        Tone::Good => ("✓", GREEN),
        Tone::Bad => ("✗", RED),
        Tone::Info => ("•", ACCENT),
    };
    Some(Line::from(vec![
        Span::styled(format!(" {mark} "), bold(color)),
        Span::styled(
            safe(&app.notice),
            fg(if app.tone == Tone::Bad { RED } else { MUTED }),
        ),
    ]))
}

fn footer(app: &App, prompt: bool, width: usize) -> Line<'static> {
    let stage = if app.staged { "unstage" } else { "stage" };
    let mut keys: Vec<(&str, &str)> = if prompt {
        vec![
            ("enter", "send"),
            ("esc", "cancel"),
            ("ctrl-c", "cancel & quit"),
        ]
    } else {
        match app.view {
            View::History => vec![
                ("↑↓", "move"),
                ("enter", "open"),
                ("w", "changes"),
                ("c", "commit"),
                ("m", "sync"),
                ("r", "refresh"),
                ("q", "quit"),
            ],
            View::Files if app.wide => {
                vec![("↑↓", "files"), ("enter", "full diff"), ("esc", "back")]
            }
            View::Files => vec![
                ("↑↓", "files"),
                ("enter", "diff"),
                ("[ ]", "scroll message"),
                ("esc", "back"),
            ],
            View::Working => vec![
                ("↑↓", "move"),
                ("tab", "staged ⇄ unstaged"),
                ("enter", "diff"),
                ("s", stage),
                ("c", "commit"),
                ("esc", "back"),
            ],
            View::Diff => vec![
                ("↑↓ pgup pgdn", "scroll"),
                ("g G", "top · end"),
                ("esc", "back"),
            ],
            View::Composer => vec![
                ("F2", "commit"),
                ("enter", "new line"),
                ("pgup pgdn", "files"),
                ("esc", "keep draft"),
            ],
            View::Remote if app.uncertain.is_some() => {
                vec![("v", "verify push"), ("f", "fetch"), ("esc", "back")]
            }
            View::Remote => {
                let upstream = app.sync.as_ref().is_some_and(|s| s.upstream.is_some());
                let mut keys = vec![("↑↓", "remote"), ("f", "fetch")];
                if upstream {
                    keys.extend([("l", "pull"), ("p", "push")]);
                } else {
                    keys.push(("b", "publish"));
                }
                keys.push(("esc", "back"));
                keys
            }
            View::Publish => vec![("enter", "review"), ("esc", "cancel")],
            View::Confirm if matches!(&app.confirm, Some(Confirm::Stash(r)) if r.entries().iter().any(|e| e.1)) =>
            {
                vec![
                    ("enter", "stash"),
                    ("u", "untracked"),
                    ("↑↓", "scroll"),
                    ("esc", "cancel"),
                ]
            }
            View::Confirm => vec![("enter", "confirm"), ("↑↓", "scroll"), ("esc", "cancel")],
        }
    };
    if !WRITES {
        keys.retain(|(key, _)| !matches!(*key, "c" | "s" | "l" | "p" | "b" | "v" | "f"));
        keys.push(("", "read-only"));
    }
    hints(&keys, width)
}

/// Draws one graph row. HEAD is a ringed node and merges are hollow, so the shape of the
/// history reads without colour.
fn lane_color(id: u8) -> Color {
    // Line 1 is the first branch drawn, usually the checked-out one.
    LANES[(usize::from(id) + LANES.len() - 1) % LANES.len()]
}

/// Node shapes per commit kind; the selected commit's line stays bright and others dim.
struct Node {
    head: bool,
    merge: bool,
    stash: bool,
}

fn graph_spans(
    row: &[GraphCell],
    width: usize,
    node: Node,
    focus: Option<u8>,
) -> Vec<Span<'static>> {
    let mut spans: Vec<Span> = row
        .iter()
        .take(width)
        .enumerate()
        .map(|(x, cell)| {
            let color = lane_color(cell.color);
            if x + 1 == width && row.len() > width {
                return Span::styled("…", fg(MUTED));
            }
            if cell.node {
                let glyph = if node.head {
                    "◉"
                } else if node.stash {
                    "◇"
                } else if node.merge {
                    "○"
                } else {
                    "●"
                };
                return Span::styled(glyph, bold(color));
            }
            let style = match focus {
                Some(line) if line != cell.color => fg(color).add_modifier(Modifier::DIM),
                Some(_) => bold(color),
                None => fg(color),
            };
            Span::styled(cell.glyph.to_string(), style)
        })
        .collect();
    spans.push(pad(width.saturating_sub(row.len()) + 1));
    spans
}

fn ref_spans(app: &App, id: &str, budget: usize) -> (Vec<Span<'static>>, usize) {
    let Some(refs) = app.refs.get(id) else {
        return (Vec::new(), 0);
    };
    let head = app
        .state
        .as_ref()
        .and_then(|s| s.session.head_ref.as_deref())
        .and_then(|h| h.strip_prefix("refs/heads/"));
    // A remote's symbolic HEAD only repeats the branch it points at.
    let mut sorted: Vec<_> = refs
        .iter()
        .filter(|(name, kind)| !(kind == "remote" && name.ends_with("/HEAD")))
        .collect();
    let rank = |(name, kind): &&(String, String)| match kind.as_str() {
        "local" if Some(name.as_str()) == head => 0,
        "local" => 1,
        "remote" => 2,
        "tag" => 3,
        _ => 4,
    };
    sorted.sort_by_key(rank);
    let mut spans = Vec::new();
    let mut used = 0;
    for (i, item) in sorted.iter().enumerate() {
        let (name, kind) = *item;
        let (text, style) = match kind.as_str() {
            "local" if Some(name.as_str()) == head => (
                format!(" {} ", safe(name)),
                Style::new()
                    .fg(Color::Black)
                    .bg(GREEN)
                    .add_modifier(Modifier::BOLD),
            ),
            "local" => (safe(name), bold(GREEN)),
            "remote" => (safe(name), fg(Color::Indexed(174))),
            "tag" => (format!("◆ {}", safe(name)), bold(YELLOW)),
            _ => (format!("≡ {}", safe(name)), fg(PURPLE)),
        };
        let w = text.width() + 1;
        if used + w > budget {
            let more = format!("+{}", sorted.len() - i);
            if used + more.width() < budget {
                used += more.width() + 1;
                spans.push(Span::styled(more, fg(MUTED)));
                spans.push(pad(1));
            }
            break;
        }
        used += w;
        spans.push(Span::styled(text, style));
        spans.push(pad(1));
    }
    (spans, used)
}

fn history(frame: &mut Frame, area: Rect, app: &App) {
    let (list_area, preview) = if app.wide {
        let [a, b] = Layout::horizontal([Constraint::Percentage(60), Constraint::Percentage(40)])
            .areas(area);
        (a, Some(b))
    } else {
        (area, None)
    };
    let mut title = String::from("History");
    if !app.commits.is_empty() {
        title.push_str(&format!(
            " · {}{}",
            app.commits.len(),
            if app.cursor.is_some() { "+" } else { "" }
        ));
    }
    if app.shallow && app.cursor.is_none() {
        title.push_str(" · shallow");
    }
    let block = panel(title, true);
    let inner = block.inner(list_area);
    frame.render_widget(block, list_area);
    if app.commits.is_empty() {
        let text = if app.state.is_some() {
            "No commits yet"
        } else {
            "Opening repository…"
        };
        empty(frame, inner, text, MUTED);
    } else {
        let height = usize::from(inner.height);
        let width = usize::from(inner.width);
        let start = window(&app.tops[0], app.history, app.commits.len(), height);
        let end = (start + height).min(app.commits.len());
        let graph_cap = (width / 3).clamp(3, 31);
        // Measure beyond the visible rows so the hash column does not shift while scrolling.
        let graph = app.rows[start.saturating_sub(height)..(end + height).min(app.rows.len())]
            .iter()
            .map(Vec::len)
            .max()
            .unwrap_or(1)
            .min(graph_cap);
        let head = app.state.as_ref().and_then(|s| s.session.head.as_deref());
        let focus = app
            .rows
            .get(app.history)
            .and_then(|row| row.iter().find(|cell| cell.node))
            .map(|cell| cell.color);
        let show_author = width >= 70;
        let show_date = width >= 50;
        let right = usize::from(show_author) * 15 + usize::from(show_date) * 5;
        for i in start..end {
            let y = inner.y + (i - start) as u16;
            target(app, Rect::new(inner.x, y, inner.width, 1), Hit::Commit(i));
        }
        let lines: Vec<Line> = (start..end)
            .map(|i| {
                let commit = &app.commits[i];
                let selected = i == app.history;
                let mut spans = vec![if selected {
                    Span::styled("▌", fg(ACCENT))
                } else {
                    pad(1)
                }];
                let stash = app
                    .refs
                    .get(&commit.id)
                    .is_some_and(|refs| refs.iter().any(|(_, kind)| kind == "stash"));
                spans.extend(graph_spans(
                    &app.rows[i],
                    graph,
                    Node {
                        head: head == Some(&commit.id),
                        merge: commit.parents.len() > 1 && !stash,
                        stash,
                    },
                    focus,
                ));
                spans.push(Span::styled(
                    commit.id.get(..7).unwrap_or(&commit.id).to_string(),
                    fg(GOLD),
                ));
                spans.push(pad(1));
                let mut used = 1 + graph + 1 + 8;
                let budget = width.saturating_sub(used + right + 12);
                let (refs, refs_width) = ref_spans(app, &commit.id, budget.min(width / 3));
                spans.extend(refs);
                used += refs_width;
                let room = width.saturating_sub(used + right);
                let subject = clip(&safe(&commit.subject), room);
                let subject_width = subject.width();
                let merge = commit.parents.len() > 1;
                spans.push(Span::styled(
                    subject,
                    if selected {
                        bold(Color::Reset)
                    } else if merge {
                        fg(MUTED)
                    } else {
                        Style::new()
                    },
                ));
                spans.push(pad(room.saturating_sub(subject_width)));
                if show_author {
                    spans.push(Span::styled(
                        format!("{:>14} ", clip(&safe(&commit.author), 14)),
                        fg(MUTED),
                    ));
                }
                if show_date {
                    spans.push(Span::styled(
                        format!("{:>4} ", ago(commit.timestamp)),
                        fg(FAINT),
                    ));
                }
                let line = Line::from(spans);
                if selected {
                    line.style(Style::new().bg(SELECT))
                } else {
                    line
                }
            })
            .collect();
        frame.render_widget(Paragraph::new(lines), inner);
    }
    if let Some(area) = preview {
        let selected = app.commits.get(app.history);
        let detail = app
            .detail
            .as_ref()
            .filter(|(d, _)| Some(&d.summary.id) == selected.map(|c| &c.id));
        let block = panel("Commit", false);
        let inner = block.inner(area);
        frame.render_widget(block, area);
        match detail {
            Some((detail, files)) => {
                let mut lines = commit_card(detail, files);
                lines.push(Line::raw(""));
                let width = usize::from(inner.width);
                lines.extend(files.iter().map(|f| file_line(f, width, false)));
                frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
            }
            None if selected.is_some() => empty(frame, inner, "Loading…", FAINT),
            None => {}
        }
    }
}

fn message_body(detail: &CommitDetail) -> Vec<String> {
    let mut lines: Vec<&str> = detail.body.trim_end().lines().collect();
    if lines.first().map(|l| l.trim()) == Some(detail.summary.subject.trim()) {
        lines.remove(0);
    }
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    lines
        .into_iter()
        .map(|l| safe(&l.replace('\t', "    ")))
        .collect()
}

fn commit_card(detail: &CommitDetail, files: &[DiffFile]) -> Vec<Line<'static>> {
    let c = &detail.summary;
    let mut lines = vec![
        Line::styled(safe(&c.subject), bold(Color::Reset)),
        Line::raw(""),
        Line::from(vec![
            Span::styled(safe(&c.author), bold(MUTED)),
            Span::styled(format!(" <{}>", safe(&c.email)), fg(FAINT)),
            Span::styled(
                match ago(c.timestamp).as_str() {
                    "now" => " · just now".into(),
                    age => format!(" · {age} ago"),
                },
                fg(FAINT),
            ),
        ]),
        Line::from(vec![
            Span::styled(c.id.get(..12).unwrap_or(&c.id).to_string(), fg(GOLD)),
            Span::styled(
                match c.parents.len() {
                    0 => " · root commit".into(),
                    1 => String::new(),
                    n => format!(" · merge of {n} parents, diff vs first"),
                },
                fg(FAINT),
            ),
        ]),
    ];
    let body = message_body(detail);
    if !body.is_empty() {
        lines.push(Line::raw(""));
        lines.extend(body.into_iter().map(Line::raw));
    }
    let (add, del) = files.iter().fold((0, 0), |(a, d), f| {
        (a + f.additions.unwrap_or(0), d + f.deletions.unwrap_or(0))
    });
    lines.push(Line::raw(""));
    lines.push(Line::from(vec![
        Span::styled(
            format!(
                "{} file{} changed",
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ),
            bold(MUTED),
        ),
        Span::styled(format!("  +{add}"), fg(GREEN)),
        Span::styled(format!(" −{del}"), fg(RED)),
    ]));
    lines
}

fn status_style(code: &str) -> (&'static str, Color) {
    match code {
        "A" => ("added", GREEN),
        "M" => ("modified", YELLOW),
        "D" => ("deleted", RED),
        "R" => ("renamed", PURPLE),
        "C" => ("copied", PURPLE),
        "T" => ("type", CYAN),
        "U" => ("conflict", RED),
        "?" => ("new", GREEN),
        _ => ("changed", MUTED),
    }
}

fn path_spans(path: &str, width: usize) -> Vec<Span<'static>> {
    let path = clip_left(&safe(path), width);
    match path.rfind('/') {
        Some(i) => vec![
            Span::styled(path[..=i].to_string(), fg(MUTED)),
            Span::raw(path[i + 1..].to_string()),
        ],
        None => vec![Span::raw(path)],
    }
}

fn file_line(file: &DiffFile, width: usize, selected: bool) -> Line<'static> {
    let code = file.status.get(..1).unwrap_or("?");
    let (_, color) = status_style(code);
    let stats = if file.binary {
        "bin".to_string()
    } else {
        format!(
            "+{} −{}",
            file.additions.unwrap_or(0),
            file.deletions.unwrap_or(0)
        )
    };
    let room = width.saturating_sub(4 + stats.width() + 1);
    let label = match &file.old_path {
        Some(old) if old != &file.path => format!("{old} → {}", file.path),
        _ => file.path.clone(),
    };
    let mut spans = vec![
        Span::styled(if selected { "▌" } else { " " }, fg(ACCENT)),
        Span::styled(code.to_string(), bold(color)),
        pad(2),
    ];
    let path = path_spans(&label, room);
    let used: usize = path.iter().map(|s| s.content.width()).sum();
    spans.extend(path);
    spans.push(pad(room.saturating_sub(used) + 1));
    if file.binary {
        spans.push(Span::styled(stats, fg(FAINT)));
    } else {
        spans.push(Span::styled(
            format!("+{}", file.additions.unwrap_or(0)),
            fg(GREEN),
        ));
        spans.push(Span::styled(
            format!(" −{}", file.deletions.unwrap_or(0)),
            fg(RED),
        ));
    }
    let line = Line::from(spans);
    if selected {
        line.style(Style::new().bg(SELECT))
    } else {
        line
    }
}

fn inspect(frame: &mut Frame, area: Rect, app: &App) {
    let Some((detail, files)) = &app.detail else {
        return;
    };
    let (left, right) = if app.wide {
        let [a, b] = Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)])
            .areas(area);
        (a, Some(b))
    } else {
        (area, None)
    };
    let card = commit_card(detail, files);
    let card_height = (card.len() as u16 + 2).min(left.height / 2).max(3);
    let [top, bottom] =
        Layout::vertical([Constraint::Length(card_height), Constraint::Min(3)]).areas(left);
    let id = detail.summary.id.get(..7).unwrap_or(&detail.summary.id);
    frame.render_widget(
        Paragraph::new(card)
            .block(panel(format!("Commit {id}"), false))
            .wrap(Wrap { trim: false })
            .scroll((app.scroll.min(u16::MAX as usize) as u16, 0)),
        top,
    );
    let block = panel(format!("Files · {}", files.len()), true);
    let inner = block.inner(bottom);
    frame.render_widget(block, bottom);
    if files.is_empty() {
        empty(frame, inner, "No file changes", MUTED);
    } else {
        let height = usize::from(inner.height);
        let start = window(&app.tops[1], app.file, files.len(), height);
        for i in start..(start + height).min(files.len()) {
            let y = inner.y + (i - start) as u16;
            target(app, Rect::new(inner.x, y, inner.width, 1), Hit::File(i));
        }
        let lines: Vec<_> = files
            .iter()
            .enumerate()
            .skip(start)
            .take(height)
            .map(|(i, f)| file_line(f, usize::from(inner.width), i == app.file))
            .collect();
        frame.render_widget(Paragraph::new(lines), inner);
    }
    if let Some(area) = right {
        let path = files.get(app.file).map(|f| f.path.as_str());
        diff_panel(
            frame,
            area,
            app,
            app.file_target().map(|(s, p)| super::diff_key(&s, &p)),
            path,
            0,
        );
    }
}

fn working_label(entry: &StatusEntry, staged: bool) -> (&'static str, Color) {
    if entry.conflicted {
        return ("conflict", RED);
    }
    if entry.untracked {
        return ("new", GREEN);
    }
    let code = if staged {
        &entry.index_status
    } else {
        &entry.worktree_status
    };
    status_style(code.get(..1).unwrap_or("."))
}

fn working(frame: &mut Frame, area: Rect, app: &App) {
    let (left, right) = if app.wide {
        let [a, b] = Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)])
            .areas(area);
        (a, Some(b))
    } else {
        (area, None)
    };
    let staged = app
        .entries
        .iter()
        .filter(|e| !e.untracked && e.index_status != ".")
        .count();
    let unstaged = app
        .entries
        .iter()
        .filter(|e| e.conflicted || e.untracked || e.worktree_status != ".")
        .count();
    let tab = |name: &str, n: usize, on: bool| {
        if on {
            Span::styled(
                format!(" {name} {n} "),
                bold(ACCENT).add_modifier(Modifier::UNDERLINED),
            )
        } else {
            Span::styled(format!(" {name} {n} "), fg(MUTED))
        }
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(fg(ACCENT))
        .title(Line::from(vec![
            tab("Unstaged", unstaged, !app.staged),
            Span::styled("│", fg(BORDER)),
            tab("Staged", staged, app.staged),
        ]))
        .padding(Padding::horizontal(1));
    let inner = block.inner(left);
    frame.render_widget(block, left);
    let first = format!(" Unstaged {unstaged} ").width() as u16;
    let second = format!(" Staged {staged} ").width() as u16;
    target(
        app,
        Rect::new(left.x + 1, left.y, first, 1),
        Hit::Staged(false),
    );
    target(
        app,
        Rect::new(left.x + 2 + first, left.y, second, 1),
        Hit::Staged(true),
    );
    let rows: Vec<&StatusEntry> = app.working_rows().collect();
    if rows.is_empty() {
        let (text, color) = match (app.entries.is_empty(), app.staged) {
            (true, _) => ("✓ Working tree clean", GREEN),
            (false, true) => ("Nothing staged · tab to switch, s to stage", MUTED),
            (false, false) => ("Everything is staged · c to commit", GREEN),
        };
        empty(frame, inner, text, color);
    } else {
        let height = usize::from(inner.height);
        let width = usize::from(inner.width);
        let start = window(&app.tops[2], app.working, rows.len(), height);
        for i in start..(start + height).min(rows.len()) {
            let y = inner.y + (i - start) as u16;
            target(app, Rect::new(inner.x, y, inner.width, 1), Hit::Change(i));
        }
        let lines: Vec<_> = rows
            .iter()
            .enumerate()
            .skip(start)
            .take(height)
            .map(|(i, entry)| {
                let selected = i == app.working;
                let (label, color) = working_label(entry, app.staged);
                let path = match &entry.old_path {
                    Some(old) => format!("{old} → {}", entry.path),
                    None => entry.path.clone(),
                };
                let mut spans = vec![
                    Span::styled(if selected { "▌" } else { " " }, fg(ACCENT)),
                    Span::styled(format!("{label:<9}"), fg(color)),
                ];
                spans.extend(path_spans(&path, width.saturating_sub(11)));
                let used: usize = spans.iter().map(|s| s.content.width()).sum();
                spans.push(pad(width.saturating_sub(used)));
                let line = Line::from(spans);
                if selected {
                    line.style(Style::new().bg(SELECT))
                } else {
                    line
                }
            })
            .collect();
        frame.render_widget(Paragraph::new(lines), inner);
    }
    if let Some(area) = right {
        let path = rows.get(app.working).map(|e| e.path.as_str());
        diff_panel(
            frame,
            area,
            app,
            app.working_target().map(|(s, p)| super::diff_key(&s, &p)),
            path,
            0,
        );
    }
}

/// Renders the diff for `key` when loaded; otherwise a quiet placeholder.
fn diff_panel(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    key: Option<String>,
    path: Option<&str>,
    scroll: usize,
) {
    let current = key.is_some() && app.diff_key == key;
    let diff = app.diff.as_ref().filter(|_| current);
    let title = path.map_or("Diff".into(), |p| {
        clip_left(&safe(p), usize::from(area.width) / 2)
    });
    let mut block = panel(title, app.view == View::Diff);
    if let Some(diff) = diff {
        let (add, del) = counts(diff);
        block = block.title(
            Line::from(vec![
                Span::styled(format!(" +{add}"), fg(GREEN)),
                Span::styled(format!(" −{del} "), fg(RED)),
            ])
            .right_aligned(),
        );
    }
    let inner = block.inner(area);
    frame.render_widget(block, area);
    match diff {
        Some(diff) => {
            let lines = diff_lines(diff);
            if lines.is_empty() {
                let text = if diff.binary {
                    "Binary file — no text preview".to_string()
                } else if diff.truncated {
                    "This diff is too large to preview".to_string()
                } else {
                    diff.message
                        .as_deref()
                        .map(safe)
                        .unwrap_or_else(|| "No text changes".into())
                };
                empty(frame, inner, &text, MUTED);
            } else {
                let height = usize::from(inner.height);
                let mut visible: Vec<Line> = lines.into_iter().skip(scroll).take(height).collect();
                if diff.truncated && visible.len() < height {
                    visible.push(Line::styled("… preview limit reached", fg(YELLOW)));
                }
                frame.render_widget(Paragraph::new(visible), inner);
            }
        }
        None if path.is_some() && app.wide || app.view == View::Diff => {
            empty(frame, inner, "Loading…", FAINT)
        }
        None => {}
    }
}

fn counts(diff: &FileDiff) -> (usize, usize) {
    diff.hunks
        .iter()
        .flat_map(|h| &h.lines)
        .fold((0, 0), |(a, d), l| match l.kind.as_str() {
            "add" => (a + 1, d),
            "remove" => (a, d + 1),
            _ => (a, d),
        })
}

pub(super) fn diff_lines(diff: &FileDiff) -> Vec<Line<'static>> {
    let max = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter_map(|l| l.old_line.max(l.new_line))
        .max()
        .unwrap_or(0);
    let digits = max.to_string().len().max(3);
    let number = |n: Option<u64>| n.map_or(" ".repeat(digits), |n| format!("{n:>digits$}"));
    let mut lines = Vec::new();
    for (i, hunk) in diff.hunks.iter().enumerate() {
        if i > 0 {
            lines.push(Line::raw(""));
        }
        lines.push(Line::from(vec![
            Span::styled(format!("{} ", "┄".repeat(digits * 2 + 1)), fg(BORDER)),
            Span::styled(safe(&hunk.header), fg(CYAN).add_modifier(Modifier::DIM)),
        ]));
        for line in &hunk.lines {
            let content = safe(&line.content.replace('\t', "    "));
            let (sign, style) = match line.kind.as_str() {
                "add" => ("+", fg(GREEN)),
                "remove" => ("-", fg(RED)),
                "context" => (" ", Style::new()),
                _ => (" ", fg(FAINT).add_modifier(Modifier::ITALIC)),
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{} {} ", number(line.old_line), number(line.new_line)),
                    fg(FAINT),
                ),
                Span::styled(format!("{sign} "), style.add_modifier(Modifier::BOLD)),
                Span::styled(content, style),
            ]));
        }
    }
    lines
}

fn full_diff(frame: &mut Frame, area: Rect, app: &App) {
    let path = app.diff.as_ref().map(|d| d.path.as_str());
    diff_panel(frame, area, app, app.diff_key.clone(), path, app.scroll);
}

fn sync(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel("Sync", true).padding(Padding::new(2, 2, 1, 0));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(sync) = &app.sync else {
        empty(frame, inner, "Loading…", FAINT);
        return;
    };
    let key = |k: &str| Span::styled(format!("{k:<11}"), fg(MUTED));
    let mut lines = vec![
        Line::from(vec![
            key("Branch"),
            Span::styled(
                safe(sync.branch.as_deref().unwrap_or("detached HEAD")),
                bold(GREEN),
            ),
        ]),
        Line::from(vec![
            key("Upstream"),
            match &sync.upstream {
                Some(upstream) => Span::styled(safe(upstream), fg(Color::Indexed(174))),
                None => Span::styled("none · publish to set one", fg(FAINT)),
            },
        ]),
    ];
    if sync.upstream.is_some() {
        let (ahead, behind) = (sync.ahead.unwrap_or(0), sync.behind.unwrap_or(0));
        lines.push(Line::from(vec![
            key("Status"),
            Span::styled(
                format!("↑ {ahead} to push"),
                fg(if ahead > 0 { YELLOW } else { MUTED }),
            ),
            Span::styled("   ", fg(FAINT)),
            Span::styled(
                format!("↓ {behind} to pull"),
                fg(if behind > 0 { CYAN } else { MUTED }),
            ),
            Span::styled("   as of the last fetch", fg(FAINT)),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::styled("Remotes", bold(MUTED)));
    if sync.remotes.is_empty() {
        lines.push(Line::styled("  No remotes configured", fg(FAINT)));
    }
    for (i, remote) in sync.remotes.iter().enumerate() {
        let selected = i == app.remote;
        let line = Line::from(vec![
            Span::styled(if selected { "▌ " } else { "  " }, fg(ACCENT)),
            Span::styled(
                safe(remote),
                if selected {
                    bold(Color::Reset)
                } else {
                    fg(MUTED)
                },
            ),
        ]);
        lines.push(if selected {
            line.style(Style::new().bg(SELECT))
        } else {
            line
        });
    }
    // The summary and remote list never wrap, so each remote's row is known for clicks.
    let first_remote = lines.len() - sync.remotes.len();
    let top_height = (lines.len() as u16).min(inner.height);
    for i in 0..sync.remotes.len() {
        let y = inner.y + (first_remote + i) as u16;
        if y < inner.y + top_height {
            target(app, Rect::new(inner.x, y, inner.width, 1), Hit::Remote(i));
        }
    }
    frame.render_widget(
        Paragraph::new(lines),
        Rect::new(inner.x, inner.y, inner.width, top_height),
    );
    let inner = Rect::new(
        inner.x,
        inner.y + top_height,
        inner.width,
        inner.height - top_height,
    );
    let mut lines = vec![Line::raw("")];
    if !WRITES {
        lines.push(Line::styled(
            "Sync actions are read-only on this platform.",
            fg(FAINT),
        ));
    } else if app.uncertain.is_some() {
        lines.push(Line::from(vec![
            Span::styled("! ", bold(YELLOW)),
            Span::styled(
                "The last push could not be confirmed. Press v to check the destination before pushing again.",
                fg(YELLOW),
            ),
        ]));
    } else {
        let action = |k: &str, label: &str| {
            vec![
                Span::styled(format!(" {k} "), Style::new().fg(Color::Black).bg(ACCENT)),
                Span::styled(format!(" {label}    "), fg(MUTED)),
            ]
        };
        let mut actions = vec![action("f", "Fetch")];
        if sync.upstream.is_some() {
            actions.push(action("l", "Pull (fast-forward)"));
            actions.push(action("p", "Push"));
        } else if sync.branch.is_some() {
            actions.push(action("b", "Publish"));
        }
        lines.push(Line::from(actions.concat()));
        lines.push(Line::raw(""));
        lines.push(Line::styled(
            "Every action is reviewed before it runs. Fetch never prunes.",
            fg(FAINT),
        ));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn composer(frame: &mut Frame, app: &App) {
    let Some(review) = &app.review else {
        return;
    };
    let area = frame.area();
    let rect = modal(
        frame,
        (area.width * 4 / 5).max(60),
        (area.height * 4 / 5).max(16),
    );
    let branch = review.head_ref().map_or("detached HEAD".into(), |h| {
        safe(h.strip_prefix("refs/heads/").unwrap_or(h))
    });
    let summary = app.message.lines().next().unwrap_or("").width();
    let block = dialog(format!("Commit to {branch}")).title_bottom(
        Line::styled(
            format!(" summary {summary}/72 "),
            fg(if summary > 72 { YELLOW } else { FAINT }),
        )
        .right_aligned(),
    );
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let files = review.files();
    let list_height = (files.len() as u16 + 1).min(inner.height / 3).max(2);
    let [list, gap, editor] = Layout::vertical([
        Constraint::Length(list_height),
        Constraint::Length(1),
        Constraint::Min(3),
    ])
    .areas(inner);
    let mut lines = vec![Line::styled(
        format!(
            "Staged · {} file{}",
            files.len(),
            if files.len() == 1 { "" } else { "s" }
        ),
        bold(MUTED),
    )];
    lines.extend(
        files
            .iter()
            .skip(app.scroll)
            .map(|f| file_line(f, usize::from(list.width), false)),
    );
    frame.render_widget(Paragraph::new(lines), list);
    frame.render_widget(
        Paragraph::new(Line::styled("─".repeat(usize::from(gap.width)), fg(BORDER))),
        gap,
    );
    let text: Vec<Line> = if app.message.is_empty() {
        vec![Line::styled(
            " Summary of the change, then a blank line and details",
            fg(FAINT),
        )]
    } else {
        app.message
            .split('\n')
            .enumerate()
            .map(|(i, line)| {
                let text = safe(&line.replace('\t', "    "));
                if i == 0 {
                    Line::styled(text, bold(Color::Reset))
                } else {
                    Line::raw(text)
                }
            })
            .collect()
    };
    // Keep the end of a long message, where typing happens, in view.
    let height = usize::from(editor.height);
    let skip = text.len().saturating_sub(height);
    let visible = text.len() - skip;
    let end = if app.message.is_empty() {
        0
    } else {
        text.last().map_or(0, Line::width)
    };
    frame.render_widget(
        Paragraph::new(text.into_iter().skip(skip).collect::<Vec<_>>()),
        editor,
    );
    frame.set_cursor_position((
        editor.x + (end as u16).min(editor.width.saturating_sub(1)),
        editor.y + visible.saturating_sub(1) as u16,
    ));
}

fn confirm(frame: &mut Frame, app: &App) {
    match &app.confirm {
        Some(Confirm::Stash(review)) => {
            let area = frame.area();
            let entries = review.entries();
            let height = (entries.len() as u16 + 9).min(area.height * 4 / 5);
            let rect = modal(frame, 72, height);
            let kept = entries.iter().filter(|(_, untracked)| *untracked).count();
            let saved = if review.include_untracked {
                entries.len()
            } else {
                entries.len() - kept
            };
            let block = dialog(format!(
                "Stash {saved} change{}",
                if saved == 1 { "" } else { "s" }
            ));
            let inner = block.inner(rect);
            frame.render_widget(block, rect);
            let mut lines: Vec<Line> = entries
                .iter()
                .skip(app.scroll)
                .take(usize::from(inner.height.saturating_sub(5)))
                .map(|(path, untracked)| {
                    let stays = *untracked && !review.include_untracked;
                    let mut spans = vec![Span::styled(
                        if *untracked { "new      " } else { "changed  " },
                        fg(if stays {
                            FAINT
                        } else if *untracked {
                            GREEN
                        } else {
                            YELLOW
                        }),
                    )];
                    spans.extend(path_spans(
                        path,
                        usize::from(inner.width).saturating_sub(18),
                    ));
                    if stays {
                        spans.push(Span::styled("  stays", fg(FAINT)));
                    }
                    Line::from(spans)
                })
                .collect();
            if kept > 0 {
                lines.push(Line::raw(""));
                lines.push(Line::from(vec![
                    Span::styled(" u ", Style::new().fg(Color::Black).bg(MUTED)),
                    Span::styled(
                        if review.include_untracked {
                            " Untracked files are included"
                        } else {
                            " Untracked files stay in place"
                        },
                        fg(MUTED),
                    ),
                ]));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled(
                    " enter ",
                    Style::new()
                        .fg(Color::Black)
                        .bg(ACCENT)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(" stash    ", fg(MUTED)),
                Span::styled(" esc ", Style::new().fg(Color::Black).bg(MUTED)),
                Span::styled(" cancel", fg(MUTED)),
            ]));
            frame.render_widget(Paragraph::new(lines), inner);
        }
        Some(Confirm::Pop(entry)) => {
            let rect = modal(frame, 72, 12);
            let block = dialog("Pop the latest stash");
            let inner = block.inner(rect);
            frame.render_widget(block, rect);
            let key = |k: &str| Span::styled(format!("{k:<9}"), fg(MUTED));
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(vec![
                        key("Stash"),
                        Span::styled(safe(&entry.selector), fg(PURPLE)),
                    ]),
                    Line::from(vec![
                        key("Message"),
                        Span::styled(safe(&entry.message), bold(Color::Reset)),
                    ]),
                    Line::from(vec![
                        key("Commit"),
                        Span::styled(
                            entry.oid.get(..12).unwrap_or(&entry.oid).to_string(),
                            fg(GOLD),
                        ),
                    ]),
                    Line::raw(""),
                    Line::styled(
                        "Needs a clean working tree. The stash is removed only after it applies.",
                        fg(FAINT),
                    ),
                    Line::raw(""),
                    Line::from(vec![
                        Span::styled(
                            " enter ",
                            Style::new()
                                .fg(Color::Black)
                                .bg(ACCENT)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(" pop    ", fg(MUTED)),
                        Span::styled(" esc ", Style::new().fg(Color::Black).bg(MUTED)),
                        Span::styled(" cancel", fg(MUTED)),
                    ]),
                ])
                .wrap(Wrap { trim: false }),
                inner,
            );
        }
        Some(Confirm::Stage(review)) => {
            let area = frame.area();
            let rect = modal(frame, area.width * 17 / 20, area.height * 17 / 20);
            let verb = if review.is_unstage() {
                "Unstage"
            } else {
                "Stage"
            };
            let paths: Vec<String> = review.paths().iter().map(|p| safe(p)).collect();
            let block = dialog(format!("{verb} {}", paths.join(" ← ")));
            let inner = block.inner(rect);
            frame.render_widget(block, rect);
            let mut lines = diff_lines(&review.preview);
            if lines.is_empty() {
                lines.push(Line::styled(
                    if review.preview.binary {
                        "Binary file — no text preview"
                    } else if review.preview.truncated {
                        "This diff is too large to preview"
                    } else {
                        "No text changes"
                    },
                    fg(MUTED),
                ));
            }
            let skip = app.scroll.min(lines.len().saturating_sub(1));
            frame.render_widget(
                Paragraph::new(lines.into_iter().skip(skip).collect::<Vec<_>>()),
                inner,
            );
        }
        Some(Confirm::Remote(review)) => {
            let rect = modal(frame, 70, 12);
            let remote = safe(review.remote());
            let local = safe(review.branch().unwrap_or("—"));
            let branch = safe(review.destination().unwrap_or("*"));
            let (verb, from, to) = match review.kind() {
                TerminalSync::Fetch => (
                    format!("Fetch from {remote}"),
                    format!("{remote}  all branches"),
                    format!("remote-tracking refs/remotes/{remote}/*"),
                ),
                TerminalSync::Pull => (
                    format!("Pull from {remote}"),
                    format!("{remote}  {branch}"),
                    format!("local  {local}  (fast-forward only)"),
                ),
                TerminalSync::Push => (
                    format!("Push to {remote}"),
                    format!("local  {local}"),
                    format!("{remote}  {branch}"),
                ),
                TerminalSync::Publish => (
                    format!("Publish to {remote}"),
                    format!("local  {local}"),
                    format!("{remote}  {branch}  (sets upstream)"),
                ),
            };
            let block = dialog(verb);
            let inner = block.inner(rect);
            frame.render_widget(block, rect);
            let key = |k: &str| Span::styled(format!("{k:<9}"), fg(MUTED));
            let mut lines = vec![
                Line::from(vec![
                    key("Remote"),
                    Span::styled(safe(&review.endpoint_label()), fg(FAINT)),
                ]),
                Line::from(vec![key("From"), Span::raw(from)]),
                Line::from(vec![key("To"), Span::styled(to, bold(Color::Reset))]),
            ];
            if let Some(oid) = review.oid() {
                lines.push(Line::from(vec![
                    key("Commit"),
                    Span::styled(oid.get(..12).unwrap_or(oid).to_string(), fg(GOLD)),
                ]));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled(
                    " enter ",
                    Style::new()
                        .fg(Color::Black)
                        .bg(ACCENT)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(" confirm    ", fg(MUTED)),
                Span::styled(" esc ", Style::new().fg(Color::Black).bg(MUTED)),
                Span::styled(" cancel", fg(MUTED)),
            ]));
            frame.render_widget(
                Paragraph::new(lines)
                    .wrap(Wrap { trim: false })
                    .scroll((app.scroll.min(8) as u16, 0)),
                inner,
            );
        }
        None => {}
    }
}

/// A one-line text field that shows the terminal's own cursor at its end.
fn field(frame: &mut Frame, area: Rect, text: &str) {
    let shown = clip_left(text, usize::from(area.width.saturating_sub(3)));
    frame.render_widget(
        Paragraph::new(format!(" {shown}")).style(Style::new().bg(SELECT)),
        area,
    );
    frame.set_cursor_position((area.x + 1 + shown.width() as u16, area.y));
}

fn publish(frame: &mut Frame, app: &App) {
    let rect = modal(frame, 64, 9);
    let remote = app
        .sync
        .as_ref()
        .and_then(|s| s.remotes.get(app.remote))
        .map_or("remote".into(), |r| safe(r));
    let block = dialog(format!("Publish to {remote}"));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled("Destination branch", fg(MUTED)),
            Line::raw(""),
            Line::raw(""),
            Line::raw(""),
            Line::styled("You will review the push before it runs.", fg(FAINT)),
        ]),
        inner,
    );
    if inner.height > 2 {
        field(
            frame,
            Rect::new(inner.x, inner.y + 2, inner.width, 1),
            &safe(&app.publish),
        );
    }
}

fn credentials(frame: &mut Frame, prompt: &Prompt) {
    let rect = modal(frame, 64, 10);
    let block = dialog("Git needs credentials");
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let context = prompt.context.as_ref().map_or_else(
        || "Git credential request".into(),
        |ctx| format!("{} · {}", safe(&ctx.repository), safe(&ctx.operation)),
    );
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled(clip(&context, usize::from(inner.width)), fg(FAINT)),
            Line::raw(""),
            Line::styled(prompt.question, bold(Color::Reset)),
            Line::raw(""),
            Line::raw(""),
            Line::raw(""),
            Line::styled("Answers stay in memory for this request only.", fg(FAINT)),
        ]),
        inner,
    );
    if inner.height > 4 {
        field(
            frame,
            Rect::new(inner.x, inner.y + 4, inner.width, 1),
            &"•".repeat(prompt.answer.chars().count()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gitty_core::dto::CommitSummary;

    #[test]
    fn clipping_and_hints_respect_display_width() {
        assert_eq!(clip("héllo wörld", 6), "héllo…");
        assert_eq!(clip_left("src/components/Graph.tsx", 10), "…Graph.tsx");
        let keys = [("↑↓", "move"), ("enter", "open"), ("q", "quit")];
        for width in [8, 20, 80] {
            assert!(hints(&keys, width).width() <= width);
        }
    }

    #[test]
    fn commit_body_omits_the_repeated_subject() {
        let detail = CommitDetail {
            summary: CommitSummary {
                id: "a".into(),
                parents: vec![],
                subject: "fix: thing".into(),
                author: String::new(),
                email: String::new(),
                timestamp: 0,
            },
            body: "fix: thing\n\nWhy it changed\n".into(),
            can_edit_message: false,
            edit_disabled_reason: None,
        };
        assert_eq!(message_body(&detail), ["Why it changed"]);
    }
}
