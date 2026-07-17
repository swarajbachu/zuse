import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import { getFileIconUrl, getFolderIconUrl } from "../icons/material-icons.ts";

/**
 * One inline chip in the composer document. The chip renders as an atomic
 * widget that visually replaces the text span [from, to). The underlying
 * doc text still contains the canonical token (`@<relPath>` for files,
 * `/<skill-name>` for skills, `[image:<id>]` for attachments) so copy/cut
 * round-trips through the clipboard cleanly.
 */
export type ChipMeta =
  | {
      readonly kind: "file";
      readonly relPath: string;
      readonly absPath: string;
      readonly entryKind: "file" | "directory";
    }
  | {
      readonly kind: "skill";
      readonly name: string;
      readonly scope: "global" | "project";
    }
  | {
      readonly kind: "image";
      readonly id: string;
      readonly mimeType: string;
      readonly originalName: string;
      readonly previewUrl: string;
    };

export interface ChipRange {
  readonly from: number;
  readonly to: number;
  readonly meta: ChipMeta;
}

/**
 * Append a chip to the field. Carries `from`/`to` so consumers can dispatch
 * a single transaction that inserts the canonical text and registers the
 * chip in one step.
 */
export const addChipEffect = StateEffect.define<ChipRange>({
  map: (chip, mapping) => ({
    ...chip,
    from: mapping.mapPos(chip.from),
    to: mapping.mapPos(chip.to),
  }),
});

/** Drop every chip — used by `/clear`. */
export const clearChipsEffect = StateEffect.define<void>();

/**
 * Swap the metadata of an existing image chip in place — used when an
 * upload resolves and the renderer wants to replace the blob: preview URL
 * with the durable `zuse://attachments/<id>` URL without disturbing the
 * cursor or the chip's position in the doc.
 */
export const updateImageChipEffect = StateEffect.define<{
  readonly previousId: string;
  readonly meta: ChipMeta;
}>();

export const removeImageChipEffect = StateEffect.define<{
  readonly id: string;
}>();

export const isChipEffect = (effect: StateEffect<unknown>): boolean =>
  effect.is(addChipEffect) ||
  effect.is(clearChipsEffect) ||
  effect.is(updateImageChipEffect) ||
  effect.is(removeImageChipEffect);

/**
 * Holds the current chip set. Decoration ranges are derived; this field
 * is the source of truth that survives transactions.
 */
export const chipsField = StateField.define<readonly ChipRange[]>({
  create: () => [],
  update(chips, tr) {
    let next = chips
      .map((c) => ({
        ...c,
        from: tr.changes.mapPos(c.from, -1),
        to: tr.changes.mapPos(c.to, 1),
      }))
      // Drop chips whose range collapsed (the user deleted across them).
      .filter((c) => c.to > c.from);

    for (const e of tr.effects) {
      if (e.is(addChipEffect)) next = [...next, e.value];
      else if (e.is(clearChipsEffect)) next = [];
      else if (e.is(updateImageChipEffect)) {
        const { previousId, meta } = e.value;
        next = next.map((c) =>
          c.meta.kind === "image" && c.meta.id === previousId
            ? { ...c, meta }
            : c,
        );
      } else if (e.is(removeImageChipEffect)) {
        next = next.filter(
          (c) => c.meta.kind !== "image" || c.meta.id !== e.value.id,
        );
      }
    }

    // Dedupe overlapping ranges that arrive from race conditions; keep the
    // most recently added.
    const sorted = [...next].sort((a, b) => a.from - b.from);
    const out: ChipRange[] = [];
    for (const c of sorted) {
      const prev = out[out.length - 1];
      if (prev && c.from < prev.to) continue;
      out.push(c);
    }
    return out;
  },
});

