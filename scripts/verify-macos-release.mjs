import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
export const expectedVersion = '2.0.0-desktop.0';
export const entitlementPolicies = Object.freeze({jitOnly:'jit-only', none:'none'});
export const approvedJitEntitlements = Object.freeze({'com.apple.security.cs.allow-jit':true});

function releaseError(message) {
  return new Error(message);
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRelative(parent, target) {
  return path.relative(parent, target).split(path.sep).join('/');
}

async function required(target, root, expectedType) {
  let stat;
  try { stat = await fs.lstat(target); }
  catch { throw releaseError(`missing required release artifact: ${path.relative(root, target)}`); }
  if (stat.isSymbolicLink() || (expectedType === 'directory' && !stat.isDirectory()) || (expectedType === 'file' && !stat.isFile())) {
    throw releaseError(`invalid required release artifact: ${path.relative(root, target)}`);
  }
}

async function filesIn(directory, files = []) {
  const entries = await fs.readdir(directory, {withFileTypes:true});
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await filesIn(target, files);
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function namedDirectories(directory, name, matches = []) {
  const entries = await fs.readdir(directory, {withFileTypes:true});
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const target = path.join(directory, entry.name);
    if (entry.name === name) matches.push(target);
    await namedDirectories(target, name, matches);
  }
  return matches;
}

function oneArtifact(kind, matches, root) {
  if (matches.length === 0) throw releaseError(`missing expected ARM64 ${kind} under ${path.relative(root, path.join(root, 'make'))}`);
  if (matches.length > 1) throw releaseError(`ambiguous ${kind} artifacts: ${matches.map(file => path.relative(root, file)).join(', ')}`);
  return matches[0];
}

export async function discoverReleaseArtifacts({root = process.cwd(), output = path.resolve(root, 'out', 'macos-release'), version = expectedVersion} = {}) {
  const repositoryRoot = path.resolve(root);
  const releaseRoot = path.resolve(output);
  const mandatedReleaseRoot = path.join(repositoryRoot, 'out', 'macos-release');
  const expectedApp = path.join(releaseRoot, 'Money Moves-darwin-arm64', 'Money Moves.app');
  const expectedDmgName = `Money Moves-${version}-arm64.dmg`;
  const expectedZipName = `Money Moves-darwin-arm64-${version}.zip`;
  const makeRoot = path.join(releaseRoot, 'make');

  if (releaseRoot !== mandatedReleaseRoot || !isWithin(repositoryRoot, releaseRoot)) {
    throw releaseError('release output must be the repository out/macos-release directory.');
  }
  await Promise.all([
    required(releaseRoot, repositoryRoot, 'directory'),
    required(expectedApp, repositoryRoot, 'directory'),
    required(makeRoot, repositoryRoot, 'directory')
  ]);
  const buildApps = (await namedDirectories(releaseRoot, 'Money Moves.app')).filter(app => !isWithin(makeRoot, app));
  if (buildApps.length !== 1 || buildApps[0] !== expectedApp) {
    throw releaseError(`ambiguous build-output app artifacts under ${path.relative(repositoryRoot, releaseRoot)}.`);
  }
  const makeFiles = await filesIn(makeRoot);
  const dmg = oneArtifact('DMG', makeFiles.filter(file => path.basename(file) === expectedDmgName), repositoryRoot);
  const zip = oneArtifact('ZIP', makeFiles.filter(file => path.basename(file) === expectedZipName), repositoryRoot);
  await Promise.all([required(dmg, repositoryRoot, 'file'), required(zip, repositoryRoot, 'file')]);
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

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function canonicalManifestText(entries) {
  return `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`;
}

export async function createCanonicalAppManifest(app) {
  await required(app, app, 'directory');
  const entries = [];

  async function visit(directory) {
    const children = await fs.readdir(directory);
    children.sort(comparePaths);
    for (const name of children) {
      const target = path.join(directory, name);
      const relativePath = normalizedRelative(app, target);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        entries.push({path:relativePath, type:'symlink', target:await fs.readlink(target)});
      } else if (stat.isDirectory()) {
        entries.push({path:relativePath, type:'directory', mode:stat.mode & 0o777});
        await visit(target);
      } else if (stat.isFile()) {
        entries.push({path:relativePath, type:'file', mode:stat.mode & 0o777, size:stat.size, sha256:await sha256File(target)});
      } else {
        throw releaseError(`unsupported filesystem entry in application bundle: ${relativePath}`);
      }
    }
  }

  await visit(app);
  entries.sort((left, right) => comparePaths(left.path, right.path));
  const canonical = canonicalManifestText(entries);
  return {entries, canonical, sha256:createHash('sha256').update(canonical).digest('hex')};
}

function manifestDifferences(reference, candidate) {
  const referenceByPath = new Map(reference.entries.map(entry => [entry.path, JSON.stringify(entry)]));
  const candidateByPath = new Map(candidate.entries.map(entry => [entry.path, JSON.stringify(entry)]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [entryPath, entry] of candidateByPath) {
    if (!referenceByPath.has(entryPath)) added += 1;
    else if (referenceByPath.get(entryPath) !== entry) changed += 1;
  }
  for (const entryPath of referenceByPath.keys()) {
    if (!candidateByPath.has(entryPath)) removed += 1;
  }
  return {added, removed, changed};
}

export function requireMatchingCandidateManifests(manifests) {
  const labels = ['build-output', 'DMG', 'ZIP'];
  const reference = manifests[labels[0]];
  if (!reference) throw releaseError('missing build-output application manifest.');
  for (const label of labels.slice(1)) {
    const candidate = manifests[label];
    if (!candidate) throw releaseError(`missing ${label} application manifest.`);
    if (candidate.canonical !== reference.canonical) {
      const difference = manifestDifferences(reference, candidate);
      throw releaseError(`${label} application candidate manifest differs from build-output (added=${difference.added}, removed=${difference.removed}, changed=${difference.changed}).`);
    }
  }
  return reference.sha256;
}

export function parseEntitlementsPlist(plistText) {
  if (typeof plistText !== 'string' || !plistText.trim()) throw releaseError('malformed or empty entitlement plist output.');
  const parsed = spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {encoding:'utf8', input:plistText});
  if (parsed.error || parsed.status !== 0 || !parsed.stdout.trim()) {
    throw releaseError('malformed or unreadable entitlement plist output.');
  }
  let entitlements;
  try { entitlements = JSON.parse(parsed.stdout); }
  catch { throw releaseError('malformed or unreadable entitlement plist output.'); }
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) {
    throw releaseError('entitlement plist root must be a dictionary.');
  }
  return entitlements;
}

