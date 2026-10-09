import "@zuse/i18n/english/settings";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { Organization } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useRef, useState } from "react";
import { organizationErrorMessage } from "../lib/organization-error.ts";
import { subscribeRendererAccount } from "../lib/renderer-account.ts";
import {
	type WorkspaceSharingState,
	workspaceSharing,
} from "../lib/workspace-sharing.ts";
import { Button } from "./ui/button.tsx";
import { PopoverDescription, PopoverTitle } from "./ui/popover.tsx";

export default function WorkspaceSharingDialog({
	chatRef,
	onClose,
}: {
	readonly chatRef: ChatRef;
	readonly onClose: () => void;
}) {
	const { environmentId, chatId } = chatRef;
	const { message } = useMessages(["settings"]);
	const [organizations, setOrganizations] = useState<
		ReadonlyArray<Organization>
	>([]);
	const [organizationId, setOrganizationId] = useState("");
	const [state, setState] = useState<WorkspaceSharingState | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmStop, setConfirmStop] = useState(false);
	const [retry, setRetry] = useState(0);
	const epoch = useRef(0);
	const mutating = useRef(false);

	useEffect(
		() =>
			subscribeRendererAccount(() => {
				epoch.current++;
				onClose();
			}),
		[onClose],
	);

	useEffect(() => {
		const current = ++epoch.current;
		setLoading(true);
		setError(null);
		setState(null);
		const ref = { environmentId, chatId };
		void workspaceSharing
			.organizations(ref)
			.then(async (list) => {
				if (current !== epoch.current) return;
				const admins = list.filter(
					(organization) => organization.role === "admin",
				);
				setOrganizations(admins);
				const id = admins[0]?.id ?? "";
				setOrganizationId(id);
				if (id) {
					const next = await workspaceSharing.get(ref, id);
					if (current === epoch.current) setState(next);
				}
			})
			.catch((cause: unknown) => {
				if (current === epoch.current)
					setError(organizationErrorMessage(cause));
			})
			.finally(() => {
				if (current === epoch.current) setLoading(false);
			});
		return () => {
			epoch.current++;
		};
	}, [environmentId, chatId, retry]);

	const load = async (id: string) => {
		const current = ++epoch.current;
		setOrganizationId(id);
		setState(null);
		setError(null);
		setConfirmStop(false);
		setLoading(true);
		try {
			const next = await workspaceSharing.get(chatRef, id);
			if (current === epoch.current) setState(next);
		} catch (cause) {
			if (current === epoch.current) setError(organizationErrorMessage(cause));
		} finally {
			if (current === epoch.current) setLoading(false);
		}
	};

	const mutate = async (operation: () => Promise<void>) => {
		if (mutating.current) return;
		mutating.current = true;
		const current = epoch.current;
		setBusy(true);
		setError(null);
		try {
			await operation();
			if (current !== epoch.current) return;
			const next = await workspaceSharing.get(chatRef, organizationId);
			if (current === epoch.current) {
				setState(next);
				setConfirmStop(false);
			}
		} catch (cause) {
			if (current === epoch.current) setError(organizationErrorMessage(cause));
		} finally {
			mutating.current = false;
			if (current === epoch.current) setBusy(false);
		}
	};

	return (
		<>
			<div className="space-y-2 px-2 py-2">
				<PopoverTitle className="text-sm">
					{message("settings:sharing_title")}
				</PopoverTitle>
				<PopoverDescription>
					{message("settings:sharing_description")}
				</PopoverDescription>
			</div>
			<div
				className="space-y-4 px-2 pb-2 pt-2 text-xs"
				aria-busy={busy || loading}
			>
				{organizations.length > 0 && (
					<select
						aria-label={message("settings:sharing_organization")}
						className="h-7 w-full rounded-md bg-muted px-2"
						value={organizationId}
						disabled={busy || loading}
						onChange={(event) => void load(event.target.value)}
					>
						{organizations.map((organization) => (
							<option key={organization.id} value={organization.id}>
								{organization.name}
							</option>
						))}
					</select>
				)}
				{loading ? (
					<p role="status">{message("settings:sharing_loading")}</p>
				) : !error && organizations.length === 0 ? (
					<p>{message("settings:sharing_no_organizations")}</p>
				) : null}
				{error && (
					<div role="alert" className="space-y-2 text-destructive">
						<p>{error}</p>
						{
							<Button
								className="h-7"
								size="xs"
								disabled={busy}
								onClick={() =>
									organizationId
										? void load(organizationId)
										: setRetry((value) => value + 1)
								}
							>
								{message("settings:sharing_retry")}
							</Button>
						}
					</div>
				)}
				{state && !loading && (
					<>
						<p>
							{message(
								state.shared
									? "settings:sharing_shared"
									: "settings:sharing_private",
							)}
						</p>
						{state.shared ? (
							<>
								<div className="max-h-64 space-y-2 overflow-y-auto">
									{state.members
										.filter((member) => member.status === "active")
										.map((member) => {
											const grant = state.grants.find(
												(candidate) => candidate.memberId === member.id,
											);
											return (
												<div
													key={member.id}
													className="flex items-center gap-3"
												>
													<div className="min-w-0 flex-1">
														<p className="truncate">{member.displayName}</p>
														<p className="truncate text-muted-foreground">
															{member.email}
														</p>
													</div>
													{member.role === "owner" ? (
														<span className="text-muted-foreground">
															{message("settings:sharing_owner")}
														</span>
													) : (
														<select
															className="h-7 w-24 rounded-md bg-muted px-2"
															aria-label={message(
																"settings:sharing_access_for",
																{ name: member.displayName },
															)}
															value={grant?.role ?? "none"}
															disabled={busy || error !== null}
															onChange={(event) => {
																const role =
																	event.target.value === "driver"
																		? "driver"
																		: event.target.value === "viewer"
																			? "viewer"
																			: null;
																void mutate(() =>
																	workspaceSharing.setGrant(
																		chatRef,
																		organizationId,
																		member.subject,
																		role,
																	),
																);
															}}
														>
															<option value="none">
																{message("settings:sharing_no_access")}
															</option>
															<option value="viewer">
																{message("settings:sharing_viewer")}
															</option>
															{member.role === "driver" && (
																<option value="driver">
																	{message("settings:sharing_driver")}
																</option>
															)}
														</select>
													)}
												</div>
											);
										})}
								</div>
								{confirmStop ? (
									<div className="space-y-2 rounded-md bg-muted p-3">
										<p>{message("settings:sharing_stop_description")}</p>
										<div className="flex gap-2">
											<Button
												className="h-7"
												size="xs"
												disabled={busy}
												onClick={() =>
													void mutate(() =>
														workspaceSharing.setShared(
															chatRef,
															organizationId,
															false,
														),
													)
												}
											>
												{message("settings:sharing_stop")}
											</Button>
											<Button
												className="h-7"
												size="xs"
												disabled={busy}
												variant="ghost"
												onClick={() => setConfirmStop(false)}
											>
												{message("settings:organizations_cancel")}
											</Button>
										</div>
									</div>
								) : (
									<Button
										className="h-7"
										size="xs"
										disabled={busy || error !== null}
										variant="ghost"
										onClick={() => setConfirmStop(true)}
									>
										{message("settings:sharing_stop")}
									</Button>
								)}
							</>
						) : (
							<Button
								className="h-7"
								size="xs"
								disabled={busy || error !== null}
								onClick={() =>
									void mutate(() =>
										workspaceSharing.setShared(chatRef, organizationId, true),
									)
								}
							>
								{message("settings:sharing_enable")}
							</Button>
						)}
					</>
				)}
			</div>
		</>
	);
}
