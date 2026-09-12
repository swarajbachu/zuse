"use client";
import {
	useWebsiteMessages,
	type WebsiteMessage,
	WebsiteRichMessage,
} from "@zuse/i18n/website/react";
import Link from "next/link";
import React from "react";
import { Container } from "@/components/container";
import { Header } from "@/components/header";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { GITHUB_URL } from "@/lib/site";

const getData = (t: WebsiteMessage) => [
	{
		question: t("faq:what_does_zuse_actually_do"),
		answer: t(
			"faq:zuse_puts_your_coding_agents_repositories_terminals_files_and_diffs_in",
		),
	},
	{
		question: t("faq:what_happens_when_i_want_to_switch_agents"),
		answer: t(
			"faq:you_choose_the_next_provider_instead_of_zuse_silently_routing_your_mes",
		),
	},
	{
		question: t("faq:which_agents_are_supported"),
		answer: t(
			"faq:zuse_supports_seven_coding_agent_clis_in_one_workspace_connect_the_pro",
		),
	},
	{
		question: t("faq:do_i_need_my_own_api_keys_or_subscriptions"),
		answer: t(
			"faq:yes_zuse_is_bring_your_own_keys_you_plug_in_your_own_provider_keys_or",
		),
	},
	{
		question: t("faq:is_my_code_or_data_sent_anywhere"),
		answer: t(
			"faq:local_and_ssh_chats_stay_on_the_computers_you_choose_when_you_use_the",
		),
	},
	{
		question: t("faq:which_operating_systems_are_supported"),
		answer: t(
			"faq:zuse_beta_ships_for_macos_and_x64_linux_the_download_button_selects_th",
		),
	},
	{
		question: t("faq:how_much_does_it_cost"),
		answer: t(
			"faq:the_zuse_desktop_beta_is_available_now_and_uses_your_own_agent_subscri",
		),
	},
	{
		question: t("faq:can_i_run_multiple_agents_at_once"),
		answer: t(
			"faq:yes_you_can_run_several_agents_in_parallel_each_in_its_own_chat_with_i",
		),
	},
	{
		question: t("faq:what_is_sub_agent_delegation"),
		answer: t(
			"faq:a_lead_agent_can_spawn_sub_agents_to_handle_parts_of_a_task_including",
		),
	},
];

export const FAQ = () => {
	const { message: t } = useWebsiteMessages();

	return (
		<section id="faq" className="w-full scroll-mt-24">
			<Container className="grid grid-cols-1 gap-15 py-20 md:py-30 lg:grid-cols-2">
				<div className="flex flex-col gap-4 pt-8">
					<Header>{t("faq:questions_devs_ask_first")}</Header>
					<div className="-tracking-xs text-muted-foreground text-base leading-6 font-medium">
						<WebsiteRichMessage
							id="faq:more_questions_see_the_project_on_github"
							values={{}}
							components={{
								part0: (
									<Link
										href={GITHUB_URL}
										target="_blank"
										rel="noopener noreferrer"
										className="text-primary underline underline-offset-3"
									/>
								),
							}}
						/>
					</div>
				</div>
				<div className="h-full w-full">
					<Accordion defaultValue={[getData(t)[0].question]}>
						{getData(t).map((item, index) => (
							<React.Fragment key={item.question}>
								<AccordionItem value={item.question} className="py-4">
									<AccordionTrigger className="-tracking-xs text-foreground text-base leading-6 font-medium">
										{item.question}
									</AccordionTrigger>
									<AccordionContent className="text-muted-foreground">
										{item.answer}
									</AccordionContent>
								</AccordionItem>
								{getData(t).length - 1 !== index && (
									<div className="bg-white/10 h-px w-full" />
								)}
							</React.Fragment>
						))}
					</Accordion>
				</div>
			</Container>
		</section>
	);
};
