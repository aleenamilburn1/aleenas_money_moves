import fs from 'node:fs/promises';
import path from 'node:path';
import {extractFile, listPackage} from '@electron/asar';

// pnpm forwards the argument separator for `pnpm run inspect:package -- out/...`.
// Ignore it so release inspection stays explicitly scoped to the supplied output.
const root = path.resolve(process.argv.slice(2).find(argument => argument !== '--') || 'out');
const forbiddenSegments = new Set(['test', 'docs', 'node_modules', 'scripts', 'supabase', '.git', '.agents', '.codex', '.claude', '.pnpm-store', '__pycache__']);
const forbiddenNames = new Set([
  'AGENTS.md', 'CHANGELOG.md', 'README.md', 'SECURITY.md', 'VERSION', 'forge.config.js',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'sample-transactions.csv', 'config.js', 'config.example.js', 'vault.js',
  'authService.js', 'hostedVaultStorage.js', 'sessionSafety.js', 'supabaseClient.js', 'vaultRepository.js'
]);

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunkTypes(png) {
  if (!png.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error('not a PNG');
  const types = [];
  let offset = pngSignature.length;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error('truncated PNG chunk');
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error('invalid PNG chunk length');
    types.push(png.subarray(offset + 4, offset + 8).toString('ascii'));
    offset = end;
  }
  return types;
}

function hasUnsafePngContent(png) {
  try {
    const types = pngChunkTypes(png);
    return !types.includes('IHDR')
      || !types.includes('IDAT')
      || !types.includes('IEND')
      || types.some(type => ['caBX', 'eXIf', 'iTXt', 'tEXt', 'zTXt'].includes(type));
  } catch {
    return true;
  }
}

async function walk(directory, files = []) {
  const entries = await fs.readdir(directory, {withFileTypes:true});
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, files);
    else files.push(target);
  }
  return files;
}

try {
  const files = await walk(root);
  const violations = files.filter(file => {
    const parts = path.relative(root, file).split(path.sep);
    return parts.some(part => forbiddenSegments.has(part)) || forbiddenNames.has(path.basename(file)) || file.endsWith('.map');
  });
  const archives = files.filter(file => path.basename(file) === 'app.asar');
  if (!archives.length) violations.push('missing packaged app.asar');
  const iconFiles = files.filter(file => path.basename(file) === 'electron.icns');
  if (!iconFiles.length) violations.push('missing packaged macOS application icon');
  for (const iconFile of iconFiles) {
    const icon = await fs.readFile(iconFile);
    for (const type of ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']) {
      if (!icon.includes(type)) violations.push(`incomplete macOS icon representation: ${path.relative(root, iconFile)}:${type}`);
    }
  }
  let archiveFileCount = 0;
  for (const archive of archives) {
    const entries = listPackage(archive, {isPack:true}).map(line => line.replace(/^pack\s+:\s+/, '').replace(/^\//, ''));
    archiveFileCount += entries.length;
    for (const entry of entries) {
      const parts = entry.split('/');
      if (parts.some(part => forbiddenSegments.has(part)) || forbiddenNames.has(path.basename(entry)) || entry.endsWith('.map')) {
        violations.push(`app.asar:${entry}`);
      }
    }
    for (const required of ['data.js', 'electron/main.js', 'electron/preload.cjs', 'js/app.js', 'js/content/faithMoneyDevotionals.js', 'js/services/devotionalService.js', 'js/services/desktopBackupRestore.js', 'js/startup-status.js', 'js/services/desktopStartup.js', 'assets/brand/money-moves-mark.png']) {
      if (!entries.includes(required)) violations.push(`missing packaged ${required}`);
    }
    if (entries.includes('electron/preload.js')) violations.push('packaged obsolete Electron preload.js');
    if (entries.includes('assets/brand/money-moves-mark.png')) {
      const iconSource = extractFile(archive, 'assets/brand/money-moves-mark.png');
      if (hasUnsafePngContent(iconSource)) violations.push('packaged founder PNG contains unsafe or personal metadata content');
    }
    if (!entries.includes('data.js')) violations.push('missing packaged data.js');
    else {
      const content = extractFile(archive, 'data.js').toString('utf8');
      if (!content.includes('MONEY_MOVES_SEED') || /"transactions"\s*:\s*\[\s*\{/.test(content)) violations.push('packaged data.js contains a populated transaction seed');
    }
  }
  if (violations.length) throw new Error(`Unsafe packaged content: ${violations.join(', ')}`);
  process.stdout.write(`Package content inspection passed (${files.length} files and ${archiveFileCount} archive entries scanned).\n`);
} catch (error) {
  process.stderr.write(`Package content inspection failed: ${error.message}\n`);
  process.exitCode = 1;
}
