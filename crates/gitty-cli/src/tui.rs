use crate::invalid;
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode as Key, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use gitty_core::{
    askpass::{self, AskpassContext, AskpassRegistry},
    dto::{
        CommitDetail, CommitSummary, DiffFile, DiffSpec, FileDiff, HistoryPage, RepositoryLocation,
        RepositoryState, Result, StatusEntry,
    },
    remote::{TerminalRemoteReview, TerminalSync},
    remote_dto::{StashAction, StashEntry, SyncInfo},
    repository::Service,
    terminal::{CommitReview, StageReview, StashReview},
    Error,
};
use ratatui::DefaultTerminal;
use std::{
    collections::HashMap,
    io::{self, IsTerminal},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

mod view;
use view::{render, safe};

const WRITES: bool = cfg!(target_os = "macos");
const PAGE: usize = 100;
/// Columns at which panes sit side by side instead of stacking.
const WIDE: u16 = 110;

/// One terminal column of the history graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GraphCell {
    glyph: char,
    /// Index into the lane palette.
    color: u8,
    node: bool,
}

/// Streams commits into lanes. Every edge keeps its own lane until it reaches its
/// parent, where the lanes meet in a curve, so lines never jump between rows.
#[derive(Default)]
struct Graph {
    /// The commit each lane is heading to, with the lane's colour.
    lanes: Vec<Option<(String, u8)>>,
    colors: u8,
}

const UP: u8 = 1;
const DOWN: u8 = 2;
const LEFT: u8 = 4;
const RIGHT: u8 = 8;

fn glyph(edges: u8) -> char {
    match edges {
        0 => ' ',
        UP => '╵',
        DOWN => '╷',
        LEFT => '╴',
        RIGHT => '╶',
        3 => '│',
        12 => '─',
        5 => '╯',
        9 => '╰',
        6 => '╮',
        10 => '╭',
        7 => '┤',
        11 => '├',
        13 => '┴',
        14 => '┬',
        _ => '┼',
    }
}

impl Graph {
    fn free(&mut self) -> usize {
        match self.lanes.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                self.lanes.push(None);
                self.lanes.len() - 1
            }
        }
    }

    fn color(&mut self) -> u8 {
        self.colors = self.colors.wrapping_add(1);
        self.colors
    }

    /// Lanes take two columns: the lane itself, then a gap that carries horizontal edges.
    fn row(&mut self, commit: &CommitSummary, stash: bool) -> Vec<GraphCell> {
        let incoming: Vec<usize> = (0..self.lanes.len())
            .filter(|&i| {
                self.lanes[i]
                    .as_ref()
                    .is_some_and(|(id, _)| id == &commit.id)
            })
            .collect();
        let (lane, color) = match incoming.first() {
            Some(&i) => (i, self.lanes[i].as_ref().map_or(0, |(_, c)| *c)),
            None => {
                let i = self.free();
                (i, self.color())
            }
        };
        let mut edges: Vec<u8> = Vec::new();
        let mut colors: Vec<u8> = Vec::new();
        fn paint(edges: &mut Vec<u8>, colors: &mut Vec<u8>, at: usize, bits: u8, c: u8) {
            if edges.len() <= at {
                edges.resize(at + 1, 0);
                colors.resize(at + 1, 0);
            }
            edges[at] |= bits;
            colors[at] = c;
        }
        // Lanes passing straight through this row.
        for (i, slot) in self.lanes.iter().enumerate() {
            if let Some((_, c)) = slot {
                if i != lane && !incoming.contains(&i) {
                    paint(&mut edges, &mut colors, 2 * i, UP | DOWN, *c);
                }
            }
        }
        // Lanes ending here curve into the node.
        for &i in incoming.iter().filter(|&&i| i != lane) {
            let c = self.lanes[i].as_ref().map_or(0, |(_, c)| *c);
            let (from, to) = (2 * lane.min(i), 2 * lane.max(i));
            for x in from + 1..to {
                paint(&mut edges, &mut colors, x, LEFT | RIGHT, c);
            }
            paint(
                &mut edges,
                &mut colors,
                2 * i,
                UP | if i > lane { LEFT } else { RIGHT },
                c,
            );
            self.lanes[i] = None;
        }
        self.lanes[lane] = None;
        let mut parents: Vec<&String> = Vec::new();
        for parent in commit
            .parents
            .iter()
            .take(if stash { 1 } else { usize::MAX })
        {
            if !parents.contains(&parent) {
                parents.push(parent);
            }
        }
        for (n, parent) in parents.into_iter().enumerate() {
            if n == 0 {
                self.lanes[lane] = Some((parent.clone(), color));
                continue;
            }
            let i = self.free();
            let c = self.color();
            self.lanes[i] = Some((parent.clone(), c));
            let (from, to) = (2 * lane.min(i), 2 * lane.max(i));
            for x in from + 1..to {
                paint(&mut edges, &mut colors, x, LEFT | RIGHT, c);
            }
            paint(
                &mut edges,
                &mut colors,
                2 * i,
                DOWN | if i > lane { LEFT } else { RIGHT },
                c,
            );
        }
        while self.lanes.last() == Some(&None) {
            self.lanes.pop();
        }
        if edges.len() <= 2 * lane {
            edges.resize(2 * lane + 1, 0);
            colors.resize(2 * lane + 1, 0);
        }
        edges
            .iter()
            .zip(&colors)
            .enumerate()
            .map(|(x, (&bits, &c))| GraphCell {
                glyph: if x == 2 * lane { '●' } else { glyph(bits) },
                color: if x == 2 * lane { color } else { c },
                node: x == 2 * lane,
            })
            .collect()
    }
}

/// Repository state plus the header summary read alongside it.
struct Snapshot {
    state: RepositoryState,
    sync: Option<SyncInfo>,
    changes: Option<usize>,
    stashes: Vec<StashEntry>,
}

/// The `bool` on Commit/Diff jobs opens the result; otherwise it only fills a preview pane.
enum Job {
    History(Option<String>),
    Commit(String, bool),
    Diff(DiffSpec, String, bool),
    Working,
    StageReview(String, bool),
    Stage(StageReview),
    CommitReview,
    Save(CommitReview, String),
    Sync,
    RemoteReview(TerminalSync, String, Option<String>),
    Remote(TerminalRemoteReview),
    Verify(TerminalRemoteReview),
    StashReview,
    Stash(StashReview),
    Pop(String),
}

