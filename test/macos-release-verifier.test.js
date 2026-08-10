import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCanonicalAppManifest,
  discoverSignedComponents,
  entitlementPolicies,
  parseEntitlementsPlist,
  requireMatchingCandidateManifests,
  validateEntitlementDictionary
} from '../scripts/verify-macos-release.mjs';

const allowJit = 'com.apple.security.cs.allow-jit';

async function fixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-release-verifier-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  return root;
}

async function syntheticApp(parent) {
  const app = path.join(parent, 'Money Moves.app');
  await fs.mkdir(path.join(app, 'Contents', 'MacOS'), {recursive:true});
  await fs.mkdir(path.join(app, 'Contents', 'Resources', 'Empty'), {recursive:true});
  await fs.mkdir(path.join(app, 'Contents', '_CodeSignature'), {recursive:true});
  await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleVersion</key><string>2.0.0-desktop.0</string></dict></plist>');
  await fs.writeFile(path.join(app, 'Contents', 'MacOS', 'Money Moves'), 'same-synthetic-executable');
  await fs.chmod(path.join(app, 'Contents', 'MacOS', 'Money Moves'), 0o755);
  await fs.writeFile(path.join(app, 'Contents', 'Resources', 'payload.txt'), 'same-payload');
  await fs.writeFile(path.join(app, 'Contents', 'Resources', 'alternate.txt'), 'same-payload');
  await fs.writeFile(path.join(app, 'Contents', '_CodeSignature', 'CodeResources'), 'same-synthetic-signature-metadata');
  await fs.symlink('payload.txt', path.join(app, 'Contents', 'Resources', 'current.txt'));
  return app;
}

async function copiedApp(source, parent) {
  const target = path.join(parent, 'Money Moves.app');
  await fs.mkdir(parent, {recursive:true});
  await fs.cp(source, target, {recursive:true, verbatimSymlinks:true});
  return target;
}

async function candidateManifests(build, dmg, zip) {
  const [buildManifest, dmgManifest, zipManifest] = await Promise.all([
    createCanonicalAppManifest(build),
    createCanonicalAppManifest(dmg),
    createCanonicalAppManifest(zip)
  ]);
  return {'build-output':buildManifest, DMG:dmgManifest, ZIP:zipManifest};
}

test('exact entitlement allowlist accepts only allow-jit=true', () => {
  assert.doesNotThrow(() => validateEntitlementDictionary({[allowJit]:true}, entitlementPolicies.jitOnly));
  assert.throws(
    () => validateEntitlementDictionary({[allowJit]:true, 'com.example.unapproved':true}, entitlementPolicies.jitOnly),
    /exact approved allowlist/
  );
  assert.throws(
    () => validateEntitlementDictionary({[allowJit]:true, 'com.apple.security.cs.disable-library-validation':true}, entitlementPolicies.jitOnly),
    /exact approved allowlist/
  );
  assert.throws(() => validateEntitlementDictionary({}, entitlementPolicies.jitOnly), /exact approved allowlist/);
  assert.throws(() => validateEntitlementDictionary(null, entitlementPolicies.jitOnly), /missing the required JIT entitlement/);
  assert.throws(() => validateEntitlementDictionary({[allowJit]:false}, entitlementPolicies.jitOnly), /allow-jit=true/);
});

test('no-entitlement policy rejects every entitlement dictionary', () => {
  assert.doesNotThrow(() => validateEntitlementDictionary(null, entitlementPolicies.none));
  assert.throws(() => validateEntitlementDictionary({}, entitlementPolicies.none), /must not contain an entitlement dictionary/);
  assert.throws(() => validateEntitlementDictionary({[allowJit]:true}, entitlementPolicies.none), /must not contain an entitlement dictionary/);
});

test('entitlement plist output is structurally parsed and malformed output fails closed', () => {
  const valid = '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>';
  assert.deepEqual(parseEntitlementsPlist(valid), {[allowJit]:true});
  assert.throws(() => parseEntitlementsPlist('not a plist'), /malformed or unreadable entitlement plist output/);
  assert.throws(() => parseEntitlementsPlist('<plist><array/></plist>'), /root must be a dictionary/);
});

