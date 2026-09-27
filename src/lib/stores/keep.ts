"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeping a screen's progress when you leave it: switching screens, a reload,
 * a phone putting the tab to sleep and bringing it back, a new deploy.
 *
 *  - `useKept`: a `useState` that outlives the component. Held in memory for
 *    screen switches and in sessionStorage for reloads of the same tab. For
 *    small UI state: a search, a filter, a half-written note.
 *  - `kept`: JSON in localStorage with an expiry, for a store's snapshot that
 *    should come back even after the tab was closed (a reel, a label batch).
 *  - `blobs`: files in IndexedDB (photos, PDFs), which localStorage cannot hold.
 *
 * Storage can be missing or full (private windows, quotas), so every call
 * fails quietly: nothing is kept, and the screen works as it always did.
 */

const PREFIX = "pom:";

/* -------------------------------------------------------------------------- */
/* useKept                                                                    */
/* -------------------------------------------------------------------------- */

const memory = new Map<string, unknown>();

function readSession<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const value = JSON.parse(raw) as T;
      memory.set(key, value);
      return value;
    }
  } catch {
    // No storage: memory only.
  }
  return undefined;
}

function writeSession(key: string, value: unknown) {
  memory.set(key, value);
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full or blocked: memory still has it for this visit.
  }
}

/**
 * `useState`, kept under `key` across screen switches and reloads of the tab.
 * The first render uses `initial` (so it matches the server's HTML); the kept
 * value takes over straight after.
 */
export function useKept<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  const current = useRef(value);
  current.current = value;

  useEffect(() => {
    const kept = readSession<T>(key);
    if (kept !== undefined) setValue(kept);
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(current.current) : next;
      current.current = v;
      writeSession(key, v);
      setValue(v);
    },
    [key],
  );
  return [value, set];
}

/** Forget a `useKept` value (a form that was sent). */
export function forgetKept(key: string) {
  memory.delete(key);
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to do.
  }
}

/* -------------------------------------------------------------------------- */
/* kept: JSON with an expiry                                                  */
/* -------------------------------------------------------------------------- */

export const kept = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const { until, value } = JSON.parse(raw) as { until: number; value: T };
      if (Date.now() > until) {
        localStorage.removeItem(PREFIX + key);
        return null;
      }
      return value;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown, ttlMs: number) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({ until: Date.now() + ttlMs, value }));
    } catch {
      // Full or blocked: the screen still works, it just won't come back after a reload.
    }
  },
  drop(key: string) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // Nothing to do.
    }
  },
};

/* -------------------------------------------------------------------------- */
/* blobs: files in IndexedDB                                                  */
/* -------------------------------------------------------------------------- */

let opening: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const req = indexedDB.open("pom-kept", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("blobs");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return opening;
}

async function tx<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction("blobs", mode);
      const req = work(t.objectStore("blobs"));
      t.oncomplete = () => resolve(req ? (req.result ?? null) : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export const blobs = {
  put: (key: string, blob: Blob) => tx("readwrite", (s) => void s.put(blob, key)).then(() => undefined),
  get: (key: string) => tx<Blob | undefined>("readonly", (s) => s.get(key)).then((b) => b ?? null),
  drop: (key: string) => tx("readwrite", (s) => void s.delete(key)).then(() => undefined),
  /** Every blob whose key starts with `prefix`. */
  dropAll: (prefix: string) =>
    tx("readwrite", (s) => void s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`))).then(() => undefined),
};
