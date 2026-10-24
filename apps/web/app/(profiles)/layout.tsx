import type { ReactNode } from "react";
import { SiteDocument } from "@/components/site-document";

export default function ProfileLayout({ children }: { children: ReactNode }) {
	return <SiteDocument>{children}</SiteDocument>;
}