test('signed-code discovery assigns JIT to executable processes and no entitlements to libraries', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticApp(root);
  const framework = path.join(app, 'Contents', 'Frameworks', 'Synthetic.framework');
  const frameworkBinary = path.join(framework, 'Versions', 'A', 'Synthetic');
  const library = path.join(framework, 'Versions', 'A', 'Libraries', 'libSynthetic.dylib');
  const tool = path.join(framework, 'Versions', 'A', 'Helpers', 'synthetic_tool');
  await fs.mkdir(path.dirname(frameworkBinary), {recursive:true});
  await fs.mkdir(path.dirname(library), {recursive:true});
  await fs.mkdir(path.dirname(tool), {recursive:true});
  await fs.writeFile(frameworkBinary, 'framework');
  await fs.writeFile(library, 'library');
  await fs.writeFile(tool, 'tool');
  await Promise.all([fs.chmod(frameworkBinary, 0o755), fs.chmod(tool, 0o755)]);

  const components = await discoverSignedComponents(app);
  const policies = new Map(components.map(component => [component.relativePath, component.policy]));
  assert.equal(policies.get('.'), entitlementPolicies.jitOnly);
  assert.equal(policies.get('Contents/MacOS/Money Moves'), entitlementPolicies.jitOnly);
  assert.equal(policies.get('Contents/Frameworks/Synthetic.framework'), entitlementPolicies.none);
  assert.equal(policies.get('Contents/Frameworks/Synthetic.framework/Versions/A/Synthetic'), entitlementPolicies.none);
  assert.equal(policies.get('Contents/Frameworks/Synthetic.framework/Versions/A/Libraries/libSynthetic.dylib'), entitlementPolicies.none);
  assert.equal(policies.get('Contents/Frameworks/Synthetic.framework/Versions/A/Helpers/synthetic_tool'), entitlementPolicies.jitOnly);
});

test('canonical app manifests bind identical build-output, DMG, and ZIP copies', async t => {
  const root = await fixtureRoot(t);
  const build = await syntheticApp(path.join(root, 'build'));
  const dmg = await copiedApp(build, path.join(root, 'dmg'));
  const zip = await copiedApp(build, path.join(root, 'zip'));
  const manifests = await candidateManifests(build, dmg, zip);
  assert.equal(requireMatchingCandidateManifests(manifests), manifests['build-output'].sha256);
});

test('same version and signature metadata cannot hide a modified payload', async t => {
  const root = await fixtureRoot(t);
  const build = await syntheticApp(path.join(root, 'build'));
  const dmg = await copiedApp(build, path.join(root, 'dmg'));
  const zip = await copiedApp(build, path.join(root, 'zip'));
  await fs.writeFile(path.join(zip, 'Contents', 'Resources', 'payload.txt'), 'stale-different-payload');
  const manifests = await candidateManifests(build, dmg, zip);
  assert.throws(() => requireMatchingCandidateManifests(manifests), /ZIP application candidate manifest differs.*changed=1/);
});

test('canonical app manifests reject added and removed files', async t => {
  const root = await fixtureRoot(t);
  const build = await syntheticApp(path.join(root, 'build'));
  const added = await copiedApp(build, path.join(root, 'added'));
  const removed = await copiedApp(build, path.join(root, 'removed'));
  await fs.writeFile(path.join(added, 'Contents', 'Resources', 'added.txt'), 'added');
  await fs.rm(path.join(removed, 'Contents', 'Resources', 'alternate.txt'));
  const [baselineManifest, addedManifest, removedManifest] = await Promise.all([
    createCanonicalAppManifest(build),
    createCanonicalAppManifest(added),
    createCanonicalAppManifest(removed)
  ]);
  assert.throws(
    () => requireMatchingCandidateManifests({'build-output':baselineManifest, DMG:addedManifest, ZIP:baselineManifest}),
    /DMG application candidate manifest differs.*added=1/
  );
  assert.throws(
    () => requireMatchingCandidateManifests({'build-output':baselineManifest, DMG:baselineManifest, ZIP:removedManifest}),
    /ZIP application candidate manifest differs.*removed=1/
  );
});

test('canonical app manifests reject a changed symlink target without following it', async t => {
  const root = await fixtureRoot(t);
  const build = await syntheticApp(path.join(root, 'build'));
  const dmg = await copiedApp(build, path.join(root, 'dmg'));
  const zip = await copiedApp(build, path.join(root, 'zip'));
  const link = path.join(dmg, 'Contents', 'Resources', 'current.txt');
  await fs.rm(link);
  await fs.symlink('alternate.txt', link);
  const manifests = await candidateManifests(build, dmg, zip);
  assert.throws(() => requireMatchingCandidateManifests(manifests), /DMG application candidate manifest differs.*changed=1/);
});
