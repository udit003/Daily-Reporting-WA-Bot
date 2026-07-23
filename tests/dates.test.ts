import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  istToday,
  istRange,
  addDays,
  dayOfWeek,
  nowInTz,
  hhmmCompare,
  hhmmToMinutes,
  isWithinWindow,
  dateStringInTz,
} from "../src/util/dates";

// Prove IST-fixed semantics hold regardless of the server's local TZ.
const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles"; // deliberately far from IST
});
afterAll(() => {
  process.env.TZ = originalTZ;
});

describe("IST day mapping (server TZ independence)", () => {
  it("maps a 23:00 IST timestamp to the correct IST day", () => {
    // 2025-03-10 23:00 IST == 2025-03-10 17:30 UTC
    const at2300Ist = new Date("2025-03-10T17:30:00.000Z");
    expect(istToday(at2300Ist)).toBe("2025-03-10");
  });

  it("maps an early-morning IST timestamp to that IST day even when UTC is prior day", () => {
    // 2025-03-11 00:30 IST == 2025-03-10 19:00 UTC
    const at0030Ist = new Date("2025-03-10T19:00:00.000Z");
    expect(istToday(at0030Ist)).toBe("2025-03-11");
  });

  it("dateStringInTz is independent of process.env.TZ", () => {
    const instant = new Date("2025-03-10T17:30:00.000Z");
    expect(dateStringInTz(instant, "Asia/Kolkata")).toBe("2025-03-10");
    expect(dateStringInTz(instant, "UTC")).toBe("2025-03-10");
    // In LA this instant is still 2025-03-10 (10:30 PDT)
    expect(dateStringInTz(instant, "America/Los_Angeles")).toBe("2025-03-10");
  });
});

describe("date arithmetic helpers", () => {
  it("addDays crosses month boundaries", () => {
    expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
    expect(addDays("2025-03-01", -1)).toBe("2025-02-28");
  });
  it("dayOfWeek: 2025-03-10 is a Monday", () => {
    expect(dayOfWeek("2025-03-10")).toBe(1);
  });
});

describe("istRange inclusive boundaries", () => {
  // Fixed 'now' = 2025-03-12 (Wednesday) IST.
  const now = new Date("2025-03-12T06:00:00.000Z"); // 11:30 IST on the 12th

  it("today is a single-day inclusive range", () => {
    expect(istRange("today", now)).toEqual({ from: "2025-03-12", to: "2025-03-12" });
  });

  it("last 7 days = today + 6 prior days inclusive", () => {
    expect(istRange("last 7 days", now)).toEqual({
      from: "2025-03-06",
      to: "2025-03-12",
    });
  });

  it("this week = Monday..today inclusive", () => {
    // 2025-03-12 is Wednesday; Monday is 2025-03-10.
    expect(istRange("this week", now)).toEqual({
      from: "2025-03-10",
      to: "2025-03-12",
    });
  });

  it("this week when today IS Monday = single day", () => {
    const monday = new Date("2025-03-10T06:00:00.000Z");
    expect(istRange("this week", monday)).toEqual({
      from: "2025-03-10",
      to: "2025-03-10",
    });
  });

  it("unknown phrase defaults to last 7 days", () => {
    expect(istRange("blah", now)).toEqual({ from: "2025-03-06", to: "2025-03-12" });
    expect(istRange(undefined, now)).toEqual({ from: "2025-03-06", to: "2025-03-12" });
  });
});

describe("reminder-window comparisons", () => {
  it("hhmmToMinutes / hhmmCompare", () => {
    expect(hhmmToMinutes("17:00")).toBe(1020);
    expect(hhmmCompare("17:00", "17:15")).toBe(-1);
    expect(hhmmCompare("22:00", "17:00")).toBe(1);
    expect(hhmmCompare("17:00", "17:00")).toBe(0);
  });

  it("isWithinWindow is inclusive on both ends", () => {
    expect(isWithinWindow("17:00", "17:00", "22:00")).toBe(true);
    expect(isWithinWindow("22:00", "17:00", "22:00")).toBe(true);
    expect(isWithinWindow("16:59", "17:00", "22:00")).toBe(false);
    expect(isWithinWindow("22:01", "17:00", "22:00")).toBe(false);
    expect(isWithinWindow("19:30", "17:00", "22:00")).toBe(true);
  });

  it("nowInTz returns wall-clock in the requested TZ", () => {
    // 2025-03-10 17:30 UTC -> 23:00 IST
    const instant = new Date("2025-03-10T17:30:00.000Z");
    const ist = nowInTz("Asia/Kolkata", instant);
    expect(ist.date).toBe("2025-03-10");
    expect(ist.hhmm).toBe("23:00");
    // Same instant in UTC is 17:30
    expect(nowInTz("UTC", instant).hhmm).toBe("17:30");
  });
});
