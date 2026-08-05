import type { FileContents } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import { useMemo } from "react";
import { useZuseDiffTheme } from "../lib/diffs-theme.ts";
import { cn } from "../lib/utils.ts";
import { CopyButton } from "./copy-button.tsx";
import { FileIcon } from "./file-icon.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const basename = (path: string): string => {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
};

export function ToolFileBlock({
	path,
	text,
	isError = false,
}: {
	readonly path: string;
	readonly text: string;
	readonly isError?: boolean;
}) {
	const diffTheme = useZuseDiffTheme();
	const name = basename(path);
	const file = useMemo<FileContents>(
		() => ({ name, contents: text }),
		[name, text],
	);

	return (
		<div
			className={cn(
				"fz-diff code-block-scroll max-h-[420px] overflow-auto rounded-lg border",
				isError ? "border-alert-error-bg" : "border-border/50",
			)}
		>
			<File
				file={file}
				options={{ ...diffTheme, overflow: "scroll" }}
				renderCustomHeader={() => (
					<div className="flex min-h-9 w-full items-center gap-2 px-2 text-[11px] text-muted-foreground">
						<Tooltip>
							<TooltipTrigger
								render={
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<FileIcon
											name={name}
											kind="file"
											className="inline-flex size-3.5 shrink-0 items-center justify-center"
										/>
										<span className="truncate font-mono text-foreground/80">
											{name}
										</span>
									</div>
								}
							/>
							<TooltipPopup>{path}</TooltipPopup>
						</Tooltip>
						<CopyButton
							text={text}
							label={`Copy ${name}`}
							className="size-5 rounded text-muted-foreground/60 hover:bg-muted/60"
						/>
					</div>
				)}
				disableWorkerPool
			/>
		</div>
	);
}
