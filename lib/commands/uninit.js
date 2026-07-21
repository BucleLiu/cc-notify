'use strict';

/**
 * ccn uninit
 *
 * Remove cc-notify hooks from ~/.claude/settings.json.
 * Remove Codex hooks with --codex, or both providers with --all.
 * Removes only entries whose command references cc-notify or cc-sticky-notify.
 * All other hook entries are preserved.
 */

const fs = require('fs');

const {
  readSettings,
  backupSettings,
  writeSettings,
  readCodexHooks,
  writeCodexHooks,
  readCodexConfigToml,
  writeCodexConfigToml,
  removeCodexTomlHooks,
  backupFile,
  isCcNotifyCommand,
  parseProviderTargets,
  CLAUDE_SETTINGS,
  CODEX_HOOKS_JSON,
  CODEX_CONFIG_TOML,
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
  let toml;
  try {
    toml = readCodexConfigToml();
  } catch (e) {
    process.stderr.write(`ccn uninit --codex: ${e.message}\n`);
    process.exit(1);
  }

  const newToml = removeCodexTomlHooks(toml);

  // Fallback: also clean up legacy hooks.json
  const legacyCleaned = cleanupLegacyCodexHooksJson();

  // Check if nothing was removed from either source
  const tomlChanged = newToml !== toml;
  if (!tomlChanged && !legacyCleaned) {
    process.stdout.write('No cc-notify hooks found in Codex config.toml.\n');
    return;
  }

  if (tomlChanged) {
    let backupPath = null;
    try {
      backupPath = backupFile(CODEX_CONFIG_TOML);
    } catch (e) {
      process.stderr.write(`ccn uninit --codex: warning — backup failed: ${e.message}\n`);
    }

    try {
      writeCodexConfigToml(newToml);
    } catch (e) {
      process.stderr.write(`ccn uninit --codex: failed to write config.toml: ${e.message}\n`);
      process.exit(1);
    }

    process.stdout.write(`\nRemoved cc-notify hooks from:\n`);
    process.stdout.write(`  ${CODEX_CONFIG_TOML}\n`);
    if (backupPath) {
      process.stdout.write(`  Backup: ${backupPath}\n`);
    }
  }

  if (legacyCleaned) {
    process.stdout.write(`Cleaned up: ${CODEX_HOOKS_JSON}\n`);
  }

  process.stdout.write('\nRun: ccn init --codex   to re-add hooks\n\n');
}

/**
 * Remove cc-notify hooks from the legacy ~/.codex/hooks.json file.
 * Used as a fallback during uninit for users upgrading from older versions.
 * If the file is empty after cleanup, delete it entirely.
 *
 * @returns {boolean} true if anything was cleaned up
 */
function cleanupLegacyCodexHooksJson() {
  if (!fs.existsSync(CODEX_HOOKS_JSON)) return false;

  let config;
  try {
    config = readCodexHooks();
  } catch {
    return false;
  }

  if (!config.hooks || typeof config.hooks !== 'object') return false;

  let removedCount = 0;
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
    }
    config.hooks[eventKey] = eventHooks.filter(g =>
      !Array.isArray(g.hooks) || g.hooks.length > 0
    );
    if (config.hooks[eventKey].length === 0) delete config.hooks[eventKey];
  }

  // Delete the file if it's effectively empty (no hook events left).
  // This covers both the case where we just removed all hooks AND the
  // case where a previous partial cleanup left empty event arrays.
  const hasAnyHooks = Object.keys(config.hooks).length > 0;

  if (!hasAnyHooks) {
    try {
      fs.unlinkSync(CODEX_HOOKS_JSON);
    } catch (e) {
      process.stderr.write(`ccn uninit --codex: warning — hooks.json cleanup failed: ${e.message}\n`);
    }
    return true;
  }

  if (removedCount === 0) return false;

  try {
    backupFile(CODEX_HOOKS_JSON);
    writeCodexHooks(config);
  } catch (e) {
    process.stderr.write(`ccn uninit --codex: warning — hooks.json cleanup failed: ${e.message}\n`);
  }

  return true;
}

module.exports = { run };
