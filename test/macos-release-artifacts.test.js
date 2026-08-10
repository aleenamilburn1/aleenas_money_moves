import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {discoverReleaseArtifacts, expectedVersion} from '../scripts/verify-macos-release.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-release-artifacts-'));
  const output = path.join(root, 'out', 'macos-release');
  const app = path.join(output, 'Money Moves-darwin-arm64', 'Money Moves.app');
  await fs.mkdir(app, {recursive:true});
  return {root, output, app};
}

async function artifactFiles(output) {
  const make = path.join(output, 'make');
  await fs.mkdir(path.join(make, 'zip', 'darwin', 'arm64'), {recursive:true});
  await fs.writeFile(path.join(make, `Money Moves-${expectedVersion}-arm64.dmg`), 'synthetic');
  await fs.writeFile(path.join(make, 'zip', 'darwin', 'arm64', `Money Moves-darwin-arm64-${expectedVersion}.zip`), 'synthetic');
}

test('release artifact discovery accepts Forge\'s nested ARM64 ZIP layout and remains inside release output', async t => {
  const {root, output, app} = await fixture();
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  await artifactFiles(output);
  const artifacts = await discoverReleaseArtifacts({root, output});
  assert.equal(artifacts.app, app);
  assert.equal(path.relative(output, artifacts.dmg), `make/Money Moves-${expectedVersion}-arm64.dmg`);
  assert.equal(path.relative(output, artifacts.zip), `make/zip/darwin/arm64/Money Moves-darwin-arm64-${expectedVersion}.zip`);
});

test('release artifact discovery rejects missing and ambiguous deterministic artifacts', async t => {
  const {root, output} = await fixture();
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  await fs.mkdir(path.join(output, 'make'), {recursive:true});
  await assert.rejects(() => discoverReleaseArtifacts({root, output}), /missing expected ARM64 DMG/);
  await artifactFiles(output);
  await fs.mkdir(path.join(output, 'make', 'duplicate'), {recursive:true});
  await fs.writeFile(path.join(output, 'make', 'duplicate', `Money Moves-darwin-arm64-${expectedVersion}.zip`), 'synthetic');
  await assert.rejects(() => discoverReleaseArtifacts({root, output}), /ambiguous ZIP artifacts/);
});

test('package inspection accepts pnpm’s argument separator before an explicit output path', async t => {
  const emptyOutput = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-package-inspection-'));
  t.after(() => fs.rm(emptyOutput, {recursive:true, force:true}));
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const result = spawnSync(process.execPath, ['scripts/inspect-package.mjs', '--', emptyOutput], {cwd:repositoryRoot, encoding:'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing packaged app\.asar/);
  assert.doesNotMatch(result.stderr, /scandir .*\/--/);
});
