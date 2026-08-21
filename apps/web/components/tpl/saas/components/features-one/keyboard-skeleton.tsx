"use client";
import type React from "react";
import { cn } from "@/components/tpl/saas/lib/utils";

export function KeyboardSkeleton({ className }: { className?: string }) {
	return (
		<div
			className={cn(
				"relative mx-auto w-fit origin-center translate-x-12 translate-y-10 scale-220 md:translate-x-10 md:-translate-y-6",
				className,
			)}
		>
			<div className="border-border bg-card absolute -top-10 left-0 z-20 w-40 rounded-lg border p-2 shadow-xl">
				<p className="text-heading text-[5px] leading-2">
					“Sign in, finish checkout, verify the receipt.”
				</p>
				<p className="text-primary mt-1 font-mono text-[4px]">
					checkout.spec.ts · generated
				</p>
			</div>
			<div className="rounded-xl bg-neutral-200 p-[3px] shadow-sm ring-1 ring-black/5 dark:bg-neutral-800 dark:ring-white/10">
				<Row>
					<Key className="w-5 rounded-tl-lg">esc</Key>
					<Key>F1</Key>
					<Key>F2</Key>
					<Key>F3</Key>
					<Key>F4</Key>
					<Key>F5</Key>
					<Key>F6</Key>
					<Key>F7</Key>
					<Key>F8</Key>
					<Key>F9</Key>
					<Key>F10</Key>
					<Key>F11</Key>
					<Key>F12</Key>
					<Key className="rounded-tr-lg">
						<div className="size-1.5 rounded-full bg-linear-to-b from-neutral-300 via-neutral-200 to-neutral-300 p-px dark:from-neutral-600 dark:via-neutral-700 dark:to-neutral-600">
							<div className="size-full rounded-full bg-neutral-100 dark:bg-neutral-800" />
						</div>
					</Key>
				</Row>

				<Row>
					<Key>~</Key>
					<Key>1</Key>
					<Key>2</Key>
					<Key>3</Key>
					<Key>4</Key>
					<Key>5</Key>
					<Key>6</Key>
					<Key>7</Key>
					<Key>8</Key>
					<Key>9</Key>
					<Key>0</Key>
					<Key>-</Key>
					<Key>=</Key>
					<Key className="w-5">delete</Key>
				</Row>

				<Row>
					<Key className="w-5">tab</Key>
					<Key>Q</Key>
					<Key>W</Key>
					<Key>E</Key>
					<Key>R</Key>
					<Key>T</Key>
					<Key>Y</Key>
					<Key>U</Key>
					<Key>I</Key>
					<Key>O</Key>
					<Key>P</Key>
					<Key>[</Key>
					<Key>]</Key>
					<Key>\</Key>
				</Row>

				<Row>
					<Key className="w-[22px]">caps</Key>
					<Key>A</Key>
					<Key>S</Key>
					<Key>D</Key>
					<Key>F</Key>
					<Key>G</Key>
					<Key>H</Key>
					<Key>J</Key>
					<Key>K</Key>
					<Key>L</Key>
					<Key>;</Key>
					<Key>&apos;</Key>
					<Key className="w-[23px]">return</Key>
				</Row>

				<Row>
					<Key className="w-[29px]">shift</Key>
					<Key>Z</Key>
					<Key>X</Key>
					<Key>C</Key>
					<Key>V</Key>
					<Key>B</Key>
					<Key>N</Key>
					<Key>M</Key>
					<Key>,</Key>
					<Key>.</Key>
					<Key>/</Key>
					<Key className="w-[29px]">shift</Key>
				</Row>

				<Row>
					<Key className="rounded-bl-lg">fn</Key>
					<Key>ctrl</Key>
					<Key>opt</Key>
					<Key className="w-4">cmd</Key>
					<Key className="w-[66px]" />
					<Key className="w-4">cmd</Key>
					<Key>opt</Key>
					<div className="flex h-3 items-center gap-px rounded-[2px]">
						<Key className="h-3 w-3">←</Key>
						<div className="flex flex-col gap-px">
							<Key className="h-[5.5px] w-3">↑</Key>
							<Key className="h-[5.5px] w-3">↓</Key>
						</div>
						<Key className="h-3 w-3 rounded-br-lg">→</Key>
					</div>
				</Row>
			</div>
		</div>
	);
}

function Row({ children }: { children: React.ReactNode }) {
	return <div className="mb-px flex gap-px">{children}</div>;
}

function Key({
	children,
	className,
}: {
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex h-3 w-3 cursor-default items-center justify-center rounded-[2px] bg-neutral-100 text-[3px] font-medium text-neutral-700 shadow-[0_0.5px_0.5px_0_rgba(0,0,0,0.1),inset_0_0.5px_0_0_rgba(255,255,255,1)] transition-shadow duration-150 hover:shadow-[0_0_6px_0_rgba(0,0,0,0.3),0_0.5px_0.5px_0_rgba(0,0,0,0.1),inset_0_0.5px_0_0_rgba(255,255,255,1)] dark:bg-neutral-700 dark:text-neutral-300 dark:shadow-[0_0.5px_0.5px_0_rgba(0,0,0,0.3),inset_0_0.5px_0_0_rgba(255,255,255,0.1)] dark:hover:shadow-[0_0_6px_0_rgba(255,255,255,0.2),0_0.5px_0.5px_0_rgba(0,0,0,0.3),inset_0_0.5px_0_0_rgba(255,255,255,0.1)]",
				className,
			)}
		>
			{children}
		</div>
	);
}
