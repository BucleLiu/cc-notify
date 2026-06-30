# Ghostty 终端精准聚焦方案

> 设计日期：2026-06-30
> 状态：待审核
> 参考：clawd-on-desk-bucle `docs/investigations/window-focus-mechanism.md`

## 1. 问题

当前 cc-notify 点击便签时，`focusTerminal()` 使用 AX Accessibility API 做通用窗口匹配，只能激活 Ghostty **应用窗口**，无法切换到运行 Claude Code 会话的那个具体 **分屏/surface**。

用户在 Ghostty 的某个 split 中运行 Claude Code，后续切换到其他 split 工作，再点击便签时 Ghostty 被激活但停留在当前 split，丢失了会话上下文。

## 2. 目标

- Ghostty 分屏场景：点击便签后精准聚焦到会话所在的 surface
- 对其他应用（iTerm2、Terminal、VS Code 等）零影响
- 纯增量改动，现有聚焦逻辑一字不改

## 3. 方案概述

核心思路来自 Clawd：**Hook 触发时采集 Ghostty terminal ID，聚焦时用 ID 精准定位**。

Ghostty 每个 surface（分屏/标签页）有唯一 `id` 属性，AppleScript 支持按 ID 遍历和聚焦。在 Hook 触发时刻（用户正在该 surface 中交互），这是捕获 ID 的最佳窗口。

```
Hook 触发时 (notify.sh)                    点击便签时 (sticky-window.swift)
────────────────────────                  ───────────────────────────────
进程树遍历 → SOURCE_APP=Ghostty           appName == "Ghostty"?
  ├─ 采集 terminal ID ──→ .ghostty-tid      ├─ 是 → focusGhosttyTerminal()
  └─ 采集 shell TTY   ──→ .ghostty-tty      │        ├─ L1: ID 匹配 ✓
                                             │        ├─ L2: TTY 匹配（备用）
会话关闭时：清理上述文件                    │        └─ 失败 → 回退通用匹配
                                             └─ 否 → 现有通用匹配（不变）
```

## 4. 改造点

### 4.1 notify.sh — Hook 时采集 Ghostty 元数据

**位置**：现有进程树遍历和 SOURCE_APP 写入之后（约第 407 行）

**新增状态文件**：

| 文件 | 内容 | 写入时机 |
|------|------|----------|
| `<STATE_KEY>.ghostty-tid` | Ghostty terminal ID（如 `abc-def-123`） | 首次触发，`SOURCE_APP=Ghostty` |
| `<STATE_KEY>.ghostty-tty` | shell 进程 TTY（如 `ttys001`） | 同上，作为备用匹配键 |

**采集逻辑**：

```bash
if [ "$SOURCE_APP" = "Ghostty" ]; then
    GHOSTTY_TID_FILE="$TMP_DIR/${STATE_KEY}.ghostty-tid"
    GHOSTTY_TTY_FILE="$TMP_DIR/${STATE_KEY}.ghostty-tty"

    # 采集 terminal ID + TTY（合并在一次 AppleScript 调用中，仅首次）
    # terminal ID 是 Ghostty 每个 surface 的唯一标识，TTY 是 shell 的设备名
    if [ ! -f "$GHOSTTY_TID_FILE" ]; then
        _tid_info=$(osascript -e \
            'tell application "Ghostty"
                set ft to focused terminal of selected tab of front window
                return (id of ft) & "|" & (tty of ft)
            end tell' 2>/dev/null)
        if [ -n "$_tid_info" ]; then
            _tid="${_tid_info%%|*}"
            _tty="${_tid_info#*|}"
            [ -n "$_tid" ] && printf '%s\n' "$_tid" > "$GHOSTTY_TID_FILE"
            [ -n "$_tty" ] && [ "$_tty" != "$_tid" ] && printf '%s\n' "$_tty" > "$GHOSTTY_TTY_FILE"
        fi
    fi
fi
```

**关键设计决策**：
- terminal ID 和 TTY 合在一次 AppleScript 调用中采集，避免两次进程启动开销
- 仅在首次 Hook 触发时写入（`[ ! -f … ]`），理由同现有 `.window` / `.pos` / `.wid` ——首次 Hook 时用户正在该 surface 交互，上下文最准确
- `tty` 是 Ghostty terminal 对象的属性，直接返回 shell 对应的设备名（如 `ttys001`），无需解析进程树
- 关闭状态（`--state close`）时随其他临时文件一起清理

**改动量**：约 40 行

**额外清理点**：

`notify.sh` 关闭分支（`--state close`）需要在现有 `rm -f` 列表中追加：
```
"$TMP_DIR/${STATE_KEY}.ghostty-tid" \
"$TMP_DIR/${STATE_KEY}.ghostty-tty" \
```

### 4.2 sticky-window.swift — 聚焦时使用 Ghostty 元数据

#### 4.2.1 新增属性

```swift
var ghosttyTidFilePath: String   // .../<STATE_KEY>.ghostty-tid
var ghosttyTtyFilePath: String   // .../<STATE_KEY>.ghostty-tty
```

在 `init(contentFilePath:)` 中从 base 路径推导。

#### 4.2.2 新增方法 `focusGhosttyTerminal()`

