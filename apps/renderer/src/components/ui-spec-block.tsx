// Must evaluate before @openuidev/react-lang (see module comment).
import "~/lib/openui-devtools";
import {
	type ActionEvent,
	BuiltinActionType,
	type ComponentRenderProps,
	createLibrary,
	defineComponent,
	type ElementNode,
	Renderer,
	useTriggerAction,
} from "@openuidev/react-lang";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import "@zuse/i18n/english/chat";
import { useMessages } from "@zuse/i18n/react";
import {
	GENERATIVE_UI_FIELD_COMPONENTS,
	type GenerativeUiComponentName,
	generativeUiComponents,
	validateGenerativeUiSpec,
} from "@zuse/utils/generative-ui";
import { Check, Circle, X } from "lucide-react";
import {
	createContext,
	Fragment,
	type ReactNode,
	useCallback,
	useContext,
	useId,
	useMemo,
	useState,
} from "react";
import type { z } from "zod";
import { sendThroughCurrentComposer } from "~/lib/context-handoff";
import { cn } from "~/lib/utils";
import { Line } from "./dither-kit/area.tsx";
import { LineChart } from "./dither-kit/area-chart.tsx";
import { Grid } from "./dither-kit/grid.tsx";
import { Tooltip } from "./dither-kit/tooltip.tsx";
import { XAxis } from "./dither-kit/x-axis.tsx";
import { YAxis } from "./dither-kit/y-axis.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { ErrorBoundary } from "./ui/error-boundary.tsx";
import { Input } from "./ui/input.tsx";
import { SegmentedTabs } from "./ui/segmented-tabs.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "./ui/select.tsx";
import { Slider } from "./ui/slider.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { toastManager } from "./ui/toast.tsx";
import { UiSpecFallback } from "./ui-spec-fallback.tsx";

/**
 * Renders a persisted `ui_spec` message — an OpenUI Lang block emitted by the
 * agent via the `emit_ui` orchestration tool — inline with the assistant's
 * reply. The component catalogue is defined once in
 * `@zuse/utils/generative-ui` and mapped here onto the renderer's primitives.
 *
 * No `toolProvider` or `onStateUpdate` is passed to `Renderer`, and the
 * server-side validator rejects Query(), Mutation(), reactive state, and
 * action expressions. The only interaction is OpenUI's built-in
 * `continue_conversation` action, raised by FollowUps and Form submissions:
 * it sends the user's response as their next message through the session's
 * composer. Blocks outside the latest turn render read-only.
 */

type SpecProps<Name extends GenerativeUiComponentName> = z.infer<
	(typeof generativeUiComponents)[Name]["props"]
>;

type SpecComponent<Name extends GenerativeUiComponentName> = (
	renderProps: ComponentRenderProps<SpecProps<Name>>,
) => ReactNode;

/** Whether this block may send, and whether it already has. */
const UiInteraction = createContext<{
	readonly enabled: boolean;
	readonly sent: boolean;
}>({ enabled: false, sent: false });

const useInteractive = () => {
	const { enabled, sent } = useContext(UiInteraction);
	return { disabled: !enabled || sent, sent };
};

const renderChildren = (
	renderNode: (value: unknown) => ReactNode,
	children: ReadonlyArray<unknown> | undefined,
) =>
	(children ?? []).map((child, index) => (
		// eslint-disable-next-line react/no-array-index-key -- spec order is stable
		<Fragment key={index}>{renderNode(child)}</Fragment>
	));

const UiCard: SpecComponent<"Card"> = ({ props, renderNode }) => (
	<section className="flex min-w-0 flex-col gap-3">
		{props.title ? (
			<h3 className="font-semibold text-foreground text-sm">{props.title}</h3>
		) : null}
		{renderChildren(renderNode, props.children)}
	</section>
);

const UiText: SpecComponent<"Text"> = ({ props }) => (
	<p className="whitespace-pre-wrap break-words text-foreground/90 text-sm leading-6">
		{props.text}
	</p>
);

