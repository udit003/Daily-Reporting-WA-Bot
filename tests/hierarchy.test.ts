import { describe, it, expect } from "vitest";
import { descendants, wouldCreateCycle } from "../src/util/hierarchy";
import type { HierarchyNode } from "../src/util/hierarchy";

// Tree:
//   1 (root)
//   ├─ 2
//   │  ├─ 4 (leaf)
//   │  └─ 5 (leaf)
//   └─ 3
//      └─ 6 (leaf)
const tree: HierarchyNode[] = [
  { id: 1, manager_id: null },
  { id: 2, manager_id: 1 },
  { id: 3, manager_id: 1 },
  { id: 4, manager_id: 2 },
  { id: 5, manager_id: 2 },
  { id: 6, manager_id: 3 },
];

describe("descendants (app-side hierarchy)", () => {
  it("leaf has an empty subtree", () => {
    expect(descendants(tree, 4).sort()).toEqual([]);
    expect(descendants(tree, 5).sort()).toEqual([]);
    expect(descendants(tree, 6).sort()).toEqual([]);
  });

  it("mid node returns exactly its own subtree", () => {
    expect(descendants(tree, 2).sort((a, b) => a - b)).toEqual([4, 5]);
    expect(descendants(tree, 3).sort((a, b) => a - b)).toEqual([6]);
  });

  it("root returns everyone else", () => {
    expect(descendants(tree, 1).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
  });

  it("excludes the node itself", () => {
    expect(descendants(tree, 1)).not.toContain(1);
    expect(descendants(tree, 2)).not.toContain(2);
  });

  it("terminates on an accidental cycle instead of looping forever", () => {
    const cyclic: HierarchyNode[] = [
      { id: 1, manager_id: 3 }, // cycle: 1 -> 3 -> 2 -> 1
      { id: 2, manager_id: 1 },
      { id: 3, manager_id: 2 },
    ];
    const result = descendants(cyclic, 1).sort((a, b) => a - b);
    expect(result).toEqual([2, 3]);
  });
});

describe("wouldCreateCycle", () => {
  it("flags self-assignment", () => {
    expect(wouldCreateCycle(tree, 2, 2)).toBe(true);
  });
  it("flags assigning a descendant as manager", () => {
    // making 4 (a descendant of 2) the manager of 2 would cycle
    expect(wouldCreateCycle(tree, 2, 4)).toBe(true);
  });
  it("allows assigning an unrelated / ancestor node", () => {
    expect(wouldCreateCycle(tree, 4, 3)).toBe(false); // 3 is not below 4
    expect(wouldCreateCycle(tree, 6, 2)).toBe(false);
  });
});
