import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const windows = process.platform === 'win32';
const toolRoot = path.join(sdk, 'build-tools', '36.0.0');
const platform = readdirSync(path.join(sdk, 'platforms')).filter((item) => /^android-\d/u.test(item))
  .sort((a, b) => parseInt(b.slice(8), 10) - parseInt(a.slice(8), 10))[0];
if (!platform) throw new Error('An Android compile platform is required.');
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar');
const source = path.resolve('packages/driver-android/observer/test-helper');
const output = path.resolve('artifacts/android-security-probe');
mkdirSync(path.join(output, 'classes'), { recursive: true });
mkdirSync(path.join(output, 'dex'), { recursive: true });
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed: ${result.stderr ?? result.error?.message}`);
}
const native = (name) => path.join(toolRoot, name + (windows ? '.exe' : ''));
const apk = path.join(output, 'probe-unsigned.apk');
run(native('aapt2'), ['link', '-o', apk, '--manifest', path.join(source, 'AndroidManifest.xml'),
  '-I', androidJar, '--min-sdk-version', '23', '--target-sdk-version', '36']);
run('javac', ['--release', '17', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', path.join(output, 'classes'),
  ...readdirSync(source).filter((item) => item.endsWith('.java')).map((item) => path.join(source, item))]);
const classesJar = path.join(output, 'classes.jar');
run('jar', ['--create', '--file', classesJar, '-C', path.join(output, 'classes'), '.']);
run('java', ['-cp', path.join(toolRoot, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--min-api', '23',
  '--lib', androidJar, '--output', path.join(output, 'dex'), classesJar]);
run(native('aapt'), ['add', apk, 'classes.dex'], path.join(output, 'dex'));
const aligned = path.join(output, 'probe-aligned.apk');
run(native('zipalign'), ['-f', '4', apk, aligned]);
const keystore = path.join(output, 'probe.p12');
if (!readdirSync(output).includes('probe.p12')) {
  run('keytool', ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-storepass', 'android',
    '-keypass', 'android', '-alias', 'probe', '-dname', 'CN=TVDoctor Security Test', '-keyalg', 'RSA',
    '-keysize', '2048', '-validity', '3650', '-noprompt']);
}
run('java', ['-jar', path.join(toolRoot, 'lib', 'apksigner.jar'), 'sign', '--ks', keystore,
  '--ks-key-alias', 'probe', '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
  '--v4-signing-enabled', 'false', '--out', path.join(output, 'probe.apk'), aligned]);
console.log('Android adversarial helper APK built in artifacts/android-security-probe.');
