use super::*;

/// (completed_at, description, expected ring, expected line kind, text and tone)
type Case = (
    Option<&'static str>,
    &'static str,
    Ring,
    Option<(LineKind, Option<&'static str>, LineTone)>,
);

#[test]
fn ring_and_line_without_sessions() {
    let cases: &[Case] = &[
        (None, "", Ring::Human, None),
        (None, "  \n\n  ", Ring::Human, None),
        (
            None,
            "\n  First line  \nsecond",
            Ring::Human,
            Some((LineKind::Description, Some("First line"), LineTone::Muted)),
        ),
        (
            Some("2026-10-02T10:00:00.000Z"),
            "desc",
            Ring::Completed,
            Some((LineKind::Completed, None, LineTone::Faint)),
        ),
    ];
    for &(completed_at, description, expected_ring, expected_line) in cases {
        let input = RingInput {
            completed_at,
            description,
            sessions: &[],
        };
        let r = ring(&input);
        assert_eq!(r, expected_ring);
        let l = line(&input, r);
        match expected_line {
            None => assert_eq!(l, None),
            Some((kind, text, tone)) => {
                let l = l.expect("line");
                assert_eq!(l.kind, kind);
                assert_eq!(l.text.as_deref(), text);
                assert_eq!(l.tone, tone);
                assert_eq!(l.at.as_deref(), completed_at);
            }
        }
        assert_eq!(ring_since(&input, r).as_deref(), completed_at);
        assert_eq!(row_line(&input, r), None, "no second line without Claude");
    }
}

#[test]
fn long_description_is_truncated() {
    let long = "é".repeat(500);
    let line = first_line(&long).expect("line");
    assert_eq!(line.chars().count(), DESCRIPTION_LINE_MAX);
    assert!(line.ends_with('…'));
    let exact = "a".repeat(DESCRIPTION_LINE_MAX);
    assert_eq!(first_line(&exact).as_deref(), Some(exact.as_str()));
}

#[test]
fn urgency_order() {
    let ordered = [
        Ring::Waiting,
        Ring::Error,
        Ring::Crashed,
        Ring::Done,
        Ring::Working,
        Ring::Idle,
        Ring::Paused,
        Ring::Human,
    ];
    for pair in ordered.windows(2) {
        assert!(urgency(pair[0]) < urgency(pair[1]), "{pair:?}");
    }
    assert_eq!(urgency(Ring::Starting), urgency(Ring::Working));
    assert!(is_claude_waiting(Ring::Done) && !is_claude_waiting(Ring::Working));
    assert!(is_active_today(Ring::Idle) && !is_active_today(Ring::Paused));
    assert!(!is_active_today(Ring::Human));
    // Starting counts as Working: the task is in Today from the launch.
    assert!(is_active_today(Ring::Starting));
}

/// A session at minute `minute` (its start, last update and state change).
fn s(state: SessionState, open: bool, minute: u32) -> SessionFacts {
    let at = format!("2026-10-03T10:{minute:02}:00.000Z");
    SessionFacts {
        agent: crate::model::Agent::Claude,
        state,
        waiting_kind: (state == SessionState::Waiting).then_some(WaitingKind::Input),
        terminal_open: open,
        activity: None,
        last_message: None,
        question: None,
        permission: None,
        error_kind: None,
        state_changed_at: at.clone(),
        updated_at: at.clone(),
        started_at: at,
    }
}

fn ring_of(sessions: &[SessionFacts]) -> Ring {
    ring(&RingInput {
        completed_at: None,
        description: "desc",
        sessions,
    })
}

#[test]
fn ring_precedence() {
    use SessionState::*;
    // Among open terminals, the most urgent wins.
    let order = [Waiting, Error, Crashed, Done, Working, Idle, Paused];
    for (i, &urgent) in order.iter().enumerate() {
        for &other in &order[i..] {
            // A stopped session shows as a plain task.
            let expected = if urgent == Paused {
                Ring::Human
            } else {
                session_ring(urgent)
            };
            let sessions = [s(other, true, 1), s(urgent, true, 2)];
            assert_eq!(ring_of(&sessions), expected, "{urgent:?} vs {other:?}");
            let sessions = [s(urgent, true, 2), s(other, true, 1)];
            assert_eq!(ring_of(&sessions), expected, "{urgent:?} vs {other:?}");
        }
    }
    assert_eq!(ring_of(&[s(Starting, true, 1)]), Ring::Starting);
    assert_eq!(
        ring_of(&[s(Starting, true, 1), s(Idle, true, 2)]),
        Ring::Starting
    );
    // A Crashed session keeps its « ! » until its tab is closed (which settles it), even
    // though its terminal row is closed; ended sessions are history.
    assert_eq!(
        ring_of(&[s(Crashed, false, 5), s(Idle, true, 1)]),
        Ring::Crashed
    );
    assert_eq!(
        ring_of(&[s(Crashed, false, 1), s(Paused, false, 3)]),
        Ring::Crashed
    );
    assert_eq!(ring_of(&[s(Paused, false, 4)]), Ring::Human);
    assert_eq!(ring_of(&[s(Done, false, 4)]), Ring::Human);
    // No session: Human. Completed wins over everything.
    assert_eq!(ring_of(&[]), Ring::Human);
    let sessions = [s(Waiting, true, 1)];
    let input = RingInput {
        completed_at: Some("2026-10-03T11:00:00.000Z"),
        description: "",
        sessions: &sessions,
    };
    assert_eq!(ring(&input), Ring::Completed);
    assert_eq!(row_line(&input, Ring::Completed), None);
}

/// sessions left Starting by an early version (no state machine yet) while their
/// terminal is closed must not show a Claude that keeps starting.
#[test]
fn a_live_state_without_open_terminal_shows_as_paused() {
    use SessionState::*;
    for live in [Starting, Idle, Working, Waiting, Done, Error, Paused] {
        let sessions = [s(live, false, 1)];
        // No running Claude: a plain task, its description in the detail, nothing in lists.
        assert_eq!(ring_of(&sessions), Ring::Human, "{live:?}");
        let input = RingInput {
            completed_at: None,
            description: "A note",
            sessions: &sessions,
        };
        assert_eq!(row_line(&input, Ring::Human), None, "{live:?}");
        let l = line(&input, Ring::Human).expect("line");
        assert_eq!(l.kind, LineKind::Description, "{live:?}");
    }
    assert_eq!(ring_of(&[s(Crashed, false, 1)]), Ring::Crashed);
}

#[test]
fn line_texts() {
    use SessionState::*;
    let base = |state, kind| SessionFacts {
        agent: crate::model::Agent::Claude,
        waiting_kind: kind,
        ..s(state, true, 7)
    };
    type LineCase = (SessionFacts, LineKind, Option<&'static str>, bool, LineTone);
    let cases: Vec<LineCase> = vec![
        (
            SessionFacts {
                agent: crate::model::Agent::Claude,
                permission: Some("Commande : rm -rf dist".into()),
                ..base(Waiting, Some(WaitingKind::Permission))
            },
            LineKind::WaitingPermission,
            Some("Commande : rm -rf dist"),
            false,
            LineTone::Waiting,
        ),
        (
            // The question stored at `Stop`; the stored message was cut at 500 characters.
            SessionFacts {
                agent: crate::model::Agent::Claude,
                last_message: Some(format!("{}…", "J'ai fini l'export. ".repeat(24))),
                question: Some("Tu veux que je pousse ?".into()),
                ..base(Waiting, Some(WaitingKind::Question))
            },
            LineKind::WaitingQuestion,
            Some("Tu veux que je pousse ?"),
            false,
            LineTone::Waiting,
        ),
        (
            base(Waiting, Some(WaitingKind::Input)),
            LineKind::WaitingInput,
            None,
            false,
            LineTone::Waiting,
        ),
        (
            SessionFacts {
                agent: crate::model::Agent::Claude,
                error_kind: Some("rate_limit".into()),
                ..base(Error, None)
            },
            LineKind::Error,
            Some("Limite d'usage atteinte"),
            false,
            LineTone::Primary,
        ),
        (
            SessionFacts {
                agent: crate::model::Agent::Claude,
                error_kind: Some("model_not_found".into()),
                ..base(Error, None)
            },
            LineKind::Error,
            Some("Erreur : model_not_found"),
            false,
            LineTone::Primary,
        ),
        (
            base(Crashed, None),
            LineKind::Crashed,
            None,
            false,
            LineTone::Primary,
        ),
        (
            SessionFacts {
                agent: crate::model::Agent::Claude,
                last_message: Some("Export **CSV** ajouté. Les tests passent.".into()),
                ..base(Done, None)
            },
            LineKind::Done,
            Some("Export CSV ajouté."),
            false,
            LineTone::Done,
        ),
        (
            SessionFacts {
                agent: crate::model::Agent::Claude,
                activity: Some("Édition src/export.ts".into()),
                ..base(Working, None)
            },
            LineKind::Working,
            Some("Édition src/export.ts"),
            false,
            LineTone::Muted,
        ),
        (
            base(Working, None),
            LineKind::Working,
            None,
            false,
            LineTone::Muted,
        ),
        (
            base(Starting, None),
            LineKind::Starting,
            None,
            false,
            LineTone::Muted,
        ),
        (
            base(Idle, None),
            LineKind::Idle,
            None,
            false,
            LineTone::Muted,
        ),
        // Paused shows as a plain task: see a_live_state_without_open_terminal_shows_as_paused.
    ];
    for (session, kind, text, has_at, tone) in cases {
        let sessions = [session];
        let input = RingInput {
            completed_at: None,
            description: "Description never shown with Claude",
            sessions: &sessions,
        };
        let r = ring(&input);
        let l = row_line(&input, r).expect("row line");
        assert_eq!(l.kind, kind);
        assert_eq!(l.text.as_deref(), text, "{kind:?}");
        assert_eq!(l.tone, tone, "{kind:?}");
        assert_eq!(l.at.is_some(), has_at, "{kind:?}");
        assert_eq!(line(&input, r), Some(l), "detail and row share the line");
        assert_eq!(
            ring_since(&input, r).as_deref(),
            Some("2026-10-03T10:07:00.000Z")
        );
    }
}

#[test]
fn subject_dots() {
    use Ring::*;
    let cases: &[(&[Ring], Option<SubjectDot>)] = &[
        (&[], None),
        (&[Human, Working, Idle, Paused, Starting], None),
        (&[Done, Human], Some(SubjectDot::Done)),
        (&[Done, Crashed], Some(SubjectDot::Error)),
        (&[Error, Done], Some(SubjectDot::Error)),
        (&[Done, Error, Waiting, Crashed], Some(SubjectDot::Waiting)),
    ];
    for (rings, expected) in cases {
        assert_eq!(subject_dot(rings.iter().copied()), *expected, "{rings:?}");
    }
}

#[test]
fn the_session_line_names_its_agent() {
    let mut codex = s(SessionState::Waiting, true, 1);
    codex.agent = crate::model::Agent::Codex;
    assert_eq!(session_line(&codex).agent, Some(crate::model::Agent::Codex));
    let claude = s(SessionState::Done, true, 2);
    assert_eq!(
        session_line(&claude).agent,
        Some(crate::model::Agent::Claude)
    );
}