enum Reply {
    History(Option<Snapshot>, HistoryPage),
    Commit(CommitDetail, Vec<DiffFile>, bool),
    Diff(String, FileDiff, bool),
    Working(Vec<StatusEntry>),
    StageReview(StageReview),
    CommitReview(CommitReview),
    Sync(SyncInfo),
    RemoteReview(TerminalRemoteReview),
    StashReview(StashReview),
    Wrote {
        outcome: Result<String>,
        committed: bool,
        refresh: Result<(Snapshot, HistoryPage)>,
    },
    RemoteDone(
        TerminalRemoteReview,
        Result<()>,
        Result<(Snapshot, HistoryPage)>,
    ),
    Verified(TerminalRemoteReview, Option<String>, Option<String>),
}

struct Prompt {
    id: usize,
    question: &'static str,
    context: Option<AskpassContext>,
    answer: String,
}

enum PromptEvent {
    Ask(Prompt),
    Expired(usize),
}

fn worker(
    path: String,
    jobs: mpsc::Receiver<Job>,
    replies: mpsc::Sender<Result<Reply>>,
    registry: Option<Arc<AskpassRegistry>>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    gitty_core::process::terminal_worker(cancel);
    let data = tempfile::tempdir()?;
    let service = Service::new(data.path().into());
    let session = service.open(RepositoryLocation::Native { path })?.session;
    let handle = &session.handle;
    let repo = service.repo(handle)?;
    let history = |cursor: Option<String>| repo.history(cursor, PAGE, Default::default());
    let fresh = || -> Result<_> {
        for _ in 0..3 {
            let state = repo.state()?;
            let page = history(None)?;
            if repo.state()?.fingerprint == state.fingerprint {
                return Ok((state, page));
            }
        }
        Err(Error::new(
            "unstable",
            "Repository refs changed during refresh. Try again.",
        ))
    };
    // Reading status first also reconciles the index after a write.
    let snapshot = || -> Result<(Snapshot, HistoryPage)> {
        let changes = if session.bare {
            None
        } else {
            Some(repo.status_entries()?.entries.len())
        };
        let (state, page) = fresh()?;
        let sync = repo.sync_info().ok();
        let stashes = repo.stashes().unwrap_or_default();
        Ok((
            Snapshot {
                state,
                sync,
                changes,
                stashes,
            },
            page,
        ))
    };
    for job in jobs {
        let reply = (|| -> Result<Reply> {
            Ok(match job {
                Job::History(None) => {
                    let (snapshot, page) = snapshot()?;
                    Reply::History(Some(snapshot), page)
                }
                Job::History(cursor) => Reply::History(None, history(cursor)?),
                Job::Commit(oid, open) => {
                    let spec = DiffSpec::Commit {
                        oid: oid.clone(),
                        parent: None,
                    };
                    let commit = repo.commit(&oid)?;
                    Reply::Commit(commit, repo.diff_files(&spec)?, open)
                }
                Job::Diff(spec, path, open) => {
                    let key = diff_key(&spec, &path);
                    Reply::Diff(key, repo.diff(&spec, &path)?, open)
                }
                Job::Working => Reply::Working(repo.status_entries()?.entries),
                Job::StageReview(path, unstage) => {
                    Reply::StageReview(repo.terminal_review_stage(&path, unstage)?)
                }
                Job::Stage(review) if WRITES => {
                    let unstage = review.is_unstage();
                    let outcome = service
                        .terminal_stage(handle, review)
                        .map(|()| if unstage { "Unstaged." } else { "Staged." }.into());
                    Reply::Wrote {
                        outcome,
                        committed: false,
                        refresh: snapshot(),
                    }
                }
                Job::CommitReview => Reply::CommitReview(repo.terminal_review_commit()?),
                Job::Save(review, message) if WRITES => {
                    let outcome = service.terminal_commit(handle, review, &message);
                    let committed = outcome.is_ok();
                    let outcome = outcome.map(|(commit, matches)| {
                        format!(
                            "Committed {}{}",
                            commit.oid.get(..7).unwrap_or(&commit.oid),
                            match matches {
                                Some(true) => "",
                                Some(false) => " — a hook changed the committed tree; review it.",
                                None => " — could not compare the tree with the reviewed index.",
                            }
                        )
                    });
                    Reply::Wrote {
                        outcome,
                        committed,
                        refresh: snapshot(),
                    }
                }
                Job::Sync => Reply::Sync(repo.sync_info()?),
                Job::RemoteReview(kind, remote, destination) => Reply::RemoteReview(
                    repo.terminal_review_remote(kind, &remote, destination.as_deref())
                        .map_err(remote_error)?,
                ),
                Job::Remote(review) if WRITES => {
                    let result = service
                        .terminal_remote(handle, &review, registry.as_deref())
                        .map(|_| ())
                        .map_err(remote_error);
                    Reply::RemoteDone(review, result, snapshot())
                }
                Job::StashReview => Reply::StashReview(repo.terminal_review_stash()?),
                Job::Stash(review) if WRITES => Reply::Wrote {
                    outcome: service
                        .terminal_stash(handle, review)
                        .map(|()| "Stashed your changes.".into()),
                    committed: false,
                    refresh: snapshot(),
                },
                Job::Pop(oid) if WRITES => Reply::Wrote {
                    outcome: service
                        .stash_action(
                            handle,
                            StashAction::Pop {
                                oid,
                                restore_index: false,
                            },
                        )
                        .map(|_| "Restored the stash and removed it from the list.".into()),
                    committed: false,
                    refresh: snapshot(),
                },
                Job::Verify(review) if WRITES => {
                    let oid = repo.terminal_push_ref(&review, registry.as_deref())?;
                    let upstream = if review.kind() == TerminalSync::Publish {
                        match review
                            .branch()
                            .and_then(|branch| repo.sync_info_for(branch).ok())
                        {
                            Some(sync) => sync.upstream,
                            None => Some("could not check".into()),
                        }
                    } else {
                        None
                    };
                    Reply::Verified(review, oid, upstream)
                }
                _ => {
                    return Err(Error::new(
                        "unsupportedOperation",
                        "Writes are disabled on this platform.",
                    ))
                }
            })
        })();
        if replies.send(reply).is_err() {
            break;
        }
    }
    service.close(handle)
}

fn error_text(error: Error) -> String {
    error.message
}

fn diff_key(spec: &DiffSpec, path: &str) -> String {
    format!("{spec:?}\0{path}")
}

