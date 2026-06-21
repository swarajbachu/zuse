import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

export interface RevealedCodeAnnotation {
  readonly id: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly comment: string;
}

export const revealAnnotationEffect =
  StateEffect.define<RevealedCodeAnnotation | null>();
export const setAnnotationsEffect =
  StateEffect.define<ReadonlyArray<RevealedCodeAnnotation>>();

export type AnnotationWidgetSaveDetail = {
  readonly id: string;
  readonly comment: string;
};

export type AnnotationWidgetDeleteDetail = {
  readonly id: string;
};

export const ANNOTATION_WIDGET_SAVE = "memoize:annotation-save";
export const ANNOTATION_WIDGET_DELETE = "memoize:annotation-delete";

class AnnotationNoteWidget extends WidgetType {
  constructor(private readonly annotation: RevealedCodeAnnotation) {
    super();
  }

  override eq(other: AnnotationNoteWidget): boolean {
    return (
      other.annotation.id === this.annotation.id &&
      other.annotation.comment === this.annotation.comment &&
      other.annotation.startLine === this.annotation.startLine &&
      other.annotation.endLine === this.annotation.endLine
    );
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-annotation-note";

    const header = document.createElement("div");
    header.className = "cm-annotation-note-header";

    const avatar = document.createElement("div");
    avatar.className = "cm-annotation-note-avatar";
    avatar.textContent = "You";

    const meta = document.createElement("div");
    meta.className = "cm-annotation-note-meta";

    const author = document.createElement("span");
    author.className = "cm-annotation-note-author";
    author.textContent = "You";

    const range = document.createElement("span");
    range.className = "cm-annotation-note-range";
    range.textContent =
      this.annotation.startLine === this.annotation.endLine
        ? `Line ${this.annotation.startLine}`
        : `Lines ${this.annotation.startLine}-${this.annotation.endLine}`;

    const actions = document.createElement("div");
    actions.className = "cm-annotation-note-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-annotation-note-action";
    edit.textContent = "Edit";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className =
      "cm-annotation-note-action cm-annotation-note-action-danger";
    remove.textContent = "Delete";

    actions.append(edit, remove);
    meta.append(author, range);
    header.append(avatar, meta, actions);

    const comment = document.createElement("div");
    comment.className = "cm-annotation-note-comment";
    comment.textContent = this.annotation.comment;

    const editor = document.createElement("div");
    editor.className = "cm-annotation-note-editor";
    editor.hidden = true;

    const textarea = document.createElement("textarea");
    textarea.className = "cm-annotation-note-textarea";
    textarea.rows = 3;
    textarea.value = this.annotation.comment;

    const editorActions = document.createElement("div");
    editorActions.className = "cm-annotation-note-editor-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className =
      "cm-annotation-note-button cm-annotation-note-button-ghost";
    cancel.textContent = "Cancel";

    const save = document.createElement("button");
    save.type = "button";
    save.className =
      "cm-annotation-note-button cm-annotation-note-button-primary";
    save.textContent = "Save";

    editorActions.append(cancel, save);
    editor.append(textarea, editorActions);

    const setEditing = (editing: boolean): void => {
      comment.hidden = editing;
      editor.hidden = !editing;
      if (editing) {
        textarea.value = this.annotation.comment;
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(
            textarea.value.length,
            textarea.value.length,
          );
        });
      }
    };

    edit.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setEditing(true);
    });
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
    });
    save.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const trimmed = textarea.value.trim();
      if (trimmed.length === 0) return;
      wrap.dispatchEvent(
        new CustomEvent<AnnotationWidgetSaveDetail>(ANNOTATION_WIDGET_SAVE, {
          bubbles: true,
          detail: { id: this.annotation.id, comment: trimmed },
        }),
      );
    });
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      wrap.dispatchEvent(
        new CustomEvent<AnnotationWidgetDeleteDetail>(
          ANNOTATION_WIDGET_DELETE,
          {
            bubbles: true,
            detail: { id: this.annotation.id },
          },
        ),
      );
    });
    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        setEditing(false);
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        save.click();
      }
    });

    wrap.append(header, comment, editor);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const buildDecorations = (
  state: EditorState,
  annotations: ReadonlyArray<RevealedCodeAnnotation>,
): DecorationSet => {
  if (annotations.length === 0) return Decoration.none;

  const doc = state.doc;
  const builder = new RangeSetBuilder<Decoration>();

  const normalized = annotations
    .map((annotation) => {
      const startLine = Math.max(1, Math.min(annotation.startLine, doc.lines));
      const endLine = Math.max(
        startLine,
        Math.min(annotation.endLine, doc.lines),
      );
      return { ...annotation, startLine, endLine };
    })
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const ranges: Array<{
    readonly from: number;
    readonly to: number;
    readonly decoration: Decoration;
  }> = [];
  for (const annotation of normalized) {
    const start = doc.line(annotation.startLine);
    const end = doc.line(annotation.endLine);
    ranges.push({
      from: start.from,
      to: end.to,
      decoration: Decoration.mark({ class: "cm-annotation-reveal-mark" }),
    });
    ranges.push({
      from: end.to,
      to: end.to,
      decoration: Decoration.widget({
        widget: new AnnotationNoteWidget(annotation),
        side: 1,
        block: true,
      }),
    });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const range of ranges) {
    builder.add(range.from, range.to, range.decoration);
  }

  return builder.finish();
};

const annotationRevealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAnnotationsEffect)) {
        return buildDecorations(tr.state, effect.value);
      }
      if (effect.is(revealAnnotationEffect)) {
        return buildDecorations(
          tr.state,
          effect.value === null ? [] : [effect.value],
        );
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const annotationRevealExtension = [
  annotationRevealField,
  EditorView.theme({
    ".cm-line.cm-annotation-reveal-line": {
      backgroundColor: "color-mix(in oklch, var(--primary) 17%, transparent)",
      boxShadow:
        "inset 3px 0 0 var(--primary), inset 0 1px 0 color-mix(in oklch, var(--primary) 20%, transparent)",
    },
    ".cm-annotation-reveal-mark": {
      backgroundColor: "rgba(113,113,122,0.28)",
      boxShadow: "inset 0 -1px 0 rgba(212,212,216,0.24)",
    },
    ".cm-annotation-note": {
      boxSizing: "border-box",
      margin: "8px 24px 12px 88px",
      maxWidth: "min(720px, calc(100% - 120px))",
      border: "1px solid rgba(255,255,255,0.16)",
      borderRadius: "8px",
      background: "#18181b",
      color: "#f4f4f5",
      boxShadow: "none",
      overflow: "hidden",
    },
    ".cm-annotation-note-header": {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      borderBottom: "1px solid rgba(255,255,255,0.14)",
      background: "#202024",
      padding: "7px 10px",
    },
    ".cm-annotation-note-avatar": {
      display: "grid",
      placeItems: "center",
      width: "22px",
      height: "22px",
      borderRadius: "6px",
      border: "1px solid rgba(255,255,255,0.16)",
      background: "#111113",
      color: "#f4f4f5",
      fontSize: "10px",
      fontWeight: "700",
    },
    ".cm-annotation-note-meta": {
      display: "flex",
      minWidth: "0",
      alignItems: "baseline",
      gap: "8px",
      flex: "1",
    },
    ".cm-annotation-note-author": {
      fontSize: "12px",
      fontWeight: "650",
      color: "#f4f4f5",
    },
    ".cm-annotation-note-range": {
      fontSize: "11px",
      color: "#a1a1aa",
    },
    ".cm-annotation-note-actions": {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      marginLeft: "auto",
    },
    ".cm-annotation-note-action": {
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: "#a1a1aa",
      cursor: "pointer",
      font: "inherit",
      fontSize: "11px",
      lineHeight: "1",
      padding: "5px 7px",
    },
    ".cm-annotation-note-action:hover": {
      background: "#2a2a30",
      color: "#f4f4f5",
    },
    ".cm-annotation-note-action-danger:hover": {
      background: "rgba(248,113,113,0.16)",
      color: "#f87171",
    },
    ".cm-annotation-note-comment": {
      padding: "11px 12px",
      fontSize: "13px",
      lineHeight: "1.45",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    },
    ".cm-annotation-note-editor": {
      padding: "10px",
    },
    ".cm-annotation-note-textarea": {
      boxSizing: "border-box",
      width: "100%",
      minHeight: "72px",
      resize: "vertical",
      border: "1px solid rgba(255,255,255,0.16)",
      borderRadius: "6px",
      background: "#111113",
      color: "#f4f4f5",
      font: "inherit",
      fontSize: "13px",
      lineHeight: "1.45",
      outline: "none",
      padding: "8px",
    },
    ".cm-annotation-note-textarea:focus": {
      borderColor: "rgba(212,212,216,0.42)",
    },
    ".cm-annotation-note-editor-actions": {
      display: "flex",
      justifyContent: "flex-end",
      gap: "6px",
      marginTop: "8px",
    },
    ".cm-annotation-note-button": {
      border: "1px solid rgba(255,255,255,0.16)",
      borderRadius: "6px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px",
      fontWeight: "600",
      lineHeight: "1",
      padding: "7px 10px",
    },
    ".cm-annotation-note-button-ghost": {
      background: "transparent",
      color: "#a1a1aa",
    },
    ".cm-annotation-note-button-primary": {
      background: "#e4e4e7",
      borderColor: "#e4e4e7",
      color: "#18181b",
    },
  }),
];
