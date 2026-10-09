import "@zuse/i18n/english/common";
import "@zuse/i18n/english/chat";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { HtmlRenderReference } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	defaultHtmlTheme,
	prepareHtmlDisplayUrl,
	readVisualHeight,
} from "@zuse/utils/html-document";
import { Expand, X } from "lucide-react";
import {
	memo,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useResolvedAppearance } from "~/lib/appearance";
import { useAttachmentUrl } from "~/lib/attachments";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog.tsx";

function VisualDocument({
	src,
	title,
	height,
	expanded = false,
}: {
	src: string;
	title: string;
	height: number;
	expanded?: boolean;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const appearance = useResolvedAppearance();
	const [measured, setMeasured] = useState(height);
	const postTheme = () => {
		const defaults = defaultHtmlTheme(appearance);
		const styles = getComputedStyle(document.documentElement);
		const variables = Object.fromEntries(
			Object.entries(defaults.variables).map(([key, value]) => [
				key,
				styles.getPropertyValue(key).trim() || value,
			]),
		);
		frame.current?.contentWindow?.postMessage(
			{ type: "zuse:visual-theme", theme: { appearance, variables } },
			"*",
		);
	};
	useEffect(postTheme, [appearance]);
	useLayoutEffect(() => {
		const receive = (event: MessageEvent) => {
			if (!frame.current || event.source !== frame.current.contentWindow)
				return;
			const next = readVisualHeight(event.data);
			if (next !== null) setMeasured(next);
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, []);
	return (
		<iframe
			ref={frame}
			title={title}
			src={src}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			loading="lazy"
			onLoad={postTheme}
			className="block w-full border-0 bg-transparent"
			style={{
				height: expanded ? "75vh" : measured,
				colorScheme: appearance,
			}}
		/>
	);
}

export const HtmlVisual = memo(function HtmlVisual({
	visual,
	sessionRef,
}: {
	visual: HtmlRenderReference;
	sessionRef: SessionRef;
}) {
	const { message } = useMessages(["common", "chat"]);
	const publicNetwork = window.zuse?.htmlVisualPublicNetwork === true;
	const container = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		if (!container.current) return;
		if (typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setVisible(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "300px" },
		);
		observer.observe(container.current);
		return () => observer.disconnect();
	}, []);
	const resource = useAttachmentUrl(
		visible && publicNetwork ? sessionRef : null,
		visual.attachmentId,
	);
	// A fetched attachment must actually be HTML; references cannot execute other blobs.
	const src = useMemo(() => {
		if (!publicNetwork || !resource.src?.startsWith("data:text/html;base64,"))
			return null;
		try {
			return prepareHtmlDisplayUrl(resource.src);
		} catch {
			return null;
		}
	}, [resource.src, publicNetwork]);
	const failed =
		!publicNetwork ||
		resource.failed ||
		(resource.src !== null && src === null);
	return (
		<div
			ref={container}
			className="group relative my-3 min-w-0"
			style={{ minHeight: src ? undefined : visual.height }}
		>
			{src ? (
				<>
					<VisualDocument
						src={src}
						title={visual.title}
						height={visual.height}
					/>
					<Button
						className="absolute right-1 top-1 h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
						variant="ghost"
						aria-label={message("common:expand", { title: visual.title })}
						onClick={() => setExpanded(true)}
					>
						<Expand className="size-3.5" />
					</Button>
				</>
			) : (
				<div
					className="flex h-full min-h-20 items-center justify-center gap-2 text-xs text-muted-foreground"
					role="status"
				>
					{failed ? (
						<>
							{visual.title} —{" "}
							{publicNetwork ? (
								<Button
									className="h-7"
									variant="ghost"
									onClick={resource.retry}
								>
									{message("chat:message_row_retry_preview")}
								</Button>
							) : (
								message("chat:cloud_setup_unavailable")
							)}
						</>
					) : (
						message("common:loading")
					)}
				</div>
			)}
			<Dialog open={expanded} onOpenChange={setExpanded}>
				<DialogPopup
					showCloseButton={false}
					className="w-[min(1100px,95vw)] max-w-none p-3"
				>
					<DialogTitle className="sr-only">{visual.title}</DialogTitle>

					<Button
						className="mb-1 ml-auto flex h-7 w-7"
						variant="ghost"
						aria-label={message("common:close")}
						onClick={() => setExpanded(false)}
					>
						<X className="size-4" />
					</Button>
					{src && expanded ? (
						<VisualDocument
							src={src}
							title={visual.title}
							height={visual.height}
							expanded
						/>
					) : null}
				</DialogPopup>
			</Dialog>
		</div>
	);
});
