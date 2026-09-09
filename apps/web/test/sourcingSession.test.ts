import { describe, it, expect } from "vitest";
import {
  createSessionRestorer,
  readSession,
  writeSession,
  sessionKey,
  type SessionStorageLike,
  type StoredSession,
} from "../src/state/sourcingSession";

/**
 * REGRESSION GUARD for "I click into a card, come back, and I've lost my
 * place" — reported three times, fixed twice wrongly.
 *
 * Both real causes were EFFECT ORDERING, so these tests replay the orderings
 * rather than testing the arithmetic. The two that actually bit:
 *
 *   A. unmount: React detaches the DOM before running an unmounting
 *      component's effect cleanups, so the final capture read zero scroll
 *      containers and saved an empty position over a good one.
 *   B. mount: the capture effect depends on `loading`, so its cleanup fires
 *      when the first fetch settles — and React runs every cleanup for a
 *      commit BEFORE any effect. The empty write landed before the restore
 *      read.
 *
 * B is the nastier one: the component destroyed its own saved position
 * microseconds before reading it, and no amount of staring at either function
 * alone reveals it.
 */
function fakeStorage(seed: Record<string, string> = {}): SessionStorageLike & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const GOOD: StoredSession = {
  search: "f=%7B%7D&page=1",
  scrollY: 120,
  tableScrollTops: [2847],
  lastViewedId: "opp-abc",
};

const EMPTY_AS_WRITTEN_AT_MOUNT: StoredSession = {
  search: "f=%7B%7D&page=1",
  scrollY: 0,
  tableScrollTops: [],
  lastViewedId: null,
};

function seeded() {
  return fakeStorage({ [sessionKey("GRADE")]: JSON.stringify(GOOD) });
}

describe("rule 1: the snapshot is taken at construction and never re-read", () => {
  it("captures the stored position the moment the restorer is created", () => {
    const restorer = createSessionRestorer(seeded(), "GRADE");
    expect(restorer.snapshot).toEqual(GOOD);
  });

  it("keeps that snapshot even if storage is later overwritten", () => {
    const storage = seeded();
    const restorer = createSessionRestorer(storage, "GRADE");

    // Something else clobbers storage after mount — exactly what failure B did.
    writeSession(storage, "GRADE", EMPTY_AS_WRITTEN_AT_MOUNT);

    expect(restorer.snapshot).toEqual(GOOD);
    expect(restorer.snapshot!.tableScrollTops).toEqual([2847]);
  });

  it("is null when nothing was ever saved, so a first visit restores nothing", () => {
    expect(createSessionRestorer(fakeStorage(), "GRADE").snapshot).toBeNull();
  });
});

describe("rule 2: nothing is written before the restore has run", () => {
  it("BLOCKS the mount-time cleanup write that caused failure B", () => {
    const storage = seeded();
    const restorer = createSessionRestorer(storage, "GRADE");

    // The capture effect's cleanup fires when `loading` flips false.
    const wrote = restorer.persist(EMPTY_AS_WRITTEN_AT_MOUNT);

    expect(wrote).toBe(false);
    expect(readSession(storage, "GRADE")).toEqual(GOOD);
  });

  it("the full failing sequence now ends with the position intact", () => {
    const storage = seeded();

    // 1. mount — snapshot taken during first render
    const restorer = createSessionRestorer(storage, "GRADE");
    // 2. fetch settles, loading flips, cleanup tries to save nothing useful
    restorer.persist(EMPTY_AS_WRITTEN_AT_MOUNT);
    // 3. restore effect reads
    const toRestore = restorer.snapshot;
    restorer.markRestored();

    expect(toRestore).toEqual(GOOD);
    expect(toRestore!.lastViewedId).toBe("opp-abc");
    expect(readSession(storage, "GRADE")).toEqual(GOOD);
  });

  it("allows writes again once the restore has happened", () => {
    const storage = seeded();
    const restorer = createSessionRestorer(storage, "GRADE");
    restorer.markRestored();

    const moved: StoredSession = { ...GOOD, tableScrollTops: [5000], scrollY: 300 };
    expect(restorer.persist(moved)).toBe(true);
    expect(readSession(storage, "GRADE")).toEqual(moved);
  });
});

describe("an explicit click always saves, gate or no gate", () => {
  it("force writes even before the restore — the table is on screen, so it is real data", () => {
    const storage = seeded();
    const restorer = createSessionRestorer(storage, "GRADE");

    const onClick: StoredSession = { ...GOOD, lastViewedId: "opp-xyz", tableScrollTops: [900] };
    expect(restorer.persist(onClick, true)).toBe(true);
    expect(readSession(storage, "GRADE")!.lastViewedId).toBe("opp-xyz");
  });

  it("and opens the gate, so the unmount write that follows is kept", () => {
    const storage = fakeStorage();
    const restorer = createSessionRestorer(storage, "GRADE");

    // Click into a card...
    restorer.persist({ ...GOOD, lastViewedId: "opp-xyz" }, true);
    // ...then the unmount cleanup, carrying the same good refs.
    const kept = restorer.persist({ ...GOOD, lastViewedId: "opp-xyz" });

    expect(kept).toBe(true);
    expect(readSession(storage, "GRADE")!.lastViewedId).toBe("opp-xyz");
  });
});

describe("tabs keep separate positions", () => {
  it("a Grade session is never read as a Flip session", () => {
    const storage = seeded();
    expect(createSessionRestorer(storage, "GRADE").snapshot).toEqual(GOOD);
    expect(createSessionRestorer(storage, "FLIP").snapshot).toBeNull();
  });
});

describe("clear forgets everything", () => {
  it("removes the stored session and leaves nothing to restore next time", () => {
    const storage = seeded();
    const restorer = createSessionRestorer(storage, "GRADE");
    restorer.clear();
    expect(readSession(storage, "GRADE")).toBeNull();
    expect(createSessionRestorer(storage, "GRADE").snapshot).toBeNull();
  });
});

describe("corrupt or legacy data never throws", () => {
  it("returns null on unparseable JSON rather than breaking the page", () => {
    expect(readSession(fakeStorage({ [sessionKey("GRADE")]: "{not json" }), "GRADE")).toBeNull();
  });

  it("rejects a session from an older build that lacks the required fields", () => {
    const legacy = fakeStorage({ [sessionKey("GRADE")]: JSON.stringify({ scrollY: 100 }) });
    expect(readSession(legacy, "GRADE")).toBeNull();
  });

  it("survives a storage that throws on every access (private browsing)", () => {
    const hostile: SessionStorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => createSessionRestorer(hostile, "GRADE")).not.toThrow();
    const r = createSessionRestorer(hostile, "GRADE");
    expect(r.snapshot).toBeNull();
    r.markRestored();
    expect(() => r.persist(GOOD)).not.toThrow();
  });
});
