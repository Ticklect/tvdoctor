import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AndroidObserverClient } from '../packages/driver-android/dist/observer-client.js';
import { AndroidTvDriver } from '../packages/driver-android/dist/android-driver.js';

const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const adb = process.env.ADB ?? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const serial = process.env.ANDROID_SERIAL ?? 'emulator-5554';
const target = 'org.tvdoctor.observer.securityprobe';
const legacy = process.argv.includes('--legacy-bootstrap');
function command(args) {
  try {
    return execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    // Tokens may appear in ADB arguments. Never include child-process errors.
    throw new Error('Android security test ADB operation failed.');
  }
}
function provision(token, packageName = target) {
  if (legacy) {
    command(['shell', 'am', 'start', '-W', '-n', 'org.tvdoctor.observer/.SetupActivity', '--es', 'tvdoctor_token', token]);
    return;
  }
  const result = command(['shell', 'content', 'call', '--uri', 'content://org.tvdoctor.observer.provisioning',
    '--method', 'provision', '--extra', `token:s:${token}`, '--extra', `target_package:s:${packageName}`]);
  assert.match(result, /result=provisioned/u, 'shell provisioning must succeed');
}
command(['install', '-r', 'packages/driver-android/observer/tvdoctor-observer.apk']);
command(['install', '-r', 'artifacts/android-security-probe/probe.apk']);
command(['shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', 'org.tvdoctor.observer/org.tvdoctor.observer.ObserverAccessibilityService']);
command(['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1']);
command(['shell', 'am', 'start', '-W', '-n', 'org.tvdoctor.observer/.SetupActivity']);
await delay(1500);
const port = Number(command(['forward', 'tcp:0', 'tcp:38337']));
let client;
const connect = (token) => AndroidObserverClient.connect({ port, token, hostVersion: '0.1.0', connectTimeoutMs: 3000, requestTimeoutMs: 6000 });
try {
  await test('ordinary application UID cannot provision or authenticate with an activity-injected token', async () => {
    const result = command(['shell', 'am', 'instrument', '-w', `${target}/.ProbeInstrumentation`]);
    const uid = /uid=(\d+)/u.exec(result)?.[1];
    assert.ok(Number(uid) >= 10000, 'the probe must execute as an unprivileged application UID');
    assert.match(result, /activity_socket=DENIED/u, 'the activity must not accept a chosen observer token');
    assert.match(result, /provider=DENIED/u, 'the provisioning provider must reject the application UID');
  });
  const token = randomBytes(32).toString('hex');
  provision(token);
  await delay(200);
  client = await connect(token);
  await test('authenticated persistent observations survive host work between requests', async () => {
    await delay(5200);
    await assert.doesNotReject(client.request({ type: 'ping' }));
  });
  await test('HELLO consumes provisioning credentials, including on the authenticated connection', async () => {
    await assert.rejects(client.request({ type: 'hello', token, hostVersion: '0.1.0' }), /rejected|already|authentication/u);
  });
  await test('password accessibility text, descriptions and focus names are redacted', async () => {
    command(['shell', 'am', 'start', '-W', '-n', `${target}/.ProbeActivity`]);
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      response = await client.request({ type: 'current_state', forceFull: true });
      if (JSON.stringify(response).includes('TVDOCTOR_PUBLIC_SECURITY_PROBE')) break;
      await delay(100);
    }
    const json = JSON.stringify(response);
    assert.match(json, /TVDOCTOR_PUBLIC_SECURITY_PROBE/u, 'the public target marker must be observable');
    assert.doesNotMatch(json, /TVDOCTOR_PASSWORD_SENTINEL|TVDOCTOR_PASSWORD_DESCRIPTION/u);
  });
  await test('an active window outside the provisioned package exposes no content and retains only the target identity', async () => {
    command(['shell', 'am', 'start', '-W', '-n', 'org.tvdoctor.observer/.SetupActivity']);
    await delay(500);
    const response = await client.request({ type: 'current_state', forceFull: true });
    assert.equal(response.state.packageName, target);
    assert.deepEqual(response.state.nodes, []);
    assert.equal(response.state.focused, null);
    assert.equal(response.state.windowClassName, null);
  });
  client.close(); client = undefined;
  await delay(200);
  await test('a consumed token cannot authenticate a new connection', async () => {
    let replay;
    try { replay = await connect(token); }
    catch (error) { assert.match(error.message, /rejected|authentication/u); return; }
    replay.close();
    assert.fail('consumed token authenticated a new connection');
  });
  await test('packaged driver verifies installed identity and completes queued real-device operations with scoped logs', async () => {
    const driver = new AndroidTvDriver({ serial, adbPath: adb });
    try {
      await driver.waitForDeviceReady(10000);
      await driver.launch({ id: target, launchUri: '.ProbeActivity' });
      const [press, snapshot] = await Promise.all([driver.press('RIGHT'), driver.snapshot(), driver.reset('relaunch')]);
      assert.equal(press.outcome, 'applied');
      assert.match(snapshot.location.value, /org.tvdoctor.observer.securityprobe/u);
      const logs = await driver.getLogs();
      assert.ok(logs.some((entry) => entry.message === 'TVDOCTOR_PUBLIC_SECURITY_LOG'), 'target launch logs must be retained');
      const app = await driver.getAppMetadata();
      assert.ok(logs.every((entry) => entry.pid === app.pid));
    } finally { await driver.close(); }
  });
} finally {
  client?.close();
  command(['forward', '--remove', `tcp:${String(port)}`]);
  command(['shell', 'am', 'force-stop', target]);
}
