import { useState } from "react";

/** GitHub returns different avatar URLs for users, bots, and apps. Never
 * reconstruct one from a display name or guess a service's user account. */
export function GitHubAvatar({
	name,
	url,
	className = "size-5",
}: {
	name: string;
	url?: string | null;
	className?: string;
}) {
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	return url && url !== failedUrl ? (
		<img
			src={url}
			alt=""
			title={name}
			loading="lazy"
			referrerPolicy="no-referrer"
			onError={() => setFailedUrl(url)}
			className={`${className} shrink-0 rounded-full bg-muted object-cover`}
		/>
	) : (
		<span
			role="img"
			aria-label={name}
			title={name}
			className={`${className} grid shrink-0 place-items-center rounded-full bg-muted text-[10px] text-muted-foreground`}
		>
			{name.trim().slice(0, 1).toUpperCase() || "?"}
		</span>
	);
}
