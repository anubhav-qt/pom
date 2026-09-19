import { redirect } from "next/navigation";

import { SubmitButton } from "@/components/submit-button";
import { AuthMark } from "@/components/auth-mark";
import { FEATURES } from "@/config/features";
import { createPendingSession, createSession, currentUser, verifyLogin } from "@/lib/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect("/orders");
  const { error } = await searchParams;

  async function login(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    const user = await verifyLogin(email, password);
    if (!user) redirect("/login?error=1");

    if (!FEATURES.requireMfa) {
      // MFA switched off — password alone grants a full session.
      await createSession(user);
      redirect("/orders");
    }

    // A correct password is only half of login — every account has MFA. This
    // grants a short-lived pending session, not access to the app.
    await createPendingSession(user);
    redirect(user.mfaEnabled ? "/mfa-verify" : "/mfa-setup");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <AuthMark />
      <h1 className="text-xl font-semibold tracking-tight">Paribelle OMS</h1>
      <p className="muted mt-1 text-sm">Sign in to manage today&rsquo;s orders.</p>

      <form action={login} className="panel mt-6 space-y-3.5 p-5">
        <div>
          <label htmlFor="email" className="muted mb-1.5 block text-xs font-medium">
            Email
          </label>
          <input id="email" name="email" type="email" required autoFocus className="input" />
        </div>
        <div>
          <label htmlFor="password" className="muted mb-1.5 block text-xs font-medium">
            Password
          </label>
          <input id="password" name="password" type="password" required className="input" />
        </div>

        {error ? (
          <p
            className="rounded-lg px-3 py-2 text-sm"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            That email and password did not match.
          </p>
        ) : null}

        <SubmitButton className="w-full">Sign in</SubmitButton>
      </form>
    </main>
  );
}
