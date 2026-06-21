"use client";

import { motion } from "motion/react";

const stars = [
  { cx: 1, cy: 12, r: 1 },
  { cx: 122, cy: 113, r: 1 },
  { cx: 108, cy: 57, r: 1 },
  { cx: 510, cy: 96, r: 1 },
  { cx: 700, cy: 93, r: 1 },
  { cx: 625, cy: 126, r: 1 },
  { cx: 821, cy: 32, r: 1 },
  { cx: 203.5, cy: 157.5, r: 0.5 },
  { cx: 167.5, cy: 94.5, r: 0.5 },
  { cx: 76.5, cy: 81.5, r: 0.5 },
  { cx: 157.5, cy: 8.5, r: 0.5 },
  { cx: 240.5, cy: 80.5, r: 0.5 },
  { cx: 256.5, cy: 64.5, r: 0.5 },
  { cx: 273.5, cy: 84.5, r: 0.5 },
  { cx: 285.5, cy: 57.5, r: 0.5 },
  { cx: 227.5, cy: 114.5, r: 0.5 },
  { cx: 202.5, cy: 55.5, r: 0.5 },
  { cx: 156.5, cy: 65.5, r: 0.5 },
  { cx: 330.5, cy: 88.5, r: 0.5 },
  { cx: 363.5, cy: 102.5, r: 0.5 },
  { cx: 476.5, cy: 80.5, r: 0.5 },
  { cx: 438.5, cy: 107.5, r: 0.5 },
  { cx: 422.5, cy: 77.5, r: 0.5 },
  { cx: 455.5, cy: 56.5, r: 0.5 },
  { cx: 488.5, cy: 35.5, r: 0.5 },
  { cx: 313.5, cy: 66.5, r: 0.5 },
  { cx: 231.5, cy: 0.5, r: 0.5 },
  { cx: 270.5, cy: 108.5, r: 0.5 },
  { cx: 573, cy: 103, r: 0.5 },
  { cx: 501.5, cy: 150.5, r: 0.5 },
  { cx: 456.5, cy: 156.5, r: 0.5 },
  { cx: 659.5, cy: 77.5, r: 0.5 },
  { cx: 746, cy: 52, r: 0.5 },
  { cx: 591.5, cy: 1.5, r: 0.5 },
  { cx: 389, cy: 123, r: 1 },
  { cx: 40, cy: 72, r: 1 },
];

// Deterministic pseudo-random in [0, 1) so SSR and client render match.
const seeded = (seed: number) => {
  const x = Math.sin(seed * 99.7) * 10000;
  return x - Math.floor(x);
};

export const Stars = () => {
  return (
    <motion.svg
      width="822"
      height="158"
      viewBox="0 0 822 158"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.5, ease: "easeInOut" }}
    >
      {stars.map((star, i) => (
        <motion.circle
          key={i}
          cx={star.cx}
          cy={star.cy}
          r={star.r}
          fill="white"
          initial={{ opacity: 0.2 }}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{
            duration: 2 + seeded(i) * 3,
            delay: 1.2 + seeded(i + 100) * 2.5,
            repeat: Infinity,
            repeatType: "loop",
            ease: "easeInOut",
          }}
        />
      ))}
    </motion.svg>
  );
};
