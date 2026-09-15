import type { ExtensionCapability } from "@zuse/contracts";
import type { ExtensionProviderDescriptor } from "@zuse/extension-sdk";

export type HostToExtensionMessage =
	| {
			readonly type: "initialize";
			readonly extensionId: string;
			readonly bundle: string;
			readonly storagePath: string;
			readonly capabilities: ReadonlyArray<ExtensionCapability>;
	  }
	| {
			readonly type: "invoke";
			readonly requestId: string;
			readonly method: string;
			readonly input: unknown;
			readonly workspace?: import("@zuse/extension-sdk").ExtensionWorkspaceContext;
	  }
	| {
			readonly type: "secret-result";
			readonly requestId: string;
			readonly value?: string | null;
			readonly error?: string;
	  }
	| { readonly type: "cancel"; readonly requestId: string }
	| { readonly type: "stop" };

export type ExtensionToHostMessage =
	| {
			readonly type: "managed-process";
			readonly pid: number;
			readonly running: boolean;
	  }
	| {
			readonly type: "ready";
			readonly methods: ReadonlyArray<string>;
			readonly providers: ReadonlyArray<ExtensionProviderDescriptor>;
	  }
	| {
			readonly type: "result";
			readonly requestId: string;
			readonly output?: unknown;
			readonly error?: string;
	  }
	| {
			readonly type: "secret";
			readonly requestId: string;
			readonly operation: "get" | "set" | "delete";
			readonly key: string;
			readonly value?: string;
	  }
	| {
			readonly type: "provider-event";
			readonly sessionId: string;
			readonly event: unknown;
	  }
	| { readonly type: "fatal"; readonly error: string };
