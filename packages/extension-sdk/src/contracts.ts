import type { Schema } from "effect";
import type { ComponentType } from "react";

import type { ExtensionClientHost } from "./client-host.ts";

export const ZUSE_EXTENSION_API_VERSION = "1.1.0";

export type ExtensionCapability =
	| "attachments"
	| "commands"
	| "credentials"
	| "filesystem"
	| "network"
	| "process"
	| "providers"
	| "rpc"
	| "storage"
	| "themes"
	| "timeline"
	| "ui"
	| "planning"
	| "sessions";

export interface ExtensionRpcContract<Input, Output> {
	readonly name: string;
	readonly input: Schema.ConstraintDecoder<Input>;
	readonly output: Schema.ConstraintDecoder<Output>;
}

export interface ExtensionTheme {
	readonly colors: {
		readonly background: string;
		readonly foreground: string;
		readonly card: string;
		readonly cardForeground: string;
		readonly popover: string;
		readonly popoverForeground: string;
		readonly muted: string;
		readonly mutedForeground: string;
		readonly border: string;
		readonly input: string;
		readonly accent: string;
		readonly accentForeground: string;
		readonly destructive: string;
		readonly ring: string;
	};
}

export interface ExtensionHostProps {
	readonly extensionId: string;
	readonly theme: ExtensionTheme;
	readonly layout: { readonly compact: boolean; readonly platform: "desktop" };
}

export interface ExtensionSurfaceProps extends ExtensionHostProps {}

export interface ExtensionWorkspacePanelProps
	extends ExtensionHostProps,
		ExtensionPanelActions {
	readonly projectId: string;
	readonly workspacePath: string;
	readonly sessionId: string | null;
}

export interface ExtensionSurfaceContribution {
	readonly id: string;
	readonly Component: ComponentType<ExtensionSurfaceProps>;
}

export interface ExtensionSidebarContribution {
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	readonly surfaceId: string;
}

export interface ExtensionWorkspacePanelContribution {
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	readonly Component: ComponentType<ExtensionWorkspacePanelProps>;
}

export interface ExtensionCommandContext {
	readonly projectId: string | null;
	readonly sessionId: string | null;
	readonly invoke: <Input, Output>(
		contract: ExtensionRpcContract<Input, Output>,
		input: Input,
	) => Promise<Output>;
	readonly openSurface: (surfaceId: string) => void;
	readonly openWorkspacePanel: (panelId: string) => void;
}

export interface ExtensionCommandContribution {
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	readonly keywords?: ReadonlyArray<string>;
	readonly context: "global" | "project" | "session";
	readonly run: (context: ExtensionCommandContext) => void | Promise<void>;
}

export interface ExtensionThemeContribution {
	readonly id: string;
	readonly name: string;
	readonly appearance: "light" | "dark";
	readonly theme: ExtensionTheme;
}

export type ExtensionTimelineData =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<ExtensionTimelineData>
	| { readonly [key: string]: ExtensionTimelineData };

export interface ExtensionTimelineItem {
	readonly type: "extension";
	readonly kind: string;
	readonly version: number;
	readonly data: ExtensionTimelineData;
}

export interface ExtensionTimelineTransformerContribution {
	readonly id: string;
	readonly sourceType: string;
	readonly transform: (
		item: unknown,
	) => { readonly items: ReadonlyArray<ExtensionTimelineItem> } | undefined;
}

export interface ExtensionTimelineRendererProps<Data = unknown>
	extends ExtensionHostProps {
	readonly sessionId: string;
	readonly item: ExtensionTimelineItem & { readonly data: Data };
	readonly timestamp: Date;
}

export interface ExtensionTimelineRendererContribution<Data> {
	readonly kind: string;
	readonly version: number;
	readonly schema: Schema.ConstraintDecoder<Data>;
	readonly Component: ComponentType<ExtensionTimelineRendererProps<Data>>;
}