fn remote_error(error: Error) -> Error {
    let message = match error.code.as_str() {
        "staleOperation" => "Sync target changed; refresh and review again.",
        "noUpstream" => "Choose the upstream remote, or Publish a new branch.",
        "invalidUpstream" => "Push requires a same-name upstream branch.",
        "upstreamExists" => "This branch already has an upstream.",
        "detachedHead" => "Sync requires a checked-out local branch.",
        "invalidBranch" => "Choose a valid destination branch.",
        "pushRejected" => "The push destination was rejected; inspect remote history before trying again.",
        "mutationUnverified" => "Git could not confirm the outcome. Verify the destination before another push.",
        _ => "Git did not complete the action. Inspect repository state and check the remote or credentials.",
    };
    // Transport output can include credentials via URLs, helpers or server messages.
    Error::new(&error.code, message)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    History,
    Files,
    Working,
    Diff,
    Composer,
    Remote,
    Publish,
    Confirm,
}

enum Confirm {
    Stage(StageReview),
    Remote(TerminalRemoteReview),
    Stash(StashReview),
    Pop(StashEntry),
}

/// Toolbar buttons; each one opens a review before anything runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Fetch,
    Pull,
    Push,
    Stash,
    Pop,
}

/// Something clickable that the last frame drew.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hit {
    Tab(u8),
    Commit(usize),
    File(usize),
    Change(usize),
    Staged(bool),
    Remote(usize),
    Action(Action),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone {
    Info,
    Good,
    Bad,
}

struct App {
    jobs: mpsc::SyncSender<Job>,
    busy: bool,
    writing: bool,
    quit: bool,
    locked: bool,
    wide: bool,
    view: View,
    back: View,
    state: Option<RepositoryState>,
    changes: Option<usize>,
    stashes: Vec<StashEntry>,
    commits: Vec<CommitSummary>,
    graph: Graph,
    rows: Vec<Vec<GraphCell>>,
    /// Commit ID to `(name, kind)` labels.
    refs: HashMap<String, Vec<(String, String)>>,
    /// An explicit read requested while another read was running.
    next: Option<Job>,
    /// The last preview requested automatically, so a failing one is not retried in a loop.
    requested: Option<String>,
    diff_key: Option<String>,
    tone: Tone,
    /// First visible row of the history, files and changes lists.
    tops: [std::cell::Cell<usize>; 3],
    /// Click targets recorded by the last frame.
    hits: std::cell::RefCell<Vec<(ratatui::layout::Rect, Hit)>>,
    last_click: Option<(std::time::Instant, Hit)>,
    generation: String,
    cursor: Option<String>,
    shallow: bool,
    history: usize,
    file: usize,
    working: usize,
    remote: usize,
    scroll: usize,
    staged: bool,
    detail: Option<(CommitDetail, Vec<DiffFile>)>,
    entries: Vec<StatusEntry>,
    diff: Option<FileDiff>,
    review: Option<CommitReview>,
    message: String,
    sync: Option<SyncInfo>,
    publish: String,
    uncertain: Option<TerminalRemoteReview>,
    confirm: Option<Confirm>,
    notice: String,
}

impl App {
    fn new(jobs: mpsc::SyncSender<Job>) -> Self {
        Self {
            jobs,
            busy: false,
            writing: false,
            quit: false,
            locked: false,
            wide: false,
            view: View::History,
            back: View::History,
            state: None,
            changes: None,
            stashes: Vec::new(),
            commits: Vec::new(),
            graph: Graph::default(),
            rows: Vec::new(),
            refs: HashMap::new(),
            next: None,
            requested: None,
            diff_key: None,
            tone: Tone::Info,
            tops: Default::default(),
            hits: Default::default(),
            last_click: None,
            generation: String::new(),
            cursor: None,
            shallow: false,
            history: 0,
            file: 0,
            working: 0,
            remote: 0,
            scroll: 0,
            staged: false,
            detail: None,
            entries: Vec::new(),
            diff: None,
            review: None,
            message: String::new(),
            sync: None,
            publish: String::new(),
            uncertain: None,
            confirm: None,
            notice: String::new(),
        }
    }

    fn send(&mut self, job: Job) {
        let write = matches!(
            job,
            Job::Stage(_) | Job::Save(..) | Job::Remote(_) | Job::Stash(_) | Job::Pop(_)
        );
        if self.busy || (write && self.locked) {
            return;
        }
        match self.jobs.try_send(job) {
            Ok(()) => {
                self.busy = true;
                self.writing = write;
                if write {
                    self.notice.clear();
                }
            }
            Err(_) => self.say(Tone::Bad, "Repository worker is unavailable."),
        }
    }

    /// Explicit reads wait behind a running preview instead of being dropped.
    fn request(&mut self, job: Job) {
        if self.busy {
            self.next = Some(job);
        } else {
            self.send(job);
        }
    }

    fn say(&mut self, tone: Tone, notice: impl Into<String>) {
        self.tone = tone;
        self.notice = notice.into();
    }

    fn file_target(&self) -> Option<(DiffSpec, String)> {
        let (commit, files) = self.detail.as_ref()?;
        let file = files.get(self.file)?;
        Some((
            DiffSpec::Commit {
                oid: commit.summary.id.clone(),
                parent: None,
            },
            file.path.clone(),
        ))
    }

    fn working_target(&self) -> Option<(DiffSpec, String)> {
        let entry = self.working_rows().nth(self.working)?;
        if entry.path.ends_with('/') {
            return None;
        }
        let spec = if entry.conflicted {
            DiffSpec::Conflict
        } else if self.staged {
            DiffSpec::Staged
        } else if entry.untracked {
            DiffSpec::Untracked
        } else {
            DiffSpec::Unstaged
        };
        Some((spec, entry.path.clone()))
    }

    /// Opens the selected file's diff, reusing the preview when it is current.
    fn open_diff(&mut self, target: Option<(DiffSpec, String)>) {
        let Some((spec, path)) = target else {
            return;
        };
        self.back = self.view;
        if self.diff_key.as_deref() == Some(diff_key(&spec, &path).as_str()) {
            self.view = View::Diff;
            self.scroll = 0;
        } else {
            self.request(Job::Diff(spec, path, true));
        }
    }

    /// Loads older history near the bottom, then the preview for the selection on wide screens.
    fn follow(&mut self) {
        if self.busy || self.quit {
            return;
        }
        if self.view == View::History && self.history + 30 >= self.commits.len() {
            if let Some(cursor) = self.cursor.clone() {
                self.send(Job::History(Some(cursor)));
                return;
            }
        }
        if !self.wide {
            return;
        }
        let (key, job) = match self.view {
            View::History => {
                let Some(commit) = self.commits.get(self.history) else {
                    return;
                };
                if self.detail.as_ref().map(|(d, _)| &d.summary.id) == Some(&commit.id) {
                    return;
                }
                (commit.id.clone(), Job::Commit(commit.id.clone(), false))
            }
            View::Files | View::Working => {
                let target = if self.view == View::Files {
                    self.file_target()
                } else {
                    self.working_target()
                };
                let Some((spec, path)) = target else {
                    return;
                };
                let key = diff_key(&spec, &path);
                if self.diff_key.as_ref() == Some(&key) {
                    return;
                }
                (key, Job::Diff(spec, path, false))
            }
            _ => return,
        };
        if self.requested.as_ref() != Some(&key) {
            self.requested = Some(key);
            self.send(job);
        }
    }

