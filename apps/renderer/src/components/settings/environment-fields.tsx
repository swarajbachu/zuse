import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { EnvironmentProject } from "@zuse/contracts";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
	selectTriggerIconClassName,
	selectTriggerVariants,
} from "../ui/select.tsx";

/** Form pieces shared by the Environment add and edit dialogs. */
export function Field({
	label,
	error,
	children,
}: {
	label: string;
	error?: string | null;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				{label}
			</span>
			{children}
			{error ? (
				<p className="text-[11px] leading-4 text-destructive">{error}</p>
			) : null}
		</div>
	);
}

export function OptionRow({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
			<div className="min-w-0">
				<p className="text-xs font-medium leading-4 text-foreground">{title}</p>
				{description === undefined ? null : (
					<p className="text-[11px] leading-4 text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			<div className="flex shrink-0 items-center">{children}</div>
		</div>
	);
}

type ProjectOption = { readonly id: string; readonly name: string };
const ALL_PROJECTS: ProjectOption = { id: "*", name: "All projects" };

/** Searchable multi-select over projects; callers decide what the selection means. */
function ProjectCombobox({
	label,
	className,
	options,
	selectedIds,
	text,
	onIdsChange,
}: {
	label: string;
	className: string;
	options: ReadonlyArray<ProjectOption>;
	selectedIds: ReadonlyArray<string>;
	text: ReactNode;
	onIdsChange: (ids: string[]) => void;
}) {
	return (
		<ComboboxPrimitive.Root
			multiple
			items={options}
			value={options.filter((option) => selectedIds.includes(option.id))}
			itemToStringLabel={(option: ProjectOption) => option.name}
			isItemEqualToValue={(a: ProjectOption, b: ProjectOption) => a.id === b.id}
			onValueChange={(next) => onIdsChange(next.map((option) => option.id))}
		>
			<ComboboxPrimitive.Trigger
				aria-label={label}
				className={cn(selectTriggerVariants(), className)}
			>
				<span className="flex-1 truncate">{text}</span>
				<ChevronsUpDown className={selectTriggerIconClassName} />
			</ComboboxPrimitive.Trigger>
			<ComboboxPrimitive.Portal>
				<ComboboxPrimitive.Positioner
					align="end"
					sideOffset={4}
					className="z-50 select-none"
				>
					<ComboboxPrimitive.Popup className="w-60 overflow-hidden rounded-lg border border-border/80 bg-popover text-foreground shadow-overlay outline-none">
						<div className="relative border-border/60 border-b">
							<Search
								className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
								aria-hidden
							/>
							<ComboboxPrimitive.Input
								aria-label="Search projects"
								placeholder="Search projects…"
								className="h-7 w-full bg-transparent pr-2.5 pl-7 text-xs outline-none placeholder:text-muted-foreground/72"
							/>
						</div>
						<ComboboxPrimitive.Empty className="px-3 py-2 text-[11px] text-muted-foreground empty:hidden">
							No matching projects.
						</ComboboxPrimitive.Empty>
						<ComboboxPrimitive.List className="max-h-56 overflow-y-auto p-1 empty:hidden">
							{(option: ProjectOption) => (
								<ComboboxPrimitive.Item
									key={option.id}
									value={option}
									className={cn(
										"grid min-h-7 cursor-default grid-cols-[0.875rem_1fr] items-center gap-1.5 rounded-md ps-1.5 pe-3 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground",
										option === ALL_PROJECTS && "font-medium",
									)}
								>
									<ComboboxPrimitive.ItemIndicator className="col-start-1">
										<Check className="size-3.5" aria-hidden />
									</ComboboxPrimitive.ItemIndicator>
									<span className="col-start-2 min-w-0 truncate">
										{option.name}
									</span>
								</ComboboxPrimitive.Item>
							)}
						</ComboboxPrimitive.List>
					</ComboboxPrimitive.Popup>
				</ComboboxPrimitive.Positioner>
			</ComboboxPrimitive.Portal>
		</ComboboxPrimitive.Root>
	);
}

const projectNames = (
	projects: ReadonlyArray<EnvironmentProject>,
	ids: ReadonlyArray<string>,
) => {
	const names = projects
		.filter((project) => ids.includes(project.id))
		.map((project) => project.name);
	return names.length <= 2 ? names.join(", ") : `${names.length} projects`;
};

export function ProjectMultiSelect({
	label,
	placeholder,
	projects,
	value,
	onChange,
	className = "w-44",
}: {
	label: string;
	placeholder: string;
	className?: string;
	projects: ReadonlyArray<EnvironmentProject>;
	value: ReadonlyArray<string>;
	onChange: (ids: string[]) => void;
}) {
	return (
		<ProjectCombobox
			label={label}
			className={className}
			options={projects}
			selectedIds={value}
			text={
				value.length === 0 ? (
					<span className="text-muted-foreground">{placeholder}</span>
				) : (
					projectNames(projects, value)
				)
			}
			onIdsChange={onChange}
		/>
	);
}

/**
 * One control for "all projects or these projects". `null` is all projects;
 * `undefined` shows a mixed state for multi-row edits.
 */
export function ProjectScopeSelect({
	label,
	projects,
	value,
	onChange,
	className = "w-44",
}: {
	label: string;
	projects: ReadonlyArray<EnvironmentProject>;
	value: ReadonlyArray<string> | null | undefined;
	onChange: (ids: readonly string[] | null) => void;
	className?: string;
}) {
	return (
		<ProjectCombobox
			label={label}
			className={className}
			options={[ALL_PROJECTS, ...projects]}
			selectedIds={value === null ? [ALL_PROJECTS.id] : (value ?? [])}
			text={
				value === undefined ? (
					<span className="text-muted-foreground">Mixed</span>
				) : value === null || value.length === 0 ? (
					ALL_PROJECTS.name
				) : (
					projectNames(projects, value)
				)
			}
			onIdsChange={(ids) => {
				const chosen = ids.filter((id) => id !== ALL_PROJECTS.id);
				// Picking "All projects" clears specific projects, and vice versa.
				const pickedAll = ids.includes(ALL_PROJECTS.id) && value !== null;
				onChange(pickedAll || chosen.length === 0 ? null : chosen);
			}}
		/>
	);
}
