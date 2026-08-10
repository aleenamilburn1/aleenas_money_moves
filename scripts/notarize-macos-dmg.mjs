import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {discoverReleaseArtifacts} from './verify-macos-release.mjs';

const run = promisify(execFile);

try {
  const {dmg} = await discoverReleaseArtifacts();
  const {stdout} = await run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', 'MoneyMovesNotary', '--wait', '--output-format', 'json'], {encoding:'utf8'});
  const result = JSON.parse(stdout);
  if (result.status !== 'Accepted' || typeof result.id !== 'string') throw new Error('Apple did not accept the DMG notarization submission.');
  const {stdout:logText} = await run('xcrun', ['notarytool', 'log', result.id, '--keychain-profile', 'MoneyMovesNotary'], {encoding:'utf8'});
  const log = JSON.parse(logText);
  if (Array.isArray(log.issues) && log.issues.length > 0) throw new Error('Apple reported DMG notarization issues.');
  await run('xcrun', ['stapler', 'staple', dmg]);
  process.stdout.write('DMG notarization accepted, issue-free, and stapled.\n');
} catch (error) {
  process.stderr.write(`DMG notarization failed: ${error.message}\n`);
  process.exitCode = 1;
}
