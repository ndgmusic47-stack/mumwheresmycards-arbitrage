/**
 * "Where was I" — the saved sourcing position for one strategy tab.
 *
 * Extracted from Dashboard.tsx on 2026-09-09 after this went wrong TWICE in
 * one day. Both failures were ordering bugs, not logic bugs, and neither was
 * catchable by reading the code — which is precisely why the rules now live
 * in a module with tests instead of inside a component.
 *
 * FAILURE 1 — the detached-DOM write. The scroll capture ran again on effect
 * cleanup. React detaches the DOM before an unmounting component's cleanups
 * run, so it found no `.table-scroll`, recorded zero offsets, and overwrote
 * the good snapshot. Visible only when navigating IN-APP: the eBay link opens
 * a new tab and never unmounts, so that path always worked, which made the
 * bug look like it wasn't there.
 *
 * FAILURE 2 — the mount-time write. The same effect lists `loading` in its
 * dependencies, so it re-binds whenever a fetch settles. React runs every
 * cleanup for a commit BEFORE any effect. So on first load after mounting:
 *
 *     loading true -> effect binds
 *     fetch settles, loading false
 *     CLEANUP runs   -> writes a session from freshly-mounted (empty) refs
 *     restore runs   -> reads the empty session it just wrote
 *
 * The component destroyed its own saved position microseconds before reading
 * it. Same visible symptom, completely different cause.
 *
 * THE TWO RULES that make this safe, both enforced here:
 *
 *   1. The snapshot to restore FROM is taken once, at construction — before
 *      any effect or cleanup can run. Never re-read later.
 *   2. Nothing is written until the restore has happened. Before that there
 *      is nothing worth saving, and saving anyway is what destroyed it.
 *
 * An explicit user action (clicking into a card) may `force` a write: the
 * table is on screen and scrolled, so that snapshot is real by definition.
 */

export interface StoredSession {
  /** The `searchParams.toString()` in effect when this was saved. A stored
   *  OFFSET is only ever replayed onto the same query — otherwise you land at
   *  a position that meant something else entirely. */
  search: string;
  /** Window-level offset. */
  scrollY: number;
  /** Offset inside each `.table-scroll` container, in document order.
   *  `.table-scroll` owns its own scrollbar (max-height: 65vh, so the sticky
   *  header works), which is why window.scrollY alone is never enough. */
  tableScrollTops: number[];
  /** The row that was opened. Preferred over the offsets on restore: centring
   *  the actual row survives changed row heights and shifted data, which a
   *  replayed pixel offset does not. */
  lastViewedId?: string | null;
}

/** Minimal slice of the Storage API, so tests need no browser. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function sessionKey(strategyTab: string): string {
  return `mwmc-sourcing-session-${strategyTab}`;
}

export function readSession(storage: SessionStorageLike, strategyTab: string): StoredSession | null {
  try {
    const raw = storage.getItem(sessionKey(strategyTab));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    // Tolerate a session written by an older build rather than throwing.
    if (typeof parsed.search !== "string" || !Array.isArray(parsed.tableScrollTops)) return null;
    return {
      search: parsed.search,
      scrollY: parsed.scrollY ?? 0,
      tableScrollTops: parsed.tableScrollTops,
      lastViewedId: parsed.lastViewedId ?? null,
    };
  } catch {
    return null;
  }
}

export function writeSession(storage: SessionStorageLike, strategyTab: string, session: StoredSession): void {
  try {
    storage.setItem(sessionKey(strategyTab), JSON.stringify(session));
  } catch {
    // Private browsing throws. This is a convenience, never load-bearing.
  }
}

export interface SessionRestorer {
  /** The position to restore, captured at construction. Null when there is
   *  none. Deliberately a value, not a getter — re-reading is the bug. */
  readonly snapshot: StoredSession | null;
  /** Called once the restore has run (or been declined). Opens the gate. */
  markRestored(): void;
  /** True once markRestored has been called. */
  readonly hasRestored: boolean;
  /** Writes the session. Returns false, writing NOTHING, when called before
   *  the restore and without `force`. */
  persist(session: StoredSession, force?: boolean): boolean;
  /** Forgets everything — used by "Clear filters". */
  clear(): void;
}

export function createSessionRestorer(storage: SessionStorageLike, strategyTab: string): SessionRestorer {
  // RULE 1: read now, at construction, before any effect can run.
  const snapshot = readSession(storage, strategyTab);
  let restored = false;

  return {
    snapshot,
    get hasRestored() {
      return restored;
    },
    markRestored() {
      restored = true;
    },
    persist(session, force = false) {
      // RULE 2: nothing is written until the restore has happened.
      if (!restored && !force) return false;
      restored = true;
      writeSession(storage, strategyTab, session);
      return true;
    },
    clear() {
      restored = true;
      try {
        storage.removeItem(sessionKey(strategyTab));
      } catch {
        /* as above */
      }
    },
  };
}
