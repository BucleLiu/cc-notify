# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

`@bucle/cc-notify` 是一个 macOS-only 的 npm CLI 包，为 Claude Code 和 Codex hook 事件显示右上角浮动便签通知。更完整的架构说明见 `docs/DESIGN.md`；修改运行时数据流、Hook 行为、Swift 窗口机制或发布流程前应先阅读该文档。

高层结构分三层：

1. **CLI 管理层（Node.js / CommonJS）**
   - 入口：`bin/ccn.js`
   - 命令模块：`lib/commands/*.js`
   - 共享路径、配置、备份、Hook 读写逻辑：`lib/utils.js`
   - 无第三方运行时依赖，主要使用 Node.js built-ins。
2. **通知触发层（Bash）**
   - `scripts/notify.sh` 是 Claude Code / Codex hooks 实际调用的脚本。
   - 运行时会复制到稳定路径 `~/.cc-notify/notify.sh`，hooks 指向该稳定路径，因此 npm 更新后通常不需要重新 `ccn init`。
   - 负责解析 hook stdin JSON、`--provider` / `--urgent` / `--force` flags、按 provider+session 写入 `/tmp/cc-notify/<provider-session>.txt`、去重、记录 focus/window 元数据并启动或复用 Swift app。
3. **UI 展示层（Swift / AppKit）**
   - 源码：`scripts/sticky-window.swift`
   - `scripts/postinstall.js` 在用户本机用 `swiftc` 编译并生成 `~/.cc-notify/sticky-notify.app`。
   - App 通过 `DispatchSource` 监听内容文件变化，并带有 inode 变化重建 watcher 的兜底逻辑；点击便签会尝试聚焦回触发通知的终端/IDE 窗口。

## 常用命令

### 安装与本地开发

```bash
# 安装依赖/触发 postinstall（本项目没有第三方依赖，但会生成 package-lock 状态）
npm install

# 将当前仓库链接为全局 ccn 命令
npm link

# 手动执行安装脚本：复制 notify.sh、编译 Swift app、生成 ~/.cc-notify 配置
node scripts/postinstall.js

# 强制重编译 Swift app
CC_NOTIFY_FORCE_RECOMPILE=1 node scripts/postinstall.js
# 或在已 link 后使用
ccn update --recompile
```

### CLI 调试

```bash
# 查看 CLI 帮助/版本
node bin/ccn.js --help
node bin/ccn.js --version

# 检查安装状态
node bin/ccn.js status
node bin/ccn.js status --codex
node bin/ccn.js status --all

# 发送测试通知
node bin/ccn.js test
# 或 npm link 后
ccn test

# 配置 hooks（会修改用户级配置并自动备份）
ccn init          # Claude Code
ccn init --codex  # Codex
ccn init --all    # 两者都配置

# 移除 hooks（同样会备份配置）
ccn uninit
ccn uninit --codex
ccn uninit --all

# 更新安装文件（修改 notify.sh / sticky-window.swift 后运行）
ccn update --recompile

# 查看/修改运行时配置
ccn set
ccn set close_timeout=300
```

### 手动测试通知脚本

```bash
# 直接调用已安装脚本
~/.cc-notify/notify.sh --force '🧪 本地测试通知'

# 模拟 Claude Code Stop hook stdin JSON
echo '{"session_id":"abcd1234test","hook":"Stop","cwd":"'"$PWD"'"}' | \
  ~/.cc-notify/notify.sh --force '✅ 手动测试'

# 模拟 urgent 权限通知
echo '{"session_id":"abcd1234test","hook":"Notification","cwd":"'"$PWD"'"}' | \
  ~/.cc-notify/notify.sh --urgent --force '🔐 权限请求'
```

### 校验与发布前检查

```bash
# Bash 语法检查
bash -n scripts/notify.sh

# Swift 编译检查（不会生成 app bundle，仅验证源码可编译）
swiftc scripts/sticky-window.swift -o /tmp/sticky-notify-app
rm -f /tmp/sticky-notify-app

# 查看 npm 包会发布哪些文件
npm pack --dry-run

# 发布 dry-run
npm publish --dry-run --access public
```

当前 `package.json` 只有 `postinstall` script，没有配置 `build`、`lint` 或自动化 `test` npm scripts；仓库内也没有已提交的测试框架。需要“单项测试”时优先使用上面的手动 hook/notify 场景，或针对被修改的 CLI 命令直接运行 `node bin/ccn.js <command>`。

## 关键文件与职责

- `bin/ccn.js`：CLI 命令分发，仅做参数解析、help/version 输出和错误包装。
- `lib/utils.js`：集中定义 `~/.cc-notify`、Claude settings、Codex hooks/config 等路径；提供 JSON/TOML 辅助、备份、env 配置生成、旧路径迁移和 provider target 解析。
- `lib/commands/init.js`：写入 Claude Code `~/.claude/settings.json` 与 Codex `~/.codex/hooks.json` / `config.toml`；操作前备份；应保持幂等。
- `lib/commands/uninit.js`：移除 cc-notify hooks，保留其它用户 hooks。
- `lib/commands/status.js`：检查安装目录、binary、hooks、配置等状态。
- `lib/commands/set.js`：读写 `~/.cc-notify/env.json` 并再生成 `env.sh`，供 `notify.sh` source。
- `lib/commands/update.js`：通过重新运行 `scripts/postinstall.js` 刷新安装文件，可传 `--recompile`。
- `scripts/postinstall.js`：npm install/update 后执行；复制脚本、按版本缓存决定是否编译 Swift app、写 `.version` 和默认配置。
- `scripts/notify.sh`：运行时核心；注意 flags 必须在通知内容参数之前，内容去重签名会排除 `Time:` 行。
- `scripts/sticky-window.swift`：AppKit 浮动便签、文件监听、窗口槽位、urgent 主题、折叠/展开、点击聚焦逻辑。
- `docs/DESIGN.md`：更详细的设计、运行时流程、发布和故障排查说明。

## 运行时状态与配置路径

- 稳定安装目录：`~/.cc-notify/`
  - `notify.sh`
  - `sticky-notify.app/`
  - `env.json`
  - `env.sh`
  - `.version`
  - `notify.log`
- 临时会话状态：`/tmp/cc-notify/`
  - `<provider-session>.txt`：便签内容
  - `<provider-session>.pid`：Swift app 进程
  - `<provider-session>.sig`：去重签名
  - `<provider-session>.focus` / `.window` / `.pos` / `.wid` / `.slot`：聚焦与窗口槽位元数据

## 修改注意事项

- 修改 `scripts/notify.sh` 或 `scripts/sticky-window.swift` 后，运行 `node scripts/postinstall.js` 或 `ccn update --recompile` 才会更新 `~/.cc-notify/` 中的实际运行版本。
- `ccn init` / `ccn uninit` 会改用户级 Claude Code/Codex 配置；除非用户明确要求，否则不要擅自运行会修改真实用户 hooks 的命令。需要验证时优先阅读代码或使用临时/手动调用方式。
- `scripts/sticky-window.swift` 的文件监听依赖 inode-aware watcher；避免用会替换文件 inode 的写法破坏已有 watcher，相关背景见 `docs/DESIGN.md` 和代码注释。
- `notify.sh` 中 provider+session 共同决定状态文件名，避免引入只按 cwd 或只按 session 的状态路径，防止 Claude Code/Codex 或多会话互相覆盖。
- 项目中的临时方案/说明文档请放入 `docs/`，不要直接放在仓库根目录。