```swift
/// Ghostty 专用聚焦：terminal ID → TTY → 回退通用匹配
/// 返回 true 表示已成功聚焦，false 表示需要走通用兜底
func focusGhosttyTerminal(app: NSRunningApplication) -> Bool
```

**策略级联**：

| 层级 | 策略 | AppleScript | 精度 | 说明 |
|------|------|-------------|------|------|
| L1 | Terminal ID | `repeat with term in terminals … if id of term = targetId then focus term` | surface 级 | 最可靠，ID 终身不变 |
| L2 | TTY 匹配 | `every terminal whose tty ends with "<tty>"` | surface 级 | ID 缺失时备用 |
| L3 | PID 匹配 | `every terminal whose pid is <pid>` | 进程级 | Ghostty AppleScript 内置筛选 |
| L4 | CWD 匹配 | `every terminal whose working directory is "<cwd>"` | 目录级 | 同目录多项目时有歧义 |
| 兜底 | 通用匹配 | 现有 AX 窗口匹配 | 窗口级 | 至少激活 Ghostty |

L1 AppleScript 模板（参考 Clawd focus.js:1503-1513）：

```applescript
tell application "Ghostty"
    set targetId to "<id>"
    repeat with w in windows
        repeat with t in tabs of w
            repeat with term in terminals of t
                if id of term is targetId then
                    focus term
                    return "ok-id"
                end if
            end repeat
        end repeat
    end repeat
end tell
```

成功后调用 `app.activate(options: [])` 确认为前台应用。

**执行方式**：`Process` 调用 `/usr/bin/osascript -e "..."`，同步等待返回（超时 3s）。

注意：Ghostty 没有提供获取 AX windows 的标准方式（其 surface 不是独立 NSWindow），所以 L1-L4 都通过 AppleScript 操作 Ghostty 内部对象模型，不走 AX API。

#### 4.2.3 修改 `focusTerminal()`

在 app 查找成功后、AX 窗口匹配前，插入分支：

```swift
// 现有: 找到了 app
debugLog("app found pid=\(app.processIdentifier)")

// 新增: Ghostty 专用聚焦分支
if appName == "Ghostty" {
    if focusGhosttyTerminal(app: app) {
        debugLog("MATCH ghostty: terminal focused")
        return
    }
    debugLog("ghostty focus failed, fallback to generic")
}

// 现有: 走 AX 窗口匹配...
```

#### 4.2.4 清理

`applicationWillTerminate()` 中新增清理 `.ghostty-tid`、`.ghostty-tty` 文件。

**改动量**：约 80 行

## 5. 隔离性保证

| 层级 | 守卫 | 影响范围 |
|------|------|----------|
| `notify.sh` | `[ "$SOURCE_APP" = "Ghostty" ]` | 仅 Ghostty 会话写入新文件 |
| `sticky-window.swift` | `if appName == "Ghostty"` | 仅 Ghostty 聚焦走新路径 |
| 所有其他应用 | 两条 guard 都不满足 | 代码路径和现在完全一致 |

新增文件（`.ghostty-tid`、`.ghostty-tty`）命名空间复用 `STATE_KEY`，会话关闭时随现有 `.pid`、`.sig`、`.focus` 等一起清理，无泄漏风险。

## 6. 与 Clawd 方案的差异

| 维度 | Clawd | cc-notify（本方案） |
|------|-------|---------------------|
| ID 捕获时机 | SessionStart 专用事件触发 | 任意 Hook 首次触发（用户当时就在该 surface） |
| TTY 匹配 | ✅ | ✅ 作为 L2 备用 |
| tmux/cmux/VS Code | ✅ 完整支持 | ❌ 不做，保持最小改动 |
| 聚焦缓存 | session 级缓存 + 节流去重 | 不需要（点击聚焦频率极低） |
| 平台 | macOS + Windows + Linux | macOS only（cc-notify 本身就是 macOS only） |

## 7. 风险与边界

| 风险 | 缓解 |
|------|------|
| Ghostty AppleScript 支持被禁用 | L1-L4 全部失败后回退通用匹配，至少激活窗口 |
| Hook 时 terminal ID 采集失败 | 有 L2 TTY 备用；TTY 也失败则走 L3/L4/兜底 |
| 会话中途 terminal 被关闭 | ID 不存在于任何 terminal → 匹配失败 → 走备用链 |
| AppleScript 执行慢（>3s） | Process.waitUntilExit 设超时，超时返回 false 走兜底 |
| 多 Ghostty 窗口同 CWD | L4 可能匹配到错误的窗口，但 L1 ID 匹配不存在此问题 |

## 8. 测试要点

1. **基本场景**：Ghostty 单窗口单 tab → 点击便签 → 聚焦到正确窗口
2. **分屏场景**：Ghostty 同一 tab 多个 split，Claude Code 在 split B → 切换到 split A → 点击便签 → 聚焦回 split B
3. **多 tab 场景**：Ghostty 多 tab，Claude Code 在 tab 2 → 切换到 tab 1 → 点击便签 → 聚焦回 tab 2 的对应 surface
4. **多窗口场景**：两个 Ghostty 窗口各运行一个 Claude Code → 两个便签各自的聚焦独立正确
5. **退化场景**：Ghostty AppleScript 不可用 → 回退到现有通用窗口激活
6. **非 Ghostty 回归**：iTerm2、Terminal.app 聚焦行为不变
