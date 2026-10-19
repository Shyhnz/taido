// Tests of fake-codex: node --test tools/fake-codex/test
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const BIN = path.join(__dirname, "..", "fake-codex");
const RELAY =
  "curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' " +
  '-H "X-App-Token: $TAIDO_HOOK_TOKEN" -H "X-Terminal-Id: $TAIDO_TERMINAL_ID" ' +
  '--data-binary @- "$TAIDO_HOOK_URL" || true';
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SessionEnd",
];

/** A server recording hooks and MCP messages, like the app's. */
function server() {
  const hooks = [];
  const mcp = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (req.url === "/hooks") {
        hooks.push({ terminal: req.headers["x-terminal-id"], ...msg });
        res.end("{}");
      } else {
        mcp.push({ token: req.headers["x-app-token"], ...msg });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id ?? null,
            result: { ok: true },
          }),
        );
      }
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({ srv, port: srv.address().port, hooks, mcp }),
    ),
  );
}

function args(port, extra = []) {
  const out = [
    "--no-daemon",
    "-c",
    `mcp_servers.taido.url="http://127.0.0.1:${port}/mcp"`,
    "-c",
    'mcp_servers.taido.env_http_headers={ "X-App-Token" = "TAIDO_HOOK_TOKEN", "X-Terminal-Id" = "TAIDO_TERMINAL_ID" }',
  ];
  for (const e of EVENTS) {
    out.push(
      "-c",
      `hooks.${e}=[{ matcher = "*", hooks = [{ type = "command", command = ${JSON.stringify(RELAY)}, timeout = 3 }] }]`,
    );
  }
  return [...out, ...extra];
}

function run(port, lines, extra = [], sub = []) {
  return new Promise((resolve) => {
    const child = spawn(BIN, [...sub, ...args(port, extra)], {
      env: {
        ...process.env,
        TAIDO_HOOK_TOKEN: "tok",
        TAIDO_TERMINAL_ID: "term-1",
        TAIDO_HOOK_URL: `http://127.0.0.1:${port}/hooks`,
        TAIDO_FAKE_SPEED: "10",
      },
    });
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    (async () => {
      for (const l of lines) {
        await new Promise((r) => setTimeout(r, l.wait ?? 50));
        child.stdin.write(`${l.text ?? l}\n`);
      }
    })();
    child.on("exit", (code) => resolve({ code, stdout }));
  });
}

test("connects to the MCP server first, then sends SessionStart with the first message", async () => {
  const s = await server();
  const { code, stdout } = await run(s.port, [
    { text: "Bonjour", wait: 200 },
    { text: "/exit", wait: 600 },
  ]);
  s.srv.close();
  assert.equal(code, 0);
  assert.match(stdout, /READY/);
  assert.equal(s.mcp[0].method, "initialize");
  assert.equal(s.mcp[0].token, "tok");
  const names = s.hooks.map((h) => h.hook_event_name);
  assert.deepEqual(names, [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ]);
  assert.equal(s.hooks[0].source, "startup");
  assert.equal(s.hooks[0].terminal, "term-1");
  assert.equal(new Set(s.hooks.map((h) => h.session_id)).size, 1);
});

test("resume announces the given conversation", async () => {
  const s = await server();
  await run(
    s.port,
    [
      { text: "Encore", wait: 200 },
      { text: "/exit", wait: 600 },
    ],
    [],
    ["resume", "019a-real"],
  );
  s.srv.close();
  assert.equal(s.hooks[0].hook_event_name, "SessionStart");
  assert.equal(s.hooks[0].source, "resume");
  assert.equal(s.hooks[0].session_id, "019a-real");
});

test("a permission turn waits for the typed answer", async () => {
  const s = await server();
  await run(s.port, [
    { text: "/p", wait: 200 },
    { text: "y", wait: 300 },
    { text: "/exit", wait: 300 },
  ]);
  s.srv.close();
  const names = s.hooks.map((h) => h.hook_event_name);
  assert.deepEqual(names.slice(0, 6), [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
  ]);
});
