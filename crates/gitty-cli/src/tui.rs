use crate::invalid;
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode as Key, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use gitty_core::{
    askpass::{self, AskpassContext, AskpassRegistry},
    blame::Blame,
    branch_delete::{BranchBatchDeleteItem, BranchBatchDeleteRequest},
    dto::{
        CommitDetail, CommitIdentity, CommitSummary, DiffFile, DiffSpec, FileDiff, HistoryPage,
        RepositoryLocation, RepositoryState, Result, SearchQuery, SearchResult, StatusEntry,
    },
    editor::{self, EditorRegistry},
    operation_dto::{
        ConflictFile, ConflictResolution, GitAction, OperationKind, OperationRequest,
        OperationState, RebaseInstruction, RebaseStep,
    },
    remote::{TerminalRemoteReview, TerminalSync},
    remote_dto::{StashAction, StashEntry, SyncInfo},
    repository::{Repository, Service},
    terminal::{CommitReview, StageReview, StashReview, TerminalBranch},
    Error,
};
use ratatui::DefaultTerminal;
use std::{
    collections::HashMap,
    io::{self, IsTerminal},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

mod keys;
mod settings;
mod theme;
mod view;
use keys::{Command, Keymap};
use settings::{Profile, Settings};
use view::{render, safe};

const WRITES: bool = cfg!(unix);
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
    operation: OperationState,
    state: RepositoryState,
    sync: Option<SyncInfo>,
    changes: Option<usize>,
    stashes: Vec<StashEntry>,
}

/// The `bool` on Commit/Diff jobs opens the result; otherwise it only fills a preview pane.
enum Job {
    Open(String),
    History(Option<String>),
    Commit(String, bool),
    Diff(DiffSpec, String, bool),
    Working,
    StageReview(String, bool),
    Stage(StageReview),
    StageAllReview(Vec<String>, bool),
    StageAll(Vec<StageReview>),
    Hunk(HunkReview),
    DiscardReview(String),
    Discard(DiscardReview),
    CommitReview(Option<CommitIdentity>),
    Save(CommitReview, String, bool),
    Sync,
    RemoteReview(TerminalSync, String, Option<String>),
    Remote(TerminalRemoteReview),
    Verify(TerminalRemoteReview),
    StashReview,
    Stash(StashReview),
    Pop(String),
    Branches(bool),
    OperationReview(GitAction),
    Operation(OperationRequest),
    DeleteReview(String),
    Delete(BranchBatchDeleteRequest),
    Stashes(Option<String>, bool),
    InspectStash(StashEntry, bool),
    StoredStashReview(StashEntry, StashVerb),
    StoredStash(StoredStashReview),
    Search(u64, String, Arc<AtomicBool>),
    RebasePlan(String),
    Conflicts(bool),
    Conflict(String),
    Resolve(ConflictFile, ConflictResolution),
    Blame(Option<String>, String),
}

enum Reply {
    Opened(Snapshot, HistoryPage, Arc<Repository>),
    History(Option<Snapshot>, HistoryPage),
    Commit(CommitDetail, Vec<DiffFile>, bool),
    Diff(String, FileDiff, bool),
    Working(Vec<StatusEntry>),
    StageReview(StageReview),
    StageAllReview(Vec<StageReview>),
    DiscardReview(DiscardReview),
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
    Branches(Vec<TerminalBranch>, bool),
    OperationReview(OperationRequest),
    DeleteReview(BranchBatchDeleteRequest),
    Stashes(Vec<StashEntry>, Option<String>, bool),
    InspectStash(CommitDetail, Vec<DiffFile>, StashEntry, bool),
    StoredStashReview(StoredStashReview),
    Search(u64, Result<SearchResult>),
    RebasePlan(OperationRequest, HashMap<String, String>),
    Conflicts(OperationState, bool),
    Conflict(ConflictFile),
    Blame(Blame),
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
    Edit(EditorMessage),
    EditExpired(usize),
}

struct EditorMessage {
    id: usize,
    name: String,
    content: String,
}

fn rebase_plan(
    repo: &Repository,
    source: &str,
) -> Result<(OperationRequest, HashMap<String, String>)> {
    let operation = repo.operation_state()?;
    let state = repo.state()?;
    let onto = repo.commit(source)?.summary.id;
    let mut current = state
        .session
        .head
        .clone()
        .ok_or_else(|| invalid("No HEAD to rebase."))?;
    let mut steps = Vec::new();
    let mut subjects = HashMap::new();
    while current != onto {
        if steps.len() == 100 {
            return Err(invalid("Select a base within 100 linear commits of HEAD."));
        }
        let commit = repo.commit(&current)?.summary;
        if commit.parents.len() != 1 {
            return Err(invalid(
                "The selected base must be an ancestor in a linear history.",
            ));
        }
        subjects.insert(current.clone(), commit.subject);
        steps.push(RebaseStep {
            oid: current,
            instruction: RebaseInstruction::Pick,
        });
        current = commit.parents[0].clone();
    }
    if steps.is_empty() {
        return Err(invalid("Select a commit before HEAD as the rebase base."));
    }
    steps.reverse();
    if repo.operation_state()?.fingerprint != operation.fingerprint {
        return Err(Error::new(
            "staleOperation",
            "Repository changed while preparing the plan.",
        ));
    }
    Ok((
        OperationRequest {
            action: GitAction::InteractiveRebase { onto, steps },
            expected_head: state.session.head,
            expected_head_ref: state.session.head_ref,
            expected_operation: operation.fingerprint,
        },
        subjects,
    ))
}

fn snapshot(repo: &Repository, bare: bool) -> Result<(Snapshot, HistoryPage)> {
    // Reading status first also reconciles the index after a write.
    let changes = if bare {
        None
    } else {
        Some(repo.status_entries()?.entries.len())
    };
    for _ in 0..3 {
        let state = repo.state()?;
        let page = repo.history(None, PAGE, Default::default())?;
        if repo.state()?.fingerprint == state.fingerprint {
            return Ok((
                Snapshot {
                    operation: repo.operation_state()?,
                    state,
                    sync: repo.sync_info().ok(),
                    changes,
                    stashes: repo.stashes().unwrap_or_default(),
                },
                page,
            ));
        }
    }
    Err(Error::new(
        "unstable",
        "Repository refs changed during refresh. Try again.",
    ))
}

