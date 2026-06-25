# cc-notify 审批操作功能设计

> 创建日期：2026-06-25
> 状态：设计阶段，待评审
> 关联文档：`docs/DESIGN.md`

## 概述

让 cc-notify 从"权限请求提醒器"升级为"可直接审批的 macOS 便签"。用户在浮动便签上可以直接点击 **Allow / Deny / Allow Always** 决策按钮，决策结果回传给 Claude Code 或 Codex，实现真审批闭环。

### 设计原则

- macOS-only，无第三方运行时依赖
- hooks 指向稳定路径 `~/.cc-notify/`
- Claude Code / Codex 状态互相隔离
- 审批失败时回退原生审批，不默认 allow 或 deny
- 首版只做当前 session 内的 Allow Always，不做跨 session 持久化

---

## 第 1 部分：总体架构

### 新增核心组件

```text
Claude Code / Codex PermissionRequest
        │
        ▼
~/.cc-notify/approval-hook.js          ← 阻塞型 hook wrapper
        │ stdin JSON
        ▼
~/.cc-notify/approval-server.js        ← 本地审批中枢
        │ 写 .txt + .approval.json
        ▼
~/.cc-notify/sticky-notify.app          ← Swift 便签 UI（扩展审批态）
        │ 用户点击 Allow / Deny / Allow Always
        ▼
POST /decision                         ← Swift → Node
        │
        ▼
approval-server.js resolve pending     ← Node 决策回写
        │
        ▼
approval-hook.js stdout 输出           ← Claude Code/Codex 执行或拒绝
```

### 与现有通知流的共存

| 组件 | 职责 | 改动 |
|---|---|---|
| `notify.sh` | Stop / Notification / UserPromptSubmit / PostToolUse / PostCompact 通知 | 不动 |
| `approval-hook.js` | PermissionRequest 真审批的阻塞 wrapper | **新增** |
| `approval-server.js` | 本地审批中枢，管理 pending requests | **新增** |
| `sticky-window.swift` | 扩展审批 UI 模式 | **扩展** |
| `init.js` / `status.js` / `uninit.js` / `utils.js` / `postinstall.js` | 新增审批 hook 配置和状态检查 | **扩展** |

### 首版边界

**做：**

- Claude Code `PermissionRequest` 真审批
- Codex `PermissionRequest` 真审批（按保守 stdout 格式）
- Allow / Deny
- Allow Always，仅当前 session 内生效
- 超时 / 服务失败 / UI 失败 → fallback 原生审批

**不做：**

- 跨 session / 项目级 / 全局 Allow Always
- Allow Always 规则的持久化与恢复
- Allow Always 规则的管理和撤销 UI
- 远程审批
- `updatedInput` 改写工具参数
- `updatedPermissions` 持久化权限策略
- 审批历史记录/审计
- Claude Code HTTP hook 直接审批（首版统一用 command hook）
- 审批请求的优先级/排队
- 便签上显示完整 tool_input JSON（首版摘要显示，详情需展开）

---

## 第 2 部分：组件与接口边界

### 2.1 `approval-hook.js`：阻塞型 hook wrapper

**路径：** `scripts/approval-hook.js` → 安装到 `~/.cc-notify/approval-hook.js`

**职责：**

1. 从 `stdin` 读取 PermissionRequest payload
2. 根据 `--provider claude|codex` 确定 provider
3. 连接或冷启动本地审批服务
4. `POST /approval` 发送审批上下文
5. 阻塞等待服务返回决策
6. 根据 provider adapter 向 stdout 输出决策 JSON
7. 超时或失败 → no_decision → exit 0

**命令形式：**

```bash
node "$HOME/.cc-notify/approval-hook.js" --provider claude
node "$HOME/.cc-notify/approval-hook.js" --provider codex
```

**stdout 输出格式：**

Claude Code allow:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

Claude Code deny:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Denied from cc-notify"
    }
  }
}
```

Codex allow（保守字段）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

Codex deny:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Denied from cc-notify"
    }
  }
}
```

**No-decision 行为：**

| Provider | 行为 | 说明 |
|---|---|---|
| Claude Code | stdout 为空，exit 0 | 回退 Claude Code 原生审批 |
| Codex | stdout 为空，exit 0 | 若实测要求 `{}`，在 Codex adapter 调整 |

