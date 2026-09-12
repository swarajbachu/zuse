import {
	isWebsiteLocale,
	websiteLocales,
	websitePath,
} from "@zuse/i18n/registry";
import {
	useWebsiteMessages,
	WebsiteProvider,
	WebsiteRichMessage,
} from "@zuse/i18n/website/react";
import { loadWebsiteCatalog } from "@zuse/i18n/website/server";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import sitemap from "../app/sitemap";
import { websiteAlternates } from "./website-localization";

function Probe() {
	const { message, locale } = useWebsiteMessages();
	return React.createElement(
		"h1",
		{ lang: locale },
		message("landing:meta_title"),
	);
}
describe("website localization", () => {
	it("uses stable English and locale paths, with no pseudo-language route", () => {
		expect(websitePath("en")).toBe("/");
		expect(websitePath("zh-Hant")).toBe("/zh-Hant");
		expect(isWebsiteLocale("en-XA")).toBe(false);
		expect(isWebsiteLocale("../../de")).toBe(false);
		expect(isWebsiteLocale("de")).toBe(true);
	});
	it("renders concurrent locale requests without sharing mutable translation state", async () => {
		const results = await Promise.all(
			websiteLocales.map(async (locale) => {
				const messages = await loadWebsiteCatalog(locale);
				const html = renderToStaticMarkup(
					<WebsiteProvider locale={locale} messages={messages}>
						<Probe />
					</WebsiteProvider>,
				);
				expect(html).toContain(`lang="${locale}"`);
				expect(html).toContain(messages["landing:meta_title"]);
				return messages["landing:meta_title"];
			}),
		);
		expect(new Set(results).size).toBe(7);
	});
	it("escapes interpolation and allows only explicitly supplied rich components", async () => {
		const messages = await loadWebsiteCatalog("en");
		const html = renderToStaticMarkup(
			<WebsiteProvider
				locale="en"
				messages={{
					...messages,
					"landing:all_your_coding_agents_one_workspace":
						"{{input}} <part0>Workspace</part0>",
				}}
			>
				<WebsiteRichMessage
					id="landing:all_your_coding_agents_one_workspace"
					values={{ input: '<img src=x onerror="alert(1)">' }}
					components={{ part0: <strong /> }}
				/>
			</WebsiteProvider>,
		);
		expect(html).toContain("&lt;img");
		expect(html).not.toContain("<img");
		expect(html).toContain("<strong>Workspace</strong>");
	});
	it("includes reciprocal sitemap alternates and an English x-default", () => {
		const alternates = websiteAlternates();
		expect(Object.keys(alternates)).toHaveLength(8);
		expect(alternates["x-default"]).toBe(alternates.en);
		const entries = sitemap().filter((entry) => entry.alternates?.languages);
		expect(entries).toHaveLength(7);
		for (const entry of entries)
			expect(entry.alternates?.languages).toEqual(alternates);
	});
});
