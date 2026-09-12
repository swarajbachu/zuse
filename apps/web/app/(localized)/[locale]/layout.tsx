import { isWebsiteLocale } from "@zuse/i18n/registry";
import { notFound } from "next/navigation";
import { SiteDocument } from "@/components/site-document";
export default async function Layout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	if (!isWebsiteLocale(locale)) notFound();
	return <SiteDocument locale={locale}>{children}</SiteDocument>;
}
