import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { AuthMark } from "@/components/auth-mark";
import { db } from "@/db";
import { users } from "@/db/schema";
import { currentUser, hashPassword } from "@/lib/auth";
import { isPasswordExpired, validatePassword } from "@/lib/password-policy";

/**
 * Deliberately outside the (app) route group: this is where
 * `requireFreshPassword` sends an expired user, so it must be reachable
 * without itself triggering the same redirect.
 */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { error } = await searchParams;

  const expired = isPasswordExpired(user.passwordChangedAt);

  async function change(formData: FormData) {
    "use server";
    const me = await currentUser();
    if (!me) redirect("/login");

    const current = String(formData.get("current") ?? "");
    const next = String(formData.get("next") ?? "");
    const confirm = String(formData.get("confirm") ?? "");

    if (!(await bcrypt.compare(current, me.passwordHash))) {
      redirect("/change-password?error=" + encodeURIComponent("Current password is wrong."));
    }
    if (next !== confirm) {
      redirect("/change-password?error=" + encodeURIComponent("New passwords do not match."));
    }
    const problems = validatePassword(next);
    if (problems.length > 0) {
      redirect("/change-password?error=" + encodeURIComponent(problems.join(" ")));
    }

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date() })
      .where(eq(users.id, me.id));

    redirect("/orders");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <AuthMark />
      <h1 className="text-xl font-semibold tracking-tight">Change your password</h1>
      <p className="muted mt-1 text-sm">
        {expired
          ? "Your password is over a year old and needs to be changed before you continue."
          : "Choose a new password."}
      </p>

      <form action={change} className="panel mt-6 space-y-3 p-4">
        <div>
          <label htmlFor="current" className="muted mb-1 block text-xs font-medium">
            Current password
          </label>
          <input id="current" name="current" type="password" required className="input" />
        </div>
        <div>
          <label htmlFor="next" className="muted mb-1 block text-xs font-medium">
            New password
          </label>
          <input id="next" name="next" type="password" required className="input" />
          <p className="muted mt-1 text-xs">
            12+ characters, with uppercase, lowercase, a number and a special character.
          </p>
        </div>
        <div>
          <label htmlFor="confirm" className="muted mb-1 block text-xs font-medium">
            Confirm new password
          </label>
          <input id="confirm" name="confirm" type="password" required className="input" />
        </div>

        {error ? (
          <p
            className="rounded-lg px-3 py-2 text-sm"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn btn-primary w-full">
          Save
        </button>
      </form>
    </main>
  );
}
