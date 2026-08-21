import { motion } from "motion/react";
import { useId } from "react";

export const HorizontalLine = (props: React.SVGProps<SVGSVGElement>) => {
	const gradientId = useId();
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="314"
			height="2"
			viewBox="0 0 314 2"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<line
				x1="0.5"
				y1="1"
				x2="313.5"
				y2="1"
				stroke="var(--color-gray-400)"
				strokeLinecap="round"
			/>
			<line
				x1="0.5"
				y1="1"
				x2="313.5"
				y2="1"
				stroke={`url(#${gradientId})`}
				strokeLinecap="round"
			/>
			<defs>
				<motion.linearGradient
					id={gradientId}
					initial={{
						y1: 0,
						y2: 1,
						x1: "-10%",
						x2: "0%",
					}}
					animate={{
						y1: 0,
						y2: 1,
						x1: "110%",
						x2: "120%",
					}}
					transition={{
						duration: 2,
						repeat: Infinity,
						repeatType: "loop",
						ease: "easeInOut",
						repeatDelay: 1,
					}}
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#EAEDF1" />
					<stop offset="0.5" stopColor="var(--color-blue-500)" />
					<stop offset="1" stopColor="#EAEDF1" />
				</motion.linearGradient>
			</defs>
		</svg>
	);
};
