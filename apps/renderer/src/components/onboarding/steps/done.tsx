import "@zuse/i18n/english/onboarding";
import { HugeiconsIcon } from "@hugeicons/react";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { Tick01Icon } from "@zuse/icons/solid-rounded";
import { Button } from "~/components/ui/button";

export function DoneStep({ onFinish }: { onFinish: () => void }) {
	const { message: uiMessage } = useUiMessages(["onboarding"]);

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
					{uiMessage("onboarding:done_you_apos_re_all_set")}
				</h2>
				<p className="max-w-sm text-[14px] leading-relaxed text-muted-foreground">
					<RichMessage
						id="onboarding:done_start_a_chat_from_the_sidebar_whenever_you_apos_re_ready_rep_sentence"
						components={{ part0: <span className="text-foreground" /> }}
					/>
				</p>
			</div>
			<Button size="default" onClick={onFinish} className="rounded-lg px-6">
				{uiMessage("onboarding:done_open_zuse_beta")}
			</Button>
		</div>
	);
}
