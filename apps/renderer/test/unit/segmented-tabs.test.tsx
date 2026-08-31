import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SegmentedTabs } from "../../src/components/ui/segmented-tabs.tsx";

describe("SegmentedTabs", () => {
	it("renders a compact accessible tab set with one selected option", () => {
		const markup = renderToStaticMarkup(
			<SegmentedTabs
				value="link"
				ariaLabel="Connection method"
				onValueChange={vi.fn()}
				options={[
					{ value: "link", label: "Connect link" },
					{ value: "ssh", label: "SSH" },
				]}
			/>,
		);

		expect(markup).toContain('role="tablist"');
		expect(markup).toContain('aria-label="Connection method"');
		expect(markup.match(/role="tab"/gu)).toHaveLength(2);
		expect(markup.match(/aria-selected="true"/gu)).toHaveLength(1);
		expect(markup).toContain("Connect link");
		expect(markup).toContain("SSH");
	});
});
