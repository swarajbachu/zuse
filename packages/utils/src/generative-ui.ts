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

import {
	type ASTNode,
	createParser,
	type ElementNode,
	type ParseResult,
	parseExpression,
	split,
	tokenize,
} from "@openuidev/lang-core";
import { z } from "zod";

/** Persisted `ui_spec` content version; bump when the payload shape changes. */
export const UI_SPEC_VERSION = 1;

/** Hard cap applied before parsing — specs are chat content, keep them small. */
export const UI_SPEC_MAX_CHARS = 32 * 1024;

/** Nested component calls or `name = ...` references, e.g. `[stat1, stat2]`. */
const elementList = z.array(z.unknown()).max(64);
const tone = z.enum(["neutral", "good", "warn", "bad"]);
const fieldName = z
	.string()
	.regex(/^[A-Za-z][\w-]{0,39}$/, "use letters, digits, - or _");
const fieldOptions = z.array(z.string().min(1).max(120)).min(1);
const chartPoints = z
	.array(z.object({ label: z.string(), value: z.number().finite() }))
	.min(1)
	.max(100);

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
			"Titled section that groups related content. Renders inline with the reply — no background — so keep nesting shallow.",
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
			pairs: z.array(z.object({ key: z.string(), value: z.string() })).max(100),
		}),
	},
	Table: {
		description:
			"Dense data table. columns is the header row; rows is one string array per row.",
		props: z.object({
			columns: z.array(z.string()).min(1).max(20),
			rows: z.array(z.array(z.string()).max(20)).max(200),
		}),
	},
	Progress: {
		description: "Labeled horizontal progress bar; percent is 0-100.",
		props: z.object({
			label: z.string(),
			percent: z.number().min(0).max(100),
		}),
	},
	Badge: {
		description: "Small status pill. tone is optional.",
		props: z.object({
			label: z.string(),
			tone: tone.optional(),
		}),
	},
	List: {
		description: "Simple bullet list of short strings.",
		props: z.object({
			items: z.array(z.string()).max(100),
		}),
	},
	Grid: {
		description:
			"Responsive grid of components, collapsing to one column in narrow chats. columns is 1-4 (default 2).",
		props: z.object({
			children: elementList,
			columns: z.number().int().min(1).max(4).optional(),
		}),
	},
	BarChart: {
		description:
			"Horizontal comparison chart with visible labels and values. Supports negative values. Up to 100 points.",
		props: z.object({
			title: z.string(),
			points: chartPoints,
			unit: z.string().optional(),
		}),
	},
	LineChart: {
		description:
			"Ordered trend chart with an accessible data table. Points stay in supplied order; up to 100 points.",
		props: z.object({
			title: z.string(),
			points: chartPoints,
			unit: z.string().optional(),
		}),
	},
	Callout: {
		description:
			"Highlighted note for a warning, risk, or key takeaway. tone defaults to neutral.",
		props: z.object({
			text: z.string(),
			tone: tone.optional(),
			title: z.string().optional(),
		}),
	},
	Steps: {
		description:
			"Ordered checklist or plan with a status per step: done, active, pending, or failed.",
		props: z.object({
			items: z
				.array(
					z.object({
						label: z.string(),
						status: z.enum(["done", "active", "pending", "failed"]),
						detail: z.string().optional(),
					}),
				)
				.min(1)
				.max(20),
		}),
	},
	Tabs: {
		description:
			"Switchable views of alternatives, e.g. options or before/after. Each tab holds one component.",
		props: z.object({
			tabs: z
				.array(
					z.object({ label: z.string().min(1).max(40), content: z.unknown() }),
				)
				.min(2)
				.max(6),
		}),
	},
	FollowUps: {
		description:
			"Suggested next steps as buttons. Clicking one sends its prompt as the user's next message. 1-6 items.",
		props: z.object({
			items: z
				.array(
					z.object({
						label: z.string().min(1).max(80),
						prompt: z.string().min(1).max(2000),
					}),
				)
				.min(1)
				.max(6),
		}),
	},
	Form: {
		description:
			"Collects structured input. Holds fields (and optional display components); submitting sends the answers as the user's next message.",
		props: z.object({
			children: elementList.min(1),
			submitLabel: z.string().min(1).max(40).optional(),
			title: z.string().optional(),
		}),
	},
	Input: {
		description: "Single-line text field inside a Form.",
		props: z.object({
			name: fieldName,
			label: z.string().min(1),
			placeholder: z.string().optional(),
			value: z.string().max(2000).optional(),
		}),
	},
	TextArea: {
		description: "Multi-line text field inside a Form.",
		props: z.object({
			name: fieldName,
			label: z.string().min(1),
			placeholder: z.string().optional(),
			value: z.string().max(8000).optional(),
		}),
	},
	Select: {
		description: "Dropdown choice inside a Form; value preselects an option.",
		props: z.object({
			name: fieldName,
			label: z.string().min(1),
			options: fieldOptions.max(50),
			value: z.string().optional(),
		}),
	},
	RadioGroup: {
		description:
			"Pick exactly one of 2-8 visible options inside a Form; value preselects one.",
		props: z.object({
			name: fieldName,
			label: z.string().min(1),
			options: fieldOptions.min(2).max(8),
			value: z.string().optional(),
		}),
	},
	Checkbox: {
		description: "Yes/no toggle inside a Form.",
		props: z.object({
			name: fieldName,
			label: z.string().min(1),
			checked: z.boolean().optional(),
		}),
	},
	Slider: {
		description: "Numeric range inside a Form; value defaults to min.",
		props: z.object({
			name: fieldName,
			label: z.string().min(1),
			min: z.number().finite(),
			max: z.number().finite(),
			value: z.number().finite().optional(),
			step: z.number().finite().positive().optional(),
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

/** Bound reference expansion BEFORE materialization, which otherwise duplicates
 * shared subtrees exponentially. Only the static language subset is supported. */
const validateStaticProgram = (spec: string): void => {
	const statements = split(tokenize(spec));
	const expressions = new Map<string, ASTNode>();
	for (const statement of statements) {
		if (statement.id.startsWith("$"))
			throw new Error("Reactive state is not supported in saved UI blocks.");
		if (expressions.has(statement.id))
			throw new Error(`Duplicate statement: ${statement.id}.`);
		expressions.set(statement.id, parseExpression(statement.tokens));
	}
	if (!expressions.has("root"))
		throw new Error("Define root = Component(...).");
	let budget = 4096;
	const active = new Set<string>();
	const visit = (node: ASTNode, depth: number): void => {
		if (--budget < 0 || depth > 48)
			throw new Error(
				"UI spec is too complex; use fewer components or references.",
			);
		switch (node.k) {
			case "Str":
			case "Num":
			case "Bool":
			case "Null":
				return;
			case "Ref": {
				const target = expressions.get(node.n);
				if (!target) throw new Error(`Unresolved reference: ${node.n}.`);
				if (active.has(node.n)) throw new Error(`Cyclic reference: ${node.n}.`);
				active.add(node.n);
				visit(target, depth + 1);
				active.delete(node.n);
				return;
			}
			case "Comp":
				if (node.name === "Query" || node.name === "Mutation")
					throw new Error(
						"Query() and Mutation() are not supported in emit_ui blocks.",
					);
				if (!Object.hasOwn(generativeUiComponents, node.name))
					throw new Error(
						`Unknown component ${node.name}. Available: ${generativeUiComponentNames.join(", ")}.`,
					);
				for (const arg of node.args) visit(arg, depth + 1);
				return;
			case "Arr":
				for (const value of node.els) visit(value, depth + 1);
				return;
			case "Obj":
				for (const [, value] of node.entries) visit(value, depth + 1);
				return;
			default:
				throw new Error(
					"Only literal values, components, and references are supported in saved UI blocks.",
				);
		}
	};
	for (const expr of expressions.values()) visit(expr, 0);
};

/** Components that collect input; they only make sense inside a Form. */
export const GENERATIVE_UI_FIELD_COMPONENTS: ReadonlySet<GenerativeUiComponentName> =
	new Set(["Input", "TextArea", "Select", "RadioGroup", "Checkbox", "Slider"]);

const isElement = (value: unknown): value is ElementNode =>
	value !== null &&
	typeof value === "object" &&
	"type" in value &&
	value.type === "element";

const requireElement = (value: unknown, where: string): ElementNode => {
	if (!isElement(value)) throw new Error(`${where} must be a component.`);
	return value;
};

/** Fields in the enclosing Form, keyed by name; null outside a Form. */
type FormScope = Set<string> | null;

/** Apply the full Zod constraints plus structural rules lang-core does not
 * know: ranges, collection caps, table shape, and Form/field nesting. */
const validateElement = (element: ElementNode, form: FormScope): void => {
	const name = element.typeName;
	if (!Object.hasOwn(generativeUiComponents, name))
		throw new Error(`Unknown component ${name}.`);
	const typed = name as GenerativeUiComponentName;
	const validation = generativeUiComponents[typed].props.safeParse(
		element.props,
	);
	if (!validation.success)
		throw new Error(
			`${name}: ${validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
		);
	const props = validation.data as Record<string, unknown>;
	if (GENERATIVE_UI_FIELD_COMPONENTS.has(typed)) {
		if (form === null) throw new Error(`${name} must be inside a Form.`);
		const field = props.name as string;
		if (form.has(field)) throw new Error(`Duplicate field name: ${field}.`);
		form.add(field);
	}
	switch (typed) {
		case "Table": {
			const { columns, rows } = generativeUiComponents.Table.props.parse(props);
			if (rows.some((row) => row.length !== columns.length))
				throw new Error(
					"Table rows must have the same number of cells as columns.",
				);
			return;
		}
		case "Select":
		case "RadioGroup": {
			const { options, value } =
				generativeUiComponents.Select.props.parse(props);
			if (value !== undefined && !options.includes(value))
				throw new Error(
					`${name} ${props.name}: value must be one of the options.`,
				);
			return;
		}
		case "Slider": {
			const { min, max, value } =
				generativeUiComponents.Slider.props.parse(props);
			if (min >= max)
				throw new Error(`Slider ${props.name}: min must be below max.`);
			if (value !== undefined && (value < min || value > max))
				throw new Error(
					`Slider ${props.name}: value must be within min and max.`,
				);
			return;
		}
		case "Card":
		case "Grid":
			for (const child of (props.children as unknown[] | undefined) ?? [])
				validateElement(requireElement(child, `${name} children`), form);
			return;
		case "Form":
			if (form !== null) throw new Error("Forms cannot be nested.");
			{
				const fields = new Set<string>();
				for (const child of props.children as unknown[])
					validateElement(requireElement(child, "Form children"), fields);
				if (fields.size === 0)
					throw new Error("Form needs at least one field.");
			}
			return;
		case "Tabs":
			for (const tab of generativeUiComponents.Tabs.props.parse(props).tabs)
				validateElement(requireElement(tab.content, "Tab content"), form);
			return;
		default:
			return;
	}
};

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
		validateStaticProgram(spec);
		result = uiSpecParser.parse(spec);
		// lang-core's own errors name the exact field; report them first.
		if (result.root && result.meta.errors.length === 0)
			validateElement(result.root, null);
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
	if (result.meta.orphaned.length > 0) {
		problems.push(
			`Unused statements: ${result.meta.orphaned.join(", ")}. Every component must be reachable from root.`,
		);
	}
	if (result.meta.incomplete) {
		problems.push("Spec looks truncated (incomplete input).");
	}
	// Query()/Mutation() would call tools at render time; the renderer never
	// wires a tool provider. The only interactions are user-sent messages.
	if (
		result.queryStatements.length > 0 ||
		result.mutationStatements.length > 0
	) {
		problems.push(
			"Query() and Mutation() are not supported in emit_ui blocks.",
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
