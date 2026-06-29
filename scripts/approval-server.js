#!/usr/bin/env node
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const cp     = require('child_process');
const crypto = require('crypto');

const INSTALL_DIR    = path.join(os.homedir(), '.cc-notify');
const RUNTIME_JSON   = path.join(INSTALL_DIR, 'runtime.json');

let SERVER_VERSION = 'unknown';
try {
  // When running from repo (dev): ../package.json
  SERVER_VERSION = require(path.join(__dirname, '..', 'package.json')).version;
} catch {
  try {
    // When running from ~/.cc-notify/ (installed): read .version
    SERVER_VERSION = fs.readFileSync(path.join(INSTALL_DIR, '.version'), 'utf8').trim();
  } catch {}
}

const TMP_DIR        = '/tmp/cc-notify';

const APPROVAL_TIMEOUT_MS = parseInt(process.env.CC_NOTIFY_APPROVAL_TIMEOUT_SECONDS || '480', 10) * 1000;
const IDLE_TIMEOUT_MS     = parseInt(process.env.CC_NOTIFY_APPROVAL_IDLE_TIMEOUT_MINUTES || '30', 10) * 60 * 1000;
const PORT_START          = parseInt(process.env.CC_NOTIFY_APPROVAL_PORT_RANGE_START || '23333', 10);
const PORT_END            = parseInt(process.env.CC_NOTIFY_APPROVAL_PORT_RANGE_END || '23337', 10);
const MAX_PENDING         = 10;
const SERVER_NAME         = 'cc-notify-approval';

function findAvailablePort(start, end) {
  const net = require('net');
  for (let port = start; port <= end; port++) {
    try {
      const s = net.createServer();
      s.listen(port, '127.0.0.1');
      s.close();
      return port;
    } catch (_) {}
  }
  return null;
}

const state = { pendingRequests: new Map(), sessionRules: new Map(), startedAt: Date.now(), lastActivityAt: Date.now(), idleTimer: null };

function matchAlwaysRule(provider, sessionId, toolName) {
  const key = `${provider}:${sessionId}`;
  const rules = state.sessionRules.get(key);
  if (!rules) return null;
  if (rules.has('*')) return { decision: rules.get('*'), reason: 'always_allow:session_wildcard' };
  if (rules.has(toolName)) return { decision: rules.get(toolName), reason: `always_allow:session_tool:${toolName}` };
  return null;
}

function setAlwaysRule(provider, sessionId, matchKey, decision) {
  const key = `${provider}:${sessionId}`;
  if (!state.sessionRules.has(key)) state.sessionRules.set(key, new Map());
  state.sessionRules.get(key).set(matchKey, decision);
}

function generateRequestId() {
  return 'appr_' + crypto.randomBytes(6).toString('hex');
}

function buildSummary(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return `${toolName}`;
  if (toolName === 'Bash' && toolInput.command) return `Command: ${toolInput.command}`;
  const keys = Object.keys(toolInput);
  if (keys.length === 1) return `${toolName}: ${JSON.stringify(toolInput[keys[0]])}`;
  return `${toolName}: ${keys.join(', ')}`;
}

