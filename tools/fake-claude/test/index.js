// Tests of tools/fake-claude (run: node --test tools/fake-claude/test). A local HTTP server
// plays the app's hook server; the settings file has the shape of `hooks_settings` in
// src-tauri/src/claude/mod.rs, including the curl relay of SessionStart.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const FAKE = path.join(__dirname, "..", "fake-claude");
const FIXTURES = path.join(__dirname, "..", "..", "..", "fixtures", "hooks");
const TOKEN = "test-token-123";
const TERMINAL = "term-test";
const NAME = "Globex · Export CSV";
const SPEED = "20";
/// Never answers (the hook timeout must fire).
const HANG = Symbol("hang");

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];
const TOOL_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
];

function httpHook(port, timeout) {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/hooks`,
    headers: {
      "X-App-Token": "$TAIDO_HOOK_TOKEN",
      "X-Terminal-Id": "$TAIDO_TERMINAL_ID",
    },
    allowedEnvVars: ["TAIDO_HOOK_TOKEN", "TAIDO_TERMINAL_ID"],
    timeout,
  };
}

/// Same shape as `hooks_settings(port)` in the Rust core.
function appSettings(port) {
  const hooks = {};
  for (const event of EVENTS) {
    let hook;
    if (event === "SessionStart") {
      hook = {
        type: "command",
        command:
          "curl -sS -m 3 -o /dev/null -X POST -H 'Content-Type: application/json' " +
          '-H "X-App-Token: $TAIDO_HOOK_TOKEN" ' +
          '-H "X-Terminal-Id: $TAIDO_TERMINAL_ID" ' +
          `--data-binary @- http://127.0.0.1:${port}/hooks || true`,
        timeout: 5,
      };
    } else if (event === "PermissionRequest") {
      hook = {
        ...httpHook(port, 600),
        statusMessage: "En attente de ta réponse dans Todo…",
      };
    } else {
      hook = httpHook(port, 5);
    }
    const group = { hooks: [hook] };
    if (TOOL_EVENTS.includes(event)) group.matcher = "*";
    hooks[event] = [group];
  }
  return { hooks };
}

/// Hook server: records every request; `respond(entry)` gives the JSON reply ({} default).
async function startServer(respond) {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = { raw: body };
      }
      const entry = {
        event: payload.hook_event_name,
        payload,
        headers: req.headers,
        url: req.url,
      };
      events.push(entry);
      const reply = respond ? await respond(entry) : {};
      if (reply === HANG) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    events,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function tempDir() {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-test-")),
  );
}

function baseEnv(extra = {}) {
  // Run inside the app's own terminal, the parent environment carries the app's
  // TAIDO_* variables: start from a clean set so only `extra` decides them.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("TAIDO_")),
  );
  const env = { ...inherited, TAIDO_FAKE_SPEED: SPEED, ...extra };
  delete env.CLAUDECODE;
  return env;
}

/// Runs fake-claude to completion. `script` (lines) goes through `--script`; `stdin`
/// (string) is written to a pipe otherwise.
function run({ args = [], settings, script, stdin, env, cwd }) {
  const dir = cwd ?? tempDir();
  const fullArgs = [...args];
  if (settings) {
    const file = path.join(dir, "claude-hooks.json");
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    fullArgs.unshift("--settings", file);
  }
  if (script) {
    const file = path.join(dir, "script.txt");
    fs.writeFileSync(file, `${script.join("\n")}\n`);
    fullArgs.push("--script", file);
  }
  const started = Date.now();
  const child = spawn(FAKE, fullArgs, {
    cwd: dir,
    env: env ?? baseEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  child.stderr.on("data", (c) => {
    stderr += c;
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  else if (!script) child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, cwd: dir, ms: Date.now() - started });
    });
  });
}

function appEnv() {
  return baseEnv({
    TAIDO_HOOK_TOKEN: TOKEN,
    TAIDO_TERMINAL_ID: TERMINAL,
  });
}

function fixture(name) {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"),
  );
}

function kind(v) {
  if (v === null) return "null";
  return Array.isArray(v) ? "array" : typeof v;
}

/// Same field names and value kinds as the captured payload.
function assertShape(payload, name) {
  const expected = fixture(name);
  assert.deepEqual(
    Object.keys(payload).sort(),
    Object.keys(expected).sort(),
    `fields of ${name}`,
  );
  for (const key of Object.keys(expected)) {
    assert.equal(kind(payload[key]), kind(expected[key]), `${name}.${key}`);
  }
}

