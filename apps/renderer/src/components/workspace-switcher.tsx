import "@zuse/i18n/english/common";
import "@zuse/i18n/english/settings";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { DitherAvatar } from "@repo/ui/dither";
import { useMessages } from "@zuse/i18n/react";
import {
	Add01Icon,
	Logout03Icon,
	Refresh01Icon,
	Settings01Icon,
	Tick02Icon,
	UnfoldMoreIcon,
} from "@zuse/icons/solid-rounded";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import { openOrganizationWorkspace } from "../lib/open-organization-workspace.ts";
import {
	loadOrganizationWorkspaces,
	organizationWorkspacesAvailable,
	useOrganizationWorkspaces,
} from "../lib/organization-workspaces.ts";
import {
	rendererWorkspaceSnapshot,
	selectRendererWorkspace,
	subscribeRendererWorkspace,
} from "../lib/renderer-workspace.ts";
import { requestReviewLeave } from "../lib/review-edit-guard.ts";
import { cn } from "../lib/utils.ts";
import { useUiStore } from "../store/ui.ts";
import { CreateOrganizationDialog } from "./organization-dialogs.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "./ui/menu.tsx";

export { organizationWorkspacesAvailable } from "../lib/organization-workspaces.ts";

/** Personal shows the account photo; organizations their dithered mark. */
function WorkspaceMark({
	seed,
	imageUrl,
	size,
}: {
	seed: string;
	imageUrl?: string | null;
	size: 16 | 18;
}) {
	return imageUrl ? (
		<img
			src={imageUrl}
			alt=""
			aria-hidden
			width={size}
			height={size}
			referrerPolicy="no-referrer"
			className="shrink-0 rounded-[4px] object-cover"
			style={{ width: size, height: size }}
		/>
	) : (
		<span aria-hidden className="shrink-0">
			<DitherAvatar name={seed} size={size} className="rounded-[4px]" />
		</span>
	);
}

const itemClass =
	"flex h-7 items-center gap-2 rounded-md px-2 text-xs text-foreground";

function WorkspaceItem({
	mark,
	label,
	checked,
	onClick,
}: {
	mark: ReactNode;
	label: string;
	checked: boolean;
	onClick: () => void;
}) {
	return (
		<MenuItem
			role="menuitemradio"
			aria-checked={checked}
			className={itemClass}
			onClick={onClick}
		>
			{mark}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{checked ? (
				<HugeiconsIcon icon={Tick02Icon} className="size-3.5 text-foreground" />
			) : null}
		</MenuItem>
	);
}

function ActionItem({
	icon,
	label,
	onClick,
}: {
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
}) {
	return (
		<MenuItem
			className={cn(itemClass, "text-muted-foreground")}
			onClick={onClick}
		>
			<span className="flex size-[18px] shrink-0 items-center justify-center">
				<HugeiconsIcon icon={icon} className="size-3.5" />
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</MenuItem>
	);
}

/**
 * Account and workspace menu: who is signed in, Personal and organization
 * workspaces, then Settings and Sign out.
 */
export function WorkspaceSwitcher() {
	const { message } = useMessages(["common", "settings"]);
	const { user, signOut } = useAuth();
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
	);
	const {
		organizations,
		loading,
		error,
		canCreate: creationAllowed,
	} = useOrganizationWorkspaces();
	const [creating, setCreating] = useState(false);
	useEffect(() => {
		if (!user?.id) return;
		const refresh = () => {
			if (!document.hidden)
				void loadOrganizationWorkspaces().catch(() => undefined);
		};
		refresh();
		const timer = window.setInterval(refresh, 30_000);
		window.addEventListener("focus", refresh);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", refresh);
		};
	}, [user?.id]);
	if (!organizationWorkspacesAvailable() || !user) return null;

	const scope = workspace.scope;
	const current =
		scope.kind === "organization"
			? organizations.find(
					(organization) => organization.id === scope.organizationId,
				)
			: undefined;
	const canCreate =
		creationAllowed &&
		!loading &&
		error == null &&
		!organizations.some((organization) => organization.isCreator);
	const leave = (action: () => void) => requestReviewLeave(action);
	const personal = message("settings:workspace_personal");

	return (
		<div className="px-2 py-1">
			<Menu>
				<MenuTrigger
					aria-label={message("settings:workspace_switcher")}
					className="group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent/50"
				>
					{current ? (
						<WorkspaceMark seed={current.id} size={18} />
					) : (
						<WorkspaceMark
							seed={user.id}
							imageUrl={user.profilePictureUrl}
							size={18}
						/>
					)}
					<span className="min-w-0 flex-1 truncate text-left">
						{current?.name ?? personal}
					</span>
					<HugeiconsIcon
						icon={UnfoldMoreIcon}
						className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-data-[popup-open]:opacity-100"
					/>
				</MenuTrigger>
				<MenuPopup side="bottom" align="start" className="w-60 p-1">
					<div className="truncate px-2 pt-1 pb-1 text-[11px] text-muted-foreground">
						{user.email}
					</div>
					<WorkspaceItem
						mark={
							<WorkspaceMark
								seed={user.id}
								imageUrl={user.profilePictureUrl}
								size={18}
							/>
						}
						label={personal}
						checked={scope.kind === "personal"}
						onClick={() =>
							leave(() => selectRendererWorkspace({ kind: "personal" }))
						}
					/>
					{organizations.map((organization) => (
						<WorkspaceItem
							key={organization.id}
							mark={<WorkspaceMark seed={organization.id} size={18} />}
							label={organization.name}
							checked={organization.id === current?.id}
							onClick={() =>
								leave(() => openOrganizationWorkspace(organization))
							}
						/>
					))}
					{loading && organizations.length === 0 && (
						<div
							role="status"
							className="px-2 py-1 text-[11px] text-muted-foreground"
						>
							{message("settings:organizations_loading_organization")}
						</div>
					)}
					{error != null && (
						<ActionItem
							icon={Refresh01Icon}
							label={message("settings:organizations_refresh")}
							onClick={() =>
								void loadOrganizationWorkspaces(true).catch(() => undefined)
							}
						/>
					)}
					{canCreate && (
						<ActionItem
							icon={Add01Icon}
							label={message("settings:organizations_create_an_organization")}
							onClick={() => setCreating(true)}
						/>
					)}
					<MenuSeparator className="my-1" />
					<ActionItem
						icon={Settings01Icon}
						label={message("common:settings")}
						onClick={() =>
							leave(() => useUiStore.getState().setView("settings"))
						}
					/>
					<ActionItem
						icon={Logout03Icon}
						label={message("common:signOut")}
						onClick={() => void signOut()}
					/>
				</MenuPopup>
			</Menu>
			<CreateOrganizationDialog open={creating} onOpenChange={setCreating} />
		</div>
	);
}
