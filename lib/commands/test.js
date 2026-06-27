'use strict';

/**
 * ccn test
 *
 * Send a test notification to verify the installation works.
 */

const cp   = require('child_process');
const path = require('path');
const fs   = require('fs');
const { NOTIFY_SH } = require('../utils');

function run(_args) {
  if (!fs.existsSync(NOTIFY_SH)) {
    process.stderr.write(`ccn test: notify.sh not found at: ${NOTIFY_SH}\n`);
    process.stderr.write('Run: npm install -g cc-notify   to reinstall\n');
    process.exit(1);
  }

  const message = '✅ cc-notify test notification';
  process.stdout.write(`Sending: ${message}\n`);
  process.stdout.write(`Script:  ${NOTIFY_SH}\n\n`);

  try {
    cp.execFileSync(NOTIFY_SH, ['--urgent', '--state', 'completed', '--force', message], {
      stdio: 'inherit',
    });
    process.stdout.write('Notification sent. A sticky note should appear in the top-right corner.\n');
  } catch (e) {
    process.stderr.write(`ccn test: notification failed: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { run };
