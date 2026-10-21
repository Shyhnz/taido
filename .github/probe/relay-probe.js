// Throwaway probe: runs hook relays the way Codex runs `command_windows`, under each shell.
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const OLD_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$body = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
try {
  Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 -Uri $env:TAIDO_HOOK_URL \`
    -ContentType 'application/json' -Body $body \`
    -Headers @{ 'X-App-Token' = $env:TAIDO_HOOK_TOKEN; 'X-Terminal-Id' = $env:TAIDO_TERMINAL_ID } |
    Out-Null
} catch {}
exit 0`;
const OLD = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(OLD_SCRIPT, "utf16le").toString("base64")}`;
const CURL = path.join(process.env.SystemRoot, "System32", "curl.exe");
const NEW = `${CURL} -s -m 2 -o NUL --variable %TAIDO_HOOK_URL --variable %TAIDO_HOOK_TOKEN --variable %TAIDO_TERMINAL_ID -H "Content-Type: application/json" --expand-header "X-App-Token: {{TAIDO_HOOK_TOKEN}}" --expand-header "X-Terminal-Id: {{TAIDO_TERMINAL_ID}}" --data-binary "@-" --expand-url "{{TAIDO_HOOK_URL}}"`;

console.log(spawnSync(CURL, ["--version"], { encoding: "utf8" }).stdout.split("\n")[0]);
const pwsh = spawnSync("where.exe", ["pwsh"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0];
console.log("pwsh:", pwsh, "COMSPEC:", process.env.COMSPEC);

const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({ at: Date.now(), headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), url: req.url });
    res.end("{}");
  });
});

function shellSpawn(shell, cmd, env) {
  const opts = { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  if (shell === "cmd") return spawn(process.env.COMSPEC, ["/C", `"${cmd}"`], { ...opts, windowsVerbatimArguments: true });
  if (shell === "pwsh") return spawn(pwsh, ["-NoProfile", "-Command", cmd], opts);
  return spawn("powershell.exe", ["-NoProfile", "-Command", cmd], opts);
}

function run(shell, cmd, port, n) {
  const id = `term-${shell}-${n}`;
  const env = { ...process.env, TAIDO_HOOK_URL: `http://127.0.0.1:${port}/hooks`, TAIDO_HOOK_TOKEN: "tok en%x", TAIDO_TERMINAL_ID: id };
  const payload = JSON.stringify({ hook_event_name: "Stop", text: "é ü 日本 \"q\" %PATH% $env:X" });
  return new Promise((resolve) => {
    const start = Date.now();
    const child = shellSpawn(shell, cmd, env);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      setTimeout(() => {
        const got = received.find((r) => r.headers["x-terminal-id"] === id);
        const ok = got && got.body === payload && got.headers["x-app-token"] === "tok en%x" && got.headers["content-type"] === "application/json" && got.url === "/hooks";
        resolve({ ms: Date.now() - start - 50, code, ok: !!ok, out: out.trim().slice(0, 300), got: ok ? undefined : got });
      }, 50);
    });
    child.stdin.end(payload);
  });
}

async function series(label) {
  const port = server.address().port;
  for (const [name, cmd] of [["new", NEW], ["old", OLD]]) {
    for (const shell of ["cmd", "pwsh", "powershell"]) {
      const results = [];
      for (let i = 0; i < 6; i++) results.push(await run(shell, cmd, port, `${label}-${name}-${i}`));
      const ms = results.map((r) => r.ms);
      console.log(`${label} ${name} via ${shell}: ok=${results.filter((r) => r.ok).length}/6 codes=${results.map((r) => r.code).join(",")} ms=${ms.join(",")}`);
      for (const r of results.filter((r) => !r.ok)) console.log("  FAIL", JSON.stringify(r));
    }
  }
}

server.listen(0, "127.0.0.1", async () => {
  await series("idle");
  const busy = [];
  for (let i = 0; i < 8; i++) busy.push(spawn(process.execPath, ["-e", "for(;;){}"]));
  await series("load");
  for (const b of busy) b.kill();
  server.close();
});
