import type { ComponentProps, JSX } from "react";

export function Card({
	className,
	...props
}: ComponentProps<"div">): JSX.Element {
	return <div className={className} data-slot="card" {...props} />;
}