export function validateEntitlementDictionary(entitlements, policy, label = 'signed component') {
  if (policy === entitlementPolicies.none) {
    if (entitlements !== null) throw releaseError(`${label} must not contain an entitlement dictionary.`);
    return;
  }
  if (policy !== entitlementPolicies.jitOnly) throw releaseError(`unknown entitlement policy for ${label}.`);
  if (entitlements === null) throw releaseError(`${label} is missing the required JIT entitlement.`);
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) {
    throw releaseError(`${label} entitlement data is not a dictionary.`);
  }
  const actualKeys = Object.keys(entitlements).sort(comparePaths);
  const approvedKeys = Object.keys(approvedJitEntitlements);
  if (actualKeys.length !== approvedKeys.length || actualKeys.some((key, index) => key !== approvedKeys[index])) {
    throw releaseError(`${label} entitlement dictionary does not match the exact approved allowlist.`);
  }
  if (entitlements['com.apple.security.cs.allow-jit'] !== true) {
    throw releaseError(`${label} requires com.apple.security.cs.allow-jit=true.`);
  }
}

function isFrameworkMainExecutable(relativePath) {
  const parts = relativePath.split('/');
  if (parts.length < 4) return false;
  const versionIndex = parts.lastIndexOf('Versions');
  if (versionIndex < 1 || versionIndex !== parts.length - 3) return false;
  const framework = parts[versionIndex - 1];
  return framework.endsWith('.framework') && parts.at(-1) === framework.slice(0, -'.framework'.length);
}

