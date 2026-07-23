import { describe, it, expect } from "vitest";
import {
  buildHelpMessage,
  HELP_BASIC,
  HELP_MENU_HINT,
  HELP_MANAGER,
  HELP_STATUS,
  HELP_ROOT,
} from "../src/domain/help";

/** Minimal user with just the derived role flags buildHelpMessage reads. */
function flags(is_manager: boolean, is_root: boolean) {
  return { is_manager, is_root };
}

describe("buildHelpMessage (CHANGE F + G role-based sections)", () => {
  it("plain IC gets only the basic section + menu hint", () => {
    const msg = buildHelpMessage(flags(false, false));
    expect(msg).toContain(HELP_BASIC);
    expect(msg).toContain(HELP_MENU_HINT);
    // No manager/status/root sections.
    expect(msg).not.toContain(HELP_MANAGER);
    expect(msg).not.toContain(HELP_STATUS);
    expect(msg).not.toContain(HELP_ROOT);
  });

  it("derived manager additionally gets the team-query AND daily-status sections", () => {
    const msg = buildHelpMessage(flags(true, false));
    expect(msg).toContain(HELP_BASIC);
    expect(msg).toContain(HELP_MANAGER);
    expect(msg).toContain(HELP_STATUS); // CHANGE G daily-status line
    expect(msg).toContain(HELP_MENU_HINT);
    // Not a root → no reminder-admin section.
    expect(msg).not.toContain(HELP_ROOT);
  });

  it("root additionally gets the reminder-admin section (and manager+status too)", () => {
    const msg = buildHelpMessage(flags(true, true));
    expect(msg).toContain(HELP_BASIC);
    expect(msg).toContain(HELP_MANAGER);
    expect(msg).toContain(HELP_STATUS);
    expect(msg).toContain(HELP_ROOT);
    expect(msg).toContain(HELP_MENU_HINT);
  });

  it("a root with no descendants still gets the reminder-admin section", () => {
    // is_root but not yet a derived manager (nobody reports to them yet).
    const msg = buildHelpMessage(flags(false, true));
    expect(msg).toContain(HELP_BASIC);
    expect(msg).toContain(HELP_ROOT);
    // No manager/status lines because is_manager is false.
    expect(msg).not.toContain(HELP_MANAGER);
    expect(msg).not.toContain(HELP_STATUS);
  });
});
