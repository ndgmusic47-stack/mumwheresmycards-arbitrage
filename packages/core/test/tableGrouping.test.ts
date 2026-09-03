import { describe, expect, it } from "vitest";
import { groupRowsByKey } from "../src/opportunity/tableGrouping.js";

interface Row {
  id: string;
  cardId: string;
}

describe("groupRowsByKey (SOURCING WORKFLOW item 12)", () => {
  it("puts a lone row in its own group with no others", () => {
    const rows: Row[] = [{ id: "a", cardId: "card-1" }];
    const groups = groupRowsByKey(rows, (r) => r.cardId);
    expect(groups).toEqual([{ key: "card-1", primary: rows[0], others: [] }]);
  });

  it("groups multiple rows sharing a key, keeping the FIRST as primary and the rest as others in arrival order", () => {
    const rows: Row[] = [
      { id: "a", cardId: "card-1" },
      { id: "b", cardId: "card-1" },
      { id: "c", cardId: "card-1" },
    ];
    const groups = groupRowsByKey(rows, (r) => r.cardId);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.primary).toEqual(rows[0]);
    expect(groups[0]!.others).toEqual([rows[1], rows[2]]);
  });

  it("preserves the FIRST-SEEN order of distinct keys, matching the caller's own sort/rank", () => {
    const rows: Row[] = [
      { id: "a", cardId: "card-2" },
      { id: "b", cardId: "card-1" },
      { id: "c", cardId: "card-2" },
    ];
    const groups = groupRowsByKey(rows, (r) => r.cardId);
    expect(groups.map((g) => g.key)).toEqual(["card-2", "card-1"]);
  });

  it("never drops a row — every input row appears exactly once across primary+others, regardless of grouping", () => {
    const rows: Row[] = [
      { id: "a", cardId: "card-1" },
      { id: "b", cardId: "card-2" },
      { id: "c", cardId: "card-1" },
      { id: "d", cardId: "card-3" },
      { id: "e", cardId: "card-2" },
    ];
    const groups = groupRowsByKey(rows, (r) => r.cardId);
    const flattened = groups.flatMap((g) => [g.primary, ...g.others]);
    expect(flattened.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(flattened).toHaveLength(rows.length);
  });

  it("returns an empty array for an empty input, never throwing", () => {
    expect(groupRowsByKey([], (r: Row) => r.cardId)).toEqual([]);
  });
});
