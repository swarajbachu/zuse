import type { ComposerInput } from "@zuse/contracts";
import type { ReactNode } from "react";
import { UserBubble } from "./message-row.tsx";

/** The first submitted turn uses the same reading column and composer as a live chat. */
export function ChatStartupView({
	input,
	previews,
	progress,
	composer,
}: {
	readonly input: ComposerInput;
	readonly previews: Readonly<Record<string, string>>;
	readonly progress: ReactNode;
	readonly composer: ReactNode;
}) {
	return (
		<div className="chat-session-layout relative flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size]">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[var(--chat-reading-column)] px-[var(--chat-row-gutter)] pt-4">
					<UserBubble
						text={input.text}
						attachments={input.attachments}
						attachmentPreviews={previews}
						fileRefs={input.fileRefs}
						skillRefs={input.skillRefs}
						goal={input.asGoal}
					/>
					{progress}
				</div>
			</div>
			<div className="shrink-0 px-[var(--chat-row-gutter)] pb-4 pt-2">
				<div className="mx-auto w-full max-w-[var(--chat-reading-column)]">
					{composer}
				</div>
			</div>
		</div>
	);
}
