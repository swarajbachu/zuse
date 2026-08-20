import {
	IconBrandChrome,
	IconBrandSafari,
	IconCheck,
	IconCookie,
	IconLock,
	IconWorld,
} from "@tabler/icons-react";
import { cn } from "@/components/tpl/saas/lib/utils";

export function LoginSkeleton({ className }: { className?: string }) {
	return (
		<div
			className={cn(
				"relative h-full w-full overflow-hidden px-5 pb-6",
				className,
			)}
		>
			<div className="bg-primary/10 absolute top-10 left-1/2 h-44 w-44 -translate-x-1/2 rounded-full blur-3xl" />
			<div className="relative mx-auto mt-4 h-52 max-w-md">
				<div className="border-border bg-card absolute top-7 left-0 w-[48%] -rotate-3 rounded-2xl border p-3 shadow-lg">
					<p className="text-muted-foreground text-[8px] font-medium uppercase">
						Local profiles
					</p>
					<Browser icon={IconBrandChrome} name="Chrome · Profile 1" active />
					<Browser icon={IconBrandSafari} name="Safari" />
				</div>
				<div className="border-primary/30 bg-card absolute top-0 right-0 w-[48%] rotate-2 rounded-2xl border p-3 shadow-xl">
					<div className="flex items-center gap-2">
						<span className="bg-primary/15 grid size-7 place-items-center rounded-lg">
							<IconWorld className="text-primary size-4" />
						</span>
						<div>
							<p className="text-heading text-[10px] font-semibold">
								Zuse browser
							</p>
							<p className="text-primary text-[8px]">Session ready</p>
						</div>
					</div>
					<div className="border-border mt-3 rounded-xl border p-2.5">
						<p className="text-heading flex items-center gap-1.5 text-[9px] font-medium">
							<IconCheck className="text-primary size-3" /> 3 signed-in sites
						</p>
						<p className="text-muted-foreground mt-1 text-[8px]">
							12 valid cookies copied
						</p>
					</div>
				</div>
				<div className="border-primary/30 bg-background absolute top-[42%] left-1/2 z-10 grid size-11 -translate-x-1/2 place-items-center rounded-full border shadow-lg">
					<IconLock className="text-primary size-5" />
				</div>
				<div className="border-border bg-card absolute inset-x-4 bottom-0 grid grid-cols-2 divide-x overflow-hidden rounded-xl border shadow-lg">
					<Note
						icon={IconCookie}
						title="Cookies only"
						detail="Passwords stay in your browser"
					/>
					<Note
						icon={IconLock}
						title="Local transfer"
						detail="Never written into agent chat"
					/>
				</div>
			</div>
		</div>
	);
}

function Browser({
	icon: Icon,
	name,
	active = false,
}: {
	icon: typeof IconBrandChrome;
	name: string;
	active?: boolean;
}) {
	return (
		<div
			className={
				active
					? "border-primary/25 bg-primary/5 mt-2 flex items-center gap-2 rounded-lg border p-2"
					: "mt-1 flex items-center gap-2 rounded-lg border border-transparent p-2 opacity-45"
			}
		>
			<Icon className="text-heading size-4" />
			<span className="text-heading truncate text-[8px] font-medium">
				{name}
			</span>
			{active && <IconCheck className="text-primary ml-auto size-3" />}
		</div>
	);
}

function Note({
	icon: Icon,
	title,
	detail,
}: {
	icon: typeof IconCookie;
	title: string;
	detail: string;
}) {
	return (
		<div className="flex gap-2 p-2.5">
			<Icon className="text-primary mt-0.5 size-3.5 shrink-0" />
			<div>
				<p className="text-heading text-[8px] font-semibold">{title}</p>
				<p className="text-muted-foreground mt-0.5 text-[7px] leading-3">
					{detail}
				</p>
			</div>
		</div>
	);
}
