import { DitherAvatar } from "@repo/ui/dither";
import { useState } from "react";

/**
 * Identity for organization settings rows: the real picture when there is
 * one, otherwise (or if it fails to load) a dithered avatar seeded with a
 * stable id so the same account looks the same everywhere.
 */
export function OrganizationAvatar({
	seed,
	imageUrl,
}: {
	seed: string;
	imageUrl?: string;
}) {
	const [failed, setFailed] = useState(false);
	if (imageUrl && !failed)
		return (
			<img
				src={imageUrl}
				alt=""
				aria-hidden
				width={28}
				height={28}
				loading="lazy"
				referrerPolicy="no-referrer"
				onError={() => setFailed(true)}
				className="block size-7 shrink-0 rounded-md bg-muted/40 object-cover"
			/>
		);
	return (
		<span aria-hidden className="block">
			<DitherAvatar name={seed} size={28} className="rounded-md bg-muted/40" />
		</span>
	);
}
