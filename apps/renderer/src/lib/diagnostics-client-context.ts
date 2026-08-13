import { EnvironmentId } from "@zuse/contracts";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { type OpenFile, rightPaneKey, useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import {
	type DiagnosticLogEntry,
	type DiagnosticUiAction,
	getDiagnosticUiActions,
	getRendererDiagnosticLogs,
} from "./diagnostics-recorder.ts";

export interface DiagnosticsClientContext {
	readonly view?: string;
	readonly settingsSection?: string;
	readonly activeMainTab?: string;
	readonly selectedFolderId?: string | null;
	readonly selectedChatId?: string | null;
	readonly activeSessionId?: string | null;
	readonly openFile?: string | null;
	readonly rightSidebarOpen?: boolean;
	readonly leftSidebarOpen?: boolean;
	readonly recentUiActions: ReadonlyArray<DiagnosticUiAction>;
	readonly rendererLogs: ReadonlyArray<DiagnosticLogEntry>;
	readonly mainProcessLogs: ReadonlyArray<DiagnosticLogEntry>;
}

function describeOpenFile(openFile: OpenFile | null): string | null {
	if (openFile === null) return null;
	if (openFile.kind === "text") return `text:${openFile.path}`;
	if (openFile.kind === "image") return `image:${openFile.name}`;
	return `external:${openFile.absPath}`;
}

export async function collectDiagnosticsClientContext(): Promise<DiagnosticsClientContext> {
	const ui = useUiStore.getState();
	const workspace = useWorkspaceStore.getState();
	const chats = useChatsStore.getState();
	const sessions = useSessionsStore.getState();
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	const mainProcessLogs =
		(await window.zuse?.app?.getMainDiagnostics?.().catch(() => [])) ?? [];

	return {
		view: ui.view,
		settingsSection: ui.settingsSection.kind,
		activeMainTab: ui.activeMainTab,
		selectedFolderId: workspace.selectedFolderId,
		selectedChatId: chats.selectedChatId,
		activeSessionId: sessions.selectedSessionId,
		openFile: describeOpenFile(ui.openFile),
		rightSidebarOpen:
			chats.selectedChatId === null
				? false
				: ui.rightPaneLayoutByChat[
						rightPaneKey({ environmentId, chatId: chats.selectedChatId })
					]?.open === true,
		leftSidebarOpen: ui.leftSidebarOpen,
		recentUiActions: getDiagnosticUiActions(),
		rendererLogs: getRendererDiagnosticLogs(),
		mainProcessLogs,
	};
}
