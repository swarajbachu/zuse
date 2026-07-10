import { Effect, Schema } from "effect";

import { ProviderId } from "./agent.ts";

/**
 * Reference to an uploaded attachment. The renderer carries this on
 * `ComposerInput` and on persisted user-rich messages; the actual bytes live
 * under the desktop app's userData directory and are served to the renderer
 * via the `zuse://attachments/<id>` custom protocol.
 *
 * `id` shape: `<sessionSegment>-<uuid>` (sanitised session id + v4 UUID).
 */
export const AttachmentRef = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.String,
  originalName: Schema.String,
});
export type AttachmentRef = typeof AttachmentRef.Type;

/**
 * Reference to a file or directory the user tagged into the composer via the
 * `@` popover. Paths are workspace-rooted; the server expands the contents at
 * send time so the provider sees the files inline.
 */
export const FileRef = Schema.Struct({
  relPath: Schema.String,
  absPath: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
});
export type FileRef = typeof FileRef.Type;

/**
 * Reference to a provider-defined skill the user invoked from the slash
 * popover. Memoize never inlines the skill body; the driver expands it
 * provider-side so semantics match the underlying CLI.
 */
export const SkillRef = Schema.Struct({
  name: Schema.String,
  scope: Schema.Literals(["global", "project"]),
  args: Schema.String,
  providerId: ProviderId,
});
export type SkillRef = typeof SkillRef.Type;

/**
 * A region of code the user pinned with a comment. Created by selecting one or
 * more lines in the file editor / diff view and typing a note; annotations
 * stack into a tray above the composer and travel with the submission. Unlike
 * `FileRef`, no code snippet crosses the wire — `relPath` + the line range
 * already pinpoints the region and the agent reads the file itself. The server
 * serialises these into a numbered list appended to the prompt text.
 */
export const CodeAnnotation = Schema.Struct({
  /** Client-generated v4 UUID — list keys + removal. */
  id: Schema.String,
  /**
   * Workspace-rooted path, for display + the model (the agent's cwd is the
   * workspace root, so a relative path resolves). For files outside any
   * project folder this holds the absolute path instead.
   */
  relPath: Schema.String,
  /** Absolute path used by renderer affordances that can reopen the target. */
  absPath: Schema.String,
  /** 1-based, inclusive. `startLine === endLine` for a single line. */
  startLine: Schema.Number,
  endLine: Schema.Number,
  comment: Schema.String,
});
export type CodeAnnotation = typeof CodeAnnotation.Type;

export const BrowserAnnotationRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type BrowserAnnotationRect = typeof BrowserAnnotationRect.Type;

export const BrowserAnnotationPoint = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type BrowserAnnotationPoint = typeof BrowserAnnotationPoint.Type;

export const BrowserAnnotationElement = Schema.Struct({
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  label: Schema.String,
  rect: BrowserAnnotationRect,
  textPreview: Schema.String,
});
export type BrowserAnnotationElement = typeof BrowserAnnotationElement.Type;

export const BrowserAnnotationRegion = Schema.Struct({
  id: Schema.String,
  rect: BrowserAnnotationRect,
});
export type BrowserAnnotationRegion = typeof BrowserAnnotationRegion.Type;

export const BrowserAnnotationStroke = Schema.Struct({
  id: Schema.String,
  points: Schema.Array(BrowserAnnotationPoint),
  bounds: BrowserAnnotationRect,
});
export type BrowserAnnotationStroke = typeof BrowserAnnotationStroke.Type;

/**
 * A visual annotation the user made directly on the Browser preview. The
 * screenshot travels through the existing attachment path, so the structured
 * annotation never carries raw image bytes or full page text.
 */
export const BrowserAnnotation = Schema.Struct({
  _tag: Schema.Literal("browser"),
  id: Schema.String,
  comment: Schema.String,
  createdAt: Schema.String,
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  elements: Schema.Array(BrowserAnnotationElement),
  regions: Schema.Array(BrowserAnnotationRegion),
  strokes: Schema.Array(BrowserAnnotationStroke),
  screenshotAttachment: Schema.NullOr(AttachmentRef),
});
export type BrowserAnnotation = typeof BrowserAnnotation.Type;

export const ComposerAnnotation = Schema.Union([
  CodeAnnotation,
  BrowserAnnotation,
]);
export type ComposerAnnotation = typeof ComposerAnnotation.Type;

/**
 * The full payload of a single composer submission. `text` is the editor
 * document with `@` / `/` tokens preserved as plain text; the typed arrays
 * give the server enough metadata to expand each segment without re-parsing.
 */
export class ComposerInput extends Schema.Class<ComposerInput>("ComposerInput")(
  {
    text: Schema.String,
    attachments: Schema.Array(AttachmentRef),
    fileRefs: Schema.Array(FileRef),
    skillRefs: Schema.Array(SkillRef),
    annotations: Schema.Array(ComposerAnnotation).pipe(
      Schema.withDecodingDefaultType(Effect.succeed([])),
    ),
  },
) {}
