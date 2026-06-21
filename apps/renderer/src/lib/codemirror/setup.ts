import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type KeyBinding,
} from "@codemirror/view";

import { useKeybindingsStore } from "../../store/keybindings";
import {
  annotationRevealExtension,
  revealAnnotationEffect,
  setAnnotationsEffect,
  type RevealedCodeAnnotation,
} from "./annotation-reveal.ts";
import {
  annotationSelectionExtension,
  type OnSelect,
} from "./annotation-selection.ts";
import { keyToCodeMirrorKey } from "./keybinding-bridge.ts";
import { memoizeTheme } from "./theme.ts";

// One compartment for the language extension so opening a different file
// reconfigures it via a single transaction instead of rebuilding the view.
export const languageCompartment = new Compartment();

/**
 * One editor-keymap compartment per view — same pattern as the composer.
 * Lets `reconfigureEditorKeymap` swap the `editor.save` chord (and any
 * future editor.* commands) without re-mounting the editor.
 */
const editorKeymapCompartment = new WeakMap<EditorView, Compartment>();

export type CreateEditorParams = {
  parent: HTMLElement;
  doc: string;
  language: Extension | null;
  onSave: () => void;
  onChange: (doc: string) => void;
  /**
   * Reports the current non-empty selection (or `null`) so the host can render
   * the floating "Annotate" affordance. Omit to disable annotation support.
   */
  onSelect?: OnSelect;
  /**
   * Fired by the `editor.annotate` keybinding — opens the comment card for the
   * current selection. The host owns the actual UI.
   */
  onAnnotate?: () => void;
};

/**
 * Build the editor-scoped keymap from the live keybindings store. Surfaces
 * `editor.save` and `editor.annotate`; adding more editor.* commands later is
 * just a new case in the switch.
 */
const buildEditorKeymap = (
  onSave: () => void,
  onAnnotate?: () => void,
): readonly KeyBinding[] => {
  const rules = useKeybindingsStore.getState().resolvedRules;
  const out: KeyBinding[] = [];
  const seen = new Set<string>();
  // Walk last-first so user rules win over defaults on the same chord.
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r === undefined) continue;
    if (!r.rule.command.startsWith("editor.")) continue;
    const key = keyToCodeMirrorKey(r.shortcut);
    if (key === null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (r.rule.command) {
      case "editor.save":
        out.push({
          key,
          preventDefault: true,
          run: () => {
            onSave();
            return true;
          },
        });
        break;
      case "editor.annotate":
        if (onAnnotate === undefined) break;
        out.push({
          key,
          preventDefault: true,
          run: () => {
            onAnnotate();
            return true;
          },
        });
        break;
      default:
        break;
    }
  }
  return out;
};

export const createEditor = ({
  parent,
  doc,
  language,
  onSave,
  onChange,
  onSelect,
  onAnnotate,
}: CreateEditorParams): EditorView => {
  const userKeymapCompartment = new Compartment();

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        // User-bindable editor commands live in their own compartment so
        // a rebind in settings takes effect without re-mounting the view.
        userKeymapCompartment.of(
          keymap.of([...buildEditorKeymap(onSave, onAnnotate)]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
        memoizeTheme,
        annotationRevealExtension,
        languageCompartment.of(language ?? []),
        ...(onSelect !== undefined
          ? [annotationSelectionExtension(onSelect)]
          : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  editorKeymapCompartment.set(view, userKeymapCompartment);
  return view;
};

export const revealAnnotationInEditor = (
  view: EditorView,
  annotation: RevealedCodeAnnotation,
): void => {
  const doc = view.state.doc;
  if (doc.lines === 0) return;
  const startLine = Math.max(1, Math.min(annotation.startLine, doc.lines));
  const endLine = Math.max(startLine, Math.min(annotation.endLine, doc.lines));
  const start = doc.line(startLine);
  view.dispatch({
    effects: [
      revealAnnotationEffect.of({
        ...annotation,
        startLine,
        endLine,
      }),
      EditorView.scrollIntoView(start.from, { y: "center" }),
    ],
  });
  view.focus();
};

export const scrollAnnotationIntoView = (
  view: EditorView,
  annotation: RevealedCodeAnnotation,
): void => {
  const doc = view.state.doc;
  if (doc.lines === 0) return;
  const startLine = Math.max(1, Math.min(annotation.startLine, doc.lines));
  const start = doc.line(startLine);
  view.dispatch({
    effects: EditorView.scrollIntoView(start.from, { y: "center" }),
  });
  view.focus();
};

export const clearAnnotationRevealInEditor = (view: EditorView): void => {
  view.dispatch({ effects: revealAnnotationEffect.of(null) });
};

export const setAnnotationsInEditor = (
  view: EditorView,
  annotations: ReadonlyArray<RevealedCodeAnnotation>,
): void => {
  view.dispatch({ effects: setAnnotationsEffect.of(annotations) });
};

/**
 * Re-derive the editor's keymap from the keybindings store and dispatch a
 * compartment reconfigure. Call after every emit from `useKeybindingsStore`
 * — keybinding edits take effect without losing the open document.
 */
export const reconfigureEditorKeymap = (
  view: EditorView,
  onSave: () => void,
  onAnnotate?: () => void,
): void => {
  const compartment = editorKeymapCompartment.get(view);
  if (compartment === undefined) return;
  view.dispatch({
    effects: compartment.reconfigure(
      keymap.of([...buildEditorKeymap(onSave, onAnnotate)]),
    ),
  });
};
