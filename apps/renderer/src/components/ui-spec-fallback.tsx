import "@zuse/i18n/english/chat";
import { useMessages } from "@zuse/i18n/react";

/**
 * Last-resort surface for specs that no longer parse — older persisted rows,
 * a library/component drift, or a spec written before validation existed.
 * Never renders blank: the raw spec stays inspectable.
 */
export function UiSpecFallback({
	spec,
	reason,
}: {
	readonly spec: string;
	readonly reason: string;
}) {
	const { message: uiMessage } = useMessages(["chat"]);
	return (
		<div
			className="rounded-lg border border-border/50 border-dashed bg-muted/30 px-3 py-2"
			role="note"
		>
			<div className="text-[11px] font-medium text-muted-foreground">
				{uiMessage("chat:message_row_ui_spec_could_not_render")}
			</div>
			{reason.length > 0 ? (
				<div className="mt-0.5 text-[11px] text-muted-foreground/80">
					{reason}
				</div>
			) : null}
			<pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-muted-foreground/80">
				{spec}
			</pre>
		</div>
	);
}