function names(events) {
  return events.map((e) => e.event);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("prints the header, echoes lines and exits on `exit`", async () => {
  const r = await run({
    args: ["--session-id", "abc", "--name", NAME, "--", "x"],
    stdin: "bonjour\nexit\n",
    env: baseEnv({ TAIDO_TERMINAL_ID: TERMINAL }),
  });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 13), [
    "fake-claude started",
    "ARG:--session-id",
    "ARG:abc",
    "ARG:--name",
    `ARG:${NAME}`,
    "ARG:--",
    "ARG:x",
    `CWD:${r.cwd}`,
    `TERMINAL:${TERMINAL}`,
    "TOKEN:unset",
    "NESTED:no",
    "READY",
    "SESSION:abc",
  ]);
  assert.ok(lines.includes("GOT:bonjour"));

  const nested = await run({
    stdin: "/exit\n",
    env: { ...appEnv(), CLAUDECODE: "1" },
  });
  assert.equal(nested.code, 0);
  assert.match(nested.stdout, /^TOKEN:set$/m);
  assert.match(nested.stdout, /^NESTED:yes$/m);
});

test("a full session sends the hooks in order, shaped like the fixtures", async () => {
  const server = await startServer();
  const sessionId = crypto.randomUUID();
  try {
    const r = await run({
      args: ["--session-id", sessionId, "--name", NAME],
      settings: appSettings(server.port),
      script: ["Bonjour", "/q", "/e", "/n", "/clear", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    const pairs = Array(5).fill(["PreToolUse", "PostToolUse"]).flat();
    assert.deepEqual(names(server.events), [
      "SessionStart",
      "UserPromptSubmit",
      ...pairs,
      "Stop",
      "Stop",
      "StopFailure",
      "Notification",
      "SessionEnd",
      "SessionStart",
      "SessionEnd",
    ]);
    // Every request carries the token and the terminal id, the curl relay included.
    for (const e of server.events) {
      assert.equal(e.headers["x-app-token"], TOKEN, e.event);
      assert.equal(e.headers["x-terminal-id"], TERMINAL, e.event);
      assert.equal(e.url, "/hooks");
      assert.equal(e.payload.cwd, r.cwd);
    }
    const p = server.events.map((e) => e.payload);
    assertShape(p[0], "SessionStart-startup");
    assert.equal(p[0].source, "startup");
    assert.equal(p[0].session_title, NAME);
    assertShape(p[1], "UserPromptSubmit");
    assert.equal(p[1].prompt, "Bonjour");
    assert.equal(p[1].permission_mode, "default");
    for (let i = 2; i < 12; i += 2) {
      assertShape(p[i], "PreToolUse-Bash");
      assertShape(p[i + 1], "PostToolUse-Bash");
      assert.equal(p[i].tool_name, "Bash");
      assert.equal(p[i].tool_use_id, p[i + 1].tool_use_id);
      assert.equal(p[i].prompt_id, p[1].prompt_id);
    }
    assertShape(p[12], "Stop");
    assert.ok(p[12].last_assistant_message.length > 0);
    assertShape(p[13], "Stop-question");
    assert.match(p[13].last_assistant_message, /\?$/);
    assert.equal(p[14].error, "rate_limit");
    assertShape(p[15], "Notification-idle_prompt");
    assert.equal(p[15].notification_type, "idle_prompt");
    assertShape(p[16], "SessionEnd-clear");
    assert.equal(p[16].reason, "clear");
    assertShape(p[17], "SessionStart-clear");
    assert.equal(p[17].source, "clear");
    assertShape(p[18], "SessionEnd-prompt_input_exit");
    assert.equal(p[18].reason, "prompt_input_exit");

    // The same session until /clear, a new one after.
    for (const payload of p.slice(0, 17)) {
      assert.equal(payload.session_id, sessionId);
      assert.ok(payload.transcript_path.endsWith(`${sessionId}.jsonl`));
    }
    const fresh = p[17].session_id;
    assert.match(fresh, UUID);
    assert.notEqual(fresh, sessionId);
    assert.equal(p[18].session_id, fresh);
    assert.match(r.stdout, new RegExp(`^SESSION:${fresh}$`, "m"));
    assert.match(r.stdout, /^GOT:Bonjour$/m);
  } finally {
    await server.close();
  }
});

test("headers interpolate only the allowed environment variables", async () => {
  const server = await startServer();
  try {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "http",
                url: `http://127.0.0.1:${server.port}/hooks`,
                headers: {
                  "X-Allowed": "$ALLOWED_VAR",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} syntax under test
                  "X-Braced": "pre-${ALLOWED_VAR}-post",
                  "X-Secret": "$SECRET_VAR",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} syntax under test
                  "X-Mixed": "$ALLOWED_VAR/${SECRET_VAR}",
                },
                allowedEnvVars: ["ALLOWED_VAR"],
                timeout: 5,
              },
            ],
          },
        ],
      },
    };
    const r = await run({
      settings,
      script: ["/q"],
      env: baseEnv({ ALLOWED_VAR: "yes", SECRET_VAR: "leaked" }),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(names(server.events), ["Stop"]);
    const h = server.events[0].headers;
    assert.equal(h["x-allowed"], "yes");
    assert.equal(h["x-braced"], "pre-yes-post");
    assert.equal(h["x-secret"], "");
    assert.equal(h["x-mixed"], "yes/");
    assert.equal(h["content-type"], "application/json");
  } finally {
    await server.close();
  }
});

