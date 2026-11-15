use crate::AgentService;
use serde_json::json;

#[test]
fn agent_dispatch_rejects_unknown_methods_fields_and_mistyped_values() {
    let data = tempfile::tempdir().unwrap();
    let service = AgentService::new(data.path().to_owned());
    assert_eq!(
        service
            .dispatch("repository_missing", json!({}))
            .unwrap_err()
            .code,
        "unsupportedOperation"
    );
    assert_eq!(
        service
            .dispatch("repository_status", json!({"handle":"x","extra":true}))
            .unwrap_err()
            .code,
        "invalidRequest"
    );
    assert_eq!(
        service
            .dispatch(
                "repository_history",
                json!({"handle":"x","limit":"50","query":{}})
            )
            .unwrap_err()
            .code,
        "invalidRequest"
    );
    assert_eq!(
        service
            .dispatch(
                "repository_history",
                json!({"handle":"x","limit":50,"cursor":3,"query":{}})
            )
            .unwrap_err()
            .code,
        "invalidRequest"
    );
}

#[test]
fn optional_provider_host_and_discovery_methods_validate_and_enforce_policy() {
    let data = tempfile::tempdir().unwrap();
    let service = AgentService::new(data.path().to_owned());

    for (method, params) in [
        (
            "provider_connect_token",
            json!({"provider":"github","username":"user","token":"secret"}),
        ),
        ("provider_oauth_start", json!({"provider":"github"})),
        ("provider_oauth_poll", json!({"id":"session"})),
        ("provider_oauth_cancel", json!({"id":"session"})),
    ] {
        assert_eq!(
            service.dispatch(method, params).unwrap_err().code,
            "accountPolicy",
            "{method} must require explicit system-account access"
        );
    }
    assert_eq!(
        service
            .dispatch(
                "provider_connect_token",
                json!({"provider":"github","username":"user","token":"secret","extra":true})
            )
            .unwrap_err()
            .code,
        "invalidRequest"
    );
    assert_eq!(
        service
            .dispatch(
                "ssh_test",
                json!({"host":"-oProxyCommand=bad","path":"/","extra":true})
            )
            .unwrap_err()
            .code,
        "invalidRequest"
    );
    assert_eq!(
        service
            .dispatch("ssh_test", json!({"host":"-oProxyCommand=bad"}))
            .unwrap_err()
            .code,
        "invalidHost"
    );
    assert_eq!(
        service
            .dispatch("wsl_distributions", json!({"extra":true}))
            .unwrap_err()
            .code,
        "invalidRequest"
    );
    #[cfg(not(windows))]
    assert_eq!(
        service
            .dispatch("wsl_distributions", json!({}))
            .unwrap_err()
            .code,
        "unsupportedPlatform"
    );
}

#[test]
fn agent_dispatch_covers_native_read_and_review_contracts() {
    use crate::tests::{commit, git, init};
    use std::path::Path;

    let repo = init();
    std::fs::write(repo.path().join("tracked.txt"), "base\n").unwrap();
    commit(repo.path(), "base commit");
    let data = tempfile::tempdir().unwrap();
    let service = AgentService::new(data.path().to_owned());
    let opened = service
        .dispatch(
            "repository_open",
            json!({"location":{"kind":"native","path":repo.path()}}),
        )
        .unwrap();
    let handle = opened["session"]["handle"].as_str().unwrap();
    for method in [
        "repository_state",
        "repository_status",
        "repository_operation_state",
        "repository_git_identity",
        "repository_remotes",
        "repository_stashes",
        "repository_worktrees",
        "repository_commit_graph_status",
        "repository_snapshot",
    ] {
        let result = service
            .dispatch(method, json!({"handle":handle}))
            .unwrap_or_else(|error| panic!("{method}: {error:?}"));
        assert!(!result.is_null(), "{method} returned null");
    }
    let remotes = service
        .dispatch("repository_remotes", json!({"handle":handle}))
        .unwrap();
    assert!(remotes.as_array().unwrap().iter().all(|remote| {
        remote["name"].is_string()
            && remote["fetchUrl"].is_string()
            && remote["pushUrl"].is_string()
            && remote["branches"].is_array()
    }));
    let identity = service
        .dispatch("repository_git_identity", json!({"handle":handle}))
        .unwrap();
    service
        .dispatch(
            "repository_set_git_identity",
            json!({
                "handle":handle,
                "identity":{"name":"Agent","email":"agent@example.invalid"},
                "expectedLocal":identity["local"]
            }),
        )
        .unwrap();
    let head = git(Path::new(repo.path()), &["rev-parse", "HEAD"]);
    let detail = service
        .dispatch("repository_commit", json!({"handle":handle,"oid":head}))
        .unwrap();
    assert_eq!(detail["subject"], "base commit");
    let diff_files = service
        .dispatch(
            "repository_diff_files",
            json!({"handle":handle,"spec":{"kind":"commit","oid":head,"parent":null}}),
        )
        .unwrap();
    assert_eq!(diff_files.as_array().unwrap().len(), 1);

    for method in [
        "repository_set_git_identity",
        "repository_search",
        "repository_cancel_search",
        "repository_branch_relation",
        "repository_conflict_file",
        "repository_resolve_conflict",
        "repository_discard",
        "repository_stage_hunk",
        "repository_unstage_hunk",
        "repository_amend_commit",
        "repository_worktree_review",
        "repository_worktree_execute",
        "repository_stash_action",
        "repository_remote_action",
        "repository_run_operation",
        "repository_delete_branch",
        "repository_delete_branches",
        "repository_write_commit_graph",
        "repository_ignore_path",
    ] {
        let result = service.dispatch(method, json!({}));
        assert_ne!(
            result.unwrap_err().code,
            "unsupportedOperation",
            "{method} is listed but not dispatched"
        );
    }
    service
        .dispatch("repository_close", json!({"handle":handle}))
        .unwrap();
}

