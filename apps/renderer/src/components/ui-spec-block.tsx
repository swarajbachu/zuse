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
	prepareGenerativeUiSpec,
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
import { useUiSpecResponses } from "~/store/ui-spec-responses";
import { Line } from "./dither-kit/area.tsx";
import { LineChart } from "./dither-kit/area-chart.tsx";
import { Grid } from "./dither-kit/grid.tsx";
import { PALETTE, rgb } from "./dither-kit/palette.ts";
import { DONUT_COLORS, StaticDitherFill } from "./dither-kit/static-fill.tsx";
import { Tooltip } from "./dither-kit/tooltip.tsx";
import { XAxis } from "./dither-kit/x-axis.tsx";
import { YAxis } from "./dither-kit/y-axis.tsx";
import { FlowDiagram } from "./flow-diagram.tsx";
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

type SpecProps<Name extends GenerativeUiComponentName> = z.infer<
	(typeof generativeUiComponents)[Name]["props"]
>;

type SpecComponent<Name extends GenerativeUiComponentName> = (
	renderProps: ComponentRenderProps<SpecProps<Name>>,
) => ReactNode;

const UiInteraction = createContext<{
	readonly enabled: boolean;
	readonly status: "sending" | "sent" | undefined;
}>({ enabled: false, status: undefined });

const useInteractive = () => {
	const { enabled, status } = useContext(UiInteraction);
	return {
		disabled: !enabled || status !== undefined,
		sent: status === "sent",
	};
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
	<section className="flex min-w-0 flex-col gap-4">
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
	<div className="flex min-w-0 flex-col gap-1 rounded-xl bg-muted/40 px-4 py-3">
		<span className="break-words text-muted-foreground text-xs">
			{props.label}
		</span>
		<span className="break-words font-semibold text-foreground text-2xl tabular-nums tracking-tight">
			{props.value}
		</span>
		{props.hint ? (
			<span className="text-[11px] text-muted-foreground/70">{props.hint}</span>
		) : null}
	</div>
);

const UiKeyValue: SpecComponent<"KeyValue"> = ({ props }) => (
	<dl className="divide-y divide-border/40 rounded-xl bg-muted/25 px-3">
		{props.pairs.map((pair, index) => (
			// eslint-disable-next-line react/no-array-index-key -- spec order is stable
			<div
				key={index}
				className="flex items-baseline gap-3 py-2 text-xs leading-5"
			>
				<dt className="min-w-0 flex-1 break-words text-muted-foreground">
					{pair.key}
				</dt>
				<dd className="min-w-0 flex-1 break-words text-right text-foreground/90 tabular-nums">
					{pair.value}
				</dd>
			</div>
		))}
	</dl>
);

