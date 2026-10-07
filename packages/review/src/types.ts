import type {
	ReviewFinding,
	ReviewLocation,
	ReviewSnapshot,
} from "@zuse/contracts";
import type { RepositoryContext } from "./context.ts";

export interface ReviewChange {
	readonly path: string;
	readonly previousPath?: string;
	readonly status: "added" | "modified" | "deleted" | "renamed";
	readonly excluded: boolean;
	readonly addedLines: readonly {
		readonly start: number;
		readonly end: number;
	}[];
	readonly deletedLines: readonly {
		readonly start: number;
		readonly end: number;
	}[];
}

export interface ReviewSearchHit {
	readonly location: ReviewLocation;
	readonly text: string;
}
export interface ReviewRelatedFile {
	readonly path: string;
	readonly kind: "imports" | "imported-by";
	readonly line: number;
}

/** A host must bind every read to the supplied immutable Git objects, never a live checkout. */
export interface ReviewSource {
	readonly snapshot: ReviewSnapshot;
	readonly changes: readonly ReviewChange[];
	readonly files: Readonly<Record<"LEFT" | "RIGHT", readonly string[]>>;
	readonly contextLimited: boolean;
	readonly search?: (
		query: string,
		side: "LEFT" | "RIGHT",
		limit: number,
	) => Promise<readonly ReviewSearchHit[]>;
	readonly relatedFiles?: (
		path: string,
		side: "LEFT" | "RIGHT",
	) => readonly ReviewRelatedFile[];
	readonly readFile: (
		side: "LEFT" | "RIGHT",
		path: string,
		signal: AbortSignal,
	) => Promise<string | null>;
}

export interface ReviewLimits {
	readonly maxFiles: number;
	readonly maxChangedLines: number;
	readonly maxFileBytes: number;
	readonly maxReadLines: number;
	readonly maxToolCalls: number;
	readonly maxSearchFiles: number;
	readonly maxSearchResults: number;
	readonly maxCandidates: number;
	readonly timeoutMs: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = Object.freeze({
	maxFiles: 50,
	maxChangedLines: 3_000,
	maxFileBytes: 1_500_000,
	maxReadLines: 300,
	maxToolCalls: 120,
	maxSearchFiles: 500,
	maxSearchResults: 30,
	maxCandidates: 30,
	timeoutMs: 600_000,
});

export interface ReviewTools {
	readonly relatedFiles: (
		path: string,
		side?: "LEFT" | "RIGHT",
	) => Promise<readonly ReviewRelatedFile[]>;
	readonly read: (location: ReviewLocation) => Promise<string>;
	/** Literal bounded search; query cannot run a regular expression or command. */
	readonly search: (
		query: string,
		side?: "LEFT" | "RIGHT",
	) => Promise<
		readonly { readonly location: ReviewLocation; readonly text: string }[]
	>;
}

export interface InvestigatorInput {
	readonly repositoryContext: RepositoryContext;
	readonly snapshot: ReviewSnapshot;
	readonly changes: readonly ReviewChange[];
	readonly tools: ReviewTools;
	readonly signal: AbortSignal;
}

export interface VerifierInput {
	readonly snapshot: ReviewSnapshot;
	readonly candidate: ReviewFinding;
	readonly tools: ReviewTools;
	readonly signal: AbortSignal;
}

/** Each invocation must create a fresh provider session; no investigator transcript is supplied. */
export type ReviewVerifier = (
	input: VerifierInput,
) => Promise<"confirmed" | "rejected">;

export interface ReviewEngineInput {
	readonly snapshot: ReviewSnapshot;
	readonly source: ReviewSource;
	readonly investigate: (input: InvestigatorInput) => Promise<unknown>;
	readonly verify: ReviewVerifier;
	readonly limits?: Partial<ReviewLimits>;
	readonly signal?: AbortSignal;
}
