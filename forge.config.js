import {FusesPlugin} from '@electron-forge/plugin-fuses';
import {FuseV1Options, FuseVersion} from '@electron/fuses';

const isMacRelease = process.env.MONEY_MOVES_RELEASE === '1';

export default {
  // Release output is deliberately isolated from ordinary developer packages.
  outDir:isMacRelease ? 'out/macos-release' : 'out',
  packagerConfig:{
    asar:true,
    appBundleId:'com.moneymoves.desktop',
    name:'Money Moves',
    executable:'Money Moves',
    icon:'assets/icons/macos/icon.icns',
    ignore:[
      /^\/test($|\/)/,
      /^\/docs($|\/)/,
      /^\/node_modules($|\/)/,
      /^\/scripts($|\/)/,
      /^\/supabase($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.agents($|\/)/,
      /^\/\.codex($|\/)/,
      /^\/\.claude($|\/)/,
      /^\/\.pnpm-store($|\/)/,
      /^\/__pycache__($|\/)/,
      /^\/\.DS_Store$/,
      /^\/out($|\/)/,
      /^\/node_modules\/\.cache($|\/)/,
      /^\/sample-transactions\.csv$/,
      /^\/start\.(py|sh|command|bat)$/,
      /^\/forge\.config\.js$/,
      /^\/(AGENTS|CHANGELOG|README|SECURITY)\.md$/,
      /^\/VERSION$/,
      /^\/pnpm-(lock|workspace)\.yaml$/,
      /^\/js\/config(\.example)?\.js$/,
      /^\/js\/vault\.js$/,
      /^\/js\/services\/(authService|hostedVaultStorage|sessionSafety|supabaseClient|vaultRepository)\.js$/,
      /^\/js\/vendor\/supabase-js($|\/)/,
      /\.map$/
    ],
    // Release signing runs after Forge packages the app. The installed
    // @electron/osx-sign always passes an entitlement plist, including for
    // native components that must have no entitlement dictionary, so the
    // release workflow uses the checked-in exact-path codesign policy instead.
    // Ordinary development packaging remains unsigned and credential-free.
  },
  makers:[
    {name:'@electron-forge/maker-dmg', config:{format:'ULFO', icon:'assets/icons/macos/icon.icns', iconSize:128}},
    {name:'@electron-forge/maker-zip', platforms:['darwin']}
  ],
  plugins:[
    new FusesPlugin({
      version:FuseVersion.V1,
      [FuseV1Options.RunAsNode]:false,
      [FuseV1Options.EnableCookieEncryption]:true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
      [FuseV1Options.EnableNodeCliInspectArguments]:false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,
      [FuseV1Options.OnlyLoadAppFromAsar]:true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]:false
    })
  ]
};