export interface ExtensionAttachmentSnapshot {
	readonly id: string;
	readonly title: string;
	readonly subtitle?: string;
	readonly text: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface ExtensionAttachmentSourceContribution {
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	readonly pickerTitle: string;
	readonly searchPlaceholder: string;
	readonly search: ExtensionRpcContract<
		{ readonly query: string },
		ReadonlyArray<ExtensionAttachmentSnapshot>
	>;
}

export interface ExtensionProviderModel {
	readonly id: string;
	readonly label: string;
	readonly defaultVisible?: boolean;
	readonly defaultModel?: boolean;
	readonly supportsPlanMode?: boolean;
	readonly supportsWebSearch?: "native" | "queryOnly";
	readonly options?: ReadonlyArray<{
		readonly id: string;
		readonly label: string;
		readonly kind: "boolean" | "select";
		readonly values?: ReadonlyArray<{
			readonly id: string;
			readonly label: string;
		}>;
	}>;
}

export interface ExtensionProviderDescriptor {
	readonly id: string;
	readonly displayName: string;
	readonly iconAsset?: string;
	readonly order?: number;
	readonly authentication:
		| { readonly kind: "none" }
		| {
				readonly kind: "api-key";
				readonly label: string;
				readonly placeholder?: string;
		  }
		| {
				readonly kind: "extension-managed";
				readonly settingsSurfaceId: string;
		  };
	readonly capabilities: ReadonlyArray<
		"answerQuestion" | "fork" | "goals" | "mcp" | "planApproval" | "resume"
	>;
	readonly models: ReadonlyArray<ExtensionProviderModel>;
}

export interface ExtensionClientContext {
	readonly host: ExtensionClientHost;
	readonly target: "client";
	/** Per-extension ephemeral query state, disposed on reload/disable. */
	readonly queryState: {
		get<T>(key: string): T | undefined;
		set<T>(key: string, value: T): void;
		invalidate(key?: string): void;
		subscribe(listener: () => void): () => void;
	};
	addSurface(id: string, Component: ComponentType<ExtensionSurfaceProps>): void;
	addSidebarItem(contribution: ExtensionSidebarContribution): void;
	addWorkspacePanel(contribution: ExtensionWorkspacePanelContribution): void;
	addCommand(contribution: ExtensionCommandContribution): void;
	addTheme(contribution: ExtensionThemeContribution): void;
	addTimelineTransformer(
		contribution: ExtensionTimelineTransformerContribution,
	): void;
	addTimelineRenderer<Data>(
		contribution: ExtensionTimelineRendererContribution<Data>,
	): void;
	addAttachmentSource(
		contribution: ExtensionAttachmentSourceContribution,
	): void;
}

export type ExtensionCleanup = () => void | Promise<void>;
export type ExtensionClientContribution = (
	extension: ExtensionClientContext,
) => ExtensionCleanup | Promise<ExtensionCleanup>;

export interface ExtensionProviderSessionInput {
	readonly sessionId: string;
	readonly projectId: string;
	readonly cwd: string;
	readonly model: string | null;
	readonly resumeCursor: string | null;
	readonly forkFromResume: boolean;
	readonly permissionMode: "default" | "plan" | "acceptEdits";
	readonly modelOptions: Readonly<Record<string, string>>;
}

export interface ExtensionProviderAdapter {
	probe(): Promise<{
		readonly available: boolean;
		readonly authenticated: boolean;
		readonly version?: string;
		readonly message?: string;
	}>;
	start(input: ExtensionProviderSessionInput): Promise<void>;
	send(sessionId: string, text: string): Promise<void>;
	interrupt(sessionId: string, turnId?: string): Promise<void>;
	close(sessionId: string): Promise<void>;
	answerQuestion?(
		sessionId: string,
		itemId: string,
		answers: unknown,
	): Promise<void>;
	respondToPlan?(
		sessionId: string,
		itemId: string,
		outcome: "approved" | "rejected",
		feedback?: string,
	): Promise<void>;
	getGoal?(sessionId: string): Promise<unknown | null>;
	setGoal?(sessionId: string, goal: unknown): Promise<unknown>;
	clearGoal?(sessionId: string): Promise<void>;
	updateMcpServers?(
		sessionId: string,
		servers: ReadonlyArray<unknown>,
	): Promise<void>;
}

export interface ExtensionServerContext {
	readonly target: "server";
	handle<Input, Output>(
		contract: ExtensionRpcContract<Input, Output>,
		handler: (
			input: Input,
			context: ExtensionInvocationContext,
		) => Output | Promise<Output>,
	): void;
	addProvider(
		descriptor: ExtensionProviderDescriptor,
		adapter: ExtensionProviderAdapter,
	): void;
	storage: {
		get(key: string): Promise<unknown>;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<void>;
		version(): Promise<number>;
		migrate(
			targetVersion: number,
			migration: (fromVersion: number) => void | Promise<void>,
		): Promise<void>;
	};
	blobs: {
		get(key: string): Promise<Uint8Array | null>;
		set(key: string, value: Uint8Array): Promise<void>;
		delete(key: string): Promise<void>;
	};
	secrets: {
		get(key: string): Promise<string | null>;
		set(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
	};
	/** Read a host-managed credential declared by one of this extension's providers. */
	credentials: {
		get(providerId: string): Promise<string | null>;
	};
	emitProviderEvent(sessionId: string, event: unknown): void;
}

export type ExtensionServerContribution = (
	extension: ExtensionServerContext,
) => ExtensionCleanup | Promise<ExtensionCleanup>;

export type ExtensionContext = ExtensionClientContext | ExtensionServerContext;
export type ExtensionContribution = (
	extension: ExtensionContext,
) => ExtensionCleanup | Promise<ExtensionCleanup>;

export interface ExtensionWorkspaceContext {
	readonly projectId: string;
	readonly workspacePath: string;
	readonly sessionId: string | null;
	readonly worktreeId?: string | null;
}
export interface ExtensionInvocationContext {
	readonly workspace: ExtensionWorkspaceContext | null;
	readonly signal: AbortSignal;
	readonly files: {
		list(): Promise<{ paths: ReadonlyArray<string>; truncated: boolean }>;
		read(path: string): Promise<string>;
	};
}
export interface ExtensionPanelActions {
	invoke<Input, Output>(
		contract: ExtensionRpcContract<Input, Output>,
		input: Input,
		options?: { signal?: AbortSignal },
	): Promise<Output>;
	attach(snapshot: ExtensionAttachmentSnapshot): Promise<void>;
}
