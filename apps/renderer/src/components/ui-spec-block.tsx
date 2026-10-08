import {
	type ComponentRenderProps,
	createLibrary,
	defineComponent,
	Renderer,
} from "@openuidev/react-lang";
import "@zuse/i18n/english/chat";
import { useMessages } from "@zuse/i18n/react";
import {
	type GenerativeUiComponentName,
	generativeUiComponents,
	validateGenerativeUiSpec,
} from "@zuse/utils/generative-ui";
import { Fragment, useMemo } from "react";
import type { z } from "zod";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge.tsx";
import { Card, CardHeader, CardPanel, CardTitle } from "./ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table.tsx";

/**
 * Renders a persisted `ui_spec` message — an OpenUI Lang block emitted by the
 * agent via the `emit_ui` orchestration tool. The component catalogue is
 * defined once in `@zuse/utils/generative-ui` and mapped here onto the
 * renderer's own `ui/` primitives so generated blocks look native.
 *
 * Read-only by construction: no `onAction`/`onStateUpdate` handlers and no
 * `toolProvider` are passed to `Renderer`, so `Query()`, `Mutation()`, and
 * `@Set`-style action statements have nothing to call. Interactive or
 * action-carrying UI is out of scope for v1 — and the server-side validator
 * already rejects specs that contain Query()/Mutation() statements.
 */

type SpecProps<Name extends GenerativeUiComponentName> = z.infer<
	(typeof generativeUiComponents)[Name]["props"]
>;

type SpecComponent<Name extends GenerativeUiComponentName> = (
	renderProps: ComponentRenderProps<SpecProps<Name>>,
) => React.ReactNode;

const renderChildren = (
	renderNode: (value: unknown) => React.ReactNode,
	children: ReadonlyArray<unknown> | undefined,
) =>
	(children ?? []).map((child, index) => (
		// eslint-disable-next-line react/no-array-index-key -- spec order is stable
		<Fragment key={index}>{renderNode(child)}</Fragment>
	));

const UiCard: SpecComponent<"Card"> = ({ props, renderNode }) => (
	<Card className="gap-2 overflow-hidden border-border/60">
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
	<p className="whitespace-pre-wrap text-sm leading-5 text-foreground/90">
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
				<dd className="shrink-0 font-medium text-foreground/90 tabular-nums">
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
			<div className="h-1.5 overflow-hidden rounded-full bg-muted">
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
		className="font-medium"
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

/** Built once — the catalogue is static. */
const generativeUiLibrary = createLibrary({
	root: "Card",
	components: [
		defineComponent({
			name: "Card",
			description: generativeUiComponents.Card.description,
			props: generativeUiComponents.Card.props,
			component: UiCard,
		}),
		defineComponent({
			name: "Text",
			description: generativeUiComponents.Text.description,
			props: generativeUiComponents.Text.props,
			component: UiText,
		}),
		defineComponent({
			name: "Stat",
			description: generativeUiComponents.Stat.description,
			props: generativeUiComponents.Stat.props,
			component: UiStat,
		}),
		defineComponent({
			name: "KeyValue",
			description: generativeUiComponents.KeyValue.description,
			props: generativeUiComponents.KeyValue.props,
			component: UiKeyValue,
		}),
		defineComponent({
			name: "Table",
			description: generativeUiComponents.Table.description,
			props: generativeUiComponents.Table.props,
			component: UiTable,
		}),
		defineComponent({
			name: "Progress",
			description: generativeUiComponents.Progress.description,
			props: generativeUiComponents.Progress.props,
			component: UiProgress,
		}),
		defineComponent({
			name: "Badge",
			description: generativeUiComponents.Badge.description,
			props: generativeUiComponents.Badge.props,
			component: UiBadge,
		}),
		defineComponent({
			name: "List",
			description: generativeUiComponents.List.description,
			props: generativeUiComponents.List.props,
			component: UiList,
		}),
	],
});

/**
 * Last-resort surface for specs that no longer parse — older persisted rows,
 * a library/component drift, or a spec written before validation existed.
 * Never renders blank: the raw spec stays inspectable.
 */
function UiSpecFallback({
	spec,
	reason,
}: {
	readonly spec: string;
	readonly reason: string;
}) {
	const { message: uiMessage } = useMessages(["chat"]);
	return (
		<div
			className="rounded-lg border border-border/50 border-dashed bg-muted/30 px-3 py-2"
			role="note"
		>
			<div className="text-[11px] font-medium text-muted-foreground">
				{uiMessage("chat:message_row_ui_spec_could_not_render")}
			</div>
			{reason.length > 0 ? (
				<div className="mt-0.5 text-[11px] text-muted-foreground/80">
					{reason}
				</div>
			) : null}
			<pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-muted-foreground/80">
				{spec}
			</pre>
		</div>
	);
}

export function UiSpecBlock({ spec }: { readonly spec: string }) {
	const { message: uiMessage } = useMessages(["chat"]);
	// Re-validated at render time so a malformed or outdated persisted row
	// degrades to the raw-spec card instead of a blank block.
	const validation = useMemo(() => validateGenerativeUiSpec(spec), [spec]);
	return (
		<div
			className="px-4 py-1.5"
			role="status"
			aria-label={uiMessage("chat:message_row_ui_spec_generated")}
		>
			{validation.ok ? (
				<Renderer response={spec} library={generativeUiLibrary} />
			) : (
				<UiSpecFallback spec={spec} reason={validation.error} />
			)}
		</div>
	);
}
