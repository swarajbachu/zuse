import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Tick01Icon,
  UserCircleIcon,
} from "@hugeicons-pro/core-bulk-rounded";

import { Button } from "~/components/ui/button";
import { BlurredEmail } from "~/components/blurred-email";
import { Spinner } from "~/components/ui/spinner";
import { useAuth } from "~/hooks/use-auth.ts";
import { StepHeader } from "./shared.tsx";

export function SigninStep() {
  const { isSignedIn, name, user, signIn, signingIn, error } = useAuth();
  const nameIsEmail = Boolean(user?.email && name === user.email);

  return (
    <div className="flex h-full flex-col gap-6">
      <StepHeader
        title="Connect your account"
        subtitle="Sign in with WorkOS to sync this Mac with future remote agents and mobile controls. You can skip it for now and connect later from Settings."
      />

      <div className="grid gap-4 rounded-xl border border-border/60 bg-muted/50 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background/70 text-foreground">
            <HugeiconsIcon
              icon={isSignedIn ? Tick01Icon : UserCircleIcon}
              className="size-5"
              strokeWidth={2}
            />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {isSignedIn ? "Account connected" : "WorkOS sign-in"}
            </span>
            {isSignedIn ? (
              <p className="flex max-w-sm flex-wrap items-center gap-1 text-[12px] leading-relaxed text-muted-foreground">
                <span>Signed in as</span>
                {nameIsEmail && user?.email ? (
                  <BlurredEmail email={user.email} />
                ) : (
                  <span>{name}</span>
                )}
                {!nameIsEmail && user?.email ? (
                  <>
                    <span>(</span>
                    <BlurredEmail email={user.email} />
                    <span>).</span>
                  </>
                ) : (
                  <span>.</span>
                )}
              </p>
            ) : (
              <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
                A browser window opens for authentication and returns here
                automatically.
              </p>
            )}
          </div>
        </div>

        {isSignedIn ? (
          <span className="inline-flex h-9 items-center justify-center rounded-lg border border-success/20 bg-alert-success-bg px-3 text-[12px] font-medium text-success">
            Signed in
          </span>
        ) : (
          <Button
            size="lg"
            disabled={signingIn}
            onClick={() => void signIn()}
            className="w-full rounded-lg px-4 sm:w-auto"
          >
            {signingIn ? (
              <>
                <Spinner className="size-4" />
                Signing in
              </>
            ) : (
              <>
                Sign in with WorkOS
                <HugeiconsIcon icon={ArrowRight01Icon} />
              </>
            )}
          </Button>
        )}
      </div>

      {error && !isSignedIn ? (
        <p
          className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-2 text-[12px] text-muted-foreground sm:grid-cols-3">
        <Hint title="Identity">
          Same account on desktop, mobile, and future cloud workers.
        </Hint>
        <Hint title="Secure handoff">
          Auth completes in your browser; tokens stay out of the renderer.
        </Hint>
        <Hint title="Optional today">
          Local agents still work if you skip this step.
        </Hint>
      </div>
    </div>
  );
}

function Hint({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-0.5 leading-snug">{children}</div>
    </div>
  );
}
