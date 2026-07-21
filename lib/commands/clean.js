'use strict';

/**
 * ccn clean
 *
 * Remove all cc-notify hooks added by `ccn init` from Claude Code and Codex.
 * Unlike `uninit` which defaults to Claude Code only, `clean` removes hooks
 * from both providers by default — the symmetric counterpart to `ccn init`.
 *
 * Behavior:
 *   1. Remove all cc-notify hooks from ~/.claude/settings.json
 *   2. Remove all cc-notify hooks from ~/.codex/config.toml
 *   3. Backup before modifying (same as init/uninit)
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

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(args) {
  const targets = parseProviderTargets(args);

  // Default to both providers when no explicit provider flag is given.
  // This differs from init/uninit where the default is Claude-only,
  // because "clean all" is the natural expectation.
  const noFlag = !args.includes('--codex') && !args.includes('--claude') && !args.includes('--all');
  const wantClaude = noFlag ? true : targets.claude;
  const wantCodex = noFlag ? true : targets.codex;

  if (wantClaude) {
    runCleanClaude();
  }

  if (wantCodex) {
    runCleanCodex();
  }

  process.stdout.write('Run: ccn init   to re-add hooks\n\n');
}

function runCleanClaude() {
  let config;
  try {
    config = readSettings();
  } catch (e) {
    process.stderr.write(`ccn clean: ${e.message}\n`);
    process.exit(1);
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    process.stdout.write('No hooks configured in settings.json.\n');
    return;
  }

  const removed = removeCcNotifyHooks(config.hooks);

  if (removed.count === 0) {
    process.stdout.write('No cc-notify hooks found in settings.json.\n');
    return;
  }

  let backupPath = null;
  try {
    backupPath = backupSettings();
  } catch (e) {
    process.stderr.write(`ccn clean: warning — backup failed: ${e.message}\n`);
  }

  try {
    writeSettings(config);
  } catch (e) {
    process.stderr.write(`ccn clean: failed to write settings.json: ${e.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`\nRemoved ${removed.count} cc-notify hook(s) from:\n`);
  process.stdout.write(`  ${CLAUDE_SETTINGS}\n`);
  if (backupPath) {
    process.stdout.write(`  Backup: ${backupPath}\n`);
  }
}

function runCleanCodex() {
  let toml;
  try {
    toml = readCodexConfigToml();
  } catch (e) {
    process.stderr.write(`ccn clean: ${e.message}\n`);
    process.exit(1);
  }

  const newToml = removeCodexTomlHooks(toml);

  // Fallback: also clean up legacy hooks.json
  const legacyCleaned = cleanupLegacyCodexHooksJson();

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
      process.stderr.write(`ccn clean: warning — backup failed: ${e.message}\n`);
    }

    try {
      writeCodexConfigToml(newToml);
    } catch (e) {
      process.stderr.write(`ccn clean: failed to write config.toml: ${e.message}\n`);
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
}

/**
 * Remove cc-notify hooks from legacy ~/.codex/hooks.json as a fallback.
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
      process.stderr.write(`ccn clean: warning — hooks.json cleanup failed: ${e.message}\n`);
    }
    return true;
  }

  if (removedCount === 0) return false;

  try {
    backupFile(CODEX_HOOKS_JSON);
    writeCodexHooks(config);
  } catch (e) {
    process.stderr.write(`ccn clean: warning — hooks.json cleanup failed: ${e.message}\n`);
  }
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function removeCcNotifyHooks(hooks) {
  let removedCount = 0;

  for (const [eventKey, eventHooks] of Object.entries(hooks)) {
    if (!Array.isArray(eventHooks)) continue;

    for (const group of eventHooks) {
      if (!Array.isArray(group.hooks)) continue;

      group.hooks = group.hooks.filter(hook => {
        if (typeof hook.command === 'string' && isCcNotifyCommand(hook.command)) {
          removedCount++;
          return false;
        }
        return true;
      });
    }

    // Remove empty groups
    hooks[eventKey] = eventHooks.filter(group => {
      if (!Array.isArray(group.hooks)) return true;
      return group.hooks.length > 0;
    });
  }

  return { count: removedCount };
}

module.exports = { run };
