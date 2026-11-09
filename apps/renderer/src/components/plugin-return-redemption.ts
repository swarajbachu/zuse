import "@zuse/i18n/english/plugins";
import { message } from "@zuse/i18n";
import type { PluginReturn } from "../lib/plugin-return.ts";
import { pluginConnectErrorKey } from "../lib/plugin-servers.ts";
import {
	claimPluginFailure,
	notifyPluginsChanged,
	pluginRequest,
} from "../lib/plugins-client.ts";
import { toastManager } from "./ui/toast.tsx";

export async function redeemPluginReturn(value: PluginReturn) {
	const name = value.plugin ?? message("plugins:plugins_title");
	if (value.ticket === null) {
		toastManager.add({
			title: message(
				value.error === "cancelled"
					? "plugins:plugins_return_cancelled"
					: "plugins:plugins_connect_failed",
				{ name },
			),
			description:
				value.error === "cancelled"
					? message("plugins:plugins_return_cancelled_detail")
					: (value.error ?? message("plugins:plugins_return_failed_detail")),
			type: "error",
		});
		notifyPluginsChanged(value.tenantId);
		return;
	}
	try {
		const result = await pluginRequest({
			action: "complete",
			tenantId: value.tenantId,
			ticket: value.ticket,
		});
		if (result.kind === "attempt" && result.state === "failed") {
			if (claimPluginFailure(result.id))
				toastManager.add({
					title: message("plugins:plugins_connect_failed", { name }),
					description: message(pluginConnectErrorKey(result.error, false)),
					type: "error",
				});
			return;
		}
		if (result.kind !== "attempt" || result.state !== "connected")
			throw new Error("Connection did not complete");
		toastManager.add({
			title: message("plugins:plugins_connected_toast", { name }),
			description: message("plugins:plugins_connected_toast_detail"),
			type: "success",
		});
	} catch {
		toastManager.add({
			title: message("plugins:plugins_connect_failed", { name }),
			description: message("plugins:plugins_return_failed_detail"),
			type: "error",
		});
	} finally {
		notifyPluginsChanged(value.tenantId);
	}
}
