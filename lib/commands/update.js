'use strict';

/**
 * ccn update [--recompile]
 *
 * Re-copy notify.sh from the npm package to ~/.cc-notify/.
 * Optionally recompile the Swift app.
 *
 * Flags:
 *   --recompile   Force Swift recompilation even if version matches
 *
 * This is useful when:
 *   - postinstall failed during npm install/update
 *   - Files in ~/.cc-notify/ got corrupted
 *   - You want to force-refresh after a version change
 */

const cp   = require('child_process');
const path = require('path');
const { INSTALL_DIR } = require('../utils');

function run(args) {
  const forceRecompile = args.includes('--recompile') || args.includes('--force');

  const env = Object.assign({}, process.env, {
    CC_NOTIFY_FORCE_RECOMPILE: forceRecompile ? '1' : '0',
  });

  const postinstallScript = path.resolve(__dirname, '../../scripts/postinstall.js');

  process.stdout.write(`Updating cc-notify installation at: ${INSTALL_DIR}\n`);
  if (forceRecompile) {
    process.stdout.write('Force recompile: enabled\n');
  }
  process.stdout.write('\n');

  try {
    cp.execFileSync(process.execPath, [postinstallScript], {
      stdio: 'inherit',
      env,
    });
  } catch (e) {
    process.stderr.write(`ccn update: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { run };