function isCodexTempCwd(provider, cwd) {
  if (provider !== 'codex' || !cwd) return false;
  const normalized = String(cwd).replace(/\\/g, '/');
  const codexScratchRe = new RegExp(`^${escapeRegExp(os.homedir().replace(/\\/g, '/'))}/Documents/Codex/\\d{4}-\\d{2}-\\d{2}/[^/]+$`);
  if (!normalized.startsWith('/tmp/') &&
      !normalized.startsWith('/private/tmp/') &&
      !normalized.startsWith('/var/folders/') &&
      !normalized.startsWith('/private/var/folders/') &&
      !codexScratchRe.test(normalized)) return false;
  return /^[A-Za-z0-9_-]{1,16}$/.test(path.basename(normalized));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveProjectName(provider, sessionId, cwd) {
  const fallback = path.basename(cwd || process.cwd());
  if (!isCodexTempCwd(provider, cwd || process.cwd())) return fallback;
  const projectFile = path.join(TMP_DIR, `${provider}-${sessionId}.project`);
  try {
    const saved = fs.readFileSync(projectFile, 'utf8').trim();
    if (saved) return saved;
  } catch (_) {}
  return '会话';
}

function writeApprovalFiles(provider, sessionId, requestId, toolName, toolInput, cwd, serverPort, toolUseId) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // Normalize sessionId the same way notify.sh does: strip non-alphanumeric chars,
  // then take first 16 characters. This ensures both use the same content file path.
  const normalizedSessionId = (sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'default';
  const projectName = resolveProjectName(provider, normalizedSessionId, cwd);
  const contentFile = path.join(TMP_DIR, `${provider}-${normalizedSessionId}.txt`);
  const approvalFile = contentFile.replace(/\.txt$/, '.approval.json');
  const summary = buildSummary(toolName, toolInput);
  const lines = ['__APPROVAL__', '__STATE__:approval', `Project: ${projectName}`];
  fs.writeFileSync(contentFile, lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(approvalFile, JSON.stringify({ type: 'approval', requestId, provider, sessionId, toolName, toolUseId: toolUseId || null, summary, detail: toolInput || {}, decisionEndpoint: `http://127.0.0.1:${serverPort}/decision`, createdAt: new Date().toISOString(), allowAlwaysScope: 'session' }, null, 2) + '\n', 'utf8');
  return { contentFile, approvalFile };
}

function updateContentFile(contentFile, text) {
  try { fs.writeFileSync(contentFile, text + '\n', 'utf8'); } catch (_) {}
}

function cleanupApprovalFiles(approvalFile) {
  try { fs.unlinkSync(approvalFile); } catch (_) {}
}

function launchSwiftWindow(contentFile) {
  const swiftApp = path.join(INSTALL_DIR, 'sticky-notify.app', 'Contents', 'MacOS', 'sticky-notify-app');
  if (!fs.existsSync(swiftApp)) return;
  const pidFile = contentFile.replace(/\.txt$/, '.pid');
  if (fs.existsSync(pidFile)) {
    try { const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); if (pid > 0) { try { process.kill(pid, 0); return; } catch (_) {} } } catch (_) {}
  }
  cp.spawn(swiftApp, [contentFile], { detached: true, stdio: 'ignore' }).unref();
}

function resetIdleTimer() {
  state.lastActivityAt = Date.now();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => { cleanup(); process.exit(0); }, IDLE_TIMEOUT_MS);
}

function cleanup() {
  for (const [id, req] of state.pendingRequests) {
    if (req.response && !req.response.writableEnded) {
      try { req.response.writeHead(200, { 'Content-Type': 'application/json' }); req.response.end(JSON.stringify({ decision: 'no_decision', reason: 'server_shutdown' })); } catch (_) {}
    }
  }
  state.pendingRequests.clear();
  state.sessionRules.clear();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  try { fs.unlinkSync(RUNTIME_JSON); } catch (_) {}
}

function handleDecision(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'invalid JSON' })); return; }
    const { requestId, decision, message } = parsed;
    if (!requestId || !decision) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing requestId or decision' })); return; }
    const pending = state.pendingRequests.get(requestId);
    if (!pending) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'request not found' })); return; }
    if (pending.status !== 'pending') { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: `request already ${pending.status}` })); return; }
    pending.status = 'decided';
    let finalDecision = decision;
    if (decision === 'allow_always') { setAlwaysRule(pending.provider, pending.sessionId, pending.toolName, 'allow'); finalDecision = 'allow'; }
    pending.decision = finalDecision;
    pending.message = message || null;
    if (pending.response && !pending.response.writableEnded) {
      const respBody = finalDecision === 'deny' ? { decision: 'deny', message: pending.message || 'Denied from cc-notify' } : { decision: finalDecision };
      pending.response.writeHead(200, { 'Content-Type': 'application/json' });
      pending.response.end(JSON.stringify(respBody));
    }
    const statusText = finalDecision === 'deny' ? '🚫 Denied' : '✅ Approved';
    if (pending.contentFile) updateContentFile(pending.contentFile, statusText);
    if (pending.approvalFile) cleanupApprovalFiles(pending.approvalFile);
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    resetIdleTimer();
  });
}

