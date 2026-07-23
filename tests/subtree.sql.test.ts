import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, closePool, cleanDb } from "./helpers/db";
import { insertUser, getSubtreeUserIds } from "../src/db/queries";

async function makeUser(waSuffix: string, name: string) {
  return insertUser({
    wa_id: `${waSuffix}@s.whatsapp.net`,
    phone: waSuffix,
    name,
    onboarding_state: "done",
  });
}

beforeAll(async () => {
  await cleanDb();
});
afterAll(async () => {
  await closePool();
});
beforeEach(async () => {
  await cleanDb();
});

describe("getSubtreeUserIds (cycle-guarded recursive CTE)", () => {
  it("returns the full transitive subtree and isolates sibling branches", async () => {
    // root
    //  ├─ b
    //  │   ├─ d
    //  │   └─ e
    //  └─ c
    //      └─ f
    const root = await makeUser("100", "root");
    const b = await makeUser("200", "b");
    const c = await makeUser("300", "c");
    const d = await makeUser("400", "d");
    const e = await makeUser("500", "e");
    const f = await makeUser("600", "f");

    const pool = getPool();
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id IN ($2,$3)`, [root.id, b.id, c.id]);
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id IN ($2,$3)`, [b.id, d.id, e.id]);
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id=$2`, [c.id, f.id]);

    const rootSub = (await getSubtreeUserIds(root.id)).sort((x, y) => x - y);
    expect(rootSub).toEqual([b.id, c.id, d.id, e.id, f.id].sort((x, y) => x - y));

    // b's subtree = its two reports only (isolation: no c/f).
    const bSub = (await getSubtreeUserIds(b.id)).sort((x, y) => x - y);
    expect(bSub).toEqual([d.id, e.id].sort((x, y) => x - y));
    expect(bSub).not.toContain(c.id);
    expect(bSub).not.toContain(f.id);

    // leaf has empty subtree.
    expect(await getSubtreeUserIds(d.id)).toEqual([]);
  });

  it("denies out-of-tree access: querying one branch never returns another", async () => {
    const root = await makeUser("100", "root");
    const b = await makeUser("200", "b");
    const c = await makeUser("300", "c");
    const pool = getPool();
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id IN ($2,$3)`, [root.id, b.id, c.id]);

    // c is not in b's subtree.
    expect(await getSubtreeUserIds(b.id)).not.toContain(c.id);
    // b is not in c's subtree.
    expect(await getSubtreeUserIds(c.id)).not.toContain(b.id);
  });

  it("terminates on a cycle instead of looping forever", async () => {
    // Create a->b->c then force c to manage a (cycle a->b->c->a).
    const a = await makeUser("100", "a");
    const b = await makeUser("200", "b");
    const c = await makeUser("300", "c");
    const pool = getPool();
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id=$2`, [a.id, b.id]);
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id=$2`, [b.id, c.id]);
    // Force a cycle directly in SQL (bypassing the app guard).
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id=$2`, [c.id, a.id]);

    // The CTE must terminate; a's subtree is {b, c} (each visited once).
    const sub = (await getSubtreeUserIds(a.id)).sort((x, y) => x - y);
    expect(sub).toEqual([b.id, c.id].sort((x, y) => x - y));
  });
});
