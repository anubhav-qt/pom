import "server-only";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { COOKIE_PATH } from "./base-path";
import { isPasswordExpired } from "./password-policy";

const SESSION_COOKIE = "oms_session";
const PENDING_COOKIE = "oms_pending";

/**
 * A single-owner account, so we optimize for "log in once, stay in." 180 days
 * rather than indefinite — a stolen laptop's session should eventually die on
 * its own. The 365-day password rotation is enforced separately, per request,
 * against the database (see requireFreshPassword) — so it still fires on
 * schedule regardless of how long this cookie lives.
 */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
/** Short-lived: only alive long enough to complete the MFA step right after login. */
const PENDING_MAX_AGE_SECONDS = 60 * 10;

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(value);
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10);
}

/**
 * Checks email + password only. Deliberately does **not** establish a full
 * session — every account has MFA, so a correct password is half of login, not
 * all of it. Callers get a pending session and must complete
 * `/mfa-verify` or `/mfa-setup` before `requireUser()` will succeed.
 */
export async function verifyLogin(email: string, password: string): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);

  if (!user || !user.active) return null;
  if (!(await bcrypt.compare(password, user.passwordHash))) return null;
  return user;
}

/* -------------------------------------------------------------------------- */
/* Pending session — password verified, MFA not yet done                     */
/* -------------------------------------------------------------------------- */

export async function createPendingSession(user: User) {
  const token = await new SignJWT({ uid: user.id, stage: "pending" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_MAX_AGE_SECONDS}s`)
    .sign(secret());

  (await cookies()).set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Scoped to the OMS's own prefix. At "/" the browser would attach an OMS
    // session to every storefront request on paribelle.in as well.
    path: COOKIE_PATH,
    maxAge: PENDING_MAX_AGE_SECONDS,
  });
}

export async function destroyPendingSession() {
  (await cookies()).delete({ name: PENDING_COOKIE, path: COOKIE_PATH });
}

/** The user mid-login, waiting on an MFA step. Not authenticated yet. */
export async function pendingUser(): Promise<User | null> {
  const token = (await cookies()).get(PENDING_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.stage !== "pending") return null;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, Number(payload.uid)))
      .limit(1);
    return user?.active ? user : null;
  } catch {
    return null;
  }
}

/** Use at the top of /mfa-verify and /mfa-setup. */
export async function requirePendingUser(): Promise<User> {
  const user = await pendingUser();
  if (!user) redirect("/login");
  return user;
}

/* -------------------------------------------------------------------------- */
/* Full session — password + MFA both complete                               */
/* -------------------------------------------------------------------------- */

export async function createSession(user: User) {
  const token = await new SignJWT({ uid: user.id, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret());

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Scoped to the OMS's own prefix. At "/" the browser would attach an OMS
    // session to every storefront request on paribelle.in as well.
    path: COOKIE_PATH,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  await destroyPendingSession();
}

export async function destroySession() {
  (await cookies()).delete({ name: SESSION_COOKIE, path: COOKIE_PATH });
}

/** Current user, or null. Safe to call from any server component. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, Number(payload.uid)))
      .limit(1);
    return user?.active ? user : null;
  } catch {
    // Expired or tampered token — treat as logged out rather than erroring.
    return null;
  }
}

/** Use at the top of any protected page or action. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireOwner(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "owner") redirect("/orders");
  return user;
}

/**
 * Call once per request from the protected-area layout. Expiry is checked
 * against the database on every call rather than baked into the session
 * token, so a password changed mid-session takes effect immediately instead
 * of waiting for the token to expire.
 */
export async function requireFreshPassword(user: User): Promise<void> {
  if (isPasswordExpired(user.passwordChangedAt)) redirect("/change-password");
}
