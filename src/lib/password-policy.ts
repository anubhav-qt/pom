/**
 * Password rules, kept in one place so the signup form, the change-password
 * form, and the seed script all enforce exactly the same thing.
 *
 * Matches what was attested on the Amazon SP-API developer profile: 12-char
 * minimum, mixed case, a number, and a special character.
 */
const MIN_LENGTH = 12;

/** Forces a password change once a year — the other half of the attestation. */
export const PASSWORD_MAX_AGE_DAYS = 365;

export function validatePassword(password: string): string[] {
  const problems: string[] = [];

  if (password.length < MIN_LENGTH) {
    problems.push(`At least ${MIN_LENGTH} characters.`);
  }
  if (!/[a-z]/.test(password)) problems.push("At least one lowercase letter.");
  if (!/[A-Z]/.test(password)) problems.push("At least one uppercase letter.");
  if (!/[0-9]/.test(password)) problems.push("At least one number.");
  if (!/[^A-Za-z0-9]/.test(password)) problems.push("At least one special character.");

  return problems;
}

export function isPasswordExpired(passwordChangedAt: Date): boolean {
  const ageMs = Date.now() - passwordChangedAt.getTime();
  return ageMs > PASSWORD_MAX_AGE_DAYS * 86_400_000;
}
