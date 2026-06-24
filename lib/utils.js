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

// Old skill path (for migration)
const OLD_SKILL_PATH  = '.claude/skills/cc-sticky-notify/scripts/notify.sh';
const NEW_NOTIFY_PATH = '$HOME/.cc-notify/notify.sh';

// ─── Env config key → shell env var mapping ──────────────────────────────────
const ENV_KEY_MAP = {
  close_timeout: 'CC_STICKY_NOTIFY_CLOSE_TIMEOUT',
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
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[features\]\s*$/.test(lines[i])) {
      featuresStart = i;
      break;
    }
  }

  if (featuresStart >= 0) {
    for (let i = featuresStart + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) {
        featuresEnd = i;
        break;
      }
    }

    for (let i = featuresStart + 1; i < featuresEnd; i++) {
      const match = lines[i].match(/^(\s*)codex_hooks\s*=/);
      if (match) {
        lines[i] = `${match[1]}codex_hooks = true`;
        return lines.join('\n') + '\n';
      }
    }

    lines.splice(featuresEnd, 0, 'codex_hooks = true');
    return lines.join('\n') + '\n';
  }

  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.push('');
  }
  lines.push('[features]', 'codex_hooks = true');
  return lines.join('\n') + '\n';
}

function isCodexHooksFeatureEnabled(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let inFeatures = false;

  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inFeatures = /^\s*\[features\]\s*$/.test(line);
      continue;
    }
    if (inFeatures && /^\s*codex_hooks\s*=\s*true\s*(?:#.*)?$/i.test(line)) {
      return true;
    }
  }
  return false;
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
  OLD_SKILL_PATH,
  NEW_NOTIFY_PATH,
  ENV_KEY_MAP,
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
