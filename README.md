# cc-notify

macOS 浮动便签通知系统，专为 Claude Code 和 Codex 事件设计。

当 Claude Code 或 Codex 完成任务、需要权限确认或进入工作状态时，在屏幕右上角显示一个钉住的黄色便签窗口。

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

Codex：

```bash
ccn init --codex
```

**更新：**

```bash
npm update -g @bucle/cc-notify
```

---

## 命令参考

| 命令 | 说明 |
|---|---|
| `ccn init` | 向 `~/.claude/settings.json` 写入 cc-notify hooks，自动备份原文件，自动迁移旧 `cc-sticky-notify` 路径，幂等操作 |
| `ccn init --codex` | 向 `~/.codex/hooks.json` 写入 cc-notify hooks，并在 `~/.codex/config.toml` 启用 `features.codex_hooks` |
| `ccn init --all` | 同时配置 Claude Code 和 Codex |
| `ccn uninit` | 从 `settings.json` 删除 cc-notify hooks，自动备份原文件 |
| `ccn uninit --codex` | 只从 `~/.codex/hooks.json` 删除 cc-notify hooks，保留其它 Codex hooks |
| `ccn uninit --all` | 同时删除 Claude Code 和 Codex 的 cc-notify hooks |
| `ccn status` | 检查安装状态（二进制、hooks、配置） |
| `ccn status --codex` | 检查 Codex feature flag 和 hooks 配置 |
| `ccn status --all` | 同时检查 Claude Code 和 Codex hooks |
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

## notify.sh flags

`notify.sh` 支持以下 flag，可任意顺序组合，必须位于内容参数之前：

| Flag | 说明 |
|---|---|
| `--urgent` | 以红色高亮主题展示便签，用于需要立即关注的事件 |
| `--force` | 跳过去重检查，即使内容与上次完全相同也强制触发通知 |
| `--provider claude\|codex` | 指定 hook 来源，用 provider 前缀隔离会话状态 |

```bash
# 仅 urgent
notify.sh --urgent "Permission required"

# 仅 force（相同内容也触发）
notify.sh --force "Task completed"

# 组合使用（顺序任意）
notify.sh --urgent --force "Critical error"
```