function handleApproval(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ decision: 'no_decision', reason: 'invalid JSON' })); return; }
    const { provider, sessionId, toolName, toolInput, cwd, toolUseId } = parsed;
    if (state.pendingRequests.size >= MAX_PENDING) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ decision: 'no_decision', reason: 'too_many_pending' })); return; }
    const sessionKey = (sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'default';
    const alwaysMatch = matchAlwaysRule(provider, sessionKey, toolName);
    if (alwaysMatch) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ decision: alwaysMatch.decision, reason: alwaysMatch.reason })); return; }
    const requestId = generateRequestId();
    const projectName = resolveProjectName(provider, sessionKey, cwd);
    const { contentFile, approvalFile } = writeApprovalFiles(provider, sessionKey, requestId, toolName, toolInput, cwd, state.port, toolUseId);
    launchSwiftWindow(contentFile);
    const timeoutId = setTimeout(() => {
      const p = state.pendingRequests.get(requestId);
      if (p && p.status === 'pending') {
        p.status = 'timeout';
        if (p.response && !p.response.writableEnded) { p.response.writeHead(200, { 'Content-Type': 'application/json' }); p.response.end(JSON.stringify({ decision: 'no_decision', reason: 'timeout' })); }
        updateContentFile(p.contentFile, '⏰ Approval timeout — returned to native approval');
        cleanupApprovalFiles(p.approvalFile);
        state.pendingRequests.delete(requestId);
      }
    }, APPROVAL_TIMEOUT_MS);
    state.pendingRequests.set(requestId, { id: requestId, provider, sessionId: sessionKey, toolName, toolUseId: toolUseId || null, status: 'pending', decision: null, message: null, response: res, contentFile, approvalFile, timeoutId, projectName, createdAt: Date.now() });

    // When the user approves in the terminal instead of clicking the sticky
    // note buttons, Claude Code may kill the approval-hook.js process, which
    // closes this HTTP connection.  Detect the close and clean up so the
    // sticky note can recover.
    //
    // IMPORTANT: listen on res.on('close'), NOT req.on('close').
    // req (IncomingMessage/Readable stream) emits 'close' immediately after
    // 'end' when the request body is fully consumed, even though the socket
    // is still open (keep-alive).  res (ServerResponse/Writable stream) only
    // emits 'close' when the underlying connection is actually terminated.
    res.on('close', () => {
      const pending = state.pendingRequests.get(requestId);
      if (pending && pending.status === 'pending') {
        pending.status = 'cancelled';
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        const projectLine = pending.projectName ? `Project: ${pending.projectName}` : '';
        updateContentFile(pending.contentFile, `__STATE__:working\n${projectLine}`.trim());
        cleanupApprovalFiles(pending.approvalFile);
        state.pendingRequests.delete(requestId);
      }
    });

    resetIdleTimer();
  });
}

function handleState(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-cc-notify-server': SERVER_NAME });
  res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, pendingCount: state.pendingRequests.size, uptime: Math.floor((Date.now() - state.startedAt) / 1000) }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const port = findAvailablePort(PORT_START, PORT_END);
if (!port) {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_JSON, JSON.stringify({ error: 'no_available_port', range: [PORT_START, PORT_END], at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  process.exit(1);
}
fs.mkdirSync(INSTALL_DIR, { recursive: true });
fs.writeFileSync(RUNTIME_JSON, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), server: SERVER_NAME, version: SERVER_VERSION }, null, 2) + '\n', 'utf8');
state.port = port;
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => { process.stderr.write(`[approval-server] uncaught: ${err.message}\n`); cleanup(); process.exit(1); });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/state') handleState(req, res);
  else if (req.method === 'POST' && url.pathname === '/approval') handleApproval(req, res);
  else if (req.method === 'POST' && url.pathname === '/decision') handleDecision(req, res);
  else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not found' })); }
});
server.listen(port, '127.0.0.1', () => { resetIdleTimer(); });
