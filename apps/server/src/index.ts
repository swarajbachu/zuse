/**
 * Public surface of `@zuse/server`. The Electron shim consumes this; a
 * future headless server boot script (`bin.ts`) re-exports it too. Anything
 * not re-exported here is internal — keep the surface minimal.
 */
export { AppPaths } from "./app-paths.ts";
export { makeMainLayer, type MainLayerDeps } from "./runtime.ts";
export { FolderPicker } from "./workspace/services/folder-picker.ts";
