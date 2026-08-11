import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {codesignArgumentsForComponent} from './macos-signing-policy.mjs';
import {discoverSignedComponents, validateSignedCodePolicies} from './verify-macos-release.mjs';

const run = promisify(execFile);
const identity = 'Developer ID Application';
const notaryProfile = 'MoneyMovesNotary';

function releaseError(message) {
  return new Error(message);
}

export function notarizationIssueCount(log, label = 'notarization') {
  if (!log || typeof log !== 'object' || Array.isArray(log)) {
    throw releaseError(`Apple ${label} log is not an inspectable object.`);
  }
  // notarytool currently serializes an empty issue list as null, while older
  // responses and non-empty results use an array. Accept only those two
  // documented shapes so an absent or malformed field still fails closed.
  if (log.issues === null) return 0;
  if (Array.isArray(log.issues)) return log.issues.length;
  throw releaseError(`Apple ${label} notarization log has no inspectable issue list.`);
}

async function requireDirectory(target) {
  let stat;
  try { stat = await fs.lstat(target); }
  catch { throw releaseError('missing freshly packaged release application.'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw releaseError('invalid freshly packaged release application.');
}

function signingDepth(component) {
  return component.relativePath === '.' ? 0 : component.relativePath.split('/').length;
}

export async function signMacosApplication(app, {entitlements = 'build/entitlements/macos-electron.plist'} = {}) {
  const components = await discoverSignedComponents(app);
  const signingOrder = [...components].sort((left, right) => {
    const depthDifference = signingDepth(right) - signingDepth(left);
    return depthDifference || left.relativePath.localeCompare(right.relativePath);
  });
  for (const component of signingOrder) {
    const args = codesignArgumentsForComponent(component.relativePath, {identity, entitlements});
    try { await run('codesign', [...args, component.path]); }
    catch { throw releaseError(`codesign failed for pinned component ${component.relativePath}.`); }
  }
  try { await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]); }
  catch { throw releaseError('fresh release application failed strict code-signature validation.'); }
  await validateSignedCodePolicies(app, 'pre-notarization app');
  return components;
}

export async function notarizeMacosApplication(app, releaseDirectory) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-v2d-app-notary-'));
  const archive = path.join(temporaryDirectory, 'Money Moves.zip');
  const provenanceFile = path.join(releaseDirectory, 'app-notarization.json');
  try {
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    const {stdout} = await run('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], {encoding:'utf8'});
    const result = JSON.parse(stdout);
    if (typeof result.id !== 'string' || !result.id) throw releaseError('Apple returned no application notarization submission ID.');
    const {stdout:logText} = await run('xcrun', ['notarytool', 'log', result.id, '--keychain-profile', notaryProfile], {encoding:'utf8'});
    const log = JSON.parse(logText);
    const issueCount = notarizationIssueCount(log, 'application');
    await fs.writeFile(provenanceFile, `${JSON.stringify({submissionId:result.id, status:result.status, issueCount}, null, 2)}\n`, {mode:0o600});
    if (result.status !== 'Accepted') throw releaseError(`Apple application notarization ended with status ${result.status || 'unknown'} and ${issueCount} issue(s).`);
    if (issueCount !== 0) throw releaseError(`Apple reported ${issueCount} application notarization issue(s).`);
    await run('xcrun', ['stapler', 'staple', app]);
    await run('xcrun', ['stapler', 'validate', app]);
    return {submissionId:result.id, status:result.status, issueCount};
  } finally {
    await fs.rm(temporaryDirectory, {recursive:true, force:true});
  }
}

export async function signAndNotarizeMacosApp({root = process.cwd()} = {}) {
  if (process.env.MONEY_MOVES_RELEASE !== '1') throw releaseError('release signing requires MONEY_MOVES_RELEASE=1.');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw releaseError('release signing requires an Apple-silicon macOS host.');
  const releaseDirectory = path.resolve(root, 'out', 'macos-release');
  const app = path.join(releaseDirectory, 'Money Moves-darwin-arm64', 'Money Moves.app');
  await requireDirectory(app);
  const components = await signMacosApplication(app);
  const notarization = await notarizeMacosApplication(app, releaseDirectory);
  return {app, components, notarization};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await signAndNotarizeMacosApp();
    process.stdout.write(`Signed ${result.components.length} exact pinned components; application notarization ${result.notarization.status} with 0 issues (submission ${result.notarization.submissionId}); app ticket stapled and validated.\n`);
  } catch (error) {
    process.stderr.write(`macOS application signing/notarization failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
