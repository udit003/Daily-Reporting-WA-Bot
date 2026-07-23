import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, closePool, cleanDb } from "./helpers/db";
import {
  insertUser,
  updateUserOnboarding,
  setRoot,
  setUserManager,
  reconcilePendingManagers,
  getUserById,
  getSubtreeUserIds,
} from "../src/db/queries";

async function makeUser(
  waSuffix: string,
  name: string,
  state: "new" | "done" = "done",
) {
  return insertUser({
    wa_id: `${waSuffix}@s.whatsapp.net`,
    phone: waSuffix,
    name,
    onboarding_state: state,
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

describe("single-root uniqueness (uq_single_root)", () => {
  it("allows exactly one completed root and rejects a second", async () => {
    const a = await makeUser("111", "Advait");
    const b = await makeUser("222", "Soham");

    expect((await setRoot(a.id)).ok).toBe(true);
    // A second completed root violates the partial unique index.
    expect((await setRoot(b.id)).ok).toBe(false);

    // A is still the root.
    const fetchedA = await getUserById(a.id);
    expect(fetchedA?.is_root).toBe(true);
  });

  it("permits a second is_root row only if it is not yet 'done'", async () => {
    const a = await makeUser("111", "Advait");
    expect((await setRoot(a.id)).ok).toBe(true);

    // A pending (not done) prospective root can carry is_root without conflict.
    const b = await makeUser("222", "Soham", "new");
    const res = await getPool().query(
      `UPDATE users SET is_root = true WHERE id = $1`,
      [b.id],
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("self / descendant manager rejection + no-self-manager CHECK", () => {
  it("rejects self-assignment", async () => {
    const u = await makeUser("111", "Advait");
    const res = await setUserManager(u.id, u.id);
    expect(res).toEqual({ ok: false, reason: "self" });
  });

  it("db CHECK blocks manager_id = id at the SQL layer", async () => {
    const u = await makeUser("111", "Advait");
    await expect(
      getPool().query(`UPDATE users SET manager_id = id WHERE id = $1`, [u.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects assigning a descendant as manager (would cycle)", async () => {
    // root -> mid -> leaf
    const root = await makeUser("111", "Advait");
    const mid = await makeUser("222", "Rohit");
    const leaf = await makeUser("333", "Sana");
    expect((await setUserManager(mid.id, root.id)).ok).toBe(true);
    expect((await setUserManager(leaf.id, mid.id)).ok).toBe(true);

    // Now try to make leaf (a descendant of root) the manager of root.
    const res = await setUserManager(root.id, leaf.id);
    expect(res).toEqual({ ok: false, reason: "descendant" });
  });
});

describe("is_manager derived on first descendant", () => {
  it("flips is_manager=true when someone reports to them", async () => {
    const mgr = await makeUser("111", "Advait");
    const rep = await makeUser("222", "Rohit");
    expect((await getUserById(mgr.id))?.is_manager).toBe(false);

    expect((await setUserManager(rep.id, mgr.id)).ok).toBe(true);
    expect((await getUserById(mgr.id))?.is_manager).toBe(true);
  });
});

describe("reconcilePendingManagers", () => {
  it("links waiters under a newly-done user and derives is_manager", async () => {
    // Waiter onboarded first, pending on a phone that isn't a user yet.
    const waiter = await makeUser("222", "Rohit");
    await updateUserOnboarding(waiter.id, { pending_manager_phone: "111" });

    // The manager now completes onboarding.
    const mgr = await makeUser("111", "Advait");

    const result = await reconcilePendingManagers("111");
    expect(result.linked).toEqual([waiter.id]);
    expect(result.skippedForCycle).toEqual([]);

    const fetchedWaiter = await getUserById(waiter.id);
    expect(fetchedWaiter?.manager_id).toBe(mgr.id);
    expect(fetchedWaiter?.pending_manager_phone).toBeNull();
    expect((await getUserById(mgr.id))?.is_manager).toBe(true);
  });

  it("refuses a link that would create a cycle and flags it", async () => {
    // Build: A is manager of B (A done, B done under A).
    const a = await makeUser("111", "Advait");
    const b = await makeUser("222", "Rohit");
    expect((await setUserManager(b.id, a.id)).ok).toBe(true);

    // A is waiting on B's phone as its pending manager (would make B->A->B cycle).
    await updateUserOnboarding(a.id, { pending_manager_phone: "222" });

    const result = await reconcilePendingManagers("222");
    expect(result.linked).toEqual([]);
    expect(result.skippedForCycle).toEqual([a.id]);

    // A's manager unchanged (still null / root-ish), pending phone left for manual resolution.
    const fetchedA = await getUserById(a.id);
    expect(fetchedA?.manager_id).toBeNull();
  });

  it("no-op when the phone's user is not yet done", async () => {
    const waiter = await makeUser("222", "Rohit");
    await updateUserOnboarding(waiter.id, { pending_manager_phone: "111" });
    // manager exists but not done
    await makeUser("111", "Advait", "new");

    const result = await reconcilePendingManagers("111");
    expect(result.linked).toEqual([]);
    expect((await getUserById(waiter.id))?.manager_id).toBeNull();
  });
});

describe("subtree integration for reconciled tree", () => {
  it("root sees the full reconciled chain", async () => {
    const root = await makeUser("111", "Advait");
    const mid = await makeUser("222", "Rohit");
    const leaf = await makeUser("333", "Sana");
    await setUserManager(mid.id, root.id);
    await setUserManager(leaf.id, mid.id);
    const ids = (await getSubtreeUserIds(root.id)).sort((a, b) => a - b);
    expect(ids).toEqual([mid.id, leaf.id].sort((a, b) => a - b));
  });
});
