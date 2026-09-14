import { SiteDocument } from "@/components/site-document";

export { metadata } from "@/components/site-document";
export default function Layout({ children }: { children: React.ReactNode }) {
	return <SiteDocument>{children}</SiteDocument>;
}
