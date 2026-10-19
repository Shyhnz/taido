use serde_json::{json, Value};

use super::*;

fn never(_: &str, _: &Value) -> ToolResult {
    panic!("no tool call expected")
}

fn ok_body(reply: Reply) -> Value {
    match reply {
        Reply::Ok(v) => v,
        other => panic!("expected 200, got {other:?}"),
    }
}

#[test]
fn the_server_discover_probe_is_refused_so_claude_falls_back() {
    let reply = handle(test_fixture("server-discover.json").as_bytes(), never);
    let Reply::BadRequest(v) = reply else {
        panic!("expected 400")
    };
    assert_eq!(v["id"], "server-discover-probe-1");
    assert_eq!(v["error"]["code"], -32601);
}

#[test]
fn initialize_answers_the_asked_legacy_version_with_tools_and_instructions() {
    let v = ok_body(handle(test_fixture("initialize.json").as_bytes(), never));
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["id"], 0);
    let r = &v["result"];
    assert_eq!(r["protocolVersion"], "2025-11-25");
    assert!(r["capabilities"]["tools"].is_object());
    assert_eq!(r["serverInfo"]["name"], "taido");
    assert!(r["instructions"]
        .as_str()
        .expect("instructions")
        .contains("add_to_note"));
    assert!(r["instructions"]
        .as_str()
        .expect("instructions")
        .contains("put that in the project notes"));
}

#[test]
fn initialize_with_an_unknown_version_answers_the_latest() {
    let body = json!({"jsonrpc":"2.0","id":7,"method":"initialize",
        "params":{"protocolVersion":"2099-01-01","capabilities":{}}});
    let v = ok_body(handle(body.to_string().as_bytes(), never));
    assert_eq!(v["result"]["protocolVersion"], "2025-11-25");
    let older = json!({"jsonrpc":"2.0","id":8,"method":"initialize",
        "params":{"protocolVersion":"2025-06-18","capabilities":{}}});
    let v = ok_body(handle(older.to_string().as_bytes(), never));
    assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
}

#[test]
fn notifications_and_client_responses_get_202() {
    let reply = handle(
        test_fixture("notifications-initialized.json").as_bytes(),
        never,
    );
    assert_eq!(reply, Reply::Accepted);
    let response = json!({"jsonrpc":"2.0","id":3,"result":{}});
    assert_eq!(
        handle(response.to_string().as_bytes(), never),
        Reply::Accepted
    );
}

#[test]
fn tools_list_gives_the_definitions() {
    let v = ok_body(handle(test_fixture("tools-list.json").as_bytes(), never));
    assert_eq!(v["id"], 1);
    assert_eq!(v["result"]["tools"], tools::definitions());
}

#[test]
fn tools_call_runs_the_tool_and_wraps_its_text() {
    let body = json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"create_subtask","arguments":{"title":"Pain"}}});
    let v = ok_body(handle(body.to_string().as_bytes(), |name, args| {
        assert_eq!(name, "create_subtask");
        assert_eq!(args["title"], "Pain");
        ToolResult::ok("done")
    }));
    assert_eq!(
        v["result"],
        json!({"content":[{"type":"text","text":"done"}],"isError":false})
    );
}

#[test]
fn a_refused_tool_sets_is_error_and_missing_arguments_are_an_empty_object() {
    let body = json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"list_projects"}});
    let v = ok_body(handle(body.to_string().as_bytes(), |_, args| {
        assert_eq!(*args, json!({}));
        ToolResult::error("no")
    }));
    assert_eq!(v["result"]["isError"], true);
}

#[test]
fn tools_call_without_a_name_is_invalid_params() {
    let body = json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{}});
    let v = ok_body(handle(body.to_string().as_bytes(), never));
    assert_eq!(v["error"]["code"], -32602);
}

#[test]
fn ping_answers_an_empty_result() {
    let body = json!({"jsonrpc":"2.0","id":"p","method":"ping"});
    let v = ok_body(handle(body.to_string().as_bytes(), never));
    assert_eq!(v["result"], json!({}));
}

#[test]
fn garbage_and_batches_are_bad_requests() {
    let Reply::BadRequest(v) = handle(b"{not json", never) else {
        panic!("expected 400")
    };
    assert_eq!(v["error"]["code"], -32700);
    let Reply::BadRequest(v) = handle(b"[]", never) else {
        panic!("expected 400")
    };
    assert_eq!(v["error"]["code"], -32600);
}

/// Words and characters of French that must not reach the agent: it reads English only.
fn french_marks(text: &str) -> Vec<String> {
    let mut found: Vec<String> = text
        .chars()
        .filter(|c| "éèàêçùôîâ«»".contains(*c))
        .map(String::from)
        .collect();
    for word in [
        " le ",
        " la ",
        " les ",
        " des ",
        " une ",
        "Sans projet",
        "projet",
    ] {
        if text.contains(word) {
            found.push(word.trim().to_string());
        }
    }
    found
}

#[test]
fn mcp_tool_descriptions_are_english() {
    let definitions = tools::definitions().to_string();
    assert_eq!(french_marks(&definitions), Vec::<String>::new());
    assert_eq!(french_marks(INSTRUCTIONS), Vec::<String>::new());
}