    fn page(&mut self, snapshot: Option<Snapshot>, page: HistoryPage) {
        if let Some(Snapshot {
            state,
            sync,
            changes,
            stashes,
        }) = snapshot
        {
            let selected = self
                .commits
                .get(self.history)
                .map(|commit| commit.id.clone());
            self.refs.clear();
            for reference in &state.refs {
                self.refs
                    .entry(reference.commit_id.clone())
                    .or_default()
                    .push((reference.name.clone(), reference.kind.clone()));
            }
            self.sync = sync;
            self.changes = changes;
            self.stashes = stashes;
            self.requested = None;
            self.state = Some(state);
            self.commits.clear();
            self.rows.clear();
            self.graph = Graph::default();
            self.generation = page.generation.clone();
            self.history = page
                .commits
                .iter()
                .position(|commit| Some(&commit.id) == selected.as_ref())
                .unwrap_or(0);
            self.locked = false;
        } else if self.generation != page.generation || self.cursor == page.cursor {
            self.cursor = None;
            self.say(Tone::Info, "History changed; press r to refresh.");
            return;
        }
        let state = self.state.as_ref();
        for commit in page.commits {
            let stash = state.is_some_and(|s| {
                s.refs
                    .iter()
                    .any(|r| r.kind == "stash" && r.commit_id == commit.id)
            });
            self.rows.push(self.graph.row(&commit, stash));
            self.commits.push(commit);
        }
        self.cursor = page.cursor;
        self.shallow = page.shallow;
    }

    fn reply(&mut self, reply: Result<Reply>) {
        self.busy = false;
        self.writing = false;
        match reply {
            Ok(Reply::History(snapshot, page)) => self.page(snapshot, page),
            Ok(Reply::Commit(detail, files, open)) => {
                self.detail = Some((detail, files));
                if open {
                    self.file = 0;
                    self.scroll = 0;
                    self.view = View::Files;
                }
            }
            Ok(Reply::Diff(key, diff, open)) => {
                self.diff = Some(diff);
                self.diff_key = Some(key);
                if open {
                    self.view = View::Diff;
                    self.scroll = 0;
                }
            }
            Ok(Reply::Working(entries)) => {
                self.changes = Some(entries.len());
                self.entries = entries;
                self.working = self
                    .working
                    .min(self.working_rows().count().saturating_sub(1));
                // Working diffs change with the files; reload the preview.
                self.diff_key = None;
                self.requested = None;
                self.view = View::Working;
            }
            Ok(Reply::StageReview(review)) => {
                self.confirm = Some(Confirm::Stage(review));
                self.scroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::CommitReview(review)) => {
                self.review = Some(review);
                self.view = View::Composer;
                self.scroll = 0;
            }
            Ok(Reply::Sync(sync)) => {
                self.sync = Some(sync);
                self.view = View::Remote;
            }
            Ok(Reply::StashReview(review)) => {
                self.confirm = Some(Confirm::Stash(review));
                self.scroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::RemoteReview(review)) => {
                self.confirm = Some(Confirm::Remote(review));
                self.scroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::Wrote {
                outcome,
                committed,
                refresh,
            }) => {
                if committed {
                    self.message.clear();
                }
                match outcome {
                    Ok(notice) => self.say(Tone::Good, notice),
                    Err(error) => self.say(Tone::Bad, error_text(error)),
                }
                self.diff_key = None;
                match refresh {
                    Ok((snapshot, page)) => {
                        self.page(Some(snapshot), page);
                        if self.view == View::Working && !self.quit {
                            self.send(Job::Working);
                        }
                    }
                    Err(_) => {
                        self.locked = true;
                        self.tone = Tone::Bad;
                        self.notice
                            .push_str(" Refresh failed; press r before writing again.");
                    }
                }
            }
            Ok(Reply::RemoteDone(review, result, refresh)) => {
                match result {
                    Ok(()) => self.say(Tone::Good, format!("{:?} completed.", review.kind())),
                    Err(error) => {
                        if error.code == "mutationUnverified"
                            && matches!(review.kind(), TerminalSync::Push | TerminalSync::Publish)
                        {
                            self.uncertain = Some(review);
                        }
                        self.say(Tone::Bad, error_text(error));
                    }
                }
                match refresh {
                    Ok((snapshot, page)) => self.page(Some(snapshot), page),
                    Err(_) => {
                        self.locked = true;
                        self.tone = Tone::Bad;
                        self.notice
                            .push_str(" Refresh failed; press r before writing again.");
                    }
                }
            }
            Ok(Reply::Verified(review, oid, upstream)) => {
                self.uncertain = None;
                self.tone = Tone::Info;
                self.notice = format!(
                    "{}: {}{}",
                    review.destination().unwrap_or("destination"),
                    if oid.is_none() {
                        "currently absent"
                    } else if oid.as_deref() == review.oid() {
                        "currently matches the attempted commit"
                    } else {
                        "currently differs from the attempted commit"
                    },
                    if review.kind() == TerminalSync::Publish {
                        format!(
                            "; local upstream: {}",
                            upstream.as_deref().unwrap_or("none")
                        )
                    } else {
                        String::new()
                    }
                );
            }
            Err(error) => self.say(Tone::Bad, error_text(error)),
        }
        match self.next.take() {
            Some(job) if !self.busy => self.send(job),
            Some(job) => self.next = Some(job),
            None => self.follow(),
        }
    }

    /// The configured remote of the upstream, else `origin`, else the only remote.
    fn sync_remote(&self) -> Option<usize> {
        let sync = self.sync.as_ref()?;
        let by_upstream = sync.upstream.as_deref().and_then(|upstream| {
            (0..sync.remotes.len())
                .filter(|&i| upstream.starts_with(&format!("{}/", sync.remotes[i])))
                .max_by_key(|&i| sync.remotes[i].len())
        });
        by_upstream
            .or_else(|| sync.remotes.iter().position(|r| r == "origin"))
            .or_else(|| (sync.remotes.len() == 1).then_some(0))
    }

