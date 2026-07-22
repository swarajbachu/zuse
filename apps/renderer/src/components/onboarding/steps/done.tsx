import { HugeiconsIcon } from "@hugeicons/react";
import Tick01Icon from "@hugeicons-pro/core-solid-rounded/Tick01Icon";
import { Button } from "~/components/ui/button";

export function DoneStep({ onFinish }: { onFinish: () => void }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-7 text-center">
			<div className="relative flex size-16 items-center justify-center">
				<span className="absolute inset-0 rounded-full bg-emerald-400/15 blur-xl" />
				<span className="relative flex size-14 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
					<HugeiconsIcon
						icon={Tick01Icon}
						className="size-6"
						strokeWidth={2.25}
					/>
				</span>
			</div>
			<div className="flex flex-col gap-2.5">
				<h2 className="text-3xl font-semibold tracking-tight text-foreground">
					You&apos;re all set
				</h2>
				<p className="max-w-sm text-[14px] leading-relaxed text-muted-foreground">
					Start a chat from the sidebar whenever you&apos;re ready. Replay this
					flow anytime from{" "}
					<span className="text-foreground">Settings → General</span>.
				</p>
			</div>
			<Button size="default" onClick={onFinish} className="rounded-lg px-6">
				Open Zuse Alpha
			</Button>
		</div>
	);
}
