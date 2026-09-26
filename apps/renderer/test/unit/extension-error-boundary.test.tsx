// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExtensionErrorBoundary } from "../../src/lib/extension-error-boundary.tsx";

it("retries a previously failed renderer when its registration is replaced", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const node = document.createElement("div");
	const root = createRoot(node);
	function Broken(): never {
		throw new Error("broken");
	}
	try {
		await act(async () =>
			root.render(
				<ExtensionErrorBoundary
					extensionId="test"
					resetKey="old"
					fallback={<p>Failed</p>}
				>
					<Broken />
				</ExtensionErrorBoundary>,
			),
		);
		expect(node.textContent).toBe("Failed");
		await act(async () =>
			root.render(
				<ExtensionErrorBoundary
					extensionId="test"
					resetKey="new"
					fallback={<p>Failed</p>}
				>
					<p>Recovered</p>
				</ExtensionErrorBoundary>,
			),
		);
		expect(node.textContent).toBe("Recovered");
	} finally {
		await act(async () => root.unmount());
		error.mockRestore();
	}
});
