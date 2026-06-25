# cc-notify 审批操作实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cc-notify 的 macOS 浮动便签支持 Allow / Deny / Allow Always 审批操作，决策结果回传给 Claude Code / Codex。

**Architecture:** 新增 `approval-hook.js`（阻塞型 hook wrapper）和 `approval-server.js`（本地审批 HTTP 中枢），扩展 `sticky-window.swift` 增加审批 UI 模式。审批失败或超时一律 fallback 原生审批，不静默放行或误拒绝。

**Tech Stack:** Node.js built-ins (http/https/fs/path/cp), Swift/AppKit, Bash, 无第三方运行时依赖。

**Source spec:** `docs/superpowers/specs/2026-06-25-approval-mechanism-design.md`

## Global Constraints

- macOS-only (`os.platform() !== 'darwin'` → skip)
- 无第三方 npm 依赖（仅 Node.js built-ins）
- hooks 指向稳定路径 `~/.cc-notify/`
- Claude Code / Codex 状态互相隔离
- 审批失败时回退原生审批（默认 no_decision）
- Allow Always 仅当前 session 内生效（不持久化）
- 所有文件使用 CommonJS (`'use strict'`)，匹配现有风格

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `scripts/approval-hook.js` | **新增** | 阻塞型 hook wrapper：读 stdin → 调审批服务 → stdout 输出决策 |
| `scripts/approval-server.js` | **新增** | 本地审批中枢 HTTP server：pending requests、Allow Always、写 .txt + .approval.json |
| `scripts/sticky-window.swift` | **修改** | 新增审批 UI 模式：__APPROVAL__ 哨兵、Allow/Deny/Always 按钮、POST /decision |
| `lib/utils.js` | **修改** | 新增 runtime.json 路径、Codex hooks 兼容 `hooks = true`、provider adapter |
| `lib/commands/init.js` | **修改** | Codex PermissionRequest 从 notify.sh --urgent 替换为 approval-hook.js |
| `lib/commands/status.js` | **修改** | 新增审批组件检查、Codex hooks 字段兼容 |
| `lib/commands/uninit.js` | **修改** | 审批 hook 清理由现有 isCcNotifyCommand 逻辑自动覆盖，无需额外改动（验证即可） |
| `lib/commands/set.js` | 不动 | 现有通用 key=value 机制自动支持 `approval.*` 配置 |
| `scripts/postinstall.js` | **修改** | 复制 approval-hook.js 和 approval-server.js 到 ~/.cc-notify/ |
| `bin/ccn.js` | 不动 | 命令行分发无需改动 |

---
```

Now let me write each task with precise code and steps.<｜end▁of▁thinking｜>### Task 1: 新增 `lib/utils.js` — 审批路径、Codex 兼容、provider adapter

**Files:**
- Modify: `lib/utils.js`

**Interfaces:**
- Consumes: (none — base utilities)
- Produces:
  - `APPROVAL_HOOK_JS` (string) — `~/.cc-notify/approval-hook.js`
  - `APPROVAL_SERVER_JS` (string) — `~/.cc-notify/approval-server.js`
  - `RUNTIME_JSON` (string) — `~/.cc-notify/runtime.json`
  - `adapters` (object) — `{ claude: { buildAllowResponse, buildDenyResponse, buildNoDecisionResponse }, codex: { ... } }`
  - `isCodexHooksFeatureEnabled(content)` — 更新：兼容 `hooks = true` 和 `codex_hooks = true`
  - `ensureCodexHooksFeature(content)` — 更新：优先写 `hooks = true`

- [ ] **Step 1: 新增审批路径常量**

在 `lib/utils.js` 的路径常量区域（`CODEX_CONFIG_TOML` 定义之后）新增：

```js
// Approval service paths
const APPROVAL_HOOK_JS  = path.join(INSTALL_DIR, 'approval-hook.js');
const APPROVAL_SERVER_JS = path.join(INSTALL_DIR, 'approval-server.js');
const RUNTIME_JSON      = path.join(INSTALL_DIR, 'runtime.json');
```

- [ ] **Step 2: 新增 provider adapter 模块**

在 ENV_KEY_MAP 定义之后、readSettings 之前新增：

```js
// ─── Provider adapters ─────────────────────────────────────────────────────────
// Isolate Claude Code / Codex wire-format differences.
// Internal model: { decision: "allow"|"deny"|"no_decision", message?: string }

