"use server";

import { requireOwner, requireUser } from "@/lib/auth";
import { deleteChats, getChatView, listChats, pinChat, renameChat, setAutoApprove } from "@/lib/seelie/chats";
import { forgetCatalog, getCatalog, type Catalog } from "@/lib/seelie/catalog";
import {
  cancelLogin,
  deleteCredential,
  finishLogin,
  LOGIN_PROVIDERS,
  loginStatus,
  setCredentialDisabled,
  startLogin,
  type LoginProvider,
  type LoginStatus,
} from "@/lib/seelie/cliproxy";
import { seelieConfig } from "@/lib/seelie/config";
import { adsContext, capRoom } from "@/lib/seelie/ads";
import { chooseMeta, connectMeta, disconnectMeta, metaStatus, refreshMeta, type MetaStatus } from "@/lib/seelie/meta";
import { getLimits, type AccountLimits } from "@/lib/seelie/limits";
import { signInStore, signOutStore, storeStatus, type StoreStatus } from "@/lib/seelie/store";
import { imageBudget, imageReset, type ImageBudget, type ImageReset } from "@/lib/seelie/studio/budget";
import type { ChatSummary, ChatView } from "@/lib/seelie/types";

/**
 * Seelie's screen's server calls. Expected failures come back as `{ ok: false, error }`
 * (a thrown error reaches the browser as a generic message in production).
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    // redirect() and notFound() throw on purpose; let them through.
    if (err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_")) throw err;
    console.error("[seelie]", err);
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

/* Chats ------------------------------------------------------------------- */

export async function chatsAction(): Promise<Result<ChatSummary[]>> {
  const user = await requireUser();
  return attempt(() => listChats(user));
}

export async function chatAction(chatId: string): Promise<Result<ChatView>> {
  const user = await requireUser();
  return attempt(() => getChatView(user, chatId));
}

export async function renameChatAction(chatId: string, title: string): Promise<Result<null>> {
  const user = await requireUser();
  return attempt(async () => (await renameChat(user, chatId, title), null));
}

export async function pinChatAction(chatId: string, pinned: boolean): Promise<Result<null>> {
  const user = await requireUser();
  return attempt(async () => (await pinChat(user, chatId, pinned), null));
}

export async function deleteChatsAction(chatIds: string[]): Promise<Result<null>> {
  const user = await requireUser();
  return attempt(async () => (await deleteChats(user, chatIds), null));
}

export async function autoApproveAction(chatId: string, on: boolean): Promise<Result<null>> {
  const user = await requireUser();
  return attempt(async () => (await setAutoApprove(user, chatId, on), null));
}

/* Models and limits ------------------------------------------------------- */

export interface SeelieStatus {
  me: { name: string; owner: boolean };
  /** CLIProxyAPI is configured on this server. */
  online: boolean;
  catalog: Catalog | null;
  /** Why the models couldn't be read, when they couldn't. */
  error: string | null;
}

export async function statusAction(force = false): Promise<SeelieStatus> {
  const user = await requireUser();
  const me = { name: user.name, owner: user.role === "owner" };
  if (!seelieConfig()) return { me, online: false, catalog: null, error: null };
  if (force) forgetCatalog();
  try {
    return { me, online: true, catalog: await getCatalog(force), error: null };
  } catch (err) {
    return { me, online: true, catalog: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function limitsAction(force = false): Promise<Result<AccountLimits[]>> {
  await requireUser();
  return attempt(() => getLimits(force));
}

/** The image model's budget, worked out from Seelie's own ledger. */
export async function imageBudgetAction(): Promise<Result<ImageBudget>> {
  await requireUser();
  return attempt(() => imageBudget());
}

/** For the OMS-wide note that photoshoots are back; null when Seelie isn't set up here. */
export async function imageResetAction(): Promise<ImageReset | null> {
  const user = await requireUser();
  if (!seelieConfig()) return null;
  return imageReset(user.id);
}

/* Model accounts (owner) -------------------------------------------------- */

function provider(value: string): LoginProvider {
  if (!(value in LOGIN_PROVIDERS)) throw new Error("Unknown provider.");
  return value as LoginProvider;
}

export async function startLoginAction(which: string): Promise<Result<{ url: string; state: string }>> {
  await requireOwner();
  return attempt(() => startLogin(provider(which)));
}

export async function loginStatusAction(state: string): Promise<Result<LoginStatus>> {
  await requireOwner();
  return attempt(async () => {
    const status = await loginStatus(state);
    if (status.status === "ok") forgetCatalog();
    return status;
  });
}

export async function finishLoginAction(which: string, redirectUrl: string): Promise<Result<null>> {
  await requireOwner();
  return attempt(async () => (await finishLogin(provider(which), redirectUrl.trim()), null));
}

export async function cancelLoginAction(state: string): Promise<Result<null>> {
  await requireOwner();
  return attempt(async () => (await cancelLogin(state), null));
}

export async function removeAccountAction(name: string): Promise<Result<null>> {
  await requireOwner();
  return attempt(async () => {
    await deleteCredential(name);
    forgetCatalog();
    return null;
  });
}

export async function accountEnabledAction(name: string, enabled: boolean): Promise<Result<null>> {
  await requireOwner();
  return attempt(async () => {
    await setCredentialDisabled(name, !enabled);
    forgetCatalog();
    return null;
  });
}

/* paribelle.in (owner) ---------------------------------------------------- */

export async function storeStatusAction(): Promise<Result<StoreStatus>> {
  await requireOwner();
  return attempt(() => storeStatus());
}

export async function storeSignInAction(email: string, password: string): Promise<Result<StoreStatus>> {
  const user = await requireOwner();
  return attempt(() => signInStore(user, email, password));
}

export async function storeSignOutAction(): Promise<Result<StoreStatus>> {
  await requireOwner();
  return attempt(async () => {
    await signOutStore();
    return storeStatus();
  });
}

/* Meta: Instagram and ads (owner) ----------------------------------------- */

export async function metaStatusAction(): Promise<Result<MetaStatus>> {
  await requireOwner();
  return attempt(() => metaStatus());
}

export async function metaConnectAction(token: string): Promise<Result<MetaStatus>> {
  const user = await requireOwner();
  return attempt(() => connectMeta(user, token));
}

/** Look again for Pages and ad accounts the system user was given. */
export async function metaRefreshAction(): Promise<Result<MetaStatus>> {
  const user = await requireOwner();
  return attempt(() => refreshMeta(user));
}

export async function metaChooseAction(input: { pageId?: string; adAccountId?: string; monthlyCap?: number | null }): Promise<Result<MetaStatus>> {
  const user = await requireOwner();
  return attempt(() => chooseMeta(user, input));
}

export interface MetaMonth {
  currency: string;
  accountStatus: string;
  spent: number;
  heldByRunning: number;
  room: number;
}

/** This month's ad spend against the cap (null without an ad account). */
export async function metaMonthAction(): Promise<Result<MetaMonth | null>> {
  await requireOwner();
  return attempt(async () => {
    const ctx = await adsContext().catch(() => null);
    if (!ctx) return null;
    const room = await capRoom(ctx);
    return { currency: room.currency, accountStatus: room.accountStatus, spent: room.spentThisMonth, heldByRunning: room.committedTotal, room: room.room };
  });
}

export async function metaDisconnectAction(): Promise<Result<MetaStatus>> {
  await requireOwner();
  return attempt(async () => {
    await disconnectMeta();
    return metaStatus();
  });
}
