import { getLandingMetadata, LandingPage } from "@/components/landing/page";
export const generateMetadata = () => getLandingMetadata("en");
export default function Home() {
	return <LandingPage locale="en" />;
}
