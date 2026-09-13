"use client";

import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import type React from "react";
import { usePlatformOnline } from "~/lib/network-status";
import { cn } from "~/lib/utils";

export function Avatar({
	className,
	...props
}: AvatarPrimitive.Root.Props): React.ReactElement {
	return (
		<AvatarPrimitive.Root
			className={cn(
				"inline-flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-background align-middle font-medium text-xs",
				className,
			)}
			data-slot="avatar"
			{...props}
		/>
	);
}

export function AvatarImage({
	className,
	...props
}: AvatarPrimitive.Image.Props): React.ReactElement {
	const online = usePlatformOnline();
	return (
		<AvatarPrimitive.Image
			key={online ? "online" : "offline"}
			className={cn("size-full object-cover", className)}
			data-slot="avatar-image"
			{...props}
		/>
	);
}

export function AvatarFallback({
	className,
	...props
}: AvatarPrimitive.Fallback.Props): React.ReactElement {
	return (
		<AvatarPrimitive.Fallback
			className={cn(
				"flex size-full items-center justify-center rounded-full bg-muted",
				className,
			)}
			data-slot="avatar-fallback"
			{...props}
		/>
	);
}

export { AvatarPrimitive };
