use super::*;

#[test]
fn new_session_arguments_follow_the_spec() {
    let args = new_session_args(&NewSession {
        session_id: "11111111-2222-4333-8444-555555555555",
        settings_file: Path::new("/data/claude-hooks.json"),
        mcp_config_file: Path::new("/data/claude-mcp.json"),
        name: "Globex · Export CSV",
        permission_mode: Some(PermissionMode::Plan),
        context_file: Some(Path::new("/data/contexts/s1.md")),
        prompt: Some("  Export CSV\n\nAvec les prestataires  "),
        add_dir: None,
    });
    assert_eq!(
        args,
        [
            "--session-id",
            "11111111-2222-4333-8444-555555555555",
            "--settings",
            "/data/claude-hooks.json",
            "--mcp-config",
            "/data/claude-mcp.json",
            "--name",
            "Globex · Export CSV",
            "--permission-mode",
            "plan",
            "--append-system-prompt-file",
            "/data/contexts/s1.md",
            "Export CSV\n\nAvec les prestataires",
        ]
    );
}

#[test]
fn normal_mode_empty_prompt_and_no_context_add_nothing() {
    let args = new_session_args(&NewSession {
        session_id: "id",
        settings_file: Path::new("/s.json"),
        mcp_config_file: Path::new("/m.json"),
        name: "Titre",
        permission_mode: Some(PermissionMode::Default),
        context_file: None,
        prompt: Some("   "),
        add_dir: None,
    });
    assert_eq!(
        args,
        [
            "--session-id",
            "id",
            "--settings",
            "/s.json",
            "--mcp-config",
            "/m.json",
            "--name",
            "Titre"
        ]
    );
}

#[test]
fn a_prompt_starting_with_a_dash_stays_positional() {
    let args = new_session_args(&NewSession {
        session_id: "id",
        settings_file: Path::new("/s.json"),
        mcp_config_file: Path::new("/m.json"),
        name: "T",
        permission_mode: None,
        context_file: None,
        prompt: Some("--help me"),
        add_dir: None,
    });
    assert_eq!(args.last().map(String::as_str), Some(" --help me"));
}

#[test]
fn mcp_config_is_never_followed_by_the_prompt() {
    // `--mcp-config <configs...>` is variadic: the positional prompt must not follow it.
    let args = new_session_args(&NewSession {
        session_id: "id",
        settings_file: Path::new("/s.json"),
        mcp_config_file: Path::new("/m.json"),
        name: "T",
        permission_mode: None,
        context_file: None,
        prompt: Some("Bonjour"),
        add_dir: None,
    });
    let at = args.iter().position(|a| a == "--mcp-config").expect("flag");
    assert_eq!(args[at + 1], "/m.json");
    assert!(args[at + 2].starts_with("--"), "{args:?}");
    assert_eq!(args.last().map(String::as_str), Some("Bonjour"));
}

#[test]
fn mcp_config_points_to_the_app_server_with_env_headers() {
    let v = mcp_config(4242);
    let server = &v["mcpServers"]["taido"];
    assert_eq!(server["type"], "http");
    assert_eq!(server["url"], "http://127.0.0.1:4242/mcp");
    assert_eq!(server["headers"]["X-App-Token"], "${TAIDO_HOOK_TOKEN}");
    assert_eq!(server["headers"]["X-Terminal-Id"], "${TAIDO_TERMINAL_ID}");
}

#[test]
fn hooks_settings_pre_allow_the_app_tools() {
    let v = hooks_settings(Language::Fr, 4242);
    let allow: Vec<&str> = v["permissions"]["allow"]
        .as_array()
        .expect("allow")
        .iter()
        .map(|r| r.as_str().expect("rule"))
        .collect();
    assert_eq!(
        allow,
        [
            "mcp__taido__list_projects",
            "mcp__taido__list_tasks",
            "mcp__taido__create_task",
            "mcp__taido__create_subtask",
            "mcp__taido__add_to_note",
            "mcp__taido__list_note_pages",
            "mcp__taido__read_note_page",
            "mcp__taido__create_note_page",
            "mcp__taido__add_to_note_page",
        ]
    );
}

