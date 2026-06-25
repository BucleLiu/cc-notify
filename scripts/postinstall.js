#!/usr/bin/env node
/**
 * cc-notify postinstall script
 *
 * Runs automatically after `npm install -g cc-notify` or `npm update -g cc-notify`.
 * Also called by `ccn update`.
 *
 * Steps:
 *   1. Platform check (macOS only, exit gracefully on others)
 *   2. Xcode Command Line Tools check
 *   3. Create ~/.cc-notify/
 *   4. Copy notify.sh → ~/.cc-notify/notify.sh (always, picks up script updates)
 *   5. Compile sticky-window.swift → ~/.cc-notify/sticky-notify.app/ (skipped if version matches)
 *   6. Write Info.plist + codesign
 *   7. Initialize env.json with defaults (if not exists)
 *   8. Regenerate env.sh from env.json
 *   9. Write ~/.cc-notify/.version
 *  10. Print next-step hint
 *
 * Force recompile: set env var CC_NOTIFY_FORCE_RECOMPILE=1
 */

'use strict';

const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const cp      = require('child_process');

// ─── Resolve package root (works both from repo and npm global install) ───────
const PKG_DIR     = path.resolve(__dirname, '..');
const PKG_JSON    = require(path.join(PKG_DIR, 'package.json'));
const CURRENT_VER = PKG_JSON.version;

// Source files (inside the npm package)
const SRC_NOTIFY_SH = path.join(PKG_DIR, 'scripts', 'notify.sh');
const SRC_SWIFT     = path.join(PKG_DIR, 'scripts', 'sticky-window.swift');
const SRC_APPROVAL_HOOK   = path.join(PKG_DIR, 'scripts', 'approval-hook.js');
const SRC_APPROVAL_SERVER = path.join(PKG_DIR, 'scripts', 'approval-server.js');

// Install directory
const INSTALL_DIR  = path.join(os.homedir(), '.cc-notify');
const NOTIFY_SH    = path.join(INSTALL_DIR, 'notify.sh');
const APP_BUNDLE   = path.join(INSTALL_DIR, 'sticky-notify.app');
const APP_MACOS    = path.join(APP_BUNDLE, 'Contents', 'MacOS');
const APP_BINARY   = path.join(APP_MACOS, 'sticky-notify-app');
const INFO_PLIST   = path.join(APP_BUNDLE, 'Contents', 'Info.plist');
const ENV_JSON     = path.join(INSTALL_DIR, 'env.json');
const VERSION_FILE = path.join(INSTALL_DIR, '.version');

