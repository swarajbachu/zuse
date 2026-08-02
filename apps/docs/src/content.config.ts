import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const docs = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./content/docs" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		section: z.string(),
		order: z.number().int().nonnegative(),
		platforms: z.array(z.string()).default([]),
		providers: z.array(z.string()).default([]),
		prerequisites: z.array(z.string()).default([]),
		related: z.array(z.string()).default([]),
		next: z.string().optional(),
		lastVerified: z.string(),
	}),
});

const meta = defineCollection({
	loader: glob({ pattern: "**/*.{json,yaml,yml}", base: "./content/docs" }),
	schema: z.object({
		title: z.string().optional(),
		description: z.string().optional(),
		pages: z.array(z.string()).optional(),
		icon: z.string().optional(),
	}),
});

export const collections = { docs, meta };
