import "@zuse/i18n/english/settings";
import type { Organization } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useRef, useState } from "react";
import { useOrganizationAction } from "../hooks/use-organization-action.ts";
import { openOrganizationWorkspace } from "../lib/open-organization-workspace.ts";
import { runOrganizations } from "../lib/organization-client.ts";
import { loadOrganizationWorkspaces } from "../lib/organization-workspaces.ts";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "./ui/dialog.tsx";
import { DitherActionButton } from "./ui/dither-action-button.tsx";
import { Input } from "./ui/input.tsx";
import { SettingsNote } from "./ui/settings-panel.tsx";

type DialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

const openInSettings = (organization: Pick<Organization, "id" | "role">) =>
	openOrganizationWorkspace(organization, { settings: true });

/** Creates an organization and opens its Members settings to invite people. */
export function CreateOrganizationDialog({ open, onOpenChange }: DialogProps) {
	const { message } = useMessages(["settings"]);
	const { busy, error, run } = useOrganizationAction();
	const [name, setName] = useState("");
	// Retrying the same name reuses the operation id, so a lost response never
	// creates a second organization.
	const attempt = useRef<{ name: string; operationId: string } | null>(null);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{message("settings:organizations_create_an_organization")}
					</DialogTitle>
					<DialogDescription>
						{message("settings:organizations_creation_limit")}
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="flex flex-col gap-2 pb-4">
					{error && <SettingsNote tone="error">{error}</SettingsNote>}
					<form
						className="flex items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							const trimmed = name.trim();
							if (!trimmed) return;
							void run(async (current) => {
								if (attempt.current?.name !== trimmed)
									attempt.current = {
										name: trimmed,
										operationId: crypto.randomUUID(),
									};
								const input = attempt.current;
								const created = await runOrganizations((client) =>
									client["organizations.create"](input),
								);
								if (!current()) return;
								attempt.current = null;
								setName("");
								// The organization exists; a failed list refresh must not strand it.
								const organizations = await loadOrganizationWorkspaces(
									true,
								).catch(() => []);
								if (!current()) return;
								if (
									organizations.some(
										(organization) => organization.id === created.id,
									)
								)
									openInSettings(created);
								onOpenChange(false);
							});
						}}
					>
						<Input
							className="h-7 min-w-0 flex-1"
							aria-label={message("settings:organizations_organization_name")}
							placeholder={message("settings:organizations_organization_name")}
							required
							maxLength={100}
							value={name}
							disabled={busy}
							onChange={(event) => setName(event.target.value)}
						/>
						<DitherActionButton
							type="submit"
							loading={busy}
							disabled={!name.trim()}
						>
							{message("settings:organizations_create")}
						</DitherActionButton>
					</form>
				</DialogPanel>
			</DialogPopup>
		</Dialog>
	);
}
