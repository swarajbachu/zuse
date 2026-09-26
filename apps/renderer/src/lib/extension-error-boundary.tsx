import "@zuse/i18n/english/extensions";
import { useMessages as useExtensionMessages } from "@zuse/i18n/react";
import * as React from "react";

export class ExtensionErrorBoundary extends React.Component<
	React.PropsWithChildren<{
		readonly extensionId: string;
		readonly fallback?: React.ReactNode;
		readonly resetKey?: unknown;
	}>,
	{ readonly failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch(cause: unknown) {
		console.error(
			`[extension:${this.props.extensionId}] renderer contribution failed`,
			cause,
		);
	}
	override componentDidUpdate(previous: Readonly<typeof this.props>) {
		if (previous.resetKey !== this.props.resetKey && this.state.failed)
			this.setState({ failed: false });
	}
	override render() {
		return this.state.failed
			? (this.props.fallback ?? <ExtensionFailureMessage />)
			: this.props.children;
	}
}

function ExtensionFailureMessage() {
	const { message } = useExtensionMessages(["extensions"]);
	return (
		<p className="p-3 text-xs text-destructive">
			{message("extensions:failed")}
		</p>
	);
}
