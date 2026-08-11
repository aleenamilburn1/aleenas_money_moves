import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCanonicalAppManifest,
  discoverSignedComponents,
  enumerateSignedComponents,
  entitlementPolicies,
  parseEntitlementsPlist,
  requireExactSignedComponentSet,
  requireMatchingCandidateManifests,
  validateSignedCodePolicies,
  validateEntitlementDictionary
} from '../scripts/verify-macos-release.mjs';
import {
  codesignArgumentsForComponent,
  signedComponentPolicy
} from '../scripts/macos-signing-policy.mjs';
import {notarizationIssueCount} from '../scripts/sign-notarize-macos-app.mjs';

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

async function syntheticPolicyApp(parent) {
  const app = path.join(parent, 'Money Moves.app');
  await fs.mkdir(app, {recursive:true});
  for (const component of signedComponentPolicy) {
    if (component.relativePath === '.') continue;
    const target = path.join(app, ...component.relativePath.split('/'));
    if (component.kind === 'application' || component.kind === 'framework') {
      await fs.mkdir(target, {recursive:true});
    } else {
      await fs.mkdir(path.dirname(target), {recursive:true});
      await fs.writeFile(target, `synthetic ${component.relativePath}`);
      await fs.chmod(target, 0o755);
    }
  }
  return app;
}

function exactEntitlementsFor(component) {
  return component.policy === entitlementPolicies.jit ? {[allowJit]:true} : null;
}

function validationInspectors(entitlementOverride, signatureOverride) {
  return {
    inspectSignature:async (target, label, component) => signatureOverride ? signatureOverride(target, label, component) : 'flags=runtime',
    inspectEntitlements:async (target, label, component) => entitlementOverride ? entitlementOverride(target, label, component) : exactEntitlementsFor(component)
  };
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
  assert.doesNotThrow(() => validateEntitlementDictionary({[allowJit]:true}, entitlementPolicies.jit));
  assert.throws(
    () => validateEntitlementDictionary({[allowJit]:true, 'com.example.unapproved':true}, entitlementPolicies.jit),
    /exact approved allowlist/
  );
  assert.throws(
    () => validateEntitlementDictionary({[allowJit]:true, 'com.apple.security.cs.disable-library-validation':true}, entitlementPolicies.jit),
    /exact approved allowlist/
  );
  assert.throws(() => validateEntitlementDictionary({}, entitlementPolicies.jit), /exact approved allowlist/);
  assert.throws(() => validateEntitlementDictionary(null, entitlementPolicies.jit), /missing the required JIT entitlement/);
  assert.throws(() => validateEntitlementDictionary({[allowJit]:false}, entitlementPolicies.jit), /allow-jit=true/);
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

test('notarization logs accept null or array issue lists and reject ambiguous shapes', () => {
  assert.equal(notarizationIssueCount({issues:null}, 'application'), 0);
  assert.equal(notarizationIssueCount({issues:[]}, 'application'), 0);
  assert.equal(notarizationIssueCount({issues:[{severity:'error'}]}, 'application'), 1);
  assert.throws(() => notarizationIssueCount({}, 'application'), /no inspectable issue list/);
  assert.throws(() => notarizationIssueCount({issues:'none'}, 'DMG'), /no inspectable issue list/);
  assert.throws(() => notarizationIssueCount(null, 'DMG'), /not an inspectable object/);
});

test('pinned policy has 24 exact paths, 10 JIT paths, and 14 no-entitlement paths', () => {
  assert.equal(signedComponentPolicy.length, 24);
  assert.equal(signedComponentPolicy.filter(component => component.policy === entitlementPolicies.jit).length, 10);
  assert.equal(signedComponentPolicy.filter(component => component.policy === entitlementPolicies.none).length, 14);
  assert.equal(new Set(signedComponentPolicy.map(component => component.relativePath)).size, signedComponentPolicy.length);
});

test('signing arguments grant JIT only to exact pinned Electron paths and have no fallback', () => {
  const jit = codesignArgumentsForComponent('Contents/MacOS/Money Moves', {entitlements:'build/entitlements/macos-electron.plist'});
  const crashpad = codesignArgumentsForComponent('Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler', {entitlements:'build/entitlements/macos-electron.plist'});
  const shipIt = codesignArgumentsForComponent('Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt', {entitlements:'build/entitlements/macos-electron.plist'});
  assert.ok(jit.includes('--entitlements'));
  assert.ok(jit.includes('runtime'));
  assert.equal(crashpad.includes('--entitlements'), false);
  assert.equal(shipIt.includes('--entitlements'), false);
  assert.throws(
    () => codesignArgumentsForComponent('Contents/Resources/synthetic_tool', {entitlements:'build/entitlements/macos-electron.plist'}),
    /unknown signed component path/
  );
});

test('complete exact expected component set resolves only pinned policies', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  const components = await discoverSignedComponents(app);
  assert.deepEqual(components.map(component => component.relativePath), signedComponentPolicy.map(component => component.relativePath));
  await assert.doesNotReject(() => validateSignedCodePolicies(app, 'synthetic app', validationInspectors()));
});

test('unknown executable is rejected instead of defaulting to JIT', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  const unknown = path.join(app, 'Contents', 'Resources', 'synthetic_tool');
  await fs.mkdir(path.dirname(unknown), {recursive:true});
  await fs.writeFile(unknown, 'unknown executable');
  await fs.chmod(unknown, 0o755);
  await assert.rejects(() => discoverSignedComponents(app), /unknown=.*synthetic_tool/);
});

