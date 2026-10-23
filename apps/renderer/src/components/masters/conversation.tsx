import "@zuse/i18n/english/projects";
import {
	EnvironmentId,
	type MasterSnapshot,
	type Session,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { lazy, type ReactNode, Suspense } from "react";
import { useSessionTimelineResource } from "../../lib/session-timeline-client-bus.ts";
import { ZOT_EXAMPLE_BRIEFS } from "../../lib/zot-guide.ts";
import { composerDraftKeyForSession } from "../../store/composer-drafts.ts";
import { useZotOnboardingStore } from "../../store/zot-onboarding.ts";
import { FloatingComposerLayout } from "../floating-composer-layout.tsx";
import { Button } from "../ui/button.tsx";
import { avatarFor, Mascot, type MascotState } from "./mascot.tsx";
import { RepositoryIcon } from "./repositories.tsx";
import { useZotExample } from "./zot-guide.tsx";

const ChatView = lazy(() =>
	import("../chat-view.tsx").then((module) => ({ default: module.ChatView })),
);
const ChatComposer = lazy(() =>
	import("../chat-composer.tsx").then((module) => ({
		default: module.ChatComposer,
	})),
);

/** Transcript length after which a fresh chat is suggested. */
const RENEW_SUGGESTION_MESSAGES = 80;

export function MasterConversation({
	snapshot,
	session,
	environmentId,
	mascotState,
}: {
	readonly snapshot: MasterSnapshot;
	readonly session: Session;
	readonly environmentId: string;
	readonly mascotState: MascotState;
}) {
	const { message } = useMessages("projects");
	const environment = EnvironmentId.make(environmentId);
	const timeline = useSessionTimelineResource({
		environmentId: environment,
		sessionId: session.id,
	});
	const empty =
		timeline.data === null
			? snapshot.coordinatorMessageCount === 0
			: timeline.data.messages.length === 0;

	const notice =
		snapshot.unavailableEnvironments.length > 0
			? message(
					"projects:masters_some_environments_are_offline_their_workers_remain_attached_reconnect_to_refresh_their_status",
				)
			: snapshot.coordinatorMessageCount > RENEW_SUGGESTION_MESSAGES
				? message("projects:masters_renew_suggestion")
				: null;
	const composer = (
		<Suspense fallback={<div className="h-28" aria-busy="true" />}>
			{notice ? (
				<p className="truncate px-3 pb-1.5 text-[11px] text-muted-foreground">
					{notice}
				</p>
			) : null}
			<div data-zot-guide="brief">
				<ChatComposer
					key={session.id}
					session={session}
					environmentId={environment}
					workspaceRootOverride={snapshot.workspacePath}
					constrain={false}
					variant="minimal"
					placeholder={message("projects:masters_composer_placeholder", {
						name: snapshot.master.settings.name,
					})}
				/>
			</div>
		</Suspense>
	);

	if (empty)
		return (
			<MasterHero
				master={snapshot.master}
				mascotState={mascotState}
				draftKey={composerDraftKeyForSession({
					environmentId: environment,
					sessionId: session.id,
				})}
			>
				{composer}
			</MasterHero>
		);

	return (
		<div className="chat-session-layout relative flex min-h-0 min-w-0 flex-1 flex-col">
			<FloatingComposerLayout
				transcript={(endInset) => (
					<Suspense fallback={null}>
						<ChatView
							session={session}
							sessionId={session.id}
							environmentId={environment}
							endInset={endInset}
						/>
					</Suspense>
				)}
				composer={composer}
			/>
		</div>
	);
}

/**
 * First-run state: the Master itself, one question, the composer, and
 * example briefs that fill in (never send) a first message.
 */
function MasterHero({
	master,
	mascotState,
	draftKey,
	children,
}: {
	readonly master: MasterSnapshot["master"];
	readonly mascotState: MascotState;
	readonly draftKey: string;
	readonly children: ReactNode;
}) {
	const { message } = useMessages("projects");
	const guideOpen = useZotOnboardingStore((state) => state.open);
	const tryExample = useZotExample(draftKey);
	const name = master.settings.name;
	return (
		<div className="chat-session-layout relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-4 max-[800px]:px-4">
			<div className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 pb-[10vh]">
				<div className="flex flex-col items-center gap-2">
					<Mascot
						avatar={avatarFor(master)}
						state={mascotState}
						size="large"
						px={112}
						seed={master.id}
						label={name}
					/>
					<span className="rounded-full bg-muted/60 px-3 py-0.5 text-[13px] font-medium text-foreground">
						{name}
					</span>
					<p className="text-center text-sm text-muted-foreground">
						{master.repositories.length
							? message("projects:masters_empty_prompt", { name })
							: message("projects:masters_hero_no_repositories", { name })}
					</p>
					{guideOpen ? null : (
						<Button
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
							onClick={useZotOnboardingStore.getState().start}
						>
							{message("projects:masters_guide_how")}
						</Button>
					)}
				</div>
				<div className="flex w-full flex-col gap-3">
					{children}
					{tryExample ? (
						<div className="flex flex-wrap items-center justify-center gap-1.5">
							{ZOT_EXAMPLE_BRIEFS.map((example) => (
								<Button
									key={example}
									variant="ghost"
									size="sm"
									className="rounded-full bg-muted/45 text-muted-foreground hover:text-foreground"
									onClick={() => tryExample(example)}
								>
									{message(`projects:masters_guide_example_${example}`)}
								</Button>
							))}
						</div>
					) : null}
				</div>
				{master.repositories.length > 0 ? (
					<ul className="flex flex-wrap justify-center gap-1.5">
						{master.repositories.map((repository) => (
							<li
								key={`${repository.environmentId}:${repository.folderId}`}
								className="flex h-6 items-center gap-1.5 rounded-full bg-muted/45 px-2.5 text-[11px] text-muted-foreground"
							>
								<RepositoryIcon repository={repository} />
								{repository.name}
							</li>
						))}
					</ul>
				) : null}
			</div>
		</div>
	);
}
