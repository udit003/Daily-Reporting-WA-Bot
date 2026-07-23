import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, closePool, cleanDb } from "./helpers/db";
import {
  insertUser,
  matchOrCreateProject,
  insertReportWithProjects,
  getSubtreeUserIds,
  getSubtreeReportedStatus,
  getReportsForUsersWithProjects,
  type User,
  type StructuredReport,
} from "../src/db/queries";

async function makeUser(waSuffix: string, name: string): Promise<User> {
  return insertUser({
    wa_id: `${waSuffix}@s.whatsapp.net`,
    phone: waSuffix,
    name,
    onboarding_state: "done",
  });
}

const structured = (summary: string, projects: string[] = []): StructuredReport => ({
  summary,
  tasks_done: [],
  blockers: [],
  projects,
  next_steps: [],
});

beforeAll(async () => {
  await cleanDb();
});
afterAll(async () => {
  await closePool();
});
beforeEach(async () => {
  await cleanDb();
});

describe("getSubtreeReportedStatus + getReportsForUsersWithProjects (CHANGE G)", () => {
  it("reports reported/pending per subtree member and joins linked project names", async () => {
    // tree: root -> (rohit, sana); rohit -> meera
    const root = await makeUser("100", "Root");
    const rohit = await makeUser("200", "Rohit");
    const sana = await makeUser("300", "Sana");
    const meera = await makeUser("400", "Meera");
    // An out-of-subtree user in a separate tree.
    const outsider = await makeUser("900", "Outsider");

    const pool = getPool();
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id IN ($2,$3)`, [root.id, rohit.id, sana.id]);
    await pool.query(`UPDATE users SET manager_id=$1 WHERE id=$2`, [rohit.id, meera.id]);

    const today = "2026-07-23";
    const proj = await matchOrCreateProject("Narang Vivenda", "vivenda");

    // Rohit + Meera reported today; Sana + Outsider did not.
    await insertReportWithProjects(
      {
        user_id: rohit.id,
        report_date: today,
        raw_transcript: "closed bookings",
        structured_json: structured("Closed 2 bookings.", ["Narang Vivenda"]),
        source_kind: "text",
        language: "text-provided",
        source_message_id: "r-rohit",
      },
      [proj.id],
    );
    await insertReportWithProjects(
      {
        user_id: meera.id,
        report_date: today,
        raw_transcript: "admin",
        structured_json: structured("General admin work."),
        source_kind: "text",
        language: "text-provided",
        source_message_id: "r-meera",
      },
      [],
    );
    // Outsider report should NEVER show up in root's subtree.
    await insertReportWithProjects(
      {
        user_id: outsider.id,
        report_date: today,
        raw_transcript: "secret",
        structured_json: structured("Outside data."),
        source_kind: "text",
        language: "text-provided",
        source_message_id: "r-out",
      },
      [proj.id],
    );

    const ids = await getSubtreeUserIds(root.id);
    expect(ids.sort((a, b) => a - b)).toEqual([rohit.id, sana.id, meera.id].sort((a, b) => a - b));
    expect(ids).not.toContain(outsider.id);

    const status = await getSubtreeReportedStatus(ids, today);
    const byName = Object.fromEntries(status.map((s) => [s.name, s.reported]));
    expect(byName).toEqual({ Rohit: true, Sana: false, Meera: true });
    expect(status.find((s) => s.name === "Outsider")).toBeUndefined();

    const reports = await getReportsForUsersWithProjects(ids, { from: today, to: today });
    expect(reports.length).toBe(2); // rohit + meera, NOT outsider
    const rohitRow = reports.find((r) => r.reporter_name === "Rohit")!;
    expect(rohitRow.project_names).toEqual(["Narang Vivenda"]);
    const meeraRow = reports.find((r) => r.reporter_name === "Meera")!;
    expect(meeraRow.project_names).toEqual([]); // no linked project → empty array
  });

  it("returns empty arrays for an empty id set", async () => {
    expect(await getSubtreeReportedStatus([], "2026-07-23")).toEqual([]);
    expect(await getReportsForUsersWithProjects([], { from: "2026-07-23", to: "2026-07-23" })).toEqual([]);
  });
});
