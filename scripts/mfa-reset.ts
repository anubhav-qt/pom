/**
 * Recovery path for a lost or replaced authenticator device.
 *
 *   npx tsx scripts/mfa-reset.ts "dad@example.com"
 *
 * Clears the MFA enrollment so the next login goes through /mfa-setup again.
 * Deliberately a local script, not an in-app "disable MFA" button — resetting
 * a second factor should require the same access level as the database
 * itself, not just an active browser session.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const [email] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: npx tsx scripts/mfa-reset.ts <email>");
    process.exit(1);
  }

  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");

  const [updated] = await db
    .update(users)
    .set({ mfaEnabled: false, mfaSecret: null })
    .where(eq(users.email, email.trim().toLowerCase()))
    .returning({ id: users.id });

  if (!updated) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }

  console.log(`MFA cleared for ${email}. They will set it up again on next sign-in.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
