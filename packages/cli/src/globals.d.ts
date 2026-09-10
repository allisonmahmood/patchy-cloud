/** The package version, baked in by the esbuild bundle; absent when run from source. */
declare const __PATCHY_VERSION__: string | undefined;

/** fs-native-extensions ships its platform prebuilds but no TypeScript declarations. */
declare module "fs-native-extensions" {
  export function tryLock(fd: number): boolean;
}