const adapters = {
  claude: {
    buildAllowResponse() {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' }
        }
      };
    },
    buildDenyResponse(message) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: message || 'Denied from cc-notify'
          }
        }
      };
    },
    buildNoDecisionResponse() {
      // Claude Code: empty stdout + exit 0 → native approval fallback
      return null;
    }
  },
  codex: {
    buildAllowResponse() {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' }
        }
      };
    },
    buildDenyResponse(message) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: message || 'Denied from cc-notify'
          }
        }
      };
    },
    buildNoDecisionResponse() {
      // Codex: empty stdout + exit 0; if empty is not accepted, adjust here
      return null;
    }
  }
};
```

- [ ] **Step 3: 更新 `isCodexHooksFeatureEnabled` — 兼容 `hooks = true`**

将现有函数替换为同时检查新老字段的版本：

```js
function isCodexHooksFeatureEnabled(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let inFeatures = false;

  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inFeatures = /^\s*\[features\]\s*$/.test(line);
      continue;
    }
    if (inFeatures) {
      if (/^\s*codex_hooks\s*=\s*true\s*(?:#.*)?$/i.test(line)) return true;
      if (/^\s*hooks\s*=\s*true\s*(?:#.*)?$/i.test(line)) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: 更新 `ensureCodexHooksFeature` — 优先写 `hooks = true`**

将现有函数替换为优先写新版字段的版本：

```js
function ensureCodexHooksFeature(content) {
  const lines = content ? content.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[features\]\s*$/.test(lines[i])) {
      featuresStart = i;
      break;
    }
  }

  if (featuresStart >= 0) {
    for (let i = featuresStart + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) {
        featuresEnd = i;
        break;
      }
    }

    // Check for existing hooks or codex_hooks
    for (let i = featuresStart + 1; i < featuresEnd; i++) {
      if (/^\s*(codex_hooks|hooks)\s*=/.test(lines[i])) {
        lines[i] = lines[i].replace(/^(\s*)(codex_hooks|hooks)\s*=.*$/, '$1hooks = true');
        return lines.join('\n') + '\n';
      }
    }

    lines.splice(featuresEnd, 0, 'hooks = true');
    return lines.join('\n') + '\n';
  }

  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.push('');
  }
  lines.push('[features]', 'hooks = true');
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 5: 更新 `module.exports`**

新增 exports：

```js
module.exports = {
  // ... existing exports ...
  APPROVAL_HOOK_JS,
  APPROVAL_SERVER_JS,
  RUNTIME_JSON,
  adapters,
  // ... rest of existing exports ...
};
```

- [ ] **Step 6: 验证语法**

```bash
node -e "const u = require('./lib/utils'); console.log('APPROVAL_HOOK_JS:', u.APPROVAL_HOOK_JS); console.log('APPROVAL_SERVER_JS:', u.APPROVAL_SERVER_JS); console.log('RUNTIME_JSON:', u.RUNTIME_JSON); console.log('adapters:', Object.keys(u.adapters));"
```

Expected: 不报错，打印路径和 `adapters: [ 'claude', 'codex' ]`。

- [ ] **Step 7: 验证 Codex 兼容**

```bash
node -e "
const u = require('./lib/utils');
// 新版格式
console.log('hooks=true detected:', u.isCodexHooksFeatureEnabled('[features]\nhooks = true'));
// 旧版格式
console.log('codex_hooks=true detected:', u.isCodexHooksFeatureEnabled('[features]\ncodex_hooks = true'));
// 未启用
console.log('none detected:', u.isCodexHooksFeatureEnabled('[features]\nsomething_else = true'));
// ensureCodexHooksFeature 新文件
console.log('ensure new toml:', u.ensureCodexHooksFeature('[features]\nfoo = bar'));
// ensureCodexHooksFeature 已有旧字段
console.log('ensure migrate old:', u.ensureCodexHooksFeature('[features]\ncodex_hooks = false'));
"
```

Expected: `true true false` 以及正确的 TOML 输出。

- [ ] **Step 8: Commit**

```bash
git add lib/utils.js
git commit -m "feat: add approval paths, provider adapters, Codex hooks compatibility"
```

---

### Task 2: 新增 `scripts/approval-server.js` — 本地审批中枢

**Files:**
- Create: `scripts/approval-server.js`

**Interfaces:**
- Consumes: `adapters` from `../lib/utils.js`（运行时 require）
- Produces: HTTP server on 127.0.0.1 DPORT → `GET /state`, `POST /approval`, `POST /decision`
- Produces: `~/.cc-notify/runtime.json` → `{ pid, port, startedAt, server, version }`
- Produces: `/tmp/cc-notify/<provider-session>.txt` + `.approval.json`

- [ ] **Step 1: 创建文件骨架**

```js
#!/usr/bin/env node
'use strict';

/**
 * cc-notify approval server
 *
 * Local HTTP server that acts as the approval hub:
 *   - Receives PermissionRequest contexts from approval-hook.js
 *   - Writes content files for Swift sticky window
 *   - Waits for user decision (Allow / Deny / Allow Always) via POST /decision
 *   - Resolves the pending request with the decision
 *
 * Lifecycle:
 *   - Started on-demand by approval-hook.js
 *   - Idle timeout: 30 minutes (configurable via CC_NOTIFY_APPROVAL_IDLE_TIMEOUT_MINUTES)
 *   - Auto-exits when idle timer fires
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const cp     = require('child_process');
const crypto = require('crypto');
```

- [ ] **Step 2: 定义路径和配置**

```js
// ─── Paths ────────────────────────────────────────────────────────────────────
const INSTALL_DIR    = path.join(os.homedir(), '.cc-notify');
const RUNTIME_JSON   = path.join(INSTALL_DIR, 'runtime.json');
const NOTIFY_SH      = path.join(INSTALL_DIR, 'notify.sh');
const ENV_SH         = path.join(INSTALL_DIR, 'env.sh');
const PKG_JSON       = require(path.join(__dirname, '..', 'package.json'));

const TMP_DIR        = '/tmp/cc-notify';

// ─── Config (env vars with defaults) ──────────────────────────────────────────
const APPROVAL_TIMEOUT_MS = parseInt(process.env.CC_NOTIFY_APPROVAL_TIMEOUT_SECONDS || '480', 10) * 1000;
const IDLE_TIMEOUT_MS     = parseInt(process.env.CC_NOTIFY_APPROVAL_IDLE_TIMEOUT_MINUTES || '30', 10) * 60 * 1000;
const PORT_START          = parseInt(process.env.CC_NOTIFY_APPROVAL_PORT_RANGE_START || '23333', 10);
const PORT_END            = parseInt(process.env.CC_NOTIFY_APPROVAL_PORT_RANGE_END || '23337', 10);
const MAX_PENDING         = 10;
const SERVER_NAME         = 'cc-notify-approval';
const SERVER_VERSION      = PKG_JSON.version;
```

- [ ] **Step 3: 实现端口探测**

```js
function findAvailablePort(start, end) {
  const net = require('net');
  for (let port = start; port <= end; port++) {
    try {
      const server = net.createServer();
      server.listen(port, '127.0.0.1');
      server.close();
      return port;
    } catch (_) {
      // Port in use, try next
    }
  }
  return null;
}
```

- [ ] **Step 4: 实现运行时状态**

```js
const state = {
  pendingRequests: new Map(),
  // sessionRules: { "<provider>:<sessionId>": Map<matchKey, decision> }
  // matchKey: "*"  or toolName like "Bash"
  sessionRules: new Map(),
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  idleTimer: null,
};
```

- [ ] **Step 5: 实现 Allow Always 规则匹配**

```js
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
  if (!state.sessionRules.has(key)) {
    state.sessionRules.set(key, new Map());
  }
  state.sessionRules.get(key).set(matchKey, decision);
}
```

- [ ] **Step 6: 实现便签内容写入**

```js
function writeApprovalFiles(provider, sessionId, requestId, toolName, toolInput, cwd, serverPort) {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const projectName = path.basename(cwd || process.cwd());
  const contentFile = path.join(TMP_DIR, `${provider}-${sessionId.slice(0, 16)}.txt`);
  const approvalFile = contentFile.replace(/\.txt$/, '.approval.json');

  // Build summary from toolInput
  const summary = buildSummary(toolName, toolInput);

  // Write .txt for Swift
  const lines = [
    '__APPROVAL__',
    `🔐 ${provider === 'claude' ? 'Claude Code' : 'Codex'} Approval`,
    `Tool: ${toolName}`,
    `Summary: ${summary}`,
    `Project: ${projectName}`,
  ];
  fs.writeFileSync(contentFile, lines.join('\n') + '\n', 'utf8');

  // Write .approval.json for Swift detail rendering
  fs.writeFileSync(approvalFile, JSON.stringify({
    type: 'approval',
    requestId: requestId,
    provider: provider,
    sessionId: sessionId,
    toolName: toolName,
    summary: summary,
    detail: toolInput || {},
    decisionEndpoint: `http://127.0.0.1:${serverPort}/decision`,
    createdAt: new Date().toISOString(),
    allowAlwaysScope: 'session',
  }, null, 2) + '\n', 'utf8');

  return { contentFile, approvalFile };
}

function buildSummary(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return `${toolName}`;
  if (toolName === 'Bash' && toolInput.command) {
    return `Command: ${toolInput.command}`;
  }
  const keys = Object.keys(toolInput);
  if (keys.length === 1) return `${toolName}: ${JSON.stringify(toolInput[keys[0]])}`;
  return `${toolName}: ${keys.join(', ')}`;
}

function updateContentFile(contentFile, text) {
  try {
    fs.writeFileSync(contentFile, text + '\n', 'utf8');
  } catch (_) {
    // Best-effort
  }
}

function cleanupApprovalFiles(approvalFile) {
  try { fs.unlinkSync(approvalFile); } catch (_) {}
}
```

- [ ] **Step 7: 实现生成唯一 ID**

```js
function generateRequestId() {
  return 'appr_' + crypto.randomBytes(6).toString('hex');
}
```

- [ ] **Step 8: 实现启动/复用 Swift 窗口**

```js
function launchSwiftWindow(contentFile) {
  const swiftApp = path.join(INSTALL_DIR, 'sticky-notify.app', 'Contents', 'MacOS', 'sticky-notify-app');
  if (!fs.existsSync(swiftApp)) return;

  // Check if a Swift window is already running for this content file
  const pidFile = contentFile.replace(/\.txt$/, '.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid > 0) {
        try { process.kill(pid, 0); return; } catch (_) {}
      }
    } catch (_) {}
  }

  // Launch new Swift window
  cp.spawn(swiftApp, [contentFile], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}
```

- [ ] **Step 9: 实现空闲超时**

```js
function resetIdleTimer() {
  state.lastActivityAt = Date.now();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    cleanup();
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}
```

- [ ] **Step 10: 实现清理函数**

```js
function cleanup() {
  // Remove all pending requests
  for (const [id, req] of state.pendingRequests) {
    if (req.response && !req.response.writableEnded) {
      try {
        req.response.writeHead(200, { 'Content-Type': 'application/json' });
        req.response.end(JSON.stringify({ decision: 'no_decision', reason: 'server_shutdown' }));
      } catch (_) {}
    }
  }
  state.pendingRequests.clear();
  state.sessionRules.clear();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  try { fs.unlinkSync(RUNTIME_JSON); } catch (_) {}
}
```

- [ ] **Step 11: 实现 POST /decision 路由**

```js
function handleDecision(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      return;
    }

    const { requestId, decision, message } = parsed;

    if (!requestId || !decision) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing requestId or decision' }));
      return;
    }

    const pending = state.pendingRequests.get(requestId);
    if (!pending) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'request not found' }));
      return;
    }

    if (pending.status !== 'pending') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `request already ${pending.status}` }));
      return;
    }

    // Apply decision
    pending.status = 'decided';
    pending.decision = decision;
    pending.message = message || null;

    // Handle allow_always
    if (decision === 'allow_always') {
      setAlwaysRule(pending.provider, pending.sessionId, pending.toolName, 'allow');
      // The actual decision for this request is still "allow"
      pending.decision = 'allow';
    }

    // Resolve the pending HTTP response
    if (pending.response && !pending.response.writableEnded) {
      const respBody = decision === 'deny'
        ? { decision: 'deny', message: pending.message || 'Denied from cc-notify' }
        : { decision: pending.decision };
      pending.response.writeHead(200, { 'Content-Type': 'application/json' });
      pending.response.end(JSON.stringify(respBody));
    }

    // Update content file for Swift UI
    const statusText = decision === 'deny' ? '🚫 Denied' : '✅ Approved';
    if (pending.contentFile) {
      updateContentFile(pending.contentFile, statusText);
    }
    if (pending.approvalFile) {
      cleanupApprovalFiles(pending.approvalFile);
    }

    // Clear timeout
    if (pending.timeoutId) clearTimeout(pending.timeoutId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    resetIdleTimer();
  });
}
```

- [ ] **Step 12: 实现 POST /approval 路由**

```js
function handleApproval(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: 'no_decision', reason: 'invalid JSON' }));
      return;
    }

    const { provider, sessionId, toolName, toolInput, cwd } = parsed;

    // Check pending limit
    if (state.pendingRequests.size >= MAX_PENDING) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: 'no_decision', reason: 'too_many_pending' }));
      return;
    }

    // Check Allow Always rule
    const sessionKey = sessionId ? sessionId.slice(0, 16) : 'default';
    const alwaysMatch = matchAlwaysRule(provider, sessionKey, toolName);
    if (alwaysMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        decision: alwaysMatch.decision,
        reason: alwaysMatch.reason,
      }));
      return;
    }

    // Generate request and write files
    const requestId = generateRequestId();
    const { contentFile, approvalFile } = writeApprovalFiles(
      provider, sessionKey, requestId, toolName, toolInput, cwd, state.port
    );

    // Launch Swift window
    launchSwiftWindow(contentFile);

    // Set timeout
    const timeoutId = setTimeout(() => {
      const p = state.pendingRequests.get(requestId);
      if (p && p.status === 'pending') {
        p.status = 'timeout';
        if (p.response && !p.response.writableEnded) {
          p.response.writeHead(200, { 'Content-Type': 'application/json' });
          p.response.end(JSON.stringify({ decision: 'no_decision', reason: 'timeout' }));
        }
        updateContentFile(p.contentFile, '⏰ Approval timeout — returned to native approval');
        cleanupApprovalFiles(p.approvalFile);
        state.pendingRequests.delete(requestId);
      }
    }, APPROVAL_TIMEOUT_MS);

    // Store pending request — response will be resolved by handleDecision
    state.pendingRequests.set(requestId, {
      id: requestId,
      provider,
      sessionId: sessionKey,
      toolName,
      status: 'pending',
      decision: null,
      message: null,
      response: res,
      contentFile,
      approvalFile,
      timeoutId,
      createdAt: Date.now(),
    });

    resetIdleTimer();
  });
}
```

- [ ] **Step 13: 实现 GET /state 路由和 server 启动**

```js
function handleState(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'x-cc-notify-server': SERVER_NAME,
  });
  res.end(JSON.stringify({
    ok: true,
    server: SERVER_NAME,
    version: SERVER_VERSION,
    pendingCount: state.pendingRequests.size,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const port = findAvailablePort(PORT_START, PORT_END);
if (!port) {
  // Write runtime.json with error so approval-hook.js knows the server is unavailable
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_JSON, JSON.stringify({
    error: 'no_available_port',
    range: [PORT_START, PORT_END],
    at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
  process.exit(1);
}

// Write runtime.json for discovery
fs.mkdirSync(INSTALL_DIR, { recursive: true });
fs.writeFileSync(RUNTIME_JSON, JSON.stringify({
  pid: process.pid,
  port: port,
  startedAt: new Date().toISOString(),
  server: SERVER_NAME,
  version: SERVER_VERSION,
}, null, 2) + '\n', 'utf8');

state.port = port;

// Signal handlers
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => {
  process.stderr.write(`[approval-server] uncaught: ${err.message}\n`);
  cleanup();
  process.exit(1);
});

// Create server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && url.pathname === '/state') {
    handleState(req, res);
  } else if (req.method === 'POST' && url.pathname === '/approval') {
    handleApproval(req, res);
  } else if (req.method === 'POST' && url.pathname === '/decision') {
    handleDecision(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  resetIdleTimer();
});
```

- [ ] **Step 14: 验证语法和启动/退出**

```bash
bash -n scripts/approval-server.js 2>&1 || node -e "require('./scripts/approval-server.js')" 2>&1 || true
# 手动启动验证（会自退出因为不是被 hook 调用）：
node scripts/approval-server.js &
sleep 2
curl -s http://127.0.0.1:23333/state
kill %1 2>/dev/null
```

Expected: `{"ok":true,"server":"cc-notify-approval","version":"...","pendingCount":0,"uptime":...}`

- [ ] **Step 15: Commit**

```bash
git add scripts/approval-server.js
git commit -m "feat: add approval server with HTTP API and Allow Always rules"
```

---

### Task 3: 新增 `scripts/approval-hook.js` — 阻塞型 hook wrapper

**Files:**
- Create: `scripts/approval-hook.js`

**Interfaces:**
- Consumes: `stdin` JSON (PermissionRequest payload), `--provider claude|codex` arg, `adapters` from `../lib/utils.js`
- Produces: stdout JSON (decision) or empty (no_decision), exit 0 or 1

- [ ] **Step 1: 创建文件**

```js
#!/usr/bin/env node
'use strict';

/**
 * cc-notify approval hook wrapper
 *
 * Called by Claude Code / Codex PermissionRequest hook.
 * Reads stdin JSON, contacts the local approval server, blocks until a
 * decision is made (or timeout), and outputs the agent-appropriate
 * allow/deny JSON to stdout.
 *
 * Fallback: if the server is unreachable or times out, outputs nothing
 * (no_decision) and exits 0 — the agent falls back to native approval.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

const INSTALL_DIR  = path.join(os.homedir(), '.cc-notify');
const RUNTIME_JSON = path.join(INSTALL_DIR, 'runtime.json');
const SERVER_JS    = path.join(INSTALL_DIR, 'approval-server.js');

// Provider adapter — same shape as lib/utils.js adapters but self-contained
// to avoid require() on the npm package tree (hook may be called from any cwd).
const adapters = {
  claude: {
    buildAllowResponse() {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' }
        }
      };
    },
    buildDenyResponse(message) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: message || 'Denied from cc-notify'
          }
        }
      };
    },
    buildNoDecisionResponse() { return null; }
  },
  codex: {
    buildAllowResponse() {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' }
        }
      };
    },
    buildDenyResponse(message) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: message || 'Denied from cc-notify'
          }
        }
      };
    },
    buildNoDecisionResponse() { return null; }
  }
};

// ─── Config ──────────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = parseInt(process.env.CC_NOTIFY_APPROVAL_TIMEOUT_SECONDS || '480', 10) * 1000;
const STARTUP_TIMEOUT_MS = parseInt(process.env.CC_NOTIFY_APPROVAL_SERVER_STARTUP_TIMEOUT_MS || '3000', 10);
const PORT_START = parseInt(process.env.CC_NOTIFY_APPROVAL_PORT_RANGE_START || '23333', 10);
const PORT_END   = parseInt(process.env.CC_NOTIFY_APPROVAL_PORT_RANGE_END || '23337', 10);

// ─── Main ─────────────────────────────────────────────────────────────────────

// Parse provider from CLI args
const providerArg = process.argv.find(a => a.startsWith('--provider='))
  || (process.argv.includes('--provider') && '--provider');
let provider = 'claude';
if (providerArg) {
  const val = providerArg.split('=')[1] || process.argv[process.argv.indexOf('--provider') + 1];
  if (val === 'codex') provider = 'codex';
}

const adapter = adapters[provider];
if (!adapter) {
  process.exit(1);
}

// Read stdin JSON
let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdinData += chunk; });
process.stdin.on('end', () => {
  let hookPayload;
  try {
    hookPayload = JSON.parse(stdinData);
  } catch {
    // Invalid stdin — no_decision
    process.exit(0);
  }

  const sessionId  = hookPayload.session_id || hookPayload.sessionId || '';
  const toolName   = hookPayload.tool_name || '';
  const toolInput  = hookPayload.tool_input || {};
  const cwd        = hookPayload.cwd || process.cwd();
  const permissionMode = hookPayload.permission_mode || 'default';

  ensureServerRunning(port => {
    if (!port) {
      emitNoDecision();
      return;
    }
    postApproval(port, provider, sessionId, toolName, toolInput, cwd, permissionMode);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emitNoDecision() {
  const resp = adapter.buildNoDecisionResponse();
  if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  process.exit(0);
}

function emitDecision(decision, message) {
  let resp;
  if (decision === 'allow') {
    resp = adapter.buildAllowResponse();
  } else if (decision === 'deny') {
    resp = adapter.buildDenyResponse(message);
  } else {
    return emitNoDecision();
  }
  if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  process.exit(0);
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

function readRuntime() {
  try {
    const raw = fs.readFileSync(RUNTIME_JSON, 'utf8');
    const data = JSON.parse(raw);
    if (data.error) return null;
    if (!data.port || !data.pid) return null;
    // Check if PID is alive
    try { process.kill(data.pid, 0); } catch { return null; }
    return data;
  } catch {
    return null;
  }
}

function ensureServerRunning(cb) {
  // Try existing instance first
  const runtime = readRuntime();
  if (runtime) {
    // Verify identity via GET /state
    httpGet(runtime.port, '/state', 500, (err, body) => {
      if (!err) {
        try {
          const s = JSON.parse(body);
          if (s.server === 'cc-notify-approval') {
            cb(runtime.port);
            return;
          }
        } catch {}
      }
      // Server not responding or wrong identity — start new
      startServer(cb);
    });
    return;
  }

  startServer(cb);
}

function startServer(cb) {
  if (!fs.existsSync(SERVER_JS)) { cb(null); return; }

  const child = cp.spawn(process.execPath, [SERVER_JS], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for runtime.json to appear (poll with timeout)
  const start = Date.now();
  const poll = setInterval(() => {
    const rt = readRuntime();
    if (rt) {
      clearInterval(poll);
      cb(rt.port);
      return;
    }
    if (Date.now() - start > STARTUP_TIMEOUT_MS) {
      clearInterval(poll);
      cb(null);
    }
  }, 100);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(port, path, timeoutMs, cb) {
  const req = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: path,
    method: 'GET',
    timeout: timeoutMs,
  }, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => cb(null, data));
  });
  req.on('error', err => cb(err));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.end();
}

function postApproval(port, provider, sessionId, toolName, toolInput, cwd, permissionMode) {
  const body = JSON.stringify({
    provider,
    sessionId,
    toolName,
    toolInput,
    cwd,
    permissionMode,
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: '/approval',
    method: 'POST',
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        emitDecision(result.decision, result.message);
      } catch {
        emitNoDecision();
      }
    });
  });

  req.on('error', () => { emitNoDecision(); });
  req.on('timeout', () => { req.destroy(); emitNoDecision(); });
  req.write(body);
  req.end();
}
```

- [ ] **Step 2: 验证语法**

```bash
node -e "require('fs'); require('path'); require('os'); require('child_process'); require('http'); console.log('deps ok')"
node --check scripts/approval-hook.js && echo "syntax ok"
```

Expected: `syntax ok`

- [ ] **Step 3: 验证 no_decision fallback（服务未启动时的行为）**

```bash
echo '{"session_id":"test123","tool_name":"Bash","tool_input":{"command":"echo hello"},"cwd":"/tmp"}' | node scripts/approval-hook.js --provider claude; echo "exit=$?"
```

Expected: `exit=0`（stdout 为空，正常 fallback）

- [ ] **Step 4: Commit**

```bash
git add scripts/approval-hook.js
git commit -m "feat: add approval hook wrapper with provider adapters and fallback"
```

---

### Task 4: 修改 `scripts/postinstall.js` — 复制审批脚本

**Files:**
- Modify: `scripts/postinstall.js`

- [ ] **Step 1: 新增审批脚本路径和复制逻辑**

在 `SRC_SWIFT` 定义之后新增：

```js
const SRC_APPROVAL_HOOK   = path.join(PKG_DIR, 'scripts', 'approval-hook.js');
const SRC_APPROVAL_SERVER = path.join(PKG_DIR, 'scripts', 'approval-server.js');
```

在 `// 4. Copy notify.sh` 之后新增复制步骤：

```js
  // 4b. Copy approval scripts (always — picks up updates on npm update)
  for (const [src, name] of [
    [SRC_APPROVAL_HOOK, 'approval-hook.js'],
    [SRC_APPROVAL_SERVER, 'approval-server.js'],
  ]) {
    if (fs.existsSync(src)) {
      const dest = path.join(INSTALL_DIR, name);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
      log(`Copied ${name}`);
    }
  }
```

- [ ] **Step 2: 验证语法**

```bash
node -c scripts/postinstall.js && echo "syntax ok"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/postinstall.js
git commit -m "feat: copy approval hook and server scripts on postinstall"
```

---

### Task 5: 修改 `lib/commands/init.js` — 审批 hook 配置

**Files:**
- Modify: `lib/commands/init.js`

**Interfaces:**
- Consumes: `APPROVAL_HOOK_JS` constant from `../utils`
- Produces: Claude Code `PermissionRequest` + Codex `PermissionRequest` hooks → `approval-hook.js`

- [ ] **Step 1: 更新 Claude Code HOOK_DEFINITIONS**

在 `HOOK_DEFINITIONS` 数组末尾（`PostCompact` 之后）新增：

```js
  {
    event:   'PermissionRequest',
    matcher: '*',
    updateExisting: true,
    entry: {
      type:    'command',
      command: "$HOME/.cc-notify/approval-hook.js --provider claude",
    },
  },
```

- [ ] **Step 2: 更新 Codex CODEX_HOOK_DEFINITIONS**

将现有的 Codex `PermissionRequest` hook 定义（从指向 `notify.sh --urgent`）替换为：

```js
  {
    event:   'PermissionRequest',
    matcher: '.*',
    updateExisting: true,
    entry: {
      type:          'command',
      command:       "$HOME/.cc-notify/approval-hook.js --provider codex",
      statusMessage: '',
    },
  },
```

- [ ] **Step 3: 验证语法**

```bash
node -e "require('./lib/commands/init.js'); console.log('ok')"
```

- [ ] **Step 4: Commit**

```bash
git add lib/commands/init.js
git commit -m "feat: add PermissionRequest hooks for Claude Code and Codex approval"
```

---

### Task 6: 修改 `lib/commands/status.js` — 审批状态检查

**Files:**
- Modify: `lib/commands/status.js`

- [ ] **Step 1: 更新 imports**

新增 imports：

```js
const {
  // ... existing imports ...
  APPROVAL_HOOK_JS,
  APPROVAL_SERVER_JS,
  RUNTIME_JSON,
} = require('../utils');
```

- [ ] **Step 2: 新增 `PermissionRequest` 到 HOOK_CHECKS**

```js
const HOOK_CHECKS = [
  // ... existing ...
  { event: 'PostCompact',       matcher: null },
  { event: 'PermissionRequest', matcher: '*' },
];
```

- [ ] **Step 3: 更新 Codex feature flag 检查消息**

`showCodexHooks` 中的 `codex_hooks feature` 标签改为 `hooks feature`：

```js
statusLine('hooks feature', enabled, enabled ? 'enabled' : 'not enabled — run: ccn init --codex');
```

- [ ] **Step 4: 新增审批组件状态检查和审批状态 block**

在 `showCodexHooks` 调用之后、CONFIG 之前新增：

```js
  // ── Approval ──────────────────────────────────────────────────────────────
  process.stdout.write('\nAPPROVAL\n');

  const approvalHookOk = fs.existsSync(APPROVAL_HOOK_JS);
  statusLine('approval-hook.js', approvalHookOk,
    approvalHookOk ? APPROVAL_HOOK_JS : 'not found — run: npm install -g cc-notify');

  const approvalServerOk = fs.existsSync(APPROVAL_SERVER_JS);
  statusLine('approval-server.js', approvalServerOk,
    approvalServerOk ? APPROVAL_SERVER_JS : 'not found — run: npm install -g cc-notify');

  // Check service status
  let svcStatus = 'stopped';
  if (fs.existsSync(RUNTIME_JSON)) {
    try {
      const rt = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf8'));
      if (rt.error) {
        svcStatus = `error: ${rt.error}`;
      } else if (rt.pid && rt.port) {
        try { process.kill(rt.pid, 0); svcStatus = `running (pid ${rt.pid}, port ${rt.port})`; }
        catch { svcStatus = 'stopped (stale runtime.json)'; }
      }
    } catch {
      svcStatus = 'error reading runtime.json';
    }
  }
  statusLine('approval service', svcStatus.startsWith('running'), svcStatus);
```

- [ ] **Step 5: 验证语法**

```bash
node -e "require('./lib/commands/status.js'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add lib/commands/status.js
git commit -m "feat: add approval component checks to status command"
```

---

### Task 7: 验证 `lib/commands/uninit.js` — 无需改动

**Files:**
- (验证即可，不修改) `lib/commands/uninit.js`

- [ ] **Step 1: 确认现有 `isCcNotifyCommand` 逻辑覆盖审批 hook**

现有 `removeCcNotifyHooks` 使用 `isCcNotifyCommand(hook.command)` 过滤，而 `approval-hook.js` 的路径中包含 `cc-notify`，所以 `isCcNotifyCommand` 会返回 `true`，自动清理。

```bash
node -e "
const u = require('./lib/utils');
console.log('approval-hook detected:', u.isCcNotifyCommand('node \\\$HOME/.cc-notify/approval-hook.js --provider claude'));
console.log('notify.sh detected:', u.isCcNotifyCommand('\\\$HOME/.cc-notify/notify.sh --urgent'));
"
```

Expected: `true true`

- [ ] **Step 2: Commit（如果通过）**

```bash
git add lib/commands/uninit.js
git commit -m "chore: verify uninit handles approval hooks via existing isCcNotifyCommand"
```

如果已有改动则提交，否则跳过。

---

### Task 8: 修改 `scripts/sticky-window.swift` — 审批 UI 模式

**Files:**
- Modify: `scripts/sticky-window.swift`

**Interfaces:**
- Consumes: `.txt` (with `__APPROVAL__` sentinel), `.approval.json` sidecar
- Produces: Approval UI buttons → `POST /decision`

- [ ] **Step 1: 新增审批数据模型**

在 `AppDelegate` 类开头新增属性：

```swift
    // ── Approval mode ───────────────────────────────────────────────────────
    var isApproval = false
    var approvalData: [String: Any]?   // parsed .approval.json
    var approvalFilePath: String = ""
    var approvalButtons: [NSButton] = []  // Allow / Deny / Always / Focus
    var approvalButtonsDisabled = false
```

- [ ] **Step 2: 在 init 中推导 approval 路径**

在 `self.slotFilePath = base + ".slot"` 之后新增：

```swift
        self.approvalFilePath = base + ".approval.json"
```

- [ ] **Step 3: 新增审批 UI 构建方法**

在 `dismissUrgent` 方法之前新增（约 200 行）：

```swift
    /// Enter approval mode: hide normal meta lines, show approval-specific UI.
    func enterApprovalMode() {
        guard let data = approvalData else { return }
        isApproval = true

        // Hide normal close timer — approval windows stay until decided or timeout
        closeTimer?.invalidate()
        closeTimer = nil

        // Change card background to a distinct approval color (light blue tint)
        cardView.layer?.backgroundColor = NSColor(calibratedRed: 0.94, green: 0.96, blue: 1.0, alpha: 1.0).cgColor

        // Build approval content labels
        let toolName = data["toolName"] as? String ?? ""
        let summary  = data["summary"] as? String ?? ""
        let provider = data["provider"] as? String ?? "claude"
        let providerName = provider == "codex" ? "Codex" : "Claude Code"

        // Update header line
        headerLabel.stringValue = "🔐 \(providerName) Approval"

        // Remove all meta line labels (we'll replace with approval-specific ones)
        for lbl in metaLineLabels { lbl.removeFromSuperview() }
        metaLineLabels.removeAll()

        // Add Tool: and Summary: labels in meta area
        let metaAreaY: CGFloat = 8
        let metaAreaH: CGFloat = noteH - 28 - 16
        let lineH: CGFloat = 15

        let toolLabel = PassthroughLabel(labelWithString: "Tool: \(toolName)")
        toolLabel.frame = NSRect(x: 16, y: metaAreaY + metaAreaH - lineH - 36, width: noteW - 140, height: lineH)
        toolLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        toolLabel.textColor = NSColor(calibratedRed: 0.15, green: 0.20, blue: 0.30, alpha: 1.0)
        toolLabel.lineBreakMode = .byTruncatingTail
        cardView.addSubview(toolLabel)
        metaLineLabels.append(toolLabel)

        let summaryLabel = PassthroughLabel(labelWithString: summary)
        summaryLabel.frame = NSRect(x: 16, y: metaAreaY + metaAreaH - lineH - 54, width: noteW - 140, height: lineH)
        summaryLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        summaryLabel.textColor = NSColor(calibratedRed: 0.25, green: 0.30, blue: 0.40, alpha: 1.0)
        summaryLabel.lineBreakMode = .byTruncatingTail
        cardView.addSubview(summaryLabel)
        metaLineLabels.append(summaryLabel)

        // Project label
        let projectName = storedMetaLines
            .first(where: { $0.hasPrefix("Project:") })
            .flatMap { line -> String? in
                guard let idx = line.firstIndex(of: ":") else { return nil }
                return line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
            } ?? ""
        if !projectName.isEmpty {
            let projLabel = PassthroughLabel(labelWithString: "Project: \(projectName)")
            projLabel.frame = NSRect(x: 16, y: metaAreaY + metaAreaH - lineH - 72, width: noteW - 140, height: lineH)
            projLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
            projLabel.textColor = NSColor(calibratedRed: 0.40, green: 0.45, blue: 0.55, alpha: 1.0)
            projLabel.lineBreakMode = .byTruncatingTail
            cardView.addSubview(projLabel)
            metaLineLabels.append(projLabel)
        }

        // ── Buttons: right-aligned, stacked vertically ──────────────────────
        let btnX = noteW - 130  // right margin
        let btnW: CGFloat = 116
        let btnH: CGFloat = 22
        let btnGap: CGFloat = 4
        // Start from bottom of meta area, stack upward
        let buttonBaseY = metaAreaY + 4

        let buttonDefs: [(title: String, action: Selector, color: NSColor)] = [
            ("Allow",  #selector(approvalAllowAction),
             NSColor(calibratedRed: 0.18, green: 0.62, blue: 0.18, alpha: 1.0)),
            ("Deny",   #selector(approvalDenyAction),
             NSColor(calibratedRed: 0.82, green: 0.18, blue: 0.18, alpha: 1.0)),
            ("Always", #selector(approvalAlwaysAction),
             NSColor(calibratedRed: 0.95, green: 0.62, blue: 0.10, alpha: 1.0)),
            ("Focus",  #selector(approvalFocusAction),
             NSColor(calibratedRed: 0.35, green: 0.45, blue: 0.60, alpha: 1.0)),
        ]

        for (i, def) in buttonDefs.enumerated() {
            let btn = NSButton(frame: NSRect(x: btnX, y: buttonBaseY + CGFloat(i) * (btnH + btnGap), width: btnW, height: btnH))
            btn.title = def.title
            btn.isBordered = true
            btn.bezelStyle = .rounded
            btn.font = NSFont.systemFont(ofSize: 11, weight: .medium)
            btn.target = self
            btn.action = def.action

            // Style: solid color background, white text
            btn.wantsLayer = true
            btn.layer?.backgroundColor = def.color.cgColor
            btn.layer?.cornerRadius = 4
            btn.contentTintColor = NSColor.white

            cardView.addSubview(btn)
            approvalButtons.append(btn)
        }

        // Update tap zone: content area excludes buttons
        cardView.closeBtnFrame = closeBtn.frame
        cardView.contentFrame = NSRect(x: 16, y: 8, width: noteW - 154, height: noteH - 16)
    }

    /// Exit approval mode: clean up buttons, restore normal theme
    func exitApprovalMode(statusText: String) {
        isApproval = false
        approvalData = nil

        // Remove approval buttons
        for btn in approvalButtons { btn.removeFromSuperview() }
        approvalButtons.removeAll()

        // Remove approval-specific labels
        for lbl in metaLineLabels { lbl.removeFromSuperview() }
        metaLineLabels.removeAll()

        // Write status text as notification
        updateLabels(from: statusText)
        applyTheme()

        // Restore normal tap zone
        cardView.closeBtnFrame = closeBtn.frame
        cardView.contentFrame = NSRect(x: 16, y: 8, width: noteW - 24, height: noteH - 16)

        // Restore close timer
        scheduleCloseTimer()
    }
```

- [ ] **Step 4: 新增按钮 action 方法**

在 `focusTerminal` 方法附近新增：

```swift
    /// POST /decision with the given decision value.
    func postDecision(_ decision: String, message: String? = nil) {
        guard let endpoint = approvalData?["decisionEndpoint"] as? String,
              let requestId = approvalData?["requestId"] as? String,
              !approvalButtonsDisabled else { return }

        approvalButtonsDisabled = true
        for btn in approvalButtons { btn.isEnabled = false }

        guard let url = URL(string: endpoint) else { return }

        var body: [String: String] = ["requestId": requestId, "decision": decision]
        if let msg = message { body["message"] = msg }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 10
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let task = URLSession.shared.dataTask(with: req) { [weak self] data, resp, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let httpResp = resp as? HTTPURLResponse {
                    if httpResp.statusCode == 200 {
                        self.exitApprovalMode(statusText: decision == "deny" ? "🚫 Denied" : "✅ Approved")
                    } else if httpResp.statusCode == 409 {
                        self.cardView?.showTooltip("Already decided", locationInWindow: NSPoint(x: 50, y: 30))
                    } else if httpResp.statusCode == 404 {
                        self.cardView?.showTooltip("Request not found", locationInWindow: NSPoint(x: 50, y: 30))
                    } else {
                        self.cardView?.showTooltip("Error: \(httpResp.statusCode)", locationInWindow: NSPoint(x: 50, y: 30))
                    }
                } else if error != nil {
                    // Network error — retry up to 2 more times
                    if self.approvalButtonsDisabled {
                        self.approvalButtonsDisabled = false
                        for btn in self.approvalButtons { btn.isEnabled = true }
                    }
                    self.cardView?.showTooltip("Network error — try again", locationInWindow: NSPoint(x: 50, y: 30))
                }
            }
        }
        task.resume()
    }

    @objc func approvalAllowAction()  { postDecision("allow") }
    @objc func approvalDenyAction()   { postDecision("deny", message: "Denied from sticky note") }
    @objc func approvalAlwaysAction()  { postDecision("allow_always") }
    @objc func approvalFocusAction()  { focusTerminal() }
```

- [ ] **Step 5: 修改 `reloadContent` — 检测审批态并进入审批模式**

在 `reloadContent` 方法中、`updateLabels(from: text)` 之后插入：

```swift
        // Check for approval mode
        let isApprovalContent = text.hasPrefix("__APPROVAL__")
        if isApprovalContent && !isApproval {
            // Load .approval.json
            if let approvalRaw = try? String(contentsOfFile: approvalFilePath, encoding: .utf8),
               let approvalObj = try? JSONSerialization.jsonObject(with: Data(approvalRaw.utf8)) as? [String: Any] {
                approvalData = approvalObj
                enterApprovalMode()
                return  // Don't proceed with normal reload
            }
        }

        // If .txt no longer starts with __APPROVAL__, exit approval mode
        if !isApprovalContent && isApproval {
            exitApprovalMode(statusText: text)
            return
        }
```

- [ ] **Step 6: 验证 Swift 编译**

```bash
swiftc scripts/sticky-window.swift -o /tmp/sticky-notify-test 2>&1 && echo "compile ok" && rm -f /tmp/sticky-notify-test
```

Expected: `compile ok`

- [ ] **Step 7: Commit**

```bash
git add scripts/sticky-window.swift
git commit -m "feat: add approval UI mode to Swift sticky window"
```

---

### Task 9: 端到端集成测试

**Files:**
- (验证)

- [ ] **Step 1: 安装审批脚本到 ~/.cc-notify/**

```bash
node scripts/postinstall.js
```

- [ ] **Step 2: 启动审批服务**

```bash
node ~/.cc-notify/approval-server.js &
SERVER_PID=$!
sleep 1
```

- [ ] **Step 3: 验证 GET /state**

```bash
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.cc-notify/runtime.json','utf8')).port)")
curl -s http://127.0.0.1:$PORT/state | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('server:', d.server, 'ok:', d.ok)"
```

Expected: `server: cc-notify-approval ok: true`

- [ ] **Step 4: 测试审批请求**

```bash
# 在后台启动审批请求
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.cc-notify/runtime.json','utf8')).port)")
curl -s -X POST http://127.0.0.1:$PORT/approval \
  -H 'Content-Type: application/json' \
  -d '{"provider":"claude","sessionId":"test-abc123","toolName":"Bash","toolInput":{"command":"echo hello"},"cwd":"/tmp"}' &
APPROVAL_PID=$!
sleep 2

# 验证 .txt 和 .approval.json 已生成
cat /tmp/cc-notify/claude-test-abc123.txt
cat /tmp/cc-notify/claude-test-abc123.approval.json
```

Expected: `.txt` 以 `__APPROVAL__` 开头；`.approval.json` 包含 requestId、decisionEndpoint 等字段。

- [ ] **Step 5: 测试 /decision 回传**

```bash
REQUEST_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/cc-notify/claude-test-abc123.approval.json','utf8')).requestId)")
curl -s -X POST http://127.0.0.1:$PORT/decision \
  -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQUEST_ID\",\"decision\":\"allow\"}"
```

Expected: `{"ok":true}`；之前的 curl /approval 请求应返回 allow；.txt 更新为 `✅ Approved`

- [ ] **Step 6: 测试 Allow Always**

```bash
# 发送带 allow_always 的决策
curl -s -X POST http://127.0.0.1:$PORT/approval \
  -H 'Content-Type: application/json' \
  -d '{"provider":"claude","sessionId":"test-abc123","toolName":"Bash","toolInput":{"command":"echo hello"},"cwd":"/tmp"}' &
PID2=$!
sleep 1
REQ_ID2=$(node -e "const f=require('fs').readdirSync('/tmp/cc-notify').find(f=>f.endsWith('.approval.json')&&f.startsWith('claude-test-abc'));if(f)console.log(JSON.parse(require('fs').readFileSync('/tmp/cc-notify/'+f,'utf8')).requestId)")
curl -s -X POST http://127.0.0.1:$PORT/decision \
  -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQ_ID2\",\"decision\":\"allow_always\"}"
sleep 1

# 再次发送同样的审批 —— 应该立刻返回 allow 而不需要 UI
curl -s -X POST http://127.0.0.1:$PORT/approval \
  -H 'Content-Type: application/json' \
  -d '{"provider":"claude","sessionId":"test-abc123","toolName":"Bash","toolInput":{"command":"echo hi"},"cwd":"/tmp"}'
```

Expected: 第三次请求立刻返回 `{"decision":"allow","reason":"always_allow:session_tool:Bash"}`

- [ ] **Step 7: 测试 approval-hook 端到端（服务已运行）**

```bash
echo '{"session_id":"test-hook-123","tool_name":"Bash","tool_input":{"command":"echo test"},"cwd":"/tmp"}' | node ~/.cc-notify/approval-hook.js --provider claude &
HOOK_PID=$!
sleep 1
REQ_ID3=$(node -e "const f=require('fs').readdirSync('/tmp/cc-notify').filter(f=>f.endsWith('.approval.json')&&f.startsWith('claude-test-hook')&&!f.includes('test-abc'));if(f.length)console.log(JSON.parse(require('fs').readFileSync('/tmp/cc-notify/'+f[0],'utf8')).requestId)")
curl -s -X POST http://127.0.0.1:$PORT/decision \
  -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQ_ID3\",\"decision\":\"allow\"}"
wait $HOOK_PID
echo "hook exit=$?"
```

Expected: hook stdout 输出 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`

- [ ] **Step 8: 清理**

```bash
kill $SERVER_PID 2>/dev/null
rm -f /tmp/cc-notify/claude-test-*.txt /tmp/cc-notify/claude-test-*.approval.json
rm -f /tmp/cc-notify/claude-test-hook-*.txt /tmp/cc-notify/claude-test-hook-*.approval.json
```

- [ ] **Step 9: Commit（如果有残留文件变更）**

```bash
# 确认没有未提交变更
git status
```

---

### Task 10: 更新文档和最终验证

**Files:**
- Modify: `docs/DESIGN.md`（如果存在）

- [ ] **Step 1: 更新 DESIGN.md 架构说明**

在架构图中补充审批组件说明（如果 DESIGN.md 存在）。

- [ ] **Step 2: 运行完整语法检查**

```bash
# Node 文件
for f in bin/ccn.js lib/utils.js lib/commands/*.js scripts/approval-hook.js scripts/approval-server.js scripts/postinstall.js; do
  node --check "$f" && echo "✓ $f" || echo "✗ $f"
done

# Swift 编译检查
swiftc scripts/sticky-window.swift -o /tmp/sticky-notify-check && echo "✓ sticky-window.swift" && rm -f /tmp/sticky-notify-check
```

- [ ] **Step 3: 运行 npm pack 验证包完整性**

```bash
npm pack --dry-run 2>&1 | grep -E 'approval-(hook|server)\.js|sticky-window\.swift|notify\.sh'
```

Expected: 看到 `scripts/approval-hook.js`、`scripts/approval-server.js` 在发布列表中。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: finalize approval mechanism — docs and verification"
```

---

## 实现依赖顺序

```
Task 1 (utils.js: 路径 + adapter + Codex 兼容)
  ├── Task 2 (approval-server.js: 依赖 utils 中的 adapter 和路径)
  ├── Task 3 (approval-hook.js: 独立文件，依赖 server 的 API)
  ├── Task 4 (postinstall.js: 复制新文件)
  ├── Task 5 (init.js: 新增 hook 定义)
  ├── Task 6 (status.js: 新增检查)
  ├── Task 7 (uninit.js: 验证即可)
  └── Task 8 (sticky-window.swift: 审批 UI)

Task 9 (集成测试: 依赖 1-8 全部完成)
Task 10 (文档 + 最终验证: 依赖 1-9)
```

推荐执行顺序：Task 1 → Task 2,3,4,8 并行 → Task 5,6,7 并行 → Task 9 → Task 10
