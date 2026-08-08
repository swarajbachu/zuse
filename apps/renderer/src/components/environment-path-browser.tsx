import type { WorkspaceDirectoryListing } from "@zuse/contracts";
import { ChevronRight, File, Folder, MoveUp } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
	browseEnvironmentDirectory,
	pickEnvironmentFolder,
} from "~/lib/environment-projects.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

export const crumbsFor = (
	path: string,
): ReadonlyArray<{ readonly label: string; readonly path: string }> => {
	const windows = /^[A-Za-z]:[\\/]/.test(path);
	const separator = windows ? "\\" : "/";
	const pieces = path.split(/[\\/]/).filter(Boolean);
	const root = windows ? `${pieces.shift() ?? ""}${separator}` : separator;
	const crumbs = [{ label: root, path: root }];
	let current = root;
	for (const piece of pieces) {
		current = current.endsWith(separator)
			? `${current}${piece}`
			: `${current}${separator}${piece}`;
		crumbs.push({ label: piece, path: current });
	}
	return crumbs;
};

export function EnvironmentPathBrowser({
	environmentId,
	value,
	onChange,
	allowNativePicker,
	onReadyChange,
}: {
	readonly environmentId: string;
	readonly value: string;
	readonly onChange: (path: string) => void;
	readonly allowNativePicker: boolean;
	readonly onReadyChange?: (ready: boolean) => void;
}) {
	const [listing, setListing] = useState<WorkspaceDirectoryListing | null>(
		null,
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestGeneration = useRef(0);

	const browse = async (path: string): Promise<void> => {
		const generation = ++requestGeneration.current;
		setLoading(true);
		setError(null);
		onReadyChange?.(false);
		try {
			const next = await browseEnvironmentDirectory(environmentId, path);
			if (generation !== requestGeneration.current) return;
			setListing(next);
			onChange(next.path);
			onReadyChange?.(true);
		} catch (cause) {
			if (generation !== requestGeneration.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
			onReadyChange?.(false);
		} finally {
			if (generation === requestGeneration.current) setLoading(false);
		}
	};

	useEffect(() => {
		setListing(null);
		setError(null);
		onReadyChange?.(false);
		void browse(value);
		// The initial/default directory belongs to the selected environment.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [environmentId, onReadyChange]);

	useEffect(() => {
		if (value.trim().length === 0 || value === listing?.path) return;
		const timer = window.setTimeout(() => void browse(value), 300);
		return () => window.clearTimeout(timer);
		// `listing.path` deliberately suppresses another request after browse
		// normalizes `~` or a relative path.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value, listing?.path]);

	const submitPath = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		void browse(value);
	};

	const useNativePicker = async (): Promise<void> => {
		const picked = await pickEnvironmentFolder(environmentId);
		if (picked !== null) void browse(picked);
	};

	return (
		<div className="flex flex-col gap-2">
			<form className="flex items-center gap-2" onSubmit={submitPath}>
				<label className="sr-only" htmlFor="project-parent-path">
					Parent folder
				</label>
				<Input
					id="project-parent-path"
					value={value}
					onChange={(event) => onChange(event.currentTarget.value)}
					placeholder="~/Developer"
					spellCheck={false}
					autoComplete="off"
					aria-invalid={error !== null ? true : undefined}
				/>
				<Button type="submit" size="sm" variant="secondary" disabled={loading}>
					{loading ? "Loading…" : "Go"}
				</Button>
				{allowNativePicker ? (
					<Button
						type="button"
						size="sm"
						variant="secondary"
						onClick={() => void useNativePicker()}
					>
						Choose…
					</Button>
				) : null}
			</form>

			{listing !== null ? (
				<div className="flex h-56 min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background/40">
					<div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2">
						{listing.parent !== null ? (
							<button
								type="button"
								className="mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() => void browse(listing.parent ?? listing.path)}
								aria-label="Go to parent folder"
							>
								<MoveUp className="size-3.5" />
							</button>
						) : null}
						{crumbsFor(listing.path).map((crumb, index) => (
							<span
								key={crumb.path}
								className="inline-flex shrink-0 items-center"
							>
								{index > 0 ? (
									<ChevronRight className="size-3 text-muted-foreground/50" />
								) : null}
								<button
									type="button"
									className="rounded px-1.5 py-1 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => void browse(crumb.path)}
								>
									{crumb.label}
								</button>
							</span>
						))}
					</div>
					<ul
						className="min-h-0 flex-1 overflow-y-auto p-1"
						aria-label="Folder contents"
					>
						{listing.entries.length === 0 ? (
							<li className="flex h-full items-center justify-center text-xs text-muted-foreground">
								This folder is empty
							</li>
						) : (
							listing.entries.map((entry) => (
								<li key={entry.path}>
									<button
										type="button"
										disabled={entry.kind === "file"}
										onClick={() => void browse(entry.path)}
										className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:text-muted-foreground disabled:opacity-70"
									>
										{entry.kind === "directory" ? (
											<Folder className="size-3.5 shrink-0" />
										) : (
											<File className="size-3.5 shrink-0" />
										)}
										<span className="truncate">{entry.name}</span>
									</button>
								</li>
							))
						)}
					</ul>
				</div>
			) : (
				<div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
					{loading ? "Loading folder…" : "Enter a folder path"}
				</div>
			)}

			{error !== null ? (
				<p className="text-[11px] text-destructive" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
