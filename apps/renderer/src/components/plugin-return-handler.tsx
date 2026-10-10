import "@zuse/i18n/english/plugins";
import { message } from "@zuse/i18n";
import { useEffect, useState } from "react";
import { useAuth } from "~/hooks/use-auth.ts";
import {
	clearStoredPluginReturn,
	type PluginReturn,
	parsePluginReturn,
	takeUrlPluginReturn,
} from "~/lib/plugin-return.ts";
import { notifyPluginsChanged, pluginRequest } from "~/lib/plugins-client.ts";
import { useUiStore } from "~/store/ui.ts";
import { toastManager } from "./ui/toast.tsx";

// Tickets are single-use; a duplicate loopback hit or re-render must not
// redeem twice or toast twice.
const seen = new Set<string>();

async function redeem(value: PluginReturn) {
	const name = value.plugin ?? message("plugins:plugins_title");
	if (value.ticket === null) {
		toastManager.add({
			title: message("plugins:plugins_return_cancelled", { name }),
			description: message("plugins:plugins_return_cancelled_detail"),
			type: "error",
		});
		return;
	}
	try {
		const result = await pluginRequest({
			action: "complete",
			tenantId: value.tenantId,
			ticket: value.ticket,
		});
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

/**
 * Finishes plugin connections automatically when the browser returns from the
 * provider. No extra confirmation: holding the ticket proves this browser
 * finished consent and the API checks it's the account that started it.
 */
export function PluginReturnHandler() {
	const { isSignedIn } = useAuth();
	const [queue, setQueue] = useState<PluginReturn[]>(() => {
		const initial = takeUrlPluginReturn();
		return initial === null ? [] : [initial];
	});
	useEffect(() => {
		const plugins = window.zuse?.plugins;
		if (plugins === undefined) return;
		const unsubscribe = plugins.onReturn((raw) => {
			const value = parsePluginReturn(raw);
			if (value !== null) setQueue((current) => [...current, value]);
		});
		plugins.subscribeReturns();
		return unsubscribe;
	}, []);
	useEffect(() => {
		if (!isSignedIn || queue.length === 0) return;
		setQueue([]);
		clearStoredPluginReturn();
		for (const value of queue) {
			const id = value.ticket ?? `${value.tenantId}:${value.error}`;
			if (seen.has(id)) continue;
			seen.add(id);
			// The web app returns on its root; bring the user back to Plugins.
			if (window.zuse === undefined) {
				useUiStore.getState().setView("chat");
				useUiStore.getState().setActiveMainTab("plugins");
			}
			void redeem(value);
		}
	}, [isSignedIn, queue]);
	return null;
}