---

### 2.2 `approval-server.js`：本地审批中枢

**路径：** `scripts/approval-server.js` → 安装到 `~/.cc-notify/approval-server.js`

**职责：**

1. 启动本地 HTTP server，绑定 `127.0.0.1`
2. 端口探测（23333-23337），写入 `~/.cc-notify/runtime.json`
3. 接收审批请求，维护 pending request map
4. 写 `.txt` + `.approval.json` 供 Swift 读取
5. 挂起 HTTP response，等待 Swift 决策
6. 管理 session 内 Allow Always 规则
7. 超时清理、空闲退出

**runtime.json 格式：**

```json
{
  "pid": 12345,
  "port": 23333,
  "startedAt": "2026-06-25T...",
  "server": "cc-notify-approval",
  "version": "1.1.0"
}
```

**API 接口：**

#### `GET /state`

探活与身份确认。

响应：

```json
{ "ok": true, "server": "cc-notify-approval", "version": "1.1.0" }
```

响应头：`x-cc-notify-server: cc-notify-approval`

#### `POST /approval`

hook wrapper 调用，阻塞直到决策或超时。

请求：

```json
{
  "provider": "claude",
  "sessionId": "abcd1234...",
  "cwd": "/path/to/project",
  "toolName": "Bash",
  "toolInput": { "command": "npm test" },
  "permissionMode": "default",
  "raw": {}
}
```

响应（正常）：

```json
{ "decision": "allow" }
```

或：

```json
{ "decision": "deny", "message": "Denied from cc-notify" }
```

或：

```json
{ "decision": "no_decision", "reason": "timeout" }
```

#### `POST /decision`

Swift 点击按钮后调用。

请求：

```json
{ "requestId": "appr_abc123", "decision": "allow" }
```

`decision` 可选值：`"allow"` | `"deny"` | `"allow_always"`

响应：

```json
{ "ok": true }
```

重复提交返回 409；未知 requestId 返回 404。

**服务生命周期：**

| 机制 | 参数 | 说明 |
|---|---|---|
| 按需启动 | approval-hook.js 首次调用时 spawn | 3 秒启动超时 |
| 端口探测 | 23333 → 23337 | 200ms/端口，全占用则失败 |
| 空闲退出 | 30 分钟无活动 | 每次 /approval 重置计时 |
| 退出清理 | 删除 runtime.json | 异常退出后残留文件由下次启动覆盖 |

---

### 2.3 Swift 审批态便签

**入口：** `/tmp/cc-notify/<provider-session>.txt`

**新 sidecar：** `/tmp/cc-notify/<provider-session>.approval.json`

`.txt` 格式（审批态）：

```text
__APPROVAL__
🔐 Claude Code Approval
Tool: Bash
Command: npm test
Project: cc-notify
```

`.approval.json` 格式：

```json
{
  "type": "approval",
  "requestId": "appr_abc123",
  "provider": "claude",
  "sessionId": "abcd1234",
  "toolName": "Bash",
  "summary": "Run command: npm test",
  "detail": { "command": "npm test" },
  "decisionEndpoint": "http://127.0.0.1:<actual-port>/decision",
  "createdAt": "2026-06-25T...",
  "allowAlwaysScope": "session"
}
```

**审批 UI 元素：**

- 标题：`🔐 Claude Code Approval`（provider 自适应）
- 主体：Tool + 操作摘要 + Project
- 展开：完整 tool_input JSON pretty-print
- 按钮：`[Allow]` `[Deny]` `[Always]` `[Focus]`

**审批态与普通态切换：**

- `.txt` 以 `__APPROVAL__` 开头 + `.approval.json` 存在 → 审批态
- `.txt` 不再以 `__APPROVAL__` 开头 → 回普通通知态
- 决策后 Node 更新 `.txt` 为 `✅ Approved` 或 `🚫 Denied`
- 审批态不受 `close_timeout` 限制（不自动关闭）

**决策后行为：**

- 按钮全部 disable（防双击 + 防重复决策）
- POST /decision
  - 成功 → 更新便签内容，保留数秒后关闭
  - 409 → 显示 "Already decided"
  - 404 → 显示 "Request not found"
  - 网络失败 → 重试 2 次，均失败则显示错误

