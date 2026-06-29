'use strict';

/**
 * ccn init
 *
 * Configure Claude Code hooks in ~/.claude/settings.json.
 * Configure Codex hooks with --codex, or both providers with --all.
 *
 * Behavior:
 *   1. Migrate any existing hooks that reference the old cc-sticky-notify path.
 *   2. Remove deprecated hooks (PostCompact, Notification/permission_prompt).
 *   3. Add cc-notify hooks for each target event (skipped if already present).
 *   4. Write back to settings.json, preserving all other configuration.
 *   5. Refresh ~/.cc-notify/ scripts to ensure they support all configured hooks.
 *
 * Idempotent: safe to run multiple times.
 */

const cp   = require('child_process');
const path = require('path');

const {
  readSettings,
  backupSettings,
  writeSettings,
  backupFile,
  readCodexHooks,
  writeCodexHooks,
  readCodexConfigToml,
  writeCodexConfigToml,
  ensureCodexHooksFeature,
  isCcNotifyCommand,
  migrateCommandPath,
  parseProviderTargets,
  CLAUDE_SETTINGS,
  CODEX_HOOKS_JSON,
  CODEX_CONFIG_TOML,
} = require('../utils');

// ─── Hook definitions ─────────────────────────────────────────────────────────
// Each entry describes which event to hook and what to add.
//
// For Notification events the key format is "Notification" with a matcher.
// For all others the key is the hook event name.

const HOOK_DEFINITIONS = [
  {
    event:   'Stop',
    matcher: null,
    updateExisting: true,
    entry: {
      type:    'command',
      command: "$HOME/.cc-notify/notify.sh --urgent --state completed",
    },
  },
  {
    event:   'SessionEnd',
    matcher: null,
    updateExisting: true,
    entry: {
      type:    'command',
      command: "$HOME/.cc-notify/notify.sh --state close",
    },
  },
  {
    event:   'PostToolUse',
    matcher: null,
    updateExisting: true,
    entry: {
      type:    'command',
      command: "$HOME/.cc-notify/notify.sh --state working",
    },
  },
  {
    event:   'UserPromptSubmit',
    matcher: null,
    updateExisting: true,
    entry: {
      type:    'command',
      command: "$HOME/.cc-notify/notify.sh --state working",
    },
  },
  {
    event:   'PermissionRequest',
    matcher: '*',
    updateExisting: true,
    entry: {
      type:    'command',
      command: "$HOME/.cc-notify/approval-hook.js --provider claude",
    },
  },
];

