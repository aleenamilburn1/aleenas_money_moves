import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const releaseDirectory = path.resolve(root, 'out', 'macos-release');
const expectedParent = path.resolve(root, 'out');

function fail(message) {
  process.stderr.write(`macOS release preflight failed: ${message}\n`);
  process.exitCode = 1;
}

if (process.env.MONEY_MOVES_RELEASE !== '1') {
  fail('set MONEY_MOVES_RELEASE=1; ordinary builds must not request release credentials.');
} else if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail('Apple-silicon release packaging must run on an arm64 macOS host.');
} else if (path.dirname(releaseDirectory) !== expectedParent || !releaseDirectory.startsWith(`${expectedParent}${path.sep}`)) {
  fail('refusing to clear an unexpected release output directory.');
} else {
  try {
    await run('xcrun', ['--find', 'notarytool']);
    // This validates the named Keychain profile without reading or printing any
    // credential fields. Forge independently fails closed if signing identity
    // discovery cannot find a Developer ID Application certificate.
    await run('xcrun', ['notarytool', 'history', '--keychain-profile', 'MoneyMovesNotary']);
    await fs.rm(releaseDirectory, {recursive:true, force:true});
    await fs.mkdir(releaseDirectory, {recursive:true});
    process.stdout.write(`Prepared fresh isolated release output: ${path.relative(root, releaseDirectory)}\n`);
  } catch {
    fail('notarytool or the MoneyMovesNotary Keychain profile is unavailable. No release build was started.');
  }
}