test('unknown non-executable 64-bit universal Mach-O is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  const unknown = path.join(app, 'Contents', 'Resources', 'synthetic-fat64');
  await fs.mkdir(path.dirname(unknown), {recursive:true});
  await fs.writeFile(unknown, Buffer.from([0xca, 0xfe, 0xba, 0xbf, 0, 0, 0, 0]));
  await fs.chmod(unknown, 0o644);
  await assert.rejects(() => discoverSignedComponents(app), /unknown=.*synthetic-fat64/);
});

test('unknown signed nested component is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  const service = path.join(app, 'Contents', 'Frameworks', 'Unknown.xpc');
  const executable = path.join(service, 'Contents', 'MacOS', 'Unknown');
  await fs.mkdir(path.dirname(executable), {recursive:true});
  await fs.writeFile(executable, 'unknown nested executable');
  await fs.chmod(executable, 0o755);
  await assert.rejects(() => discoverSignedComponents(app), /unknown=.*Unknown\.xpc/);
});

test('missing expected nested executable is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await fs.rm(path.join(app, 'Contents', 'Frameworks', 'Squirrel.framework', 'Versions', 'A', 'Resources', 'ShipIt'));
  await assert.rejects(() => discoverSignedComponents(app), /missing=.*ShipIt/);
});

test('missing expected helper is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await fs.rm(path.join(app, 'Contents', 'Frameworks', 'Money Moves Helper (Renderer).app'), {recursive:true});
  await assert.rejects(() => discoverSignedComponents(app), /missing=.*Money Moves Helper \(Renderer\)\.app/);
});

test('duplicate or ambiguous expected path is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  const components = await enumerateSignedComponents(app);
  assert.throws(() => requireExactSignedComponentSet([...components, components[0]]), /duplicate or ambiguous.*\./);
});

test('expected path with a changed signed-component kind is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  const components = await enumerateSignedComponents(app);
  const changed = components.map(component => component.relativePath === 'Contents/Frameworks/Mantle.framework'
    ? {...component, discoveredKind:'executable'}
    : component);
  assert.throws(() => requireExactSignedComponentSet(changed), /component kinds.*Mantle\.framework expected=framework actual=executable/);
});

test('component moved to an unexpected path is rejected as unknown and missing', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  const shipIt = path.join(app, 'Contents', 'Frameworks', 'Squirrel.framework', 'Versions', 'A', 'Resources', 'ShipIt');
  await fs.rename(shipIt, `${shipIt}-moved`);
  await assert.rejects(() => discoverSignedComponents(app), /unknown=.*ShipIt-moved; missing=.*ShipIt/);
});

test('native executable with exact no-entitlement policy passes', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.doesNotReject(() => validateSignedCodePolicies(app, 'synthetic app', validationInspectors()));
});

test('native executable carrying JIT is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.rejects(
    () => validateSignedCodePolicies(app, 'synthetic app', validationInspectors((target, label, component) => component.relativePath.endsWith('chrome_crashpad_handler') ? {[allowJit]:true} : exactEntitlementsFor(component))),
    /chrome_crashpad_handler must not contain an entitlement dictionary/
  );
});

test('native executable carrying an arbitrary entitlement is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.rejects(
    () => validateSignedCodePolicies(app, 'synthetic app', validationInspectors((target, label, component) => component.relativePath.endsWith('/ShipIt') ? {'com.example.unapproved':true} : exactEntitlementsFor(component))),
    /ShipIt must not contain an entitlement dictionary/
  );
});

test('Electron process missing JIT is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.rejects(
    () => validateSignedCodePolicies(app, 'synthetic app', validationInspectors((target, label, component) => component.relativePath === 'Contents/MacOS/Money Moves' ? null : exactEntitlementsFor(component))),
    /Money Moves is missing the required JIT entitlement/
  );
});

test('Electron process with allow-jit=false is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.rejects(
    () => validateSignedCodePolicies(app, 'synthetic app', validationInspectors((target, label, component) => component.relativePath === 'Contents/MacOS/Money Moves' ? {[allowJit]:false} : exactEntitlementsFor(component))),
    /allow-jit=true/
  );
});

test('Electron process with an extra entitlement is rejected', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.rejects(
    () => validateSignedCodePolicies(app, 'synthetic app', validationInspectors((target, label, component) => component.relativePath === 'Contents/MacOS/Money Moves' ? {[allowJit]:true, 'com.example.extra':true} : exactEntitlementsFor(component))),
    /exact approved allowlist/
  );
});

test('malformed component entitlement inspection fails closed with the component path', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.rejects(
    () => validateSignedCodePolicies(app, 'synthetic app', validationInspectors((target, label, component) => {
      if (component.relativePath === 'Contents/MacOS/Money Moves') throw new Error(`malformed entitlement output for ${label}.`);
      return exactEntitlementsFor(component);
    })),
    /malformed entitlement output.*Contents\/MacOS\/Money Moves/
  );
});

test('unreadable required component inspection fails closed with the component path', async t => {
  const root = await fixtureRoot(t);
  const app = await syntheticPolicyApp(root);
  await assert.rejects(
    () => validateSignedCodePolicies(app, 'synthetic app', validationInspectors(undefined, (target, label, component) => {
      if (component.relativePath.endsWith('/ShipIt')) throw new Error('unreadable');
      return 'flags=runtime';
    })),
    /unable to inspect required signed component: synthetic app .*ShipIt/
  );
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