const CODEX_HOOK_DEFINITIONS = [
  {
    event:   'Stop',
    matcher: null,
    updateExisting: true,
    entry: {
      type:          'command',
      command:       "$HOME/.cc-notify/notify.sh --provider codex --urgent --state completed",
      statusMessage: '',
    },
  },
  {
    event:   'PermissionRequest',
    matcher: '.*',
    updateExisting: true,
    entry: {
      type:          'command',
      command:       "$HOME/.cc-notify/approval-hook.js --provider codex",
      timeout:       600,
      statusMessage: '',
    },
  },
  {
    event:   'UserPromptSubmit',
    matcher: null,
    updateExisting: true,
    entry: {
      type:          'command',
      command:       "$HOME/.cc-notify/notify.sh --provider codex --state working",
      statusMessage: '',
    },
  },
  {
    event:   'PostToolUse',
    matcher: null,
    updateExisting: true,
    entry: {
      type:          'command',
      command:       "$HOME/.cc-notify/notify.sh --provider codex --state working",
      statusMessage: '',
    },
  },
  {
    event:   'SessionStart',
    matcher: 'startup|resume',
    updateExisting: true,
    entry: {
      type:          'command',
      command:       "$HOME/.cc-notify/notify.sh --provider codex --urgent --state completed",
      statusMessage: '',
    },
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(args) {
  const targets = parseProviderTargets(args);

  if (targets.claude) {
    runClaudeInit();
  }

  if (targets.codex) {
    runCodexInit();
  }

  // Refresh installed scripts so they support all configured hooks.
  // postinstall always copies notify.sh (fast); Swift recompile is
  // skipped when version matches.
  refreshScripts();

  process.stdout.write('Run: ccn status   to verify the installation\n');
  process.stdout.write('Run: ccn test     to send a test notification\n\n');
}

function refreshScripts() {
  const postinstallScript = path.resolve(__dirname, '../../scripts/postinstall.js');
  try {
    cp.execFileSync(process.execPath, [postinstallScript], {
      stdio: 'inherit',
      env: Object.assign({}, process.env, { CC_NOTIFY_FORCE_RECOMPILE: '0' }),
    });
  } catch (e) {
    process.stderr.write(`ccn init: warning — script refresh failed: ${e.message}\n`);
  }
}

function runClaudeInit() {
  let config;
  try {
    config = readSettings();
  } catch (e) {
    process.stderr.write(`ccn init: ${e.message}\n`);
    process.exit(1);
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }

  const results = [];

  // ── Step 1: Migrate old paths ──────────────────────────────────────────────
  let migratedCount = 0;
  for (const [eventKey, eventHooks] of Object.entries(config.hooks)) {
    if (!Array.isArray(eventHooks)) continue;
    for (const group of eventHooks) {
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook.command !== 'string') continue;
        if (hook.command.includes('cc-sticky-notify')) {
          hook.command = migrateCommandPath(hook.command);
          migratedCount++;
        }
      }
    }
  }

  if (migratedCount > 0) {
    results.push({ status: 'migrated', label: `Migrated ${migratedCount} old cc-sticky-notify path(s) → $HOME/.cc-notify/` });
  }

  // ── Step 2: Remove deprecated hooks ───────────────────────────────────────
  // Hooks that are no longer needed and should be cleaned up from existing configs.
  const DEPRECATED_HOOKS = [
    { event: 'PostCompact', matcher: null },
    { event: 'Notification', matcher: 'permission_prompt' },
  ];

  let cleanedCount = 0;
  for (const { event, matcher } of DEPRECATED_HOOKS) {
    if (!Array.isArray(config.hooks[event])) continue;

    const kept = [];
    for (const group of config.hooks[event]) {
      // Match the target group by matcher
      const groupMatcher = group.matcher ?? null;
      const matcherMatch = matcher === null
        ? (groupMatcher === null || groupMatcher === '' || groupMatcher === undefined)
        : groupMatcher === matcher;

      if (matcherMatch && Array.isArray(group.hooks)) {
        group.hooks = group.hooks.filter(h => {
          if (typeof h.command === 'string' && isCcNotifyCommand(h.command)) {
            cleanedCount++;
            return false;
          }
          return true;
        });
      }

      // Keep group if it still has hooks (possibly from other tools)
      if (Array.isArray(group.hooks) && group.hooks.length > 0) {
        kept.push(group);
      }
    }
    if (kept.length > 0) {
      config.hooks[event] = kept;
    } else {
      delete config.hooks[event];
    }
  }

  if (cleanedCount > 0) {
    results.push({ status: 'removed', label: `Removed ${cleanedCount} deprecated hook(s)` });
  }

  // ── Step 3: Add missing hooks ──────────────────────────────────────────────
  for (const def of HOOK_DEFINITIONS) {
    const result = ensureHook(config.hooks, def);
    results.push(result);
  }

  // ── Step 4: Backup + Write back ──────────────────────────────────────────
  let backupPath = null;
  try {
    backupPath = backupSettings();
  } catch (e) {
    process.stderr.write(`ccn init: warning — backup failed: ${e.message}\n`);
  }

  try {
    writeSettings(config);
  } catch (e) {
    process.stderr.write(`ccn init: failed to write settings.json: ${e.message}\n`);
    process.exit(1);
  }

  // ── Step 5: Print summary ─────────────────────────────────────────────────
  process.stdout.write(`\nConfigured: ${CLAUDE_SETTINGS}\n`);
  if (backupPath) {
    process.stdout.write(`Backup:     ${backupPath}\n`);
  }
  process.stdout.write('\n');

  for (const r of results) {
    const icon = r.status === 'added'    ? '[added]'
               : r.status === 'skipped'  ? '[skipped]'
               : r.status === 'removed'  ? '[removed]'
               : r.status === 'migrated' ? '[migrated]'
               : '[?]';
    process.stdout.write(`  ${icon.padEnd(10)} ${r.label}\n`);
  }

  process.stdout.write('\n');
}