class ChipWidget extends WidgetType {
  constructor(readonly meta: ChipMeta) {
    super();
  }
  eq(other: ChipWidget): boolean {
    return chipKey(this.meta) === chipKey(other.meta);
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "fz-chip";
    span.dataset.kind = this.meta.kind;
    span.contentEditable = "false";

    // Surface chip metadata as data-attributes so the React-side hover
    // popover (event-delegated on the composer card) can read them
    // without re-mounting React inside the CM widget.
    if (this.meta.kind === "file") {
      span.dataset.relPath = this.meta.relPath;
      span.dataset.absPath = this.meta.absPath;
      span.dataset.entryKind = this.meta.entryKind;
    } else if (this.meta.kind === "skill") {
      span.dataset.skillName = this.meta.name;
      span.dataset.skillScope = this.meta.scope;
    } else if (this.meta.kind === "image") {
      span.dataset.attachmentId = this.meta.id;
      span.dataset.mimeType = this.meta.mimeType;
      span.dataset.originalName = this.meta.originalName;
      span.dataset.previewUrl = this.meta.previewUrl;
    }

    const label = document.createElement("span");
    label.className = "fz-chip-label";

    if (this.meta.kind === "skill") {
      // Skill chips render as `/name` text only — no leading icon. The
      // monospace `/` cues the slash-command origin without an emoji-like
      // sparkles glyph.
      label.textContent = `/${chipLabel(this.meta)}`;
      span.append(label);
    } else {
      const icon = document.createElement("span");
      icon.className = "fz-chip-icon";
      icon.appendChild(buildIconNode(this.meta));
      label.textContent = chipLabel(this.meta);
      span.append(icon, label);
    }
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const chipKey = (meta: ChipMeta): string => {
  switch (meta.kind) {
    case "file":
      return `file:${meta.relPath}`;
    case "skill":
      return `skill:${meta.scope}:${meta.name}`;
    case "image":
      return `image:${meta.id}`;
  }
};

const chipLabel = (meta: ChipMeta): string => {
  switch (meta.kind) {
    case "file":
      return basename(meta.relPath);
    case "skill":
      return meta.name;
    case "image":
      return meta.originalName;
  }
};

const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

const buildIconNode = (meta: ChipMeta): Node => {
  if (meta.kind === "file") {
    const url =
      meta.entryKind === "directory"
        ? getFolderIconUrl(basename(meta.relPath), false)
        : getFileIconUrl(basename(meta.relPath));
    if (url !== null) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.className = "fz-chip-iconimg";
      return img;
    }
  }
  if (meta.kind === "image") {
    // Image attachment → thumbnail. Non-image attachments share the same
    // chip kind (so the wire shape stays tidy) but render with the
    // file-type material icon instead.
    const isImage =
      meta.mimeType.startsWith("image/") && meta.previewUrl !== "";
    if (isImage) {
      const img = document.createElement("img");
      img.src = meta.previewUrl;
      img.alt = "";
      img.className = "fz-chip-thumb";
      img.draggable = false;
      return img;
    }
    const url = getFileIconUrl(meta.originalName);
    if (url !== null) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.className = "fz-chip-iconimg";
      return img;
    }
  }
  // Fallback — should be unreachable.
  return document.createElement("span");
};

/** Re-derive decorations from the chip field on every state change. */
const chipDecorations = (state: EditorState): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  const chips = state.field(chipsField);
  // RangeSetBuilder requires sorted, non-overlapping inputs; chipsField
  // already returns sorted/deduped ranges.
  for (const c of chips) {
    builder.add(
      c.from,
      c.to,
      Decoration.replace({ widget: new ChipWidget(c.meta) }),
    );
  }
  return builder.finish();
};

/**
 * Bundle: the field + a derived ViewPlugin-equivalent decoration provider
 * + an `atomicRanges` provider so cursor movement skips over chips.
 */
export const chipExtensions = [
  chipsField,
  EditorView.decorations.compute([chipsField], (state) =>
    chipDecorations(state),
  ),
  EditorView.atomicRanges.of((view) => {
    const chips = view.state.field(chipsField);
    const builder = new RangeSetBuilder<Decoration>();
    for (const c of chips) builder.add(c.from, c.to, Decoration.mark({}));
    return builder.finish();
  }),
] as const;

/** Look up the chip range that covers (or starts at) `pos`. */
export const chipAt = (state: EditorState, pos: number): ChipRange | null => {
  const chips = state.field(chipsField);
  return chips.find((c) => pos >= c.from && pos <= c.to) ?? null;
};

/** Used by the segment parser at submit time. */
export const allChips = (state: EditorState): readonly ChipRange[] =>
  state.field(chipsField);

// Suppress unused-warning when this file is imported only for its side effects.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RangePlaceholder = Range<Decoration>;
