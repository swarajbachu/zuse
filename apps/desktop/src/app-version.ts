import desktopPackage from "../package.json" with { type: "json" };

/**
 * Electron reports its own version in unpackaged development builds. Keep the
 * product version anchored to the desktop package for both dev and release
 * runtime metadata.
 */
export const ZUSE_APP_VERSION = desktopPackage.version;
