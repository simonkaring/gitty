//! Rendering only: every function reads `App` and draws; none of them change state.
use super::theme::{self, t};
use super::{
    Action, App, Confirm, GraphCell, Hit, HunkKind, Prompt, StashVerb, Tone, View, WRITES,
};
use gitty_core::{
    dto::{CommitDetail, DiffFile, FileDiff, StatusEntry},
    operation_dto::{ConflictFile, ConflictResolution, ConflictVersion, GitAction},
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

const LOCAL_BRANCH: &str = "💻";
const REMOTE_BRANCH: &str = "🌐";

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
        .border_style(fg(if focused { t().accent } else { t().border }))
        .title(Line::from(vec![
            Span::raw(" "),
            Span::styled(
                title.into(),
                bold(if focused { t().accent } else { t().muted }),
            ),
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
    frame.buffer_mut().set_style(
        area,
        Style::new().fg(t().faint).remove_modifier(Modifier::BOLD),
    );
    let w = width.min(area.width.saturating_sub(2));
    let h = height.min(area.height.saturating_sub(2));
    let rect = Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    );
    frame.render_widget(Clear, rect);
    paint(frame, rect);
    rect
}

/// Fills `area` with the theme's background, when it has one.
fn paint(frame: &mut Frame, area: Rect) {
    if let Some(bg) = t().bg {
        frame
            .buffer_mut()
            .set_style(area, Style::new().bg(bg).fg(t().text));
    }
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
            spans.push(Span::styled(gap, fg(t().border)));
        }
        spans.push(Span::styled(key.to_string(), bold(t().accent)));
        spans.push(Span::styled(format!(" {label}"), fg(t().muted)));
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
    // Settings previews the highlighted theme; everywhere else uses the applied one.
    theme::set(if app.view == View::Settings {
        app.settings
    } else {
        app.theme
    });
    let area = frame.area();
    paint(frame, area);
    if area.width < 40 || area.height < 10 {
        frame.render_widget(
            Paragraph::new(vec![
                Line::styled("Gitty needs a larger terminal", bold(t().accent)),
                Line::styled("at least 40 × 10 · Ctrl-C quits", fg(t().muted)),
            ])
            .centered()
            .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }
    let status = status_line(app);
    let operation = app.operation.as_ref().filter(|o| {
        o.kind != gitty_core::operation_dto::OperationKind::None || !o.conflicts.is_empty()
    });
    let [top, op, bar, body, note, bottom] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(u16::from(operation.is_some())),
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(u16::from(status.is_some())),
        Constraint::Length(1),
    ])
    .areas(area);
    header(frame, top, app);
    if let Some(operation) = operation {
        frame.render_widget(
            Paragraph::new(format!(
                " {} · {} conflicts · {} continue / {} skip / {} abort",
                safe(&operation.label),
                operation.conflicts.len(),
                app.keymap.label("continue"),
                app.keymap.label("skip"),
                app.keymap.label("abort")
            ))
            .style(fg(t().yellow)),
            op,
        );
    }
    toolbar(frame, bar, app);
    let base = match app.view {
        View::Confirm => app.back,
        View::Composer => View::History,
        View::Publish => View::Remote,
        View::BranchName => app.back,
        View::Search => View::History,
        View::Message => View::History,
        view => view,
    };
    match base {
        View::Files => inspect(frame, body, app),
        View::Working => working(frame, body, app),
        View::Diff => full_diff(frame, body, app),
        View::Remote => sync(frame, body, app),
        View::Branches => branches(frame, body, app),
        View::Stashes => stashes(frame, body, app),
        View::RebasePlan => rebase_plan(frame, body, app),
        View::Conflicts => conflicts(frame, body, app),
        View::Conflict => {
            if let Some(file) = &app.conflict {
                let label = ["Both sides", "Ours", "Theirs"][app.conflict_side];
                let block = panel(format!("Conflict · {} · {label}", safe(&file.path)), true);
                frame.render_widget(
                    Paragraph::new(conflict_lines(file, app.conflict_side))
                        .block(block)
                        .scroll((app.scroll.min(u16::MAX as usize) as u16, 0)),
                    body,
                );
            }
        }
        View::Repositories => repositories(frame, body, app),
        View::Settings => settings(frame, body, app),
        View::Profiles | View::ProfileEdit => profiles(frame, body, app),
        _ => history(frame, body, app),
    }
    if let Some(status) = status {
        frame.render_widget(Paragraph::new(status), note);
    }
    frame.render_widget(
        Paragraph::new(footer(app, prompt.is_some(), usize::from(area.width)))
            .style(Style::new().bg(t().bar)),
        bottom,
    );
    match app.view {
        View::Composer => composer(frame, app),
        View::Confirm => confirm(frame, app),
        View::Publish => publish(frame, app),
        View::BranchName | View::Search => input(frame, app),
        View::Message => message_editor(frame, app),
        _ => {}
    }
    if app.help {
        help(frame, app);
    }
    if let Some(prompt) = prompt {
        credentials(frame, prompt);
    }
}

