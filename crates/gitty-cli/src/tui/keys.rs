use super::{App, Confirm, Key, StashVerb, View, WRITES};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Command {
    Quit,
    Cancel,
    Help,
    Up,
    Down,
    PageUp,
    PageDown,
    Home,
    End,
    Left,
    Right,
    Accept,
    Next,
    Previous,
    Erase,
    Clear,
    History,
    Working,
    Remote,
    Settings,
    Repositories,
    Branches,
    Stashes,
    Commit,
    Fetch,
    Pull,
    Push,
    Stash,
    Pop,
    Search,
    NextMatch,
    PreviousMatch,
    CreateHere,
    New,
    Edit,
    Delete,
    ApplyStash,
    PopStash,
    StashFiles,
    Stage,
    StageAll,
    Discard,
    NextHunk,
    PreviousHunk,
    SelectLines,
    SaveCommit,
    Amend,
    Publish,
    Verify,
    IncludeUntracked,
    AllowDelete,
    RestoreIndex,
    MessageUp,
    MessageDown,
    Refresh,
    Merge,
    Rebase,
    CherryPick,
    Tag,
    Continue,
    Skip,
    Abort,
    MergeStash,
    InteractiveRebase,
    PlanInstruction,
    PlanUp,
    PlanDown,
    SaveMessage,
    Conflicts,
    Ours,
    Theirs,
    Blame,
    Text(char),
}

const fn v(view: View) -> u32 {
    1 << view as u32
}
pub(super) const PROMPT: u32 = v(View::Message) << 1;
pub(super) const HELP: u32 = PROMPT << 1;
const ALL: u32 = (HELP << 1) - 1;
const INPUT: u32 = v(View::Repositories)
    | v(View::Composer)
    | v(View::Publish)
    | v(View::ProfileEdit)
    | v(View::BranchName)
    | v(View::Search)
    | v(View::Message);
const BROWSE: u32 =
    ALL & !(INPUT | v(View::Profiles) | v(View::RebasePlan) | v(View::Confirm) | PROMPT | HELP);
const NAV: u32 = BROWSE | v(View::Profiles) | v(View::RebasePlan) | v(View::Confirm) | HELP;
const PAN: u32 = v(View::Files) | v(View::Working) | v(View::Diff) | v(View::Confirm);

pub(super) struct Binding {
    pub name: &'static str,
    defaults: &'static str,
    scope: u32,
    pub command: Command,
    pub label: &'static str,
}

macro_rules! binding {
    ($name:literal, $keys:literal, $scope:expr, $command:ident, $label:literal) => {
        Binding {
            name: $name,
            defaults: $keys,
            scope: $scope,
            command: Command::$command,
            label: $label,
        }
    };
}