function entitlementPolicyFor(relativePath, kind) {
  if (kind === 'application') return entitlementPolicies.jitOnly;
  if (kind === 'framework' || /\.(dylib|node|so)$/.test(relativePath) || isFrameworkMainExecutable(relativePath)) {
    return entitlementPolicies.none;
  }
  return entitlementPolicies.jitOnly;
}

export async function discoverSignedComponents(app) {
  const components = [{path:app, relativePath:'.', kind:'application', policy:entitlementPolicies.jitOnly}];

  async function visit(directory) {
    const entries = await fs.readdir(directory, {withFileTypes:true});
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const relativePath = normalizedRelative(app, target);
      if (entry.isDirectory()) {
        let kind = null;
        if (entry.name.endsWith('.app')) kind = 'application';
        else if (entry.name.endsWith('.framework')) kind = 'framework';
        else if (entry.name.endsWith('.xpc') || entry.name.endsWith('.appex')) kind = 'service';
        if (kind) components.push({path:target, relativePath, kind, policy:entitlementPolicyFor(relativePath, kind)});
        await visit(target);
      } else if (entry.isFile()) {
        const stat = await fs.lstat(target);
        if ((stat.mode & 0o111) !== 0 || /\.(dylib|node|so)$/.test(entry.name)) {
          components.push({path:target, relativePath, kind:'executable', policy:entitlementPolicyFor(relativePath, 'executable')});
        }
      }
    }
  }

  await visit(app);
  components.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  return components;
}

async function extractEntitlementDictionary(component, label) {
  const inspectionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-v2d-entitlements-'));
  const derFile = path.join(inspectionDirectory, 'entitlements.der');
  const plistFile = path.join(inspectionDirectory, 'entitlements.plist');
  try {
    try { await run('codesign', ['-d', '--entitlements', derFile, '--der', component]); }
    catch { throw releaseError(`unable to inspect entitlements for ${label}.`); }
    try { await fs.access(derFile); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw releaseError(`unable to read entitlement output for ${label}.`);
    }
    const derStat = await fs.stat(derFile);
    if (derStat.size === 0) throw releaseError(`malformed entitlement output for ${label}.`);
    try { await run('derq', ['query', '-i', derFile, '-o', plistFile, '--xml']); }
    catch { throw releaseError(`malformed or unreadable entitlement output for ${label}.`); }
    let plistText;
    try { plistText = await fs.readFile(plistFile, 'utf8'); }
    catch { throw releaseError(`unable to parse entitlement output for ${label}.`); }
    return parseEntitlementsPlist(plistText);
  } finally {
    await fs.rm(inspectionDirectory, {recursive:true, force:true});
  }
}

async function validateSignedCodePolicies(app, label) {
  const components = await discoverSignedComponents(app);
  for (const component of components) {
    const componentLabel = `${label} ${component.relativePath}`;
    let signature;
    try { signature = await commandOutput('codesign', ['-d', '--verbose=2', component.path]); }
    catch { throw releaseError(`unable to inspect required signed component: ${componentLabel}.`); }
    if (!signature.includes('runtime')) throw releaseError(`hardened runtime is absent from ${componentLabel}.`);
    const entitlements = await extractEntitlementDictionary(component.path, componentLabel);
    validateEntitlementDictionary(entitlements, component.policy, componentLabel);
  }
  return components;
}

