import { describe, expect, it } from "bun:test";

import {
  TASK_REPORT_WITHHELD_MESSAGE,
  applyTaskReportProvenance,
  workspaceHistoryCarriesProjectSkillContent,
} from "./taskReportProvenance";

describe("applyTaskReportProvenance", () => {
  const report = {
    reportMarkdown: "The skill says X",
    title: "Findings",
    structuredOutput: { x: 1 },
  };

  it("leaves a clean report alone, stamps a carrying one, withholds it when the turn excludes", () => {
    expect(applyTaskReportProvenance(report, { carries: false, excludes: true })).toBe(report);
    expect(applyTaskReportProvenance(report, { carries: true, excludes: false })).toEqual({
      ...report,
      carriesProjectSkillContent: true,
    });
    const withheld = applyTaskReportProvenance(report, { carries: true, excludes: true });
    expect(withheld.reportMarkdown).toBe(TASK_REPORT_WITHHELD_MESSAGE);
    expect(withheld.title).toBeUndefined();
    expect(withheld.structuredOutput).toBeUndefined();
    expect(withheld.carriesProjectSkillContent).toBeUndefined();
  });
});

describe("workspaceHistoryCarriesProjectSkillContent", () => {
  it("fails closed without history access or an unreadable history", async () => {
    expect(await workspaceHistoryCarriesProjectSkillContent({}, "ws")).toBe(true);
    expect(await workspaceHistoryCarriesProjectSkillContent({}, undefined)).toBe(true);
    const unreadable = {
      getHistoryFromLatestBoundary: () =>
        Promise.resolve({ success: false as const, error: "gone" }),
    };
    expect(
      await workspaceHistoryCarriesProjectSkillContent(
        { historyService: unreadable as never },
        "ws"
      )
    ).toBe(true);
    const clean = {
      getHistoryFromLatestBoundary: () => Promise.resolve({ success: true as const, data: [] }),
    };
    expect(
      await workspaceHistoryCarriesProjectSkillContent({ historyService: clean as never }, "ws")
    ).toBe(false);
  });
});