const UiStat: SpecComponent<"Stat"> = ({ props }) => (
	<div className="flex min-w-0 flex-col gap-0.5">
		<span className="truncate font-semibold text-foreground text-xl tabular-nums tracking-tight">
			{props.value}
		</span>
		<span className="text-muted-foreground text-xs">{props.label}</span>
		{props.hint ? (
			<span className="text-[11px] text-muted-foreground/70">{props.hint}</span>
		) : null}
	</div>
);

const UiKeyValue: SpecComponent<"KeyValue"> = ({ props }) => (
	<dl className="divide-y divide-border/60">
		{props.pairs.map((pair, index) => (
			// eslint-disable-next-line react/no-array-index-key -- spec order is stable
			<div key={index} className="flex items-baseline gap-3 py-1.5 text-sm">
				<dt className="min-w-0 flex-1 truncate text-muted-foreground">
					{pair.key}
				</dt>
				<dd className="min-w-0 flex-1 break-words text-right text-foreground/90 tabular-nums">
					{pair.value}
				</dd>
			</div>
		))}
	</dl>
);

const UiTable: SpecComponent<"Table"> = ({ props }) => (
	<Table>
		<TableHeader>
			<TableRow>
				{props.columns.map((column, index) => (
					// eslint-disable-next-line react/no-array-index-key -- spec order is stable
					<TableHead key={index} className="h-7 text-[11px]">
						{column}
					</TableHead>
				))}
			</TableRow>
		</TableHeader>
		<TableBody>
			{props.rows.map((row, rowIndex) => (
				// eslint-disable-next-line react/no-array-index-key -- spec order is stable
				<TableRow key={rowIndex}>
					{row.map((cell, cellIndex) => (
						// eslint-disable-next-line react/no-array-index-key -- spec order is stable
						<TableCell key={cellIndex} className="h-7">
							{cell}
						</TableCell>
					))}
				</TableRow>
			))}
		</TableBody>
	</Table>
);