fn header(frame: &mut Frame, area: Rect, app: &App) {
    frame.render_widget(Block::new().style(Style::new().bg(t().bar)), area);
    let mut left = vec![Span::styled(
        format!(
            " {} ",
            app.state
                .as_ref()
                .map_or("gitty".into(), |s| safe(&s.session.name))
        ),
        Style::new()
            .fg(t().on_accent)
            .bg(t().accent)
            .add_modifier(Modifier::BOLD),
    )];
    if let Some(state) = &app.state {
        left.push(pad(2));
        match state.session.head_ref.as_deref() {
            Some(head) => left.push(Span::styled(
                format!(
                    "{LOCAL_BRANCH} {}",
                    safe(head.strip_prefix("refs/heads/").unwrap_or(head))
                ),
                bold(t().green),
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
                bold(t().yellow),
            )),
        }
        if let Some(sync) = app.sync.as_ref().filter(|s| s.upstream.is_some()) {
            let (ahead, behind) = (sync.ahead.unwrap_or(0), sync.behind.unwrap_or(0));
            left.push(pad(1));
            left.push(Span::styled(
                format!("↑{ahead}"),
                fg(if ahead > 0 { t().yellow } else { t().faint }),
            ));
            left.push(Span::styled(
                format!(" ↓{behind}"),
                fg(if behind > 0 { t().cyan } else { t().faint }),
            ));
        }
        left.push(pad(3));
        left.push(match (state.session.bare, app.changes) {
            (true, _) => Span::styled("bare repository", fg(t().muted)),
            (_, Some(0)) => Span::styled("✓ clean", fg(t().green)),
            (_, Some(n)) => Span::styled(format!("● {n} changed"), fg(t().yellow)),
            (_, None) => Span::raw(""),
        });
    }
    let active = match app.view {
        View::Working => 1,
        View::Remote | View::Publish => 2,
        View::Diff | View::Confirm if app.back == View::Working => 1,
        View::Confirm if app.back == View::Remote => 2,
        View::Settings | View::Profiles | View::ProfileEdit => 3,
        View::Repositories => 4,
        _ => 0,
    };
    let mut right = Vec::new();
    if app.busy && !app.writing {
        right.push(Span::styled(format!("{} ", spinner()), fg(t().accent)));
    }
    let mut tabs = Vec::new();
    for (i, (name, short, key)) in [
        ("History", "h", "history"),
        ("Changes", "w", "working"),
        ("Sync", "m", "remote"),
        ("Settings", ",", "settings"),
        ("Repos", "o", "repositories"),
    ]
    .into_iter()
    .enumerate()
    {
        let key = clip(&app.keymap.label(key), 3);
        let short = if key.len() == 1 { key.as_str() } else { short };
        let start: usize = right.iter().map(|s: &Span| s.content.width()).sum();
        if area.width < 70 {
            right.push(Span::styled(
                format!(" {short} "),
                if i == active {
                    bold(t().accent)
                } else {
                    fg(t().muted)
                },
            ));
        } else if i == active {
            right.push(Span::styled(
                format!(" {name} "),
                bold(t().accent).add_modifier(Modifier::UNDERLINED),
            ));
        } else {
            right.push(Span::styled(format!(" {name}"), fg(t().muted)));
            right.push(Span::styled(format!(" {key} "), fg(t().faint)));
        }
        let end: usize = right.iter().map(|s| s.content.width()).sum();
        tabs.push((start, end - start, i as u8));
    }
    right.push(pad(1));
    let total: usize = right.iter().map(|s| s.content.width()).sum();
    let left_edge = area.right().saturating_sub(total as u16);
    frame.render_widget(
        Paragraph::new(Line::from(left)),
        Rect::new(area.x, area.y, left_edge.saturating_sub(area.x), 1),
    );
    for (start, width, tab) in tabs {
        target(
            app,
            Rect::new(left_edge + start as u16, area.y, width as u16, 1),
            Hit::Tab(tab),
        );
    }
    frame.render_widget(
        Paragraph::new(Line::from(right)),
        Rect::new(left_edge, area.y, total as u16, 1),
    );
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
        (Action::Fetch, "↻ Fetch".to_string(), "fetch"),
        (
            Action::Pull,
            format!("↓ Pull{}", count(sync.and_then(|s| s.behind))),
            "pull",
        ),
        (
            Action::Push,
            if upstream || sync.is_none() {
                format!("↑ Push{}", count(sync.and_then(|s| s.ahead)))
            } else {
                "↑ Publish".to_string()
            },
            "push",
        ),
        (Action::Stash, "▾ Stash".to_string(), "stash"),
        (
            Action::Pop,
            format!("▴ Pop{}", count(Some(app.stashes.len() as u64))),
            "pop",
        ),
    ];
    // Each button is its label, the ` key ` hint and a one-column gap.
    let mut fitted = Vec::new();
    let mut total = 0;
    for (action, label, key) in buttons {
        let key = app.keymap.label(key);
        let label = format!(" {label} ");
        let width = label.width() as u16;
        if total + width + key.width() as u16 + 4 > area.width {
            break;
        }
        total += width + key.width() as u16 + 3;
        fitted.push((action, label, key, width));
    }
    let mut x = area.x + area.width.saturating_sub(total.saturating_sub(1)) / 2;
    let mut spans = vec![pad(usize::from(x - area.x))];
    for (action, label, key, width) in fitted {
        let enabled = app.unavailable(action).is_none()
            && !app.writing
            && !matches!(
                app.view,
                View::Repositories | View::Profiles | View::ProfileEdit
            );
        let style = if enabled {
            Style::new().fg(t().text).bg(t().select)
        } else {
            fg(t().faint)
        };
        target(app, Rect::new(x, area.y, width, 1), Hit::Action(action));
        spans.push(Span::styled(label, style));
        spans.push(Span::styled(
            format!(" {key} "),
            fg(if enabled { t().muted } else { t().border }),
        ));
        spans.push(pad(1));
        x += width + key.width() as u16 + 3;
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn status_line(app: &App) -> Option<Line<'static>> {
    if app.quit {
        return Some(Line::from(vec![
            Span::styled(format!(" {} ", spinner()), fg(t().yellow)),
            Span::styled(
                "Finishing the running Git action before exit — cancelling is not a rollback.",
                fg(t().yellow),
            ),
        ]));
    }
    if app.writing {
        return Some(Line::from(vec![
            Span::styled(format!(" {} ", spinner()), fg(t().yellow)),
            Span::styled("Running Git…", fg(t().yellow)),
        ]));
    }
    if app.switching {
        return Some(Line::from(vec![
            Span::styled(format!(" {} ", spinner()), fg(t().accent)),
            Span::styled("Opening repository…", fg(t().muted)),
        ]));
    }
    if app.notice.is_empty() {
        return None;
    }
    let (mark, color) = match app.tone {
        Tone::Good => ("✓", t().green),
        Tone::Bad => ("✗", t().red),
        Tone::Info => ("•", t().accent),
    };
    Some(Line::from(vec![
        Span::styled(format!(" {mark} "), bold(color)),
        Span::styled(
            safe(&app.notice),
            fg(if app.tone == Tone::Bad {
                t().red
            } else {
                t().muted
            }),
        ),
    ]))
}

fn footer(app: &App, prompt: bool, width: usize) -> Line<'static> {
    if app.help && !prompt {
        return hints(&[("esc", "close help")], width);
    }
    let shown = app.keymap.shown(app, prompt);
    let mut keys: Vec<_> = shown
        .iter()
        .map(|(b, k)| (k.as_str(), b.label(app)))
        .collect();
    if !WRITES {
        keys.push(("", "read-only"));
    }
    hints(&keys, width)
}

