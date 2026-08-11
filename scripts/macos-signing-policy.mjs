import path from 'node:path';

export const entitlementPolicies = Object.freeze({jit:'jit', none:'none'});

const policyEntries = [
  {relativePath:'.', kind:'application', policy:entitlementPolicies.jit, category:'Electron main application'},
  {relativePath:'Contents/Frameworks/Electron Framework.framework', kind:'framework', policy:entitlementPolicies.none, category:'native framework bundle'},
  {relativePath:'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', kind:'executable', policy:entitlementPolicies.none, category:'Electron/V8 framework library'},
  {relativePath:'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler', kind:'executable', policy:entitlementPolicies.none, category:'native Crashpad support tool'},
  {relativePath:'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib', kind:'executable', policy:entitlementPolicies.none, category:'native dynamic library'},
  {relativePath:'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib', kind:'executable', policy:entitlementPolicies.none, category:'native dynamic library'},
  {relativePath:'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib', kind:'executable', policy:entitlementPolicies.none, category:'native dynamic library'},
  {relativePath:'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib', kind:'executable', policy:entitlementPolicies.none, category:'native dynamic library'},
  {relativePath:'Contents/Frameworks/Mantle.framework', kind:'framework', policy:entitlementPolicies.none, category:'native framework bundle'},
  {relativePath:'Contents/Frameworks/Mantle.framework/Versions/A/Mantle', kind:'executable', policy:entitlementPolicies.none, category:'native framework library'},
  {relativePath:'Contents/Frameworks/Money Moves Helper (GPU).app', kind:'application', policy:entitlementPolicies.jit, category:'Electron GPU helper application'},
  {relativePath:'Contents/Frameworks/Money Moves Helper (GPU).app/Contents/MacOS/Money Moves Helper (GPU)', kind:'executable', policy:entitlementPolicies.jit, category:'Electron GPU helper process'},
  {relativePath:'Contents/Frameworks/Money Moves Helper (Plugin).app', kind:'application', policy:entitlementPolicies.jit, category:'Electron plugin helper application'},
  {relativePath:'Contents/Frameworks/Money Moves Helper (Plugin).app/Contents/MacOS/Money Moves Helper (Plugin)', kind:'executable', policy:entitlementPolicies.jit, category:'Electron plugin helper process'},
  {relativePath:'Contents/Frameworks/Money Moves Helper (Renderer).app', kind:'application', policy:entitlementPolicies.jit, category:'Electron renderer helper application'},
  {relativePath:'Contents/Frameworks/Money Moves Helper (Renderer).app/Contents/MacOS/Money Moves Helper (Renderer)', kind:'executable', policy:entitlementPolicies.jit, category:'Electron renderer helper process'},
  {relativePath:'Contents/Frameworks/Money Moves Helper.app', kind:'application', policy:entitlementPolicies.jit, category:'Electron utility helper application'},
  {relativePath:'Contents/Frameworks/Money Moves Helper.app/Contents/MacOS/Money Moves Helper', kind:'executable', policy:entitlementPolicies.jit, category:'Electron utility helper process'},
  {relativePath:'Contents/Frameworks/ReactiveObjC.framework', kind:'framework', policy:entitlementPolicies.none, category:'native framework bundle'},
  {relativePath:'Contents/Frameworks/ReactiveObjC.framework/Versions/A/ReactiveObjC', kind:'executable', policy:entitlementPolicies.none, category:'native framework library'},
  {relativePath:'Contents/Frameworks/Squirrel.framework', kind:'framework', policy:entitlementPolicies.none, category:'native framework bundle'},
  {relativePath:'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt', kind:'executable', policy:entitlementPolicies.none, category:'native Squirrel support tool'},
  {relativePath:'Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel', kind:'executable', policy:entitlementPolicies.none, category:'native framework library'},
  {relativePath:'Contents/MacOS/Money Moves', kind:'executable', policy:entitlementPolicies.jit, category:'Electron main process'}
].map(entry => Object.freeze(entry));

export const signedComponentPolicy = Object.freeze(policyEntries);
const policyByPath = new Map(signedComponentPolicy.map(entry => [entry.relativePath, entry]));

export function requireSignedComponentPolicy(relativePath) {
  const entry = policyByPath.get(relativePath);
  if (!entry) throw new Error(`unknown signed component path: ${relativePath}`);
  return entry;
}

export function codesignArgumentsForComponent(relativePath, {identity = 'Developer ID Application', entitlements} = {}) {
  const entry = requireSignedComponentPolicy(relativePath);
  const args = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime'];
  if (entry.policy === entitlementPolicies.jit) {
    if (!entitlements) throw new Error(`missing JIT entitlement file for ${relativePath}`);
    args.push('--entitlements', path.resolve(entitlements));
  }
  return args;
}