const { regenerateEnvSh, readEnvJson, writeEnvJson } = require(path.join(PKG_DIR, 'lib', 'utils.js'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg)  { process.stdout.write(`[cc-notify] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[cc-notify] WARNING: ${msg}\n`); }

function run(cmd, opts = {}) {
  return cp.execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
}

function runSilent(cmd) {
  try {
    return run(cmd, { silent: true }).toString().trim();
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // 1. Platform check
  if (os.platform() !== 'darwin') {
    log('Skipping install — cc-notify requires macOS.');
    process.exit(0);
  }

  // 2. Xcode CLT check
  const xcodeOk = runSilent('xcode-select -p');
  if (!xcodeOk) {
    warn('Xcode Command Line Tools not found.');
    warn('Install them with: xcode-select --install');
    warn('Then run: ccn update');
    warn('Skipping Swift compilation — notifications will not appear.');
    // Don't exit 1; let npm install succeed so ccn CLI is still available
  }

  // 3. Create install directory
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  log(`Install directory: ${INSTALL_DIR}`);

  // 4. Copy notify.sh (always — picks up script changes on npm update)
  fs.copyFileSync(SRC_NOTIFY_SH, NOTIFY_SH);
  fs.chmodSync(NOTIFY_SH, 0o755);
  log('Copied notify.sh');

  // 4b. Copy approval scripts (always — picks up updates on npm update)
  for (const [src, name] of [
    [SRC_APPROVAL_HOOK, 'approval-hook.js'],
    [SRC_APPROVAL_SERVER, 'approval-server.js'],
  ]) {
    if (fs.existsSync(src)) {
      const dest = path.join(INSTALL_DIR, name);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
      log(`Copied ${name}`);
    }
  }

  // 5. Compile Swift (skip if version matches and binary exists)
  const forceRecompile = process.env.CC_NOTIFY_FORCE_RECOMPILE === '1';
  const installedVer   = fs.existsSync(VERSION_FILE)
    ? fs.readFileSync(VERSION_FILE, 'utf8').trim()
    : null;
  const needsCompile   = forceRecompile
    || !fs.existsSync(APP_BINARY)
    || installedVer !== CURRENT_VER;

  if (!xcodeOk) {
    warn('Skipping Swift compilation (Xcode CLT missing).');
  } else if (!needsCompile) {
    log(`Swift app up-to-date (v${CURRENT_VER}), skipping recompile.`);
  } else {
    log('Compiling sticky-window.swift (this may take ~30s on first run)...');
    compileSwift();
  }

  // 7. Init env.json with defaults if missing
  if (!fs.existsSync(ENV_JSON)) {
    const defaults = { close_timeout: 10800 };
    writeEnvJson(defaults);
    log('Created env.json with defaults.');
  } else {
    // Always regenerate env.sh in case format changed
    regenerateEnvSh(readEnvJson());
    log('Regenerated env.sh from existing env.json.');
  }

  // 9. Write version file
  fs.writeFileSync(VERSION_FILE, CURRENT_VER + '\n', 'utf8');

  // 10. Next step hint
  log(`Done! v${CURRENT_VER} installed.`);
  log('Run: ccn init   — to configure Claude Code hooks');
  log('Run: ccn status — to check installation state');
}

// ─── Swift compilation ────────────────────────────────────────────────────────

function compileSwift() {
  // Create bundle directories
  fs.mkdirSync(APP_MACOS, { recursive: true });

  // Write a temp binary path (swiftc outputs to current dir)
  const tmpBin = path.join(INSTALL_DIR, '_sticky-notify-app-tmp');

  try {
    run(`swiftc "${SRC_SWIFT}" -o "${tmpBin}"`, { stdio: 'inherit' });
  } catch (e) {
    warn(`Swift compilation failed: ${e.message}`);
    warn('Run: ccn update --recompile   to retry after fixing the issue.');
    return;
  }

  // Move compiled binary into bundle
  fs.renameSync(tmpBin, APP_BINARY);
  fs.chmodSync(APP_BINARY, 0o755);

  // Write Info.plist
  fs.writeFileSync(INFO_PLIST, INFO_PLIST_CONTENT, 'utf8');

  // Codesign
  const entitlementsPath = path.join(INSTALL_DIR, '_cc-notify.entitlements');
  fs.writeFileSync(entitlementsPath, ENTITLEMENTS_CONTENT, 'utf8');

  try {
    run(
      `codesign --sign - --force --deep --timestamp=none --entitlements "${entitlementsPath}" "${APP_BUNDLE}"`,
      { stdio: 'pipe' }
    );
    log('Swift app compiled and signed.');
  } catch (e) {
    warn(`codesign failed (app may still work): ${e.message}`);
  } finally {
    try { fs.unlinkSync(entitlementsPath); } catch {}
  }
}

// ─── Embedded file content ────────────────────────────────────────────────────

const INFO_PLIST_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>sticky-notify-app</string>
  <key>CFBundleIdentifier</key>
  <string>com.cc-notify.app</string>
  <key>CFBundleName</key>
  <string>cc-notify</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>cc-notify needs Apple Events to detect the source terminal window.</string>
</dict>
</plist>
`;

const ENTITLEMENTS_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <false/>
  <key>com.apple.security.automation.apple-events</key>
  <true/>
</dict>
</plist>
`;

// ─── Run ──────────────────────────────────────────────────────────────────────
main();
