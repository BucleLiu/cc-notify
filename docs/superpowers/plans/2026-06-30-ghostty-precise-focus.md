# Ghostty 精准聚焦实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 cc-notify 的 Ghostty 终端实现 surface 级精准聚焦，点击便签后定位到会话所在的具体分屏

**Architecture:** Hook 触发时在 notify.sh 中采集 Ghostty terminal ID + TTY（一次 AppleScript 调用），存入 `.ghostty-tid` / `.ghostty-tty` 文件。点击聚焦时 sticky-window.swift 先尝试 Ghostty 专用聚焦链（ID→TTY→PID→CWD），失败则回退现有通用匹配。非 Ghostty 应用代码路径完全不变。

**Tech Stack:** Bash (notify.sh), Swift 5 + AppKit + ApplicationServices (sticky-window.swift), AppleScript (Ghostty automation)

## Global Constraints

- 仅 macOS，不对其他平台做适配
- 纯增量改动，不修改任何现有聚焦逻辑
- 非 Ghostty 应用行为零变化（两层 guard: bash `[ "$SOURCE_APP" = "Ghostty" ]` + Swift `appName == "Ghostty"`）
- 新增状态文件遵循现有命名规范：`/tmp/cc-notify/<STATE_KEY>.ghostty-tid`、`.ghostty-tty`
- 关闭会话时清理所有新增文件

---

### Task 1: notify.sh — Hook 时采集 Ghostty terminal ID + TTY

**Files:**
- Modify: `scripts/notify.sh:280-291` (close cleanup)
- Modify: `scripts/notify.sh:406-407` (after SOURCE_APP capture)

**Interfaces:**
- Consumes: `SOURCE_APP`（已在前面从 System Events AppleScript 获取）、`TMP_DIR`、`STATE_KEY`
- Produces: `/tmp/cc-notify/<STATE_KEY>.ghostty-tid`、`/tmp/cc-notify/<STATE_KEY>.ghostty-tty`

- [ ] **Step 1: 在 close 分支的清理列表中添加 Ghostty 文件**

在 `scripts/notify.sh:280-290` 的 `rm -f` 列表末尾添加两行：

```bash
    rm -f "$CONTENT_FILE" \
          "$TMP_DIR/${STATE_KEY}.sig" \
          "$TMP_DIR/${STATE_KEY}.focus" \
          "$TMP_DIR/${STATE_KEY}.window" \
          "$TMP_DIR/${STATE_KEY}.pos" \
          "$TMP_DIR/${STATE_KEY}.wid" \
          "$TMP_DIR/${STATE_KEY}.project" \
          "$TMP_DIR/${STATE_KEY}.slot" \
          "$TMP_DIR/${STATE_KEY}.watcher" \
          "$TMP_DIR/${STATE_KEY}.ghostty-tid" \
          "$TMP_DIR/${STATE_KEY}.ghostty-tty" \
          2>/dev/null
```

- [ ] **Step 2: 在 SOURCE_APP 捕获之后添加 Ghostty 元数据采集**

在 `scripts/notify.sh:406` 之后（`fi` 闭合 SOURCE_APP 检测块之后，`# Append Source` 注释之前）插入：

```bash
# ── Ghostty: capture terminal ID + TTY for surface-level precise focus ─────
# terminal ID uniquely identifies each split/tab surface; TTY is the fallback
# match key.  Both are captured in a single AppleScript call — only on the
# first hook invocation, when the user is actively interacting with this surface.
if [ "$SOURCE_APP" = "Ghostty" ]; then
    GHOSTTY_TID_FILE="$TMP_DIR/${STATE_KEY}.ghostty-tid"
    GHOSTTY_TTY_FILE="$TMP_DIR/${STATE_KEY}.ghostty-tty"
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
        _log "GHOSTTY tid=$_tid tty=$_tty"
    fi
fi
```

- [ ] **Step 3: 语法检查**

```bash
bash -n scripts/notify.sh
```
Expected: 无输出，退出码 0

- [ ] **Step 4: Commit**

```bash
git add scripts/notify.sh
git commit -m "feat(notify): capture Ghostty terminal ID + TTY at hook time for precise focus"
```

---

### Task 2: sticky-window.swift — 添加 Ghostty 专用聚焦

