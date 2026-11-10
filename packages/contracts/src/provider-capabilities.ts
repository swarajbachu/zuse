import {
	type BuiltinProviderId,
	isAcpProviderId,
	type ProviderId,
} from "./agent.ts";

/** Static provider traits; runtime integration stays in the owning application. */
export const PROVIDER_CAPABILITIES = {
	claude: {
		planMode: true,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: false,
		skillFolders: [".claude"],
	},
	codex: {
		planMode: true,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: true,
		skillFolders: [".codex"],
	},
	cursor: {
		planMode: true,
		appTools: true,
		cliBacked: false,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: true,
		skillFolders: [],
	},
	gemini: {
		planMode: true,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: false,
		skillFolders: [],
	},
	grok: {
		planMode: true,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: false,
		skillFolders: [],
	},
	opencode: {
		planMode: true,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: true,
		skillFolders: [],
	},
	opencode2: {
		planMode: true,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: true,
		skillFolders: [],
	},
	kiro: {
		planMode: true,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: true,
		skillFolders: [],
	},
	muse: {
		planMode: false,
		appTools: true,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: true,
		skillFolders: [],
	},
	pi: {
		planMode: false,
		appTools: false,
		cliBacked: true,
		enabledByDefault: true,
		credentialSource: "provider",
		nativeSubagentsByDefault: false,
		authoritativeModels: false,
		skillFolders: [],
	},
	zuse: {
		planMode: false,
		appTools: false,
		cliBacked: false,
		enabledByDefault: false,
		credentialSource: "connections",
		nativeSubagentsByDefault: true,
		authoritativeModels: true,
		skillFolders: [".zuse", ".agents", ".codex"],
	},
} as const satisfies Record<
	ProviderId,
	{
		readonly planMode: boolean;
		readonly appTools: boolean;
		readonly cliBacked: boolean;
		readonly enabledByDefault: boolean;
		readonly credentialSource: "provider" | "connections";
		readonly nativeSubagentsByDefault: boolean;
		readonly authoritativeModels: boolean;
		readonly skillFolders: readonly string[];
	}
>;
export type CliProviderId = {
	[P in BuiltinProviderId]: (typeof PROVIDER_CAPABILITIES)[P]["cliBacked"] extends true
		? P
		: never;
}[BuiltinProviderId];

export const providerCapabilities = (id: ProviderId) =>
	isAcpProviderId(id)
		? {
				planMode: false,
				appTools: true,
				cliBacked: true,
				enabledByDefault: true,
				credentialSource: "provider" as const,
				nativeSubagentsByDefault: false,
				authoritativeModels: true,
				skillFolders: [] as readonly string[],
			}
		: PROVIDER_CAPABILITIES[id];
