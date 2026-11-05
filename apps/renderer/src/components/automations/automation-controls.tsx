import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	Alert02Icon,
	Calendar03Icon,
	Cursor01Icon,
	InformationCircleIcon,
	PackageIcon,
	SecurityCheckIcon,
	WebhookIcon,
} from "@zuse/icons/solid-rounded";
import type { ReactNode } from "react";
import type { AutomationTriggerKind } from "~/lib/automation-format.ts";
import { cn } from "~/lib/utils";
import { GitHubIcon } from "../icons/github-icon.tsx";
import { SlackIcon } from "../icons/slack-icon.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";

/** Number fields without the native stepper arrows. */
export const numberInputClass =
	"[&_input]:[appearance:textfield] [&_input::-webkit-inner-spin-button]:appearance-none [&_input::-webkit-outer-spin-button]:appearance-none";

const TRIGGER_ICON: Readonly<
	Record<Exclude<AutomationTriggerKind, "github" | "slack">, IconSvgElement>
> = {
	schedule: Calendar03Icon,
	webhook: WebhookIcon,
	security_scan: SecurityCheckIcon,
	snapshot_build: PackageIcon,
	manual: Cursor01Icon,
};

/** Trigger glyph; integrations use their own brand marks. */
export function TriggerIcon({
	kind,
	className,
}: {
	kind: AutomationTriggerKind;
	className?: string;
}) {
	if (kind === "github")
		return <GitHubIcon className={cn("text-foreground", className)} />;
	if (kind === "slack") return <SlackIcon className={className} />;
	return (
		<HugeiconsIcon
			icon={TRIGGER_ICON[kind]}
			className={className}
			aria-hidden
		/>
	);
}

export function AutomationSection({
	id,
	title,
	action,
	children,
}: {
	id?: string;
	title: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-labelledby={id} className="space-y-2">
			<div className="flex min-h-7 items-center justify-between gap-3">
				<h3 id={id} className="text-xs font-medium text-muted-foreground">
					{title}
				</h3>
				{action && <div className="flex shrink-0 gap-1">{action}</div>}
			</div>
			{children}
		</section>
	);
}

/** Label and hint on the left, a compact control on the right. */
export function AutomationRow({
	label,
	hint,
	htmlFor,
	children,
	className,
}: {
	label: string;
	hint?: ReactNode;
	htmlFor?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-7 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
				className,
			)}
		>
			<div className="min-w-0">
				<label htmlFor={htmlFor} className="block text-xs">
					{label}
				</label>
				{hint && (
					<div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
						{hint}
					</div>
				)}
			</div>
			<div className="flex w-full shrink-0 items-center gap-1.5 sm:w-56 sm:justify-end">
				{children}
			</div>
		</div>
	);
}

/** Stacked label for wide controls such as text areas and lists. */
export function AutomationField({
	label,
	hint,
	htmlFor,
	children,
	className,
}: {
	label: string;
	hint?: ReactNode;
	htmlFor?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
			<label htmlFor={htmlFor} className="text-[11px] text-muted-foreground">
				{label}
			</label>
			{children}
			{hint && (
				<div className="text-[11px] leading-4 text-muted-foreground">
					{hint}
				</div>
			)}
		</div>
	);
}

export interface AutomationOption<Value extends string> {
	readonly value: Value;
	readonly label: string;
	readonly description?: string;
	readonly disabled?: boolean;
	readonly icon?: ReactNode;
}

export function AutomationSelect<Value extends string>({
	id,
	label,
	value,
	options,
	onChange,
	disabled,
	className,
}: {
	id?: string;
	label: string;
	value: Value;
	options: ReadonlyArray<AutomationOption<Value>>;
	onChange: (value: Value) => void;
	disabled?: boolean;
	className?: string;
}) {
	const items = options.map((option) => ({
		value: option.value,
		label: option.label,
	}));
	const selected = options.find((option) => option.value === value);
	return (
		<Select
			value={value}
			items={items}
			disabled={disabled}
			onValueChange={(next) => {
				const match = options.find((option) => option.value === next);
				if (match) onChange(match.value);
			}}
		>
			<SelectTrigger
				id={id}
				aria-label={label}
				className={cn("h-7 w-full min-w-0", className)}
			>
				{selected?.icon}
				<SelectValue />
			</SelectTrigger>
			<SelectPopup>
				{options.map((option) => (
					<SelectItem
						key={option.value}
						value={option.value}
						disabled={option.disabled}
						className={option.description ? "items-start py-1" : undefined}
					>
						<span className="flex min-w-0 items-center gap-1.5">
							{option.icon}
							<span className="truncate">{option.label}</span>
						</span>
						{option.description && (
							<span className="block max-w-72 whitespace-normal text-[11px] leading-4 text-muted-foreground">
								{option.description}
							</span>
						)}
					</SelectItem>
				))}
			</SelectPopup>
		</Select>
	);
}

/** Dropdown with checkable options; the trigger lists the chosen labels. */
export function AutomationMultiSelect<Value extends string>({
	id,
	label,
	options,
	values,
	onChange,
	placeholder = "Choose…",
}: {
	id?: string;
	label: string;
	options: ReadonlyArray<readonly [Value, string]>;
	values: ReadonlyArray<Value>;
	onChange: (values: Value[]) => void;
	placeholder?: string;
}) {
	const chosen = options
		.filter(([value]) => values.includes(value))
		.map(([, name]) => name);
	return (
		<Select
			multiple
			value={[...values]}
			onValueChange={(next) =>
				onChange(
					options
						.map(([value]) => value)
						.filter((value) => next.includes(value)),
				)
			}
		>
			<SelectTrigger id={id} aria-label={label} className="h-7 w-full min-w-0">
				<span
					className={cn(
						"flex-1 truncate",
						chosen.length === 0 && "text-muted-foreground",
					)}
				>
					{chosen.length ? chosen.join(", ") : placeholder}
				</span>
			</SelectTrigger>
			<SelectPopup>
				{options.map(([value, name]) => (
					<SelectItem key={value} value={value}>
						{name}
					</SelectItem>
				))}
			</SelectPopup>
		</Select>
	);
}

export function AutomationNotice({
	tone = "info",
	children,
	action,
	className,
}: {
	tone?: "info" | "warning" | "error";
	children: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			role={tone === "error" ? "alert" : undefined}
			data-slot={tone === "info" ? undefined : "automation-notice"}
			className={cn(
				"flex items-start gap-2 rounded-md px-2.5 py-2 text-[11px] leading-4",
				tone === "info" && "bg-muted/45 text-muted-foreground",
				tone === "warning" && "bg-alert-warning-bg text-foreground",
				tone === "error" && "bg-alert-error-bg text-foreground",
				className,
			)}
		>
			<HugeiconsIcon
				icon={tone === "info" ? InformationCircleIcon : Alert02Icon}
				className={cn(
					"mt-px size-3.5 shrink-0",
					tone === "warning" && "text-warning",
					tone === "error" && "text-destructive",
				)}
				aria-hidden
			/>
			<div className="min-w-0 flex-1">{children}</div>
			{action && <div className="-my-1 shrink-0">{action}</div>}
		</div>
	);
}
