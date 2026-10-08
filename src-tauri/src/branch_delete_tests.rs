use crate::{
    branch_delete::BranchDeleteRequest,
    repository::Service,
    tests::{commit, git, init, open},
};

#[test]
fn branch_delete_request_rejects_unknown_fields_and_uses_camel_case() {
    let valid = serde_json::json!({
        "branch": "feature/nested", "expectedHead": null, "expectedHeadRef": "refs/heads/main",
        "expectedLocalOid": "0123456789012345678901234567890123456789", "deleteLocal": true,
        "deleteOrigin": false, "forceLocal": false
    });
    assert!(serde_json::from_value::<BranchDeleteRequest>(valid.clone()).is_ok());
    let mut invalid = valid;
    invalid["surprise"] = serde_json::json!(true);
    assert!(serde_json::from_value::<BranchDeleteRequest>(invalid).is_err());
}

fn request(
    branch: &str,
    state: &crate::dto::RepositoryState,
    oid: &str,
    force: bool,
) -> BranchDeleteRequest {
    BranchDeleteRequest {
        branch: branch.into(),
        expected_head: state.session.head.clone(),
        expected_head_ref: state.session.head_ref.clone(),
        expected_local_oid: Some(oid.into()),
        expected_origin_oid: None,
        expected_push_url: None,
        delete_local: true,
        delete_origin: false,
        force_local: force,
    }
}

#[test]
fn branch_delete_requires_fresh_state_and_refuses_current_branch() {
    let repo = init();
    std::fs::write(repo.path().join("base"), "one").unwrap();
    let tip = commit(repo.path(), "base");
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, repo.path());
    let error = service
        .delete_branch(
            &state.session.handle,
            request("main", &state, &tip, false),
            None,
        )
        .unwrap_err();
    assert_eq!(error.code, "currentBranch");
    git(repo.path(), &["branch", "topic", &tip]);
    let mut stale = request("topic", &state, &tip, false);
    stale.expected_head = Some("stale".into());
    assert_eq!(
        service
            .delete_branch(&state.session.handle, stale, None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
}

#[test]
fn branch_delete_safe_failure_is_classified_and_force_requires_a_second_request() {
    let repo = init();
    std::fs::write(repo.path().join("base"), "base").unwrap();
    commit(repo.path(), "base");
    git(repo.path(), &["switch", "-c", "topic"]);
    std::fs::write(repo.path().join("topic"), "topic").unwrap();
    let tip = commit(repo.path(), "topic");
    git(repo.path(), &["switch", "main"]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, repo.path());
    let result = service
        .delete_branch(
            &state.session.handle,
            request("topic", &state, &tip, false),
            None,
        )
        .unwrap();
    assert_eq!(result.local.unwrap().error.unwrap().code, "branchNotMerged");
    assert_eq!(git(repo.path(), &["rev-parse", "refs/heads/topic"]), tip);
    let forced = service
        .delete_branch(
            &state.session.handle,
            request("topic", &state, &tip, true),
            None,
        )
        .unwrap();
    assert_eq!(forced.local.unwrap().status, "deleted");
    assert!(git(repo.path(), &["branch", "--list", "topic"]).is_empty());
}

#[test]
fn branch_delete_ref_lock_failure_is_not_misreported_as_unmerged() {
    let repo = init();
    std::fs::write(repo.path().join("base"), "base").unwrap();
    let tip = commit(repo.path(), "base");
    git(repo.path(), &["branch", "topic", &tip]);
    std::fs::write(repo.path().join(".git/refs/heads/topic.lock"), "held").unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, repo.path());
    let result = service
        .delete_branch(
            &state.session.handle,
            request("topic", &state, &tip, false),
            None,
        )
        .unwrap();
    assert_eq!(result.local.unwrap().error.unwrap().code, "git");
    assert_eq!(git(repo.path(), &["rev-parse", "refs/heads/topic"]), tip);
}