#[test]
fn malformed_line_indices_never_fall_back_to_whole_hunk_staging() {
    use crate::tests::{commit, git, init};

    let repo = init();
    std::fs::write(repo.path().join("file.txt"), "base\n").unwrap();
    commit(repo.path(), "base");
    std::fs::write(repo.path().join("file.txt"), "changed\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let service = AgentService::new(data.path().to_owned());
    let opened = service
        .dispatch(
            "repository_open",
            json!({"location":{"kind":"native","path":repo.path()}}),
        )
        .unwrap();
    let handle = opened["session"]["handle"].as_str().unwrap();
    let diff = service
        .dispatch(
            "repository_diff",
            json!({"handle":handle,"spec":{"kind":"unstaged"},"path":"file.txt"}),
        )
        .unwrap();
    let fingerprint = diff["hunkAction"]["fingerprint"].as_str().unwrap();
    let error = service
        .dispatch(
            "repository_stage_hunk",
            json!({
                "handle":handle,
                "path":"file.txt",
                "hunkIndex":0,
                "fingerprint":fingerprint,
                "lineIndices":"not-an-array"
            }),
        )
        .unwrap_err();
    assert_eq!(error.code, "invalidRequest");
    assert_eq!(git(repo.path(), &["show", ":file.txt"]), "base");
    assert_eq!(
        std::fs::read_to_string(repo.path().join("file.txt")).unwrap(),
        "changed\n"
    );
}

#[test]
fn malformed_amend_flags_never_default_to_a_wider_rewrite() {
    use crate::tests::{commit, git, init};

    for (field, value) in [
        ("messageOnly", json!("true")),
        ("requireUnpushed", json!(1)),
    ] {
        let repo = init();
        std::fs::write(repo.path().join("file.txt"), "base\n").unwrap();
        commit(repo.path(), "original subject");
        let before = git(repo.path(), &["rev-parse", "HEAD"]);
        let data = tempfile::tempdir().unwrap();
        let service = AgentService::new(data.path().to_owned());
        let opened = service
            .dispatch(
                "repository_open",
                json!({"location":{"kind":"native","path":repo.path()}}),
            )
            .unwrap();
        let handle = opened["session"]["handle"].as_str().unwrap();
        let status = service
            .dispatch("repository_status", json!({"handle":handle}))
            .unwrap();
        let mut params = json!({
            "handle":handle,
            "message":"rewritten subject",
            "expectedHead":before.clone(),
            "expectedStatusFingerprint":status["fingerprint"]
        });
        params[field] = value;
        let error = service
            .dispatch("repository_amend_commit", params)
            .unwrap_err();
        assert_eq!(error.code, "invalidRequest", "{field}");
        assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), before, "{field}");
        assert_eq!(
            git(repo.path(), &["log", "-1", "--format=%s"]),
            "original subject"
        );
    }
}
