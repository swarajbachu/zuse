import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * A live, non-empty selection in the file editor — enough for the React
 * `<AnnotateOverlay>` to anchor its floating button and pre-fill the
 * `path:start-end` tag. Coordinates are viewport (client) space so the overlay
 * can render `position: fixed` without container-relative math; it re-emits on
 * scroll / geometry changes so the button tracks the selection.
 */
export interface PendingSelection {
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** Client-space coords of the selection's first line. */
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  /** Client-space bounds of the editor/diff surface that owns the selection. */
  readonly boundaryRight?: number;
  readonly boundaryBottom?: number;
}

export type OnSelect = (selection: PendingSelection | null) => void;

const readSelection = (view: EditorView): PendingSelection | null => {
  const sel = view.state.selection.main;
  if (sel.empty) {
    return null;
  }
  const coords = view.coordsAtPos(sel.from);
  const fallback = view.dom.getBoundingClientRect();
  const doc = view.state.doc;
  return {
    startLine: doc.lineAt(sel.from).number,
    endLine: doc.lineAt(sel.to).number,
    top: coords?.top ?? fallback.top + 12,
    left: coords?.left ?? fallback.left + 12,
    bottom: coords?.bottom ?? fallback.top + 32,
    boundaryRight: fallback.right,
    boundaryBottom: fallback.bottom,
  };
};

export const measureAnnotationSelection = (
  view: EditorView,
  onSelect: OnSelect,
  key?: object,
): void => {
  view.requestMeasure({
    key,
    read: readSelection,
    write: (selection) => onSelect(selection),
  });
};

/**
 * Reports the editor's current non-empty selection to `onSelect`, and `null`
 * when it collapses or the view tears down. Recomputes on selection, doc,
 * geometry and viewport changes (the last two cover scrolling and resizes).
 */
export const annotationSelectionExtension = (onSelect: OnSelect) => [
  ViewPlugin.fromClass(
    class {
      private destroyed = false;

      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate): void {
        if (
          u.selectionSet ||
          u.docChanged ||
          u.geometryChanged ||
          u.viewportChanged
        ) {
          u.view.requestMeasure({
            key: this,
            read: readSelection,
            write: (selection) => {
              if (!this.destroyed) onSelect(selection);
            },
          });
        }
      }
      destroy(): void {
        this.destroyed = true;
        onSelect(null);
      }
    },
  ),
  EditorView.domEventHandlers({
    mouseup: (_event, view) => {
      measureAnnotationSelection(view, onSelect);
    },
    keyup: (_event, view) => {
      measureAnnotationSelection(view, onSelect);
    },
    scroll: (_event, view) => {
      measureAnnotationSelection(view, onSelect);
    },
  }),
];
