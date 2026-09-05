import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown02Icon,
	ArrowTurnDownIcon,
	ArrowUp02Icon,
	Search01Icon,
} from "@zuse/icons/solid-rounded";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "~/lib/utils";
import { Dialog, DialogPopup } from "./dialog";
import { Kbd, KbdGroup } from "./kbd";

export interface CommandPaletteItem<Value> {
	readonly id: string;
	readonly label: string;
	readonly icon: ReactNode;
	readonly value: Value;
	readonly detail?: ReactNode;
	readonly shortcut?: string;
}

export interface CommandPaletteGroup<Value> {
	readonly label: string;
	readonly items: ReadonlyArray<CommandPaletteItem<Value>>;
}

/** Shared command-dialog surface: rounded inset panel, bounded scroll, one focus owner. */
export function CommandPaletteDialog<Value>({
	label,
	inputLabel,
	placeholder,
	query,
	onQueryChange,
	groups,
	onClose,
	onSelect,
	emptyMessage = "Try another chat, project, or command name.",
	notice,
}: {
	label: string;
	inputLabel: string;
	placeholder: string;
	query: string;
	onQueryChange: (query: string) => void;
	groups: ReadonlyArray<CommandPaletteGroup<Value>>;
	onClose: () => void;
	onSelect: (value: Value) => void;
	emptyMessage?: string;
	notice?: string;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const listId = useId();
	const confirmedRef = useRef(false);
	const rows = useMemo(() => groups.flatMap((group) => group.items), [groups]);
	const [highlight, setHighlight] = useState(0);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		setHighlight(0);
		listRef.current?.scrollTo({ top: 0 });
	}, [rows]);
	useEffect(() => {
		itemRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const confirm = (item: CommandPaletteItem<Value> | undefined) => {
		if (item === undefined) return;
		confirmedRef.current = true;
		// Unmount before dispatch: commands may focus content made inert by this modal.
		flushSync(onClose);
		onSelect(item.value);
	};
	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing || rows.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			setHighlight((index) => (index + direction + rows.length) % rows.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			confirm(rows[highlight]);
		}
	};
	let rowIndex = 0;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogPopup
				aria-label={label}
				className="max-h-[min(440px,calc(100dvh-64px))] max-w-xl overflow-hidden rounded-2xl bg-muted"
				showCloseButton={false}
				bottomStickOnMobile={false}
				initialFocus={inputRef}
				finalFocus={() => !confirmedRef.current}
			>
				<div className="flex shrink-0 items-center gap-2.5 px-4 py-3">
					<HugeiconsIcon
						icon={Search01Icon}
						aria-hidden
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<input
						ref={inputRef}
						role="combobox"
						aria-expanded={rows.length > 0}
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={
							rows[highlight] === undefined
								? undefined
								: `${listId}-${highlight}`
						}
						onKeyDown={onKey}
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						aria-label={inputLabel}
						placeholder={placeholder}
						className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<div className="flex min-h-0 flex-col overflow-hidden rounded-t-2xl border-t border-border/70 bg-popover">
					{notice && (
						<p
							role="status"
							className="shrink-0 px-4 pt-3 text-xs text-muted-foreground"
						>
							{notice}
						</p>
					)}
					<div
						ref={listRef}
						id={listId}
						role="listbox"
						hidden={rows.length === 0}
						tabIndex={-1}
						aria-label={label}
						className="min-h-0 overflow-y-auto overscroll-contain p-1.5 [scrollbar-width:thin]"
					>
						{rows.length === 0
							? null
							: groups.map((group, groupIndex) =>
									group.items.length === 0 ? null : (
										<fieldset
											key={group.label}
											aria-labelledby={`${listId}-group-${groupIndex}`}
											className="min-w-0 pb-2 last:pb-1 [&+&]:pt-1"
										>
											<div
												id={`${listId}-group-${groupIndex}`}
												className="px-2.5 py-2 text-xs font-medium text-muted-foreground"
											>
												{group.label}
											</div>
											{group.items.map((item) => {
												const index = rowIndex++;
												return (
													<button
														key={item.id}
														ref={(element) => {
															itemRefs.current[index] = element;
														}}
														type="button"
														role="option"
														id={`${listId}-${index}`}
														tabIndex={-1}
														onMouseDown={(event) => event.preventDefault()}
														aria-selected={index === highlight}
														onMouseMove={() => setHighlight(index)}
														onClick={() => confirm(item)}
														className={cn(
															"flex h-7 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring",
															index === highlight
																? "bg-accent text-accent-foreground"
																: "hover:bg-muted/60",
														)}
													>
														{item.icon}
														<span className="min-w-0 flex-1 truncate">
															{item.label}
														</span>
														{item.detail}
														{item.shortcut && (
															<Kbd className="h-4 shrink-0 rounded-full bg-muted/70 px-1.5 text-[11px]">
																{item.shortcut}
															</Kbd>
														)}
													</button>
												);
											})}
										</fieldset>
									),
								)}
					</div>
					{rows.length === 0 && (
						<p role="status" className="px-4 pb-8 pt-5 text-center text-sm">
							{emptyMessage}
						</p>
					)}
					<div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/40 px-4 py-2 text-[11px] text-muted-foreground">
						<div className="flex items-center gap-3">
							<span className="flex items-center gap-1.5">
								<KbdGroup>
									<Kbd>
										<HugeiconsIcon icon={ArrowUp02Icon} aria-label="Up arrow" />
									</Kbd>
									<Kbd>
										<HugeiconsIcon
											icon={ArrowDown02Icon}
											aria-label="Down arrow"
										/>
									</Kbd>
								</KbdGroup>
								Navigate
							</span>
							<span className="flex items-center gap-1.5">
								<Kbd>
									<HugeiconsIcon icon={ArrowTurnDownIcon} aria-label="Enter" />
								</Kbd>
								Open
							</span>
						</div>
						<span className="flex items-center gap-1.5">
							<Kbd>Esc</Kbd>Close
						</span>
					</div>
				</div>
			</DialogPopup>
		</Dialog>
	);
}
