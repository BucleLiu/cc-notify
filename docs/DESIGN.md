# cc-notify

macOS 浮动便签通知系统，专为 Claude Code 事件设计。

当 Claude Code 完成任务、需要权限确认或遇到错误时，在屏幕右上角显示一个钉住的黄色便签窗口。

---

## 目录

- [系统要求](#系统要求)
- [快速安装](#快速安装)
- [命令参考](#命令参考)
- [配置说明](#配置说明)
- [架构设计](#架构设计)
- [本地开发与测试](#本地开发与测试)
- [npm 发布操作](#npm-发布操作)
- [故障排查](#故障排查)

---

## 系统要求

- macOS 12 Monterey 或更高版本
- Node.js 16+
- Xcode Command Line Tools（用于编译 Swift）

```bash
xcode-select --install
```

---

## 快速安装

```bash
npm install -g @bucle/cc-notify
ccn init
```

`npm install` 通过 `postinstall` 钩子自动编译 Swift 浮动窗口应用。`ccn init` 将 hook 配置写入 Claude Code 的 `~/.claude/settings.json`。

**更新：**

```bash
npm update -g @bucle/cc-notify
```

npm 会自动重新执行 `postinstall`——更新 `notify.sh` 并在版本变化时重新编译 Swift 应用。无需手动修改 `settings.json`（hooks 指向稳定的 `~/.cc-notify/` 路径）。

---

## 命令参考

| 命令 | 说明 |
|---|---|
| `ccn init` | 向 `~/.claude/settings.json` 写入 cc-notify hooks，自动备份原文件，自动迁移旧 `cc-sticky-notify` 路径，幂等操作。`--codex` 配置 Codex，`--all` 两者都配置 |
| `ccn uninit` | 删除 cc-notify hooks，自动备份原文件。支持 `--codex` / `--all` |
| `ccn status` | 检查安装状态（二进制、hooks、审批服务、配置）。支持 `--codex` / `--all` |
| `ccn test` | 发送一条测试通知 |
| `ccn update` | 重新复制 `notify.sh` 并重编译 Swift 应用 |
| `ccn update --recompile` | 强制重编译，即使版本号未变化 |
| `ccn set` | 查看当前所有配置 |
| `ccn set key=value` | 设置配置值（支持点号嵌套路径） |

---

## 配置说明

配置存储在 `~/.cc-notify/env.json`，并自动生成为 `~/.cc-notify/env.sh` 中的 shell 导出语句，由 `notify.sh` 在运行时 source。

```bash
# 5 分钟无操作后自动关闭（默认 3600 秒 = 1 小时）
ccn set close_timeout=300

# 查看全部配置
ccn set
```

| 配置键 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `close_timeout` | `CC_STICKY_NOTIFY_CLOSE_TIMEOUT` | `10800` | 窗口闲置自动关闭的秒数，每次新通知到来时重置计时器 |

---

## 架构设计

### 总览

cc-notify 由三层组成：**CLI 管理层**（Node.js）、**通知触发层**（Bash）、**UI 展示层**（Swift/macOS），三层通过稳定的文件路径 `~/.cc-notify/` 松耦合。

```
Claude Code
    │  触发 Hook 事件（stdin JSON）
    ▼
~/.cc-notify/notify.sh          ← 通知触发层（Bash）
    │  写入 /tmp/cc-notify/<session>.txt
    ▼
~/.cc-notify/sticky-notify.app  ← UI 展示层（Swift NSWindow）
    │  DispatchSource 监听文件变化
    ▼
屏幕右上角浮动便签
```

---

### 目录结构

```
cc-notify/                        ← 仓库/npm 包根目录
├── package.json                  ← npm 包定义（无构建工具，纯 CommonJS）
├── .npmignore                    ← npm 发布排除规则
│
├── bin/
│   └── ccn.js                    ← CLI 入口（#!/usr/bin/env node）
│
├── lib/
│   ├── utils.js                  ← 共享工具函数 + 所有路径常量
│   └── commands/
│       ├── init.js               ← ccn init：写入 Claude Code hooks
│       ├── uninit.js             ← ccn uninit：删除 hooks
│       ├── status.js             ← ccn status：检查安装状态
│       ├── test.js               ← ccn test：发送测试通知
│       ├── update.js             ← ccn update：重新安装脚本/重编译
│       └── set.js                ← ccn set：管理 env.json 配置
│
└── scripts/
    ├── notify.sh                 ← 主通知脚本（Claude Code hook 实际调用）
    ├── sticky-window.swift       ← Swift 浮动窗口源码（~1144 行）
    ├── postinstall.js            ← npm postinstall 脚本（编译 Swift）
    ├── test.sh                   ← 本地回归测试套件（T1-T10，不随包发布）
    ├── sticky-notify-app         ← 预编译二进制（本地开发产物，不随包发布）
    └── sticky-notify.app/        ← App Bundle（本地开发产物，不随包发布）

~/.cc-notify/                     ← 稳定安装目录（npm 更新不影响 hook 路径）
├── notify.sh                     ← 从包复制过来的运行时脚本
├── sticky-notify.app/            ← 本地编译的 Swift 应用 Bundle
├── env.json                      ← 用户配置（ccn set 管理）
├── env.sh                        ← 自动生成的 shell 导出（notify.sh 运行时 source）
└── .version                      ← 已安装的包版本（用于跳过不必要的重编译）
```

---

### npm 安装流程

```
npm install -g @bucle/cc-notify
    │
    └─► scripts/postinstall.js 自动触发
            ├── 检查平台（非 darwin 直接退出）
            ├── 检查 Xcode CLT（xcode-select -p）
            ├── mkdir -p ~/.cc-notify/
            ├── 复制 scripts/notify.sh → ~/.cc-notify/notify.sh
            ├── 编译 Swift（可跳过条件：binary 存在 && .version 版本匹配）
            │       swiftc sticky-window.swift → ~/.cc-notify/sticky-notify-app
            │       写 Info.plist → 构建 .app Bundle
            │       codesign --deep（ad-hoc 签名）
            ├── 初始化 ~/.cc-notify/env.json（默认 close_timeout=10800）
            ├── 生成 ~/.cc-notify/env.sh（shell 导出）
            └── 写 ~/.cc-notify/.version（当前包版本）
```

---

### 运行时通知数据流

Claude Code 触发 Hook 时，通过 **stdin** 传入 JSON（如 `{"session_id":"abcd1234xxxx","hook":"Stop"}`），`notify.sh` 按以下步骤处理：

```
notify.sh
  ├── [1] 解析 --urgent 标志（首个参数）
  ├── [2] 从 stdin JSON 提取 session_id 前 8 位作 SESSION_KEY
  ├── [3] 确定通知内容（命令行参数 或 stdin Stop 模式）
  ├── [4] 走进程树（ps，最多 12 层）找所有祖先 PID
  ├── [5] osascript → System Events：获取 GUI App 名/窗口标题/坐标
  ├── [6] osascript -l JavaScript → CGWindowID 精确捕获
  ├── [7] 内容去重：对比 .sig 文件（Time 行不参与比对）
  │        └── 内容相同 → exit 0（静默跳过，避免刷屏）
  ├── [8] 写通知内容到 /tmp/cc-notify/${SESSION_KEY}.txt
  │        └── urgent 模式：第一行写 __URGENT__ 哨兵
  ├── [9] 检查 .pid 文件：进程仍存活 → exit 0（窗口通过 DispatchSource 自刷新）
  └── [10] 启动 ~/.cc-notify/sticky-notify.app（后台 disown）
```

**Swift 浮动窗口（sticky-notify.app）运行机制：**

```
启动后
  ├── 写 /tmp/cc-notify/${SESSION_KEY}.pid
  ├── 计算屏幕槽位（slot allocation，多个 session 窗口不重叠）
  ├── 读取并渲染 .txt 文件内容，解析 __URGENT__ 哨兵决定主题色
  ├── DispatchSource 监听 .txt 文件 write 事件
  │        └── 文件变化 → reloadContent() → updateLabels() → applyTheme() → animatePulse()
  ├── 点击行为
  │        ├── urgent 状态：dismissUrgent() 解除紧急样式
  │        ├── 折叠状态：expandWindow()
  │        └── 展开状态：focusTerminal() 跳回触发的终端窗口
  │                focusTerminal 四级定位策略：
  │                  策略0: CGWindowID 精确匹配（最准确）
  │                  策略1: 标题 + 位置组合匹配
  │                  策略2: 仅标题匹配
  │                  策略3: 仅位置匹配（唯一时）
  └── 自动关闭计时器（CC_STICKY_NOTIFY_CLOSE_TIMEOUT，每次通知到来时重置）
```

---

### 配置数据流

```
ccn set close_timeout=300
    ├── 读 ~/.cc-notify/env.json
    ├── setNestedValue(obj, "close_timeout", 300)  ← 支持 dot notation 嵌套
    └── writeEnvJson(obj)
            ├── 写 ~/.cc-notify/env.json
            └── regenerateEnvSh(obj)
                    ├── flattenEnvObj() → [["close_timeout", 300]]
                    ├── resolveEnvVarName() → "CC_STICKY_NOTIFY_CLOSE_TIMEOUT"
                    └── 写 ~/.cc-notify/env.sh:
                            export CC_STICKY_NOTIFY_CLOSE_TIMEOUT='300'

运行时：notify.sh → source ~/.cc-notify/env.sh → Swift app 读 ProcessInfo.environment
```

---

### Hooks 配置（ccn init 写入内容）

`ccn init` 同时支持 Claude Code 与 Codex 两个 provider。默认配置 Claude Code；`ccn init --codex` 配置 Codex；`ccn init --all` 两者都配置。所有操作幂等，已存在则跳过或更新。

**Claude Code**（写入 `~/.claude/settings.json`）：

| 事件 | matcher | 命令 | 说明 |
|---|---|---|---|
| `Stop` | — | `notify.sh --urgent --state completed` | ✅ 任务完成 |
| `SessionEnd` | — | `notify.sh --state close` | 关闭并清理便签 |
| `PostToolUse` | — | `notify.sh --state working` | ⏳ 工作中 |
| `UserPromptSubmit` | — | `notify.sh --state working` | ⏳ 工作中 |
| `PermissionRequest` | `*` | `approval-hook.js --provider claude` | 🔐 真审批（见下） |

**Codex**（写入 `~/.codex/hooks.json`，并在 `~/.codex/config.toml` 开启 `[features] hooks = true`）：

| 事件 | matcher | 命令 | 说明 |
|---|---|---|---|
| `Stop` | — | `notify.sh --provider codex --urgent --state completed` | ✅ 任务完成 |
| `PermissionRequest` | `.*` | `approval-hook.js --provider codex`（`timeout: 600`） | 🔐 真审批 |
| `UserPromptSubmit` | — | `notify.sh --provider codex --state working` | ⏳ 工作中 |
| `PostToolUse` | — | `notify.sh --provider codex --state working` | ⏳ 工作中 |

> **退出会话关闭便签**：Claude Code 有真正的 `SessionEnd` hook（见上表）直接 `--state close`。Codex 的 hook 事件包含 `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `PostToolUse` / `Stop`，但**没有 SessionEnd**。因此 Codex 的"退出关闭"由 `notify.sh` 内的 `ensure_codex_watcher` 实现：每次 Codex hook 调用（非 close 状态）时，沿进程树向上找到 Codex 主进程（`comm` 为 `codex` 的最上层祖先），启动一个轻量后台 watcher 每 5s 轮询该 PID；PID 消失（Codex 退出）即调用 `notify.sh --provider codex --state close --session <key>` 关闭并清理对应会话的便签。watcher 按 `<provider>-<session>.watcher` 文件去重，同一会话只保留一个；找不到 Codex 祖先（手动调用/测试）时跳过，退化为 Swift app 的空闲自动关闭（`CC_STICKY_NOTIFY_CLOSE_TIMEOUT`）兜底。该机制对 Claude Code 零影响（`ensure_codex_watcher` 仅在 `--provider codex` 时生效）。

所有 hook 命令引用 `$HOME/.cc-notify/` 下的稳定路径（`notify.sh` / `approval-hook.js`），npm 更新后通常无需重新运行 `ccn init`。

操作前自动备份：
- Claude Code：`~/.claude/settings.json.bak.YYYYMMDD-HHMMSS`
- Codex：`~/.codex/hooks.json.bak.*` 与 `~/.codex/config.toml.bak.*`

---

### 审批机制（PermissionRequest 真审批）

cc-notify 不仅在权限请求时弹便签提醒，还支持**在便签上直接 Allow / Deny / Always**，决策回传给 Claude Code 或 Codex，形成真审批闭环。

```
Claude Code / Codex 触发 PermissionRequest
    │  stdin JSON（tool_name / tool_input / session_id / transcript_path / ...）
    ▼
~/.cc-notify/approval-hook.js        ← 阻塞型 hook wrapper（按 --provider 区分）
    │  POST /approval（阻塞等待决策）
    ▼
~/.cc-notify/approval-server.js      ← 本地审批中枢（127.0.0.1，端口 23333-23337）
    │  写 /tmp/cc-notify/<provider-session>.txt（__APPROVAL__ 哨兵）
    │  写 /tmp/cc-notify/<provider-session>.approval.json
    │  启动/复用 Swift 便签
    ▼
~/.cc-notify/sticky-notify.app       ← Swift 便签审批态（红底 + Allow/Deny/Always 按钮）
    │  用户点击 → POST /decision
    ▼
approval-server.js resolve pending   ← 回写挂起的 /approval 响应
    │  更新 .txt 为 ✅ Approved / 🚫 Denied
    ▼
approval-hook.js stdout              ← adapter 输出决策 JSON → agent 执行或拒绝
```

**Provider 适配（adapter）：** allow/deny 输出格式 Claude Code 与 Codex 一致，均为：

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

deny 时附加 `"message"`。两者的关键差异在 **no-decision（超时/失败回退）**：

| Provider | no-decision stdout | 回退行为 |
|---|---|---|
| Claude Code | 空（`null`） | 回退 CC 原生审批 |
| Codex | `{}` | 回退 Codex 原生审批 |

**会话键一致性：** 审批便签与后续通知便签必须复用同一窗口（`<provider>-<session>.txt`）。`approval-hook.js` 与 `notify.sh` 共用同一套会话键算法：Codex 优先从 `transcript_path` 文件名（`rollout-...-<uuid>.jsonl`）提取 UUID，回退 `session_id` / `turn_id`；Claude Code 的 `transcript_path` 不匹配 `rollout-` 模式，回退 `session_id`，行为不变。

**Codex 审批要点：**
- `PermissionRequest` hook 必须配 `timeout: 600`（秒），否则 Codex 默认超时太短，用户还没点便签 hook 就被杀。
- 审批 HTTP 超时默认 480s < hook 600s，留足缓冲让 hook 输出 `{}` 后退出。
- no-decision 输出 `{}`（非空 stdout），对齐 Codex 期望的回退格式。

**Allow Always：** 仅当前 session 内生效（`approval-server.js` 内存，进程退出即失效），按 `provider:sessionId` + toolName 匹配，不做跨 session 持久化。

**Fallback 原则：** 任何失败路径（服务不可用、启动超时、审批超时、Swift 未响应）都回退到 provider 原生审批，**绝不替用户默认 allow 或 deny**。

> 完整设计见 `docs/superpowers/specs/2026-06-25-approval-mechanism-design.md`（原始设计）与 `docs/superpowers/specs/2026-06-29-codex-approval-design.md`（Codex 对齐修复）。

---

### npm 发布内容

包通过 `package.json` 的 `files` 白名单精确控制发布内容：

| 发布内容 | 说明 |
|---|---|
| `bin/ccn.js` | CLI 入口 |
| `lib/` | 所有命令模块 + utils |
| `scripts/notify.sh` | 运行时 Bash 通知脚本 |
| `scripts/sticky-window.swift` | Swift 源码（用户本地编译） |
| `scripts/postinstall.js` | npm install 时自动触发的编译脚本 |

**不随包发布：** 预编译二进制 `sticky-notify-app`、App Bundle `sticky-notify.app/`、本地测试脚本 `test.sh`、`.claude/` 配置目录。

**核心设计原则：** Swift 二进制不随包分发，每位用户安装时通过 `postinstall.js` 在本地用 `swiftc` 编译，确保与本机系统兼容。

---

## 本地开发与测试

### 环境准备

```bash
# 克隆仓库
git clone <repo-url>
cd skill-vault/cc-notify

# 确保有 Xcode CLT
xcode-select --install

# 本地链接（可直接使用 ccn 命令）
npm link
```

### 开发调试

```bash
# 手动触发 postinstall（重新编译 Swift，安装脚本）
node scripts/postinstall.js

# 强制重编译 Swift（忽略版本缓存）
CC_NOTIFY_FORCE_RECOMPILE=1 node scripts/postinstall.js

# 直接测试通知脚本
~/.cc-notify/notify.sh '🧪 本地测试通知'

# 通过 CLI 发送测试通知
ccn test

# 检查完整安装状态
ccn status
```

### 运行回归测试套件

`scripts/test.sh` 包含 T1–T10 共 10 项回归测试，覆盖：
- T1: 二进制存在性检查
- T2: session_id 解析
- T3: 基础通知发送
- T4: 窗口复用（同 session 不重启进程）
- T5: 多 session 槽位分配
- T6: 内容去重
- T7: 工作目录切换弹性
- T8: 进程树位置捕获
- T9: urgent 模式
- T10: 通知内容更新刷新

```bash
# 运行完整回归测试
bash scripts/test.sh

# 运行单项测试（如只跑 T3）
bash scripts/test.sh T3
```

### 旧路径迁移测试

```bash
# 测试 ccn init 迁移旧版 cc-sticky-notify 路径
ccn init
# 查看备份文件
ls ~/.claude/settings.json.bak.*
```

### 调试 notify.sh

```bash
# 模拟 Claude Code Stop 事件（带 session_id）
echo '{"session_id":"abcd1234test","hook":"Stop"}' | ~/.cc-notify/notify.sh '✅ 手动测试'

# 模拟 urgent 通知
echo '{"session_id":"abcd1234test","hook":"Notification"}' | ~/.cc-notify/notify.sh --urgent '🔐 权限请求'

# 查看临时文件内容
ls /tmp/cc-notify/
cat /tmp/cc-notify/abcd1234.txt
```

### 调试配置管理

```bash
# 查看当前配置
ccn set

# 设置关闭超时
ccn set close_timeout=60

# 查看生成的 env.sh
cat ~/.cc-notify/env.sh

# 查看原始 env.json
cat ~/.cc-notify/env.json
```

### 取消本地链接

```bash
npm unlink -g @bucle/cc-notify
```

---

## npm 发布操作

### 发布前检查

```bash
# 1. 确认包含文件列表正确
npm pack --dry-run

# 2. 实际打包预览（生成 .tgz 但不发布）
npm pack
tar -tzf bucle-cc-notify-*.tgz   # 查看包内容
rm bucle-cc-notify-*.tgz          # 清理

# 3. 确认版本号
node -e "console.log(require('./package.json').version)"

# 4. 检查 npm 登录状态
npm whoami
```

### 更新版本号

```bash
# 补丁版本（bug 修复）：1.0.0 → 1.0.1
npm version patch

# 次版本（新功能）：1.0.0 → 1.1.0
npm version minor

# 主版本（破坏性变更）：1.0.0 → 2.0.0
npm version major

# 手动指定版本
npm version 1.2.3
```

`npm version` 会自动创建 git tag，版本号写入 `package.json`。

### 发布

```bash
# 发布到 npm（公开包）
npm publish --access public

# 发布前预览（不实际发布）
npm publish --dry-run --access public
```

### 发布后验证

```bash
# 确认包已上线
npm info @bucle/cc-notify

# 测试全新安装
npm install -g @bucle/cc-notify
ccn status
ccn test
```

### 发布到私有 registry（如有需要）

```bash
# 临时指定 registry
npm publish --registry https://your-registry.com --access public

# 或在 package.json 中添加 publishConfig
# "publishConfig": { "registry": "https://your-registry.com" }
```

---

## 故障排查

**没有弹出便签**

```bash
ccn status          # 查看哪个环节出问题
ccn test            # 直接验证 notify.sh 是否工作
ccn update          # 重新复制脚本并重编译
```

**`xcode-select: error: invalid active developer path`**

```bash
sudo xcode-select --reset
# 或
xcode-select --install
ccn update --recompile
```

**`notify.sh: Permission denied`**

```bash
chmod +x ~/.cc-notify/notify.sh
```

**从旧版 cc-sticky-notify skill 迁移**

```bash
ccn init    # 自动迁移旧路径，并补全缺失的 hooks
```

**查看 Swift 窗口进程**

```bash
pgrep -l sticky-notify
ps aux | grep sticky-notify
```

**手动清理所有状态**

```bash
ccn uninit                          # 删除 hooks
rm -rf ~/.cc-notify/                # 删除安装目录
rm -f /tmp/cc-notify/*.txt          # 清理临时文件
rm -f /tmp/cc-notify/*.pid
```