#[test]
fn session_name_with_and_without_project() {
    assert_eq!(session_name(Some("Globex"), "Devis"), "Globex · Devis");
    assert_eq!(session_name(None, "Devis"), "Devis");
}

#[test]
fn context_lists_the_task_and_truncates_the_description() {
    let long = "é".repeat(DESCRIPTION_MAX_CHARS + 5);
    let text = context_text(&TaskContext {
        subject: Some("Globex"),
        parent: None,
        title: "Export CSV",
        description: &long,
        subtasks: vec![(true, "Colonnes"), (false, "Tests")],
        attachments: &[],
    });
    assert!(text.starts_with("Context provided by Taido:\n- Project: Globex\n- Task: Export CSV\n"));
    let description = text
        .lines()
        .find(|l| l.starts_with("- Description: "))
        .expect("description line");
    assert_eq!(
        description.chars().count(),
        "- Description: ".chars().count() + DESCRIPTION_MAX_CHARS + 1
    );
    assert!(text.ends_with("- Subtasks:\n  - [x] Colonnes\n  - [ ] Tests\n"));
}

#[test]
fn context_without_project_description_or_subtasks() {
    let text = context_text(&TaskContext {
        subject: None,
        parent: None,
        title: "Seule",
        description: "  ",
        subtasks: vec![],
        attachments: &[],
    });
    assert_eq!(text, "Context provided by Taido:\n- Task: Seule\n");
}

#[test]
fn context_of_a_subtask_names_its_parent() {
    let text = context_text(&TaskContext {
        subject: Some("Globex"),
        parent: Some("Export CSV"),
        title: "Colonnes",
        description: "",
        subtasks: vec![],
        attachments: &[],
    });
    assert_eq!(
        text,
        "Context provided by Taido:\n- Project: Globex\n- Subtask of: Export CSV\n\
         - Task: Colonnes\n"
    );
}

#[test]
fn hooks_settings_shape() {
    let v = hooks_settings(Language::Fr, 4242);
    let hooks = v["hooks"].as_object().expect("hooks");
    assert_eq!(hooks.len(), EVENTS.len());
    assert!(!hooks.contains_key("MessageDisplay"));
    let start = &hooks["SessionStart"][0]["hooks"][0];
    assert_eq!(start["type"], "command");
    let cmd = start["command"].as_str().expect("command");
    assert!(cmd.contains("http://127.0.0.1:4242/hooks"));
    assert!(cmd.contains("$TAIDO_HOOK_TOKEN") && cmd.ends_with("|| true"));
    let stop = &hooks["Stop"][0];
    assert!(stop.get("matcher").is_none());
    assert_eq!(stop["hooks"][0]["type"], "http");
    assert_eq!(stop["hooks"][0]["timeout"], 5);
    assert_eq!(
        stop["hooks"][0]["headers"]["X-Terminal-Id"],
        "$TAIDO_TERMINAL_ID"
    );
    let perm = &hooks["PermissionRequest"][0];
    assert_eq!(perm["matcher"], "*");
    assert_eq!(perm["hooks"][0]["timeout"], 600);
    assert!(perm["hooks"][0]["statusMessage"].as_str().is_some());
}

