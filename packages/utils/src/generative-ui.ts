/**
 * Shared spec for the `emit_ui` generative-UI surface. One module owns the
 * component catalogue — names, prop schemas, and descriptions — so the
 * orchestration tool description (packages/agents), the server-side
 * validator (apps/server), and the transcript renderer's component library
 * (apps/renderer) can never drift.
 *
 * Specs are OpenUI Lang text parsed by `@openuidev/lang-core`:
 * `root = Component(arg, ...)`, strictly positional arguments, children
 * nested via arrays or `name = ...` references.
 */

import { createParser, type ParseResult } from "@openuidev/lang-core";
import { z } from "zod";

/** Persisted `ui_spec` content version; bump when the payload shape changes. */
export const UI_SPEC_VERSION = 1;

/** Hard cap applied before parsing — specs are chat content, keep them small. */
export const UI_SPEC_MAX_CHARS = 32 * 1024;

/** Nested component calls or `name = ...` references, e.g. `[stat1, stat2]`. */
const elementList = z.array(z.any());

export interface GenerativeUiComponentSpec {
	readonly description: string;
	readonly props: z.ZodObject<z.ZodRawShape>;
}

/**
 * The component catalogue. Prop declaration order IS the positional argument
 * order the OpenUI Lang parser uses — always declare required props first and
 * optional props last. For containers, `children` comes first so the model
 * can write `Card([stat1, stat2])`.
 */
export const generativeUiComponents = {
	Card: {
		description:
			"Tonal container that groups a small UI block. Pass an optional title as the second argument.",
		props: z.object({
			children: elementList.optional(),
			title: z.string().optional(),
		}),
	},
	Text: {
		description: "Plain paragraph of body text.",
		props: z.object({
			text: z.string(),
		}),
	},
	Stat: {
		description:
			"Single prominent metric — large value with a small label and optional hint.",
		props: z.object({
			label: z.string(),
			value: z.string(),
			hint: z.string().optional(),
		}),
	},
	KeyValue: {
		description:
			"Compact two-column list of key/value pairs — ids, branches, statuses.",
		props: z.object({
			pairs: z.array(z.object({ key: z.string(), value: z.string() })),
		}),
	},
	Table: {
		description:
			"Dense data table. columns is the header row; rows is one string array per row.",
		props: z.object({
			columns: z.array(z.string()),
			rows: z.array(z.array(z.string())),
		}),
	},
	Progress: {
		description: "Labeled horizontal progress bar; percent is 0-100.",
		props: z.object({
			label: z.string(),
			percent: z.number(),
		}),
	},
	Badge: {
		description: "Small status pill. tone is optional.",
		props: z.object({
			label: z.string(),
			tone: z.enum(["neutral", "good", "warn", "bad"]).optional(),
		}),
	},
	List: {
		description: "Simple bullet list of short strings.",
		props: z.object({
			items: z.array(z.string()),
		}),
	},
} satisfies Record<string, GenerativeUiComponentSpec>;

export type GenerativeUiComponentName = keyof typeof generativeUiComponents;

export const generativeUiComponentNames = Object.keys(
	generativeUiComponents,
) as ReadonlyArray<GenerativeUiComponentName>;

const WRAPPING_DEF_TYPES = new Set([
	"optional",
	"default",
	"nullable",
	"readonly",
	"prefault",
]);

const unwrapDef = (schema: z.core.$ZodType): Record<string, unknown> => {
	let def = schema._zod.def as unknown as Record<string, unknown>;
	while (
		typeof def.type === "string" &&
		WRAPPING_DEF_TYPES.has(def.type) &&
		def.innerType !== undefined
	) {
		def = (def.innerType as z.core.$ZodType)._zod.def as unknown as Record<
			string,
			unknown
		>;
	}
	return def;
};