**文件监听兼容：**

- 现有 Swift 使用 DispatchSource + kqueue 监听 `.txt`
- `.approval.json` 不需要实时监听；Swift 启动时同步读取
- Node 更新 `.txt` 保持与 `notify.sh` 一致的写入方式（truncate+write，不换 inode）
- 审批态下 `.txt` 哨兵变化 → Swift 切换 UI 模式

---

### 2.4 Provider Adapter

Node 侧抽象 adapter 接口，隔离 Claude Code / Codex 协议差异：

```js
const adapters = {
  claude: {
    buildAllowResponse()    → { hookSpecificOutput: { ... } },
    buildDenyResponse(msg)  → { hookSpecificOutput: { ... } },
    buildNoDecisionResponse() → null/stdout empty
  },
  codex: {
    buildAllowResponse()    → { hookSpecificOutput: { ... } },
    buildDenyResponse(msg)  → { hookSpecificOutput: { ... } },
    buildNoDecisionResponse() → null/stdout empty
  }
};
```

内部统一决策模型：

```js
{
  decision: "allow" | "deny" | "no_decision",
  message?: string,
  remember?: { scope: "session", key: string }
}
```

---

## 第 3 部分：核心交互流程

### 3.1 正常审批

```text
1. Claude Code/Codex 触发 PermissionRequest
2. agent 调 approval-hook.js，stdin 传入 payload
3. approval-hook.js：
   - 读 runtime.json，若服务不在则 spawn approval-server.js
   - POST /approval
4. approval-server.js：
   - 若匹配 Allow Always 规则 → 直接返回 allow，跳过 UI
   - 否则生成 requestId，入 pendingRequests
   - 写 .txt + .approval.json
   - 启动/复用 Swift 窗口
   - 挂起 /approval HTTP response
5. Swift 读取 .approval.json，渲染审批便签
6. 用户点击 Allow/Deny/Always
7. Swift POST /decision
8. approval-server.js：
   - 查找 pendingRequests[requestId]
   - 若 allow_always → 写入 sessionRules
   - 标记 decided，resolve 挂起 response
   - 更新 .txt，清理 .approval.json
9. approval-hook.js 收到响应 → adapter → stdout
10. agent 读取 stdout → 执行或拒绝
11. Swift 便签按 close_timeout 关闭
```

### 3.2 Allow Always 流程

**触发：** 用户点击 "Always" 按钮。

**规则存储：**

- 位置：`approval-server.js` 运行时内存
- Key：`${provider}:${sessionId}`
- Value：`Map<matchKey, decision>`
- matchKey：
  - `"*"` → 当前 session 所有 tool
  - `"Bash"` → 仅同名 tool

**匹配逻辑：**

```js
function matchAlwaysRule(provider, sessionId, toolName) {
  const rules = sessionRules[`${provider}:${sessionId}`];
  if (!rules) return null;
  if (rules.has("*")) return { decision: rules.get("*") };
  if (rules.has(toolName)) return { decision: rules.get(toolName) };
  return null;
}
```

**生命周期：**

- 与 approval-server 进程共存亡
- 服务重启后清空
- 不做持久化

**安全约束：**

- 仅当前 session 内生效
- 服务异常退出 → 规则消失 → 安全回退到审批 UI
- 首版不给"撤销"入口，session 结束自然失效

### 3.3 超时与 Fallback

| 阶段 | 时间 | 行为 |
|---|---|---|
| 服务启动 | 3 秒 | 超时 → no_decision fallback |
| 审批决策 | 8 分钟（可配置） | 超时 → no_decision → 回退原生审批 |
| Swift 窗口（审批态） | 不限 | 不自动关闭 |
| Swift 窗口（决策后） | close_timeout（默认 30s） | 正常自动关闭 |
| 服务空闲 | 30 分钟 | 自动退出 |

**超时侧清理：**

- Node 侧 pending request 标记 timeout，从 pendingRequests 移除
- 更新 `.txt` 为 timeout 提示
- 删除 `.approval.json`
- Swift 降级为普通通知，按 close_timeout 关闭

### 3.4 并发审批

