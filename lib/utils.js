'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// ─── Stable installation directory ───────────────────────────────────────────
const INSTALL_DIR = path.join(os.homedir(), '.cc-notify');

// Paths inside the install directory
const NOTIFY_SH       = path.join(INSTALL_DIR, 'notify.sh');
const APP_BUNDLE      = path.join(INSTALL_DIR, 'sticky-notify.app');
const APP_BINARY      = path.join(APP_BUNDLE, 'Contents', 'MacOS', 'sticky-notify-app');
const ENV_JSON        = path.join(INSTALL_DIR, 'env.json');
const ENV_SH          = path.join(INSTALL_DIR, 'env.sh');
const VERSION_FILE    = path.join(INSTALL_DIR, '.version');

// Claude Code settings.json
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Codex hooks and feature flag config
const CODEX_DIR         = path.join(os.homedir(), '.codex');
const CODEX_HOOKS_JSON  = path.join(CODEX_DIR, 'hooks.json');
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');

const APPROVAL_HOOK_JS  = path.join(INSTALL_DIR, 'approval-hook.js');
const APPROVAL_SERVER_JS = path.join(INSTALL_DIR, 'approval-server.js');
const RUNTIME_JSON      = path.join(INSTALL_DIR, 'runtime.json');

// Old skill path (for migration)
const OLD_SKILL_PATH  = '.claude/skills/cc-sticky-notify/scripts/notify.sh';
const NEW_NOTIFY_PATH = '$HOME/.cc-notify/notify.sh';

// ─── Env config key → shell env var mapping ──────────────────────────────────
const ENV_KEY_MAP = {
  close_timeout: 'CC_STICKY_NOTIFY_CLOSE_TIMEOUT',
};

const adapters = {
  claude: {
    buildAllowResponse() {
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    },
    buildDenyResponse(message) {
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: message || 'Denied from cc-notify' } } };
    },
    buildNoDecisionResponse() { return null; }
  },
  codex: {
    buildAllowResponse() {
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    },
    buildDenyResponse(message) {
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: message || 'Denied from cc-notify' } } };
    },
    // Codex expects "{}" (not empty stdout) to fall back to native approval.
    buildNoDecisionResponse() { return {}; }
  }
};

// ─── settings.json read/write ────────────────────────────────────────────────

/**
 * Read ~/.claude/settings.json. Returns parsed object or throws with a clear message.
 */
function readSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) {
    throw new Error(`settings.json not found: ${CLAUDE_SETTINGS}\nPlease ensure Claude Code is installed.`);
  }
  const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse settings.json: ${e.message}`);
  }
}

/**
 * Create a timestamped backup of ~/.claude/settings.json before modifying it.
 * Backup path: ~/.claude/settings.json.bak.YYYYMMDD-HHMMSS
 * Returns the backup file path, or null if settings.json doesn't exist.
 */
function backupSettings() {
  return backupFile(CLAUDE_SETTINGS);
}

/**
 * Create a timestamped backup of a file before modifying it.
 * Backup path: <file>.bak.YYYYMMDD-HHMMSS
 * Returns the backup file path, or null if the file doesn't exist.
 */
function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const backupPath = `${filePath}.bak.${ts}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Write object back to ~/.claude/settings.json with 2-space indentation.
 * Preserves trailing newline.
 */