#[test]
fn branch_delete_protects_branches_checked_out_in_linked_worktrees() {
    let repo = init();
    std::fs::write(repo.path().join("base"), "base").unwrap();
    let tip = commit(repo.path(), "base");
    let linked = tempfile::tempdir().unwrap();
    let worktree = linked.path().join("worktree");
    git(
        repo.path(),
        &["worktree", "add", "-b", "topic", worktree.to_str().unwrap()],
    );
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, repo.path());
    let error = service
        .delete_branch(
            &state.session.handle,
            request("topic", &state, &tip, false),
            None,
        )
        .unwrap_err();
    assert_eq!(error.code, "branchInUse");
    assert_eq!(git(repo.path(), &["rev-parse", "refs/heads/topic"]), tip);
}

#[test]
fn stale_origin_oid_or_push_url_preflight_prevents_local_deletion() {
    let repo = init();
    std::fs::write(repo.path().join("base"), "base").unwrap();
    let base = commit(repo.path(), "base");
    git(repo.path(), &["branch", "topic", &base]);
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare"]);
    let remote_path = remote.path().to_str().unwrap();
    git(repo.path(), &["remote", "add", "origin", remote_path]);
    git(
        repo.path(),
        &["push", "origin", "refs/heads/topic:refs/heads/topic"],
    );
    git(
        repo.path(),
        &[
            "fetch",
            "origin",
            "refs/heads/topic:refs/remotes/origin/topic",
        ],
    );
    std::fs::write(repo.path().join("later"), "later").unwrap();
    let moved = commit(repo.path(), "later");
    git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/topic", &moved],
    );

    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, repo.path());
    let request = |expected_origin_oid: &str, expected_push_url: &str| BranchDeleteRequest {
        branch: "topic".into(),
        expected_head: state.session.head.clone(),
        expected_head_ref: state.session.head_ref.clone(),
        expected_local_oid: Some(base.clone()),
        expected_origin_oid: Some(expected_origin_oid.into()),
        expected_push_url: Some(expected_push_url.into()),
        delete_local: true,
        delete_origin: true,
        force_local: false,
    };
    let stale_oid = service
        .delete_branch(&state.session.handle, request(&base, remote_path), None)
        .unwrap();
    assert_eq!(stale_oid.local.unwrap().status, "notAttempted");
    assert_eq!(
        stale_oid.origin.unwrap().error.unwrap().code,
        "staleOperation"
    );
    assert_eq!(git(repo.path(), &["rev-parse", "refs/heads/topic"]), base);

    git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/topic", &base],
    );
    let other = tempfile::tempdir().unwrap();
    git(other.path(), &["init", "--bare"]);
    git(
        repo.path(),
        &[
            "remote",
            "set-url",
            "--push",
            "origin",
            other.path().to_str().unwrap(),
        ],
    );
    let stale_url = service
        .delete_branch(&state.session.handle, request(&base, remote_path), None)
        .unwrap();
    assert_eq!(stale_url.local.unwrap().status, "notAttempted");
    assert_eq!(
        stale_url.origin.unwrap().error.unwrap().code,
        "staleOperation"
    );
    assert_eq!(git(repo.path(), &["rev-parse", "refs/heads/topic"]), base);
}

#[test]
fn confirmed_force_in_both_scope_deletes_local_then_leased_origin() {
    let repo = init();
    std::fs::write(repo.path().join("base"), "base").unwrap();
    commit(repo.path(), "base");
    git(repo.path(), &["switch", "-c", "topic"]);
    std::fs::write(repo.path().join("topic"), "topic").unwrap();
    let tip = commit(repo.path(), "topic work");
    git(repo.path(), &["switch", "main"]);
    std::fs::write(repo.path().join("main-only"), "main").unwrap();
    commit(repo.path(), "main work");

    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare"]);
    let remote_path = remote.path().to_str().unwrap();
    git(repo.path(), &["remote", "add", "origin", remote_path]);
    git(
        repo.path(),
        &["push", "origin", &format!("{tip}:refs/heads/topic")],
    );
    git(
        repo.path(),
        &[
            "fetch",
            "origin",
            "refs/heads/topic:refs/remotes/origin/topic",
        ],
    );

    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, repo.path());
    let request = |force_local| BranchDeleteRequest {
        branch: "topic".into(),
        expected_head: state.session.head.clone(),
        expected_head_ref: state.session.head_ref.clone(),
        expected_local_oid: Some(tip.clone()),
        expected_origin_oid: Some(tip.clone()),
        expected_push_url: Some(remote_path.into()),
        delete_local: true,
        delete_origin: true,
        force_local,
    };
    let refused = service
        .delete_branch(&state.session.handle, request(false), None)
        .unwrap();
    assert_eq!(
        refused.local.as_ref().unwrap().error.as_ref().unwrap().code,
        "branchNotMerged"
    );
    assert_eq!(refused.origin.as_ref().unwrap().status, "notAttempted");
    assert_eq!(git(repo.path(), &["rev-parse", "refs/heads/topic"]), tip);

    let forced = service
        .delete_branch(&state.session.handle, request(true), None)
        .unwrap();
    assert_eq!(forced.local.as_ref().unwrap().status, "deleted");
    assert_eq!(forced.origin.as_ref().unwrap().status, "deleted");
    assert!(git(repo.path(), &["for-each-ref", "refs/heads/topic"]).is_empty());
    assert!(git(remote.path(), &["for-each-ref", "refs/heads/topic"]).is_empty());
}