#[test]
fn private_files_are_0600() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("sub/claude-hooks.json");
    write_private(&path, "{}").expect("write");
    write_private(&path, "{\"a\":1}").expect("rewrite");
    assert_eq!(std::fs::read_to_string(&path).expect("read"), "{\"a\":1}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn binary_resolution_order() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bin_dir = dir.path().join("bin");
    std::fs::create_dir_all(&bin_dir).expect("mkdir");
    let claude = bin_dir.join("claude");
    std::fs::write(&claude, "#!/bin/sh\n").expect("write");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    let mut env = BTreeMap::new();
    env.insert(
        "HOME".to_string(),
        dir.path().join("nohome").to_string_lossy().into_owned(),
    );
    env.insert(
        "PATH".to_string(),
        format!("/nonexistent:{}", bin_dir.to_string_lossy()),
    );
    assert_eq!(resolve_binary(None, None, &env), Some(claude.clone()));
    // The override wins, and a missing override file is "not found" (no silent fallback).
    let fake = claude.to_string_lossy().into_owned();
    assert_eq!(
        resolve_binary(Some(&fake), None, &BTreeMap::new()),
        Some(claude.clone())
    );
    assert_eq!(resolve_binary(Some("/nope/fake-claude"), None, &env), None);

    // The explicit setting comes after the override, before the automatic detection.
    let other = bin_dir.join("other-claude");
    std::fs::write(&other, "#!/bin/sh\n").expect("write");
    let not_executable = bin_dir.join("not-executable");
    std::fs::write(&not_executable, "#!/bin/sh\n").expect("write");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        std::fs::set_permissions(&not_executable, std::fs::Permissions::from_mode(0o644))
            .expect("chmod");
    }
    let other_s = other.to_string_lossy().into_owned();
    let not_exec_s = not_executable.to_string_lossy().into_owned();
    let dir_s = bin_dir.to_string_lossy().into_owned();
    let cases: [(Option<&str>, Option<&str>, Option<&PathBuf>); 7] = [
        (None, Some(&other_s), Some(&other)),
        (None, Some(&format!("  {other_s} ")), Some(&other)),
        (Some(&fake), Some(&other_s), Some(&claude)),
        (None, Some(""), Some(&claude)),
        (None, Some("/nope/claude"), None),
        (None, Some(&not_exec_s), None),
        (None, Some(&dir_s), None),
    ];
    for (override_bin, setting, expected) in cases {
        assert_eq!(
            resolve_binary(override_bin, setting, &env).as_ref(),
            expected,
            "{override_bin:?} {setting:?}"
        );
    }
}

#[test]
fn resume_arguments_pass_the_settings_again() {
    let args = resume_args(&Resume {
        conversation_id: "abc",
        settings_file: Path::new("/s.json"),
        mcp_config_file: Path::new("/m.json"),
        permission_mode: Some(PermissionMode::AcceptEdits),
        context_file: Some(Path::new("/c.md")),
        add_dir: None,
    });
    assert_eq!(
        args,
        [
            "--resume",
            "abc",
            "--settings",
            "/s.json",
            "--mcp-config",
            "/m.json",
            "--permission-mode",
            "acceptEdits",
            "--append-system-prompt-file",
            "/c.md",
        ]
    );
    let bare = resume_args(&Resume {
        conversation_id: "abc",
        settings_file: Path::new("/s.json"),
        mcp_config_file: Path::new("/m.json"),
        permission_mode: Some(PermissionMode::Default),
        context_file: None,
        add_dir: None,
    });
    assert_eq!(
        bare,
        [
            "--resume",
            "abc",
            "--settings",
            "/s.json",
            "--mcp-config",
            "/m.json"
        ]
    );
}

/// Taido V2.3: the attachments folder is readable by Claude (`--add-dir`, variadic, so an
/// option always follows it) and each file is named in the context.
#[test]
fn attachments_reach_claude() {
    let args = new_session_args(&NewSession {
        session_id: "s",
        settings_file: Path::new("/data/claude-hooks.json"),
        mcp_config_file: Path::new("/data/claude-mcp.json"),
        name: "Export",
        permission_mode: None,
        context_file: None,
        prompt: None,
        add_dir: Some(Path::new(
            "/Users/user/Taido/Pièces jointes/Summit/Export (abc123)",
        )),
    });
    let i = args
        .iter()
        .position(|a| a == "--add-dir")
        .expect("--add-dir");
    assert_eq!(
        args[i + 1],
        "/Users/user/Taido/Pièces jointes/Summit/Export (abc123)"
    );
    assert_eq!(args[i + 2], "--name");
    let resumed = resume_args(&Resume {
        conversation_id: "c",
        settings_file: Path::new("/data/claude-hooks.json"),
        mcp_config_file: Path::new("/data/claude-mcp.json"),
        permission_mode: None,
        context_file: None,
        add_dir: Some(Path::new("/x")),
    });
    assert_eq!(&resumed[resumed.len() - 2..], ["--add-dir", "/x"]);
    let files = ["/x/maquette.png".to_string()];
    let text = context_text(&TaskContext {
        subject: None,
        parent: None,
        title: "Export",
        description: "",
        subtasks: Vec::new(),
        attachments: &files,
    });
    assert!(text.contains("- Attachments (readable):\n  - /x/maquette.png\n"));
}
