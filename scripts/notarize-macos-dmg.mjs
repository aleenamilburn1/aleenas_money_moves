import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {discoverReleaseArtifacts} from './verify-macos-release.mjs';
import {notarizationIssueCount} from './sign-notarize-macos-app.mjs';

const run = promisify(execFile);

try {
  if (process.env.MONEY_MOVES_RELEASE !== '1') throw new Error('DMG notarization requires MONEY_MOVES_RELEASE=1.');
  const {dmg} = await discoverReleaseArtifacts();
  const {stdout} = await run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', 'MoneyMovesNotary', '--wait', '--output-format', 'json'], {encoding:'utf8'});
  const result = JSON.parse(stdout);
  if (typeof result.id !== 'string' || !result.id) throw new Error('Apple returned no DMG notarization submission ID.');
  const {stdout:logText} = await run('xcrun', ['notarytool', 'log', result.id, '--keychain-profile', 'MoneyMovesNotary'], {encoding:'utf8'});
  const log = JSON.parse(logText);
  const issueCount = notarizationIssueCount(log, 'DMG');
  await fs.writeFile(path.join(path.resolve(process.cwd(), 'out', 'macos-release'), 'dmg-notarization.json'), `${JSON.stringify({submissionId:result.id, status:result.status, issueCount}, null, 2)}\n`, {mode:0o600});
  if (result.status !== 'Accepted') throw new Error(`Apple DMG notarization ended with status ${result.status || 'unknown'} and ${issueCount} issue(s).`);
  if (issueCount !== 0) throw new Error(`Apple reported ${issueCount} DMG notarization issue(s).`);
  await run('xcrun', ['stapler', 'staple', dmg]);
  await run('xcrun', ['stapler', 'validate', dmg]);
  process.stdout.write(`DMG notarization accepted with 0 issues (submission ${result.id}); ticket stapled and validated.\n`);
} catch (error) {
  process.stderr.write(`DMG notarization failed: ${error.message}\n`);
  process.exitCode = 1;
}
