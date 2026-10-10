import {
	type ActionEvent,
	BuiltinActionType,
	type ComponentRenderProps,
	createLibrary,
	defineComponent,
	Renderer,
	useTriggerAction,
} from "@openuidev/react-lang";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import "@zuse/i18n/english/chat";
import { useMessages } from "@zuse/i18n/react";
import {
	type GenerativeUiComponentName,
	generativeUiComponents,
	validateGenerativeUiSpec,
} from "@zuse/utils/generative-ui";
import {
	createContext,
	Fragment,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import type { z } from "zod";
import { insertIntoCurrentComposer } from "~/lib/context-handoff";
import { cn } from "~/lib/utils";
import { Line } from "./dither-kit/area.tsx";
import { LineChart } from "./dither-kit/area-chart.tsx";
import { Grid } from "./dither-kit/grid.tsx";
import { Tooltip } from "./dither-kit/tooltip.tsx";
import { XAxis } from "./dither-kit/x-axis.tsx";
import { YAxis } from "./dither-kit/y-axis.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardHeader, CardPanel, CardTitle } from "./ui/card.tsx";
import { ErrorBoundary } from "./ui/error-boundary.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table.tsx";
import { toastManager } from "./ui/toast.tsx";
import { UiSpecFallback } from "./ui-spec-fallback.tsx";

/**
 * Renders a persisted `ui_spec` message — an OpenUI Lang block emitted by the
 * agent via the `emit_ui` orchestration tool. The component catalogue is
 * defined once in `@zuse/utils/generative-ui` and mapped here onto the
 * renderer's own `ui/` primitives so generated blocks look native.
 *
 * Display-only by construction: no `toolProvider` or `onStateUpdate` is
 * passed to `Renderer`, and the server-side validator rejects Query(),
 * Mutation(), reactive state, and action expressions. The single interaction
 * is OpenUI's built-in `continue_conversation` action, raised by FollowUps:
 * it places the prompt in this session's composer and never sends it.
 */

type SpecProps<Name extends GenerativeUiComponentName> = z.infer<
	(typeof generativeUiComponents)[Name]["props"]
>;

type SpecComponent<Name extends GenerativeUiComponentName> = (
	renderProps: ComponentRenderProps<SpecProps<Name>>,
) => ReactNode;

const renderChildren = (
	renderNode: (value: unknown) => ReactNode,
	children: ReadonlyArray<unknown> | undefined,
) =>
	(children ?? []).map((child, index) => (
		// eslint-disable-next-line react/no-array-index-key -- spec order is stable
		<Fragment key={index}>{renderNode(child)}</Fragment>
	));

const UiCard: SpecComponent<"Card"> = ({ props, renderNode }) => (
	<Card className="min-w-0 gap-2 overflow-hidden border-0 bg-muted/30 before:hidden">
		{props.title ? (
			<CardHeader className="px-3 pt-2.5 pb-0">
				<CardTitle className="text-xs font-medium text-muted-foreground">
					{props.title}
				</CardTitle>
			</CardHeader>
		) : null}
		<CardPanel
			className={cn("flex flex-col gap-2 px-3 py-2.5", props.title && "pt-0")}
		>
			{renderChildren(renderNode, props.children)}
		</CardPanel>
	</Card>
);

const UiText: SpecComponent<"Text"> = ({ props }) => (
	<p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground/90">
		{props.text}
	</p>
);

const UiStat: SpecComponent<"Stat"> = ({ props }) => (
	<div className="flex min-w-0 flex-col gap-0.5">
		<span className="truncate font-semibold text-base text-foreground tabular-nums">
			{props.value}
		</span>
		<span className="text-[11px] text-muted-foreground">{props.label}</span>
		{props.hint ? (
			<span className="text-[11px] text-muted-foreground/70">{props.hint}</span>
		) : null}
	</div>
);

const UiKeyValue: SpecComponent<"KeyValue"> = ({ props }) => (
	<dl className="space-y-0.5">
		{props.pairs.map((pair, index) => (
			// eslint-disable-next-line react/no-array-index-key -- spec order is stable
			<div key={index} className="flex items-baseline gap-3 text-xs">
				<dt className="min-w-0 flex-1 truncate text-muted-foreground">
					{pair.key}
				</dt>
				<dd className="min-w-0 flex-1 break-words text-right font-medium text-foreground/90 tabular-nums">
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
		<div className="space-y-1">
			<div className="flex items-baseline justify-between gap-2 text-xs">
				<span className="truncate text-foreground/90">{props.label}</span>
				<span className="text-muted-foreground tabular-nums">
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
		className="self-start font-medium"
	>
		{props.label}
	</Badge>
);

const UiList: SpecComponent<"List"> = ({ props }) => (
	<ul className="space-y-0.5 text-xs text-foreground/90">
		{props.items.map((item, index) => (
			// eslint-disable-next-line react/no-array-index-key -- spec order is stable
			<li key={index} className="flex gap-1.5">
				<span aria-hidden className="shrink-0 text-muted-foreground">
					•
				</span>
				<span className="min-w-0">{item}</span>
			</li>
		))}
	</ul>
);

const UiGrid: SpecComponent<"Grid"> = ({ props, renderNode }) => (
	<div
		className="grid min-w-0 gap-3"
		style={{
			gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(9rem, calc((100% - ${(props.columns ?? 2) - 1} * 0.75rem) / ${props.columns ?? 2}))), 1fr))`,
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
			<figcaption className="text-xs font-medium">{props.title}</figcaption>
			<dl className="space-y-2">
				{props.points.map((point, index) => (
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
							className="relative h-2 rounded-sm bg-muted"
						>
							<div
								className="absolute inset-y-0 w-px bg-foreground/30"
								style={{ left: `${zero}%` }}
							/>
							<div
								className="absolute inset-y-0 rounded-sm bg-primary/80"
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
			<figcaption className="text-xs font-medium">{props.title}</figcaption>
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
					<div key={index}>
						<dt>{point.label}</dt>
						<dd>{chartValue(point.value, props.unit)}</dd>
					</div>
				))}
			</dl>
		</figure>
	);
};

/** Whether FollowUps can reach this session's composer (false in read-only views). */
const FollowUpsEnabled = createContext(false);

const UiFollowUps: SpecComponent<"FollowUps"> = ({ props }) => {
	const triggerAction = useTriggerAction();
	const enabled = useContext(FollowUpsEnabled);
	return (
		<div className="flex min-w-0 flex-wrap gap-1.5">
			{props.items.map((item, index) => (
				<Button
					// eslint-disable-next-line react/no-array-index-key -- spec order is stable
					key={index}
					variant="subtle"
					disabled={!enabled}
					title={item.prompt}
					className="h-7 max-w-full px-2.5"
					onClick={() => void triggerAction(item.prompt)}
				>
					<span className="truncate">{item.label}</span>
				</Button>
			))}
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
		FollowUps: UiFollowUps,
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
	/** Composer target for FollowUps; omit in read-only transcripts. */
	readonly sessionRef?: SessionRef;
}) {
	const { message: uiMessage } = useMessages(["chat"]);
	const onAction = useCallback(
		(event: ActionEvent) => {
			if (
				sessionRef === undefined ||
				event.type !== BuiltinActionType.ContinueConversation
			)
				return;
			if (insertIntoCurrentComposer(event.humanFriendlyMessage, sessionRef))
				return;
			toastManager.add({
				type: "error",
				title: uiMessage("chat:message_row_ui_spec_follow_up_failed"),
				description: uiMessage("chat:message_row_ui_spec_follow_up_open_chat"),
			});
		},
		[sessionRef, uiMessage],
	);
	// Re-validated at render time so a malformed or outdated persisted row
	// degrades to the raw-spec card instead of a blank block.
	const validation = useMemo(() => validateGenerativeUiSpec(spec), [spec]);
	return (
		<section
			className="min-w-0 px-4 py-1.5"
			aria-label={uiMessage("chat:message_row_ui_spec_generated")}
		>
			{validation.ok ? (
				<ErrorBoundary
					resetKey={spec}
					fallback={<UiSpecFallback spec={spec} reason="" />}
				>
					<FollowUpsEnabled.Provider value={sessionRef !== undefined}>
						<Renderer
							response={spec}
							library={generativeUiLibrary}
							onAction={onAction}
							publishObservability={false}
						/>
					</FollowUpsEnabled.Provider>
				</ErrorBoundary>
			) : (
				<UiSpecFallback spec={spec} reason={validation.error} />
			)}
		</section>
	);
}
