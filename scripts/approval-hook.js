#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

const INSTALL_DIR  = path.join(os.homedir(), '.cc-notify');
const RUNTIME_JSON = path.join(INSTALL_DIR, 'runtime.json');
const SERVER_JS    = path.join(INSTALL_DIR, 'approval-server.js');

const adapters = {
  claude: {
    buildAllowResponse() { return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }; },
    buildDenyResponse(message) { return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } }; },
    buildNoDecisionResponse() { return null; }
  },
  codex: {
    buildAllowResponse() { return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }; },
    buildDenyResponse(message) { return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } }; },
    buildNoDecisionResponse() { return null; }
  }
};

const REQUEST_TIMEOUT_MS = parseInt(process.env.CC_NOTIFY_APPROVAL_TIMEOUT_SECONDS || '480', 10) * 1000;
const STARTUP_TIMEOUT_MS = parseInt(process.env.CC_NOTIFY_APPROVAL_SERVER_STARTUP_TIMEOUT_MS || '3000', 10);

// Parse provider from CLI args
let provider = 'claude';
const codexIdx = process.argv.indexOf('--provider');
if (codexIdx >= 0 && process.argv[codexIdx + 1] === 'codex') provider = 'codex';
else if (process.argv.some(a => a.startsWith('--provider=codex'))) provider = 'codex';

const adapter = adapters[provider];
if (!adapter) { process.exit(1); }

let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdinData += chunk; });
process.stdin.on('end', () => {
  let hookPayload;
  try { hookPayload = JSON.parse(stdinData); } catch { process.exit(0); }
  const sessionId = hookPayload.session_id || hookPayload.sessionId || '';
  const toolName  = hookPayload.tool_name || '';
  const toolInput = hookPayload.tool_input || {};
  const cwd       = hookPayload.cwd || process.cwd();
  const permissionMode = hookPayload.permission_mode || 'default';
  ensureServerRunning(port => {
    if (!port) { emitNoDecision(); return; }
    postApproval(port, provider, sessionId, toolName, toolInput, cwd, permissionMode);
  });
});

function emitNoDecision() {
  const resp = adapter.buildNoDecisionResponse();
  if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  process.exit(0);
}

function emitDecision(decision, message) {
  let resp;
  if (decision === 'allow') resp = adapter.buildAllowResponse();
  else if (decision === 'deny') resp = adapter.buildDenyResponse(message);
  else { emitNoDecision(); return; }
  if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  process.exit(0);
}

function readRuntime() {
  try {
    const raw = fs.readFileSync(RUNTIME_JSON, 'utf8');
    const data = JSON.parse(raw);
    if (data.error || !data.port || !data.pid) return null;
    try { process.kill(data.pid, 0); } catch { return null; }
    return data;
  } catch { return null; }
}

function ensureServerRunning(cb) {
  const runtime = readRuntime();
  if (runtime) {
    httpGet(runtime.port, '/state', 500, (err, body) => {
      if (!err) {
        try { const s = JSON.parse(body); if (s.server === 'cc-notify-approval') { cb(runtime.port); return; } } catch {}
      }
      startServer(cb);
    });
    return;
  }
  startServer(cb);
}

function startServer(cb) {
  if (!fs.existsSync(SERVER_JS)) { cb(null); return; }
  cp.spawn(process.execPath, [SERVER_JS], { detached: true, stdio: 'ignore' }).unref();
  const start = Date.now();
  const poll = setInterval(() => {
    const rt = readRuntime();
    if (rt) { clearInterval(poll); cb(rt.port); return; }
    if (Date.now() - start > STARTUP_TIMEOUT_MS) { clearInterval(poll); cb(null); }
  }, 100);
}

function httpGet(port, path, timeoutMs, cb) {
  const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => cb(null, data));
  });
  req.on('error', err => cb(err));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.end();
}

function postApproval(port, provider, sessionId, toolName, toolInput, cwd, permissionMode) {
  const body = JSON.stringify({ provider, sessionId, toolName, toolInput, cwd, permissionMode });
  const req = http.request({
    hostname: '127.0.0.1', port, path: '/approval', method: 'POST',
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => { try { const r = JSON.parse(data); emitDecision(r.decision, r.message); } catch { emitNoDecision(); } });
  });
  req.on('error', () => { emitNoDecision(); });
  req.on('timeout', () => { req.destroy(); emitNoDecision(); });

  // When the user approves in the terminal instead of clicking the sticky
  // note buttons, CC may close stdout (the pipe CC reads from) or send
  // SIGTERM to this process.  Detect these signals and abort the HTTP
  // request — this closes the TCP connection to approval-server, which
  // triggers res.on('close') and immmediately restores the sticky note
  // without waiting for PostToolUse or Stop hooks.
  function abortRequest() {
    if (aborted) return;
    aborted = true;
    try { req.destroy(); } catch (_) {}
  }
  let aborted = false;

  // stdout pipe broken: CC has stopped reading our output (user already
  // decided in the terminal).  This is the fastest and most reliable signal
  // for command-type hooks.
  process.stdout.on('error', () => abortRequest());

  // CC may send SIGTERM to clean up hooks it no longer needs.
  process.on('SIGTERM', () => { abortRequest(); process.exit(0); });

  req.write(body);
  req.end();
}
