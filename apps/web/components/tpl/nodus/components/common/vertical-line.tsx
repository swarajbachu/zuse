import { motion } from "motion/react";
import { useId } from "react";

export const VerticalLine = (
	props: React.SVGProps<SVGSVGElement> & { stopColor?: string },
) => {
	const gradientId = useId();
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="1"
			height="81"
			viewBox="0 0 1 81"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className="shrink-0"
			{...props}
		>
			<line
				y1="-0.5"
				x2="80"
				y2="-0.5"
				transform="matrix(0 -1 -1 0 0 80.5)"
				stroke="var(--color-line)"
			/>
			<line
				y1="-0.5"
				x2="80"
				y2="-0.5"
				transform="matrix(0 -1 -1 0 0 80.5)"
				stroke={`url(#${gradientId})`}
			/>
			<defs>
				<motion.linearGradient
					id={gradientId}
					initial={{
						x1: 0,
						x2: 2,
						y1: "0%",
						y2: "0%",
					}}
					animate={{
						x1: 0,
						x2: 2,
						y1: "80%",
						y2: "100%",
					}}
					transition={{
						duration: 4,
						repeat: Infinity,
						repeatType: "loop",
						ease: "easeInOut",
						repeatDelay: 1,
					}}
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="var(--color-line)" />
					<stop offset="0.5" stopColor="#F17463" />
					<stop offset="1" stopColor="var(--color-line)" />
				</motion.linearGradient>
			</defs>
		</svg>
	);
};