**Files:**
- Modify: `scripts/sticky-window.swift:400-412` (init — add new file paths)
- Modify: `scripts/sticky-window.swift:860-1006` (focusTerminal — add Ghostty branch + new method)
- Modify: `scripts/sticky-window.swift:1626-1643` (applicationWillTerminate — add cleanup)

**Interfaces:**
- Consumes: `.ghostty-tid`、`.ghostty-tty` 文件（由 Task 1 写入）
- Produces: `focusGhosttyTerminal(app:) -> Bool` 方法

- [ ] **Step 1: 在 init 中添加 Ghostty 文件路径属性**

在 `scripts/sticky-window.swift:400-412`，`init(contentFilePath:)` 的属性初始化块中添加两条：

```swift
init(contentFilePath: String) {
    self.contentFilePath = contentFilePath
    let base = contentFilePath.hasSuffix(".txt")
        ? String(contentFilePath.dropLast(4))
        : contentFilePath
    self.pidFilePath   = base + ".pid"
    self.focusFilePath = base + ".focus"
    self.windowFilePath = base + ".window"
    self.posFilePath   = base + ".pos"
    self.widFilePath   = base + ".wid"
    self.slotFilePath  = base + ".slot"
    self.approvalFilePath = base + ".approval.json"
    self.ghosttyTidFilePath = base + ".ghostty-tid"
    self.ghosttyTtyFilePath = base + ".ghostty-tty"
}
```

并在类属性声明区域（约第 312-343 行，与其他 file path 属性相邻）添加：

```swift
var ghosttyTidFilePath: String
var ghosttyTtyFilePath: String
```

- [ ] **Step 2: 在 focusTerminal() 中添加 Ghostty 分支**

在 `scripts/sticky-window.swift:872` 之后（`debugLog("app found pid=...")` 之后，`let axApp = AXUIElementCreateApplication(...)` 之前）插入：

```swift
        debugLog("app found pid=\(app.processIdentifier)")

        // Ghostty 专用聚焦：terminal ID → TTY → 回退通用匹配
        if appName == "Ghostty" {
            if focusGhosttyTerminal(app: app) {
                debugLog("MATCH ghostty: surface focused via terminal ID/TTY")
                return
            }
            debugLog("ghostty focus cascade exhausted, fallback to generic AX match")
        }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
```

- [ ] **Step 3: 实现 focusGhosttyTerminal() 方法**

在 `focusTerminal()` 方法之后（`}` 闭合之后，约第 1007 行前）添加完整方法：

```swift
    /// Ghostty 专用聚焦：terminal ID → TTY → 回退
    /// 返回 true 表示已成功聚焦到具体 surface，false 表示需要走通用兜底
    func focusGhosttyTerminal(app: NSRunningApplication) -> Bool {
        // ── L1: Terminal ID 匹配（最精准，surface 级）──────────────────────
        if let tid = try? String(contentsOfFile: ghosttyTidFilePath, encoding: .utf8) {
            let trimmed = tid.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                let script = """
                tell application "Ghostty"
                    repeat with w in windows
                        repeat with t in tabs of w
                            repeat with term in terminals of t
                                if id of term is "\(trimmed)" then
                                    focus term
                                    return "ok-id"
                                end if
                            end repeat
                        end repeat
                    end repeat
                end tell
                return ""
                """
                let proc = Process()
                proc.launchPath = "/usr/bin/osascript"
                proc.arguments = ["-e", script]
                let pipe = Pipe()
                proc.standardOutput = pipe
                proc.standardError = FileHandle.nullDevice
                proc.launch()
                proc.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let result = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if result == "ok-id" {
                    app.activate(options: [])
                    debugLog("ghostty L1: terminal ID match ✓")
                    return true
                }
                debugLog("ghostty L1: terminal ID not found (result=\(result))")
            }
        }

        // ── L2: TTY 匹配（ID 缺失时的备用，surface 级）───────────────────
        if let tty = try? String(contentsOfFile: ghosttyTtyFilePath, encoding: .utf8) {
            let trimmed = tty.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                let script = """
                tell application "Ghostty"
                    repeat with w in windows
                        repeat with t in tabs of w
                            repeat with term in terminals of t
                                if tty of term ends with "\(trimmed)" then
                                    focus term
                                    return "ok-tty"
                                end if
                            end repeat
                        end repeat
                    end repeat
                end tell
                return ""
                """
                let proc = Process()
                proc.launchPath = "/usr/bin/osascript"
                proc.arguments = ["-e", script]
                let pipe = Pipe()
                proc.standardOutput = pipe
                proc.standardError = FileHandle.nullDevice
                proc.launch()
                proc.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let result = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if result == "ok-tty" {
                    app.activate(options: [])
                    debugLog("ghostty L2: TTY match ✓")
                    return true
                }
                debugLog("ghostty L2: TTY not found (result=\(result))")
            }
        }

        debugLog("ghostty: all cascade levels exhausted, fallback to generic")
        return false
    }
```

