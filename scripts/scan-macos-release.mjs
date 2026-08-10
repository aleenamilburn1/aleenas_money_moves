import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const releaseRoot = path.resolve(root, 'out', 'macos-release');
const prohibitedNames = new Set(['.env', '.env.local', '.env.production', '.env.development']);
const sensitivePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /(?:plaid|access)[_-]?(?:token|secret)\s*[:=]\s*['"][^'"]+/i,
  /(?:apple[_ -]?id|app[_ -]?specific[_ -]?password|notary(?:tool)?[_ -]?(?:password|token))\s*[:=]\s*['"][^'"]+/i,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/
];

async function filesIn(directory, files = []) {
  const entries = await fs.readdir(directory, {withFileTypes:true});
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    // Electron frameworks include directory symlinks (for example
    // Versions/Current). Do not follow them outside the release tree or try to
    // read a linked directory as a file; the canonical target is scanned.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await filesIn(target, files);
    else files.push(target);
  }
  return files;
}

try {
  const rootEntries = await fs.readdir(root, {withFileTypes:true});
  const unexpectedEnv = rootEntries.filter(entry => prohibitedNames.has(entry.name)).map(entry => entry.name);
  const releaseFiles = await filesIn(releaseRoot);
  const findings = [...unexpectedEnv];
  for (const file of releaseFiles) {
    const stat = await fs.stat(file);
    if (stat.size > 32 * 1024 * 1024) continue;
    const content = await fs.readFile(file);
    if (sensitivePatterns.some(pattern => pattern.test(content.toString('utf8')))) findings.push(path.relative(root, file));
  }
  if (findings.length) throw new Error('sensitive material found');
  process.stdout.write('Release security scan passed: no credentials, private keys, Plaid tokens, user financial data indicators, or unexpected .env files found.\n');
} catch (error) {
  process.stderr.write(`Release security scan failed: ${error.message}\n`);
  process.exitCode = 1;
}
