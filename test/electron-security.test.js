import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = file => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const readBuffer = file => fs.readFile(new URL(`../${file}`, import.meta.url));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunkTypes(png) {
  assert.deepEqual(png.subarray(0, pngSignature.length), pngSignature);
  const types = [];
  let offset = pngSignature.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= png.length, 'PNG chunk must not extend beyond the source file');
    types.push(png.subarray(offset + 4, offset + 8).toString('ascii'));
    offset = end;
  }
  return types;
}

test('Electron main, preload, Forge, and packaged HTML enforce the desktop security baseline', async () => {
  const [main, preload, forge, html, adapter, restoreCoordinator, startupStatus, startupService, iconSource, icon] = await Promise.all([
    read('electron/main.js'), read('electron/preload.cjs'), read('forge.config.js'), read('index.html'), read('js/services/desktopVaultRepository.js'),
    read('js/services/desktopBackupRestore.js'), read('js/startup-status.js'), read('js/services/desktopStartup.js'), readBuffer('assets/brand/money-moves-mark.png'), readBuffer('assets/icons/macos/icon.icns')
  ]);
  for (const setting of ['nodeIntegration:false', 'contextIsolation:true', 'sandbox:true', 'webSecurity:true', 'allowRunningInsecureContent:false', 'experimentalFeatures:false']) assert.match(main, new RegExp(setting));
  assert.match(main, /protocol\.handle\(APP_PROTOCOL/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{action:'deny'\}\)\)/);
  assert.match(main, /will-navigate/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /requireTrustedRenderer/);
  assert.match(main, /status:'selected'/);
  assert.match(main, /status:'cancelled'/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('moneyMovesDesktop'/);
  assert.doesNotMatch(preload, /invoke:\s*\(/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^\n]*ipcRenderer/);
  assert.match(forge, /RunAsNode\]:false/);
  assert.match(forge, /OnlyLoadAppFromAsar\]:true/);
  assert.match(forge, /EnableEmbeddedAsarIntegrityValidation\]:true/);
  assert.match(forge, /maker-dmg/);
  assert.match(forge, /icon:'assets\/icons\/macos\/icon\.icns'/);
  assert.match(forge, /MONEY_MOVES_RELEASE/);
  assert.match(forge, /identity:'Developer ID Application'/);
  assert.match(forge, /continueOnError:false/);
  assert.match(forge, /hardenedRuntime:true/);
  assert.match(forge, /keychainProfile:'MoneyMovesNotary'/);
  assert.match(forge, /macos-electron\.plist/);
  assert.match(forge, /outDir:isMacRelease \? 'out\/macos-release' : 'out'/);
  assert.match(main, /preload\.cjs/);
  assert.doesNotMatch(main, /preload\.js['"`]/);
  assert.doesNotMatch(html, /unsafe-inline|https:\/\/\*\.supabase\.co/);
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /frame-ancestors/);
  assert.match(html, /js\/startup-status\.js/);
  assert.match(html, /assets\/brand\/money-moves-mark\.png/);
  assert.match(html, /STARTUP NEEDS ATTENTION/);
  assert.match(startupStatus, /setTimeout/);
  assert.match(startupService, /DESKTOP_BRIDGE_UNAVAILABLE/);
  assert.match(startupService, /STARTUP_TIMEOUT/);
  const iconChunks = pngChunkTypes(iconSource);
  assert.ok(iconChunks.includes('IHDR'));
  assert.ok(iconChunks.includes('IDAT'));
  assert.ok(iconChunks.includes('IEND'));
  for (const metadataType of ['caBX', 'eXIf', 'iTXt', 'tEXt', 'zTXt']) assert.ok(!iconChunks.includes(metadataType), `unexpected icon metadata: ${metadataType}`);
  for (const type of ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']) assert.ok(icon.includes(type), `missing ${type} icon representation`);
  assert.doesNotMatch(adapter, /hostedVaultStorage|supabase/i);
  assert.match(adapter, /serializeSelectedBackup/);
  assert.match(restoreCoordinator, /IMPORT_FAILED/);
  assert.doesNotMatch(restoreCoordinator, /console\./);
});
