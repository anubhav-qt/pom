import { eq } from "drizzle-orm";
import { SubmitButton } from "@/components/submit-button";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, requirePendingUser } from "@/lib/auth";
import { generateMfaSecret, mfaQrCode, verifyMfaToken } from "@/lib/mfa";

export default async function MfaSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requirePendingUser();
  if (user.mfaEnabled) redirect("/mfa-verify");
  const { error } = await searchParams;

  // A secret is generated and stored as soon as setup starts, not only once
  // confirmed — that way reloading this page or coming back to it later shows
  // the same QR code instead of a new one that invalidates the last scan.
  let secret = user.mfaSecret;
  if (!secret) {
    secret = generateMfaSecret();
    await db.update(users).set({ mfaSecret: secret }).where(eq(users.id, user.id));
  }

  const qr = await mfaQrCode(user.email, secret);

  async function confirm(formData: FormData) {
    "use server";
    const pending = await requirePendingUser();
    if (!pending.mfaSecret) redirect("/mfa-setup");

    const code = String(formData.get("code") ?? "");
    if (!verifyMfaToken(pending.email, pending.mfaSecret, code)) {
      redirect("/mfa-setup?error=1");
    }

    const [updated] = await db
      .update(users)
      .set({ mfaEnabled: true })
      .where(eq(users.id, pending.id))
      .returning();

    await createSession(updated);
    redirect("/orders");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold">Set up two-factor login</h1>
      <p className="muted mt-1 text-sm">
        Required once, on every account. Scan this with an authenticator app —
        Google Authenticator, Authy, or similar.
      </p>

      <div className="panel mt-6 flex flex-col items-center gap-3 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- a locally generated data URL, not a remote image */}
        <img src={qr} alt="Scan this QR code in your authenticator app" width={200} height={200} />
        <details className="w-full text-xs">
          <summary className="muted cursor-pointer">Can&rsquo;t scan? Enter this key manually</summary>
          <code
            className="mt-1 block break-all rounded p-2"
            style={{ background: "var(--panel-2)" }}
          >
            {secret}
          </code>
        </details>
      </div>

      <form action={confirm} className="panel mt-3 space-y-3 p-4">
        <label htmlFor="code" className="muted block text-xs font-medium">
          Enter the 6-digit code it shows now, to confirm setup
        </label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          placeholder="000000"
          className="input text-center text-2xl tracking-[0.3em]"
        />

        {error ? <p className="text-sm text-rose-500">That code was not correct.</p> : null}

        <SubmitButton className="w-full">Confirm and finish signing in</SubmitButton>
      </form>
    </main>
  );
}