#[test]
fn origin_delete_uses_a_lease_and_keeps_local_tracking_ref_when_peer_moved() {
    let repo = init();
    std::fs::write(repo.path().join("base"), "base").unwrap();
    let base = commit(repo.path(), "base");
    git(repo.path(), &["branch", "topic", &base]);
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare"]);
    let remote_path = remote.path().to_str().unwrap();
    git(repo.path(), &["remote", "add", "origin", remote_path]);
    git(
        repo.path(),
        &["push", "origin", "refs/heads/topic:refs/heads/topic"],
    );
    git(
        repo.path(),
        &[
            "fetch",
            "origin",
            "refs/heads/topic:refs/remotes/origin/topic",
        ],
    );

    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, repo.path());
    let request = BranchDeleteRequest {
        branch: "topic".into(),
        expected_head: state.session.head.clone(),
        expected_head_ref: state.session.head_ref.clone(),
        expected_local_oid: None,
        expected_origin_oid: Some(base.clone()),
        expected_push_url: Some(remote_path.into()),
        delete_local: false,
        delete_origin: true,
        force_local: false,
    };
    let peer = tempfile::tempdir().unwrap();
    git(
        peer.path(),
        &["clone", remote_path, peer.path().to_str().unwrap()],
    );
    git(
        peer.path(),
        &["switch", "-c", "topic", "--track", "origin/topic"],
    );
    git(peer.path(), &["config", "user.name", "Peer"]);
    git(peer.path(), &["config", "user.email", "peer@example.test"]);
    std::fs::write(peer.path().join("peer"), "peer").unwrap();
    let moved = commit(peer.path(), "peer movement");
    git(
        peer.path(),
        &["push", "origin", &format!("{moved}:refs/heads/topic")],
    );
    let result = service
        .delete_branch(&state.session.handle, request, None)
        .unwrap();
    assert_eq!(result.origin.as_ref().unwrap().status, "failed");
    let error = result.origin.unwrap().error.unwrap();
    assert_eq!(error.code, "git", "{error:?}");
    assert_eq!(
        git(remote.path(), &["rev-parse", "refs/heads/topic"]),
        moved
    );
    assert_eq!(
        git(repo.path(), &["rev-parse", "refs/remotes/origin/topic"]),
        base
    );
    git(
        repo.path(),
        &[
            "fetch",
            "origin",
            "refs/heads/topic:refs/remotes/origin/topic",
        ],
    );
    let refreshed = BranchDeleteRequest {
        branch: "topic".into(),
        expected_head: state.session.head.clone(),
        expected_head_ref: state.session.head_ref.clone(),
        expected_local_oid: None,
        expected_origin_oid: Some(moved),
        expected_push_url: Some(remote_path.into()),
        delete_local: false,
        delete_origin: true,
        force_local: false,
    };
    let deleted = service
        .delete_branch(&state.session.handle, refreshed, None)
        .unwrap();
    assert_eq!(deleted.origin.unwrap().status, "deleted");
    assert!(git(repo.path(), &["for-each-ref", "refs/remotes/origin/topic"]).is_empty());
    assert!(git(remote.path(), &["for-each-ref", "refs/heads/topic"]).is_empty());
}