function runCodexInit() {
  let hooksConfig;
  try {
    hooksConfig = readCodexHooks();
  } catch (e) {
    process.stderr.write(`ccn init --codex: ${e.message}\n`);
    process.exit(1);
  }

  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object') {
    hooksConfig.hooks = {};
  }

  const results = [];
  for (const def of CODEX_HOOK_DEFINITIONS) {
    results.push(ensureHook(hooksConfig.hooks, def));
  }

  let hooksBackupPath = null;
  try {
    hooksBackupPath = backupFile(CODEX_HOOKS_JSON);
  } catch (e) {
    process.stderr.write(`ccn init --codex: warning — hooks backup failed: ${e.message}\n`);
  }

  try {
    writeCodexHooks(hooksConfig);
  } catch (e) {
    process.stderr.write(`ccn init --codex: failed to write hooks.json: ${e.message}\n`);
    process.exit(1);
  }

  let configBackupPath = null;
  try {
    const toml = readCodexConfigToml();
    const updatedToml = ensureCodexHooksFeature(toml);
    try {
      configBackupPath = backupFile(CODEX_CONFIG_TOML);
    } catch (e) {
      process.stderr.write(`ccn init --codex: warning — config backup failed: ${e.message}\n`);
    }
    writeCodexConfigToml(updatedToml);
  } catch (e) {
    process.stderr.write(`ccn init --codex: failed to enable codex_hooks feature: ${e.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`\nConfigured: ${CODEX_HOOKS_JSON}\n`);
  if (hooksBackupPath) {
    process.stdout.write(`Hooks backup:  ${hooksBackupPath}\n`);
  }
  process.stdout.write(`Feature flag: ${CODEX_CONFIG_TOML}\n`);
  if (configBackupPath) {
    process.stdout.write(`Config backup: ${configBackupPath}\n`);
  }
  process.stdout.write('\n');

  for (const r of results) {
    const icon = r.status === 'added' ? '[added]'
               : r.status === 'updated' ? '[updated]'
               : r.status === 'skipped' ? '[skipped]'
               : '[?]';
    process.stdout.write(`  ${icon.padEnd(10)} ${r.label}\n`);
  }

  process.stdout.write('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensure that the given hook definition exists in config.hooks.
 * Returns { status: 'added'|'skipped', label: string }
 */
function ensureHook(hooks, def) {
  const { event, matcher, entry, updateExisting } = def;
  const label = matcher ? `${event}/${matcher}` : event;

  // Ensure the event array exists
  if (!Array.isArray(hooks[event])) {
    hooks[event] = [];
  }

  const eventHooks = hooks[event];

  // Check if cc-notify is already configured for this event+matcher combo
  for (const group of eventHooks) {
    // Match by matcher (null matcher means we look for groups without matcher or empty matcher)
    const groupMatcher = group.matcher ?? null;
    const matcherMatch = matcher === null
      ? (groupMatcher === null || groupMatcher === '' || groupMatcher === undefined)
      : groupMatcher === matcher;

    if (!matcherMatch) continue;

    if (Array.isArray(group.hooks)) {
      for (const hook of group.hooks) {
        if (typeof hook.command === 'string' && isCcNotifyCommand(hook.command)) {
          if (updateExisting && hook.command !== entry.command) {
            Object.assign(hook, entry);
            return { status: 'updated', label };
          }
          return { status: 'skipped', label };
        }
      }
    }
  }

  // Not found — need to add. Find the right group to append to, or create one.
  let targetGroup = null;

  for (const group of eventHooks) {
    const groupMatcher = group.matcher ?? null;
    const matcherMatch = matcher === null
      ? (groupMatcher === null || groupMatcher === '' || groupMatcher === undefined)
      : groupMatcher === matcher;

    if (matcherMatch) {
      targetGroup = group;
      break;
    }
  }

  if (!targetGroup) {
    // Create a new group
    targetGroup = matcher !== null ? { matcher, hooks: [] } : { hooks: [] };
    eventHooks.push(targetGroup);
  }

  if (!Array.isArray(targetGroup.hooks)) {
    targetGroup.hooks = [];
  }

  targetGroup.hooks.push(entry);
  return { status: 'added', label };
}

module.exports = { run };