- 每个 `POST /approval` → 独立 requestId → 各自 pending
- Swift 为审批态复用现有窗口槽位机制
- 同一 provider+session 的最新审批覆盖窗口内容
- 不同 session 互不干扰（不同的 .txt / .pid）

**内存泄漏防护：**

- pendingRequests 超时自动清理
- 上限 10 个待审批 → 超过则拒绝新请求（返回 no_decision）

### 3.5 重复决策防护

pendingRequests[requestId] 有状态字段：

```js
{
  id: "appr_abc123",
  status: "pending" | "decided" | "timeout",
  ...
}
```

- `pending` + POST /decision → 正常处理，status → `decided`
- `decided` + POST /decision → 409
- `timeout` + POST /decision → 409

Swift 按钮点击后立即 disable，防双击。

---

## 第 4 部分：Hook 配置与命令改动

### 4.1 `ccn init`

**新增 Claude Code hook：**

```js
{
  event: 'PermissionRequest',
  matcher: '*',
  command: `${HOME}/.cc-notify/approval-hook.js --provider claude`,
  updateExisting: true
}
```

**新增 Codex hook：**

```js
{
  event: 'PermissionRequest',
  matcher: '.*',
  command: `${HOME}/.cc-notify/approval-hook.js --provider codex`,
  updateExisting: true
}
```

**与现有 urgent notification 的去重：**

- `ccn init` 将已有的指向 `notify.sh --urgent` 的 `PermissionRequest` hook 替换为指向 `approval-hook.js`
- 若用户有非 cc-notify 的 `PermissionRequest` hook → 不覆盖，status 提示冲突
- 现有 `Notification(permission_prompt)` 保留作为兜底提醒

### 4.2 `ccn status`

新增检查项：

| 检查项 | 内容 |
|---|---|
| 审批脚本 | `approval-hook.js`、`approval-server.js` 是否存在 |
| Claude Code | `PermissionRequest` hook 是否指向 cc-notify |
| Codex | `PermissionRequest` hook 是否指向 cc-notify |
| Codex 开关 | `hooks = true` feature flag |
| 服务状态 | runtime.json、pid、GET /state |
| 活跃规则 | 当前 session 内 Allow Always 规则数 |

### 4.3 `ccn uninit`

- 删除指向 `approval-hook.js` 的 `PermissionRequest` hook
- 一并清理旧的 `notify.sh --urgent` 版本
- 不影响用户自有 hook
- 不自动停止审批服务（可能被其他 session 使用）

### 4.4 `ccn set`

新增可配置项：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `approval.timeout_seconds` | 480 | 审批决策超时（秒） |
| `approval.server_startup_timeout_ms` | 3000 | 服务冷启动超时（毫秒） |
| `approval.port_range_start` | 23333 | 端口探测起始 |
| `approval.port_range_end` | 23337 | 端口探测结束 |
| `approval.idle_timeout_minutes` | 30 | 服务空闲退出时间 |
| `approval.enabled` | true | 是否启用真审批 |

通过 `env.json` → `env.sh` → `process.env` 传递给脚本。

### 4.5 Codex feature flag 兼容

`lib/utils.js` 需同时兼容新老字段：

```toml
[features]
hooks = true          # 新版 ← 本机实际使用

[features]
codex_hooks = true    # 旧版兼容
```

读时两个都检查，写时优先写 `hooks = true`。

### 4.6 `postinstall.js`

复制新增文件：

```js
['approval-hook.js', 'approval-server.js']
  .forEach(f => copyToHomeDir(f));
```

---

## 第 5 部分：错误处理、风险缓解、测试

### 5.1 错误处理矩阵

#### approval-hook.js

| 失败场景 | 行为 |
|---|---|
| stdin 为空/非 JSON | exit 1，回退原生审批 |
| 服务不可用（端口全占/启动失败） | no_decision → 回退原生审批 |
| POST /approval 超时（8分钟） | no_decision → 回退原生审批 |
| 服务返回 5xx | no_decision → 回退原生审批 |
| provider 未知 | exit 1 → 回退原生审批 |

#### approval-server.js

