import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, closePool, cleanDb } from "./helpers/db";
import {
  matchOrCreateProject,
  findProjectByNorm,
  appendProjectAlias,
} from "../src/db/queries";
import { normalizeProjectName } from "../src/util/projectName";

beforeAll(async () => {
  await cleanDb();
});
afterAll(async () => {
  await closePool();
});
beforeEach(async () => {
  await cleanDb();
});

describe("normalizeProjectName", () => {
  it("lowercases, strips boilerplate words, collapses spaces", () => {
    expect(normalizeProjectName("Narang Vivenda")).toBe("vivenda");
    expect(normalizeProjectName("Windsor Grande Residences")).toBe("windsor grande");
    expect(normalizeProjectName("Asteria by Courtyard")).toBe("asteria");
    expect(normalizeProjectName("  NARANG   Valora  ")).toBe("valora");
  });

  it("normalizes punctuation and case variants to the same key", () => {
    expect(normalizeProjectName("Windsor-BKC")).toBe(
      normalizeProjectName("windsor bkc"),
    );
  });
});

describe("matchOrCreateProject conflict-safe upsert", () => {
  it("creates once, then appends distinct aliases on conflict", async () => {
    const norm = normalizeProjectName("Narang Vivenda");
    const a = await matchOrCreateProject("Narang Vivenda", norm);
    const b = await matchOrCreateProject("Vivenda Tower", norm); // same norm
    expect(b.id).toBe(a.id);
    expect(b.canonical_name).toBe("Narang Vivenda"); // canonical preserved
    expect(b.aliases).toContain("Vivenda Tower");

    // Re-inserting the canonical name adds no duplicate alias.
    const c = await matchOrCreateProject("Narang Vivenda", norm);
    expect(c.aliases).not.toContain("Narang Vivenda");
    expect(c.aliases.filter((x) => x === "Vivenda Tower").length).toBe(1);
  });

  it("concurrent matchOrCreateProject yields exactly one row + merged aliases", async () => {
    const norm = normalizeProjectName("Narang Privado");
    const canon = "Narang Privado";
    const aliasVariants = [canon, "Privado", "Privado Thane", "Narang Privado Thane"];

    // Fire many concurrent upserts of the same norm with different canonicals.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        matchOrCreateProject(aliasVariants[i % aliasVariants.length], norm),
      ),
    );

    const rows = (
      await getPool().query(`SELECT id, aliases FROM projects WHERE norm_name = $1`, [norm])
    ).rows;
    expect(rows.length).toBe(1); // exactly one physical row

    const found = await findProjectByNorm(norm);
    expect(found).not.toBeNull();
    // Every non-canonical variant should have merged in as a distinct alias.
    const expectedAliases = aliasVariants.filter((v) => v !== found!.canonical_name);
    for (const a of new Set(expectedAliases)) {
      expect(found!.aliases).toContain(a);
    }
    // No duplicate aliases.
    expect(new Set(found!.aliases).size).toBe(found!.aliases.length);
  });
});

describe("appendProjectAlias", () => {
  it("adds a distinct alias and ignores duplicates / canonical", async () => {
    const norm = normalizeProjectName("Windsor BKC");
    const p = await matchOrCreateProject("Windsor BKC", norm);
    const withAlias = await appendProjectAlias(p.id, "BKC Tower");
    expect(withAlias?.aliases).toContain("BKC Tower");

    const again = await appendProjectAlias(p.id, "BKC Tower");
    expect(again?.aliases.filter((x) => x === "BKC Tower").length).toBe(1);

    const canon = await appendProjectAlias(p.id, "Windsor BKC");
    expect(canon?.aliases).not.toContain("Windsor BKC");
  });
});

describe("findProjectByNorm (lookup-only)", () => {
  it("returns null when absent and never creates a row", async () => {
    const missing = await findProjectByNorm("does-not-exist");
    expect(missing).toBeNull();
    const count = (await getPool().query(`SELECT count(*)::int AS c FROM projects`)).rows[0].c;
    expect(count).toBe(0);
  });
});
