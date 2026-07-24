import { Schema } from "effect";

export const BrowserViewportMode = Schema.Literals([
	"fill",
	"phone",
	"tablet",
	"laptop",
	"desktop",
	"custom",
]);
export type BrowserViewportMode = typeof BrowserViewportMode.Type;

export const BrowserOverlayShape = Schema.Union([
	Schema.TaggedStruct("Rectangle", {
		id: Schema.String,
		x: Schema.Number,
		y: Schema.Number,
		width: Schema.Number,
		height: Schema.Number,
		color: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("Highlight", {
		id: Schema.String,
		x: Schema.Number,
		y: Schema.Number,
		width: Schema.Number,
		height: Schema.Number,
		color: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("Arrow", {
		id: Schema.String,
		fromX: Schema.Number,
		fromY: Schema.Number,
		toX: Schema.Number,
		toY: Schema.Number,
		color: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("Label", {
		id: Schema.String,
		x: Schema.Number,
		y: Schema.Number,
		text: Schema.String,
		color: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("Freehand", {
		id: Schema.String,
		points: Schema.Array(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
		color: Schema.optional(Schema.String),
	}),
]);
export type BrowserOverlayShape = typeof BrowserOverlayShape.Type;
