import { describe, expect, it } from "bun:test";
import { collectRejectedTurnRowIds, createMuxMessage, excludeRejectedTurnRows } from "./message";

describe("collectRejectedTurnRowIds", () => {
  const rows = [
    createMuxMessage("u-earlier", "user", "earlier prompt", { timestamp: 1 }),
    createMuxMessage("snap-skill", "user", "skill body", {
      timestamp: 2,
      synthetic: true,
      agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "x" },
    }),
    createMuxMessage("snap-mcp", "user", "prompt expansion", {
      timestamp: 3,
      synthetic: true,
      mcpPromptSnapshot: { serverName: "srv", promptName: "p", commandKey: "srv:p" },
    }),
    createMuxMessage("u-rejected", "user", "refused prompt", { timestamp: 4 }),
    createMuxMessage("a-later", "assistant", "later answer", { timestamp: 5 }),
    createMuxMessage("u-later", "user", "later prompt", { timestamp: 6 }),
  ];

  it("expands a turn key to its user row and the contiguous synthetic snapshot prefix", () => {
    // A durable repair record only names the user row; the repository content
    // rides the snapshot rows persisted immediately before it.
    expect([...collectRejectedTurnRowIds(rows, ["u-rejected"])].sort()).toEqual([
      "snap-mcp",
      "snap-skill",
      "u-rejected",
    ]);
  });

  it("stops at the first non-snapshot row and passes non-turn ids through unchanged", () => {
    // "u-later" is preceded by an assistant row: nothing to expand. Quarantined
    // assistant ids and already-truncated keys stay excluded as given.
    expect([...collectRejectedTurnRowIds(rows, ["u-later", "a-later", "gone"])].sort()).toEqual([
      "a-later",
      "gone",
      "u-later",
    ]);
  });
});

describe("excludeRejectedTurnRows", () => {
  it("drops stamped turns (unstamped snapshot prefix included) and quarantined turns", () => {
    // A side channel must see neither the refused prompts nor the repository
    // content that rode in with them — whether the turn's stamp landed only on
    // its user row or never landed at all (quarantined key).
    const rows = [
      createMuxMessage("snap-stamped-turn", "user", "project skill body", {
        timestamp: 1,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "x" },
      }),
      createMuxMessage("u-stamped", "user", "refused prompt", {
        timestamp: 2,
        preStreamRejected: true,
      }),
      createMuxMessage("a-kept", "assistant", "kept answer", { timestamp: 3 }),
      createMuxMessage("snap-quarantined-turn", "user", "prompt expansion", {
        timestamp: 4,
        synthetic: true,
        mcpPromptSnapshot: { serverName: "srv", promptName: "p", commandKey: "srv:p" },
      }),
      createMuxMessage("u-quarantined", "user", "unstamped refusal", { timestamp: 5 }),
      createMuxMessage("u-kept", "user", "later prompt", { timestamp: 6 }),
    ];
    expect(excludeRejectedTurnRows(rows, ["u-quarantined"]).map((row) => row.id)).toEqual([
      "a-kept",
      "u-kept",
    ]);
  });
});