function writeSettings(config) {
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ─── Codex config read/write ────────────────────────────────────────────────

function readCodexHooks() {
  if (!fs.existsSync(CODEX_HOOKS_JSON)) return {};
  const raw = fs.readFileSync(CODEX_HOOKS_JSON, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse hooks.json: ${e.message}`);
  }
}

function writeCodexHooks(config) {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(CODEX_HOOKS_JSON, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function readCodexConfigToml() {
  if (!fs.existsSync(CODEX_CONFIG_TOML)) return '';
  return fs.readFileSync(CODEX_CONFIG_TOML, 'utf8');
}

function writeCodexConfigToml(content) {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(CODEX_CONFIG_TOML, content, 'utf8');
}

function ensureCodexHooksFeature(content) {
  const lines = content ? content.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }
  let featuresStart = -1, featuresEnd = lines.length;
  for (let i = 0; i < lines.length; i++) { if (/^\s*\[features\]\s*$/.test(lines[i])) { featuresStart = i; break; } }
  if (featuresStart >= 0) {
    for (let i = featuresStart + 1; i < lines.length; i++) { if (/^\s*\[.*\]\s*$/.test(lines[i])) { featuresEnd = i; break; } }
    for (let i = featuresStart + 1; i < featuresEnd; i++) {
      if (/^\s*(codex_hooks|hooks)\s*=/.test(lines[i])) {
        lines[i] = lines[i].replace(/^(\s*)(codex_hooks|hooks)\s*=.*$/, '$1hooks = true');
        return lines.join('\n') + '\n';
      }
    }
    lines.splice(featuresEnd, 0, 'hooks = true');
    return lines.join('\n') + '\n';
  }
  if (lines.length > 0 && lines[lines.length - 1] !== '') { lines.push(''); }
  lines.push('[features]', 'hooks = true');
  return lines.join('\n') + '\n';
}

function isCodexHooksFeatureEnabled(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let inFeatures = false;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) { inFeatures = /^\s*\[features\]\s*$/.test(line); continue; }
    if (inFeatures) {
      if (/^\s*codex_hooks\s*=\s*true\s*(?:#.*)?$/i.test(line)) return true;
      if (/^\s*hooks\s*=\s*true\s*(?:#.*)?$/i.test(line)) return true;
    }
  }
  return false;
}

// ─── Codex TOML hooks manipulation ────────────────────────────────────

/**
 * Parse config.toml text into structured blocks for safe manipulation.
 *
 * Splits on `[section]` and `[[array]]` headers. Each block has:
 *   { type, header?, lines[] }
 * Types:
 *   'preamble'    — key=value lines before the first [section]
 *   'hook-group'  — [[hooks.<Event>]] header, may contain matcher field
 *   'hook-entry'  — [[hooks.<Event>.hooks]] header, contains command/type/etc.
 *   'other'       — any other section (features, hooks.state, plugins, projects, …)
 *
 * Internal helper. Public functions below use this to surgically
 * add/remove/check hooks without touching anything else.
 */
function parseTomlBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  const preambleLines = [];
  let i = 0;

  // Collect preamble (lines before first [section])
  while (i < lines.length && !/^\[/.test(lines[i])) {
    preambleLines.push(lines[i]);
    i++;
  }
  if (preambleLines.length > 0) {
    blocks.push({ type: 'preamble', lines: preambleLines });
  }

  // Parse sections
  while (i < lines.length) {
    const headerLine = lines[i];
    const isDouble = headerLine.startsWith('[[');
    const contentLines = [];
    i++;

    while (i < lines.length && !/^\[/.test(lines[i])) {
      contentLines.push(lines[i]);
      i++;
    }

    const key = headerLine.replace(/^\[+|\]+$/g, '').trim();

    if (isDouble && /^hooks\.\w+\.hooks$/.test(key)) {
      const eventName = key.match(/^hooks\.(\w+)\.hooks$/)[1];
      blocks.push({ type: 'hook-entry', eventName, header: headerLine, lines: contentLines });
    } else if (isDouble && /^hooks\.\w+$/.test(key)) {
      const eventName = key.match(/^hooks\.(\w+)$/)[1];
      blocks.push({ type: 'hook-group', eventName, header: headerLine, lines: contentLines });
    } else {
      blocks.push({ type: 'other', header: headerLine, lines: contentLines });
    }
  }

  return blocks;
}

/**
 * Rejoin parsed blocks into TOML text with trailing newline.
 * Internal helper.
 */
function blocksToText(blocks) {
  const lines = [];
  for (const block of blocks) {
    if (block.type === 'preamble') {
      for (const line of block.lines) lines.push(line);
    } else {
      lines.push(block.header);
      for (const line of block.lines) lines.push(line);
    }
  }
  // Normalise: max one blank line between blocks, ensure ending newline
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/**
 * Build [[hooks.*]] TOML text from hook definitions.
 * Internal helper for upsertCodexTomlHooks.
 */
function buildCodexHooksToml(hookDefs) {
  const parts = [];
  for (const def of hookDefs) {
    const { event, matcher, entry } = def;

    parts.push(`[[hooks.${event}]]`);
    if (matcher) {
      parts.push(`matcher = "${matcher}"`);
    }
    parts.push('');
    parts.push(`[[hooks.${event}.hooks]]`);
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'number') {
        parts.push(`${key} = ${value}`);
      } else {
        parts.push(`${key} = "${value}"`);
      }
    }
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Remove all cc-notify hook entries from config.toml text.
 *
 * NON-INVASIVE guarantees:
 *   - Only removes [[hooks.<Event>.hooks]] blocks whose command line
 *     references "cc-notify" or "cc-sticky-notify".
 *   - Does NOT touch [hooks.state."…"] sections.
 *   - Does NOT touch other tools' hook entries.
 *   - Cleans up orphan group headers ([[hooks.<Event>]] with no hooks left).
 *   - All other config (features, plugins, projects, …) passes through unchanged.
 *
 * @param {string} text - config.toml content
 * @returns {string} - config.toml with cc-notify hooks removed
 */
function removeCodexTomlHooks(text) {
  const blocks = parseTomlBlocks(text);

  // Step 1: Remove cc-notify hook entry blocks
  const filtered = blocks.filter(block => {
    if (block.type !== 'hook-entry') return true;
    const isCcNotify = block.lines.some(line =>
      /^\s*command\s*=\s*".*(?:cc-notify|cc-sticky-notify)/.test(line)
    );
    return !isCcNotify;
  });

  // Step 2: Remove orphan group headers
  // A group header is orphan when, after removing cc-notify entries,
  // no [[hooks.<Event>.hooks]] blocks exist under it before the next
  // group header for the *same* event.
  const finalBlocks = [];
  for (let i = 0; i < filtered.length; i++) {
    const block = filtered[i];
    if (block.type !== 'hook-group') {
      finalBlocks.push(block);
      continue;
    }

    let hasHooks = false;
    for (let j = i + 1; j < filtered.length; j++) {
      const next = filtered[j];
      // Next group header for the same event → end of this group's scope
      if (next.type === 'hook-group' && next.eventName === block.eventName) break;
      if (next.type === 'hook-entry' && next.eventName === block.eventName) {
        hasHooks = true;
        break;
      }
    }

    if (hasHooks) finalBlocks.push(block);
    // else: skip orphan group header
  }

  return blocksToText(finalBlocks);
}

/**
 * Ensure cc-notify hooks are present in config.toml.
 *
 * Idempotent: removes any stale cc-notify hooks first, then appends
 * fresh entries at the end of the file.  Also ensures [features] hooks=true.
 *
 * NON-INVASIVE: only appends to the file; never modifies existing
 * non-cc-notify content.
 *
 * @param {string} text - config.toml content
 * @param {Array}  hookDefs - CODEX_HOOK_DEFINITIONS from init.js
 * @returns {string} - updated config.toml
 */
function upsertCodexTomlHooks(text, hookDefs) {
  // Step 1: Remove any existing cc-notify hooks (makes it idempotent)
  let result = removeCodexTomlHooks(text);

  // Step 2: Append fresh hook blocks
  const newToml = buildCodexHooksToml(hookDefs);
  result = result.trimEnd() + '\n' + newToml + '\n';

  // Step 3: Ensure [features] hooks = true
  result = ensureCodexHooksFeature(result.trimEnd());
  return result.endsWith('\n') ? result : result + '\n';
}

/**
 * Check which cc-notify hooks are configured in config.toml.
 * Read-only. Returns the same shape as hookChecks with a `found` boolean.
 *
 * @param {string} text - config.toml content
 * @param {Array}  hookChecks - [{ event, matcher }, …] from status.js
 * @returns {Array<{event: string, matcher: string|null, found: boolean}>}
 */
function findCodexTomlHooks(text, hookChecks) {
  const blocks = parseTomlBlocks(text);

  const results = hookChecks.map(c => ({
    event: c.event,
    matcher: c.matcher || null,
    found: false,
  }));

  let currentGroupEvent = null;
  let currentGroupMatcher = null;

  for (const block of blocks) {
    if (block.type === 'hook-group') {
      currentGroupEvent = block.eventName;
      currentGroupMatcher = null;
      for (const line of block.lines) {
        const m = line.match(/^\s*matcher\s*=\s*"(.*)"/);
        if (m) { currentGroupMatcher = m[1]; break; }
      }
    } else if (block.type === 'hook-entry') {
      const isCcNotify = block.lines.some(line =>
        /^\s*command\s*=\s*".*(?:cc-notify|cc-sticky-notify)/.test(line)
      );
      if (!isCcNotify) continue;

      const event = block.eventName;

      for (const result of results) {
        if (result.event !== event) continue;

        // Mirror the matcher matching logic from ensureHook in init.js
        const matcherMatches = result.matcher === null
          ? (currentGroupMatcher === null || currentGroupMatcher === '')
          : currentGroupMatcher === result.matcher;

        if (matcherMatches) result.found = true;
      }
    }
  }

  return results;
}

// ─── env.json read/write ─────────────────────────────────────────────────────

/**
 * Read ~/.cc-notify/env.json. Returns {} if the file doesn't exist.
 */
function readEnvJson() {
  if (!fs.existsSync(ENV_JSON)) return {};
  try {
    return JSON.parse(fs.readFileSync(ENV_JSON, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write env object to env.json, then regenerate env.sh.
 */
function writeEnvJson(envObj) {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(ENV_JSON, JSON.stringify(envObj, null, 2) + '\n', 'utf8');
  regenerateEnvSh(envObj);
}

/**
 * Regenerate ~/.cc-notify/env.sh from a flat/nested env object.
 * Known keys are mapped to their proper env var names.
 * Unknown leaf keys are uppercased and prefixed with CC_NOTIFY_.
 */
function regenerateEnvSh(envObj) {
  const lines = [
    '# Auto-generated by ccn set — DO NOT edit manually',
    `# Generated at: ${new Date().toISOString()}`,
    '',
  ];

  const entries = flattenEnvObj(envObj);
  for (const [key, value] of entries) {
    const envVar = resolveEnvVarName(key);
    // Shell-safe value: wrap in single quotes, escape any single quotes inside
    const safeVal = String(value).replace(/'/g, "'\\''");
    lines.push(`export ${envVar}='${safeVal}'`);
  }

  fs.writeFileSync(ENV_SH, lines.join('\n') + '\n', 'utf8');
}

/**
 * Flatten a potentially nested object into dot-notation key → value pairs.
 * E.g. { a: { b: 1 } } → [['a.b', 1]]
 */
function flattenEnvObj(obj, prefix = '') {
  const result = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result.push(...flattenEnvObj(v, fullKey));
    } else {
      result.push([fullKey, v]);
    }
  }
  return result;
}

