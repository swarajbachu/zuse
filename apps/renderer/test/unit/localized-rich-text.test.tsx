import { activateLocale, prepareLocale } from "@zuse/i18n";
import { RichMessage } from "@zuse/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

it("renders interpolated content as text, even when it contains markup", async () => {
	await prepareLocale("fr", ["usage"]);
	await activateLocale("fr");
	try {
		const html = renderToStaticMarkup(
			<RichMessage
				id="usage:usage_dashboard_view_all"
				values={{ value1: '<img src=x onerror="alert(1)"> & literal' }}
				components={{}}
			/>,
		);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
		expect(html).toContain("&amp; literal");
	} finally {
		await activateLocale("en");
	}
});
