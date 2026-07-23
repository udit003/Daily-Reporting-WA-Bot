import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { getPool, closePool, cleanDb } from "./helpers/db";
import {
  matchOrCreateProject,
  findProjectByNorm,
  appendProjectAlias,
  type Project,
} from "../src/db/queries";
import { normalizeProjectName } from "../src/util/projectName";
import { createProjects, normalize, type ProjectsDb } from "../src/domain/projects";

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

// ---------------------------------------------------------------------------
// Domain projects module (Task 4): matchOrCreate + findByNorm with a mocked DB
// so the match-vs-create + alias-append logic is verified without Postgres.
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    canonical_name: "Narang Vivenda",
    norm_name: "vivenda",
    aliases: [],
    created_at: new Date(),
    ...overrides,
  };
}

/** An in-memory ProjectsDb keyed on norm_name, with a low fuzzy threshold. */
function makeProjectsDb(seed: Project[] = []) {
  const rows = new Map<string, Project>();
  for (const r of seed) rows.set(r.norm_name, { ...r, aliases: [...r.aliases] });
  let nextId = Math.max(0, ...seed.map((r) => r.id)) + 1;

  const db: ProjectsDb & {
    findProjectByNorm: ReturnType<typeof vi.fn>;
    findProjectBySimilarity: ReturnType<typeof vi.fn>;
    appendProjectAlias: ReturnType<typeof vi.fn>;
    matchOrCreateProject: ReturnType<typeof vi.fn>;
    _rows: Map<string, Project>;
  } = {
    _rows: rows,
    findProjectByNorm: vi.fn(async (norm: string) => {
      const r = rows.get(norm);
      return r ? { ...r } : null;
    }),
    // Trivial fuzzy match: shared token overlap counts as similar (>=threshold
    // handled by the caller; here we just return the first token-overlapping row).
    findProjectBySimilarity: vi.fn(async (norm: string) => {
      const tokens = new Set(norm.split(" "));
      for (const r of rows.values()) {
        const rt = r.norm_name.split(" ");
        if (rt.some((t) => tokens.has(t))) return { ...r };
      }
      return null;
    }),
    appendProjectAlias: vi.fn(async (id: number, alias: string) => {
      for (const r of rows.values()) {
        if (r.id === id) {
          if (alias !== r.canonical_name && !r.aliases.includes(alias)) {
            r.aliases.push(alias);
          }
          return { ...r };
        }
      }
      return null;
    }),
    matchOrCreateProject: vi.fn(async (canonical: string, norm: string) => {
      const existing = rows.get(norm);
      if (existing) return { ...existing };
      const created = makeRow({ id: nextId++, canonical_name: canonical, norm_name: norm, aliases: [] });
      rows.set(norm, created);
      return { ...created };
    }),
  };
  return db;
}

describe("projects.normalize (shared normalizer)", () => {
  it("re-exports the shared normalizer", () => {
    expect(normalize("Narang Vivenda")).toBe(normalizeProjectName("Narang Vivenda"));
    expect(normalize("Narang Vivenda")).toBe("vivenda");
  });
});

describe("projects.matchOrCreate", () => {
  it("'Vivenda' and 'narang vivenda' collapse to one canonical project", async () => {
    const db = makeProjectsDb();
    const p = createProjects({ db, threshold: 0.3 });

    const a = await p.matchOrCreate("Vivenda");
    const b = await p.matchOrCreate("narang vivenda");

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.id).toBe(a!.id); // same canonical row
    // Only one physical row created.
    expect(db._rows.size).toBe(1);
    // matchOrCreateProject (create) called exactly once.
    expect(db.matchOrCreateProject).toHaveBeenCalledTimes(1);
  });

  it("appends a new raw alias to a matched project", async () => {
    const db = makeProjectsDb([makeRow({ id: 5, canonical_name: "Narang Vivenda", norm_name: "vivenda" })]);
    const p = createProjects({ db, threshold: 0.3 });

    const r = await p.matchOrCreate("Vivenda Tower"); // normalizes to "vivenda tower" → fuzzy match
    expect(r!.id).toBe(5);
    expect(db.appendProjectAlias).toHaveBeenCalled();
    expect(db._rows.get("vivenda")!.aliases).toContain("Vivenda Tower");
    // No new row created.
    expect(db.matchOrCreateProject).not.toHaveBeenCalled();
  });

  it("a below-threshold distinct string creates a new project", async () => {
    const db = makeProjectsDb([makeRow({ id: 5, canonical_name: "Narang Vivenda", norm_name: "vivenda" })]);
    const p = createProjects({ db, threshold: 0.3 });

    const r = await p.matchOrCreate("Windsor BKC"); // no token overlap with "vivenda"
    expect(r!.id).not.toBe(5);
    expect(db.matchOrCreateProject).toHaveBeenCalledTimes(1);
    expect(db._rows.size).toBe(2);
  });

  it("returns null (and never writes) for a blank / normalizes-to-empty name", async () => {
    const db = makeProjectsDb();
    const p = createProjects({ db, threshold: 0.3 });
    const r = await p.matchOrCreate("   narang   "); // normalizes to ""
    expect(r).toBeNull();
    expect(db.matchOrCreateProject).not.toHaveBeenCalled();
  });
});

describe("projects.findByNorm (lookup-only)", () => {
  it("finds an existing project without ever writing", async () => {
    const db = makeProjectsDb([makeRow({ id: 5, canonical_name: "Narang Vivenda", norm_name: "vivenda" })]);
    const p = createProjects({ db, threshold: 0.3 });

    const r = await p.findByNorm("Narang Vivenda");
    expect(r!.id).toBe(5);
    // Never creates or appends.
    expect(db.matchOrCreateProject).not.toHaveBeenCalled();
    expect(db.appendProjectAlias).not.toHaveBeenCalled();
  });

  it("returns null for an unknown project and still never writes", async () => {
    const db = makeProjectsDb();
    const p = createProjects({ db, threshold: 0.3 });

    const r = await p.findByNorm("Totally Unknown");
    expect(r).toBeNull();
    expect(db.matchOrCreateProject).not.toHaveBeenCalled();
    expect(db.appendProjectAlias).not.toHaveBeenCalled();
  });
});
