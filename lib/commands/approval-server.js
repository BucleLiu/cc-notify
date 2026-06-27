'use strict';

/**
 * ccn approval-server [start|stop|status]
 *
 * Manually control the cc-notify approval HTTP server.
 *
 * The server normally auto-starts when a PermissionRequest hook fires and
 * auto-stops after 30 minutes of inactivity.  These commands let you
 * explicitly start or stop it — useful after deploying code changes.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');
const cp   = require('child_process');
const os   = require('os');

const INSTALL_DIR  = path.join(os.homedir(), '.cc-notify');
const RUNTIME_JSON = path.join(INSTALL_DIR, 'runtime.json');
const SERVER_JS    = path.join(INSTALL_DIR, 'approval-server.js');

function readRuntime() {
  try {
    const raw = fs.readFileSync(RUNTIME_JSON, 'utf8');
    const data = JSON.parse(raw);
    if (data.error || !data.port || !data.pid) return null;
    try { process.kill(data.pid, 0); } catch { return null; }
    return data;
  } catch { return null; }
}

function httpGet(port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function showStatus() {
  const rt = readRuntime();
  if (!rt) {
    process.stdout.write('Approval server: not running\n');
    process.stdout.write(`Start it with: ccn approval-server start\n`);
    return;
  }

  const uptime = Math.floor((Date.now() - new Date(rt.startedAt).getTime()) / 1000);
  process.stdout.write(`Approval server: running\n`);
  process.stdout.write(`  PID:       ${rt.pid}\n`);
  process.stdout.write(`  Port:      ${rt.port}\n`);
  process.stdout.write(`  Version:   ${rt.version || 'unknown'}\n`);
  process.stdout.write(`  Uptime:    ${uptime}s (${Math.floor(uptime / 60)}m)\n`);

  try {
    const body = await httpGet(rt.port, '/state', 2000);
    const state = JSON.parse(body);
    process.stdout.write(`  Pending:   ${state.pendingCount || 0} request(s)\n`);
  } catch {
    // /state unavailable — server may be starting up
  }
}

function doStart() {
  const rt = readRuntime();
  if (rt) {
    process.stdout.write(`Approval server already running (pid ${rt.pid}, port ${rt.port})\n`);
    process.stdout.write(`Run 'ccn approval-server stop' to restart it.\n`);
    return;
  }

  if (!fs.existsSync(SERVER_JS)) {
    process.stderr.write(`ccn approval-server: server script not found at ${SERVER_JS}\n`);
    process.stderr.write('Run ccn update first.\n');
    process.exit(1);
  }

  cp.spawn(process.execPath, [SERVER_JS], { detached: true, stdio: 'ignore' }).unref();

  // Poll for runtime.json (server writes it after binding a port)
  const start = Date.now();
  const poll = setInterval(() => {
    const rt = readRuntime();
    if (rt) {
      clearInterval(poll);
      process.stdout.write(`Approval server started (pid ${rt.pid}, port ${rt.port})\n`);
      return;
    }
    if (Date.now() - start > 5000) {
      clearInterval(poll);
      process.stderr.write('ccn approval-server: timed out waiting for server to start\n');
      process.stderr.write('Check ~/.cc-notify/runtime.json for errors.\n');
      process.exit(1);
    }
  }, 200);
}

function doStop() {
  const rt = readRuntime();
  if (!rt) {
    process.stdout.write('Approval server is not running.\n');
    return;
  }

  try { process.kill(rt.pid, 'SIGTERM'); } catch (e) {
    process.stderr.write(`ccn approval-server: failed to kill pid ${rt.pid}: ${e.message}\n`);
    process.exit(1);
  }

  // Wait for process to exit (server deletes runtime.json on exit)
  const start = Date.now();
  const poll = setInterval(() => {
    try { process.kill(rt.pid, 0); } catch {
      clearInterval(poll);
      process.stdout.write(`Approval server stopped (was pid ${rt.pid}).\n`);
      return;
    }
    if (Date.now() - start > 5000) {
      clearInterval(poll);
      process.stderr.write(`ccn approval-server: server did not stop within 5s, sending SIGKILL\n`);
      try { process.kill(rt.pid, 'SIGKILL'); } catch (_) {}
      try { fs.unlinkSync(RUNTIME_JSON); } catch (_) {}
    }
  }, 200);
}

function run(args) {
  const sub = args[0] || 'status';

  switch (sub) {
    case 'start':
      doStart();
      break;
    case 'stop':
      doStop();
      break;
    case 'status':
      showStatus();
      break;
    default:
      process.stderr.write(`ccn approval-server: unknown subcommand '${sub}'\n`);
      process.stderr.write(`Usage: ccn approval-server [start|stop|status]\n`);
      process.exit(1);
  }
}

module.exports = { run };