    /// Why a toolbar action cannot run now, or `None` when it can.
    fn unavailable(&self, action: Action) -> Option<&'static str> {
        let sync = self.sync.as_ref();
        let upstream = sync.is_some_and(|s| s.upstream.is_some());
        let bare = self.state.as_ref().is_none_or(|s| s.session.bare);
        if !WRITES {
            return Some("Actions are read-only on this platform.");
        }
        if self.locked {
            return Some("Refresh with r before another action.");
        }
        match action {
            Action::Fetch | Action::Pull | Action::Push if self.sync_remote().is_none() => {
                Some("No remote to sync with; add one in Git.")
            }
            Action::Pull if !upstream => Some("This branch has no upstream to pull from."),
            Action::Push if self.uncertain.is_some() => {
                Some("Verify the last push first: open Sync (m) and press v.")
            }
            Action::Push if sync.and_then(|s| s.branch.as_ref()).is_none() => {
                Some("Switch to a branch before pushing.")
            }
            // Change counts can be stale; the review itself reports a clean tree.
            Action::Stash if bare => Some("Bare repositories have nothing to stash."),
            Action::Pop if bare || self.stashes.is_empty() => Some("No stashes to pop."),
            _ => None,
        }
    }

    fn action(&mut self, action: Action) {
        if let Some(reason) = self.unavailable(action) {
            self.say(Tone::Info, reason);
            return;
        }
        self.back = if self.view == View::Confirm {
            View::History
        } else {
            self.view
        };
        let remote = self
            .sync_remote()
            .and_then(|i| Some((i, self.sync.as_ref()?.remotes.get(i)?.clone())));
        let upstream = self.sync.as_ref().is_some_and(|s| s.upstream.is_some());
        match (action, remote) {
            (Action::Stash, _) => self.request(Job::StashReview),
            (Action::Pop, _) => {
                if let Some(entry) = self.stashes.first().cloned() {
                    self.confirm = Some(Confirm::Pop(entry));
                    self.scroll = 0;
                    self.view = View::Confirm;
                }
            }
            (Action::Push, Some((i, _))) if !upstream => {
                self.remote = i;
                self.publish = self
                    .sync
                    .as_ref()
                    .and_then(|s| s.branch.clone())
                    .unwrap_or_default();
                self.view = View::Publish;
            }
            (action, Some((_, remote))) => {
                let kind = match action {
                    Action::Fetch => TerminalSync::Fetch,
                    Action::Pull => TerminalSync::Pull,
                    _ => TerminalSync::Push,
                };
                self.request(Job::RemoteReview(kind, remote, None));
            }
            (_, None) => {}
        }
    }

    /// Clicking selects; a second click on the same item within a moment opens it.
    fn click(&mut self, column: u16, row: u16) {
        if self.writing || matches!(self.view, View::Composer | View::Confirm | View::Publish) {
            return;
        }
        let at = ratatui::layout::Position::new(column, row);
        let Some(hit) = self
            .hits
            .borrow()
            .iter()
            .find(|(rect, _)| rect.contains(at))
            .map(|(_, hit)| *hit)
        else {
            return;
        };
        let now = std::time::Instant::now();
        let double = self.last_click.is_some_and(|(at, last)| {
            last == hit && now.duration_since(at) < Duration::from_millis(450)
        });
        self.last_click = Some((now, hit));
        match hit {
            Hit::Tab(0) => self.key(Key::Char('h'), false, 1),
            Hit::Tab(1) => self.key(Key::Char('w'), false, 1),
            Hit::Tab(_) => self.key(Key::Char('m'), false, 1),
            Hit::Staged(staged) if staged != self.staged => self.key(Key::Tab, false, 1),
            Hit::Staged(_) => {}
            Hit::Remote(i) => self.remote = i,
            Hit::Action(action) => self.action(action),
            Hit::Commit(i) | Hit::File(i) | Hit::Change(i) => {
                match hit {
                    Hit::Commit(_) => self.history = i,
                    Hit::File(_) => self.file = i,
                    _ => self.working = i,
                }
                if double {
                    self.key(Key::Enter, false, 1);
                } else {
                    self.follow();
                }
            }
        }
    }

    fn working_rows(&self) -> impl Iterator<Item = &StatusEntry> {
        self.entries.iter().filter(|entry| {
            if self.staged {
                !entry.untracked && entry.index_status != "."
            } else {
                entry.conflicted || entry.untracked || entry.worktree_status != "."
            }
        })
    }

    fn key(&mut self, key: Key, ctrl: bool, height: usize) {
        if (key == Key::Char('q') && !matches!(self.view, View::Composer | View::Publish))
            || (ctrl && key == Key::Char('c'))
        {
            self.quit = true;
            return;
        }
        // Navigation stays live during reads; nothing changes while a write runs.
        if self.writing {
            return;
        }
        if key == Key::Esc {
            self.view = match self.view {
                View::Diff | View::Confirm => self.back,
                View::Publish => View::Remote,
                _ => View::History,
            };
            self.confirm = None;
            self.next = None;
            self.follow();
            return;
        }
        match self.view {
            View::Composer => {
                match key {
                    Key::F(2) if WRITES && !self.busy => {
                        if let Some(review) = self.review.take() {
                            self.view = View::History;
                            self.send(Job::Save(review, self.message.clone()));
                        }
                    }
                    Key::Backspace => {
                        self.message.pop();
                    }
                    Key::Enter => self.message.push('\n'),
                    Key::Char(c) if !ctrl && self.message.len() + c.len_utf8() <= 65536 => {
                        self.message.push(c)
                    }
                    Key::PageDown => {
                        let last = self
                            .review
                            .as_ref()
                            .map_or(0, |review| review.files().len().saturating_sub(1));
                        self.scroll = self.scroll.saturating_add(height / 2).min(last);
                    }
                    Key::PageUp => self.scroll = self.scroll.saturating_sub(height / 2),
                    _ => {}
                }
                return;
            }
            View::Publish => {
                match key {
                    Key::Enter => {
                        if let Some(remote) = self
                            .sync
                            .as_ref()
                            .and_then(|s| s.remotes.get(self.remote))
                            .cloned()
                        {
                            self.back = View::Remote;
                            self.request(Job::RemoteReview(
                                TerminalSync::Publish,
                                remote,
                                Some(self.publish.clone()),
                            ));
                        }
                    }
                    Key::Backspace => {
                        self.publish.pop();
                    }
                    Key::Char(c) if !ctrl && self.publish.len() + c.len_utf8() <= 1024 => {
                        self.publish.push(c)
                    }
                    _ => {}
                }
                return;
            }
            View::Confirm => {
                match key {
                    Key::Up | Key::Char('k') => self.scroll = self.scroll.saturating_sub(1),
                    Key::Down | Key::Char('j') => self.scroll = self.scroll.saturating_add(1),
                    Key::PageUp => self.scroll = self.scroll.saturating_sub(height),
                    Key::PageDown => self.scroll = self.scroll.saturating_add(height),
                    // A write never queues behind a read; press Enter again once it ends.
                    Key::Char('u') => {
                        if let Some(Confirm::Stash(review)) = &mut self.confirm {
                            review.include_untracked = !review.include_untracked;
                        }
                    }
                    Key::Enter if !self.busy => {
                        self.view = self.back;
                        match self.confirm.take() {
                            Some(Confirm::Stage(review)) => self.send(Job::Stage(review)),
                            Some(Confirm::Remote(review)) => self.send(Job::Remote(review)),
                            Some(Confirm::Stash(review)) => self.send(Job::Stash(review)),
                            Some(Confirm::Pop(entry)) => self.send(Job::Pop(entry.oid)),
                            None => {}
                        }
                    }
                    _ => {}
                }
                return;
            }
            _ => {}
        }
        let worktree = self.state.as_ref().is_some_and(|s| !s.session.bare);
        match key {
            Key::Char('h') => {
                self.view = View::History;
                self.next = None;
                self.follow();
                return;
            }
            Key::Char('r') => {
                self.view = View::History;
                self.request(Job::History(None));
                return;
            }
            Key::Char('w') if worktree => {
                self.request(Job::Working);
                return;
            }
            Key::Char('m') => {
                self.request(Job::Sync);
                return;
            }
            Key::Char('c') if WRITES && !self.locked && worktree => {
                self.request(Job::CommitReview);
                return;
            }
            Key::Char('z') => return self.action(Action::Stash),
            Key::Char('Z') => return self.action(Action::Pop),
            // The sync view applies these to its selected remote instead.
            Key::Char('f') if self.view != View::Remote => return self.action(Action::Fetch),
            Key::Char('l') if self.view != View::Remote => return self.action(Action::Pull),
            Key::Char('p') if self.view != View::Remote => return self.action(Action::Push),
            _ => {}
        }
        let move_by = match key {
            Key::Up | Key::Char('k') => -1,
            Key::Down | Key::Char('j') => 1,
            Key::PageUp => -(height as isize),
            Key::PageDown => height as isize,
            Key::Home | Key::Char('g') => isize::MIN / 2,
            Key::End | Key::Char('G') => isize::MAX / 2,
            _ => 0,
        };
        fn shift(index: &mut usize, by: isize, len: usize) {
            *index = index.saturating_add_signed(by).min(len.saturating_sub(1));
        }
        match self.view {
            View::History => {
                shift(&mut self.history, move_by, self.commits.len());
                if key == Key::Enter {
                    if let Some(commit) = self.commits.get(self.history) {
                        let id = commit.id.clone();
                        if self.detail.as_ref().map(|(d, _)| &d.summary.id) == Some(&id) {
                            self.file = 0;
                            self.scroll = 0;
                            self.view = View::Files;
                        } else {
                            self.request(Job::Commit(id, true));
                        }
                    }
                }
            }
            View::Files => {
                let len = self.detail.as_ref().map_or(0, |(_, files)| files.len());
                shift(&mut self.file, move_by, len);
                if key == Key::Enter {
                    self.open_diff(self.file_target());
                }
            }
            View::Working => {
                if key == Key::Tab {
                    self.staged = !self.staged;
                    self.working = 0;
                }
                let len = self.working_rows().count();
                shift(&mut self.working, move_by, len);
                if key == Key::Enter {
                    self.open_diff(self.working_target());
                } else if key == Key::Char('s') && WRITES && !self.locked {
                    let entry = self.working_rows().nth(self.working);
                    if let Some(entry) = entry.filter(|e| !e.conflicted && !e.path.ends_with('/')) {
                        let path = entry.path.clone();
                        self.back = View::Working;
                        self.request(Job::StageReview(path, self.staged));
                    }
                }
            }
            View::Diff => {
                let len = self
                    .diff
                    .as_ref()
                    .map_or(0, |diff| diff.hunks.iter().map(|h| h.lines.len() + 1).sum());
                shift(&mut self.scroll, move_by, len);
                if key == Key::Tab {
                    self.view = self.back;
                }
            }
            View::Remote => {
                if let Some(sync) = &self.sync {
                    shift(&mut self.remote, move_by, sync.remotes.len());
                    if WRITES && key == Key::Char('v') {
                        if let Some(review) = self.uncertain.clone() {
                            self.request(Job::Verify(review));
                        }
                    } else if WRITES && !self.locked {
                        if let Some(remote) = sync.remotes.get(self.remote).cloned() {
                            let kind = match key {
                                Key::Char('f') => Some(TerminalSync::Fetch),
                                Key::Char('l') => Some(TerminalSync::Pull),
                                Key::Char('p') if self.uncertain.is_none() => {
                                    Some(TerminalSync::Push)
                                }
                                Key::Char('b') if self.uncertain.is_none() => {
                                    self.publish = sync.branch.clone().unwrap_or_default();
                                    self.view = View::Publish;
                                    None
                                }
                                _ => None,
                            };
                            if let Some(kind) = kind {
                                self.back = View::Remote;
                                self.request(Job::RemoteReview(kind, remote, None));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        self.follow();
    }
}

pub fn run(args: &[String]) -> Result<()> {
    let path = match args {
        [] => std::env::current_dir()?
            .into_os_string()
            .into_string()
            .map_err(|_| invalid("Repository path must be UTF-8"))?,
        [flag, path] if flag == "--repo" => path.clone(),
        [flag] if flag == "--help" || flag == "-h" => {
            println!("Usage: gitty-cli tui [--repo PATH]");
            return Ok(());
        }
        _ => return Err(invalid("Usage: gitty-cli tui [--repo PATH]")),
    };
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(Error::new(
            "notTerminal",
            "Gitty TUI requires interactive input and output.",
        ));
    }
    let (jobs, input) = mpsc::sync_channel(1);
    let (reply, replies) = mpsc::channel();
    let (prompt_tx, prompt_rx) = mpsc::sync_channel(8);
    struct AskpassCleanup(Option<Arc<AskpassRegistry>>);
    impl Drop for AskpassCleanup {
        fn drop(&mut self) {
            if let Some(registry) = &self.0 {
                registry.cancel_all();
                registry.cleanup();
            }
        }
    }
    let registry = AskpassCleanup(if WRITES {
        let (listener, registry) = askpass::bind()?;
        let (ask, expire) = (prompt_tx.clone(), prompt_tx);
        let server = registry.clone();
        std::thread::spawn(move || {
            askpass::serve(
                listener,
                server,
                move |id, question, context| {
                    let question = if question.starts_with("Username for") {
                        "Git username (masked)"
                    } else if question.starts_with("Enter passphrase") {
                        "SSH key passphrase (masked)"
                    } else {
                        "Git password or credential (masked)"
                    };
                    ask.try_send(PromptEvent::Ask(Prompt {
                        id,
                        question,
                        context,
                        answer: String::new(),
                    }))
                    .map_err(|_| ())
                },
                move |id| {
                    let _ = expire.try_send(PromptEvent::Expired(id));
                },
            )
        });
        Some(registry)
    } else {
        None
    });
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = crossterm::execute!(io::stdout(), DisableMouseCapture, DisableBracketedPaste);
            let _ = ratatui::try_restore();
        }
    }
    let _restore = Restore;
    let mut terminal = ratatui::try_init()?;
    crossterm::execute!(io::stdout(), EnableBracketedPaste, EnableMouseCapture)?;
    let worker_registry = registry.0.clone();
    struct Cancel(Arc<AtomicBool>);
    impl Drop for Cancel {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    let cancel = Cancel(Arc::new(AtomicBool::new(false)));
    let worker_cancel = cancel.0.clone();
    let worker = std::thread::spawn(move || {
        if let Err(error) = worker(path, input, reply.clone(), worker_registry, worker_cancel) {
            let _ = reply.send(Err(error));
        }
    });
    let result = event_loop(
        &mut terminal,
        App::new(jobs),
        replies,
        prompt_rx,
        registry.0.as_deref(),
    );
    drop(_restore);
    drop(cancel);
    drop(registry);
    if worker.join().is_err() {
        return Err(Error::new("worker", "Repository worker stopped unexpectedly; inspect repository state before trying another action."));
    }
    match result {
        Ok(notice) => {
            if let Some(notice) = notice {
                eprintln!("{}", safe(&notice));
            }
            Ok(())
        }
        Err(error) => Err(Error::new(&error.code, safe(&error.message))),
    }
}

fn event_loop(
    terminal: &mut DefaultTerminal,
    mut app: App,
    replies: mpsc::Receiver<Result<Reply>>,
    prompts: mpsc::Receiver<PromptEvent>,
    registry: Option<&AskpassRegistry>,
) -> Result<Option<String>> {
    let mut prompt: Option<Prompt> = None;
    let mut redraw = true;
    let mut exit_after_write = false;
    app.send(Job::History(None));
    loop {
        loop {
            match replies.try_recv() {
                Ok(reply) => {
                    redraw = true;
                    if app.state.is_none() && app.busy && reply.is_err() {
                        return reply.map(|_| None);
                    }
                    app.reply(reply);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(Error::new(
                        "worker",
                        "Repository worker closed unexpectedly.",
                    ))
                }
            }
        }
        for event in prompts.try_iter() {
            redraw = true;
            match event {
                PromptEvent::Ask(next) if app.quit || prompt.is_some() => {
                    if let Some(registry) = registry {
                        let _ = registry.reply(next.id, None);
                    }
                }
                PromptEvent::Ask(next) => prompt = Some(next),
                PromptEvent::Expired(id) if prompt.as_ref().is_some_and(|p| p.id == id) => {
                    prompt = None
                }
                PromptEvent::Expired(_) => {}
            }
        }
        if app.quit && !app.writing {
            return Ok(exit_after_write.then_some(app.notice));
        }
        let wide = terminal.size()?.width >= WIDE;
        if wide != app.wide {
            app.wide = wide;
            app.follow();
            redraw = true;
        }
        if redraw {
            terminal.draw(|frame| render(frame, &app, prompt.as_ref()))?;
            redraw = false;
        }
        if !event::poll(Duration::from_millis(80))? {
            // Keep the activity spinner moving.
            redraw = app.busy;
            continue;
        }
        let event = event::read()?;
        if matches!(event, Event::Resize(..)) {
            redraw = true;
        }
        if let Event::Mouse(mouse) = event {
            if prompt.is_none() && !app.quit {
                let height = usize::from(terminal.size()?.height.saturating_sub(4)).max(1);
                match mouse.kind {
                    MouseEventKind::Down(MouseButton::Left) => app.click(mouse.column, mouse.row),
                    MouseEventKind::ScrollDown | MouseEventKind::ScrollUp => {
                        let key = if mouse.kind == MouseEventKind::ScrollDown {
                            Key::Down
                        } else {
                            Key::Up
                        };
                        for _ in 0..3 {
                            app.key(key, false, height);
                        }
                    }
                    _ => continue,
                }
                redraw = true;
            }
        }
        if let Event::Paste(text) = &event {
            if prompt.is_none() && !app.busy && !app.quit && app.view == View::Composer {
                for c in text.replace("\r\n", "\n").chars() {
                    if app.message.len() + c.len_utf8() > 65536 {
                        break;
                    }
                    if !c.is_control() || matches!(c, '\n' | '\t') {
                        app.message.push(c);
                    }
                }
                redraw = true;
            }
        }
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Release
                || (key.kind == KeyEventKind::Repeat && matches!(key.code, Key::Enter | Key::F(2)))
            {
                continue;
            }
            redraw = true;
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            if let (Some(current), Some(registry)) = (&mut prompt, registry) {
                match key.code {
                    Key::Enter | Key::Esc => {
                        let answer =
                            (key.code == Key::Enter).then(|| std::mem::take(&mut current.answer));
                        let _ = registry.reply(current.id, answer);
                        prompt = None;
                    }
                    Key::Char('c') if ctrl => {
                        app.quit = true;
                        registry.cancel_all();
                        prompt = None;
                    }
                    Key::Char(c)
                        if !ctrl
                            && !c.is_control()
                            && current.answer.len() + c.len_utf8() <= 4096 =>
                    {
                        current.answer.push(c)
                    }
                    Key::Backspace => {
                        current.answer.pop();
                    }
                    _ => {}
                }
            } else if !app.quit {
                if app.view == View::Files && matches!(key.code, Key::Char('[' | ']')) {
                    app.scroll = if key.code == Key::Char('[') {
                        app.scroll.saturating_sub(1)
                    } else {
                        app.scroll.saturating_add(1)
                    };
                } else {
                    let height = usize::from(terminal.size()?.height.saturating_sub(4)).max(1);
                    app.key(key.code, ctrl, height);
                }
                if app.quit {
                    if let Some(registry) = registry {
                        registry.cancel_all();
                    }
                }
            }
            exit_after_write |= app.quit && app.writing;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};

    fn commit(id: &str, parents: &[&str]) -> CommitSummary {
        CommitSummary {
            id: id.into(),
            parents: parents.iter().map(|id| (*id).into()).collect(),
            subject: format!("commit {id}"),
            author: String::new(),
            email: String::new(),
            timestamp: 0,
        }
    }

    fn drawn(cells: &[GraphCell]) -> String {
        cells.iter().map(|cell| cell.glyph).collect()
    }

    #[test]
    fn terminal_graph_keeps_octopus_lanes_across_pages_and_hides_stash_helpers() {
        let (jobs, rx) = mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        app.generation = "page".into();
        app.page(
            None,
            HistoryPage {
                commits: vec![commit("merge", &["a", "b", "c"])],
                cursor: Some("next".into()),
                generation: "page".into(),
                shallow: false,
                first_page_millis: None,
            },
        );
        let merge = app.rows[0].clone();
        assert_eq!(drawn(&merge), "●─┬─╮");
        app.key(Key::Down, false, 12);
        assert!(matches!(rx.try_recv().unwrap(), Job::History(Some(cursor)) if cursor == "next"));
        app.reply(Ok(Reply::History(
            None,
            HistoryPage {
                commits: vec![
                    commit("a", &["base"]),
                    commit("b", &["base"]),
                    commit("c", &["base"]),
                    commit("base", &[]),
                ],
                cursor: None,
                generation: "page".into(),
                shallow: false,
                first_page_millis: None,
            },
        )));
        assert_eq!(app.rows[0], merge);
        // Each branch keeps its lane down to the shared parent, then curves into it.
        let drawn: Vec<_> = app.rows.iter().map(|row| drawn(row)).collect();
        assert_eq!(drawn, ["●─┬─╮", "● │ │", "│ ● │", "│ │ ●", "●─┴─╯"]);
        assert_eq!(app.history, 0);
        assert!(app.graph.lanes.is_empty());
        let mut graph = Graph::default();
        graph.row(&commit("stash", &["base", "index", "untracked"]), true);
        assert_eq!(graph.lanes.len(), 1);
        assert_eq!(
            graph.lanes[0].as_ref().map(|(id, _)| id.as_str()),
            Some("base")
        );
    }

    #[test]
    fn terminal_wide_preview_loads_once_and_explicit_reads_wait_their_turn() {
        let (jobs, rx) = mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        app.wide = true;
        app.commits = vec![commit("a", &["b"]), commit("b", &[])];
        app.follow();
        assert!(matches!(rx.try_recv().unwrap(), Job::Commit(id, false) if id == "a"));
        // The preview is running: moving is still allowed, and `m` waits instead of being lost.
        app.key(Key::Down, false, 10);
        assert_eq!(app.history, 1);
        app.key(Key::Char('m'), false, 10);
        assert!(rx.try_recv().is_err());
        app.reply(Err(Error::new("git", "preview failed")));
        assert!(matches!(rx.try_recv().unwrap(), Job::Sync));
        app.reply(Ok(Reply::Sync(SyncInfo {
            branch: None,
            upstream: None,
            ahead: None,
            behind: None,
            remotes: Vec::new(),
        })));
        assert!(app.view == View::Remote);
        app.view = View::History;
        app.follow();
        assert!(matches!(rx.try_recv().unwrap(), Job::Commit(id, false) if id == "b"));
        app.reply(Err(Error::new("git", "preview failed")));
        // A failing preview is not retried in a loop.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn terminal_render_fits_narrow_and_wide_and_escapes_repo_controls() {
        let (jobs, _) = mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        let mut c = commit("abcdef0123", &[]);
        c.subject = "safe\u{1b}]52;\u{7} title".into();
        app.commits.push(c);
        let cell = GraphCell {
            glyph: '│',
            color: 0,
            node: false,
        };
        let mut row = vec![cell; 40];
        row[0] = GraphCell {
            glyph: '●',
            color: 0,
            node: true,
        };
        app.rows.push(row);
        for width in [40, 80, 120] {
            app.wide = width >= WIDE;
            let mut terminal = Terminal::new(TestBackend::new(width, 12)).unwrap();
            terminal.draw(|frame| render(frame, &app, None)).unwrap();
            let buffer = terminal.backend().buffer();
            let text: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
            assert!(text.contains("●"));
            assert!(text.contains('…'));
            assert!(!text.contains('\u{1b}'));
            if width >= 80 {
                assert!(text.contains("abcdef0"));
            }
        }
    }

    #[test]
    fn terminal_worker_pages_real_merge_history_without_moving_refs_or_index() {
        use std::process::Command;
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .env("GIT_AUTHOR_NAME", "Test")
                .env("GIT_COMMITTER_NAME", "Test")
                .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
                .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&["init", "-b", "main"]);
        std::fs::write(dir.path().join("file"), b"base\n").unwrap();
        git(&["add", "file"]);
        let tree = git(&["write-tree"]);
        let base = git(&["commit-tree", &tree, "-m", "base"]);
        let side = git(&["commit-tree", &tree, "-p", &base, "-m", "side"]);
        let third = git(&["commit-tree", &tree, "-p", &base, "-m", "third"]);
        let mut tip = base;
        for n in 0..PAGE {
            tip = git(&["commit-tree", &tree, "-p", &tip, "-m", &format!("main {n}")]);
        }
        let merge = git(&[
            "commit-tree",
            &tree,
            "-p",
            &tip,
            "-p",
            &side,
            "-p",
            &third,
            "-m",
            "octopus",
        ]);
        git(&["update-ref", "refs/heads/main", &merge]);
        let index = std::fs::read(dir.path().join(".git/index")).unwrap();

        let (jobs, incoming) = mpsc::sync_channel(1);
        let (outgoing, replies) = mpsc::channel();
        let path = dir.path().to_string_lossy().into_owned();
        let worker = std::thread::spawn(move || {
            worker(
                path,
                incoming,
                outgoing,
                None,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()
        });
        let mut app = App::new(jobs);
        app.send(Job::History(None));
        app.reply(replies.recv_timeout(Duration::from_secs(10)).unwrap());
        assert_eq!(app.commits[0].id, merge);
        assert_eq!(app.commits.len(), PAGE);
        let first_row = app.rows[0].clone();
        assert_eq!(drawn(&first_row), "●─┬─╮");
        app.send(Job::History(app.cursor.clone()));
        app.reply(replies.recv_timeout(Duration::from_secs(10)).unwrap());
        assert_eq!(app.commits.len(), PAGE + 4);
        assert_eq!(app.rows[0], first_row);
        assert!(app.graph.lanes.is_empty());
        drop(app);
        worker.join().unwrap();
        assert_eq!(git(&["rev-parse", "HEAD"]), merge);
        assert_eq!(std::fs::read(dir.path().join(".git/index")).unwrap(), index);
        assert_eq!(std::fs::read(dir.path().join("file")).unwrap(), b"base\n");
    }
}
