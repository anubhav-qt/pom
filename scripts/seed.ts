/**
 * Create the first owner login, or reset a password (also the recovery path if
 * someone loses their authenticator device — see scripts/mfa-reset.ts).
 *
 *   npx tsx scripts/seed.ts "dad@example.com" "a-Good-Password1!" "Papa"
 *
 * Safe to re-run: an existing email has its password reset rather than being
 * duplicated. A reset also restarts the 365-day expiry clock — otherwise a
 * password set through here would silently outlive the rotation policy.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const [email, password, name = "Owner"] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: npx tsx scripts/seed.ts <email> <password> [name]');
    process.exit(1);
  }

  const { validatePassword } = await import("../src/lib/password-policy");
  const problems = validatePassword(password);
  if (problems.length > 0) {
    console.error("That password does not meet the policy:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const bcrypt = (await import("bcryptjs")).default;

  const passwordHash = await bcrypt.hash(password, 10);
  const passwordChangedAt = new Date();

  await db
    .insert(users)
    .values({
      email: email.trim().toLowerCase(),
      name,
      passwordHash,
      passwordChangedAt,
      role: "owner",
    })
    .onConflictDoUpdate({
      target: users.email,
      set: { passwordHash, passwordChangedAt, name, role: "owner", active: true },
    });

  console.log(`Owner login ready: ${email}`);
  console.log("MFA will be set up on first sign-in — the login flow requires it for every account.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
