import "@zuse/i18n/english/chat";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import { useMessages } from "@zuse/i18n/react";
import { Share2 } from "lucide-react";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import { useEnvironmentChat } from "../lib/environment-entity-hooks.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../lib/renderer-workspace.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover.tsx";
import { Spinner } from "./ui/spinner.tsx";

const WorkspaceSharingDialog = lazy(
	() => import("./workspace-sharing-dialog.tsx"),
);
const CloudChatSharingDialog = lazy(
	() => import("./cloud-chat-sharing-dialog.tsx"),
);

export function WorkspaceSharingButton({
	chatRef,
}: {
	readonly chatRef: ChatRef;
}) {
	const { message } = useMessages(["chat"]);
	const auth = useAuth();
	const chat = useEnvironmentChat(chatRef);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const cloud = useCloudChatCatalogStore((state) =>
		state.summaries.find(
			(summary) =>
				summary.workspaceId === chatRef.environmentId &&
				summary.chatId === chatRef.chatId,
		),
	);
	const organizationId =
		cloud?.workspaceScope?.kind === "organization"
			? cloud.workspaceScope.organizationId
			: undefined;
	const [open, setOpen] = useState(false);
	const [opened, setOpened] = useState(false);
	if (
		!auth.isSignedIn ||
		chat === null ||
		(chat.readOnly === true && organizationId === undefined)
	)
		return null;
	if (
		workspace.scope.kind === "organization" &&
		workspace.scope.organizationId !== organizationId
	)
		return null;
	if (organizationId !== undefined && workspace.scope.kind !== "organization")
		return null;
	return (
		<Popover
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (value) setOpened(true);
			}}
		>
			<PopoverTrigger
				render={
					<Button
						className="h-7 gap-2 px-2.5 text-xs [-webkit-app-region:no-drag]"
						size="sm"
						variant="ghost"
					/>
				}
			>
				<Share2 className="size-3" aria-hidden="true" />
				{message("chat:workspace_sharing_button")}
			</PopoverTrigger>
			{opened && (
				<PopoverPopup
					portalProps={{ keepMounted: true }}
					align="end"
					sideOffset={8}
					className="w-80 max-w-[calc(100vw-1rem)] [-webkit-app-region:no-drag]"
				>
					<Suspense
						fallback={
							<div className="flex justify-center p-4">
								<Spinner className="size-3.5" />
							</div>
						}
					>
						{organizationId !== undefined ? (
							<CloudChatSharingDialog
								key={`${chatRef.environmentId}:${auth.user?.id}:${workspace.epoch}`}
								workspaceId={chatRef.environmentId}
								organizationId={organizationId}
								open={open}
								onClose={() => setOpen(false)}
							/>
						) : (
							<WorkspaceSharingDialog
								key={`${chatRef.environmentId}:${chatRef.chatId}:${auth.user?.id}`}
								chatRef={chatRef}
								onClose={() => setOpen(false)}
							/>
						)}
					</Suspense>
				</PopoverPopup>
			)}
		</Popover>
	);
}
