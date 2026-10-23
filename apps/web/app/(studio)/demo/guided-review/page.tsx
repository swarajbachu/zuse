import type { Metadata } from "next";
import { GuidedReviewDemo } from "@/components/demo/guided-review/guided-review-demo";

export const metadata: Metadata = {
	title: "Guided review demo — Zuse",
	description:
		"Walk through a real Zuse pull request the way Zuse shows it: an overview, a guide in reading order beside the code, and the full diff.",
	alternates: { canonical: "/demo/guided-review" },
};

export default function GuidedReviewDemoPage() {
	return <GuidedReviewDemo />;
}
