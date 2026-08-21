import { ShimmerText } from "./shimmer-text";

export const Badge = ({ text }: { text: string }) => {
	return (
		<ShimmerText
			duration={1.2}
			className="text-sm font-normal [--base-color:var(--color-brand)] [--base-gradient-color:var(--color-white)] dark:[--base-color:var(--color-brand)] dark:[--base-gradient-color:var(--color-white)]"
		>
			{text}
		</ShimmerText>
	);
};
