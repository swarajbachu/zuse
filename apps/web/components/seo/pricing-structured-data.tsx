import { JsonLd } from "@/components/seo/json-ld";
import { PRICING_PLANS } from "@/lib/pricing";
import { siteConfig } from "@/lib/seo";

export function createPricingStructuredData() {
	const url = new URL("/pricing", siteConfig.url).toString();
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Product",
				"@id": `${url}#product`,
				name: siteConfig.name,
				description:
					"Zuse is an open source workspace for local and cloud coding agents. Local use is free during beta; Cloud Workspace is $40 per month.",
				url,
				image: new URL(siteConfig.ogImage, siteConfig.url).toString(),
				brand: {
					"@type": "Organization",
					name: siteConfig.name,
					url: siteConfig.url,
				},
				offers: PRICING_PLANS.map(({ name, offer }) => ({
					"@type": "Offer",
					name,
					url,
					price: offer.amount,
					priceCurrency: "USD",
					description: offer.description,
					availability: `https://schema.org/${offer.availability}`,
					...(offer.billedMonthly
						? {
								priceSpecification: {
									"@type": "UnitPriceSpecification",
									price: offer.amount,
									priceCurrency: "USD",
									unitCode: "MON",
									billingDuration: 1,
								},
							}
						: {}),
				})),
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{
						"@type": "ListItem",
						position: 1,
						name: siteConfig.name,
						item: siteConfig.url,
					},
					{ "@type": "ListItem", position: 2, name: "Pricing", item: url },
				],
			},
		],
	};
}

export function PricingStructuredData() {
	return <JsonLd data={createPricingStructuredData()} />;
}
