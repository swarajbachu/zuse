"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/tpl/agenforce/lib/utils";

const FILE = "review-guide/tools.ts";
const LINES: ReadonlyArray<{
	kind: "context" | "add" | "remove";
	code: string;
}> = [
	{ kind: "context", code: "addChapter(input) {" },
	{ kind: "remove", code: "  chapters.push(input);" },
	{ kind: "add", code: "  const owned = this.claim(input.hunks);" },
	{ kind: "add", code: "  return report({ owned, unplaced });" },
	{ kind: "context", code: "}" },
];

/** A miniature guide: chapters on the left, the active one's code beside it. */
export const SkeletonFive = () => {
	const { message: t } = useWebsiteMessages();
	const reduceMotion = useReducedMotion();
	const chapters = [
		t("showcase:guided_review_tools_chapter"),
		t("showcase:guided_review_checks_chapter"),
		t("showcase:guided_review_refresh_chapter"),
	];
	return (
		<div className="flex h-full w-full flex-1 items-center justify-center px-6 md:px-10">
			<div className="border-border bg-card grid w-full max-w-xl grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] gap-4 rounded-xl border p-4 shadow-xl">
				<ol className="flex flex-col gap-1.5">
					{chapters.map((title, index) => (
						<motion.li
							key={title}
							initial={false}
							whileInView={{ opacity: 1, x: 0 }}
							transition={{
								duration: 0.24,
								delay: reduceMotion ? 0 : index * 0.06,
							}}
							className={cn(
								"flex items-start gap-2 rounded-lg px-2 py-1.5 text-[11px] leading-4",
								index === 1
									? "bg-primary/10 text-heading"
									: "text-muted-foreground",
							)}
						>
							<span className="font-mono text-[10px] opacity-70">
								0{index + 1}
							</span>
							<span>{title}</span>
						</motion.li>
					))}
				</ol>
				<div className="border-border overflow-hidden rounded-lg border">
					<div className="border-border text-muted-foreground border-b px-2.5 py-1.5 font-mono text-[9px]">
						{FILE}
					</div>
					<div className="py-1 font-mono text-[9px] leading-[18px]">
						{LINES.map((line) => (
							<div
								key={line.code}
								className={cn(
									"truncate border-l-2 border-transparent px-2 whitespace-pre",
									line.kind === "add" &&
										"border-primary bg-primary/10 text-primary",
									line.kind === "remove" &&
										"border-red-500 bg-red-500/10 text-red-500",
									line.kind === "context" && "text-muted-foreground",
								)}
							>
								{line.kind === "add"
									? "+ "
									: line.kind === "remove"
										? "- "
										: "  "}
								{line.code}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
};