const UiProgress: SpecComponent<"Progress"> = ({ props }) => {
	const percent = Math.min(100, Math.max(0, props.percent));
	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between gap-2 text-sm">
				<span className="truncate text-foreground/90">{props.label}</span>
				<span className="text-muted-foreground text-xs tabular-nums">
					{Math.round(percent)}%
				</span>
			</div>
			<div
				role="progressbar"
				aria-label={props.label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className="h-full rounded-full bg-primary transition-[width]"
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
};

const BADGE_VARIANTS = {
	neutral: "outline",
	good: "success",
	warn: "warning",
	bad: "error",
} as const;

const UiBadge: SpecComponent<"Badge"> = ({ props }) => (
	<Badge
		variant={BADGE_VARIANTS[props.tone ?? "neutral"]}
		size="sm"
		className="self-start justify-self-start font-medium"
	>
		{props.label}
	</Badge>
);

const UiList: SpecComponent<"List"> = ({ props }) => (
	<ul className="list-disc space-y-1 ps-5 text-foreground/90 text-sm leading-6 marker:text-muted-foreground">
		{props.items.map((item, index) => (
			// eslint-disable-next-line react/no-array-index-key -- spec order is stable
			<li key={index}>{item}</li>
		))}
	</ul>
);

const UiGrid: SpecComponent<"Grid"> = ({ props, renderNode }) => (
	<div
		className="grid min-w-0 gap-x-6 gap-y-4"
		style={{
			gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(9rem, calc((100% - ${(props.columns ?? 2) - 1} * 1.5rem) / ${props.columns ?? 2}))), 1fr))`,
		}}
	>
		{renderChildren(renderNode, props.children)}
	</div>
);

const chartValue = (value: number, unit?: string) =>
	`${value}${unit ? ` ${unit}` : ""}`;

const UiBarChart: SpecComponent<"BarChart"> = ({ props }) => {
	// Normalize before subtracting to avoid overflow for large finite numbers.
	const scale =
		Math.max(...props.points.map((point) => Math.abs(point.value))) || 1;
	const low = Math.min(0, ...props.points.map((point) => point.value / scale));
	const high = Math.max(0, ...props.points.map((point) => point.value / scale));
	const span = high - low || 1;
	const zero = (-low / span) * 100;
	return (
		<figure className="min-w-0 space-y-3">
			<figcaption className="font-medium text-sm">{props.title}</figcaption>
			<dl className="space-y-2.5">
				{props.points.map((point, index) => (
					// eslint-disable-next-line react/no-array-index-key -- spec order is stable
					<div key={index} className="space-y-1">
						<div className="flex justify-between gap-3 text-xs">
							<dt className="min-w-0 break-words text-muted-foreground">
								{point.label}
							</dt>
							<dd className="shrink-0 tabular-nums">
								{chartValue(point.value, props.unit)}
							</dd>
						</div>
						<div
							aria-hidden="true"
							className="relative h-1.5 rounded-full bg-muted"
						>
							<div
								className="absolute inset-y-0 w-px bg-foreground/30"
								style={{ left: `${zero}%` }}
							/>
							<div
								className="absolute inset-y-0 rounded-full bg-primary/80"
								style={{
									left: `${Math.min(zero, ((point.value / scale - low) / span) * 100)}%`,
									width: `${(Math.abs(point.value / scale) / span) * 100}%`,
								}}
							/>
						</div>
					</div>
				))}
			</dl>
		</figure>
	);
};

const UiLineChart: SpecComponent<"LineChart"> = ({ props }) => {
	const config = useMemo(
		() => ({ value: { color: "blue" as const, label: props.title } }),
		[props.title],
	);
	return (
		<figure className="min-w-0 space-y-2">
			<figcaption className="font-medium text-sm">{props.title}</figcaption>
			<LineChart
				data={props.points}
				config={config}
				animate={false}
				className="h-44 w-full"
			>
				<Grid />
				<Line dataKey="value" />
				<XAxis dataKey="label" maxTicks={4} />
				<YAxis />
				<Tooltip
					labelKey="label"
					valueFormatter={(value) => chartValue(value, props.unit)}
				/>
			</LineChart>
			<dl className="sr-only">
				{props.points.map((point, index) => (
					// eslint-disable-next-line react/no-array-index-key -- spec order is stable
					<div key={index}>
						<dt>{point.label}</dt>
						<dd>{chartValue(point.value, props.unit)}</dd>
					</div>
				))}
			</dl>
		</figure>
	);
};

const CALLOUT_ACCENT = {
	neutral: "border-border",
	good: "border-success",
	warn: "border-warning",
	bad: "border-destructive",
} as const;

const UiCallout: SpecComponent<"Callout"> = ({ props }) => (
	<aside
		className={cn(
			"border-s-2 ps-3 text-sm leading-6",
			CALLOUT_ACCENT[props.tone ?? "neutral"],
		)}
	>
		{props.title ? (
			<p className="font-medium text-foreground">{props.title}</p>
		) : null}
		<p className="whitespace-pre-wrap break-words text-foreground/80">
			{props.text}
		</p>
	</aside>
);

const STEP_MARKERS = {
	done: <Check aria-hidden className="size-3.5 text-success" />,
	active: (
		<span
			aria-hidden
			className="size-2 animate-pulse rounded-full bg-primary"
		/>
	),
	pending: <Circle aria-hidden className="size-3 text-muted-foreground/60" />,
	failed: <X aria-hidden className="size-3.5 text-destructive" />,
} as const;

const UiSteps: SpecComponent<"Steps"> = ({ props }) => (
	<ol className="space-y-1.5 text-sm">
		{props.items.map((item, index) => (
			// eslint-disable-next-line react/no-array-index-key -- spec order is stable
			<li key={index} className="flex gap-2.5" data-status={item.status}>
				<span className="mt-1 grid size-4 shrink-0 place-items-center">
					{STEP_MARKERS[item.status]}
				</span>
				<span className="min-w-0">
					<span
						className={cn(
							"leading-6",
							item.status === "pending"
								? "text-muted-foreground"
								: "text-foreground/90",
							item.status === "active" && "font-medium text-foreground",
						)}
					>
						{item.label}
					</span>
					{item.detail ? (
						<span className="block text-muted-foreground text-xs leading-5">
							{item.detail}
						</span>
					) : null}
				</span>
			</li>
		))}
	</ol>
);

const UiTabs: SpecComponent<"Tabs"> = ({ props, renderNode }) => {
	const [active, setActive] = useState("0");
	const index = Number(active);
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<SegmentedTabs
				value={active}
				onValueChange={setActive}
				ariaLabel={props.tabs.map((tab) => tab.label).join(", ")}
				equalWidth={false}
				className="self-start"
				options={props.tabs.map((tab, tabIndex) => ({
					value: String(tabIndex),
					label: tab.label,
				}))}
			/>
			<div role="tabpanel" className="min-w-0">
				{renderNode(props.tabs[index]?.content)}
			</div>
		</div>
	);
};

const UiFollowUps: SpecComponent<"FollowUps"> = ({ props }) => {
	const triggerAction = useTriggerAction();
	const { disabled } = useInteractive();
	const [chosen, setChosen] = useState<number | null>(null);
	return (
		<div className="flex min-w-0 flex-wrap gap-1.5">
			{props.items.map((item, index) => (
				<Button
					// eslint-disable-next-line react/no-array-index-key -- spec order is stable
					key={index}
					variant="outline"
					disabled={disabled}
					title={item.prompt}
					className="h-7 max-w-full px-2.5"
					onClick={() => {
						setChosen(index);
						void triggerAction(item.prompt);
					}}
				>
					{chosen === index && disabled ? <Check aria-hidden /> : null}
					<span className="truncate">{item.label}</span>
				</Button>
			))}
		</div>
	);
};

type FieldValue = string | number | boolean;

interface FieldDefinition {
	readonly name: string;
	readonly label: string;
	readonly initial: FieldValue;
}

const isElementNode = (value: unknown): value is ElementNode =>
	value !== null &&
	typeof value === "object" &&
	"type" in value &&
	value.type === "element";

const initialFieldValue = (element: ElementNode): FieldValue => {
	const props = element.props as Record<string, unknown>;
	switch (element.typeName) {
		case "Checkbox":
			return props.checked === true;
		case "Slider":
			return typeof props.value === "number"
				? props.value
				: (props.min as number);
		default:
			return typeof props.value === "string" ? props.value : "";
	}
};

/** Fields in document order, including ones nested in Cards, Grids, or Tabs. */
const collectFields = (nodes: ReadonlyArray<unknown>): FieldDefinition[] =>
	nodes.flatMap((node): FieldDefinition[] => {
		if (!isElementNode(node)) return [];
		const props = node.props as Record<string, unknown>;
		if (
			GENERATIVE_UI_FIELD_COMPONENTS.has(
				node.typeName as GenerativeUiComponentName,
			)
		)
			return [
				{
					name: props.name as string,
					label: props.label as string,
					initial: initialFieldValue(node),
				},
			];
		if (Array.isArray(props.children)) return collectFields(props.children);
		if (Array.isArray(props.tabs))
			return collectFields(
				props.tabs.map((tab: { readonly content?: unknown }) => tab.content),
			);
		return [];
	});

const FormFields = createContext<{
	readonly values: Readonly<Record<string, FieldValue>>;
	readonly setValue: (name: string, value: FieldValue) => void;
} | null>(null);

const useField = <Value extends FieldValue>(name: string, fallback: Value) => {
	const form = useContext(FormFields);
	const { disabled } = useInteractive();
	const value = form?.values[name];
	return {
		value: (typeof value === typeof fallback ? value : fallback) as Value,
		setValue: (next: Value) => form?.setValue(name, next),
		disabled,
	};
};

const FieldLabel = ({
	htmlFor,
	children,
}: {
	readonly htmlFor?: string;
	readonly children: ReactNode;
}) => (
	<label htmlFor={htmlFor} className="text-muted-foreground text-xs">
		{children}
	</label>
);

const UiForm: SpecComponent<"Form"> = ({ props, renderNode }) => {
	const { message: uiMessage } = useMessages(["chat"]);
	const triggerAction = useTriggerAction();
	const { disabled, sent } = useInteractive();
	const fields = useMemo(() => collectFields(props.children), [props.children]);
	const [values, setValues] = useState<Record<string, FieldValue>>(() =>
		Object.fromEntries(fields.map((field) => [field.name, field.initial])),
	);
	const context = useMemo(
		() => ({
			values,
			setValue: (name: string, value: FieldValue) =>
				setValues((current) => ({ ...current, [name]: value })),
		}),
		[values],
	);
	const format = (value: FieldValue) =>
		typeof value === "boolean"
			? uiMessage(
					value
						? "chat:message_row_ui_spec_yes"
						: "chat:message_row_ui_spec_no",
				)
			: String(value).trim() || "—";
	const submit = () => {
		const heading = props.title ?? props.submitLabel;
		const answers = fields.map((field) => {
			// "Anything else?" reads better without a trailing colon.
			const label = /[?:]$/.test(field.label) ? field.label : `${field.label}:`;
			return `- ${label} ${format(values[field.name] ?? field.initial)}`;
		});
		void triggerAction([...(heading ? [heading] : []), ...answers].join("\n"));
	};
	return (
		<form
			className="flex min-w-0 max-w-lg flex-col gap-3.5"
			onSubmit={(event) => {
				event.preventDefault();
				if (!disabled) submit();
			}}
		>
			{props.title ? (
				<h3 className="font-semibold text-foreground text-sm">{props.title}</h3>
			) : null}
			<FormFields.Provider value={context}>
				{renderChildren(renderNode, props.children)}
			</FormFields.Provider>
			<Button type="submit" disabled={disabled} className="h-7 self-start">
				{sent ? <Check aria-hidden /> : null}
				{sent
					? uiMessage("chat:message_row_ui_spec_sent")
					: (props.submitLabel ?? uiMessage("chat:message_row_ui_spec_submit"))}
			</Button>
		</form>
	);
};

const UiInput: SpecComponent<"Input"> = ({ props }) => {
	const field = useField<string>(props.name, "");
	const id = useId();
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<FieldLabel htmlFor={id}>{props.label}</FieldLabel>
			<Input
				id={id}
				className="h-7"
				placeholder={props.placeholder}
				value={field.value}
				disabled={field.disabled}
				onChange={(event) => field.setValue(event.currentTarget.value)}
			/>
		</div>
	);
};

const UiTextArea: SpecComponent<"TextArea"> = ({ props }) => {
	const field = useField<string>(props.name, "");
	const id = useId();
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<FieldLabel htmlFor={id}>{props.label}</FieldLabel>
			<Textarea
				id={id}
				placeholder={props.placeholder}
				value={field.value}
				disabled={field.disabled}
				onChange={(event) => field.setValue(event.currentTarget.value)}
			/>
		</div>
	);
};

const UiSelect: SpecComponent<"Select"> = ({ props }) => {
	const field = useField<string>(props.name, "");
	const items = useMemo(
		() => props.options.map((option) => ({ value: option, label: option })),
		[props.options],
	);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<FieldLabel>{props.label}</FieldLabel>
			<Select
				items={items}
				value={field.value === "" ? null : field.value}
				disabled={field.disabled}
				onValueChange={(value) => {
					if (typeof value === "string") field.setValue(value);
				}}
			>
				<SelectTrigger className="h-7 self-start" aria-label={props.label}>
					<SelectValue />
				</SelectTrigger>
				<SelectPopup>
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectPopup>
			</Select>
		</div>
	);
};

const UiRadioGroup: SpecComponent<"RadioGroup"> = ({ props }) => {
	const field = useField<string>(props.name, "");
	return (
		<fieldset className="flex min-w-0 flex-col gap-1.5">
			<legend className="mb-1.5 text-muted-foreground text-xs">
				{props.label}
			</legend>
			<div
				role="radiogroup"
				aria-label={props.label}
				className="flex flex-wrap gap-1.5"
			>
				{props.options.map((option) => {
					const selected = field.value === option;
					return (
						<Button
							key={option}
							type="button"
							role="radio"
							aria-checked={selected}
							variant="outline"
							disabled={field.disabled}
							onClick={() => field.setValue(option)}
							className={cn(
								"h-7 px-2.5",
								selected &&
									"border-primary bg-primary/15 text-foreground hover:bg-primary/20",
							)}
						>
							{selected ? <Check aria-hidden /> : null}
							{option}
						</Button>
					);
				})}
			</div>
		</fieldset>
	);
};

const UiCheckbox: SpecComponent<"Checkbox"> = ({ props }) => {
	const field = useField<boolean>(props.name, false);
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the checkbox is the nested control
		<label className="flex items-center gap-2 text-foreground/90 text-sm">
			<Checkbox
				checked={field.value}
				disabled={field.disabled}
				onCheckedChange={(checked) => field.setValue(checked === true)}
			/>
			{props.label}
		</label>
	);
};

const UiSlider: SpecComponent<"Slider"> = ({ props }) => {
	const field = useField(props.name, props.min);
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex items-baseline justify-between gap-2">
				<FieldLabel>{props.label}</FieldLabel>
				<span className="text-foreground text-xs tabular-nums">
					{field.value}
				</span>
			</div>
			<Slider
				aria-label={props.label}
				min={props.min}
				max={props.max}
				step={props.step ?? 1}
				value={field.value}
				disabled={field.disabled}
				onValueChange={(value) =>
					field.setValue(Array.isArray(value) ? (value[0] ?? props.min) : value)
				}
			/>
		</div>
	);
};

/** Exhaustive mapping: adding a catalogue component requires a renderer. */
const components: { [Name in GenerativeUiComponentName]: SpecComponent<Name> } =
	{
		Card: UiCard,
		Text: UiText,
		Stat: UiStat,
		KeyValue: UiKeyValue,
		Table: UiTable,
		Progress: UiProgress,
		Badge: UiBadge,
		List: UiList,
		Grid: UiGrid,
		BarChart: UiBarChart,
		LineChart: UiLineChart,
		Callout: UiCallout,
		Steps: UiSteps,
		Tabs: UiTabs,
		FollowUps: UiFollowUps,
		Form: UiForm,
		Input: UiInput,
		TextArea: UiTextArea,
		Select: UiSelect,
		RadioGroup: UiRadioGroup,
		Checkbox: UiCheckbox,
		Slider: UiSlider,
	};

function defineUiComponent<Name extends GenerativeUiComponentName>(name: Name) {
	const spec = generativeUiComponents[name];
	return defineComponent({
		name,
		description: spec.description,
		props: spec.props,
		component: components[name] as SpecComponent<GenerativeUiComponentName>,
	});
}

/** Built once — schemas, signatures, and renderers use the same catalogue. */
const generativeUiLibrary = createLibrary({
	root: "Card",
	components: (Object.keys(components) as GenerativeUiComponentName[]).map(
		defineUiComponent,
	),
});

export function UiSpecBlock({
	spec,
	sessionRef,
}: {
	readonly spec: string;
	/** Session that receives responses; omit when the block is read-only. */
	readonly sessionRef?: SessionRef;
}) {
	const { message: uiMessage } = useMessages(["chat"]);
	const [sent, setSent] = useState(false);
	const onAction = useCallback(
		(event: ActionEvent) => {
			if (
				sessionRef === undefined ||
				sent ||
				event.type !== BuiltinActionType.ContinueConversation
			)
				return;
			if (sendThroughCurrentComposer(event.humanFriendlyMessage, sessionRef)) {
				setSent(true);
				return;
			}
			toastManager.add({
				type: "error",
				title: uiMessage("chat:message_row_ui_spec_send_failed"),
				description: uiMessage("chat:message_row_ui_spec_send_open_chat"),
			});
		},
		[sent, sessionRef, uiMessage],
	);
	const interaction = useMemo(
		() => ({ enabled: sessionRef !== undefined, sent }),
		[sessionRef, sent],
	);
	// Re-validated at render time so a malformed or outdated persisted row
	// degrades to the raw-spec fallback instead of a blank block.
	const validation = useMemo(() => validateGenerativeUiSpec(spec), [spec]);
	return (
		<section
			className="min-w-0"
			aria-label={uiMessage("chat:message_row_ui_spec_generated")}
		>
			{validation.ok ? (
				<ErrorBoundary
					resetKey={spec}
					fallback={<UiSpecFallback spec={spec} reason="" />}
				>
					<UiInteraction.Provider value={interaction}>
						<Renderer
							response={spec}
							library={generativeUiLibrary}
							onAction={onAction}
							publishObservability={false}
						/>
					</UiInteraction.Provider>
				</ErrorBoundary>
			) : (
				<UiSpecFallback spec={spec} reason={validation.error} />
			)}
		</section>
	);
}