const UiTable: SpecComponent<"Table"> = ({ props }) => {
	const weights = props.columns.map((column, index) =>
		Math.min(
			48,
			Math.max(
				12,
				column.length,
				...props.rows.map((row) => (row[index] ?? "").length),
			),
		),
	);
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	return (
		<div className="@container min-w-0">
			<Table className="table-fixed overflow-hidden rounded-xl bg-muted/20">
				<colgroup className="@max-sm:hidden">
					{weights.map((weight, index) => (
						// eslint-disable-next-line react/no-array-index-key -- spec order is stable
						<col
							key={index}
							style={{ width: `${(weight / totalWeight) * 100}%` }}
						/>
					))}
				</colgroup>
				<TableHeader className="@max-sm:sr-only">
					<TableRow className="border-border/40 bg-muted/40">
						{props.columns.map((column, index) => (
							// eslint-disable-next-line react/no-array-index-key -- spec order is stable
							<TableHead
								key={index}
								scope="col"
								className="h-7 whitespace-normal break-words px-3 py-2 text-[11px] leading-4"
							>
								{column}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody className="@max-sm:block">
					{props.rows.map((row, rowIndex) => (
						// eslint-disable-next-line react/no-array-index-key -- spec order is stable
						<TableRow
							key={rowIndex}
							className="border-border/40 @max-sm:grid @max-sm:grid-cols-2 @max-sm:py-2"
						>
							{row.map((cell, cellIndex) => (
								// eslint-disable-next-line react/no-array-index-key -- spec order is stable
								<TableCell
									key={cellIndex}
									className={cn(
										"h-7 whitespace-normal break-words px-3 py-2 align-top text-xs leading-5 tabular-nums [overflow-wrap:anywhere] @max-sm:h-auto @max-sm:min-w-0",
										(cellIndex === 0 || cell.length > 40) &&
											"@max-sm:col-span-2",
										cellIndex === 0 && "font-medium text-foreground",
									)}
								>
									<span
										aria-hidden="true"
										className="hidden font-normal text-muted-foreground text-[11px] @max-sm:block"
									>
										{props.columns[cellIndex]}
									</span>
									{cell}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
};

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

const UiGrid: SpecComponent<"Grid"> = ({ props, renderNode }) => {
	const minimum = props.children.every(
		(child) =>
			isElementNode(child) &&
			["Stat", "Badge", "Progress"].includes(child.typeName),
	)
		? "9rem"
		: "16rem";
	return (
		<div
			className="grid min-w-0 gap-3"
			style={{
				gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(${minimum}, calc((100% - ${(props.columns ?? 2) - 1} * 0.75rem) / ${props.columns ?? 2}))), 1fr))`,
			}}
		>
			{renderChildren(renderNode, props.children)}
		</div>
	);
};

const chartValue = (value: number, unit?: string) =>
	`${value}${unit ? ` ${unit}` : ""}`;

const UiBarChart: SpecComponent<"BarChart"> = ({ props }) => {
	const scale =
		Math.max(...props.points.map((point) => Math.abs(point.value))) || 1;
	const low = Math.min(0, ...props.points.map((point) => point.value / scale));
	const high = Math.max(0, ...props.points.map((point) => point.value / scale));
	const span = high - low || 1;
	const zero = (-low / span) * 100;
	return (
		<figure className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
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
							className="relative h-4 overflow-hidden rounded-sm bg-muted"
						>
							<div
								className="absolute inset-y-0 w-px bg-foreground/30"
								style={{ left: `${zero}%` }}
							/>
							<StaticDitherFill
								shape="bar"
								color="green"
								start={
									Math.min(zero, ((point.value / scale - low) / span) * 100) /
									100
								}
								fraction={Math.abs(point.value / scale) / span}
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
		<figure className="min-w-0 space-y-2 rounded-xl bg-muted/30 p-4">
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

const compactNumber = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

const UiDonutChart: SpecComponent<"DonutChart"> = ({ props }) => {
	const total = props.points.reduce((sum, point) => sum + point.value, 0);
	const values = useMemo(
		() => props.points.map((point) => point.value),
		[props.points],
	);
	return (
		<figure className="min-w-0 space-y-4 rounded-xl bg-muted/30 p-4">
			<figcaption className="font-medium text-sm">{props.title}</figcaption>
			<div className="flex flex-wrap items-center gap-5">
				<div className="relative mx-auto size-36 shrink-0">
					<svg
						viewBox="0 0 120 120"
						aria-hidden="true"
						className="size-full -rotate-90"
					>
						<circle
							cx="60"
							cy="60"
							r="50"
							fill="none"
							strokeWidth="12"
							className={total === 0 ? "stroke-muted" : "stroke-transparent"}
						/>
					</svg>
					<StaticDitherFill shape="donut" values={values} />
					<div
						className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
						aria-hidden="true"
					>
						<span className="font-semibold text-xl tabular-nums tracking-tight">
							{compactNumber.format(total)}
						</span>
						{props.unit ? (
							<span className="text-muted-foreground text-xs">
								{props.unit}
							</span>
						) : null}
					</div>
				</div>
				<dl className="min-w-0 flex-1 basis-40 divide-y divide-border/40">
					{props.points.map((point, index) => (
						// eslint-disable-next-line react/no-array-index-key -- spec order is stable
						<div
							key={index}
							className="flex items-baseline gap-3 py-2 text-xs leading-5"
						>
							<dt className="flex min-w-0 flex-1 items-baseline gap-2 text-muted-foreground">
								<span
									aria-hidden="true"
									className="size-2 shrink-0 rounded-sm"
									style={{
										backgroundColor: rgb(
											PALETTE[
												DONUT_COLORS[index % DONUT_COLORS.length] ?? "blue"
											].fill,
										),
									}}
								/>
								<span className="break-words">{point.label}</span>
							</dt>
							<dd className="text-right tabular-nums">
								{chartValue(point.value, props.unit)}
								<span className="ms-3 text-muted-foreground">
									{" "}
									{total === 0 ? 0 : Math.round((point.value / total) * 100)}%
								</span>
							</dd>
						</div>
					))}
				</dl>
			</div>
		</figure>
	);
};

const CALLOUT_ACCENT = {
	neutral: "border-border bg-muted/30",
	good: "border-success bg-success/5",
	warn: "border-warning bg-warning/5",
	bad: "border-destructive bg-destructive/5",
} as const;

const UiCallout: SpecComponent<"Callout"> = ({ props }) => (
	<aside
		className={cn(
			"rounded-r-lg border-s-2 px-3 py-2.5 text-xs leading-5",
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
	<ol className="space-y-3 rounded-xl bg-muted/25 p-3 text-sm">
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

const UiFlow: SpecComponent<"Flow"> = ({ props }) => (
	<FlowDiagram nodes={props.nodes} caption={props.caption} />
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
		DonutChart: UiDonutChart,
		Callout: UiCallout,
		Steps: UiSteps,
		Flow: UiFlow,
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

const generativeUiLibrary = createLibrary({
	root: "Card",
	components: (Object.keys(components) as GenerativeUiComponentName[]).map(
		defineUiComponent,
	),
});

export function UiSpecBlock({
	spec,
	messageId,
	sessionRef,
}: {
	readonly spec: string;

	readonly messageId: string;

	readonly sessionRef?: SessionRef;
}) {
	const { message: uiMessage } = useMessages(["chat"]);
	const status = useUiSpecResponses((state) => state.byMessageId[messageId]);
	const onAction = useCallback(
		async (event: ActionEvent) => {
			if (
				sessionRef === undefined ||
				event.type !== BuiltinActionType.ContinueConversation
			)
				return;
			const responses = useUiSpecResponses.getState();
			if (!responses.begin(messageId)) return;
			const accepted = await sendThroughCurrentComposer(
				event.humanFriendlyMessage,
				sessionRef,
			).catch(() => false);
			responses.settle(messageId, accepted);
			if (accepted) return;
			toastManager.add({
				type: "error",
				title: uiMessage("chat:message_row_ui_spec_send_failed"),
				description: uiMessage("chat:message_row_ui_spec_send_open_chat"),
			});
		},
		[messageId, sessionRef, uiMessage],
	);
	const interaction = useMemo(
		() => ({ enabled: sessionRef !== undefined, status }),
		[sessionRef, status],
	);

	const validation = useMemo(() => prepareGenerativeUiSpec(spec), [spec]);
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
							response={validation.spec}
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
