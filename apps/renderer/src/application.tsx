import { App } from "./app.tsx";
import { ToastProvider } from "./components/ui/toast.tsx";
import { AppAtomProvider } from "./state/registry.tsx";

export function Application() {
	return (
		<AppAtomProvider>
			<ToastProvider>
				<App />
			</ToastProvider>
		</AppAtomProvider>
	);
}
