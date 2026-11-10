import type { QueuedMessage } from "@zuse/contracts";
import type { ChipMeta } from "../lib/codemirror/composer-chips.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

export type AttachableFile = {
	readonly relPath: string;
	readonly absPath: string;
	readonly kind: "file" | "directory";
};

type AttachFile = (ref: AttachableFile) => void;
type InsertText = (text: string) => void;
type FocusComposer = () => void;

type SendText = (text: string) => Promise<boolean>;
type EditQueuedMessage = (item: QueuedMessage) => void;

type SettleAttachment = (id: string, meta: ChipMeta | null) => void;

/** Background work of the active composer's session. */
export type ComposerBackgroundTasks = {
	readonly count: () => number;
	readonly stopAll: () => number;
};

/** Model controls of the active composer, driven by global shortcuts. */
export type ComposerModelControls = {
	readonly openPicker: () => void;
	readonly cycleEffort: () => void;
	readonly toggleFastMode: () => void;
};

type Bridge = {
	readonly settleAttachment: SettleAttachment | null;
	readonly setSettleAttachment: (fn: SettleAttachment | null) => void;
	readonly attachFile: AttachFile | null;
	readonly draftKey: string | null;
	readonly insertText: InsertText | null;
	readonly focus: FocusComposer | null;
	readonly sendText: SendText | null;
	readonly editQueuedMessage: EditQueuedMessage | null;
	readonly modelControls: ComposerModelControls | null;
	readonly setModelControls: (controls: ComposerModelControls | null) => void;
	readonly backgroundTasks: ComposerBackgroundTasks | null;
	readonly setBackgroundTasks: (tasks: ComposerBackgroundTasks | null) => void;
	readonly setAttachFile: (fn: AttachFile | null, draftKey?: string) => void;
	readonly setInsertText: (fn: InsertText | null) => void;
	readonly setFocus: (fn: FocusComposer | null) => void;
	readonly setSendText: (fn: SendText | null) => void;
	readonly setEditQueuedMessage: (fn: EditQueuedMessage | null) => void;
};

export const useComposerBridge = create<Bridge>((set) => ({
	settleAttachment: null,
	setSettleAttachment: (fn) => set({ settleAttachment: fn }),
	attachFile: null,
	draftKey: null,
	insertText: null,
	focus: null,
	sendText: null,
	editQueuedMessage: null,
	modelControls: null,
	setModelControls: (controls) => set({ modelControls: controls }),
	backgroundTasks: null,
	setBackgroundTasks: (tasks) => set({ backgroundTasks: tasks }),
	setAttachFile: (fn, draftKey) =>
		set({ attachFile: fn, draftKey: fn === null ? null : (draftKey ?? null) }),
	setInsertText: (fn) => set({ insertText: fn }),
	setFocus: (fn) => set({ focus: fn }),
	setSendText: (fn) => set({ sendText: fn }),
	setEditQueuedMessage: (fn) => set({ editQueuedMessage: fn }),
}));