async function validateApp(app, {root, label}) {
  const executable = path.join(app, 'Contents', 'MacOS', 'Money Moves');
  const info = path.join(app, 'Contents', 'Info.plist');
  await Promise.all([required(app, root, 'directory'), required(executable, root, 'file'), required(info, root, 'file')]);
  const [architectures, shortVersion, buildVersion] = await Promise.all([
    commandOutput('lipo', ['-archs', executable]),
    commandOutput('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', info]),
    commandOutput('plutil', ['-extract', 'CFBundleVersion', 'raw', info])
  ]);
  if (architectures.trim() !== 'arm64') throw releaseError(`${label} executable must be arm64, got ${architectures || 'no architecture'}.`);
  if (shortVersion.trim() !== expectedVersion || buildVersion.trim() !== expectedVersion) throw releaseError(`${label} version metadata does not match ${expectedVersion}.`);
  try { await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]); }
  catch { throw releaseError(`${label} failed strict code-signature validation.`); }
  return {executable, info};
}

async function findOneApp(directory, label) {
  const apps = await namedDirectories(directory, 'Money Moves.app');
  if (apps.length === 0) throw releaseError(`${label} does not contain Money Moves.app.`);
  if (apps.length > 1) throw releaseError(`${label} contains ambiguous Money Moves.app bundles.`);
  if (!isWithin(directory, apps[0])) throw releaseError(`${label} app is outside its inspection directory.`);
  return apps[0];
}

async function withPackagedApps(artifacts, action) {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-v2d-dmg-'));
  const extractionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'money-moves-v2d-zip-'));
  let mounted = false;
  try {
    await run('hdiutil', ['attach', artifacts.dmg, '-readonly', '-nobrowse', '-mountpoint', mountPoint]);
    mounted = true;
    await run('ditto', ['-x', '-k', artifacts.zip, extractionDirectory]);
    const [dmgApp, zipApp] = await Promise.all([
      findOneApp(mountPoint, 'DMG'),
      findOneApp(extractionDirectory, 'ZIP')
    ]);
    return await action({dmgApp, zipApp});
  } finally {
    if (mounted) await run('hdiutil', ['detach', mountPoint]);
    await Promise.all([
      fs.rm(mountPoint, {recursive:true, force:true}),
      fs.rm(extractionDirectory, {recursive:true, force:true})
    ]);
  }
}

export async function verifyMacosRelease({root = process.cwd()} = {}) {
  const artifacts = await discoverReleaseArtifacts({root});
  return withPackagedApps(artifacts, async ({dmgApp, zipApp}) => {
    const [buildManifest, dmgManifest, zipManifest, dmgSha256, zipSha256] = await Promise.all([
      createCanonicalAppManifest(artifacts.app),
      createCanonicalAppManifest(dmgApp),
      createCanonicalAppManifest(zipApp),
      sha256File(artifacts.dmg),
      sha256File(artifacts.zip)
    ]);
    const manifests = {'build-output':buildManifest, DMG:dmgManifest, ZIP:zipManifest};
    const appManifestSha256 = requireMatchingCandidateManifests(manifests);

    await Promise.all([
      validateApp(artifacts.app, {root, label:'build-output app'}),
      validateApp(dmgApp, {root, label:'DMG app'}),
      validateApp(zipApp, {root, label:'ZIP app'})
    ]);
    const signedComponents = await validateSignedCodePolicies(artifacts.app, 'build-output app');
    await run('xcrun', ['stapler', 'validate', artifacts.app]);
    await run('xcrun', ['stapler', 'validate', artifacts.dmg]);
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', artifacts.app]);
    return {
      ...artifacts,
      manifests,
      signedComponents,
      provenance:{appManifestSha256, dmgSha256, zipSha256}
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const artifacts = await verifyMacosRelease();
    process.stdout.write(`Verified signed and notarized ARM64 artifacts: ${[artifacts.app, artifacts.dmg, artifacts.zip].map(file => path.relative(process.cwd(), file)).join(', ')}\n`);
    process.stdout.write(`Exact entitlement policy verified for ${artifacts.signedComponents.length} signed code paths.\n`);
    process.stdout.write(`Application manifest SHA-256: ${artifacts.provenance.appManifestSha256}\n`);
    process.stdout.write(`DMG SHA-256: ${artifacts.provenance.dmgSha256}\n`);
    process.stdout.write(`ZIP SHA-256: ${artifacts.provenance.zipSha256}\n`);
  } catch (error) {
    process.stderr.write(`macOS release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
