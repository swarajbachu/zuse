import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Register our custom font-size tokens (see app/globals.css) so tailwind-merge
// treats them as font sizes instead of misclassifying them as text colors and
// dropping them when combined with utilities like `text-transparent`.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-page-header",
        "text-page-header-md",
        "text-page-header-lg",
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
