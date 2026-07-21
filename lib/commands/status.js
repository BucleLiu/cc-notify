'use strict';

/**
 * ccn status
 *
 * Show installation state:
 *   - notify.sh presence + executable bit
 *   - Swift app compiled + codesigned
 *   - Each cc-notify hook configured for Claude and/or Codex
 *   - env.json config summary
 */

const fs   = require('fs');
const cp   = require('child_process');
const path = require('path');

const {
  INSTALL_DIR,
  NOTIFY_SH,
  APP_BINARY,
  APP_BUNDLE,
  ENV_JSON,
  ENV_SH,
  VERSION_FILE,
  CLAUDE_SETTINGS,
  CODEX_CONFIG_TOML,
  APPROVAL_HOOK_JS,
  APPROVAL_SERVER_JS,
  RUNTIME_JSON,
  isCcNotifyCommand,
  isCodexHooksFeatureEnabled,
  findCodexTomlHooks,
  parseProviderTargets,
  readEnvJson,
  flattenEnvObj,
  resolveEnvVarName,
} = require('../utils');

const PKG_VERSION = require('../../package.json').version;

// Mirror of the hook definitions from init.js (event + matcher pairs to check)
const HOOK_CHECKS = [
  { event: 'Stop',             matcher: null },
  { event: 'Notification',     matcher: 'permission_prompt' },
  { event: 'PostToolUse',      matcher: null },
  { event: 'UserPromptSubmit', matcher: null },
  { event: 'PostCompact',      matcher: null },
  { event: 'PermissionRequest', matcher: '*' },
];

const CODEX_HOOK_CHECKS = [
  { event: 'Stop',             matcher: null },
  { event: 'PermissionRequest', matcher: '.*' },
  { event: 'UserPromptSubmit', matcher: null },
  { event: 'PostToolUse',      matcher: null },
];

