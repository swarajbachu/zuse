import type { DeviceCommandDecision } from "@zuse/contracts";
export const DEVICE_PERMISSION_CHOICES: ReadonlyArray<
	readonly [DeviceCommandDecision, string]
> = [
	["AllowOnce", "Allow once"],
	["AllowForSession", "Allow for this session"],
	["AlwaysAllow", "Always allow"],
	["Deny", "Deny"],
];
export const DEVICE_PERMISSION_DESCRIPTION =
	"Shell access lets cloud agents read and change files on this computer. Session access lasts for this chat; Always allow applies to your cloud chats until revoked.";
