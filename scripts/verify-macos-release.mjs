import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
export const expectedVersion = '2.0.0-desktop.0';

function releaseError(message) {
  return new Error(message);
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function required(target, root) {
  try { await fs.access(target); }
  catch { throw releaseError(`missing required release artifact: ${path.relative(root, target)}`); }
}

async function filesIn(directory, files = []) {
  const entries = await fs.readdir(directory, {withFileTypes:true});
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await filesIn(target, files);
    else files.push(target);
  }
  return files;
}

function oneArtifact(kind, matches, root) {
  if (matches.length === 0) throw releaseError(`missing expected ARM64 ${kind} under ${path.relative(root, path.join(root, 'make'))}`);
  if (matches.length > 1) throw releaseError(`ambiguous ${kind} artifacts: ${matches.map(file => path.relative(root, file)).join(', ')}`);
  return matches[0];
}

export async function discoverReleaseArtifacts({root = process.cwd(), output = path.resolve(root, 'out', 'macos-release'), version = expectedVersion} = {}) {
  const releaseRoot = path.resolve(output);
  const expectedApp = path.join(releaseRoot, 'Money Moves-darwin-arm64', 'Money Moves.app');
  const expectedDmgName = `Money Moves-${version}-arm64.dmg`;
  const expectedZipName = `Money Moves-darwin-arm64-${version}.zip`;
  const makeRoot = path.join(releaseRoot, 'make');

  if (!isWithin(path.resolve(root), releaseRoot)) throw releaseError('release output must remain inside the repository root.');
  await Promise.all([required(expectedApp, root), required(makeRoot, root)]);
  const makeFiles = await filesIn(makeRoot);
  const dmg = oneArtifact('DMG', makeFiles.filter(file => path.basename(file) === expectedDmgName), root);
  const zip = oneArtifact('ZIP', makeFiles.filter(file => path.basename(file) === expectedZipName), root);
  for (const artifact of [expectedApp, dmg, zip]) {
    if (!isWithin(releaseRoot, artifact)) throw releaseError('refusing artifact outside the isolated release output.');
  }
  return {
    app:expectedApp,
    dmg,
    zip,
    executable:path.join(expectedApp, 'Contents', 'MacOS', 'Money Moves'),
    info:path.join(expectedApp, 'Contents', 'Info.plist'),
    output:releaseRoot
  };
}

async function commandOutput(command, args) {
  const {stdout, stderr} = await run(command, args, {encoding:'utf8'});
  return `${stdout}\n${stderr}`.trim();
}

async function validateApp(app, {root, label}) {
  const executable = path.join(app, 'Contents', 'MacOS', 'Money Moves');
  const info = path.join(app, 'Contents', 'Info.plist');
  await Promise.all([required(app, root), required(executable, root), required(info, root)]);
  const [architectures, shortVersion, buildVersion] = await Promise.all([
    commandOutput('lipo', ['-archs', executable]),
    commandOutput('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', info]),
    commandOutput('plutil', ['-extract', 'CFBundleVersion', 'raw', info])
  ]);
  if (architectures.trim() !== 'arm64') throw releaseError(`${label} executable must be arm64, got ${architectures || 'no architecture'}.`);
  if (shortVersion.trim() !== expectedVersion || buildVersion.trim() !== expectedVersion) throw releaseError(`${label} version metadata does not match ${expectedVersion}.`);
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  return {executable, info};
}

async function findOneApp(directory, root, label) {
  const entries = await fs.readdir(directory, {withFileTypes:true});
  const apps = entries.filter(entry => entry.isDirectory() && entry.name === 'Money Moves.app').map(entry => path.join(directory, entry.name));
  if (apps.length === 0) throw releaseError(`${label} does not contain Money Moves.app.`);
  if (apps.length > 1) throw releaseError(`${label} contains ambiguous Money Moves.app bundles.`);
  if (!isWithin(directory, apps[0])) throw releaseError(`${label} app is outside its inspection directory.`);
  return apps[0];
}

async function inspectDmg(dmg, root) {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-v2d-dmg-'));
  try {
    await run('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mountPoint]);
    const app = await findOneApp(mountPoint, root, 'DMG');
    await validateApp(app, {root, label:'DMG app'});
  } finally {
    try { await run('hdiutil', ['detach', mountPoint]); }
    finally { await fs.rm(mountPoint, {recursive:true, force:true}); }
  }
}

async function inspectZip(zip, root) {
  const extractionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-v2d-zip-'));
  try {
    await run('ditto', ['-x', '-k', zip, extractionDirectory]);
    const app = await findOneApp(extractionDirectory, root, 'ZIP');
    await validateApp(app, {root, label:'ZIP app'});
  } finally {
    await fs.rm(extractionDirectory, {recursive:true, force:true});
  }
}

export async function verifyMacosRelease({root = process.cwd()} = {}) {
  const artifacts = await discoverReleaseArtifacts({root});
  await validateApp(artifacts.app, {root, label:'packaged app'});
  const [runtime, entitlements] = await Promise.all([
    commandOutput('codesign', ['-dvv', artifacts.app]),
    commandOutput('codesign', ['-d', '--entitlements', ':-', artifacts.app])
  ]);
  if (!runtime.includes('runtime')) throw releaseError('hardened runtime is absent from the app signature.');
  if (!entitlements.includes('com.apple.security.cs.allow-jit')) throw releaseError('expected JIT entitlement is absent.');
  for (const forbidden of ['allow-unsigned-executable-memory', 'disable-library-validation', 'device.camera', 'device.microphone', 'device.audio-input']) {
    if (entitlements.includes(forbidden)) throw releaseError(`unexpected entitlement: ${forbidden}`);
  }
  await run('xcrun', ['stapler', 'validate', artifacts.app]);
  await run('xcrun', ['stapler', 'validate', artifacts.dmg]);
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', artifacts.app]);
  await inspectDmg(artifacts.dmg, root);
  await inspectZip(artifacts.zip, root);
  return artifacts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const artifacts = await verifyMacosRelease();
    process.stdout.write(`Verified signed and notarized ARM64 artifacts: ${[artifacts.app, artifacts.dmg, artifacts.zip].map(file => path.relative(process.cwd(), file)).join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`macOS release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