/**
 * Resolve the env var name for a config key.
 * Known keys use the mapping table; others get CC_NOTIFY_ prefix + uppercased.
 */
function resolveEnvVarName(dotKey) {
  // Direct match
  if (ENV_KEY_MAP[dotKey]) return ENV_KEY_MAP[dotKey];
  // Convert dot.notation.key → CC_NOTIFY_DOT_NOTATION_KEY
  return 'CC_NOTIFY_' + dotKey.toUpperCase().replace(/\./g, '_');
}

/**
 * Set a value at a dot-notation path inside an object (mutates in place).
 * E.g. setNestedValue(obj, 'a.b.c', 42) sets obj.a.b.c = 42
 */
function setNestedValue(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  const lastKey = keys[keys.length - 1];
  // Auto-coerce numeric strings
  const num = Number(value);
  cur[lastKey] = value !== '' && !isNaN(num) ? num : value;
}

/**
 * Get a value at a dot-notation path from an object.
 */
function getNestedValue(obj, dotPath) {
  const keys = dotPath.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[k];
  }
  return cur;
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

/**
 * Check whether a command string references cc-notify (new or old paths).
 */
function isCcNotifyCommand(cmd) {
  return cmd.includes('cc-notify') || cmd.includes('cc-sticky-notify');
}

