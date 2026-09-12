import { isWebsiteLocale, websiteLocales } from "@zuse/i18n/registry";
import { notFound, permanentRedirect } from "next/navigation";
import { getLandingMetadata, LandingPage } from "@/components/landing/page";
export function generateStaticParams() {
	return websiteLocales.map((locale) => ({ locale }));
}
export async function generateMetadata({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	if (!isWebsiteLocale(locale)) notFound();
	return getLandingMetadata(locale);
}
export default async function Page({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	if (!isWebsiteLocale(locale)) notFound();
	if (locale === "en") permanentRedirect("/");
	return <LandingPage locale={locale} />;
}
