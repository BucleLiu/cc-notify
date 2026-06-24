#!/usr/bin/env node
/**
 * ccn — cc-notify CLI entry point
 *
 * Commands:
 *   ccn init              Configure Claude Code hooks in ~/.claude/settings.json
 *   ccn init --codex      Configure Codex hooks in ~/.codex/
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
  init:   () => require('../lib/commands/init'),
  uninit: () => require('../lib/commands/uninit'),
  status: () => require('../lib/commands/status'),
  test:   () => require('../lib/commands/test'),
  update: () => require('../lib/commands/update'),
  set:    () => require('../lib/commands/set'),
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

CONFIG KEYS
  close_timeout     Auto-close after N seconds of inactivity (default: 10800)
                    Maps to env var: CC_STICKY_NOTIFY_CLOSE_TIMEOUT

EXAMPLES
  ccn init
  ccn init --codex
  ccn init --all
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