/** Short type label for a prop, matching the syntax lang-core prompts use. */
const propTypeLabel = (schema: z.core.$ZodType): string => {
	const def = unwrapDef(schema);
	switch (def.type) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "array":
			return `${propTypeLabel(def.element as z.core.$ZodType)}[]`;
		case "tuple":
			return `[${(def.items as ReadonlyArray<z.core.$ZodType>).map(propTypeLabel).join(", ")}]`;
		case "enum":
			return Object.values(def.entries as Record<string, string>)
				.map((value) => JSON.stringify(value))
				.join(" | ");
		case "object":
			return `{ ${Object.entries(def.shape as Record<string, z.core.$ZodType>)
				.map(([key, value]) => `${key}: ${propTypeLabel(value)}`)
				.join(", ")} }`;
		default:
			return "any";
	}
};

const propSignature = (name: string, schema: z.ZodType): string =>
	`${name}${schema.safeParse(undefined).success ? "?" : ""}: ${propTypeLabel(schema)}`;

/** `Name(prop: type, prop?: type)` — one line per component for prompts. */
export const generativeUiComponentSignature = (
	name: GenerativeUiComponentName,
): string =>
	`${name}(${Object.entries(generativeUiComponents[name].props.shape)
		.map(([propName, schema]) => propSignature(propName, schema))
		.join(", ")})`;

export const generativeUiComponentLines = (): string =>
	generativeUiComponentNames
		.map(
			(name) =>
				`${generativeUiComponentSignature(name)} — ${generativeUiComponents[name].description}`,
		)
		.join("\n");

/**
 * JSON Schema fed to `createParser` / `createStreamingParser` — the same
 * shape `library.toJSONSchema()` produces (`$defs` keyed by component name).
 */
export const generativeUiJsonSchema = (): {
	$defs: Record<string, unknown>;
} => ({
	$defs: Object.fromEntries(
		Object.entries(generativeUiComponents).map(([name, spec]) => [
			name,
			{ ...z.toJSONSchema(spec.props), description: spec.description },
		]),
	),
});

const uiSpecParser = createParser(
	generativeUiJsonSchema() as Parameters<typeof createParser>[0],
);

export const parseGenerativeUiSpec = (spec: string): ParseResult =>
	uiSpecParser.parse(spec);

export type GenerativeUiSpecValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: string };

/**
 * Validate a raw spec string. Rejects empty/oversized input and anything the
 * parser cannot resolve to a clean `root` element — validation errors,
 * unresolved references, and truncated input all fail so the model gets a
 * fixable error instead of a silently degraded render.
 */
export const validateGenerativeUiSpec = (
	spec: unknown,
): GenerativeUiSpecValidation => {
	if (typeof spec !== "string" || spec.trim().length === 0) {
		return {
			ok: false,
			error: "emit_ui requires a non-empty OpenUI Lang spec string.",
		};
	}
	if (spec.length > UI_SPEC_MAX_CHARS) {
		return {
			ok: false,
			error: `emit_ui spec is ${spec.length} chars; the limit is ${UI_SPEC_MAX_CHARS}.`,
		};
	}
	let result: ParseResult;
	try {
		result = uiSpecParser.parse(spec);
	} catch (error) {
		return {
			ok: false,
			error: `emit_ui spec failed to parse: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const problems = result.meta.errors.map((error) => error.message);
	if (result.meta.unresolved.length > 0) {
		problems.push(
			`Unresolved references: ${result.meta.unresolved.join(", ")}.`,
		);
	}
	if (result.meta.incomplete) {
		problems.push("Spec looks truncated (incomplete input).");
	}
	// emit_ui blocks are display-only: Query()/Mutation() would try to call
	// tools at render time, and the renderer never wires a tool provider.
	if (
		result.queryStatements.length > 0 ||
		result.mutationStatements.length > 0
	) {
		problems.push(
			"Query() and Mutation() are not supported — emit_ui blocks are static.",
		);
	}
	if (result.root === null && problems.length === 0) {
		problems.push(
			"Spec did not produce a root element — start with `root = <Component>(...)`.",
		);
	}
	if (result.root === null || problems.length > 0) {
		return { ok: false, error: problems.join(" ") };
	}
	return { ok: true };
};
