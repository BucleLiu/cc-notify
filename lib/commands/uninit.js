'use strict';

/**
 * ccn uninit
 *
 * Remove cc-notify hooks from ~/.claude/settings.json.
 * Remove Codex hooks with --codex, or both providers with --all.
 * Removes only entries whose command references cc-notify or cc-sticky-notify.
 * All other hook entries are preserved.
 */

const {
  readSettings,
  backupSettings,
  writeSettings,
  readCodexHooks,
  writeCodexHooks,
  backupFile,
  isCcNotifyCommand,
  parseProviderTargets,
  CLAUDE_SETTINGS,
  CODEX_HOOKS_JSON,
} = require('../utils');

function run(args) {
  const targets = parseProviderTargets(args);

  if (targets.claude) {
    runClaudeUninit();
  }

  if (targets.codex) {
    runCodexUninit();
  }
}

function runClaudeUninit() {
  let config;
  try {
    config = readSettings();
  } catch (e) {
    process.stderr.write(`ccn uninit: ${e.message}\n`);
    process.exit(1);
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    process.stdout.write('No hooks configured.\n');
    return;
  }

  let removedCount  = 0;
  let removedGroups = 0;

  for (const [eventKey, eventHooks] of Object.entries(config.hooks)) {
    if (!Array.isArray(eventHooks)) continue;

    for (const group of eventHooks) {
      if (!Array.isArray(group.hooks)) continue;

      const before = group.hooks.length;
      group.hooks = group.hooks.filter(hook => {
        if (typeof hook.command === 'string' && isCcNotifyCommand(hook.command)) {
          removedCount++;
          return false;
        }
        return true;
      });
      const removed = before - group.hooks.length;
      if (removed > 0) removedGroups++;
    }

    // Remove empty groups (groups that now have no hooks)
    config.hooks[eventKey] = eventHooks.filter(group => {
      if (!Array.isArray(group.hooks)) return true;
      return group.hooks.length > 0;
    });
  }

  if (removedCount === 0) {
    process.stdout.write('No cc-notify hooks found in settings.json.\n');
    return;
  }

  let backupPath = null;
  try {
    backupPath = backupSettings();
  } catch (e) {
    process.stderr.write(`ccn uninit: warning — backup failed: ${e.message}\n`);
  }

  try {
    writeSettings(config);
  } catch (e) {
    process.stderr.write(`ccn uninit: failed to write settings.json: ${e.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`\nRemoved ${removedCount} cc-notify hook(s) from:\n`);
  process.stdout.write(`  ${CLAUDE_SETTINGS}\n`);
  if (backupPath) {
    process.stdout.write(`  Backup: ${backupPath}\n`);
  }
  process.stdout.write('\nRun: ccn init   to re-add hooks\n\n');
}

function runCodexUninit() {
  let config;
  try {
    config = readCodexHooks();
  } catch (e) {
    process.stderr.write(`ccn uninit --codex: ${e.message}\n`);
    process.exit(1);
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    process.stdout.write('No Codex hooks configured.\n');
    return;
  }

  const removed = removeCcNotifyHooks(config.hooks);

  if (removed.count === 0) {
    process.stdout.write('No cc-notify hooks found in Codex hooks.json.\n');
    return;
  }

  let backupPath = null;
  try {
    backupPath = backupFile(CODEX_HOOKS_JSON);
  } catch (e) {
    process.stderr.write(`ccn uninit --codex: warning — backup failed: ${e.message}\n`);
  }

  try {
    writeCodexHooks(config);
  } catch (e) {
    process.stderr.write(`ccn uninit --codex: failed to write hooks.json: ${e.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`\nRemoved ${removed.count} cc-notify hook(s) from:\n`);
  process.stdout.write(`  ${CODEX_HOOKS_JSON}\n`);
  if (backupPath) {
    process.stdout.write(`  Backup: ${backupPath}\n`);
  }
  process.stdout.write('\nRun: ccn init --codex   to re-add hooks\n\n');
}

function removeCcNotifyHooks(hooks) {
  let removedCount = 0;
  let removedGroups = 0;

  for (const [eventKey, eventHooks] of Object.entries(hooks)) {
    if (!Array.isArray(eventHooks)) continue;

    for (const group of eventHooks) {
      if (!Array.isArray(group.hooks)) continue;

      const before = group.hooks.length;
      group.hooks = group.hooks.filter(hook => {
        if (typeof hook.command === 'string' && isCcNotifyCommand(hook.command)) {
          removedCount++;
          return false;
        }
        return true;
      });
      const removed = before - group.hooks.length;
      if (removed > 0) removedGroups++;
    }

    hooks[eventKey] = eventHooks.filter(group => {
      if (!Array.isArray(group.hooks)) return true;
      return group.hooks.length > 0;
    });
  }

  return { count: removedCount, groups: removedGroups };
}

module.exports = { run };
