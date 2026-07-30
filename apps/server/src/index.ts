/**
 * Public surface of `@zusehq/server`. The Electron shim consumes this; a
 * future headless server boot script (`bin.ts`) re-exports it too. Anything
 * not re-exported here is internal — keep the surface minimal.
 */
export { AppPaths } from "./app-paths.ts";
export { readBrowserCredentialFromVault } from "./provider/layers/credentials-service.ts";
export { type MainLayerDeps, makeMainLayer } from "./runtime.ts";
export { wsServerProtocolLayer } from "./transports/ws.ts";
export { FolderPicker } from "./workspace/services/folder-picker.ts";
