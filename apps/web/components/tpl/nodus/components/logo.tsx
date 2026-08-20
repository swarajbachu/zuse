import Link from "next/link";

export const LogoSVG = (props: React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			role="presentation"
			width="20"
			height="24"
			viewBox="0 0 20 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="M0 4.5C0 3.11929 1.11929 2 2.5 2H7.5C8.88071 2 10 3.11929 10 4.5V9.40959C10.0001 9.4396 10.0002 9.46975 10.0002 9.50001C10.0002 10.8787 11.1162 11.9968 12.4942 12C12.4961 12 12.4981 12 12.5 12H17.5C18.8807 12 20 13.1193 20 14.5V19.5C20 20.8807 18.8807 22 17.5 22H12.5C11.1193 22 10 20.8807 10 19.5V14.5C10 14.4931 10 14.4861 10.0001 14.4792C9.98891 13.1081 8.87394 12 7.50017 12C7.4937 12 7.48725 12 7.48079 12H2.5C1.11929 12 0 10.8807 0 9.5V4.5Z"
				fill="currentColor"
			/>
		</svg>
	);
};

export const Logo = () => {
	return (
		<Link href="/" className="flex items-center gap-2">
			<LogoSVG />
			<span className="text-2xl font-medium">Notus</span>
		</Link>
	);
};
