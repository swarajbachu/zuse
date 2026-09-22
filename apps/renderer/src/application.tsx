import { App } from "./app.tsx";
import { ToastProvider } from "./components/ui/toast.tsx";
import { AppAtomProvider } from "./state/registry.tsx";

export function Application({ onReady }: { readonly onReady?: () => void }) {
	return (
		<AppAtomProvider>
			<ToastProvider>
				<App onReady={onReady} />
			</ToastProvider>
		</AppAtomProvider>
	);
}
