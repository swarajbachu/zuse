import { ArrowRight } from "lucide-react";
import { Fragment } from "react";
import { cn } from "~/lib/utils";

export interface FlowDiagramNode {
	readonly label: string;
	readonly detail?: string | undefined;
	readonly highlight?: boolean | undefined;
}

/**
 * Boxes joined by arrows, left to right, stacking vertically when narrow.
 * Shared by generative UI blocks and guided reviews' before/after.
 */
export function FlowDiagram({
	nodes,
	caption,
}: {
	readonly nodes: ReadonlyArray<FlowDiagramNode>;
	readonly caption?: string | undefined;
}) {
	return (
		<figure className="@container min-w-0 space-y-2">
			<ol className="flex flex-col items-stretch gap-1.5 @lg:flex-row @lg:items-center">
				{nodes.map((node, index) => (
					// eslint-disable-next-line react/no-array-index-key -- spec order is stable
					<Fragment key={index}>
						{index > 0 ? (
							<ArrowRight
								aria-hidden
								className="size-4 shrink-0 rotate-90 self-center text-muted-foreground @lg:rotate-0"
							/>
						) : null}
						<li
							data-highlight={node.highlight === true || undefined}
							className={cn(
								"flex min-w-0 flex-1 flex-col justify-center self-stretch rounded-lg bg-muted/50 px-3 py-2 text-center",
								node.highlight && "bg-primary/15 ring-1 ring-primary/40",
							)}
						>
							<span className="break-words font-medium text-foreground text-sm">
								{node.label}
							</span>
							{node.detail ? (
								<span className="break-words text-muted-foreground text-xs leading-5">
									{node.detail}
								</span>
							) : null}
						</li>
					</Fragment>
				))}
			</ol>
			{caption ? (
				<figcaption className="text-muted-foreground text-xs">
					{caption}
				</figcaption>
			) : null}
		</figure>
	);
}
