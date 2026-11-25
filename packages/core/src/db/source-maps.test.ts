import { describe, expect, it } from "vitest";
import { chooseSourceMaps } from "./source-maps.js";

describe("chooseSourceMaps", () => {
  it("keeps maps in order while they fit the count and the total size", () => {
    const rows = [
      { debugId: "a", size: 60 },
      { debugId: "b", size: 30 },
      { debugId: "c", size: 30 },
      { debugId: "d", size: 10 },
    ];

    expect(chooseSourceMaps(rows, { maxMaps: 3, maxTotalBytes: 100 }).sort()).toEqual(["a", "b", "d"]);
    expect(chooseSourceMaps(rows, { maxMaps: 2, maxTotalBytes: 1_000 })).toHaveLength(2);
    expect(chooseSourceMaps([{ debugId: "huge", size: 101 }], { maxMaps: 3, maxTotalBytes: 100 })).toEqual([]);
  });
});
