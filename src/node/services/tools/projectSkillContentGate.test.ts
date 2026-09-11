import { describe, expect, it } from "bun:test";
import { toolExcludesProjectSkillContent } from "./projectSkillContentGate";

describe("toolExcludesProjectSkillContent", () => {
  it("combines the assembly-time verdict with a trust re-read at the call, failing closed", async () => {
    // Unrouted turn: nothing to exclude. Untrusted routed turn: excluded
    // regardless of the re-read. Trusted routed turn: the re-read decides —
    // a revocation between assembly and the call excludes, a throwing
    // re-read excludes too.
    expect(await toolExcludesProjectSkillContent({})).toBe(false);
    expect(await toolExcludesProjectSkillContent({ excludeProjectSkillContent: true })).toBe(true);
    expect(
      await toolExcludesProjectSkillContent({
        excludeProjectSkillContent: true,
        projectSkillContentStillReadable: () => Promise.resolve(true),
      })
    ).toBe(true);
    expect(
      await toolExcludesProjectSkillContent({
        projectSkillContentStillReadable: () => Promise.resolve(true),
      })
    ).toBe(false);
    expect(
      await toolExcludesProjectSkillContent({
        projectSkillContentStillReadable: () => Promise.resolve(false),
      })
    ).toBe(true);
    expect(
      await toolExcludesProjectSkillContent({
        projectSkillContentStillReadable: () => Promise.reject(new Error("trust unreadable")),
      })
    ).toBe(true);
  });
});
