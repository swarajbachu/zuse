"use client";
import {
	BrainIcon,
	CodeIcon,
	FingerprintIcon,
	MouseBoxIcon,
	NativeIcon,
	WindowIcon,
} from "@/components/tpl/nodus/icons/bento-icons";
import { Badge } from "../badge";
import { Container } from "../container";
import { SectionHeading } from "../seciton-heading";
import { SubHeading } from "../subheading";
import { Card, CardDescription, CardTitle } from "./card";
import {
	AgentActivityGraphSkeleton,
	CliSessionSkeleton,
	WorkspaceSessionSkeleton,
} from "./skeletons";

export const AgenticIntelligence = () => {
	return (
		<Container className="border-divide border-x">
			<div className="flex flex-col items-center py-16">
				<Badge text="Zuse CLI" />
				<SectionHeading className="mt-4">
					Create the work. Add another session. Keep the context.
				</SectionHeading>

				<SubHeading as="p" className="mx-auto mt-6 max-w-lg px-2">
					Create a fresh worktree from the CLI, start provider sessions in the
					same chat, and keep the branch and attached context together.
				</SubHeading>
				<div className="border-divide divide-divide mt-16 grid grid-cols-1 divide-y border-y md:grid-cols-2 md:divide-x">
					<Card className="overflow-hidden mask-b-from-80%">
						<div className="flex items-center gap-2">
							<BrainIcon />
							<CardTitle>Create a fresh worktree</CardTitle>
						</div>
						<CardDescription>
							Run `zuse chat create --workspace fresh` to create the worktree,
							chat, and first provider session together.
						</CardDescription>
						<WorkspaceSessionSkeleton />
					</Card>
					<Card className="overflow-hidden mask-b-from-80%">
						<div className="flex items-center gap-2">
							<MouseBoxIcon />
							<CardTitle>Add Codex to the same workspace</CardTitle>
						</div>
						<CardDescription>
							Use `zuse session create` for another provider in the same chat
							and worktree; attach a plan or transcript when needed.
						</CardDescription>
						<CliSessionSkeleton />
					</Card>
				</div>
				<div className="w-full">
					<Card className="relative w-full max-w-none overflow-hidden">
						<div className="pointer-events-none absolute inset-0 h-full w-full bg-[radial-gradient(var(--color-dots)_1px,transparent_1px)] mask-radial-from-10% [background-size:10px_10px]"></div>
						<div className="flex items-center gap-2">
							<NativeIcon />
							<CardTitle>Create → implement → review</CardTitle>
						</div>
						<CardDescription>
							Follow each provider session against the same branch and inspect
							the resulting diff and check evidence in Zuse.
						</CardDescription>
						<AgentActivityGraphSkeleton />
					</Card>
				</div>
				<div className="grid grid-cols-1 gap-10 md:grid-cols-3">
					<Card>
						<div className="flex items-center gap-2">
							<FingerprintIcon />
							<CardTitle>Implementation evidence</CardTitle>
						</div>
						<CardDescription>
							The chat stays linked to its worktree; plans, transcripts, and
							files can be attached explicitly.
						</CardDescription>
					</Card>
					<Card>
						<div className="flex items-center gap-2">
							<CodeIcon />
							<CardTitle>Independent diff review</CardTitle>
						</div>
						<CardDescription>
							Start Codex in the same chat and ask it to inspect Claude Code's
							branch diff.
						</CardDescription>
					</Card>
					<Card>
						<div className="flex items-center gap-2">
							<WindowIcon />
							<CardTitle>GitHub follow-through</CardTitle>
						</div>
						<CardDescription>
							Inspect pull request state and checks, or attach failing Actions
							logs to an agent for diagnosis.
						</CardDescription>
					</Card>
				</div>
			</div>
		</Container>
	);
};
