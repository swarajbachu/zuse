import { SiteDocument } from "@/components/site-document";

export { metadata } from "@/components/site-document";
export default function StudioLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <SiteDocument studio>{children}</SiteDocument>;
}