test("a permission allowed by the hook runs the tool", async () => {
  const server = await startServer((e) =>
    e.event === "PermissionRequest"
      ? {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        }
      : {},
  );
  try {
    const r = await run({
      settings: appSettings(server.port),
      script: ["/p", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(names(server.events), [
      "SessionStart",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]);
    const perm = server.events[2].payload;
    assertShape(perm, "PermissionRequest-Bash");
    assert.equal(perm.tool_use_id, undefined);
    assert.deepEqual(perm.tool_input, server.events[1].payload.tool_input);
    assert.match(r.stdout, /^Do you want to proceed\?$/m);
    assert.match(r.stdout, /^DECISION:\{"hookSpecificOutput".*"allow"/m);
    assert.match(r.stdout, /^Allowed by PermissionRequest hook$/m);
    // The fake never touches the working folder.
    assert.equal(fs.existsSync(path.join(r.cwd, "fake-claude.txt")), false);
  } finally {
    await server.close();
  }
});

test("a permission denied by the hook ends the turn without the tool", async () => {
  const server = await startServer((e) =>
    e.event === "PermissionRequest"
      ? {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny" },
          },
        }
      : {},
  );
  try {
    const r = await run({
      settings: appSettings(server.port),
      script: ["/p", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(names(server.events), [
      "SessionStart",
      "PreToolUse",
      "PermissionRequest",
      "Stop",
      "SessionEnd",
    ]);
    assertShape(server.events[3].payload, "Stop-after-deny");
    assert.match(r.stdout, /^Denied by PermissionRequest hook$/m);
  } finally {
    await server.close();
  }
});

test("`{}` lets the terminal answer the permission dialog", async () => {
  const server = await startServer();
  try {
    const r = await run({
      settings: appSettings(server.port),
      script: ["/p", "/wait 2000", "1", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(names(server.events), [
      "SessionStart",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]);
    const out = r.stdout;
    assert.ok(
      out.indexOf("DECISION:{}") > out.indexOf("Do you want to proceed?"),
    );
    assert.doesNotMatch(out, /by PermissionRequest hook/);
  } finally {
    await server.close();
  }
});

test("a terminal answer wins while the request is still held", async () => {
  const server = await startServer((e) =>
    e.event === "PermissionRequest" ? HANG : {},
  );
  try {
    const r = await run({
      settings: appSettings(server.port),
      script: ["/p", "y", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(names(server.events), [
      "SessionStart",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]);
    assert.doesNotMatch(r.stdout, /DECISION:/);
  } finally {
    await server.close();
  }
});

test("an unanswered permission sends the permission_prompt notification", async () => {
  const server = await startServer((e) =>
    e.event === "PermissionRequest" ? HANG : {},
  );
  try {
    // 6 s of fake time at speed 20 = 300 ms.
    const r = await run({
      settings: appSettings(server.port),
      script: ["/p", "/wait 8000", "/esc", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(names(server.events), [
      "SessionStart",
      "PreToolUse",
      "PermissionRequest",
      "Notification",
      "SessionEnd",
    ]);
    assertShape(server.events[3].payload, "Notification-permission_prompt");
    assert.match(r.stdout, /^Interrupted$/m);
  } finally {
    await server.close();
  }
});

test("Escape interrupts the turn without any hook", async () => {
  const server = await startServer();
  try {
    const r = await run({
      settings: appSettings(server.port),
      script: ["Bonjour", "/wait 1200", "\x1b", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    const seq = names(server.events);
    assert.equal(seq[0], "SessionStart");
    assert.equal(seq[1], "UserPromptSubmit");
    assert.equal(seq.at(-1), "SessionEnd");
    assert.ok(!seq.includes("Stop"), seq.join(","));
    assert.ok(seq.filter((e) => e === "PreToolUse").length < 5);
    assert.match(r.stdout, /^Interrupted$/m);
  } finally {
    await server.close();
  }
});

test("/x crashes with code 1 and no SessionEnd", async () => {
  const server = await startServer();
  try {
    const r = await run({
      settings: appSettings(server.port),
      script: ["/x", "/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 1);
    assert.deepEqual(names(server.events), ["SessionStart"]);
  } finally {
    await server.close();
  }
});

test("--resume starts with SessionStart(resume); a prompt argument starts a turn", async () => {
  const server = await startServer();
  const id = crypto.randomUUID();
  try {
    const r = await run({
      args: [
        "--resume",
        id,
        "--name",
        NAME,
        "--permission-mode",
        "acceptEdits",
        // The app prefixes a space to a prompt starting with "-".
        " -Réponds OK",
      ],
      settings: appSettings(server.port),
      script: ["/exit"],
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    const seq = names(server.events);
    assert.deepEqual(seq.slice(0, 2), ["SessionStart", "UserPromptSubmit"]);
    assert.deepEqual(seq.slice(-2), ["Stop", "SessionEnd"]);
    const start = server.events[0].payload;
    assertShape(start, "SessionStart-resume");
    assert.equal(start.source, "resume");
    assert.equal(start.session_id, id);
    const prompt = server.events[1].payload;
    assert.equal(prompt.prompt, "-Réponds OK");
    assert.equal(prompt.permission_mode, "acceptEdits");
    assert.ok(server.events.every((e) => e.payload.session_id === id));
  } finally {
    await server.close();
  }
});

test("matchers select the tool hooks", async () => {
  const server = await startServer();
  try {
    const hook = (which) => ({
      type: "http",
      url: `http://127.0.0.1:${server.port}/hooks?${which}`,
      timeout: 5,
    });
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: "Edit", hooks: [hook("edit")] },
          { matcher: "Bash|Read", hooks: [hook("bash")] },
          { hooks: [hook("all")] },
        ],
        Notification: [
          { matcher: "permission_prompt", hooks: [hook("perm")] },
          { matcher: "idle_prompt", hooks: [hook("idle")] },
        ],
      },
    };
    const r = await run({ settings, script: ["/n", "/p"] });
    assert.equal(r.code, 0, r.stderr);
    const urls = server.events.map((e) => e.url).sort();
    assert.deepEqual(urls, ["/hooks?all", "/hooks?bash", "/hooks?idle"]);
  } finally {
    await server.close();
  }
});

test("hook failures and timeouts do not block", async () => {
  const hanging = await startServer((e) =>
    e.event === "UserPromptSubmit" ? HANG : {},
  );
  const closed = await startServer();
  const closedPort = closed.port;
  await closed.close();
  try {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "exit 3" }] }],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "http",
                url: `http://127.0.0.1:${hanging.port}/hooks`,
                timeout: 1,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "http",
                url: `http://127.0.0.1:${closedPort}/hooks`,
                timeout: 5,
              },
              { type: "http", url: "not a url" },
              { type: "unknown" },
            ],
          },
        ],
      },
    };
    const r = await run({ settings, script: ["salut", "/exit"] });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^⏺ OK, c'est fait\.$/m);
    assert.ok(r.ms >= 1000, `${r.ms} ms: the 1 s timeout was honoured`);
    assert.ok(r.ms < 8000, `${r.ms} ms`);
    assert.deepEqual(names(hanging.events), ["UserPromptSubmit"]);
  } finally {
    await hanging.close();
  }
});

test("the command hook gets the payload on stdin", async () => {
  const dir = tempDir();
  const outFile = path.join(dir, "payload.json");
  const settings = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: `cat > '${outFile}'` }],
        },
      ],
    },
  };
  const r = await run({ settings, script: ["/exit"], cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(fs.readFileSync(outFile, "utf8"));
  assert.equal(payload.hook_event_name, "SessionStart");
  assert.equal(payload.source, "startup");
  assert.equal(payload.cwd, dir);
});

test("end of stdin acts like Ctrl+D", async () => {
  const server = await startServer();
  try {
    const r = await run({
      settings: appSettings(server.port),
      stdin: "/q\n",
      env: appEnv(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(names(server.events), [
      "SessionStart",
      "Stop",
      "SessionEnd",
    ]);
    assert.equal(server.events[2].payload.reason, "prompt_input_exit");
  } finally {
    await server.close();
  }
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

// Raw mode in a real PTY: echo, backspace, Escape alone, arrows ignored, Ctrl+D.
const PTY_DRIVER = `
import os, pty, select, sys, time
fake = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execv(fake, [fake, "--session-id", "s1"])
buf = b""
def read_for(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                d = os.read(fd, 4096)
            except OSError:
                return
            if not d:
                return
            buf += d
def until(needle, t=10):
    end = time.time() + t
    while needle not in buf and time.time() < end:
        read_for(0.05)
until(b"READY")
read_for(0.3)
os.write(fd, "bonjoux\\x7fr \\u00e9\\r".encode())
until(b"step 1")
os.write(fd, b"\\x1b")
until(b"Interrupted")
os.write(fd, b"\\x1b[A")
os.write(fd, b"\\x04")
read_for(1.0)
_, status = os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf-8", "replace"))
sys.stdout.write("\\nEXIT:%d\\n" % os.waitstatus_to_exitcode(status))
`;

test("in a terminal, raw input handles Escape and Ctrl+D", {
  skip: !hasPython || process.platform === "win32",
}, () => {
  const r = spawnSync("python3", ["-c", PTY_DRIVER, FAKE], {
    env: baseEnv({ TAIDO_FAKE_SPEED: "5" }),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.replaceAll("\r\n", "\n");
  assert.match(out, /^GOT:bonjour é$/m);
  assert.match(out, /^Interrupted$/m);
  assert.doesNotMatch(out, /OK, c'est fait/);
  assert.match(out, /^EXIT:0$/m);
});

test("/mcp calls a tool of the --mcp-config server like Claude Code", async () => {
  const server = await startServer(({ payload }) => {
    if (payload.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "todo", version: "0" },
        },
      };
    }
    if (payload.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: { content: [{ type: "text", text: "done" }], isError: false },
      };
    }
    return {};
  });
  try {
    const dir = tempDir();
    const config = path.join(dir, "claude-mcp.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          todo: {
            type: "http",
            url: `http://127.0.0.1:${server.port}/mcp`,
            headers: {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's ${VAR} syntax
              "X-App-Token": "${TAIDO_HOOK_TOKEN}",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's ${VAR} syntax
              "X-Terminal-Id": "${TAIDO_TERMINAL_ID}",
            },
          },
        },
      }),
    );
    const r = await run({
      args: ["--mcp-config", config],
      script: ['/mcp create_subtask {"title":"Acheter du pain"}', "/exit"],
      env: appEnv(),
      cwd: dir,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(
      !r.stdout.includes(`GOT:${config}`),
      "the file is not the prompt",
    );
    const mcp = server.events.filter((e) => e.url === "/mcp");
    assert.deepEqual(
      mcp.map((e) => e.payload.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
    for (const e of mcp) {
      assert.equal(e.headers["x-app-token"], TOKEN);
      assert.equal(e.headers["x-terminal-id"], TERMINAL);
    }
    assert.deepEqual(mcp[2].payload.params, {
      name: "create_subtask",
      arguments: { title: "Acheter du pain" },
    });
    assert.match(r.stdout, /MCP:.*"text":"done"/);
  } finally {
    await server.close();
  }
});

test("/mcp without --mcp-config prints an error and goes on", async () => {
  const r = await run({
    script: ["/mcp list_projects", "/exit"],
    env: appEnv(),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /MCP-ERROR:no --mcp-config server/);
});
