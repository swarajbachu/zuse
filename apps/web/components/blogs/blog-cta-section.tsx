import { Button } from "@/components/button";
export const BlogCtaSection = () => (
	<section className="mx-5 flex flex-col items-start gap-6 border-y border-dotted border-border py-10 md:mx-16 md:flex-row md:items-center md:justify-between">
		<div>
			<p className="editorial-label">Put it into practice</p>
			<h2 className="mt-3 text-3xl">Your next idea, in motion.</h2>
		</div>
		<Button />
	</section>
);