pub(super) static TABLE: &[Binding] = &[
    binding!("help", "?", NAV, Help, "help"),
    binding!("help_input", "F1", INPUT, Help, "help"),
    binding!(
        "open",
        "Enter",
        v(View::History)
            | v(View::Files)
            | v(View::Working)
            | v(View::Repositories)
            | v(View::Stashes),
        Accept,
        "open"
    ),
    binding!("checkout", "Enter", v(View::Branches), Accept, "checkout"),
    binding!(
        "blame_commit",
        "Enter",
        v(View::Blame),
        Accept,
        "jump to commit"
    ),
    binding!(
        "open_conflict",
        "Enter",
        v(View::Conflicts),
        Accept,
        "inspect"
    ),
    binding!(
        "conflict_view",
        "Tab",
        v(View::Conflict),
        Next,
        "both/ours/theirs"
    ),
    binding!("conflict_ours", "1", v(View::Conflict), Ours, "take ours"),
    binding!(
        "conflict_theirs",
        "2",
        v(View::Conflict),
        Theirs,
        "take theirs"
    ),
    binding!("confirm", "Enter", v(View::Confirm), Accept, "confirm"),
    binding!(
        "review",
        "Enter",
        v(View::BranchName) | v(View::Publish),
        Accept,
        "review"
    ),
    binding!("submit_search", "Enter", v(View::Search), Accept, "search"),
    binding!(
        "apply_setting",
        "Enter",
        v(View::Settings) | v(View::Profiles),
        Accept,
        "apply"
    ),
    binding!(
        "save_profile",
        "Enter",
        v(View::ProfileEdit),
        Accept,
        "save"
    ),
    binding!(
        "newline",
        "Enter",
        v(View::Composer) | v(View::Message),
        Accept,
        "new line"
    ),
    binding!(
        "save_message",
        "F2",
        v(View::Message),
        SaveMessage,
        "save message"
    ),
    binding!(
        "plan_review",
        "Enter",
        v(View::RebasePlan),
        Accept,
        "review plan"
    ),
    binding!(
        "plan_instruction",
        "Space",
        v(View::RebasePlan),
        PlanInstruction,
        "cycle instruction"
    ),
    binding!("plan_up", "K", v(View::RebasePlan), PlanUp, "move earlier"),
    binding!(
        "plan_down",
        "J",
        v(View::RebasePlan),
        PlanDown,
        "move later"
    ),
    binding!(
        "stage",
        "s",
        v(View::Working) | v(View::Diff),
        Stage,
        "stage"
    ),
    binding!("stage_all", "S", v(View::Working), StageAll, "all"),
    binding!(
        "discard",
        "d",
        v(View::Working) | v(View::Diff),
        Discard,
        "discard"
    ),
    binding!("next_hunk", "n", v(View::Diff), NextHunk, "next hunk"),
    binding!(
        "previous_hunk",
        "N",
        v(View::Diff),
        PreviousHunk,
        "previous hunk"
    ),
    binding!("select_lines", "v", v(View::Diff), SelectLines, "lines"),
    binding!("next_match", "n", v(View::History), NextMatch, "next match"),
    binding!(
        "previous_match",
        "N",
        v(View::History),
        PreviousMatch,
        "previous match"
    ),
    binding!("search", "/", v(View::History), Search, "search"),
    binding!(
        "create_here",
        "C",
        v(View::History),
        CreateHere,
        "branch here"
    ),
    binding!(
        "new",
        "n",
        v(View::Branches) | v(View::Profiles),
        New,
        "create"
    ),
    binding!(
        "edit",
        "e",
        v(View::Branches) | v(View::Profiles),
        Edit,
        "rename/edit"
    ),
    binding!(
        "delete_branch_stash",
        "d",
        v(View::Branches) | v(View::Stashes),
        Delete,
        "delete/drop"
    ),
    binding!(
        "delete_profile",
        "Delete",
        v(View::Profiles),
        Delete,
        "delete"
    ),
    binding!("apply_stash", "a", v(View::Stashes), ApplyStash, "apply"),
    binding!("pop_stash", "P", v(View::Stashes), PopStash, "pop"),
    binding!(
        "stash_files",
        "u",
        v(View::Files),
        StashFiles,
        "tracked/untracked"
    ),
    binding!("save_commit", "F2", v(View::Composer), SaveCommit, "commit"),
    binding!("amend", "F3", v(View::Composer), Amend, "toggle amend"),
    binding!("publish", "b", v(View::Remote), Publish, "publish"),
    binding!("verify", "v", v(View::Remote), Verify, "verify push"),
    binding!(
        "include_untracked",
        "u",
        v(View::Confirm),
        IncludeUntracked,
        "untracked"
    ),
    binding!(
        "allow_delete",
        "D",
        v(View::Confirm),
        AllowDelete,
        "allow deletion"
    ),
    binding!(
        "restore_index",
        "i",
        v(View::Confirm),
        RestoreIndex,
        "restore index"
    ),
    binding!(
        "switch_list",
        "Tab",
        v(View::Working),
        Next,
        "staged ⇄ unstaged"
    ),
    binding!("leave_diff", "Tab", v(View::Diff), Next, "back"),
    binding!(
        "profiles",
        "Tab",
        v(View::Settings) | v(View::Profiles),
        Next,
        "profiles/theme"
    ),
    binding!(
        "profiles_back",
        "BackTab",
        v(View::Settings) | v(View::Profiles),
        Previous,
        "profiles/theme"
    ),
    binding!(
        "next_field",
        "Tab Down",
        v(View::ProfileEdit),
        Next,
        "next field"
    ),
    binding!(
        "previous_field",
        "BackTab Up",
        v(View::ProfileEdit),
        Previous,
        "previous field"
    ),
    binding!(
        "message_up",
        "[",
        v(View::Files),
        MessageUp,
        "scroll message up"
    ),
    binding!(
        "message_down",
        "]",
        v(View::Files),
        MessageDown,
        "scroll message down"
    ),
    binding!("up", "Up k", NAV, Up, "up"),
    binding!("down", "Down j", NAV, Down, "down"),
    binding!("recent_up", "Up", v(View::Repositories), Up, "recent up"),
    binding!(
        "recent_down",
        "Down",
        v(View::Repositories),
        Down,
        "recent down"
    ),
    binding!(
        "page_up",
        "PageUp",
        (NAV & !v(View::Profiles)) | v(View::Composer),
        PageUp,
        "page up"
    ),
    binding!(
        "page_down",
        "PageDown",
        (NAV & !v(View::Profiles)) | v(View::Composer),
        PageDown,
        "page down"
    ),
    binding!("home", "Home g", BROWSE, Home, "top"),
    binding!("end", "End G", BROWSE, End, "end"),
    binding!("pan_left", "Left", PAN, Left, "pan left"),
    binding!("pan_right", "Right", PAN, Right, "pan right"),
    binding!("erase", "Backspace", INPUT, Erase, "erase"),
    binding!(
        "clear",
        "Ctrl-u",
        INPUT & !(v(View::Composer) | v(View::Publish)),
        Clear,
        "clear"
    ),
    binding!(
        "merge",
        "M",
        v(View::History) | v(View::Branches),
        Merge,
        "merge here"
    ),
    binding!(
        "rebase",
        "R",
        v(View::History) | v(View::Branches),
        Rebase,
        "rebase onto"
    ),
    binding!(
        "cherry_pick",
        "y",
        v(View::History) | v(View::Branches),
        CherryPick,
        "cherry-pick"
    ),
    binding!("tag", "T", v(View::History) | v(View::Branches), Tag, "tag"),
    binding!("continue", "F5", BROWSE, Continue, "continue"),
    binding!("skip", "F6", BROWSE, Skip, "skip"),
    binding!("abort", "F7", BROWSE, Abort, "abort"),
    binding!(
        "merge_stash",
        "a",
        v(View::Confirm),
        MergeStash,
        "stash local work"
    ),
    binding!("branches", "B", BROWSE, Branches, "branches"),
    binding!(
        "blame",
        "b",
        v(View::Files) | v(View::Working),
        Blame,
        "blame"
    ),
    binding!("conflicts", "X", BROWSE, Conflicts, "conflicts"),
    binding!(
        "interactive_rebase",
        "I",
        v(View::History) | v(View::Branches),
        InteractiveRebase,
        "edit rebase plan"
    ),
    binding!("stashes", "t", BROWSE, Stashes, "stashes"),
    binding!("repositories", "o", BROWSE, Repositories, "repos"),
    binding!("history", "h", BROWSE, History, "history"),
    binding!("refresh", "r", BROWSE, Refresh, "refresh"),
    binding!("working", "w", BROWSE, Working, "changes"),
    binding!("remote", "m", BROWSE, Remote, "sync"),
    binding!("settings", ",", BROWSE, Settings, "settings"),
    binding!("commit", "c", BROWSE, Commit, "commit"),
    binding!("fetch", "f", BROWSE, Fetch, "fetch"),
    binding!("pull", "l", BROWSE, Pull, "pull"),
    binding!("push", "p", BROWSE, Push, "push"),
    binding!("stash", "z", BROWSE, Stash, "stash"),
    binding!("pop", "Z", BROWSE, Pop, "pop latest"),
    binding!("quit", "q", NAV, Quit, "quit"),
    binding!("cancel", "Esc", ALL, Cancel, "back/cancel"),
    binding!("interrupt", "Ctrl-c", ALL, Quit, "quit"),
    binding!("prompt_send", "Enter", PROMPT, Accept, "send"),
    binding!("prompt_erase", "Backspace", PROMPT, Erase, "erase"),
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum KeyConfig {
    Preset(String),
    Map(BTreeMap<String, String>),
}

impl Default for KeyConfig {
    fn default() -> Self {
        Self::Map(BTreeMap::new())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Chord {
    key: Key,
    ctrl: bool,
}

impl Chord {
    fn parse(text: &str) -> Result<Self, String> {
        let (ctrl, text) = text
            .strip_prefix("Ctrl-")
            .map_or((false, text), |s| (true, s));
        let key = match text {
            "Enter" => Key::Enter,
            "Esc" => Key::Esc,
            "Tab" => Key::Tab,
            "BackTab" => Key::BackTab,
            "Backspace" => Key::Backspace,
            "Delete" => Key::Delete,
            "Up" => Key::Up,
            "Down" => Key::Down,
            "Left" => Key::Left,
            "Right" => Key::Right,
            "Home" => Key::Home,
            "End" => Key::End,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            "Space" => Key::Char(' '),
            s if s.starts_with('F') && s.len() > 1 => {
                let n: u8 = s[1..].parse().map_err(|_| format!("Invalid key {text}"))?;
                if !(1..=12).contains(&n) {
                    return Err(format!("Invalid key {text}"));
                }
                Key::F(n)
            }
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_graphic() => {
                Key::Char(s.chars().next().unwrap())
            }
            _ => return Err(format!("Invalid key {text}")),
        };
        if ctrl && !matches!(key, Key::Char('a'..='z')) {
            return Err("Ctrl keys must use a lowercase letter.".into());
        }
        Ok(Self { key, ctrl })
    }

    fn label(self) -> String {
        let text = match self.key {
            Key::Char(' ') => "space".into(),
            Key::Char(c) => c.to_string(),
            Key::Up => "↑".into(),
            Key::Down => "↓".into(),
            Key::Left => "←".into(),
            Key::Right => "→".into(),
            Key::PageUp => "pgup".into(),
            Key::PageDown => "pgdn".into(),
            Key::BackTab => "shift-tab".into(),
            Key::F(n) => format!("F{n}"),
            key => format!("{key:?}").to_lowercase(),
        };
        if self.ctrl {
            format!("ctrl-{text}")
        } else {
            text
        }
    }
}

#[derive(Clone)]
pub(super) struct Keymap {
    keys: Vec<Vec<Chord>>,
}

impl Default for Keymap {
    fn default() -> Self {
        Self::new(&KeyConfig::default()).expect("valid default key table")
    }
}

impl Keymap {
    pub fn new(config: &KeyConfig) -> Result<Self, String> {
        let overrides = match config {
            KeyConfig::Map(map) => map.clone(),
            KeyConfig::Preset(name) if name == "vim" => [
                ("history", "H"),
                ("pull", "L"),
                ("pan_left", "Left h"),
                ("pan_right", "Right l"),
                ("page_up", "PageUp Ctrl-u"),
                ("page_down", "PageDown Ctrl-d"),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect(),
            KeyConfig::Preset(name) => return Err(format!("Unknown key preset {name}")),
        };
        for name in overrides.keys() {
            if !TABLE.iter().any(|b| b.name == name) {
                return Err(format!("Unknown action {name}"));
            }
            if matches!(
                name.as_str(),
                "cancel" | "interrupt" | "prompt_send" | "prompt_erase"
            ) {
                return Err(format!(
                    "{name} is fixed so cancellation and credential entry stay available."
                ));
            }
        }
        let mut keys: Vec<Vec<Chord>> = Vec::new();
        for (i, binding) in TABLE.iter().enumerate() {
            let custom = overrides.get(binding.name);
            let chords = custom
                .map(String::as_str)
                .unwrap_or(binding.defaults)
                .split_whitespace()
                .map(Chord::parse)
                .collect::<Result<Vec<_>, _>>()?;
            if chords.is_empty() {
                return Err(format!("No key for {}", binding.name));
            }
            if custom.is_some()
                && binding.scope & INPUT != 0
                && chords
                    .iter()
                    .any(|c| matches!(c.key, Key::Char(_)) && !c.ctrl)
            {
                return Err(format!("{} needs a non-text key in editors.", binding.name));
            }
            for (j, previous) in keys.iter().enumerate() {
                if TABLE[j].scope & binding.scope != 0
                    && chords.iter().any(|c| previous.contains(c))
                {
                    return Err(format!(
                        "Conflicting keys: {} and {}",
                        TABLE[j].name, binding.name
                    ));
                }
            }
            if chords
                .iter()
                .enumerate()
                .any(|(n, c)| chords[..n].contains(c))
            {
                return Err(format!("Repeated key for {}", binding.name));
            }
            assert_eq!(keys.len(), i);
            keys.push(chords);
        }
        Ok(Self { keys })
    }

    pub fn lookup(&self, scope: u32, key: Key, ctrl: bool) -> Option<Command> {
        let chord = Chord { key, ctrl };
        TABLE
            .iter()
            .zip(&self.keys)
            .find(|(b, keys)| b.scope & scope != 0 && keys.contains(&chord))
            .map(|(b, _)| b.command)
    }

    pub fn label(&self, name: &str) -> String {
        let index = TABLE
            .iter()
            .position(|b| b.name == name)
            .expect("known named action");
        self.keys[index]
            .iter()
            .map(|c| c.label())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn command(&self, app: &App, key: Key, ctrl: bool) -> Option<Command> {
        self.lookup(v(app.view), key, ctrl).or_else(|| {
            if v(app.view) & INPUT != 0 && !ctrl {
                if let Key::Char(c) = key {
                    return Some(Command::Text(c));
                }
            }
            None
        })
    }

    pub fn shown(&self, app: &App, prompt: bool) -> Vec<(&'static Binding, String)> {
        let scope = if prompt { PROMPT } else { v(app.view) };
        TABLE
            .iter()
            .zip(&self.keys)
            .filter(|(b, _)| b.scope & scope != 0)
            .filter(|(b, _)| prompt || b.visible(app))
            .map(|(b, keys)| {
                (
                    b,
                    keys.iter().map(|c| c.label()).collect::<Vec<_>>().join(" "),
                )
            })
            .collect()
    }
}

impl Binding {
    fn visible(&self, app: &App) -> bool {
        use Command::*;
        if !WRITES
            && matches!(
                self.command,
                Merge | Rebase | CherryPick | Tag | Continue | Skip | Abort | MergeStash
            )
        {
            return false;
        }
        match self.command {
            MergeStash => {
                matches!(&app.confirm, Some(Confirm::Operation(r)) if matches!(r.action, gitty_core::operation_dto::GitAction::Merge { .. }))
            }
            Continue => app.operation.as_ref().is_some_and(|o| o.can_continue),
            Skip => app.operation.as_ref().is_some_and(|o| o.can_skip),
            Abort => app
                .operation
                .as_ref()
                .is_some_and(|o| o.kind != gitty_core::operation_dto::OperationKind::None),
            Amend => app.review.as_ref().is_some_and(|r| r.can_amend()),
            NextMatch | PreviousMatch => app.search_cancel.is_some(),
            Stage | StageAll | Discard | NextHunk | PreviousHunk | SelectLines
                if app.view == View::Diff && !app.working_diff() =>
            {
                false
            }
            Discard if app.staged => false,
            StashFiles => app.stash_detail.is_some(),
            IncludeUntracked => matches!(app.confirm, Some(Confirm::Stash(_))),
            AllowDelete => matches!(&app.confirm, Some(Confirm::Discard(r)) if r.untracked),
            RestoreIndex => {
                matches!(&app.confirm, Some(Confirm::StoredStash(r)) if r.verb != StashVerb::Drop)
            }
            Verify => app.uncertain.is_some(),
            _ if !WRITES
                && matches!(
                    self.command,
                    Stage
                        | StageAll
                        | Discard
                        | SaveCommit
                        | Commit
                        | Fetch
                        | Pull
                        | Push
                        | Stash
                        | Pop
                        | ApplyStash
                        | PopStash
                        | CreateHere
                        | New
                        | Edit
                        | Delete
                        | Publish
                        | InteractiveRebase
                        | Ours
                        | Theirs
                        | SaveMessage
                ) =>
            {
                false
            }
            _ => true,
        }
    }

    pub fn label(&self, app: &App) -> &str {
        match self.command {
            Command::Stage if app.staged => "unstage",
            Command::SaveCommit if app.amend => "amend",
            _ => self.label,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn lookup_is_contextual_and_input_characters_stay_text() {
        let map = Keymap::default();
        assert_eq!(
            map.lookup(v(View::History), Key::Char('n'), false),
            Some(Command::NextMatch)
        );
        assert_eq!(
            map.lookup(v(View::Diff), Key::Char('n'), false),
            Some(Command::NextHunk)
        );
        assert_eq!(
            map.lookup(v(View::Branches), Key::Char('n'), false),
            Some(Command::New)
        );
        let (jobs, _) = mpsc::sync_channel(1);
        let mut app = App::new(jobs);
        app.view = View::Composer;
        assert_eq!(
            map.command(&app, Key::Char('?'), false),
            Some(Command::Text('?'))
        );
        assert_eq!(
            map.command(&app, Key::Char('s'), false),
            Some(Command::Text('s'))
        );
        assert_eq!(map.command(&app, Key::F(1), false), Some(Command::Help));
        for (binding, keys) in TABLE.iter().zip(&map.keys) {
            for view in 0..=HELP.ilog2() {
                if binding.scope & (1 << view) != 0 {
                    for key in keys {
                        assert_eq!(
                            map.lookup(1 << view, key.key, key.ctrl),
                            Some(binding.command)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn custom_keys_reject_conflicts_unknown_names_and_editor_text() {
        for (name, key) in [
            ("stage", "Enter"),
            ("stage", "q"),
            ("stage", "Ctrl-c"),
            ("save_commit", "x"),
            ("unknown", "x"),
            ("stage", "BadKey"),
            ("stage", ""),
            ("stage", "x x"),
            ("cancel", "x"),
        ] {
            assert!(
                Keymap::new(&KeyConfig::Map([(name.into(), key.into())].into())).is_err(),
                "{name}: {key}"
            );
        }
        let map = Keymap::new(&KeyConfig::Map([("stage".into(), "x".into())].into())).unwrap();
        assert_eq!(
            map.lookup(v(View::Working), Key::Char('x'), false),
            Some(Command::Stage)
        );
        assert_eq!(map.lookup(v(View::Working), Key::Char('s'), false), None);
        assert_eq!(map.lookup(v(View::Confirm), Key::Char('x'), false), None);
        assert_eq!(map.label("stage"), "x");
    }

    #[test]
    fn vim_keeps_arrows_and_moves_conflicting_global_shortcuts() {
        let map = Keymap::new(&KeyConfig::Preset("vim".into())).unwrap();
        for key in [Key::Char('h'), Key::Left] {
            assert_eq!(map.lookup(v(View::Diff), key, false), Some(Command::Left));
        }
        assert_eq!(map.lookup(v(View::History), Key::Char('h'), false), None);
        assert_eq!(
            map.lookup(v(View::History), Key::Char('H'), false),
            Some(Command::History)
        );
        assert_eq!(
            map.lookup(v(View::Remote), Key::Char('L'), false),
            Some(Command::Pull)
        );
        assert_eq!(
            map.lookup(v(View::History), Key::Char('d'), true),
            Some(Command::PageDown)
        );
        assert!(Keymap::new(&KeyConfig::Preset("unknown".into())).is_err());
    }
}
