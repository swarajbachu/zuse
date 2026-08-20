"use client";

import { RemoteWorldMap } from "./remote-world-map";

export function EdgeComputing() {
	return (
		<section className="bg-card overflow-hidden px-6 pt-12 md:px-10 md:pt-16">
			<div className="mx-auto max-w-2xl text-center">
				<h2 className="text-heading text-3xl font-semibold tracking-tight md:text-4xl">
					Remote access, any machine
				</h2>
				<p className="text-muted-foreground mx-auto mt-4 max-w-xl text-balance text-sm leading-6 md:text-base md:leading-7">
					Open the Zuse environment already running on another computer from the
					web or iPhone. Use Zuse Serve for a headless Mac or Linux host.
				</p>
			</div>

			<RemoteWorldMap className="mt-8 md:mt-10" />
		</section>
	);
}
