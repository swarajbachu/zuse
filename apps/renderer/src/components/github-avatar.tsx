import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";

/** Use GitHub's supplied user or app image, with a visible fallback while
 * loading or unavailable. A display name is never a profile-image URL. */
export function GitHubAvatar({
	name,
	url,
	className = "size-5",
}: {
	name: string;
	url?: string | null;
	className?: string;
}) {
	return (
		<Avatar className={className} title={name}>
			{url ? (
				<AvatarImage src={url} alt={name} referrerPolicy="no-referrer" />
			) : null}
			<AvatarFallback
				aria-label={name}
				className="text-[10px] text-muted-foreground"
			>
				{name.trim().slice(0, 1).toUpperCase() || "?"}
			</AvatarFallback>
		</Avatar>
	);
}
