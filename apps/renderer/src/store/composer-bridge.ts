import { createAtomStore as create } from "../state/atom-store.ts";

export type AttachableFile = {
  readonly relPath: string;
  readonly absPath: string;
  readonly kind: "file" | "directory";
};

type AttachFile = (ref: AttachableFile) => void;
type InsertText = (text: string) => void;
type FocusComposer = () => void;

type Bridge = {
  readonly attachFile: AttachFile | null;
  readonly insertText: InsertText | null;
  readonly focus: FocusComposer | null;
  readonly setAttachFile: (fn: AttachFile | null) => void;
  readonly setInsertText: (fn: InsertText | null) => void;
  readonly setFocus: (fn: FocusComposer | null) => void;
};

export const useComposerBridge = create<Bridge>((set) => ({
  attachFile: null,
  insertText: null,
  focus: null,
  setAttachFile: (fn) => set({ attachFile: fn }),
  setInsertText: (fn) => set({ insertText: fn }),
  setFocus: (fn) => set({ focus: fn }),
}));
