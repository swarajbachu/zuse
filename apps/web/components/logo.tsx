import { cn } from "@/lib/utils";
import Image from "next/image";
import Link from "next/link";
import { SITE_NAME } from "@/lib/site";

/** memoize wordmark + the real desktop app icon. */
export const LogoMark = ({ className }: { className?: string }) => {
  return (
    <Image
      src="/app-icon.png"
      alt=""
      width={1024}
      height={1024}
      className={cn("size-8 rounded-lg", className)}
      priority
    />
  );
};

export const Logo = ({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) => {
  return (
    <Link href="/" className="flex items-center gap-2">
      <LogoMark className={className} />
      {showWordmark && (
        <span className="text-natural-white text-lg font-semibold -tracking-sm">
          {SITE_NAME}
        </span>
      )}
    </Link>
  );
};