| 失败场景 | 行为 |
|---|---|
| 所有端口被占用 | 拒绝启动，写 runtime.json 错误标记 |
| pendingRequests > 10 | 拒绝新请求，返回 no_decision |
| Swift 进程不响应 | pending request 超时后释放 |
| POST /decision 未知 requestId | 404 |
| POST /decision 重复提交 | 409 |
| Node 进程异常退出 | runtime.json 残留；下次 hook 调用检测 pid 不存活，重新启动 |

#### Swift 审批便签

| 失败场景 | 行为 |
|---|---|
| .approval.json 不存在/格式错误 | 回退普通便签模式 |
| POST /decision 网络错误 | 重试 2 次；失败显示错误 |
| POST /decision 409 | 显示 "Already decided" |
| POST /decision 404 | 显示 "Request not found" |
| 窗口被手动关闭（×） | 不发 decision；服务侧超时 fallback |
| Swift App 不存在 | 服务不写 .approval.json；超时 fallback |

### 5.2 安全风险缓解

| 风险 | 缓解措施 |
|---|---|
| 误触 Allow Always | 仅当前 session 内生效，session 结束规则消失 |
| 端口被冒充 | 127.0.0.1 监听；GET /state 响应头确认身份 |
| .approval.json 被篡改 | decisionEndpoint 固定为 127.0.0.1 |
| tool_input 泄露 | 日志不记录 tool_input，仅记录 tool_name 和 session |
| 审批超时恰好用户刚点击 | 服务返回 409 提示 timeout，不误应用 |

### 5.3 与现有文件监听兼容

现有 `sticky-window.swift` 的 DispatchSource + kqueue 监听 `.txt`，已处理 inode 替换。

- `.approval.json` 写入不影响 `.txt` 监听（不同文件）
- 决策后更新 `.txt`：使用 truncate+write，不换 inode
- `.approval.json` 不需要实时监听，Swift 启动时同步读
- `.txt` 哨兵从 `__APPROVAL__` 变为普通内容 → Swift 退出审批 UI 模式

### 5.4 测试策略

**手动场景测试：**

| 场景 | 预期 |
|---|---|
| Allow | 便签出现 → 点击 Allow → 命令执行 |
| Deny | 便签出现 → 点击 Deny → 命令拒绝 |
| Allow Always | 点击 Always → 同类 tool 再次触发时无需审批 |
| Allow Always 范围 | 点击 Always(Bash) → Edit tool 仍需审批 |
| 超时 | 不点击等超时 → 回退终端原生审批 |
| 服务重启 | kill 服务 → 下次触发 → 冷启动成功 |
| 关闭便签不决策 | 点击 × → 超时后 fallback |
| Codex | Codex 中触发 → Allow/Deny 生效 |
| status | `ccn status --all` 显示审批状态 |
| 禁用 | `ccn set approval.enabled=false` → 走通知模式 |

**自检命令：**

```bash
node bin/ccn.js status --all

# 模拟审批请求
echo '{"session_id":"test123","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo hello"},"cwd":"/tmp"}' | \
  node ~/.cc-notify/approval-hook.js --provider claude

# 探活
curl -s http://127.0.0.1:23333/state
```

---

## 实现文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `scripts/approval-hook.js` | **新增** | 阻塞型 hook wrapper |
| `scripts/approval-server.js` | **新增** | 本地审批中枢 HTTP 服务 |
| `scripts/sticky-window.swift` | **修改** | 新增审批 UI 模式 |
| `scripts/notify.sh` | 不动 | 继续处理非审批事件 |
| `lib/commands/init.js` | **修改** | 新增 PermissionRequest hook |
| `lib/commands/status.js` | **修改** | 新增审批状态检查 |
| `lib/commands/uninit.js` | **修改** | 新增审批 hook 清理 |
| `lib/commands/set.js` | **修改** | 新增审批配置项 |
| `lib/utils.js` | **修改** | Codex 兼容 + runtime path |
| `scripts/postinstall.js` | **修改** | 复制审批脚本 |
| `docs/DESIGN.md` | **修改** | 更新架构说明 |

---

## 参考

- Claude Code hooks 官方文档：https://code.claude.com/docs/en/hooks.md
- clawd-on-desk 审批机制调研：`/Users/admin/IdeaProjects/bucle/clawd-on-desk-bucle/docs/investigations/approval-mechanism.md`
- 核查结论（内部）：PermissionRequest 协议与 fallback 行为已确认