function run(args) {
  const targets = parseProviderTargets(args);

  process.stdout.write(`\ncc-notify v${PKG_VERSION} — status\n`);
  process.stdout.write(`Install dir: ${INSTALL_DIR}\n\n`);

  // ── Binary & scripts ───────────────────────────────────────────────────────
  process.stdout.write('INSTALLATION\n');

  const notifyOk = fs.existsSync(NOTIFY_SH);
  statusLine('notify.sh', notifyOk, notifyOk ? NOTIFY_SH : 'not found — run: npm install -g cc-notify');

  const binaryOk = fs.existsSync(APP_BINARY);
  statusLine('Swift app', binaryOk, binaryOk ? APP_BINARY : 'not compiled — run: ccn update');

  if (binaryOk) {
    const signed = isCodesigned(APP_BUNDLE);
    statusLine('codesign', signed, signed ? 'ad-hoc signed' : 'not signed');
  }

  const installedVer = fs.existsSync(VERSION_FILE)
    ? fs.readFileSync(VERSION_FILE, 'utf8').trim()
    : null;

  if (installedVer) {
    const verMatch = installedVer === PKG_VERSION;
    statusLine(
      'version',
      verMatch,
      verMatch
        ? `v${installedVer} (up-to-date)`
        : `installed v${installedVer} ≠ package v${PKG_VERSION} — run: ccn update`
    );
  }

  if (targets.claude) {
    showClaudeHooks();
  }

  if (targets.codex) {
    showCodexHooks();
  }

  // ── Approval
  process.stdout.write('\nAPPROVAL\n');

  const approvalHookOk = fs.existsSync(APPROVAL_HOOK_JS);
  statusLine('approval-hook.js', approvalHookOk,
    approvalHookOk ? APPROVAL_HOOK_JS : 'not found');

  const approvalServerOk = fs.existsSync(APPROVAL_SERVER_JS);
  statusLine('approval-server.js', approvalServerOk,
    approvalServerOk ? APPROVAL_SERVER_JS : 'not found');

  let svcStatus = 'stopped';
  if (fs.existsSync(RUNTIME_JSON)) {
    try {
      const rt = JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf8'));
      if (rt.error) { svcStatus = `error: ${rt.error}`; }
      else if (rt.pid && rt.port) {
        try { process.kill(rt.pid, 0); svcStatus = `running (pid ${rt.pid}, port ${rt.port})`; }
        catch { svcStatus = 'stopped (stale runtime.json)'; }
      }
    } catch { svcStatus = 'error reading runtime.json'; }
  }
  statusLine('approval service', svcStatus.startsWith('running'), svcStatus);

  // ── Config ────────────────────────────────────────────────────────────────
  process.stdout.write('\nCONFIG  (' + ENV_JSON + ')\n');

  const envObj = readEnvJson();
  const entries = flattenEnvObj(envObj);

  if (entries.length === 0) {
    process.stdout.write('  (empty — using defaults)\n');
  } else {
    for (const [key, value] of entries) {
      process.stdout.write(`  ${key} = ${value}  (${resolveEnvVarName(key)})\n`);
    }
  }

  const envShOk = fs.existsSync(ENV_SH);
  statusLine('env.sh', envShOk, envShOk ? 'generated' : 'missing — run: ccn set close_timeout=10800');

  process.stdout.write('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusLine(label, ok, detail) {
  const icon = ok ? '✓' : '✗';
  process.stdout.write(`  ${icon} ${label.padEnd(30)} ${detail}\n`);
}

function isCodesigned(bundlePath) {
  try {
    cp.execSync(`codesign --verify "${bundlePath}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function showClaudeHooks() {
  process.stdout.write('\nCLAUDE HOOKS  (' + CLAUDE_SETTINGS + ')\n');

  let settings = null;
  if (!fs.existsSync(CLAUDE_SETTINGS)) {
    process.stdout.write('  settings.json not found\n');
  } else {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    } catch {
      process.stdout.write('  ERROR: failed to parse settings.json\n');
    }
  }

  if (settings) {
    for (const { event, matcher } of HOOK_CHECKS) {
      const label = matcher ? `${event}/${matcher}` : event;
      const found = isHookConfigured(settings, event, matcher);
      statusLine(label, found, found ? 'configured' : 'not configured — run: ccn init');
    }
  }
}

function showCodexHooks() {
  process.stdout.write('\nCODEX  (' + CODEX_CONFIG_TOML + ')\n');

  if (!fs.existsSync(CODEX_CONFIG_TOML)) {
    statusLine('hooks feature', false, 'config.toml not found — run: ccn init --codex');
    return;
  }

  let toml = '';
  try {
    toml = fs.readFileSync(CODEX_CONFIG_TOML, 'utf8');
  } catch {
    statusLine('hooks feature', false, 'ERROR: failed to read config.toml');
    return;
  }

  const enabled = isCodexHooksFeatureEnabled(toml);
  statusLine('hooks feature', enabled, enabled ? 'enabled' : 'not enabled — run: ccn init --codex');

  // All hooks live in config.toml now
  const hookResults = findCodexTomlHooks(toml, CODEX_HOOK_CHECKS);
  for (const { event, matcher, found } of hookResults) {
    const label = matcher ? `${event}/${matcher}` : event;
    statusLine(label, found, found ? 'configured' : 'not configured — run: ccn init --codex');
  }
}

function isHookConfigured(settings, event, matcher) {
  const eventHooks = settings?.hooks?.[event];
  if (!Array.isArray(eventHooks)) return false;

  for (const group of eventHooks) {
    const groupMatcher = group.matcher ?? null;
    const matcherMatch = matcher === null
      ? (groupMatcher === null || groupMatcher === '' || groupMatcher === undefined)
      : groupMatcher === matcher;

    if (!matcherMatch) continue;

    if (Array.isArray(group.hooks)) {
      for (const hook of group.hooks) {
        if (typeof hook.command === 'string' && isCcNotifyCommand(hook.command)) {
          return true;
        }
      }
    }
  }
  return false;
}

module.exports = { run };