/**
 * Replace old skill paths with new ~/.cc-notify/ path in a command string.
 */
function migrateCommandPath(cmd) {
  // Replace both the full old path variants
  return cmd
    .replace(/\$HOME\/\.claude\/skills\/cc-sticky-notify\/scripts\//g, '$HOME/.cc-notify/')
    .replace(/~\/\.claude\/skills\/cc-sticky-notify\/scripts\//g, '$HOME/.cc-notify/')
    .replace(/\/Users\/[^/]+\/\.claude\/skills\/cc-sticky-notify\/scripts\//g, '$HOME/.cc-notify/');
}

function parseProviderTargets(args = []) {
  const codex = args.includes('--codex');
  const all = args.includes('--all');
  return {
    claude: all || !codex,
    codex: all || codex,
  };
}

module.exports = {
  INSTALL_DIR,
  NOTIFY_SH,
  APP_BUNDLE,
  APP_BINARY,
  ENV_JSON,
  ENV_SH,
  VERSION_FILE,
  CLAUDE_SETTINGS,
  CODEX_DIR,
  CODEX_HOOKS_JSON,
  CODEX_CONFIG_TOML,
  APPROVAL_HOOK_JS,
  APPROVAL_SERVER_JS,
  RUNTIME_JSON,
  OLD_SKILL_PATH,
  NEW_NOTIFY_PATH,
  ENV_KEY_MAP,
  adapters,
  readSettings,
  backupSettings,
  backupFile,
  writeSettings,
  readCodexHooks,
  writeCodexHooks,
  readCodexConfigToml,
  writeCodexConfigToml,
  ensureCodexHooksFeature,
  isCodexHooksFeatureEnabled,
  upsertCodexTomlHooks,
  removeCodexTomlHooks,
  findCodexTomlHooks,
  readEnvJson,
  writeEnvJson,
  regenerateEnvSh,
  flattenEnvObj,
  resolveEnvVarName,
  setNestedValue,
  getNestedValue,
  isCcNotifyCommand,
  migrateCommandPath,
  parseProviderTargets,
};