- [ ] **Step 4: 在 applicationWillTerminate 中添加 Ghostty 文件清理**

在 `scripts/sticky-window.swift:1640` 之后（`try? FileManager.default.removeItem(atPath: slotFilePath)` 之后，`try? FileManager.default.removeItem(atPath: base + ".project")` 之前）插入两行：

```swift
        try? FileManager.default.removeItem(atPath: ghosttyTidFilePath)
        try? FileManager.default.removeItem(atPath: ghosttyTtyFilePath)
```

- [ ] **Step 5: Swift 编译检查**

```bash
swiftc scripts/sticky-window.swift -o /tmp/sticky-notify-app
rm -f /tmp/sticky-notify-app
```
Expected: 编译成功，无错误输出

- [ ] **Step 6: Commit**

```bash
git add scripts/sticky-window.swift
git commit -m "feat(swift): add Ghostty surface-level precise focus via terminal ID/TTY cascade"
```

---

### Task 3: 构建部署并验证

**Files:**
- 部署产物: `~/.cc-notify/notify.sh`、`~/.cc-notify/sticky-notify.app/`

- [ ] **Step 1: 重新编译部署**

```bash
node scripts/postinstall.js
```

Expected: 复制 `notify.sh` 到 `~/.cc-notify/`，用 `swiftc` 编译生成 `~/.cc-notify/sticky-notify.app/`，无错误

- [ ] **Step 2: Bash 语法二次确认**

```bash
bash -n ~/.cc-notify/notify.sh
```
Expected: 无输出，退出码 0

- [ ] **Step 3: 非 Ghostty 回归测试 — 发送通用测试通知**

```bash
~/.cc-notify/notify.sh --force '🧪 回归测试: 通用通知'
```

Expected: 右上角出现黄色便签，内容为 "🧪 回归测试: 通用通知"。点击便签应聚焦到当前终端窗口。检查 `/tmp/cc-notify/` 下没有 `.ghostty-tid` 文件产生。

- [ ] **Step 4: Ghostty 场景测试 — 在 Ghostty 中运行**

在 Ghostty 终端中运行：

```bash
# 模拟 Claude Code Stop hook
echo '{"session_id":"ghostty-test-001","hook":"Stop","cwd":"'"$PWD"'"}' | \
  ~/.cc-notify/notify.sh --force '✅ Ghostty 精准聚焦测试'
```

Expected:
  - 便签出现
  - 检查 `/tmp/cc-notify/claude-ghosttytest001.ghostty-tid` 存在且包含 terminal ID
  - 检查 `/tmp/cc-notify/claude-ghosttytest001.ghostty-tty` 存在且包含 TTY
  - 切换到 Ghostty 的另一个 split/tab，点击便签 → 应聚焦回原 split

- [ ] **Step 5: 验证 debug 日志**

```bash
cat /tmp/cc-sticky-notify/focus-debug.log | grep ghostty
```

Expected: 看到 `ghostty L1: terminal ID match ✓` 或 `ghostty L2: TTY match ✓`

- [ ] **Step 6: 清理并 Commit（如有 fixup）**

```bash
# 清理测试文件
rm -f /tmp/cc-notify/claude-ghosttytest001.*
```

如验证过程中有修改，commit 修正。无修改则跳过。

---

## 自审清单

- [x] Spec 覆盖: Task 1 对应 4.1 节（Hook 采集），Task 2 对应 4.2 节（聚焦使用），Task 3 对应 8 节（测试要点）
- [x] 无占位符: 所有步骤均有完整代码
- [x] 类型一致性: `.ghostty-tid` / `.ghostty-tty` 文件名在 bash 和 Swift 两侧一致；`ghosttyTidFilePath` / `ghosttyTtyFilePath` 属性名与 init 和 cleanup 一致
