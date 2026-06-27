#!/usr/bin/env node
/**
 * ccn — cc-notify CLI entry point
 *
 * Commands:
 *   ccn init              Configure Claude Code hooks in ~/.claude/settings.json
 *   ccn init --codex      Configure Codex hooks in ~/.codex/
 *   ccn clean             Remove deprecated cc-notify hooks (keeps active ones)
 *   ccn clean --codex     Clean deprecated Codex hooks
 *   ccn uninit            Remove cc-notify hooks from settings.json
 *   ccn status            Check installation state
 *   ccn test              Send a test notification
 *   ccn update            Re-copy scripts and recompile Swift app
 *   ccn set [key=value]   Manage ~/.cc-notify/env.json config
 *
 * No third-party runtime dependencies — uses Node.js built-ins only.
 */

'use strict';

const COMMANDS = {
  init:             () => require('../lib/commands/init'),
  clean:            () => require('../lib/commands/clean'),
  uninit:           () => require('../lib/commands/uninit'),
  status:           () => require('../lib/commands/status'),
  test:             () => require('../lib/commands/test'),
  update:           () => require('../lib/commands/update'),
  set:              () => require('../lib/commands/set'),
  'approval-server': () => require('../lib/commands/approval-server'),
};

const VERSION = require('../package.json').version;

const args = process.argv.slice(2);
const cmd  = args[0];

// ─── Help / version ───────────────────────────────────────────────────────────

if (!cmd || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v') {
  process.stdout.write(`cc-notify v${VERSION}\n`);
  process.exit(0);
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

if (!COMMANDS[cmd]) {
  process.stderr.write(`ccn: unknown command '${cmd}'\n`);
  process.stderr.write(`Run 'ccn --help' for usage.\n`);
  process.exit(1);
}

try {
  COMMANDS[cmd]().run(args.slice(1));
} catch (err) {
  process.stderr.write(`ccn ${cmd}: ${err.message}\n`);
  process.exit(1);
}

// ─── Help text ────────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write(`
cc-notify v${VERSION} — Mac floating sticky-note notifications for Claude Code and Codex

USAGE
  ccn <command> [options]

COMMANDS
  init              Add cc-notify hooks to ~/.claude/settings.json
                    Also migrates old ~/.claude/skills/cc-sticky-notify/ paths
    --codex           Configure Codex hooks in ~/.codex/hooks.json and enable
                      features.codex_hooks in ~/.codex/config.toml
    --all             Configure both Claude Code and Codex
  clean             Remove all cc-notify hooks added by ccn init
                    Cleans both Claude Code and Codex hooks by default
    --codex           Clean only Codex hooks
    --claude          Clean only Claude Code hooks
  uninit            Remove cc-notify hooks from ~/.claude/settings.json
    --codex           Remove only cc-notify hooks from ~/.codex/hooks.json
    --all             Remove cc-notify hooks from both providers
  status            Show installation state (binary, hooks, config)
    --codex           Show Codex hook and feature-flag status
    --all             Show both Claude Code and Codex hook status
  test              Send a test notification to verify everything works
  update            Re-copy notify.sh and recompile Swift app
    --recompile       Force recompile even if version matches
  set [key=value]   Manage ~/.cc-notify/env.json config
    (no args)         Show current config
    key=value         Set a config value (dot notation supported)
  approval-server   Manage the local approval HTTP server
    (no args)         Show server status (pid, port, uptime)
    start             Start the server manually
    stop              Stop the server immediately

CONFIG KEYS
  close_timeout     Auto-close after N seconds of inactivity (default: 10800)
                    Maps to env var: CC_STICKY_NOTIFY_CLOSE_TIMEOUT

EXAMPLES
  ccn init
  ccn init --codex
  ccn init --all
  ccn clean
  ccn clean --codex
  ccn set close_timeout=300
  ccn set close_timeout=86400
  ccn test
  ccn status
  ccn update
  npm update -g @bucle/cc-notify    # Update package (auto-runs postinstall)

INSTALL
  npm install -g @bucle/cc-notify
  ccn init

`.trimStart());
}
