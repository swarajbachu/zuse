import {
  getDiagnosticUiActions,
  getRendererDiagnosticLogs,
  type DiagnosticLogEntry,
  type DiagnosticUiAction,
} from "./diagnostics-recorder.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore, type OpenFile } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";

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
    rightSidebarOpen: ui.rightSidebarOpen,
    leftSidebarOpen: ui.leftSidebarOpen,
    recentUiActions: getDiagnosticUiActions(),
    rendererLogs: getRendererDiagnosticLogs(),
    mainProcessLogs,
  };
}
