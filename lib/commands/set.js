'use strict';

/**
 * ccn set [key=value]
 *
 * Manage ~/.cc-notify/env.json config.
 *
 * Usage:
 *   ccn set                  — list all current config values
 *   ccn set close_timeout=300
 *   ccn set a.b.c=hello      — dot notation for nested keys
 */

const {
  ENV_JSON,
  ENV_SH,
  readEnvJson,
  writeEnvJson,
  flattenEnvObj,
  resolveEnvVarName,
  setNestedValue,
} = require('../utils');

function run(args) {
  if (args.length === 0 || args[0] === '--list' || args[0] === '-l') {
    return listConfig();
  }

  // Each arg should be key=value
  const envObj = readEnvJson();
  let changed = 0;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) {
      process.stderr.write(`ccn set: invalid argument '${arg}' — expected key=value\n`);
      process.exit(1);
    }

    const key   = arg.slice(0, eqIdx).trim();
    const value = arg.slice(eqIdx + 1).trim();

    if (!key) {
      process.stderr.write(`ccn set: empty key in '${arg}'\n`);
      process.exit(1);
    }

    setNestedValue(envObj, key, value);
    const envVar = resolveEnvVarName(key);
    process.stdout.write(`  set  ${key} = ${value}  (→ ${envVar})\n`);
    changed++;
  }

  if (changed > 0) {
    writeEnvJson(envObj);
    process.stdout.write(`\nSaved to: ${ENV_JSON}\n`);
    process.stdout.write(`Shell:    ${ENV_SH}\n`);
  }
}

function listConfig() {
  const envObj = readEnvJson();
  const entries = flattenEnvObj(envObj);

  if (entries.length === 0) {
    process.stdout.write('No config found. Run: ccn set close_timeout=10800\n');
    return;
  }

  process.stdout.write(`Config: ${ENV_JSON}\n\n`);
  const keyW = Math.max(...entries.map(([k]) => k.length), 15);
  const varW = Math.max(...entries.map(([k]) => resolveEnvVarName(k).length), 20);

  process.stdout.write(
    `${'KEY'.padEnd(keyW)}  ${'ENV VAR'.padEnd(varW)}  VALUE\n`
  );
  process.stdout.write(`${'-'.repeat(keyW)}  ${'-'.repeat(varW)}  -----\n`);

  for (const [key, value] of entries) {
    const envVar = resolveEnvVarName(key);
    process.stdout.write(`${key.padEnd(keyW)}  ${envVar.padEnd(varW)}  ${value}\n`);
  }
}

module.exports = { run };