fn worker(
    jobs: mpsc::Receiver<Job>,
    replies: mpsc::Sender<Result<Reply>>,
    registry: Option<Arc<AskpassRegistry>>,
    cancel: Arc<AtomicBool>,
    editor: Option<Arc<EditorRegistry>>,
) -> Result<()> {
    gitty_core::process::terminal_worker(cancel);
    let data = tempfile::tempdir()?;
    let service = Service::new(data.path().into());
    let mut active: Option<(String, bool)> = None;
    for job in jobs {
        let reply = (|| -> Result<Reply> {
            if let Job::Open(path) = job {
                let session = service.open(RepositoryLocation::Native { path })?.session;
                let result = service
                    .repo(&session.handle)
                    .and_then(|repo| snapshot(&repo, session.bare));
                let (snapshot, page) = match result {
                    Ok(loaded) => loaded,
                    Err(error) => {
                        service.close(&session.handle)?;
                        return Err(error);
                    }
                };
                if let Some((handle, _)) = &active {
                    service.close(handle)?;
                }
                active = Some((session.handle, session.bare));
                return Ok(Reply::Opened(
                    snapshot,
                    page,
                    service.repo(&active.as_ref().unwrap().0)?,
                ));
            }
            let (handle, bare) = active
                .as_ref()
                .ok_or_else(|| Error::new("noRepository", "Open a repository first."))?;
            let repo = service.repo(handle)?;
            let snapshot = || snapshot(&repo, *bare);
            Ok(match job {
                Job::History(None) => {
                    let (snapshot, page) = snapshot()?;
                    Reply::History(Some(snapshot), page)
                }
                Job::History(cursor) => {
                    Reply::History(None, repo.history(cursor, PAGE, Default::default())?)
                }
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
                Job::Branches(open) => Reply::Branches(repo.terminal_branches()?, open),
                Job::Conflicts(open) => Reply::Conflicts(repo.operation_state()?, open),
                Job::Conflict(path) => Reply::Conflict(repo.conflict_file(&path)?),
                Job::Blame(revision, path) => Reply::Blame(repo.blame(revision.as_deref(), &path)?),
                Job::Resolve(file, resolution) if WRITES => Reply::Wrote {
                    outcome: service
                        .resolve_conflict(handle, &file.path, &file.fingerprint, resolution)
                        .map(|()| "Conflict resolved and staged.".into()),
                    committed: false,
                    refresh: snapshot(),
                },
                Job::RebasePlan(source) => {
                    let (review, subjects) = rebase_plan(&repo, &source)?;
                    Reply::RebasePlan(review, subjects)
                }
                Job::OperationReview(action) => {
                    let before = repo.operation_state()?;
                    let state = repo.state()?;
                    if repo.operation_state()?.fingerprint != before.fingerprint {
                        return Err(Error::new(
                            "staleOperation",
                            "Repository changed during review.",
                        ));
                    }
                    Reply::OperationReview(OperationRequest {
                        action,
                        expected_head: state.session.head,
                        expected_head_ref: state.session.head_ref,
                        expected_operation: before.fingerprint,
                    })
                }
                Job::Operation(review) if WRITES => {
                    let done = match review.action {
                        GitAction::CreateBranch { .. } => "Branch created.",
                        GitAction::RenameBranch { .. } => "Branch renamed.",
                        GitAction::SwitchBranch { .. } => "Checked out branch.",
                        GitAction::Merge { .. } => "Merge completed.",
                        GitAction::Rebase { .. } => "Rebase completed.",
                        GitAction::CherryPick { .. } => "Cherry-pick completed.",
                        GitAction::CreateTag { .. } => "Tag created.",
                        GitAction::Continue => "Operation continued.",
                        GitAction::Skip => "Commit skipped.",
                        GitAction::Abort => "Operation aborted.",
                        _ => "Operation completed.",
                    };
                    Reply::Wrote {
                        outcome: service
                            .run_operation(handle, review, editor.as_deref())
                            .map(|r| {
                                r.notice.unwrap_or_else(|| {
                                    if r.operation.kind == OperationKind::None
                                        && r.operation.conflicts.is_empty()
                                    {
                                        done.into()
                                    } else {
                                        format!(
                                            "Operation paused: {} · {} conflicts.",
                                            r.operation.label,
                                            r.operation.conflicts.len()
                                        )
                                    }
                                })
                            }),
                        committed: false,
                        refresh: snapshot(),
                    }
                }
                Job::DeleteReview(reference) => {
                    let state = repo.state()?;
                    let entry = state
                        .refs
                        .iter()
                        .find(|r| r.full_name == reference)
                        .ok_or_else(|| Error::new("staleOperation", "Branch no longer exists."))?;
                    let (branch, local) = if let Some(name) = reference.strip_prefix("refs/heads/")
                    {
                        (name.to_owned(), true)
                    } else if let Some(name) = reference
                        .strip_prefix("refs/remotes/origin/")
                        .filter(|n| *n != "HEAD")
                    {
                        (name.to_owned(), false)
                    } else {
                        return Err(Error::new(
                            "unsupportedOperation",
                            "Deletion supports local and origin branches.",
                        ));
                    };
                    let push_url = if local {
                        None
                    } else {
                        Some(
                            repo.remotes()?
                                .into_iter()
                                .find(|r| r.name == "origin")
                                .ok_or_else(|| Error::new("noRemote", "origin is not configured."))?
                                .push_url,
                        )
                    };
                    Reply::DeleteReview(BranchBatchDeleteRequest {
                        branches: vec![BranchBatchDeleteItem {
                            branch,
                            expected_local_oid: local.then(|| entry.commit_id.clone()),
                            expected_origin_oid: (!local).then(|| entry.commit_id.clone()),
                        }],
                        expected_head: state.session.head,
                        expected_head_ref: state.session.head_ref,
                        expected_push_url: push_url,
                        delete_local: local,
                        delete_origin: !local,
                        force_local: vec![],
                    })
                }
                Job::Delete(review) if WRITES => {
                    let remote = review.delete_origin;
                    let outcome = service
                        .delete_branches(handle, review, registry.as_deref())
                        .and_then(|result| {
                            for branch in result.branches {
                                for target in [branch.local, branch.origin].into_iter().flatten() {
                                    if target.status != "deleted" {
                                        return Err(target.error.unwrap_or_else(|| {
                                            Error::new(
                                                "mutationUnverified",
                                                target.note.unwrap_or_else(|| {
                                                    format!("Deletion: {}", target.status)
                                                }),
                                            )
                                        }));
                                    }
                                }
                            }
                            Ok("Branch deleted.".into())
                        })
                        .map_err(|e| if remote { remote_error(e) } else { e });
                    Reply::Wrote {
                        outcome,
                        committed: false,
                        refresh: snapshot(),
                    }
                }
                Job::Stashes(selected, open) => Reply::Stashes(repo.stashes()?, selected, open),
                Job::InspectStash(entry, untracked) => {
                    let mut detail = repo.commit(&entry.oid)?;
                    if untracked {
                        let oid = detail.summary.parents.get(2).ok_or_else(|| {
                            Error::new("noUntracked", "This stash has no saved untracked files.")
                        })?;
                        detail = repo.commit(oid)?;
                    }
                    let spec = DiffSpec::Commit {
                        oid: detail.summary.id.clone(),
                        parent: None,
                    };
                    let files = repo.diff_files(&spec)?;
                    Reply::InspectStash(detail, files, entry, untracked)
                }
                Job::StoredStashReview(entry, verb) => {
                    let before = repo.operation_state()?;
                    let entry = repo
                        .stashes()?
                        .into_iter()
                        .find(|s| s.oid == entry.oid)
                        .ok_or_else(|| {
                            Error::new("staleStash", "The selected stash no longer exists.")
                        })?;
                    let state = repo.state()?;
                    if repo.operation_state()?.fingerprint != before.fingerprint {
                        return Err(Error::new(
                            "staleOperation",
                            "Repository changed during review.",
                        ));
                    }
                    Reply::StoredStashReview(StoredStashReview {
                        entry,
                        verb,
                        restore_index: false,
                        operation: before.fingerprint,
                        destination: state
                            .session
                            .head_ref
                            .or(state.session.head)
                            .unwrap_or_default(),
                    })
                }
                Job::StoredStash(review) if WRITES => Reply::Wrote {
                    outcome: service
                        .terminal_stash_action(handle, review.action(), &review.operation)
                        .map(|_| format!("Stash {} completed.", review.verb.label())),
                    committed: false,
                    refresh: snapshot(),
                },
                Job::Search(id, text, cancel) => Reply::Search(
                    id,
                    repo.search_cancellable(
                        SearchQuery {
                            text,
                            branch: None,
                            since: None,
                            until: None,
                            path: None,
                        },
                        cancel,
                    ),
                ),
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
                Job::StageAllReview(paths, unstage) => Reply::StageAllReview(
                    paths
                        .iter()
                        .map(|path| repo.terminal_review_stage(path, unstage))
                        .collect::<Result<_>>()?,
                ),
                Job::StageAll(reviews) if WRITES => Reply::Wrote {
                    outcome: service
                        .terminal_stage_many(handle, reviews)
                        .map(|()| "Updated the reviewed list.".into()),
                    committed: false,
                    refresh: snapshot(),
                },
                Job::Hunk(review) if WRITES => {
                    let outcome = match review.kind {
                        HunkKind::Stage => service.stage_hunk(
                            handle,
                            &review.preview.path,
                            review.index,
                            &review.fingerprint,
                            review.lines,
                        ),
                        HunkKind::Unstage => service.unstage_hunk(
                            handle,
                            &review.preview.path,
                            review.index,
                            &review.fingerprint,
                            review.lines,
                        ),
                        HunkKind::Discard => service.discard_hunk(
                            handle,
                            &review.preview.path,
                            review.index,
                            &review.fingerprint,
                        ),
                    }
                    .map(|()| format!("{} completed.", review.kind.verb()));
                    Reply::Wrote {
                        outcome,
                        committed: false,
                        refresh: snapshot(),
                    }
                }
                Job::DiscardReview(path) => {
                    let status = repo.status()?;
                    let entry =
                        status
                            .entries
                            .iter()
                            .find(|e| e.path == path)
                            .ok_or_else(|| {
                                Error::new(
                                    "staleOperation",
                                    "File changed; refresh and review again.",
                                )
                            })?;
                    let preview = repo.diff(
                        &if entry.untracked {
                            DiffSpec::Untracked
                        } else {
                            DiffSpec::Unstaged
                        },
                        &path,
                    )?;
                    if repo.status()?.fingerprint != status.fingerprint {
                        return Err(Error::new(
                            "staleOperation",
                            "File changed; refresh and review again.",
                        ));
                    }
                    Reply::DiscardReview(DiscardReview {
                        fingerprint: status.fingerprint,
                        untracked: entry.untracked,
                        delete_confirmed: false,
                        preview,
                    })
                }
                Job::Discard(review) if WRITES => Reply::Wrote {
                    outcome: service
                        .discard(handle, &[review.preview.path], &review.fingerprint)
                        .map(|()| "Discarded the reviewed file changes.".into()),
                    committed: false,
                    refresh: snapshot(),
                },
                Job::CommitReview(identity) => {
                    Reply::CommitReview(repo.terminal_review_commit_with_identity(identity)?)
                }
                Job::Save(review, message, amend) if WRITES => {
                    let outcome = if amend {
                        service.terminal_amend(handle, review, &message)
                    } else {
                        service.terminal_commit(handle, review, &message)
                    };
                    let committed = outcome.is_ok();
                    let outcome = outcome.map(|(commit, matches)| {
                        format!(
                            "{} {}{}",
                            if amend { "Amended" } else { "Committed" },
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
    if let Some((handle, _)) = active {
        service.close(&handle)?;
    }
    Ok(())
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
    Repositories,
    History,
    Files,
    Working,
    Diff,
    Composer,
    Remote,
    Publish,
    Confirm,
    Settings,
    Profiles,
    ProfileEdit,
    Branches,
    BranchName,
    Stashes,
    Search,
    RebasePlan,
    Conflicts,
    Conflict,
    Blame,
    Message,
}

struct ProfileEditor {
    id: usize,
    field: usize,
    values: [String; 3],
}

impl ProfileEditor {
    fn profile(&self) -> Profile {
        let [label, name, email] = self.values.each_ref().map(|s| s.trim().to_owned());
        Profile {
            id: self.id,
            label,
            name,
            email,
        }
    }
}

enum Confirm {
    Resolve(ConflictFile, ConflictResolution),
    Stage(StageReview),
    StageAll(Vec<StageReview>),
    Hunk(HunkReview),
    Discard(DiscardReview),
    Remote(TerminalRemoteReview),
    Stash(StashReview),
    Pop(StashEntry),
    Operation(OperationRequest),
    Delete(BranchBatchDeleteRequest),
    StoredStash(StoredStashReview),
}

struct BranchEditor {
    tag: bool,
    source: String,
    rename: bool,
    name: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StashVerb {
    Apply,
    Pop,
    Drop,
}

impl StashVerb {
    fn label(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::Pop => "pop",
            Self::Drop => "drop",
        }
    }
}

struct StoredStashReview {
    entry: StashEntry,
    verb: StashVerb,
    restore_index: bool,
    operation: String,
    destination: String,
}

impl StoredStashReview {
    fn action(&self) -> StashAction {
        let oid = self.entry.oid.clone();
        match self.verb {
            StashVerb::Apply => StashAction::Apply {
                oid,
                restore_index: self.restore_index,
            },
            StashVerb::Pop => StashAction::Pop {
                oid,
                restore_index: self.restore_index,
            },
            StashVerb::Drop => StashAction::Drop { oid },
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HunkKind {
    Stage,
    Unstage,
    Discard,
}

impl HunkKind {
    fn verb(self) -> &'static str {
        match self {
            Self::Stage => "Stage",
            Self::Unstage => "Unstage",
            Self::Discard => "Discard",
        }
    }
}

struct HunkReview {
    index: usize,
    fingerprint: String,
    lines: Option<Vec<usize>>,
    kind: HunkKind,
    preview: FileDiff,
}

struct DiscardReview {
    fingerprint: String,
    untracked: bool,
    delete_confirmed: bool,
    preview: FileDiff,
}

fn hunk_row(diff: &FileDiff, index: usize) -> usize {
    diff.hunks
        .iter()
        .take(index)
        .map(|h| h.lines.len() + 2)
        .sum()
}

fn diff_position(diff: &FileDiff, row: usize) -> Option<(usize, Option<usize>)> {
    let mut start = 0;
    for (index, hunk) in diff.hunks.iter().enumerate() {
        if row <= start + hunk.lines.len() {
            return Some((index, row.checked_sub(start + 1)));
        }
        start += hunk.lines.len() + 2;
    }
    None
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
    Setting(usize),
    ProfilePage,
    Repository(usize),
    Profile(usize),
    ProfileField(usize),
    Action(Action),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone {
    Info,
    Good,
    Bad,
}

struct App {
    blame: Option<Blame>,
    blame_row: usize,
    conflict: Option<ConflictFile>,
    conflict_index: usize,
    conflict_side: usize,
    editor: Option<Arc<EditorRegistry>>,
    editor_message: Option<EditorMessage>,
    editor_back: View,
    plan: Option<OperationRequest>,
    plan_subjects: HashMap<String, String>,
    plan_row: usize,
    operation: Option<OperationState>,
    keymap: Keymap,
    help: bool,
    help_scroll: usize,
    config_error: Option<String>,
    jobs: mpsc::SyncSender<Job>,
    busy: bool,
    writing: bool,
    switching: bool,
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
    line_anchor: Option<usize>,
    staged: bool,
    detail: Option<(CommitDetail, Vec<DiffFile>)>,
    entries: Vec<StatusEntry>,
    diff: Option<FileDiff>,
    review: Option<CommitReview>,
    amend: bool,
    message: String,
    /// Drafts and uncertain push checks survive switching away from a worktree.
    inactive: HashMap<String, (String, Option<TerminalRemoteReview>)>,
    sync: Option<SyncInfo>,
    publish: String,
    uncertain: Option<TerminalRemoteReview>,
    confirm: Option<Confirm>,
    notice: String,
    /// Index of the applied theme, and of the one highlighted in settings.
    theme: usize,
    settings: usize,
    config: Settings,
    config_path: Option<PathBuf>,
    config_unreadable: bool,
    repo_selection: usize,
    repo_path: String,
    repo_back: View,
    profile_selection: usize,
    profile_editor: Option<ProfileEditor>,
    /// Columns the diff is panned to the right.
    hscroll: usize,
    branches: Vec<TerminalBranch>,
    branch: usize,
    branch_editor: Option<BranchEditor>,
    stash: usize,
    stash_detail: Option<(StashEntry, bool)>,
    search_text: String,
    search_id: u64,
    search_cancel: Option<Arc<AtomicBool>>,
    search_repo: Option<Arc<Repository>>,
    matches: Vec<String>,
    match_index: usize,
    search_target: Option<String>,
}

impl App {
    fn new(jobs: mpsc::SyncSender<Job>) -> Self {
        Self {
            blame: None,
            blame_row: 0,
            conflict: None,
            conflict_index: 0,
            conflict_side: 0,
            editor: None,
            editor_message: None,
            editor_back: View::History,
            plan: None,
            plan_subjects: HashMap::new(),
            plan_row: 0,
            operation: None,
            keymap: Keymap::default(),
            help: false,
            help_scroll: 0,
            config_error: None,
            jobs,
            busy: false,
            writing: false,
            switching: false,
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
            line_anchor: None,
            staged: false,
            detail: None,
            entries: Vec::new(),
            diff: None,
            review: None,
            amend: false,
            message: String::new(),
            inactive: HashMap::new(),
            sync: None,
            publish: String::new(),
            uncertain: None,
            confirm: None,
            notice: String::new(),
            theme: 0,
            settings: 0,
            config: Settings::default(),
            config_path: None,
            config_unreadable: false,
            repo_selection: 0,
            repo_path: String::new(),
            repo_back: View::History,
            profile_selection: 0,
            profile_editor: None,
            hscroll: 0,
            branches: vec![],
            branch: 0,
            branch_editor: None,
            stash: 0,
            stash_detail: None,
            search_text: String::new(),
            search_id: 0,
            search_cancel: None,
            search_repo: None,
            matches: vec![],
            match_index: 0,
            search_target: None,
        }
    }

    fn send(&mut self, job: Job) {
        let switching = matches!(job, Job::Open(_));
        let write = matches!(
            job,
            Job::Stage(_)
                | Job::StageAll(_)
                | Job::Hunk(_)
                | Job::Discard(_)
                | Job::Save(..)
                | Job::Remote(_)
                | Job::Stash(_)
                | Job::Pop(_)
                | Job::Operation(_)
                | Job::Delete(_)
                | Job::StoredStash(_)
                | Job::Resolve(..)
        );
        if self.busy || (write && self.locked) {
            return;
        }
        match self.jobs.try_send(job) {
            Ok(()) => {
                self.busy = true;
                self.writing = write;
                self.switching = switching;
                if write || switching {
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

    fn root(&self) -> Option<&str> {
        self.state.as_ref().map(|s| s.session.root.as_str())
    }

    fn selected_profile(&self) -> Option<&Profile> {
        self.config.profile(self.root()?)
    }

    fn save_config(&mut self, message: impl Into<String>) {
        let message = message.into();
        let result = if self.config_unreadable {
            Err(io::Error::other("existing settings could not be read"))
        } else {
            self.config.save(self.config_path.as_deref())
        };
        match result {
            Ok(()) => self.say(Tone::Good, message),
            Err(error) => self.say(Tone::Bad, format!("{message} In memory only: {error}.")),
        }
    }

    fn opened(&mut self, snapshot: Snapshot, page: HistoryPage) {
        let root = snapshot.state.session.root.clone();
        let name = snapshot.state.session.name.clone();
        let mut fresh = Self::new(self.jobs.clone());
        fresh.wide = self.wide;
        fresh.quit = self.quit;
        fresh.theme = self.theme;
        fresh.config = std::mem::take(&mut self.config);
        fresh.config_path = self.config_path.take();
        fresh.config_unreadable = self.config_unreadable;
        fresh.config_error = self.config_error.take();
        fresh.keymap = self.keymap.clone();
        fresh.editor = self.editor.clone();
        fresh.inactive = std::mem::take(&mut self.inactive);
        if let Some(from) = self.root().map(str::to_owned) {
            if !self.message.is_empty() || self.uncertain.is_some() {
                fresh.inactive.insert(
                    from,
                    (std::mem::take(&mut self.message), self.uncertain.take()),
                );
            }
        }
        if let Some((message, uncertain)) = fresh.inactive.remove(&root) {
            fresh.message = message;
            fresh.uncertain = uncertain;
        }
        fresh.page(Some(snapshot), page);
        let message = format!("Opened {name}.");
        if fresh.config.remember(&root) {
            fresh.save_config(message);
        } else {
            fresh.say(Tone::Good, message);
        }
        if let Some(error) = &fresh.config_error {
            fresh.say(
                Tone::Bad,
                format!(
                    "Settings: {error}. Using defaults; existing file will not be overwritten."
                ),
            );
        }
        *self = fresh;
    }

    fn edit_profile(&mut self, new: bool) {
        let existing = self
            .profile_selection
            .checked_sub(1)
            .and_then(|i| self.config.profiles.get(i));
        let editor = if new {
            if self.config.profiles.len() >= settings::MAX_PROFILES {
                self.say(Tone::Bad, "Delete a profile before adding another.");
                return;
            }
            let id = (1..)
                .find(|id| !self.config.profiles.iter().any(|p| p.id == *id))
                .unwrap();
            ProfileEditor {
                id,
                field: 0,
                values: Default::default(),
            }
        } else if let Some(p) = existing {
            ProfileEditor {
                id: p.id,
                field: 0,
                values: [p.label.clone(), p.name.clone(), p.email.clone()],
            }
        } else {
            return;
        };
        self.profile_editor = Some(editor);
        self.view = View::ProfileEdit;
    }

    fn save_profile(&mut self) {
        let Some(editor) = &self.profile_editor else {
            return;
        };
        let profile = editor.profile();
        if !profile.valid_label() {
            self.say(Tone::Bad, "Enter a profile label (up to 80 bytes).");
            return;
        }
        if let Err(error) = profile.identity().validate() {
            self.say(Tone::Bad, error_text(error));
            return;
        }
        if let Some(i) = self.config.profiles.iter().position(|p| p.id == profile.id) {
            self.config.profiles[i] = profile;
            self.profile_selection = i + 1;
        } else {
            self.config.profiles.push(profile);
            self.profile_selection = self.config.profiles.len();
        }
        self.profile_editor = None;
        self.view = View::Profiles;
        self.save_config("Profile saved.");
    }

    fn paste(&mut self, text: &str) {
        if self.help {
            return;
        }
        let (field, limit, multiline) = match self.view {
            View::Message => {
                let Some(message) = &mut self.editor_message else {
                    return;
                };
                (&mut message.content, 256 * 1024, true)
            }
            View::Composer => (&mut self.message, 65536, true),
            View::Search => (&mut self.search_text, 4096, false),
            View::BranchName => {
                let Some(editor) = &mut self.branch_editor else {
                    return;
                };
                (&mut editor.name, 1024, false)
            }
            View::Repositories if self.repo_selection == 0 => (&mut self.repo_path, 32768, false),
            View::ProfileEdit => {
                let Some(editor) = &mut self.profile_editor else {
                    return;
                };
                (
                    &mut editor.values[editor.field],
                    [80, 120, 254][editor.field],
                    false,
                )
            }
            _ => return,
        };
        let normalized = text.replace("\r\n", "\n");
        for c in if multiline {
            normalized.as_str()
        } else {
            normalized.lines().next().unwrap_or("")
        }
        .chars()
        {
            if field.len() + c.len_utf8() > limit {
                break;
            }
            if !c.is_control() || (multiline && matches!(c, '\n' | '\t')) {
                field.push(c);
            }
        }
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
        self.line_anchor = None;
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
        if let Some(target) = &self.search_target {
            if let Some(i) = self.commits.iter().position(|c| &c.id == target) {
                self.history = i;
                self.search_target = None;
            } else if let Some(cursor) = self.cursor.clone() {
                self.send(Job::History(Some(cursor)));
                return;
            } else {
                self.search_target = None;
                self.say(
                    Tone::Info,
                    "Search match is no longer in this history; search again.",
                );
            }
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
            operation,
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
            self.operation = Some(operation);
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
            self.say(
                Tone::Info,
                format!(
                    "History changed; press {} to refresh.",
                    self.keymap.label("refresh")
                ),
            );
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
        self.switching = false;
        match reply {
            Ok(Reply::Opened(snapshot, page, repo)) => {
                self.cancel_search();
                self.opened(snapshot, page);
                self.search_repo = Some(repo);
            }
            Ok(Reply::History(snapshot, page)) => self.page(snapshot, page),
            Ok(Reply::Commit(detail, files, open)) => {
                self.stash_detail = None;
                self.detail = Some((detail, files));
                if open {
                    self.file = 0;
                    self.scroll = 0;
                    self.view = View::Files;
                }
            }
            Ok(Reply::Branches(branches, open)) => {
                self.branches = branches;
                self.branch = self.branch.min(self.branches.len().saturating_sub(1));
                if open {
                    self.view = View::Branches;
                }
            }
            Ok(Reply::Conflicts(operation, open)) => {
                self.conflict_index = self
                    .conflict_index
                    .min(operation.conflicts.len().saturating_sub(1));
                self.operation = Some(operation);
                if open {
                    self.view = View::Conflicts;
                }
            }
            Ok(Reply::Conflict(file)) => {
                self.conflict = Some(file);
                self.conflict_side = 0;
                self.scroll = 0;
                self.view = View::Conflict;
            }
            Ok(Reply::Blame(blame)) => {
                self.blame = Some(blame);
                self.blame_row = 0;
                self.view = View::Blame;
            }
            Ok(Reply::RebasePlan(review, subjects)) => {
                self.plan = Some(review);
                self.plan_subjects = subjects;
                self.plan_row = 0;
                self.view = View::RebasePlan;
            }
            Ok(Reply::OperationReview(review)) => {
                self.confirm = Some(Confirm::Operation(review));
                self.scroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::DeleteReview(review)) => {
                self.confirm = Some(Confirm::Delete(review));
                self.scroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::Stashes(stashes, selected, open)) => {
                self.stashes = stashes;
                self.stash = selected
                    .and_then(|oid| self.stashes.iter().position(|s| s.oid == oid))
                    .unwrap_or(self.stash)
                    .min(self.stashes.len().saturating_sub(1));
                if open {
                    self.view = View::Stashes;
                }
            }
            Ok(Reply::InspectStash(detail, files, entry, untracked)) => {
                self.detail = Some((detail, files));
                self.stash_detail = Some((entry, untracked));
                self.file = 0;
                self.scroll = 0;
                self.view = View::Files;
            }
            Ok(Reply::StoredStashReview(review)) => {
                self.confirm = Some(Confirm::StoredStash(review));
                self.scroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::Search(id, result)) if id == self.search_id => match result {
                Ok(result) => {
                    self.matches = result.commits.into_iter().map(|c| c.id).collect();
                    self.match_index = 0;
                    self.search_target = self.matches.first().cloned();
                    self.say(
                        Tone::Info,
                        format!(
                            "Search: {} matches{}.",
                            self.matches.len(),
                            if result.truncated {
                                " (first 500; refine the query)"
                            } else {
                                ""
                            }
                        ),
                    );
                }
                Err(error) => self.say(Tone::Bad, error_text(error)),
            },
            Ok(Reply::Search(..)) => {}
            Ok(Reply::Diff(key, diff, open)) => {
                self.line_anchor = None;
                self.diff = Some(diff);
                self.diff_key = Some(key);
                self.hscroll = 0;
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
                self.hscroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::StageAllReview(reviews)) => {
                self.confirm = Some(Confirm::StageAll(reviews));
                self.scroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::DiscardReview(review)) => {
                self.confirm = Some(Confirm::Discard(review));
                self.scroll = 0;
                self.hscroll = 0;
                self.view = View::Confirm;
            }
            Ok(Reply::CommitReview(review)) => {
                self.review = Some(review);
                self.amend = false;
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
                if self.editor_message.take().is_some() {
                    self.view = self.editor_back;
                }
                self.cancel_search();
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
                        if !self.quit {
                            match self.view {
                                View::Working => self.send(Job::Working),
                                View::Branches => self.send(Job::Branches(false)),
                                View::Stashes => self.send(Job::Stashes(None, false)),
                                View::Conflicts => self.send(Job::Conflicts(false)),
                                _ => {}
                            }
                        }
                    }
                    Err(_) => {
                        self.locked = true;
                        self.tone = Tone::Bad;
                        self.notice.push_str(&format!(
                            " Refresh failed; press {} before writing again.",
                            self.keymap.label("refresh")
                        ));
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
                        self.notice.push_str(&format!(
                            " Refresh failed; press {} before writing again.",
                            self.keymap.label("refresh")
                        ));
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
            return Some("Refresh before another action.");
        }
        match action {
            Action::Fetch | Action::Pull | Action::Push if self.sync_remote().is_none() => {
                Some("No remote to sync with; add one in Git.")
            }
            Action::Pull if !upstream => Some("This branch has no upstream to pull from."),
            Action::Push if self.uncertain.is_some() => {
                Some("Verify the last push in Sync before pushing again.")
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
        if self.help
            || self.writing
            || self.switching
            || matches!(
                self.view,
                View::Composer | View::Confirm | View::Publish | View::BranchName | View::Search
            )
        {
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
        if matches!(
            self.view,
            View::Repositories | View::Profiles | View::ProfileEdit
        ) && !matches!(
            hit,
            Hit::Repository(_) | Hit::Profile(_) | Hit::ProfileField(_)
        ) {
            return;
        }
        let now = std::time::Instant::now();
        let double = self.last_click.is_some_and(|(at, last)| {
            last == hit && now.duration_since(at) < Duration::from_millis(450)
        });
        self.last_click = Some((now, hit));
        match hit {
            Hit::Tab(0) => self.command(Command::History, 1),
            Hit::Tab(1) => self.command(Command::Working, 1),
            Hit::Tab(2) => self.command(Command::Remote, 1),
            Hit::Tab(3) => self.command(Command::Settings, 1),
            Hit::Tab(_) => self.command(Command::Repositories, 1),
            Hit::Staged(staged) if staged != self.staged => self.command(Command::Next, 1),
            Hit::Staged(_) => {}
            Hit::Remote(i) => self.remote = i,
            Hit::ProfilePage => self.command(Command::Next, 1),
            Hit::Repository(i) => {
                self.repo_selection = i;
                if double && i != 0 {
                    self.command(Command::Accept, 1);
                }
            }
            Hit::Profile(i) => {
                self.profile_selection = i;
                if double {
                    self.command(Command::Accept, 1);
                }
            }
            Hit::ProfileField(i) => {
                if let Some(editor) = &mut self.profile_editor {
                    editor.field = i;
                }
            }
            Hit::Action(action) => self.action(action),
            Hit::Commit(i) | Hit::File(i) | Hit::Change(i) | Hit::Setting(i) => {
                match hit {
                    Hit::Commit(_) => self.history = i,
                    Hit::File(_) => self.file = i,
                    Hit::Setting(_) => self.settings = i,
                    _ => self.working = i,
                }
                if double {
                    self.command(Command::Accept, 1);
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

    fn cancel_search(&mut self) {
        self.search_id = self.search_id.wrapping_add(1);
        if let Some(cancel) = self.search_cancel.take() {
            cancel.store(true, Ordering::Relaxed);
        }
        if let Some(repo) = &self.search_repo {
            repo.cancel_search();
        }
        if matches!(self.next, Some(Job::Search(..))) {
            self.next = None;
        }
        self.matches.clear();
        self.search_target = None;
    }

    fn branch_name(&mut self, source: String, rename: bool) {
        self.back = self.view;
        self.branch_editor = Some(BranchEditor {
            tag: false,
            source,
            rename,
            name: String::new(),
        });
        self.view = View::BranchName;
    }

    fn working_diff(&self) -> bool {
        self.view == View::Diff
            && self.back == View::Working
            && self.working_target().is_some_and(|(spec, path)| {
                matches!(spec, DiffSpec::Staged | DiffSpec::Unstaged)
                    && self.diff_key.as_deref() == Some(diff_key(&spec, &path).as_str())
            })
    }

    fn selected_lines(&self) -> Option<Vec<usize>> {
        let anchor = self.line_anchor?;
        let diff = self.diff.as_ref()?;
        let (index, _) = diff_position(diff, self.scroll)?;
        let start = hunk_row(diff, index) + 1;
        Some(
            diff.hunks[index]
                .lines
                .iter()
                .enumerate()
                .filter_map(|(i, line)| {
                    ((anchor.min(self.scroll)..=anchor.max(self.scroll)).contains(&(start + i))
                        && matches!(line.kind.as_str(), "add" | "remove"))
                    .then_some(i)
                })
                .collect(),
        )
    }

    fn review_hunk(&mut self, discard: bool) {
        if !self.working_diff() || (discard && self.staged) {
            return;
        }
        let Some(diff) = &self.diff else { return };
        let Some(fingerprint) = diff
            .hunk_action
            .as_ref()
            .and_then(|a| a.fingerprint.clone())
        else {
            let reason = diff
                .hunk_action
                .as_ref()
                .and_then(|a| a.reason.clone())
                .unwrap_or_else(|| "Use the whole-file action for this diff.".into());
            self.say(Tone::Info, reason);
            return;
        };
        let Some((index, _)) = diff_position(diff, self.scroll) else {
            return;
        };
        let lines = if discard { None } else { self.selected_lines() };
        if lines.as_ref().is_some_and(Vec::is_empty) {
            self.say(Tone::Info, "Select added or removed lines first.");
            return;
        }
        let mut preview = self.diff.take().unwrap();
        preview.hunks = vec![preview.hunks.remove(index)];
        if let Some(lines) = &lines {
            preview.hunks[0].lines = std::mem::take(&mut preview.hunks[0].lines)
                .into_iter()
                .enumerate()
                .filter_map(|(i, line)| lines.contains(&i).then_some(line))
                .collect();
        }
        self.diff_key = None;
        self.requested = None;
        self.confirm = Some(Confirm::Hunk(HunkReview {
            index,
            fingerprint,
            lines,
            kind: if discard {
                HunkKind::Discard
            } else if self.staged {
                HunkKind::Unstage
            } else {
                HunkKind::Stage
            },
            preview,
        }));
        self.back = View::Working;
        self.view = View::Confirm;
        self.scroll = 0;
        self.hscroll = 0;
        self.line_anchor = None;
    }

    fn key(&mut self, key: Key, ctrl: bool, height: usize) {
        let command = if self.help {
            self.keymap.lookup(keys::HELP, key, ctrl)
        } else {
            self.keymap.command(self, key, ctrl)
        };
        if let Some(command) = command {
            self.command(command, height);
        }
    }

    fn command(&mut self, key: Command, height: usize) {
        if key == Command::Quit {
            if let Some(editor) = &self.editor {
                editor.cancel_all();
            }
            self.cancel_search();
            self.quit = true;
            return;
        }
        // Navigation stays live during reads; nothing changes while a write runs.
        if (self.writing || self.switching) && self.view != View::Message {
            return;
        }
        if self.help {
            match key {
                Command::Help | Command::Cancel => self.help = false,
                Command::Up => self.help_scroll = self.help_scroll.saturating_sub(1),
                Command::Down => self.help_scroll = self.help_scroll.saturating_add(1),
                Command::PageUp => self.help_scroll = self.help_scroll.saturating_sub(height),
                Command::PageDown => self.help_scroll = self.help_scroll.saturating_add(height),
                _ => {}
            }
            return;
        }
        if key == Command::Help {
            self.help = true;
            self.help_scroll = 0;
            return;
        }
        if self.view == View::Message {
            match key {
                Command::SaveMessage | Command::Cancel => {
                    if let (Some(message), Some(editor)) =
                        (self.editor_message.take(), &self.editor)
                    {
                        let result = editor.reply(
                            message.id,
                            (key == Command::SaveMessage).then_some(message.content),
                        );
                        if let Err(error) = result {
                            self.say(Tone::Bad, error);
                        }
                    }
                    self.view = self.editor_back;
                }
                Command::Clear => {
                    if let Some(message) = &mut self.editor_message {
                        message.content.clear();
                    }
                }
                Command::Erase => {
                    if let Some(message) = &mut self.editor_message {
                        message.content.pop();
                    }
                }
                Command::Accept => self.paste("\n"),
                Command::Text(c) if !c.is_control() => self.paste(&c.to_string()),
                _ => {}
            }
            return;
        }
        if key == Command::Cancel {
            if self.view == View::Search
                || (self.view == View::History && self.search_cancel.is_some())
            {
                self.cancel_search();
                self.view = View::History;
                self.say(Tone::Info, "Search cancelled.");
                return;
            }
            self.view = match self.view {
                View::Diff | View::Confirm | View::Blame => self.back,
                View::Conflict => View::Conflicts,
                View::BranchName => self.back,
                View::Files if self.stash_detail.is_some() => View::Stashes,
                View::Publish => View::Remote,
                View::Profiles => View::Settings,
                View::ProfileEdit => {
                    self.profile_editor = None;
                    View::Profiles
                }
                View::Repositories if self.state.is_none() => View::Repositories,
                View::Repositories => self.repo_back,
                _ => View::History,
            };
            self.confirm = None;
            self.next = None;
            self.follow();
            return;
        }
        if matches!(key, Command::Left | Command::Right)
            && matches!(
                self.view,
                View::Diff | View::Files | View::Working | View::Confirm
            )
        {
            let diff = match (self.view, &self.confirm) {
                (View::Confirm, Some(Confirm::Stage(review))) => Some(&review.preview),
                (View::Confirm, Some(Confirm::Hunk(review))) => Some(&review.preview),
                (View::Confirm, Some(Confirm::Discard(review))) => Some(&review.preview),
                (View::Confirm, _) => None,
                _ => self.diff.as_ref(),
            };
            let limit = diff.map_or(0, view::widest).saturating_sub(8);
            self.hscroll = if key == Command::Left {
                self.hscroll.saturating_sub(8)
            } else {
                (self.hscroll + 8).min(limit.next_multiple_of(8))
            };
            return;
        }
        match self.view {
            View::RebasePlan => {
                if let Some(OperationRequest {
                    action: GitAction::InteractiveRebase { steps, .. },
                    ..
                }) = &mut self.plan
                {
                    match key {
                        Command::Up => self.plan_row = self.plan_row.saturating_sub(1),
                        Command::Down => {
                            self.plan_row = (self.plan_row + 1).min(steps.len().saturating_sub(1))
                        }
                        Command::PageUp => self.plan_row = self.plan_row.saturating_sub(height),
                        Command::PageDown => {
                            self.plan_row =
                                (self.plan_row + height).min(steps.len().saturating_sub(1))
                        }
                        Command::PlanInstruction => {
                            if let Some(step) = steps.get_mut(self.plan_row) {
                                step.instruction = match step.instruction {
                                    RebaseInstruction::Pick => RebaseInstruction::Drop,
                                    RebaseInstruction::Drop => RebaseInstruction::Reword,
                                    RebaseInstruction::Reword => RebaseInstruction::Squash,
                                    RebaseInstruction::Squash => RebaseInstruction::Fixup,
                                    RebaseInstruction::Fixup => RebaseInstruction::Pick,
                                };
                            }
                        }
                        Command::PlanUp | Command::PlanDown => {
                            let next = if key == Command::PlanUp {
                                self.plan_row.saturating_sub(1)
                            } else {
                                (self.plan_row + 1).min(steps.len().saturating_sub(1))
                            };
                            steps.swap(self.plan_row, next);
                            self.plan_row = next;
                        }
                        Command::Accept => {
                            self.confirm = self.plan.take().map(Confirm::Operation);
                            self.back = View::History;
                            self.scroll = 0;
                            self.view = View::Confirm;
                        }
                        _ => {}
                    }
                }
                return;
            }
            View::BranchName | View::Search => {
                match key {
                    Command::Accept if self.view == View::Search => {
                        let text = self.search_text.clone();
                        self.cancel_search();
                        if !text.trim().is_empty() {
                            let cancel = Arc::new(AtomicBool::new(false));
                            self.search_cancel = Some(cancel.clone());
                            self.request(Job::Search(self.search_id, text, cancel));
                            self.say(Tone::Info, "Searching history… Esc cancels.");
                        }
                        self.view = View::History;
                    }
                    Command::Accept => {
                        if let Some(editor) = &self.branch_editor {
                            let action = if editor.tag {
                                GitAction::CreateTag {
                                    name: editor.name.clone(),
                                    oid: editor.source.clone(),
                                    message: None,
                                }
                            } else if editor.rename {
                                GitAction::RenameBranch {
                                    branch: editor.source.clone(),
                                    name: editor.name.clone(),
                                }
                            } else {
                                GitAction::CreateBranch {
                                    name: editor.name.clone(),
                                    start_point: editor.source.clone(),
                                    checkout: false,
                                }
                            };
                            self.request(Job::OperationReview(action));
                        }
                    }
                    Command::Erase => {
                        if self.view == View::Search {
                            self.search_text.pop();
                        } else if let Some(editor) = &mut self.branch_editor {
                            editor.name.pop();
                        }
                    }
                    Command::Clear => {
                        if self.view == View::Search {
                            self.search_text.clear();
                        } else if let Some(editor) = &mut self.branch_editor {
                            editor.name.clear();
                        }
                    }
                    Command::Text(c) if !c.is_control() => self.paste(&c.to_string()),
                    _ => {}
                }
                return;
            }
            View::Repositories => {
                match key {
                    Command::Up => self.repo_selection = self.repo_selection.saturating_sub(1),
                    Command::Down => {
                        self.repo_selection =
                            (self.repo_selection + 1).min(self.config.recent.len())
                    }
                    Command::Accept => {
                        let path = if self.repo_selection == 0 {
                            self.repo_path.clone()
                        } else {
                            self.config.recent[self.repo_selection - 1].clone()
                        };
                        if path.is_empty() {
                            self.say(Tone::Bad, "Enter a local repository path.");
                        } else {
                            self.send(Job::Open(path));
                        }
                    }
                    Command::Erase if self.repo_selection == 0 => {
                        self.repo_path.pop();
                    }
                    Command::Clear if self.repo_selection == 0 => self.repo_path.clear(),
                    Command::Text(c)
                        if !c.is_control()
                            && self.repo_selection == 0
                            && self.repo_path.len() + c.len_utf8() <= 32768 =>
                    {
                        self.repo_path.push(c)
                    }
                    _ => {}
                }
                return;
            }
            View::Profiles => {
                match key {
                    Command::Up => {
                        self.profile_selection = self.profile_selection.saturating_sub(1)
                    }
                    Command::Down => {
                        self.profile_selection =
                            (self.profile_selection + 1).min(self.config.profiles.len())
                    }
                    Command::Next | Command::Previous => self.view = View::Settings,
                    Command::New => self.edit_profile(true),
                    Command::Edit => self.edit_profile(false),
                    Command::Delete if self.profile_selection > 0 => {
                        let profile = self.config.profiles.remove(self.profile_selection - 1);
                        self.config.assignments.retain(|_, id| *id != profile.id);
                        self.profile_selection =
                            self.profile_selection.min(self.config.profiles.len());
                        self.save_config(
                            "Profile deleted. Its repositories will use Git defaults.",
                        );
                    }
                    Command::Accept => {
                        if let Some(root) = self.root().map(str::to_owned) {
                            if let Some(i) = self.profile_selection.checked_sub(1) {
                                self.config
                                    .assignments
                                    .insert(root, self.config.profiles[i].id);
                                self.save_config("Profile assigned to this repository.");
                            } else {
                                self.config.assignments.remove(&root);
                                self.save_config("This repository will use Git defaults.");
                            }
                        } else {
                            self.say(Tone::Info, "Open a repository before choosing its profile.");
                        }
                    }
                    _ => {}
                }
                return;
            }
            View::ProfileEdit => {
                if let Some(editor) = &mut self.profile_editor {
                    match key {
                        Command::Next => editor.field = (editor.field + 1) % 3,
                        Command::Previous => editor.field = (editor.field + 2) % 3,
                        Command::Accept => self.save_profile(),
                        Command::Erase => {
                            editor.values[editor.field].pop();
                        }
                        Command::Clear => editor.values[editor.field].clear(),
                        Command::Text(c) if !c.is_control() => {
                            let field = &mut editor.values[editor.field];
                            if field.len() + c.len_utf8() <= [80, 120, 254][editor.field] {
                                field.push(c);
                            }
                        }
                        _ => {}
                    }
                }
                return;
            }
            View::Composer => {
                match key {
                    Command::SaveCommit if WRITES && !self.busy => {
                        if let Some(review) = self.review.take() {
                            self.view = View::History;
                            self.send(Job::Save(review, self.message.clone(), self.amend));
                        }
                    }
                    Command::Amend if self.review.as_ref().is_some_and(CommitReview::can_amend) => {
                        self.amend = !self.amend;
                    }
                    Command::Erase => {
                        self.message.pop();
                    }
                    Command::Accept => self.message.push('\n'),
                    Command::Text(c) if self.message.len() + c.len_utf8() <= 65536 => {
                        self.message.push(c)
                    }
                    Command::PageDown => {
                        let last = self
                            .review
                            .as_ref()
                            .map_or(0, |review| review.files().len().saturating_sub(1));
                        self.scroll = self.scroll.saturating_add(height / 2).min(last);
                    }
                    Command::PageUp => self.scroll = self.scroll.saturating_sub(height / 2),
                    _ => {}
                }
                return;
            }
            View::Publish => {
                match key {
                    Command::Accept => {
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
                    Command::Erase => {
                        self.publish.pop();
                    }
                    Command::Text(c) if self.publish.len() + c.len_utf8() <= 1024 => {
                        self.publish.push(c)
                    }
                    _ => {}
                }
                return;
            }
            View::Confirm => {
                match key {
                    Command::MergeStash => {
                        if let Some(Confirm::Operation(OperationRequest {
                            action: GitAction::Merge { stash_changes, .. },
                            ..
                        })) = &mut self.confirm
                        {
                            *stash_changes = !*stash_changes;
                        }
                    }
                    Command::Up => self.scroll = self.scroll.saturating_sub(1),
                    Command::Down => self.scroll = self.scroll.saturating_add(1),
                    Command::PageUp => self.scroll = self.scroll.saturating_sub(height),
                    Command::PageDown => self.scroll = self.scroll.saturating_add(height),
                    // A write never queues behind a read; press Enter again once it ends.
                    Command::IncludeUntracked => {
                        if let Some(Confirm::Stash(review)) = &mut self.confirm {
                            review.include_untracked = !review.include_untracked;
                        }
                    }
                    Command::AllowDelete => {
                        if let Some(Confirm::Discard(review)) = &mut self.confirm {
                            review.delete_confirmed = !review.delete_confirmed;
                        }
                    }
                    Command::RestoreIndex => {
                        if let Some(Confirm::StoredStash(review)) = &mut self.confirm {
                            if review.verb != StashVerb::Drop {
                                review.restore_index = !review.restore_index;
                            }
                        }
                    }
                    Command::Accept if WRITES && !self.busy => {
                        if matches!(&self.confirm, Some(Confirm::Discard(r)) if r.untracked && !r.delete_confirmed)
                        {
                            self.say(
                                Tone::Info,
                                format!(
                                    "Press {} to explicitly allow deleting this untracked file.",
                                    self.keymap.label("allow_delete")
                                ),
                            );
                            return;
                        }
                        self.view = self.back;
                        match self.confirm.take() {
                            Some(Confirm::Stage(review)) => self.send(Job::Stage(review)),
                            Some(Confirm::StageAll(reviews)) => self.send(Job::StageAll(reviews)),
                            Some(Confirm::Hunk(review)) => self.send(Job::Hunk(review)),
                            Some(Confirm::Discard(review)) => self.send(Job::Discard(review)),
                            Some(Confirm::Remote(review)) => self.send(Job::Remote(review)),
                            Some(Confirm::Stash(review)) => self.send(Job::Stash(review)),
                            Some(Confirm::Pop(entry)) => self.send(Job::Pop(entry.oid)),
                            Some(Confirm::Operation(review)) => self.send(Job::Operation(review)),
                            Some(Confirm::Resolve(file, resolution)) => {
                                self.send(Job::Resolve(file, resolution))
                            }
                            Some(Confirm::Delete(review)) => self.send(Job::Delete(review)),
                            Some(Confirm::StoredStash(review)) => {
                                self.send(Job::StoredStash(review))
                            }
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
        if WRITES && !self.locked && worktree {
            let control = match key {
                Command::Continue => Some(GitAction::Continue),
                Command::Skip => Some(GitAction::Skip),
                Command::Abort => Some(GitAction::Abort),
                _ => None,
            };
            if let Some(action) = control {
                self.back = self.view;
                self.request(Job::OperationReview(action));
                return;
            }
            if matches!(self.view, View::History | View::Branches) {
                let source = if self.view == View::Branches {
                    self.branches
                        .get(self.branch)
                        .map(|b| b.reference.full_name.clone())
                } else {
                    self.commits.get(self.history).map(|c| c.id.clone())
                };
                if let Some(source) = source {
                    let action = match key {
                        Command::Merge => Some(GitAction::Merge {
                            source,
                            destination: None,
                            no_fast_forward: false,
                            message: None,
                            stash_changes: false,
                        }),
                        Command::Rebase => Some(GitAction::Rebase { onto: source }),
                        Command::InteractiveRebase => {
                            self.request(Job::RebasePlan(source));
                            return;
                        }
                        Command::CherryPick => Some(GitAction::CherryPick {
                            commits: vec![source],
                            mainline: None,
                        }),
                        Command::Tag => {
                            self.branch_name(source, false);
                            self.branch_editor.as_mut().unwrap().tag = true;
                            return;
                        }
                        _ => None,
                    };
                    if let Some(action) = action {
                        self.back = self.view;
                        self.request(Job::OperationReview(action));
                        return;
                    }
                }
            }
        }
        match key {
            Command::Blame => {
                let target = if self.view == View::Files {
                    self.file_target().and_then(|(spec, path)| match spec {
                        DiffSpec::Commit { oid, .. } => Some((Some(oid), path)),
                        _ => None,
                    })
                } else {
                    self.working_target().map(|(_, path)| (None, path))
                };
                if let Some((revision, path)) = target {
                    self.back = self.view;
                    self.request(Job::Blame(revision, path));
                }
                return;
            }
            Command::Conflicts if worktree => {
                self.request(Job::Conflicts(true));
                return;
            }
            Command::Branches if self.state.is_some() => {
                self.request(Job::Branches(true));
                return;
            }
            Command::Stashes if worktree => {
                self.request(Job::Stashes(None, true));
                return;
            }
            Command::Repositories => {
                if self.busy {
                    self.say(
                        Tone::Info,
                        "Wait for the current read before switching repositories.",
                    );
                } else {
                    self.repo_path.clear();
                    self.repo_selection = 0;
                    self.repo_back = self.view;
                    self.view = View::Repositories;
                }
                return;
            }
            Command::History => {
                self.view = View::History;
                self.next = None;
                self.follow();
                return;
            }
            Command::Refresh => {
                self.cancel_search();
                self.view = View::History;
                self.request(Job::History(None));
                return;
            }
            Command::Working if worktree => {
                self.request(Job::Working);
                return;
            }
            Command::Remote => {
                self.request(Job::Sync);
                return;
            }
            Command::Settings => {
                if self.busy {
                    return;
                }
                self.settings = self.theme;
                self.view = View::Settings;
                self.next = None;
                return;
            }
            Command::Commit if WRITES && !self.locked && worktree => {
                self.request(Job::CommitReview(
                    self.selected_profile().map(Profile::identity),
                ));
                return;
            }
            Command::Stash => return self.action(Action::Stash),
            Command::Pop => return self.action(Action::Pop),
            // The sync view applies these to its selected remote instead.
            Command::Fetch if self.view != View::Remote => return self.action(Action::Fetch),
            Command::Pull if self.view != View::Remote => return self.action(Action::Pull),
            Command::Push if self.view != View::Remote => return self.action(Action::Push),
            _ => {}
        }
        // History rows are two lines tall.
        let page = if self.view == View::History {
            height / 2
        } else {
            height
        } as isize;
        let move_by = match key {
            Command::Up => -1,
            Command::Down => 1,
            Command::PageUp => -page,
            Command::PageDown => page,
            Command::Home => isize::MIN / 2,
            Command::End => isize::MAX / 2,
            _ => 0,
        };
        fn shift(index: &mut usize, by: isize, len: usize) {
            *index = index.saturating_add_signed(by).min(len.saturating_sub(1));
        }
        match self.view {
            View::Blame => {
                let len = self.blame.as_ref().map_or(0, |b| b.lines.len());
                shift(&mut self.blame_row, move_by, len);
                if key == Command::Accept {
                    let oid = self
                        .blame
                        .as_ref()
                        .and_then(|b| b.lines.get(self.blame_row))
                        .and_then(|l| l.oid.clone());
                    if let Some(oid) = oid {
                        self.cancel_search();
                        self.search_target = Some(oid);
                        self.view = View::History;
                    } else {
                        self.say(
                            Tone::Info,
                            "This line is uncommitted; it has no commit to open.",
                        );
                    }
                }
            }
            View::Conflicts => {
                let files = self
                    .operation
                    .as_ref()
                    .map(|o| o.conflicts.as_slice())
                    .unwrap_or_default();
                shift(&mut self.conflict_index, move_by, files.len());
                if key == Command::Accept {
                    if let Some(path) = files.get(self.conflict_index) {
                        self.request(Job::Conflict(path.clone()));
                    }
                }
            }
            View::Conflict => {
                let len = self
                    .conflict
                    .as_ref()
                    .map_or(0, |f| view::conflict_lines(f, self.conflict_side).len());
                shift(&mut self.scroll, move_by, len);
                if key == Command::Next {
                    self.conflict_side = (self.conflict_side + 1) % 3;
                    self.scroll = 0;
                }
                if WRITES && !self.locked && matches!(key, Command::Ours | Command::Theirs) {
                    if let Some(file) = self.conflict.take() {
                        let resolution = if key == Command::Ours {
                            if file.ours.is_some() {
                                ConflictResolution::Ours
                            } else {
                                ConflictResolution::Delete
                            }
                        } else if file.theirs.is_some() {
                            ConflictResolution::Theirs
                        } else {
                            ConflictResolution::Delete
                        };
                        self.confirm = Some(Confirm::Resolve(file, resolution));
                        self.back = View::Conflicts;
                        self.view = View::Confirm;
                        self.scroll = 0;
                    }
                }
            }
            View::History => {
                if key == Command::Search {
                    self.view = View::Search;
                    return;
                }
                if matches!(key, Command::NextMatch | Command::PreviousMatch)
                    && !self.matches.is_empty()
                {
                    self.match_index = if key == Command::NextMatch {
                        (self.match_index + 1) % self.matches.len()
                    } else {
                        (self.match_index + self.matches.len() - 1) % self.matches.len()
                    };
                    self.search_target = Some(self.matches[self.match_index].clone());
                }
                if key == Command::CreateHere && WRITES && !self.locked && worktree {
                    if let Some(commit) = self.commits.get(self.history) {
                        self.branch_name(commit.id.clone(), false);
                    }
                    return;
                }
                shift(&mut self.history, move_by, self.commits.len());
                if key == Command::Accept {
                    if let Some(commit) = self.commits.get(self.history) {
                        let id = commit.id.clone();
                        if self.stashes.iter().any(|s| s.oid == id) {
                            self.request(Job::Stashes(Some(id), true));
                            return;
                        }
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
                if key == Command::StashFiles {
                    if let Some((entry, untracked)) = &self.stash_detail {
                        self.request(Job::InspectStash(entry.clone(), !untracked));
                        return;
                    }
                }
                let len = self.detail.as_ref().map_or(0, |(_, files)| files.len());
                shift(&mut self.file, move_by, len);
                if key == Command::MessageUp {
                    self.scroll = self.scroll.saturating_sub(1);
                } else if key == Command::MessageDown {
                    self.scroll = self.scroll.saturating_add(1);
                } else if key == Command::Accept {
                    self.open_diff(self.file_target());
                }
            }
            View::Branches => {
                shift(&mut self.branch, move_by, self.branches.len());
                if WRITES && !self.locked {
                    if let Some(branch) = self.branches.get(self.branch) {
                        let reference = branch.reference.full_name.clone();
                        match key {
                            Command::Accept => {
                                self.back = View::Branches;
                                self.request(Job::OperationReview(GitAction::SwitchBranch {
                                    branch: reference,
                                    carry_changes: false,
                                }));
                            }
                            Command::New => self.branch_name(reference, false),
                            Command::Edit => self.branch_name(reference, true),
                            Command::Delete => {
                                self.back = View::Branches;
                                self.request(Job::DeleteReview(reference));
                            }
                            _ => {}
                        }
                    }
                }
            }
            View::Stashes => {
                shift(&mut self.stash, move_by, self.stashes.len());
                if let Some(entry) = self.stashes.get(self.stash).cloned() {
                    if key == Command::Accept {
                        self.request(Job::InspectStash(entry, false));
                    } else if WRITES && !self.locked {
                        let verb = match key {
                            Command::ApplyStash => Some(StashVerb::Apply),
                            Command::PopStash => Some(StashVerb::Pop),
                            Command::Delete => Some(StashVerb::Drop),
                            _ => None,
                        };
                        if let Some(verb) = verb {
                            self.back = View::Stashes;
                            self.request(Job::StoredStashReview(entry, verb));
                        }
                    }
                }
            }
            View::Working => {
                if key == Command::Next {
                    self.staged = !self.staged;
                    self.working = 0;
                }
                let len = self.working_rows().count();
                shift(&mut self.working, move_by, len);
                if key == Command::Accept {
                    let conflict = self
                        .working_rows()
                        .nth(self.working)
                        .filter(|e| e.conflicted)
                        .map(|e| e.path.clone());
                    if let Some(path) = conflict {
                        self.request(Job::Conflict(path));
                    } else {
                        self.open_diff(self.working_target());
                    }
                } else if key == Command::Stage && WRITES && !self.locked {
                    let entry = self.working_rows().nth(self.working);
                    if let Some(entry) = entry.filter(|e| !e.conflicted && !e.path.ends_with('/')) {
                        let path = entry.path.clone();
                        self.back = View::Working;
                        self.request(Job::StageReview(path, self.staged));
                    }
                } else if key == Command::StageAll && WRITES && !self.locked {
                    let paths: Vec<_> = self.working_rows().map(|e| e.path.clone()).collect();
                    if !paths.is_empty() {
                        self.back = View::Working;
                        self.request(Job::StageAllReview(paths, self.staged));
                    }
                } else if key == Command::Discard && WRITES && !self.locked && !self.staged {
                    let path = self
                        .working_rows()
                        .nth(self.working)
                        .filter(|e| !e.conflicted && !e.path.ends_with('/'))
                        .map(|e| e.path.clone());
                    if let Some(path) = path {
                        self.back = View::Working;
                        self.request(Job::DiscardReview(path));
                    }
                }
            }
            View::Diff => {
                let len = self
                    .diff
                    .as_ref()
                    .map_or(0, |diff| hunk_row(diff, diff.hunks.len()).saturating_sub(1));
                shift(&mut self.scroll, move_by, len);
                if self.working_diff() {
                    if let Some(diff) = &self.diff {
                        if let Some(anchor) = self.line_anchor {
                            if let Some((index, _)) = diff_position(diff, anchor) {
                                let start = hunk_row(diff, index) + 1;
                                self.scroll = self.scroll.clamp(
                                    start,
                                    start + diff.hunks[index].lines.len().saturating_sub(1),
                                );
                            }
                        }
                        if matches!(key, Command::NextHunk | Command::PreviousHunk) {
                            let next = if key == Command::NextHunk {
                                (0..diff.hunks.len()).find(|&i| hunk_row(diff, i) > self.scroll)
                            } else {
                                (0..diff.hunks.len())
                                    .rev()
                                    .find(|&i| hunk_row(diff, i) < self.scroll)
                            };
                            if let Some(index) = next {
                                self.scroll = hunk_row(diff, index);
                                self.line_anchor = None;
                            }
                        }
                        if key == Command::SelectLines {
                            if self.line_anchor.is_some() {
                                self.line_anchor = None;
                            } else if let Some((index, line)) = diff_position(diff, self.scroll) {
                                if line.is_none() {
                                    if let Some(i) = diff.hunks[index]
                                        .lines
                                        .iter()
                                        .position(|l| matches!(l.kind.as_str(), "add" | "remove"))
                                    {
                                        self.scroll = hunk_row(diff, index) + 1 + i;
                                    }
                                }
                                self.line_anchor = Some(self.scroll);
                            }
                        }
                    }
                    if WRITES && !self.locked && matches!(key, Command::Stage | Command::Discard) {
                        self.review_hunk(key == Command::Discard);
                    }
                }
                if key == Command::Next {
                    self.view = self.back;
                }
            }
            View::Settings => {
                shift(&mut self.settings, move_by, theme::themes().len());
                if matches!(key, Command::Next | Command::Previous) {
                    self.profile_selection = self
                        .selected_profile()
                        .and_then(|selected| {
                            self.config
                                .profiles
                                .iter()
                                .position(|p| p.id == selected.id)
                        })
                        .map_or(0, |i| i + 1);
                    self.view = View::Profiles;
                } else if key == Command::Accept {
                    self.theme = self.settings;
                    let name = theme::themes()[self.theme].name;
                    self.config.set_theme(self.theme);
                    self.save_config(format!("Theme set to {name}."));
                }
            }
            View::Remote => {
                if let Some(sync) = &self.sync {
                    shift(&mut self.remote, move_by, sync.remotes.len());
                    if WRITES && key == Command::Verify {
                        if let Some(review) = self.uncertain.clone() {
                            self.request(Job::Verify(review));
                        }
                    } else if WRITES && !self.locked {
                        if let Some(remote) = sync.remotes.get(self.remote).cloned() {
                            let kind = match key {
                                Command::Fetch => Some(TerminalSync::Fetch),
                                Command::Pull => Some(TerminalSync::Pull),
                                Command::Push if self.uncertain.is_none() => {
                                    Some(TerminalSync::Push)
                                }
                                Command::Publish if self.uncertain.is_none() => {
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
        let (ask, expire) = (prompt_tx.clone(), prompt_tx.clone());
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
    struct EditorCleanup(Option<Arc<EditorRegistry>>);
    impl Drop for EditorCleanup {
        fn drop(&mut self) {
            if let Some(editor) = &self.0 {
                editor.cancel_all();
                editor.cleanup();
            }
        }
    }
    let editor = EditorCleanup(if WRITES {
        let (listener, registry) = editor::bind()?;
        let (ask, expire) = (prompt_tx.clone(), prompt_tx);
        let server = registry.clone();
        std::thread::spawn(move || {
            editor::serve(
                listener,
                server,
                move |id, name, content| {
                    ask.try_send(PromptEvent::Edit(EditorMessage { id, name, content }))
                        .map_err(|_| ())
                },
                move |id| {
                    let _ = expire.try_send(PromptEvent::EditExpired(id));
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
    let worker_editor = editor.0.clone();
    let worker = std::thread::spawn(move || {
        if let Err(error) = worker(
            input,
            reply.clone(),
            worker_registry,
            worker_cancel,
            worker_editor,
        ) {
            let _ = reply.send(Err(error));
        }
    });
    let mut app = App::new(jobs);
    app.editor = editor.0.clone();
    app.config_path = settings::config_path();
    if let Some(file) = &app.config_path {
        match Settings::load(file) {
            Ok(config) => {
                app.keymap = Keymap::new(&config.keys).map_err(|e| invalid(&e))?;
                app.config = config;
            }
            Err(error) => {
                app.config_unreadable = true;
                app.config_error = Some(error.to_string());
            }
        }
    }
    app.theme = app.config.theme();
    app.view = View::Repositories;
    // Keep a failed startup open recoverable, with recent paths still available.
    app.repo_path = path;
    app.send(Job::Open(app.repo_path.clone()));
    let result = event_loop(
        &mut terminal,
        app,
        replies,
        prompt_rx,
        registry.0.as_deref(),
    );
    drop(_restore);
    drop(cancel);
    drop(registry);
    drop(editor);
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
    loop {
        loop {
            match replies.try_recv() {
                Ok(reply) => {
                    redraw = true;
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
                PromptEvent::Edit(message) => {
                    if app.quit || !app.writing || prompt.is_some() || app.editor_message.is_some()
                    {
                        if let Some(editor) = &app.editor {
                            let _ = editor.reply(message.id, None);
                        }
                    } else {
                        app.editor_back = app.view;
                        app.editor_message = Some(message);
                        app.help = false;
                        app.view = View::Message;
                    }
                }
                PromptEvent::EditExpired(id) => {
                    if app.editor_message.as_ref().is_some_and(|m| m.id == id) {
                        app.editor_message = None;
                        app.view = app.editor_back;
                        app.say(
                            Tone::Bad,
                            "Message editor expired; inspect the operation before continuing.",
                        );
                    }
                }
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
                            Command::Down
                        } else {
                            Command::Up
                        };
                        for _ in 0..3 {
                            app.command(key, height);
                        }
                    }
                    _ => continue,
                }
                redraw = true;
            }
        }
        if let Event::Paste(text) = &event {
            if prompt.is_none() && (!app.busy || app.view == View::Message) && !app.quit {
                app.paste(text);
                redraw = true;
            }
        }
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Release {
                continue;
            }
            redraw = true;
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let command = app.keymap.lookup(
                if prompt.is_some() {
                    keys::PROMPT
                } else {
                    1 << app.view as u32
                },
                key.code,
                ctrl,
            );
            if key.kind == KeyEventKind::Repeat
                && matches!(
                    command,
                    Some(
                        Command::Accept
                            | Command::SaveCommit
                            | Command::SaveMessage
                            | Command::Delete
                    )
                )
            {
                continue;
            }
            if let (Some(current), Some(registry)) = (&mut prompt, registry) {
                match command {
                    Some(Command::Accept | Command::Cancel) => {
                        let answer = (command == Some(Command::Accept))
                            .then(|| std::mem::take(&mut current.answer));
                        let _ = registry.reply(current.id, answer);
                        prompt = None;
                    }
                    Some(Command::Quit) => {
                        app.quit = true;
                        registry.cancel_all();
                        prompt = None;
                    }
                    Some(Command::Erase) => {
                        current.answer.pop();
                    }
                    _ => {
                        if let Key::Char(c) = key.code {
                            if !ctrl
                                && !c.is_control()
                                && current.answer.len() + c.len_utf8() <= 4096
                            {
                                current.answer.push(c);
                            }
                        }
                    }
                }
            } else if !app.quit {
                let height = usize::from(terminal.size()?.height.saturating_sub(4)).max(1);
                app.key(key.code, ctrl, height);
                if app.quit {
                    if let Some(registry) = registry {
                        registry.cancel_all();
                    }
                }
            }
            exit_after_write |= app.quit && app.writing;
            if app.quit {
                if let Some(editor) = &app.editor {
                    editor.cancel_all();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    #[ignore = "set GITTY_TUI_BENCH_REPO; run scripts/bench-tui.py"]
    fn terminal_benchmark() {
        let path = std::env::var("GITTY_TUI_BENCH_REPO").expect("set GITTY_TUI_BENCH_REPO");
        let (jobs, incoming) = mpsc::sync_channel(1);
        let (outgoing, replies) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            worker(
                incoming,
                outgoing,
                None,
                Arc::new(AtomicBool::new(false)),
                None,
            )
            .unwrap()
        });
        let mut app = App::new(jobs);
        let started = std::time::Instant::now();
        app.send(Job::Open(path.clone()));
        app.reply(replies.recv_timeout(Duration::from_secs(120)).unwrap());
        assert!(app.state.is_some(), "{}", app.notice);
        let open_ms = started.elapsed().as_secs_f64() * 1000.0;
        let paging = std::time::Instant::now();
        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        let mut pages = 1;
        let mut layout_ms = 0.0;
        let mut checkpoints = Vec::new();
        while app.cursor.is_some() || app.busy {
            if !app.busy {
                app.history = app.commits.len().saturating_sub(1);
                app.follow();
            }
            let reply = replies
                .recv_timeout(Duration::from_secs(120))
                .unwrap()
                .unwrap();
            let layout = std::time::Instant::now();
            app.reply(Ok(reply));
            app.history = app.commits.len().saturating_sub(1);
            terminal.draw(|frame| render(frame, &app, None)).unwrap();
            layout_ms += layout.elapsed().as_secs_f64() * 1000.0;
            pages += 1;
            if app.commits.len() % 50_000 < PAGE {
                checkpoints.push(serde_json::json!({
                    "commits": app.commits.len(), "elapsed_ms": paging.elapsed().as_secs_f64() * 1000.0,
                }));
            }
        }
        let paging_ms = paging.elapsed().as_secs_f64() * 1000.0;
        let rss = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find_map(|l| l.strip_prefix("VmHWM:"))
                    .and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok())
            });
        let result = serde_json::json!({
            "repo": path, "commits": app.commits.len(), "pages": pages,
            "open_ms": open_ms, "paging_ms": paging_ms, "layout_render_ms": layout_ms,
            "peak_rss_kib": rss, "checkpoints": checkpoints,
        });
        println!("{result}");
        if let Ok(out) = std::env::var("GITTY_TUI_BENCH_OUT") {
            std::fs::write(out, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        }
        drop(app);
        worker.join().unwrap();
    }

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
    fn terminal_switches_repositories_without_leaking_reviews_or_assignments() {
        use std::process::Command;
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first repo");
        let second = dir.path().join("second repo");
        for repo in [&first, &second] {
            assert!(Command::new("git")
                .args(["init", "-q", "-b", "main"])
                .arg(repo)
                .status()
                .unwrap()
                .success());
        }
        let (jobs, incoming) = mpsc::sync_channel(1);
        let (outgoing, replies) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            worker(
                incoming,
                outgoing,
                None,
                Arc::new(AtomicBool::new(false)),
                None,
            )
            .unwrap()
        });
        let mut app = App::new(jobs);
        let config = dir.path().join("settings.json");
        app.config_path = Some(config.clone());
        let receive =
            |app: &mut App| app.reply(replies.recv_timeout(Duration::from_secs(10)).unwrap());
        let key = |app: &mut App, code| app.key(code, false, 10);
        for (path, label) in [(&first, "Work"), (&second, "Personal")] {
            key(&mut app, Key::Char('o'));
            app.paste(&path.to_string_lossy());
            key(&mut app, Key::Enter);
            receive(&mut app);
            assert!(app.view == View::History);
            assert!(app.selected_profile().is_none());
            assert!(app.message.is_empty());
            key(&mut app, Key::Char(','));
            key(&mut app, Key::Tab);
            key(&mut app, Key::Char('n'));
            for field in [label, "Example Author", "author@example.invalid"] {
                app.paste(field);
                key(&mut app, Key::Tab);
            }
            key(&mut app, Key::Enter);
            assert!(app.view == View::Profiles);
            key(&mut app, Key::Enter);
            assert_eq!(app.selected_profile().unwrap().label, label);
            key(&mut app, Key::Esc);
            key(&mut app, Key::Esc);
            app.message = format!("draft for {label}");
            app.diff_key = Some(label.into());
        }
        let second_root = app.root().unwrap().to_owned();
        key(&mut app, Key::Char('o'));
        app.paste(&dir.path().join("not-a-repo").to_string_lossy());
        key(&mut app, Key::Enter);
        receive(&mut app);
        assert!(app.view == View::Repositories);
        assert_eq!(app.root(), Some(second_root.as_str()));
        assert_eq!(app.diff_key.as_deref(), Some("Personal"));
        key(&mut app, Key::Esc);
        key(&mut app, Key::Char('r'));
        receive(&mut app);
        assert_eq!(app.root(), Some(second_root.as_str()));

        key(&mut app, Key::Char('o'));
        for _ in 0..2 {
            key(&mut app, Key::Down);
        }
        key(&mut app, Key::Enter);
        receive(&mut app);
        let first_root = app.root().unwrap().to_owned();
        assert_ne!(first_root, second_root);
        assert_eq!(app.selected_profile().unwrap().label, "Work");
        assert_eq!(app.message, "draft for Work");
        assert!(app.diff_key.is_none());
        let persisted = Settings::load(&config).unwrap();
        assert_eq!(persisted.profile(&first_root).unwrap().label, "Work");
        assert_eq!(persisted.profile(&second_root).unwrap().label, "Personal");
        key(&mut app, Key::Char(','));
        key(&mut app, Key::Tab);
        key(&mut app, Key::Delete);
        assert!(app.selected_profile().is_none());
        assert_eq!(app.config.profile(&second_root).unwrap().label, "Personal");
        drop(app);
        worker.join().unwrap();
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
                incoming,
                outgoing,
                None,
                Arc::new(AtomicBool::new(false)),
                None,
            )
            .unwrap()
        });
        let mut app = App::new(jobs);
        app.send(Job::Open(path));
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

    #[cfg(unix)]
    struct WriteFixture {
        root: tempfile::TempDir,
        app: App,
        replies: mpsc::Receiver<Result<Reply>>,
        worker: std::thread::JoinHandle<()>,
    }

    #[cfg(unix)]
    impl WriteFixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let (jobs, incoming) = mpsc::sync_channel(1);
            let (outgoing, replies) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                worker(
                    incoming,
                    outgoing,
                    None,
                    Arc::new(AtomicBool::new(false)),
                    None,
                )
                .unwrap()
            });
            let mut f = Self {
                root,
                app: App::new(jobs),
                replies,
                worker,
            };
            f.git(&["init", "-q", "-b", "main"]);
            f.git(&["config", "user.name", "TUI Test"]);
            f.git(&["config", "user.email", "tui@example.invalid"]);
            f.git(&["config", "commit.gpgsign", "false"]);
            f.git(&["config", "core.hooksPath", ".git/hooks"]);
            f.git(&["config", "core.autocrlf", "false"]);
            f.write("file", &Self::base());
            f.git(&["add", "file"]);
            f.git(&["commit", "-qm", "base"]);
            f.app
                .send(Job::Open(f.root.path().to_string_lossy().into_owned()));
            f.settle();
            f
        }

        fn base() -> String {
            (0..60).map(|i| format!("line {i:02}\n")).collect()
        }

        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(self.root.path())
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        }

        fn write(&self, path: &str, text: &str) {
            std::fs::write(self.root.path().join(path), text).unwrap();
        }

        fn settle(&mut self) {
            while self.app.busy {
                self.app
                    .reply(self.replies.recv_timeout(Duration::from_secs(10)).unwrap());
            }
        }

        fn key(&mut self, key: Key) {
            self.app.key(key, false, 18);
            self.settle();
        }

        fn screen(&mut self, expected: &str) {
            for width in [80, 120] {
                let mut terminal = Terminal::new(TestBackend::new(width, 24)).unwrap();
                self.app.wide = width >= WIDE;
                terminal
                    .draw(|frame| render(frame, &self.app, None))
                    .unwrap();
                let text: String = terminal
                    .backend()
                    .buffer()
                    .content
                    .iter()
                    .map(|c| c.symbol())
                    .collect();
                assert!(text.contains(expected), "{text}");
            }
            self.app.wide = false;
        }

        fn finish(self) {
            drop(self.app);
            self.worker.join().unwrap();
        }
    }

    #[test]
    #[cfg(unix)]
    fn terminal_hunks_and_lines_use_reviewed_indices_and_refuse_stale_content() {
        let mut f = WriteFixture::new();
        let base = WriteFixture::base();
        let changed = base
            .replace("line 02\n", "first edit\n")
            .replace("line 45\n", "second edit\n");
        f.write("file", &changed);
        f.key(Key::Char('w'));
        f.key(Key::Enter);
        f.screen("hunk 1/2");
        f.key(Key::Char('n'));
        assert_eq!(
            diff_position(f.app.diff.as_ref().unwrap(), f.app.scroll)
                .unwrap()
                .0,
            1
        );
        f.key(Key::Char('N'));
        f.key(Key::Char('v'));
        f.key(Key::Down);
        f.key(Key::Char('s'));
        assert!(
            matches!(&f.app.confirm, Some(Confirm::Hunk(r)) if r.index == 0 && r.lines.as_ref().unwrap().len() == 2)
        );
        f.screen("Stage 2 selected lines in hunk 1");
        f.write("file", &(changed.clone() + "external\n"));
        f.key(Key::Enter);
        assert!(
            f.app.notice.contains("diff or index changed"),
            "{}",
            f.app.notice
        );
        assert_eq!(f.git(&["diff", "--cached"]), "");
        assert!(f.app.view == View::Working);
        f.write("file", &changed);
        f.key(Key::Enter);
        f.key(Key::Char('v'));
        f.key(Key::Down);
        f.key(Key::Char('s'));
        f.key(Key::Enter);
        assert_eq!(
            f.git(&["show", ":file"]),
            base.replace("line 02\n", "first edit\n")
        );
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file")).unwrap(),
            changed
        );
        f.key(Key::Tab);
        f.key(Key::Enter);
        f.key(Key::Char('v'));
        f.key(Key::Down);
        f.key(Key::Char('s'));
        f.screen("Unstage 2 selected lines");
        f.key(Key::Enter);
        assert_eq!(f.git(&["show", ":file"]), base);
        f.key(Key::Tab);
        f.key(Key::Enter);
        f.key(Key::Char('n'));
        f.key(Key::Char('s'));
        f.key(Key::Enter);
        assert_eq!(
            f.git(&["show", ":file"]),
            base.replace("line 45\n", "second edit\n")
        );
        f.finish();
    }

    #[test]
    #[cfg(unix)]
    fn terminal_stage_all_validates_every_file_before_writing() {
        let mut f = WriteFixture::new();
        f.write("file", "changed\n");
        f.write("new", "new\n");
        f.key(Key::Char('w'));
        f.key(Key::Char('S'));
        f.screen("Stage all · 2 reviewed files");
        assert_eq!(f.git(&["diff", "--cached"]), "");
        f.write("new", "changed after review\n");
        f.key(Key::Enter);
        assert!(f.app.notice.contains("Repository changed"));
        assert_eq!(f.git(&["diff", "--cached"]), "");
        f.key(Key::Char('S'));
        f.key(Key::Enter);
        assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "file\nnew\n");
        f.key(Key::Tab);
        f.key(Key::Char('S'));
        f.screen("Unstage all · 2 reviewed files");
        f.key(Key::Enter);
        assert_eq!(f.git(&["diff", "--cached"]), "");
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("new")).unwrap(),
            "changed after review\n"
        );
        f.finish();
    }

    #[test]
    #[cfg(unix)]
    fn terminal_discard_reviews_exact_loss_and_requires_untracked_confirmation() {
        let mut f = WriteFixture::new();
        let staged = WriteFixture::base().replace("line 25\n", "staged\n");
        f.write("file", &staged);
        f.git(&["add", "file"]);
        let changed = staged
            .replace("line 02\n", "first\n")
            .replace("line 45\n", "second\n");
        f.write("file", &changed);
        f.key(Key::Char('w'));
        f.key(Key::Enter);
        f.key(Key::Char('n'));
        f.key(Key::Char('d'));
        f.screen("Discard hunk 2");
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file")).unwrap(),
            changed
        );
        f.key(Key::Enter);
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file")).unwrap(),
            staged.replace("line 02\n", "first\n")
        );
        assert_eq!(f.git(&["show", ":file"]), staged);
        f.key(Key::Char('d'));
        f.screen("Discard file");
        f.write("file", "external edit\n");
        f.key(Key::Enter);
        assert!(f.app.notice.contains("working tree changed"));
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file")).unwrap(),
            "external edit\n"
        );
        f.key(Key::Char('d'));
        f.key(Key::Enter);
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file")).unwrap(),
            staged
        );
        f.write("untracked", "delete only after D\n");
        f.key(Key::Char('w'));
        f.key(Key::Char('d'));
        f.screen("D allow deletion");
        f.key(Key::Enter);
        assert!(f.app.view == View::Confirm);
        assert!(f.root.path().join("untracked").exists());
        f.key(Key::Char('D'));
        f.key(Key::Enter);
        assert!(!f.root.path().join("untracked").exists());
        f.finish();
    }

    #[test]
    #[cfg(unix)]
    fn terminal_amend_keeps_draft_and_rechecks_head_index_and_eligibility() {
        let mut f = WriteFixture::new();
        let before = f.git(&["rev-parse", "HEAD"]);
        f.app.message = "amended draft".into();
        f.key(Key::Char('c'));
        assert!(f.app.review.as_ref().unwrap().can_amend());
        f.key(Key::F(3));
        f.screen("Amend ");
        f.key(Key::F(3));
        assert_eq!(f.app.message, "amended draft");
        f.key(Key::F(3));
        f.write("file", "external index edit\n");
        f.git(&["add", "file"]);
        f.key(Key::F(2));
        assert!(f.app.notice.contains("Repository changed"));
        assert_eq!(f.app.message, "amended draft");
        assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
        f.key(Key::Char('c'));
        f.key(Key::F(3));
        f.git(&["update-ref", "refs/remotes/origin/main", before.trim()]);
        f.key(Key::F(2));
        assert!(f.app.notice.contains("Repository changed"));
        assert_eq!(f.app.message, "amended draft");
        f.key(Key::Char('c'));
        assert!(!f.app.review.as_ref().unwrap().can_amend());
        f.key(Key::F(3));
        assert!(!f.app.amend);
        f.key(Key::Esc);
        f.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
        f.key(Key::Char('c'));
        f.key(Key::F(3));
        let old_tree = f.git(&["rev-parse", "HEAD^{tree}"]);
        let moved = f.git(&["commit-tree", old_tree.trim(), "-m", "external HEAD"]);
        f.git(&["update-ref", "refs/heads/main", moved.trim()]);
        f.key(Key::F(2));
        assert!(f.app.notice.contains("Repository changed"));
        assert_eq!(f.app.message, "amended draft");
        assert_eq!(f.git(&["rev-parse", "HEAD"]), moved);
        f.key(Key::Char('c'));
        f.key(Key::F(3));
        f.key(Key::F(2));
        assert!(f.app.notice.starts_with("Amended"), "{}", f.app.notice);
        assert!(f.app.message.is_empty());
        assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "1\n");
        assert_eq!(f.git(&["log", "-1", "--format=%s"]), "amended draft\n");
        assert_eq!(f.git(&["show", "HEAD:file"]), "external index edit\n");
        // A completed merge has no amend toggle either.
        let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
        let side = f.git(&["commit-tree", tree.trim(), "-m", "side"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        let merge = f.git(&[
            "commit-tree",
            tree.trim(),
            "-p",
            head.trim(),
            "-p",
            side.trim(),
            "-m",
            "merge",
        ]);
        f.git(&["update-ref", "refs/heads/main", merge.trim()]);
        f.key(Key::Char('c'));
        assert!(!f.app.review.as_ref().unwrap().can_amend());
        f.finish();
    }

    #[test]
    #[cfg(unix)]
    fn terminal_branch_reviews_create_checkout_rename_delete_and_refuse_stale_state() {
        let mut f = WriteFixture::new();
        f.key(Key::Char('C'));
        f.app.paste("topic");
        f.key(Key::Enter);
        f.screen("Create branch");
        f.key(Key::Enter);
        assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main\n");
        assert_eq!(
            f.git(&["rev-parse", "topic"]),
            f.git(&["rev-parse", "HEAD"])
        );
        f.key(Key::Char('B'));
        f.screen("ahead/behind HEAD");
        f.key(Key::Down);
        f.key(Key::Enter);
        f.screen("Checkout branch");
        f.write("file", "stale checkout\n");
        f.key(Key::Enter);
        assert!(f.app.notice.contains("Repository changed"));
        assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main\n");
        f.git(&["restore", "--worktree", "file"]);
        f.key(Key::Enter);
        f.key(Key::Enter);
        assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic\n");
        f.key(Key::Char('e'));
        f.app.paste("renamed");
        f.key(Key::Enter);
        f.screen("Rename branch");
        f.write("file", "stale rename\n");
        f.key(Key::Enter);
        assert!(f.app.notice.contains("Repository changed"));
        assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic\n");
        f.git(&["restore", "--worktree", "file"]);
        f.key(Key::Char('e'));
        f.app.paste("renamed");
        f.key(Key::Enter);
        f.key(Key::Enter);
        assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/renamed\n");
        f.key(Key::Home);
        f.key(Key::Enter);
        f.key(Key::Enter);
        assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main\n");
        f.key(Key::Down);
        f.key(Key::Char('d'));
        f.screen("Delete branch");
        let head = f.git(&["rev-parse", "HEAD"]);
        let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
        let moved = f.git(&["commit-tree", tree.trim(), "-m", "external"]);
        f.git(&["update-ref", "refs/heads/renamed", moved.trim()]);
        f.key(Key::Enter);
        assert!(f.app.notice.contains("changed"), "{}", f.app.notice);
        assert_eq!(f.git(&["rev-parse", "renamed"]), moved);
        f.git(&["update-ref", "refs/heads/renamed", head.trim()]);
        f.key(Key::Char('d'));
        f.key(Key::Enter);
        assert_eq!(f.git(&["branch", "--list", "renamed"]), "");
        f.finish();
    }

    #[test]
    #[cfg(unix)]
    fn terminal_stashes_inspect_untracked_apply_index_drop_and_pop() {
        let mut f = WriteFixture::new();
        f.write("file", "stash staged\n");
        f.git(&["add", "file"]);
        f.write("untracked", "stash untracked\n");
        f.git(&["stash", "push", "-u", "-m", "review stash"]);
        let oid = f.git(&["rev-parse", "refs/stash"]);
        f.key(Key::Char('r'));
        f.app.history = f
            .app
            .commits
            .iter()
            .position(|c| c.id == oid.trim())
            .unwrap();
        f.key(Key::Enter);
        assert!(f.app.view == View::Stashes);
        f.screen("review stash");
        f.key(Key::Enter);
        f.screen("Stash tracked files");
        f.key(Key::Char('u'));
        f.screen("Stash untracked files");
        f.key(Key::Enter);
        f.screen("stash untracked");
        f.key(Key::Esc);
        f.key(Key::Esc);
        f.key(Key::Char('a'));
        f.screen("Stash apply");
        f.key(Key::Char('i'));
        f.screen("Restore index: yes");
        f.key(Key::Enter);
        assert_eq!(f.git(&["show", ":file"]), "stash staged\n");
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("untracked")).unwrap(),
            "stash untracked\n"
        );
        assert_eq!(f.git(&["rev-parse", "refs/stash"]), oid);
        f.key(Key::Char('d'));
        f.screen("Stash drop");
        f.key(Key::Enter);
        assert_eq!(f.git(&["stash", "list"]), "");
        assert!(f.root.path().join("untracked").exists());
        f.git(&["stash", "push", "-u", "-m", "pop me"]);
        f.key(Key::Char('t'));
        f.key(Key::Char('P'));
        f.key(Key::Enter);
        assert_eq!(f.git(&["stash", "list"]), "");
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("file")).unwrap(),
            "stash staged\n"
        );
        f.finish();
    }

    #[test]
    #[cfg(unix)]
    fn terminal_search_reveals_old_matches_and_ignores_cancelled_replies() {
        let mut f = WriteFixture::new();
        let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
        let mut head = f.git(&["rev-parse", "HEAD"]);
        let mut old = String::new();
        for i in 0..PAGE + 5 {
            head = f.git(&[
                "commit-tree",
                tree.trim(),
                "-p",
                head.trim(),
                "-m",
                if i == 0 || i == PAGE + 4 {
                    "needle"
                } else {
                    "filler"
                },
            ]);
            if i == 0 {
                old = head.trim().to_owned();
            }
        }
        f.git(&["update-ref", "refs/heads/main", head.trim()]);
        f.key(Key::Char('r'));
        assert_eq!(f.app.commits.len(), PAGE);
        f.key(Key::Char('/'));
        f.app.paste("needle");
        f.screen("Search history");
        f.key(Key::Enter);
        assert_eq!(f.app.matches.len(), 2);
        assert_eq!(f.app.commits[f.app.history].id, head.trim());
        f.key(Key::Char('n'));
        assert_eq!(f.app.commits[f.app.history].id, old);
        assert!(f.app.commits.len() > PAGE);
        f.key(Key::Char('N'));
        assert_eq!(f.app.commits[f.app.history].id, head.trim());
        f.key(Key::Char('/'));
        f.app.search_text = "base".into();
        f.app.key(Key::Enter, false, 18);
        let old_id = f.app.search_id;
        f.app.key(Key::Esc, false, 18);
        f.settle();
        assert!(f.app.search_cancel.is_none());
        assert!(f.app.matches.is_empty());
        assert_ne!(f.app.search_id, old_id);
        assert_eq!(f.app.notice, "Search cancelled.");
        f.finish();
    }

    #[test]
    fn terminal_branch_refresh_preserves_typing_and_queues_the_review() {
        let (jobs, rx) = mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        app.view = View::Branches;
        app.busy = true;
        app.branch_name("refs/heads/main".into(), true);
        app.paste("renamed");
        app.key(Key::Enter, false, 18);
        assert!(rx.try_recv().is_err());
        app.reply(Ok(Reply::Branches(vec![], false)));
        assert!(app.view == View::BranchName);
        assert_eq!(app.branch_editor.as_ref().unwrap().name, "renamed");
        assert!(matches!(rx.try_recv().unwrap(),
            Job::OperationReview(GitAction::RenameBranch { name, .. }) if name == "renamed"));
    }

    #[test]
    #[cfg(unix)]
    fn terminal_remapped_stage_and_help_still_require_review() {
        let mut f = WriteFixture::new();
        f.app.keymap =
            Keymap::new(&keys::KeyConfig::Map([("stage".into(), "x".into())].into())).unwrap();
        f.write("file", "review me\n");
        f.key(Key::Char('w'));
        f.key(Key::Char('?'));
        f.screen("Keys for this view");
        f.screen("[stage]");
        f.key(Key::Char('x'));
        assert!(f.app.help);
        assert_eq!(f.git(&["diff", "--cached"]), "");
        f.key(Key::Esc);
        f.key(Key::Char('s'));
        assert!(f.app.view == View::Working);
        f.key(Key::Char('x'));
        assert!(f.app.view == View::Confirm);
        assert_eq!(f.git(&["diff", "--cached"]), "");
        f.key(Key::Char('x'));
        assert!(f.app.view == View::Confirm);
        f.key(Key::Enter);
        assert_eq!(f.git(&["show", ":file"]), "review me\n");
        f.finish();
    }

    #[test]
    fn terminal_invalid_key_settings_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tui.json");
        let original = r#"{"keys":{"stage":"Enter"},"theme":"keep-me"}"#;
        std::fs::write(&path, original).unwrap();
        let error = Settings::load(&path).err().unwrap();
        let (jobs, _) = mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        app.config_path = Some(path.clone());
        app.config_unreadable = true;
        app.config_error = Some(error.to_string());
        app.save_config("Changed theme.");
        assert!(app.notice.contains("In memory only"));
        assert!(app.config_error.unwrap().contains("Conflicting keys"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    #[cfg(unix)]
    fn terminal_graph_operations_review_and_reconcile() {
        let mut f = WriteFixture::new();
        f.git(&["switch", "-c", "side"]);
        f.write("side", "picked\n");
        f.git(&["add", "side"]);
        f.git(&["commit", "-qm", "side"]);
        let side = f.git(&["rev-parse", "HEAD"]);
        f.git(&["switch", "main"]);
        f.key(Key::Char('r'));
        f.app.history = f
            .app
            .commits
            .iter()
            .position(|c| c.id == side.trim())
            .unwrap();
        f.key(Key::Char('y'));
        f.screen("Cherry-pick");
        f.key(Key::Enter);
        assert_eq!(f.git(&["show", "HEAD:side"]), "picked\n");
        f.key(Key::Char('T'));
        f.app.paste("v-test");
        f.key(Key::Enter);
        f.screen("Create tag");
        f.key(Key::Enter);
        assert_eq!(f.git(&["rev-parse", "v-test"]), side);
        f.git(&["switch", "side"]);
        f.write("upstream", "upstream\n");
        f.git(&["add", "upstream"]);
        f.git(&["commit", "-qm", "upstream"]);
        let upstream = f.git(&["rev-parse", "HEAD"]);
        f.git(&["switch", "main"]);
        f.write("local", "local\n");
        f.git(&["add", "local"]);
        f.git(&["commit", "-qm", "local"]);
        f.key(Key::Char('B'));
        f.app.branch = f
            .app
            .branches
            .iter()
            .position(|b| b.reference.name == "side")
            .unwrap();
        f.key(Key::Char('M'));
        f.screen("Stash local work: no");
        f.write("file", "external\n");
        let before = f.git(&["rev-parse", "HEAD"]);
        f.key(Key::Enter);
        assert!(f.app.notice.contains("Repository changed"));
        assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
        f.git(&["restore", "file"]);
        f.key(Key::Char('R'));
        f.screen("Rebase");
        f.key(Key::Enter);
        assert!(
            f.app.notice.contains("Rebase completed"),
            "{}",
            f.app.notice
        );
        f.git(&["merge-base", "--is-ancestor", upstream.trim(), "HEAD"]);
        assert_eq!(f.git(&["show", "HEAD:local"]), "local\n");
        f.finish();
    }

    #[test]
    #[cfg(unix)]
    fn terminal_rebase_plan_edits_order_and_refuses_stale_review() {
        let mut f = WriteFixture::new();
        let base = f.git(&["rev-parse", "HEAD"]);
        for name in ["one", "two", "three"] {
            f.write(name, name);
            f.git(&["add", name]);
            f.git(&["commit", "-qm", name]);
        }
        let head = f.git(&["rev-parse", "HEAD"]);
        f.key(Key::Char('r'));
        f.app.history = f
            .app
            .commits
            .iter()
            .position(|c| c.id == base.trim())
            .unwrap();
        f.key(Key::Char('I'));
        f.screen("Interactive rebase");
        f.key(Key::Char(' '));
        f.key(Key::Down);
        f.key(Key::Char(' '));
        f.key(Key::Char(' '));
        f.key(Key::Char('K'));
        if let Some(OperationRequest {
            action: GitAction::InteractiveRebase { steps, .. },
            ..
        }) = &f.app.plan
        {
            assert_eq!(steps[0].instruction, RebaseInstruction::Reword);
            assert_eq!(steps[1].instruction, RebaseInstruction::Drop);
        } else {
            panic!("missing plan");
        }
        f.key(Key::Char('J'));
        f.key(Key::Enter);
        f.screen("Review interactive rebase");
        f.write("file", "changed after review\n");
        f.key(Key::Enter);
        assert!(
            f.app.notice.contains("Repository changed"),
            "{}",
            f.app.notice
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        f.finish();
    }

    #[test]
    fn terminal_message_editor_accepts_input_during_a_write_and_cancels_without_quitting() {
        let (jobs, _) = mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        app.view = View::Message;
        app.writing = true;
        app.busy = true;
        app.editor_message = Some(EditorMessage {
            id: 1,
            name: "COMMIT_EDITMSG".into(),
            content: "old".into(),
        });
        app.key(Key::Char('u'), true, 18);
        app.paste("new\nmessage");
        assert_eq!(app.editor_message.as_ref().unwrap().content, "new\nmessage");
        app.key(Key::F(1), false, 18);
        assert!(app.help);
        app.key(Key::Esc, false, 18);
        assert!(!app.help);
        app.key(Key::Esc, false, 18);
        assert!(app.view == View::History);
        assert!(!app.quit);
        assert!(app.writing);
    }

    #[test]
    #[cfg(unix)]
    fn terminal_conflict_sides_refuse_stale_content_then_continue_merge() {
        for (key, expected) in [('1', "ours\n"), ('2', "theirs\n")] {
            let mut f = WriteFixture::new();
            f.git(&["switch", "-c", "side"]);
            f.write("file", "theirs\n");
            f.git(&["commit", "-qam", "side"]);
            f.git(&["switch", "main"]);
            f.write("file", "ours\n");
            f.git(&["commit", "-qam", "main"]);
            f.key(Key::Char('B'));
            f.app.branch = f
                .app
                .branches
                .iter()
                .position(|b| b.reference.name == "side")
                .unwrap();
            f.key(Key::Char('M'));
            f.key(Key::Enter);
            assert_eq!(f.app.operation.as_ref().unwrap().kind, OperationKind::Merge);
            f.key(Key::Char('X'));
            f.key(Key::Enter);
            f.screen("Both sides");
            f.key(Key::Tab);
            assert_eq!(f.app.conflict_side, 1);
            f.key(Key::Char(key));
            f.screen("Resolve conflict");
            f.write("file", "external resolution\n");
            f.key(Key::Enter);
            assert!(f.app.notice.contains("changed"), "{}", f.app.notice);
            assert_eq!(
                std::fs::read_to_string(f.root.path().join("file")).unwrap(),
                "external resolution\n"
            );
            assert!(!f.git(&["ls-files", "--unmerged"]).is_empty());
            f.key(Key::Enter);
            f.key(Key::Char(key));
            f.key(Key::Enter);
            assert_eq!(f.git(&["show", ":file"]), expected);
            assert!(f.git(&["ls-files", "--unmerged"]).is_empty());
            assert_eq!(f.app.operation.as_ref().unwrap().kind, OperationKind::Merge);
            f.key(Key::F(5));
            f.screen("Continue operation");
            f.key(Key::Enter);
            assert_eq!(f.app.operation.as_ref().unwrap().kind, OperationKind::None);
            assert_eq!(
                f.git(&["rev-list", "--parents", "-1", "HEAD"])
                    .split_whitespace()
                    .count(),
                3
            );
            f.finish();
        }
    }

    #[test]
    #[cfg(unix)]
    fn terminal_blame_uses_selected_revision_and_jumps_to_attributed_commit() {
        let mut f = WriteFixture::new();
        let base = f.git(&["rev-parse", "HEAD"]);
        let changed = WriteFixture::base().replace("line 10\n", "edited line\n");
        f.write("file", &changed);
        f.git(&["commit", "-qam", "edit line"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        f.key(Key::Char('r'));
        f.key(Key::Home);
        f.key(Key::Enter);
        f.key(Key::Char('b'));
        f.screen("Blame");
        assert_eq!(
            f.app.blame.as_ref().unwrap().revision.as_deref(),
            Some(head.trim())
        );
        assert_eq!(
            f.app.blame.as_ref().unwrap().lines[10].oid.as_deref(),
            Some(head.trim())
        );
        f.app.blame_row = 0;
        f.key(Key::Enter);
        assert!(f.app.view == View::History);
        assert_eq!(f.app.commits[f.app.history].id, base.trim());
        f.key(Key::Enter);
        f.write("file", &(changed.clone() + "uncommitted\n"));
        f.key(Key::Char('b'));
        assert_eq!(f.app.blame.as_ref().unwrap().lines[10].content, "line 10");
        f.key(Key::Char('w'));
        f.key(Key::Char('b'));
        f.key(Key::End);
        assert!(f
            .app
            .blame
            .as_ref()
            .unwrap()
            .lines
            .last()
            .unwrap()
            .oid
            .is_none());
        f.key(Key::Enter);
        assert!(f.app.view == View::Blame);
        assert!(f.app.notice.contains("uncommitted"));
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        f.finish();
    }
}
