import { redirect } from "next/navigation";

import { SubmitButton } from "@/components/submit-button";
import { createSession, requirePendingUser } from "@/lib/auth";
import { verifyMfaToken } from "@/lib/mfa";

export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requirePendingUser();
  if (!user.mfaEnabled || !user.mfaSecret) redirect("/mfa-setup");
  const { error } = await searchParams;

  async function verify(formData: FormData) {
    "use server";
    const pending = await requirePendingUser();
    if (!pending.mfaSecret) redirect("/mfa-setup");

    const code = String(formData.get("code") ?? "");
    if (!verifyMfaToken(pending.email, pending.mfaSecret, code)) {
      redirect("/mfa-verify?error=1");
    }

    await createSession(pending);
    redirect("/orders");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold">Enter your code</h1>
      <p className="muted mt-1 text-sm">
        Open your authenticator app and enter the 6-digit code for {user.email}.
      </p>

      <form action={verify} className="panel mt-6 space-y-3 p-4">
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          autoFocus
          placeholder="000000"
          className="input text-center text-2xl tracking-[0.3em]"
        />

        {error ? <p className="text-sm text-rose-500">That code was not correct.</p> : null}

        <SubmitButton className="w-full">Verify</SubmitButton>
      </form>
    </main>
  );
}
