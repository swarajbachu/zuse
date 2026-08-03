import { App } from "./app.tsx";
import { BrowserAccessGate } from "./components/browser-access-gate.tsx";
import { ToastProvider } from "./components/ui/toast.tsx";
import { AppAtomProvider } from "./state/registry.tsx";

export function Application() {
	return (
		<AppAtomProvider>
			<ToastProvider>
				<BrowserAccessGate>
					<App />
				</BrowserAccessGate>
			</ToastProvider>
		</AppAtomProvider>
	);
}
