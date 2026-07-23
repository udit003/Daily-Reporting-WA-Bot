/**
 * Pure, app-side org-tree helpers used for unit testing the hierarchy logic
 * independently of Postgres. The authoritative subtree query lives in
 * `db/queries.getSubtreeUserIds` (recursive CTE); this mirror is deliberately
 * simple and cycle-guarded so tests can reason about the same semantics.
 */

export interface HierarchyNode {
  id: number;
  manager_id: number | null;
}

/**
 * Return the set of ids that are transitively below `rootId` (its descendants),
 * excluding `rootId` itself. Cycle-guarded: a node is never visited twice, so
 * accidental cycles terminate instead of looping forever.
 */
export function descendants(users: HierarchyNode[], rootId: number): number[] {
  // Build manager_id -> direct reports adjacency.
  const childrenByManager = new Map<number, number[]>();
  for (const u of users) {
    if (u.manager_id == null) continue;
    const list = childrenByManager.get(u.manager_id) ?? [];
    list.push(u.id);
    childrenByManager.set(u.manager_id, list);
  }

  const result: number[] = [];
  const visited = new Set<number>([rootId]);
  const stack: number[] = [...(childrenByManager.get(rootId) ?? [])];

  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (visited.has(id)) continue; // cycle / duplicate guard
    visited.add(id);
    result.push(id);
    const kids = childrenByManager.get(id);
    if (kids) stack.push(...kids);
  }

  return result;
}

/**
 * True if `candidateManagerId` is `userId` itself or one of `userId`'s
 * descendants — i.e. assigning it as `userId`'s manager would create a cycle.
 */
export function wouldCreateCycle(
  users: HierarchyNode[],
  userId: number,
  candidateManagerId: number,
): boolean {
  if (candidateManagerId === userId) return true;
  return descendants(users, userId).includes(candidateManagerId);
}
