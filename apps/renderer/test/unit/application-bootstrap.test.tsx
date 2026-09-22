import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationBootstrap } from "../../src/application-bootstrap.tsx";

const surface = vi.hoisted(() => ({
	retry: undefined as (() => void) | undefined,
}));
vi.mock("../../src/components/startup-surface.tsx", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../src/components/startup-surface.tsx")
		>();
	return {
		...actual,
		StartupSurface: (props: Parameters<typeof actual.StartupSurface>[0]) => {
			surface.retry = props.onRetry;
			return <actual.StartupSurface {...props} />;
		},
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
	surface.retry = undefined;
});

describe("application bootstrap", () => {
	it("mounts a bounded startup surface without suspending the root", () => {
		const markup = renderToStaticMarkup(<ApplicationBootstrap />);

		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain('aria-label="Loading Zuse"');
	});

	it("retries bootstrap with a fresh document instead of a cached failed import", () => {
		const reload = vi.fn();
		vi.stubGlobal("window", { location: { reload } });
		renderToStaticMarkup(<ApplicationBootstrap />);
		expect(surface.retry).toBeTypeOf("function");
		surface.retry?.();
		expect(reload).toHaveBeenCalledOnce();
	});
});
