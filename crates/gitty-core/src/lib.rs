pub mod agent;
pub mod askpass;
pub mod branch_delete;
pub mod bridge;
pub mod clone;
pub mod clone_dto;
pub mod commit;
pub mod commit_graph;
pub mod conflicts;
pub mod credentials;
pub mod diff;
pub mod dto;
pub mod editor;
pub mod events;
pub mod external;
pub mod helper;
pub mod hunk;
pub mod identity;
pub mod mutate;
pub mod operation_dto;
pub mod operations;
pub mod process;
pub mod protocol;
pub mod provider_accounts;
pub mod provider_oauth;
pub mod provider_pr;
pub mod provider_repositories;
pub mod remote;
pub mod remote_dto;
pub mod repository;
pub mod ssh;
pub mod stash;
pub mod stream;
pub mod terminal;
pub mod watcher;
pub mod worktree_files;
pub mod worktrees;
pub mod wsl;

pub use agent::AgentService;
pub use dto::Error;
pub use mutate::AmendOptions;

#[cfg(test)]
mod agent_tests;
#[cfg(test)]
mod bench_tests;
#[cfg(test)]
mod branch_delete_tests;
#[cfg(test)]
mod hunk_tests;
#[cfg(test)]
mod operation_tests;
#[cfg(test)]
mod remote_tests;
#[cfg(all(test, unix))]
mod ssh_tests;
#[cfg(test)]
mod tests;
#[cfg(all(test, windows))]
mod wsl_tests;
