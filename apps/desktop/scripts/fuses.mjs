// The Electron fuses Landlens ships with: the opposite of what the study found in Freelens 2.0
// (study/freelens-app/electron-fuses.json). Applied to the packaged app in wave 7 (electron-builder afterPack).
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

export const LANDLENS_FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false, // ELECTRON_RUN_AS_NODE can't turn Landlens into a Node shell
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS can't inject code
  [FuseV1Options.EnableNodeCliInspectArguments]: false, // --inspect can't attach a debugger to main
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

/** Flip the fuses of an Electron executable or .app bundle. */
export async function hardenFuses(appPath) {
  await flipFuses(appPath, { ...LANDLENS_FUSES, resetAdHocDarwinSignature: process.platform === "darwin" });
}
