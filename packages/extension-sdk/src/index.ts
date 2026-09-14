export * from "./contracts.ts";
export { defineRpc } from "./rpc.ts";

declare global {
	var __ZUSE_EXTENSION_TARGET__: "client" | "server";
}

export const extensionTarget = globalThis.__ZUSE_EXTENSION_TARGET__;

export { extensionInstallState } from "./install-state.ts";
export * from "./workspace-tool.ts";