fn help(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let rect = modal(frame, 100, area.height.saturating_sub(2));
    let block = dialog("Keys for this view").title_bottom(" Esc closes · navigation keys scroll ");
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let shown = app.keymap.shown(app, false);
    let start = app.help_scroll.min(shown.len().saturating_sub(1));
    let lines: Vec<_> = shown
        .iter()
        .skip(start)
        .map(|(binding, keys)| {
            Line::from(vec![
                Span::styled(format!("{keys:<18}"), bold(t().accent)),
                Span::raw(format!("{}  [{}]", binding.label(app), binding.name)),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

/// Draws one graph row. HEAD is a ringed node and merges are hollow, so the shape of the
/// history reads without colour.
fn lane_color(id: u8) -> Color {
    // Line 1 is the first branch drawn, usually the checked-out one.
    {
        let lanes = t().lanes;
        lanes[(usize::from(id) + lanes.len() - 1) % lanes.len()]
    }
}

/// Node shapes per commit kind; the selected commit's line stays bright and others dim.
struct Node {
    head: bool,
    merge: bool,
    stash: bool,
    root: bool,
}

/// Lines that carry on below a commit row, drawn on the spacer row under it.
fn continues(cell: &GraphCell, root: bool) -> bool {
    if cell.node {
        !root
    } else {
        matches!(cell.glyph, '│' | '╷' | '╮' | '╭' | '┤' | '├' | '┬' | '┼')
    }
}

/// Draws a commit row, or with `connector` the spacer row below it that joins it to the next.
fn graph_spans(
    row: &[GraphCell],
    width: usize,
    node: &Node,
    focus: Option<u8>,
    connector: bool,
) -> Vec<Span<'static>> {
    let mut spans: Vec<Span> = row
        .iter()
        .take(width)
        .enumerate()
        .map(|(x, cell)| {
            let color = lane_color(cell.color);
            if x + 1 == width && row.len() > width {
                return Span::styled(if connector { " " } else { "…" }, fg(t().muted));
            }
            let style = match focus {
                Some(line) if line != cell.color => fg(color).add_modifier(Modifier::DIM),
                Some(_) => bold(color),
                None => fg(color),
            };
            if connector {
                let glyph = if continues(cell, node.root) {
                    "│"
                } else {
                    " "
                };
                return Span::styled(glyph, style);
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
                format!(" {LOCAL_BRANCH} {} ", safe(name)),
                Style::new()
                    .fg(t().on_accent)
                    .bg(t().green)
                    .add_modifier(Modifier::BOLD),
            ),
            "local" => (format!("{LOCAL_BRANCH} {}", safe(name)), bold(t().green)),
            "remote" => (format!("{REMOTE_BRANCH} {}", safe(name)), fg(t().remote)),
            "tag" => (format!("◆ {}", safe(name)), bold(t().yellow)),
            _ => (format!("≡ {}", safe(name)), fg(t().purple)),
        };
        let w = text.width() + 1;
        if used + w > budget {
            let more = format!("+{}", sorted.len() - i);
            if used + more.width() < budget {
                used += more.width() + 1;
                spans.push(Span::styled(more, fg(t().muted)));
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
    if app.search_cancel.is_some() {
        title.push_str(&format!(
            " · Search {} · {}/{}",
            safe(&app.search_text),
            if app.matches.is_empty() {
                0
            } else {
                app.match_index + 1
            },
            app.matches.len()
        ));
    }
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
        empty(frame, inner, text, t().muted);
    } else {
        let height = usize::from(inner.height);
        let width = usize::from(inner.width);
        // Each commit takes a row plus a spacer row that joins it to the next one.
        let visible = height.div_ceil(2);
        let start = window(&app.tops[0], app.history, app.commits.len(), visible);
        let end = (start + visible).min(app.commits.len());
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
            let y = inner.y + 2 * (i - start) as u16;
            let rows = (inner.bottom() - y).min(2);
            target(
                app,
                Rect::new(inner.x, y, inner.width, rows),
                Hit::Commit(i),
            );
        }
        let lines: Vec<Line> = (start..end)
            .flat_map(|i| {
                let commit = &app.commits[i];
                let selected = i == app.history;
                let mut spans = vec![if selected {
                    Span::styled("▌", fg(t().accent))
                } else if app.matches.contains(&commit.id) {
                    Span::styled("*", bold(t().yellow))
                } else {
                    pad(1)
                }];
                let stash = app
                    .refs
                    .get(&commit.id)
                    .is_some_and(|refs| refs.iter().any(|(_, kind)| kind == "stash"));
                let node = Node {
                    head: head == Some(&commit.id),
                    merge: commit.parents.len() > 1 && !stash,
                    stash,
                    root: commit.parents.is_empty(),
                };
                let mut spacer = vec![spans[0].clone()];
                spacer.extend(graph_spans(&app.rows[i], graph, &node, focus, true));
                spacer.push(pad(width.saturating_sub(graph + 2)));
                spans.extend(graph_spans(&app.rows[i], graph, &node, focus, false));
                spans.push(Span::styled(
                    commit.id.get(..7).unwrap_or(&commit.id).to_string(),
                    fg(t().gold),
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
                        bold(t().text)
                    } else if merge {
                        fg(t().muted)
                    } else {
                        Style::new()
                    },
                ));
                spans.push(pad(room.saturating_sub(subject_width)));
                if show_author {
                    spans.push(Span::styled(
                        format!("{:>14} ", clip(&safe(&commit.author), 14)),
                        fg(t().muted),
                    ));
                }
                if show_date {
                    spans.push(Span::styled(
                        format!("{:>4} ", ago(commit.timestamp)),
                        fg(t().faint),
                    ));
                }
                let style = if selected {
                    Style::new().bg(t().select)
                } else {
                    Style::new()
                };
                [
                    Line::from(spans).style(style),
                    Line::from(spacer).style(style),
                ]
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
            None if selected.is_some() => empty(frame, inner, "Loading…", t().faint),
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
        Line::styled(safe(&c.subject), bold(t().text)),
        Line::raw(""),
        Line::from(vec![
            Span::styled(safe(&c.author), bold(t().muted)),
            Span::styled(format!(" <{}>", safe(&c.email)), fg(t().faint)),
            Span::styled(
                match ago(c.timestamp).as_str() {
                    "now" => " · just now".into(),
                    age => format!(" · {age} ago"),
                },
                fg(t().faint),
            ),
        ]),
        Line::from(vec![
            Span::styled(c.id.get(..12).unwrap_or(&c.id).to_string(), fg(t().gold)),
            Span::styled(
                match c.parents.len() {
                    0 => " · root commit".into(),
                    1 => String::new(),
                    n => format!(" · merge of {n} parents, diff vs first"),
                },
                fg(t().faint),
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
            bold(t().muted),
        ),
        Span::styled(format!("  +{add}"), fg(t().green)),
        Span::styled(format!(" −{del}"), fg(t().red)),
    ]));
    lines
}

fn status_style(code: &str) -> (&'static str, Color) {
    match code {
        "A" => ("added", t().green),
        "M" => ("modified", t().yellow),
        "D" => ("deleted", t().red),
        "R" => ("renamed", t().purple),
        "C" => ("copied", t().purple),
        "T" => ("type", t().cyan),
        "U" => ("conflict", t().red),
        "?" => ("new", t().green),
        _ => ("changed", t().muted),
    }
}

fn path_spans(path: &str, width: usize) -> Vec<Span<'static>> {
    let path = clip_left(&safe(path), width);
    match path.rfind('/') {
        Some(i) => vec![
            Span::styled(path[..=i].to_string(), fg(t().muted)),
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
        Span::styled(if selected { "▌" } else { " " }, fg(t().accent)),
        Span::styled(code.to_string(), bold(color)),
        pad(2),
    ];
    let path = path_spans(&label, room);
    let used: usize = path.iter().map(|s| s.content.width()).sum();
    spans.extend(path);
    spans.push(pad(room.saturating_sub(used) + 1));
    if file.binary {
        spans.push(Span::styled(stats, fg(t().faint)));
    } else {
        spans.push(Span::styled(
            format!("+{}", file.additions.unwrap_or(0)),
            fg(t().green),
        ));
        spans.push(Span::styled(
            format!(" −{}", file.deletions.unwrap_or(0)),
            fg(t().red),
        ));
    }
    let line = Line::from(spans);
    if selected {
        line.style(Style::new().bg(t().select))
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
    let title = app.stash_detail.as_ref().map_or_else(
        || format!("Files · {}", files.len()),
        |(_, untracked)| {
            format!(
                "Stash {} files · {}",
                if *untracked { "untracked" } else { "tracked" },
                files.len()
            )
        },
    );
    let block = panel(title, true);
    let inner = block.inner(bottom);
    frame.render_widget(block, bottom);
    if files.is_empty() {
        empty(frame, inner, "No file changes", t().muted);
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
        return ("conflict", t().red);
    }
    if entry.untracked {
        return ("new", t().green);
    }
    let code = if staged {
        &entry.index_status
    } else {
        &entry.worktree_status
    };
    status_style(code.get(..1).unwrap_or("."))
}

fn branches(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel("Branches · ahead/behind HEAD (local refs)", true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if app.branches.is_empty() {
        empty(
            frame,
            inner,
            "No branches yet · create one from a commit in history",
            t().muted,
        );
        return;
    }
    let start = window(
        &app.tops[1],
        app.branch,
        app.branches.len(),
        usize::from(inner.height),
    );
    let lines: Vec<_> = app
        .branches
        .iter()
        .enumerate()
        .skip(start)
        .take(usize::from(inner.height))
        .map(|(i, branch)| {
            let counts = branch
                .counts
                .map_or("↑? ↓?".into(), |(a, b)| format!("↑{a} ↓{b}"));
            let text = format!(
                "{} {} {}  {counts}",
                if branch.current { "*" } else { " " },
                if branch.reference.kind == "local" {
                    "local "
                } else {
                    "remote"
                },
                safe(&branch.reference.name)
            );
            Line::styled(
                clip(&text, usize::from(inner.width)),
                if i == app.branch {
                    bold(t().text).bg(t().select)
                } else {
                    fg(t().muted)
                },
            )
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn stashes(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel(format!("Stashes · {}", app.stashes.len()), true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if app.stashes.is_empty() {
        empty(frame, inner, "No stashes", t().muted);
        return;
    }
    let start = window(
        &app.tops[1],
        app.stash,
        app.stashes.len(),
        usize::from(inner.height),
    );
    let lines: Vec<_> = app
        .stashes
        .iter()
        .enumerate()
        .skip(start)
        .take(usize::from(inner.height))
        .map(|(i, stash)| {
            Line::styled(
                clip(
                    &format!(
                        "{}  {}  {}",
                        safe(&stash.selector),
                        stash.oid.get(..7).unwrap_or(&stash.oid),
                        safe(&stash.message)
                    ),
                    usize::from(inner.width),
                ),
                if i == app.stash {
                    bold(t().text).bg(t().select)
                } else {
                    fg(t().muted)
                },
            )
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn input(frame: &mut Frame, app: &App) {
    let (title, source, value) = if app.view == View::Search {
        (
            "Search history",
            "Message, author, OID or ref".to_owned(),
            app.search_text.as_str(),
        )
    } else {
        let Some(editor) = &app.branch_editor else {
            return;
        };
        (
            if editor.tag {
                "Create tag"
            } else if editor.rename {
                "Rename branch"
            } else {
                "Create branch"
            },
            format!("From: {}", safe(&editor.source)),
            editor.name.as_str(),
        )
    };
    let rect = modal(frame, 76, 10);
    let block = dialog(title);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let value = clip_left(&safe(value), usize::from(inner.width.saturating_sub(2)));
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled(source, fg(t().muted)),
            Line::raw(""),
            Line::styled(format!("{value}▏"), bold(t().text)),
        ])
        .wrap(Wrap { trim: false }),
        inner,
    );
}

fn conflicts(frame: &mut Frame, area: Rect, app: &App) {
    let files = app
        .operation
        .as_ref()
        .map(|o| o.conflicts.as_slice())
        .unwrap_or_default();
    let block = panel(format!("Conflicts · {}", files.len()), true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if files.is_empty() {
        empty(frame, inner, "No unresolved conflicts", t().green);
        return;
    }
    let start = window(
        &app.tops[1],
        app.conflict_index,
        files.len(),
        usize::from(inner.height),
    );
    let lines: Vec<_> = files
        .iter()
        .enumerate()
        .skip(start)
        .take(usize::from(inner.height))
        .map(|(i, path)| {
            Line::styled(
                safe(path),
                if i == app.conflict_index {
                    bold(t().text).bg(t().select)
                } else {
                    fg(t().muted)
                },
            )
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn version_lines(label: &str, version: Option<&ConflictVersion>) -> Vec<Line<'static>> {
    let mut lines = vec![Line::styled(safe(label), bold(t().accent))];
    match version {
        None => lines.push(Line::raw("(Absent / deleted)")),
        Some(version) => {
            lines.push(Line::styled(
                format!("{} · mode {}", version.oid, version.mode),
                fg(t().muted),
            ));
            match &version.content {
                Some(content) => lines.extend(content.lines().map(|line| Line::raw(safe(line)))),
                None => lines.push(Line::raw("(Binary or content exceeds preview bounds)")),
            }
        }
    }
    lines
}

pub(super) fn conflict_lines(file: &ConflictFile, side: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if side != 2 {
        lines.extend(version_lines(&file.ours_label, file.ours.as_ref()));
    }
    if side == 0 {
        lines.push(Line::raw(""));
    }
    if side != 1 {
        lines.extend(version_lines(&file.theirs_label, file.theirs.as_ref()));
    }
    lines
}

fn rebase_plan(frame: &mut Frame, area: Rect, app: &App) {
    let Some(super::OperationRequest {
        action: GitAction::InteractiveRebase { steps, .. },
        ..
    }) = &app.plan
    else {
        return;
    };
    let block = panel("Interactive rebase · oldest first", true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let start = window(
        &app.tops[1],
        app.plan_row,
        steps.len(),
        usize::from(inner.height),
    );
    let lines: Vec<_> = steps
        .iter()
        .enumerate()
        .skip(start)
        .take(usize::from(inner.height))
        .map(|(i, step)| {
            Line::styled(
                clip(
                    &format!(
                        "{:<7} {} {}",
                        step.instruction.git(),
                        step.oid.get(..7).unwrap_or(&step.oid),
                        safe(app.plan_subjects.get(&step.oid).map_or("", String::as_str))
                    ),
                    usize::from(inner.width),
                ),
                if i == app.plan_row {
                    bold(t().text).bg(t().select)
                } else {
                    fg(t().muted)
                },
            )
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn message_editor(frame: &mut Frame, app: &App) {
    let Some(message) = &app.editor_message else {
        return;
    };
    let area = frame.area();
    let rect = modal(
        frame,
        area.width.saturating_sub(2),
        area.height.saturating_sub(4),
    );
    let block =
        dialog(format!("Edit Git message · {}", safe(&message.name))).title_bottom(format!(
            " {} saves · {} clears · Esc cancels Git's editor ",
            app.keymap.label("save_message"),
            app.keymap.label("clear")
        ));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let lines: Vec<_> = message
        .content
        .split('\n')
        .map(|l| Line::raw(safe(l)))
        .collect();
    let skip = lines.len().saturating_sub(usize::from(inner.height));
    frame.render_widget(
        Paragraph::new(lines.into_iter().skip(skip).collect::<Vec<_>>()),
        inner,
    );
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
                bold(t().accent).add_modifier(Modifier::UNDERLINED),
            )
        } else {
            Span::styled(format!(" {name} {n} "), fg(t().muted))
        }
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(fg(t().accent))
        .title(Line::from(vec![
            tab("Unstaged", unstaged, !app.staged),
            Span::styled("│", fg(t().border)),
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
            (true, _) => ("✓ Working tree clean", t().green),
            (false, true) => ("Nothing staged · switch lists to stage changes", t().muted),
            (false, false) => ("Everything is staged · ready to commit", t().green),
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
                    Span::styled(if selected { "▌" } else { " " }, fg(t().accent)),
                    Span::styled(format!("{label:<9}"), fg(color)),
                ];
                spans.extend(path_spans(&path, width.saturating_sub(11)));
                let used: usize = spans.iter().map(|s| s.content.width()).sum();
                spans.push(pad(width.saturating_sub(used)));
                let line = Line::from(spans);
                if selected {
                    line.style(Style::new().bg(t().select))
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
        let mut title = vec![
            Span::styled(format!(" +{add}"), fg(t().green)),
            Span::styled(format!(" −{del} "), fg(t().red)),
        ];
        if app.working_diff() {
            if let Some((index, _)) = super::diff_position(diff, app.scroll) {
                let label = app.selected_lines().map_or_else(
                    || format!(" hunk {}/{} ", index + 1, diff.hunks.len()),
                    |lines| format!(" {} lines selected ", lines.len()),
                );
                title.insert(0, Span::styled(label, bold(t().accent)));
            }
        }
        if app.hscroll > 0 {
            title.insert(
                0,
                Span::styled(format!(" ◂ +{}", app.hscroll), fg(t().muted)),
            );
        }
        block = block.title(Line::from(title).right_aligned());
    }
    let inner = block.inner(area);
    frame.render_widget(block, area);
    match diff {
        Some(diff) => {
            let selecting = app.working_diff();
            let mut lines = diff_lines(
                diff,
                usize::from(inner.width).saturating_sub(usize::from(selecting)),
                app.hscroll,
            );
            if selecting {
                for (row, line) in lines.iter_mut().enumerate() {
                    let selected = app.line_anchor.is_some_and(|anchor| {
                        (anchor.min(app.scroll)..=anchor.max(app.scroll)).contains(&row)
                            && super::diff_position(diff, row).is_some_and(|(h, i)| {
                                i.is_some_and(|i| {
                                    matches!(diff.hunks[h].lines[i].kind.as_str(), "add" | "remove")
                                })
                            })
                    });
                    line.spans.insert(
                        0,
                        Span::styled(
                            if row == app.scroll {
                                "▌"
                            } else if selected {
                                "*"
                            } else {
                                " "
                            },
                            bold(t().accent),
                        ),
                    );
                    if selected {
                        for span in &mut line.spans {
                            span.style = span.style.add_modifier(Modifier::UNDERLINED);
                        }
                    }
                }
            }
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
                empty(frame, inner, &text, t().muted);
            } else {
                let height = usize::from(inner.height);
                let mut visible: Vec<Line> = lines.into_iter().skip(scroll).take(height).collect();
                if diff.truncated && visible.len() < height {
                    visible.push(Line::styled("… preview limit reached", fg(t().yellow)));
                }
                frame.render_widget(Paragraph::new(visible), inner);
            }
        }
        None if path.is_some() && app.wide || app.view == View::Diff => {
            empty(frame, inner, "Loading…", t().faint)
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

/// The changed character ranges of an edited line pair, after trimming their shared start and
/// end and widening to whole words. `None` when too little is shared to be worth marking.
fn changed(old: &[char], new: &[char]) -> Option<((usize, usize), (usize, usize))> {
    let word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric() || *c == '_');
    let mut pre = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    while pre > 0 && word(old.get(pre - 1)) && (word(old.get(pre)) || word(new.get(pre))) {
        pre -= 1;
    }
    let shortest = old.len().min(new.len()) - pre;
    let mut suf = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(shortest)
        .take_while(|(a, b)| a == b)
        .count();
    while suf > 0
        && word(old.get(old.len() - suf))
        && (word(old.len().checked_sub(suf + 1).and_then(|i| old.get(i)))
            || word(new.len().checked_sub(suf + 1).and_then(|i| new.get(i))))
    {
        suf -= 1;
    }
    if (pre + suf) * 3 < old.len().max(new.len()) {
        return None;
    }
    Some(((pre, old.len() - suf), (pre, new.len() - suf)))
}

/// Cuts `skip` columns off the front and keeps `width` columns, split into runs by whether
/// each character falls inside `mark`.
fn columns(
    text: &[char],
    mark: Option<(usize, usize)>,
    skip: usize,
    width: usize,
) -> Vec<(String, bool)> {
    let mut runs: Vec<(String, bool)> = Vec::new();
    let (mut at, mut used) = (0, 0);
    for (i, &c) in text.iter().enumerate() {
        let w = c.width().unwrap_or(0);
        let start = at;
        at += w;
        // Characters before the pan, including a wide one cut by it, are hidden.
        if start < skip {
            continue;
        }
        if used + w > width {
            break;
        }
        used += w;
        let marked = mark.is_some_and(|(a, b)| (a..b).contains(&i));
        match runs.last_mut() {
            Some((run, m)) if *m == marked => run.push(c),
            _ => runs.push((c.to_string(), marked)),
        }
    }
    runs
}

/// The widest line of `diff`, in columns, as drawn.
pub(super) fn widest(diff: &FileDiff) -> usize {
    diff.hunks
        .iter()
        .flat_map(|h| &h.lines)
        .map(|l| safe(&l.content.replace('\t', "    ")).width())
        .max()
        .unwrap_or(0)
}

fn hunk_bar(header: &str, width: usize) -> Line<'static> {
    let header = safe(header);
    let split = header
        .strip_prefix("@@")
        .and_then(|rest| rest.find("@@"))
        .map_or(header.len(), |i| i + 4);
    let (ranges, context) = header.split_at(split);
    let ranges = clip(ranges, width.saturating_sub(1));
    let context = clip(context, width.saturating_sub(1 + ranges.width()));
    let used = 1 + ranges.width() + context.width();
    Line::from(vec![
        pad(1),
        Span::styled(ranges, fg(t().cyan)),
        Span::styled(context, bold(t().text)),
        pad(width.saturating_sub(used)),
    ])
    .style(Style::new().bg(t().hunk_bg))
}

/// Diff rows `width` columns wide: a line-number gutter, then content panned by `hscroll`.
/// Added and removed lines are tinted, with the edited words of a changed line tinted harder.
pub(super) fn diff_lines(diff: &FileDiff, width: usize, hscroll: usize) -> Vec<Line<'static>> {
    let max = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter_map(|l| l.old_line.max(l.new_line))
        .max()
        .unwrap_or(0);
    let digits = max.to_string().len().max(3);
    let number = |n: Option<u64>| n.map_or(" ".repeat(digits), |n| format!("{n:>digits$}"));
    let room = width.saturating_sub(2 * digits + 5);
    let mut lines = Vec::new();
    for (i, hunk) in diff.hunks.iter().enumerate() {
        if i > 0 {
            lines.push(Line::raw(""));
        }
        lines.push(hunk_bar(&hunk.header, width));
        let texts: Vec<Vec<char>> = hunk
            .lines
            .iter()
            .map(|l| safe(&l.content.replace('\t', "    ")).chars().collect())
            .collect();
        let kind = |k: usize| hunk.lines[k].kind.as_str();
        // Pair each run of removed lines with the added lines right after it, in order.
        let mut marks = vec![None; texts.len()];
        let mut k = 0;
        while k < texts.len() {
            if kind(k) != "remove" {
                k += 1;
                continue;
            }
            let removed = k;
            while k < texts.len() && kind(k) == "remove" {
                k += 1;
            }
            let added = k;
            while k < texts.len() && kind(k) == "add" {
                k += 1;
            }
            for j in 0..(added - removed).min(k - added) {
                if let Some((a, b)) = changed(&texts[removed + j], &texts[added + j]) {
                    marks[removed + j] = Some(a);
                    marks[added + j] = Some(b);
                }
            }
        }
        for (j, line) in hunk.lines.iter().enumerate() {
            let (sign, color, tint, strong) = match line.kind.as_str() {
                "add" => ("+", t().green, Some(t().add_bg), t().add_word),
                "remove" => ("−", t().red, Some(t().del_bg), t().del_word),
                _ => (" ", t().faint, None, t().select),
            };
            let base = match (tint, line.kind.as_str()) {
                (Some(bg), _) => Style::new().bg(bg),
                (None, "context") => Style::new(),
                _ => fg(t().faint).add_modifier(Modifier::ITALIC),
            };
            let mut spans = vec![
                Span::styled(
                    format!("{} {} ", number(line.old_line), number(line.new_line)),
                    fg(t().faint),
                ),
                Span::styled(format!(" {sign} "), base.patch(bold(color))),
            ];
            let mut used = 0;
            for (text, marked) in columns(&texts[j], marks[j], hscroll, room) {
                used += text.width();
                spans.push(Span::styled(
                    text,
                    if marked { base.bg(strong) } else { base },
                ));
            }
            spans.push(Span::styled(" ".repeat(room.saturating_sub(used)), base));
            lines.push(Line::from(spans));
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
        empty(frame, inner, "Loading…", t().faint);
        return;
    };
    let key = |k: &str| Span::styled(format!("{k:<11}"), fg(t().muted));
    let mut lines = vec![
        Line::from(vec![
            key("Branch"),
            Span::styled(
                safe(sync.branch.as_deref().unwrap_or("detached HEAD")),
                bold(t().green),
            ),
        ]),
        Line::from(vec![
            key("Upstream"),
            match &sync.upstream {
                Some(upstream) => Span::styled(safe(upstream), fg(t().remote)),
                None => Span::styled("none · publish to set one", fg(t().faint)),
            },
        ]),
    ];
    if sync.upstream.is_some() {
        let (ahead, behind) = (sync.ahead.unwrap_or(0), sync.behind.unwrap_or(0));
        lines.push(Line::from(vec![
            key("Status"),
            Span::styled(
                format!("↑ {ahead} to push"),
                fg(if ahead > 0 { t().yellow } else { t().muted }),
            ),
            Span::styled("   ", fg(t().faint)),
            Span::styled(
                format!("↓ {behind} to pull"),
                fg(if behind > 0 { t().cyan } else { t().muted }),
            ),
            Span::styled("   as of the last fetch", fg(t().faint)),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::styled("Remotes", bold(t().muted)));
    if sync.remotes.is_empty() {
        lines.push(Line::styled("  No remotes configured", fg(t().faint)));
    }
    for (i, remote) in sync.remotes.iter().enumerate() {
        let selected = i == app.remote;
        let line = Line::from(vec![
            Span::styled(if selected { "▌ " } else { "  " }, fg(t().accent)),
            Span::styled(
                safe(remote),
                if selected {
                    bold(t().text)
                } else {
                    fg(t().muted)
                },
            ),
        ]);
        lines.push(if selected {
            line.style(Style::new().bg(t().select))
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
            fg(t().faint),
        ));
    } else if app.uncertain.is_some() {
        lines.push(Line::from(vec![
            Span::styled("! ", bold(t().yellow)),
            Span::styled(
                format!("The last push could not be confirmed. Press {} to check the destination before pushing again.", app.keymap.label("verify")),
                fg(t().yellow),
            ),
        ]));
    } else {
        let action = |k: &str, label: &str| {
            vec![
                Span::styled(
                    format!(" {} ", app.keymap.label(k)),
                    Style::new().fg(t().on_accent).bg(t().accent),
                ),
                Span::styled(format!(" {label}    "), fg(t().muted)),
            ]
        };
        let mut actions = vec![action("fetch", "Fetch")];
        if sync.upstream.is_some() {
            actions.push(action("pull", "Pull (fast-forward)"));
            actions.push(action("push", "Push"));
        } else if sync.branch.is_some() {
            actions.push(action("publish", "Publish"));
        }
        lines.push(Line::from(actions.concat()));
        lines.push(Line::raw(""));
        lines.push(Line::styled(
            "Every action is reviewed before it runs. Fetch never prunes.",
            fg(t().faint),
        ));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn settings(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel("Settings", true).padding(Padding::new(2, 2, 0, 0));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let themes = theme::themes();
    let [list, sample] = if inner.width >= 70 {
        Layout::horizontal([Constraint::Length(30), Constraint::Min(30)]).areas(inner)
    } else {
        let rows = (themes.len() as u16 + 3).min(inner.height);
        Layout::vertical([Constraint::Length(rows), Constraint::Min(0)]).areas(inner)
    };
    let mut lines = vec![
        Line::styled(
            format!("{} → Commit Profiles", app.keymap.label("profiles")),
            bold(t().accent),
        ),
        Line::styled("Theme", bold(t().muted)),
    ];
    if list.height > 0 {
        target(
            app,
            Rect::new(list.x, list.y, list.width, 1),
            Hit::ProfilePage,
        );
    }
    let start = app
        .settings
        .saturating_sub(usize::from(list.height.saturating_sub(3)));
    for (i, theme) in themes.iter().enumerate().skip(start) {
        let selected = i == app.settings;
        let y = list.y + lines.len() as u16;
        if y < list.bottom() {
            target(app, Rect::new(list.x, y, list.width, 1), Hit::Setting(i));
        }
        let line = Line::from(vec![
            Span::styled(if selected { "▌ " } else { "  " }, fg(t().accent)),
            Span::styled(
                format!("{:<20}", theme.name),
                if selected {
                    bold(t().text)
                } else {
                    fg(t().muted)
                },
            ),
            Span::styled(if i == app.theme { "✓" } else { " " }, fg(t().green)),
        ]);
        lines.push(if selected {
            line.style(Style::new().bg(t().select))
        } else {
            line
        });
    }
    frame.render_widget(Paragraph::new(lines), list);

    let lanes: Vec<Span> = t()
        .lanes
        .iter()
        .flat_map(|&c| [Span::styled("●", bold(c)), Span::styled("──", fg(c))])
        .collect();
    let word = |text: &str, bg: Color| Span::styled(text.to_string(), Style::new().bg(bg));
    let mut lines = vec![
        Line::styled("Preview", bold(t().muted)),
        Line::raw(""),
        Line::from(lanes),
        Line::raw(""),
        Line::from(vec![
            Span::styled(
                format!(" {LOCAL_BRANCH} main "),
                Style::new()
                    .fg(t().on_accent)
                    .bg(t().green)
                    .add_modifier(Modifier::BOLD),
            ),
            pad(1),
            Span::styled(format!("{REMOTE_BRANCH} origin/main"), fg(t().remote)),
            pad(1),
            Span::styled("◆ v1.0", bold(t().yellow)),
            pad(2),
            Span::styled(
                format!(" {} ", app.keymap.label("apply_setting")),
                Style::new().fg(t().on_accent).bg(t().accent),
            ),
        ]),
        Line::raw(""),
        Line::from(vec![
            pad(1),
            Span::styled("@@ -4 +4 @@ ", fg(t().cyan)),
            Span::styled("fn greet", bold(t().text)),
        ])
        .style(Style::new().bg(t().hunk_bg)),
        Line::from(vec![
            Span::styled(" − ", bold(t().red)),
            word("let name = ", t().del_bg),
            word("\"world\"", t().del_word),
            word(";", t().del_bg),
        ])
        .style(Style::new().bg(t().del_bg)),
        Line::from(vec![
            Span::styled(" + ", bold(t().green)),
            word("let name = ", t().add_bg),
            word("\"gitty\"", t().add_word),
            word(";", t().add_bg),
        ])
        .style(Style::new().bg(t().add_bg)),
        Line::raw(""),
    ];
    if t().bg.is_some() && !theme::truecolor() {
        lines.push(Line::styled(
            "Shown with 256 colours; set COLORTERM=truecolor for exact colours.",
            fg(t().faint),
        ));
    }
    if let Some(path) = &app.config_path {
        lines.push(Line::styled(
            format!("Saved to {}", safe(&path.to_string_lossy())),
            fg(t().faint),
        ));
    }
    let keys = match &app.config.keys {
        super::keys::KeyConfig::Preset(name) => name.as_str(),
        super::keys::KeyConfig::Map(map) if map.is_empty() => "defaults",
        _ => "custom",
    };
    lines.push(Line::styled(
        format!(
            "Keys: {keys} · edit keys in tui.json; {} for help",
            app.keymap.label("help")
        ),
        fg(t().muted),
    ));
    if let Some(error) = &app.config_error {
        lines.push(Line::styled(
            format!("Settings unchanged: {}", safe(error)),
            fg(t().red),
        ));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), sample);
}

fn choice(frame: &mut Frame, area: Rect, text: &str, selected: bool) {
    let mark = if selected { "▌ " } else { "  " };
    let text = clip(text, usize::from(area.width.saturating_sub(2)));
    let line = Line::from(vec![Span::styled(mark, fg(t().accent)), Span::raw(text)]);
    let style = if selected {
        bold(t().text).bg(t().select)
    } else {
        fg(t().muted)
    };
    frame.render_widget(Paragraph::new(line).style(style), area);
}

fn repositories(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel("Repositories", true).padding(Padding::horizontal(2));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 {
        return;
    }
    let path = safe(&app.repo_path);
    let input = if path.is_empty() {
        "Enter a local repository path…".into()
    } else {
        clip_left(&path, usize::from(inner.width.saturating_sub(3)))
    };
    let row = Rect::new(inner.x, inner.y, inner.width, 1);
    choice(frame, row, &input, app.repo_selection == 0);
    target(app, row, Hit::Repository(0));
    if app.repo_selection == 0 && !app.switching && inner.width >= 3 {
        let end = if path.is_empty() {
            0
        } else {
            input.width() as u16
        };
        frame.set_cursor_position((row.x + 2 + end, row.y));
    }
    if inner.height < 2 {
        return;
    }
    let label = if app.config.recent.is_empty() {
        "No recent repositories"
    } else {
        "Recent repositories"
    };
    frame.render_widget(
        Paragraph::new(label).style(bold(t().muted)),
        Rect::new(inner.x, inner.y + 1, inner.width, 1),
    );
    let available = usize::from(inner.height - 2);
    let start = app.repo_selection.saturating_sub(available);
    for (row, (i, path)) in app
        .config
        .recent
        .iter()
        .enumerate()
        .skip(start)
        .take(available)
        .enumerate()
    {
        let active = app.root() == Some(path.as_str());
        let path = clip_left(&safe(path), usize::from(inner.width.saturating_sub(4)));
        let text = format!("{} {path}", if active { "✓" } else { " " });
        let row = Rect::new(inner.x, inner.y + 2 + row as u16, inner.width, 1);
        choice(frame, row, &text, app.repo_selection == i + 1);
        target(app, row, Hit::Repository(i + 1));
    }
}

fn profiles(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel("Settings · Commit Profiles", true).padding(Padding::horizontal(2));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if let Some(editor) = &app.profile_editor {
        for (i, label) in ["Profile label", "Author name", "Email"]
            .into_iter()
            .enumerate()
            .take(usize::from(inner.height))
        {
            let row = Rect::new(inner.x, inner.y + i as u16, inner.width, 1);
            let label = format!("{label:<14} ");
            let value = clip_left(
                &safe(&editor.values[i]),
                usize::from(inner.width).saturating_sub(label.width() + 3),
            );
            choice(frame, row, &format!("{label}{value}"), editor.field == i);
            target(app, row, Hit::ProfileField(i));
            if editor.field == i && usize::from(inner.width) > label.width() + 2 {
                frame.set_cursor_position((
                    row.x + (2 + label.width() + value.width()) as u16,
                    row.y,
                ));
            }
        }
        return;
    }
    if inner.height == 0 {
        return;
    }
    let assigned = app.selected_profile();
    let title = app.state.as_ref().map_or_else(
        || "Open a repository to assign a profile.".into(),
        |s| {
            format!(
                "{}: {}",
                safe(&s.session.name),
                assigned.map_or("Use Git default".into(), |p| safe(&p.label))
            )
        },
    );
    frame.render_widget(
        Paragraph::new(clip(&title, usize::from(inner.width))).style(bold(t().accent)),
        Rect::new(inner.x, inner.y, inner.width, 1),
    );
    let available = usize::from(inner.height - 1);
    let start = (app.profile_selection + 1).saturating_sub(available);
    let choices = std::iter::once((assigned.is_none(), "Use Git default".into())).chain(
        app.config.profiles.iter().map(|p| {
            (
                assigned.is_some_and(|selected| selected.id == p.id),
                format!(
                    "{} · {} <{}>",
                    safe(&p.label),
                    safe(&p.name),
                    safe(&p.email)
                ),
            )
        }),
    );
    for (row, (i, (active, text))) in choices.enumerate().skip(start).take(available).enumerate() {
        let row = Rect::new(inner.x, inner.y + 1 + row as u16, inner.width, 1);
        choice(
            frame,
            row,
            &format!("{} {text}", if active { "✓" } else { " " }),
            i == app.profile_selection,
        );
        target(app, row, Hit::Profile(i));
    }
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
    let title = if app.amend {
        format!(
            "Amend {} on {branch}",
            review.head().unwrap_or("").get(..7).unwrap_or("")
        )
    } else {
        format!("Commit to {branch}")
    };
    let block = dialog(title).title_bottom(
        Line::styled(
            format!(" summary {summary}/72 "),
            fg(if summary > 72 { t().yellow } else { t().faint }),
        )
        .right_aligned(),
    );
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let files = review.files();
    let list_height = (files
        .len()
        .saturating_add(2)
        .min(usize::from(inner.height / 3)) as u16)
        .max(3);
    let [list, gap, editor] = Layout::vertical([
        Constraint::Length(list_height),
        Constraint::Length(1),
        Constraint::Min(3),
    ])
    .areas(inner);
    let identity = review.identity().map_or_else(
        || "Commit as: Git default".into(),
        |id| format!("Commit as: {} <{}>", safe(&id.name), safe(&id.email)),
    );
    let mut lines = vec![
        Line::styled(clip(&identity, usize::from(list.width)), bold(t().accent)),
        Line::styled(
            format!(
                "Staged · {} file{}",
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ),
            bold(t().muted),
        ),
    ];
    lines.extend(
        files
            .iter()
            .skip(app.scroll)
            .map(|f| file_line(f, usize::from(list.width), false)),
    );
    frame.render_widget(Paragraph::new(lines), list);
    frame.render_widget(
        Paragraph::new(Line::styled(
            "─".repeat(usize::from(gap.width)),
            fg(t().border),
        )),
        gap,
    );
    let text: Vec<Line> = if app.message.is_empty() {
        vec![Line::styled(
            " Summary of the change, then a blank line and details",
            fg(t().faint),
        )]
    } else {
        app.message
            .split('\n')
            .enumerate()
            .map(|(i, line)| {
                let text = safe(&line.replace('\t', "    "));
                if i == 0 {
                    Line::styled(text, bold(t().text))
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
        Some(Confirm::Resolve(file, resolution)) => {
            let (label, version) = match resolution {
                ConflictResolution::Ours => (file.ours_label.as_str(), file.ours.as_ref()),
                ConflictResolution::Theirs => (file.theirs_label.as_str(), file.theirs.as_ref()),
                _ => ("Delete the file", None),
            };
            let mut lines = vec![
                format!("File: {}", file.path),
                format!("Resolution: {label}"),
                "Replace this file's working resolution and stage the selected version.".into(),
            ];
            lines.extend(
                version_lines(label, version)
                    .iter()
                    .map(ToString::to_string),
            );
            text_review(frame, app, "Resolve conflict", lines);
        }
        Some(Confirm::Operation(review)) => {
            let (title, mut lines) = match &review.action {
                GitAction::InteractiveRebase { onto, steps } => {
                    let mut lines = vec![format!("Base: {onto}"), "Rewrite HEAD using this exact order; messages are edited in the TUI.".into()];
                    lines.extend(steps.iter().map(|step| format!("{} {} {}", step.instruction.git(), step.oid,
                        app.plan_subjects.get(&step.oid).map_or("", String::as_str))));
                    ("Review interactive rebase", lines)
                }
                GitAction::Merge { source, stash_changes, .. } => ("Merge", vec![
                    format!("Source: {source}"),
                    "Merge into the reviewed HEAD branch; may leave conflicts.".into(),
                    format!("Stash local work: {} ({} toggles; restore staging after merge)",
                        if *stash_changes { "yes" } else { "no" }, app.keymap.label("merge_stash")),
                ]),
                GitAction::Rebase { onto } => ("Rebase", vec![
                    format!("Onto: {onto}"), "Replay the current branch; commit IDs will change.".into(),
                ]),
                GitAction::CherryPick { commits, .. } => ("Cherry-pick", vec![
                    format!("Commit: {}", commits.join(", ")), "Apply this commit on the reviewed HEAD. Merge commits require a mainline in Git.".into(),
                ]),
                GitAction::CreateTag { name, oid, .. } => ("Create tag", vec![
                    format!("Name: {name}"), format!("Commit: {oid}"), "Create a lightweight local tag.".into(),
                ]),
                GitAction::Continue => ("Continue operation", vec!["Continue with the reviewed resolutions and index.".into()]),
                GitAction::Skip => ("Skip commit", vec!["Discard this replayed commit and its resolution progress.".into()]),
                GitAction::Abort => ("Abort operation", vec!["Stop the operation and discard its resolution progress.".into()]),
                GitAction::SwitchBranch { branch, .. } => (
                    "Checkout branch",
                    vec![
                        format!("Destination: {branch}"),
                        "Update HEAD, index and working files. Requires a clean worktree.".into(),
                    ],
                ),
                GitAction::CreateBranch {
                    name, start_point, ..
                } => (
                    "Create branch",
                    vec![
                        format!("Name: {name}"),
                        format!("Starting point: {start_point}"),
                        "Create the branch without checking it out.".into(),
                    ],
                ),
                GitAction::RenameBranch { branch, name } => (
                    "Rename branch",
                    vec![
                        format!("From: {branch}"),
                        format!("New name: {name}"),
                        "Rename the local ref, reflog and branch configuration.".into(),
                    ],
                ),
                _ => return,
            };
            lines.push(format!(
                "Reviewed HEAD: {} ({})",
                review.expected_head_ref.as_deref().unwrap_or("detached"),
                review.expected_head.as_deref().unwrap_or("unborn")
            ));
            text_review(frame, app, title, lines);
        }
        Some(Confirm::Delete(review)) => {
            let mut lines = vec![];
            for branch in &review.branches {
                lines.push(format!(
                    "Delete {} branch: {}",
                    if review.delete_origin {
                        "origin"
                    } else {
                        "local"
                    },
                    branch.branch
                ));
                lines.push(format!(
                    "Reviewed commit: {}",
                    branch
                        .expected_local_oid
                        .as_deref()
                        .or(branch.expected_origin_oid.as_deref())
                        .unwrap_or("")
                ));
            }
            if let Some(url) = &review.expected_push_url {
                lines.push(format!(
                    "Push endpoint: {}",
                    gitty_core::remote::endpoint_label(url)
                ));
                lines.push(
                    "Remove refs/heads/<branch> from origin using the reviewed OID lease.".into(),
                );
            } else {
                lines.push("Safe deletion only; unmerged branches are refused.".into());
            }
            text_review(frame, app, "Delete branch", lines);
        }
        Some(Confirm::StoredStash(review)) => {
            let mut lines = vec![
                format!("{}: {}", review.entry.selector, review.entry.message),
                format!("Reviewed stash: {}", review.entry.oid),
            ];
            if review.verb == StashVerb::Drop {
                lines.push("Permanently remove this entire stash, including its index and untracked files.".into());
            } else {
                lines.push(format!("Destination: {}", review.destination));
                lines.push(format!(
                    "Restore index: {} ({} toggles)",
                    if review.restore_index { "yes" } else { "no" },
                    app.keymap.label("restore_index"),
                ));
                lines.push(if review.verb == StashVerb::Pop {
                    "Apply, then remove this stash only after successful restoration.".into()
                } else {
                    "Apply this stash and keep it in the list.".into()
                });
            }
            text_review(frame, app, &format!("Stash {}", review.verb.label()), lines);
        }
        Some(Confirm::StageAll(reviews)) => {
            let area = frame.area();
            let rect = modal(frame, area.width * 17 / 20, area.height * 17 / 20);
            let verb = if reviews.first().is_some_and(|r| r.is_unstage()) {
                "Unstage"
            } else {
                "Stage"
            };
            let block = dialog(format!("{verb} all · {} reviewed files", reviews.len()));
            let inner = block.inner(rect);
            frame.render_widget(block, rect);
            let lines: Vec<_> = reviews
                .iter()
                .flat_map(|r| r.paths())
                .skip(app.scroll)
                .map(|path| Line::raw(safe(path)))
                .collect();
            frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
        }
        Some(Confirm::Hunk(review)) => {
            let label = review.lines.as_ref().map_or_else(
                || format!("hunk {}", review.index + 1),
                |lines| {
                    format!(
                        "{} selected lines in hunk {}",
                        lines.len(),
                        review.index + 1
                    )
                },
            );
            let title = format!("{} {label}", review.kind.verb());
            let warning = if review.kind == HunkKind::Discard {
                "Permanently lose this entire unstaged hunk. Staged content stays."
            } else {
                "Only the changes shown below will be applied to the index."
            };
            patch_review(frame, app, &title, warning, &review.preview);
        }
        Some(Confirm::Discard(review)) => {
            let warning = if review.untracked {
                if review.delete_confirmed {
                    format!(
                        "Deletion allowed. {} permanently deletes this entire untracked file.",
                        app.keymap.label("confirm")
                    )
                } else {
                    format!("Permanently delete this entire untracked file. Press {} to allow deletion.", app.keymap.label("allow_delete"))
                }
            } else {
                "Permanently lose all unstaged changes in this file. Restore its staged content."
                    .into()
            };
            patch_review(frame, app, "Discard file", &warning, &review.preview);
        }
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
                            t().faint
                        } else if *untracked {
                            t().green
                        } else {
                            t().yellow
                        }),
                    )];
                    spans.extend(path_spans(
                        path,
                        usize::from(inner.width).saturating_sub(18),
                    ));
                    if stays {
                        spans.push(Span::styled("  stays", fg(t().faint)));
                    }
                    Line::from(spans)
                })
                .collect();
            if kept > 0 {
                lines.push(Line::raw(""));
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(" {} ", app.keymap.label("include_untracked")),
                        Style::new().fg(t().on_accent).bg(t().muted),
                    ),
                    Span::styled(
                        if review.include_untracked {
                            " Untracked files are included"
                        } else {
                            " Untracked files stay in place"
                        },
                        fg(t().muted),
                    ),
                ]));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled(
                    format!(" {} ", app.keymap.label("confirm")),
                    Style::new()
                        .fg(t().on_accent)
                        .bg(t().accent)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(" stash    ", fg(t().muted)),
                Span::styled(" esc ", Style::new().fg(t().on_accent).bg(t().muted)),
                Span::styled(" cancel", fg(t().muted)),
            ]));
            frame.render_widget(Paragraph::new(lines), inner);
        }
        Some(Confirm::Pop(entry)) => {
            let rect = modal(frame, 72, 12);
            let block = dialog("Pop the latest stash");
            let inner = block.inner(rect);
            frame.render_widget(block, rect);
            let key = |k: &str| Span::styled(format!("{k:<9}"), fg(t().muted));
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(vec![
                        key("Stash"),
                        Span::styled(safe(&entry.selector), fg(t().purple)),
                    ]),
                    Line::from(vec![
                        key("Message"),
                        Span::styled(safe(&entry.message), bold(t().text)),
                    ]),
                    Line::from(vec![
                        key("Commit"),
                        Span::styled(
                            entry.oid.get(..12).unwrap_or(&entry.oid).to_string(),
                            fg(t().gold),
                        ),
                    ]),
                    Line::raw(""),
                    Line::styled(
                        "Needs a clean working tree. The stash is removed only after it applies.",
                        fg(t().faint),
                    ),
                    Line::raw(""),
                    Line::from(vec![
                        Span::styled(
                            format!(" {} ", app.keymap.label("confirm")),
                            Style::new()
                                .fg(t().on_accent)
                                .bg(t().accent)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(" pop    ", fg(t().muted)),
                        Span::styled(" esc ", Style::new().fg(t().on_accent).bg(t().muted)),
                        Span::styled(" cancel", fg(t().muted)),
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
            let mut lines = diff_lines(&review.preview, usize::from(inner.width), app.hscroll);
            if lines.is_empty() {
                lines.push(Line::styled(
                    if review.preview.binary {
                        "Binary file — no text preview"
                    } else if review.preview.truncated {
                        "This diff is too large to preview"
                    } else {
                        "No text changes"
                    },
                    fg(t().muted),
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
            let key = |k: &str| Span::styled(format!("{k:<9}"), fg(t().muted));
            let mut lines = vec![
                Line::from(vec![
                    key("Remote"),
                    Span::styled(safe(&review.endpoint_label()), fg(t().faint)),
                ]),
                Line::from(vec![key("From"), Span::raw(from)]),
                Line::from(vec![key("To"), Span::styled(to, bold(t().text))]),
            ];
            if let Some(oid) = review.oid() {
                lines.push(Line::from(vec![
                    key("Commit"),
                    Span::styled(oid.get(..12).unwrap_or(oid).to_string(), fg(t().gold)),
                ]));
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled(
                    format!(" {} ", app.keymap.label("confirm")),
                    Style::new()
                        .fg(t().on_accent)
                        .bg(t().accent)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(" confirm    ", fg(t().muted)),
                Span::styled(" esc ", Style::new().fg(t().on_accent).bg(t().muted)),
                Span::styled(" cancel", fg(t().muted)),
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

fn text_review(frame: &mut Frame, app: &App, title: &str, lines: Vec<String>) {
    let area = frame.area();
    let rect = modal(frame, 86, area.height * 4 / 5);
    let block = dialog(title);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let lines: Vec<_> = lines.into_iter().map(|s| Line::raw(safe(&s))).collect();
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((app.scroll.min(u16::MAX as usize) as u16, 0)),
        inner,
    );
}

fn patch_review(frame: &mut Frame, app: &App, title: &str, warning: &str, diff: &FileDiff) {
    let area = frame.area();
    let rect = modal(frame, area.width * 17 / 20, area.height * 17 / 20);
    let block = dialog(title);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let mut lines = vec![
        Line::styled(safe(&diff.path), bold(t().text)),
        Line::styled(warning.to_owned(), fg(t().yellow)),
        Line::raw(""),
    ];
    let patch = diff_lines(diff, usize::from(inner.width), app.hscroll);
    if patch.is_empty() {
        lines.push(Line::raw(if diff.binary {
            "Binary file — no text preview"
        } else {
            "No text preview"
        }));
    } else {
        lines.extend(patch.into_iter().skip(app.scroll));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

/// A one-line text field that shows the terminal's own cursor at its end.
fn field(frame: &mut Frame, area: Rect, text: &str) {
    let shown = clip_left(text, usize::from(area.width.saturating_sub(3)));
    frame.render_widget(
        Paragraph::new(format!(" {shown}")).style(Style::new().bg(t().select)),
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
            Line::styled("Destination branch", fg(t().muted)),
            Line::raw(""),
            Line::raw(""),
            Line::raw(""),
            Line::styled("You will review the push before it runs.", fg(t().faint)),
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
            Line::styled(clip(&context, usize::from(inner.width)), fg(t().faint)),
            Line::raw(""),
            Line::styled(prompt.question, bold(t().text)),
            Line::raw(""),
            Line::raw(""),
            Line::raw(""),
            Line::styled(
                "Answers stay in memory for this request only.",
                fg(t().faint),
            ),
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

    fn text(spans: &[Span]) -> String {
        spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn branch_icons_keep_ref_labels_within_budget() {
        let (jobs, _) = std::sync::mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        app.refs.insert(
            "a".into(),
            vec![
                ("origin/main".into(), "remote".into()),
                ("origin/HEAD".into(), "remote".into()),
                ("topic".into(), "local".into()),
                ("v1".into(), "tag".into()),
            ],
        );
        let (spans, _) = ref_spans(&app, "a", 80);
        assert_eq!(text(&spans), "💻 topic 🌐 origin/main ◆ v1 ");
        for budget in 0..80 {
            let (spans, used) = ref_spans(&app, "a", budget);
            assert_eq!(text(&spans).width(), used);
            assert!(used <= budget);
        }
    }

    #[test]
    fn spacer_rows_continue_every_line_that_goes_down() {
        let row = |s: &str| -> Vec<GraphCell> {
            s.chars()
                .map(|glyph| GraphCell {
                    glyph,
                    color: 0,
                    node: glyph == '●',
                })
                .collect()
        };
        let node = |root| Node {
            head: false,
            merge: false,
            stash: false,
            root,
        };
        let spacer = |s: &str, root| text(&graph_spans(&row(s), 5, &node(root), None, true));
        assert_eq!(spacer("●─┬─╮", false), "│ │ │ ");
        assert_eq!(spacer("│ ● │", false), "│ │ │ ");
        assert_eq!(spacer("●─┴─╯", true), "      ");
        assert_eq!(spacer("● ╭─╯", false), "│ │   ");
    }

    #[test]
    fn edited_lines_mark_whole_changed_words() {
        let chars = |s: &str| s.chars().collect::<Vec<_>>();
        let (old, new) = (chars("let x = foo(1);"), chars("let x = foobar(1);"));
        assert_eq!(changed(&old, &new), Some(((8, 11), (8, 14))));
        assert_eq!(changed(&chars("alpha"), &chars("omega")), None);
        let runs = columns(&new, Some((8, 14)), 6, 6);
        assert_eq!(
            runs,
            [("= ".to_string(), false), ("foob".to_string(), true)]
        );
    }

    #[test]
    fn toolbar_buttons_are_centred() {
        use ratatui::{backend::TestBackend, Terminal};
        let (jobs, _) = std::sync::mpsc::sync_channel(1);
        let app = App::new(jobs);
        let mut terminal = Terminal::new(TestBackend::new(100, 3)).unwrap();
        terminal
            .draw(|frame| toolbar(frame, frame.area(), &app))
            .unwrap();
        let hits = app.hits.borrow();
        let (first, last) = (hits.first().unwrap().0, hits.last().unwrap().0);
        let (left, right) = (first.x, 100 - (last.right() + 3));
        assert_eq!(hits.len(), 5);
        assert!(left.abs_diff(right) <= 1, "{left} vs {right}");
    }
}
