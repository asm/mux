import { describe, expect, it } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { renderAgentSkillSnapshotText } from "@/common/utils/agentSkills/skillSnapshot";

import {
  extractLoadedSkillSnapshotsFromMessages,
  PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE,
  redactProjectSkillToolResults,
  rowCarriesProjectSkillContent,
} from "./loadedSkillSnapshots";

function createAgentSkillReadToolMessage(args: {
  id: string;
  skillName: string;
  body: string;
  scope?: "project" | "global" | "built-in";
}): MuxMessage {
  const scope = args.scope ?? "project";
  return {
    id: args.id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `tool-${args.id}`,
        toolName: "agent_skill_read",
        state: "output-available",
        input: { name: args.skillName },
        output: {
          success: true,
          skill: {
            scope,
            directoryName: args.skillName,
            frontmatter: {
              name: args.skillName,
              description: `${args.skillName} description`,
            },
            body: args.body,
          },
        },
      },
    ],
    metadata: {
      timestamp: Date.now(),
    },
  };
}

function createSyntheticSkillSnapshotMessage(args: {
  id: string;
  skillName: string;
  body: string;
  scope?: "project" | "global" | "built-in";
}): MuxMessage {
  const scope = args.scope ?? "project";
  return createMuxMessage(
    args.id,
    "user",
    renderAgentSkillSnapshotText({
      name: args.skillName,
      scope,
      body: args.body,
    }),
    {
      synthetic: true,
      agentSkillSnapshot: {
        skillName: args.skillName,
        scope,
        sha256: `${args.id}-sha`,
        frontmatterYaml: `name: ${args.skillName}\ndescription: ${args.skillName} description`,
      },
    }
  );
}

describe("extractLoadedSkillSnapshotsFromMessages", () => {
  it("extracts snapshots from nested agent_skill_read records inside code_execution", () => {
    // Exclusive PTC: skill reads happen as nested xum.agent_skill_read calls,
    // so the snapshot must be recovered from the code_execution record.
    const nestedMessage: MuxMessage = {
      id: "nested",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-nested",
          toolName: "code_execution",
          state: "output-available",
          input: { code: "..." },
          output: {
            success: true,
            toolCalls: [
              {
                toolName: "agent_skill_read",
                args: { name: "nested-skill" },
                result: {
                  success: true,
                  skill: {
                    scope: "project",
                    directoryName: "nested-skill",
                    frontmatter: { name: "nested-skill", description: "nested description" },
                    body: "Nested body",
                  },
                },
              },
              // Failed and kernel-compacted records (no full result) yield nothing.
              { toolName: "agent_skill_read", args: { name: "failed-skill" }, error: "denied" },
              { toolName: "agent_skill_read", args: { name: "kernel-skill" }, ok: true, bytes: 9 },
              // Contradictory untrusted row: explicit ok:false is authoritative
              // failure even when a schema-valid result rides alongside (r18).
              {
                toolName: "agent_skill_read",
                args: { name: "contradictory-skill" },
                ok: false,
                result: {
                  success: true,
                  skill: {
                    scope: "project",
                    directoryName: "contradictory-skill",
                    frontmatter: {
                      name: "contradictory-skill",
                      description: "contradictory description",
                    },
                    body: "Contradictory body",
                  },
                },
              },
              { toolName: "bash", args: { script: "true" }, result: { success: true } },
            ],
          },
        },
      ],
    };

    const snapshots = extractLoadedSkillSnapshotsFromMessages([nestedMessage]);
    expect(snapshots.map((snapshot) => snapshot.name)).toEqual(["nested-skill"]);
    expect(snapshots[0].body).toContain("Nested body");
  });

  it("dedupes by scope/name and keeps the latest read order", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createAgentSkillReadToolMessage({
        id: "alpha-old",
        skillName: "alpha-skill",
        body: "Old alpha body",
      }),
      createAgentSkillReadToolMessage({
        id: "beta",
        skillName: "beta-skill",
        body: "Beta body",
        scope: "global",
      }),
      createAgentSkillReadToolMessage({
        id: "alpha-new",
        skillName: "alpha-skill",
        body: "New alpha body",
      }),
    ]);

    expect(snapshots.map((snapshot) => `${snapshot.scope}:${snapshot.name}`)).toEqual([
      "global:beta-skill",
      "project:alpha-skill",
    ]);
    expect(snapshots[1]?.body).toContain("New alpha body");
  });

  it("falls back to synthetic slash-command snapshots when no tool output exists", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createSyntheticSkillSnapshotMessage({
        id: "slash-react-effects",
        skillName: "react-effects",
        body: "Avoid unnecessary useEffect calls.",
      }),
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.name).toBe("react-effects");
    expect(snapshots[0]?.body).toContain("Avoid unnecessary useEffect calls.");
    expect(snapshots[0]?.sha256).toBeTruthy();
  });

  it("lets a later agent_skill_read output override an earlier synthetic snapshot", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createSyntheticSkillSnapshotMessage({
        id: "slash-test-skill",
        skillName: "test-skill",
        body: "Old synthetic body",
      }),
      createAgentSkillReadToolMessage({
        id: "tool-test-skill",
        skillName: "test-skill",
        body: "New tool body",
      }),
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.body).toContain("New tool body");
  });
});

describe("project skill content in persisted tool results", () => {
  function nestedRecordsMessage(records: unknown[]): MuxMessage {
    return {
      id: "nested",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-nested",
          toolName: "code_execution",
          state: "output-available",
          input: { code: "..." },
          output: { success: true, toolCalls: records },
        },
      ],
    };
  }
  const projectResult = (name: string, body: string) => ({
    success: true,
    skill: {
      scope: "project",
      directoryName: name,
      frontmatter: { name, description: `${name} description` },
      body,
    },
  });

  it("counts a retained project skill even when the nested record is marked failed", () => {
    // The snapshot extractor drops a contradictory `ok: false` record as a
    // failed call; the confidentiality scan must not — the retained body
    // would still leave for the class provider.
    const message = nestedRecordsMessage([
      {
        toolName: "agent_skill_read",
        args: { name: "contradictory-skill" },
        ok: false,
        result: projectResult("contradictory-skill", "Contradictory body"),
      },
    ]);
    expect(extractLoadedSkillSnapshotsFromMessages([message])).toHaveLength(0);
    expect(rowCarriesProjectSkillContent(message)).toBe(true);

    const [redacted] = redactProjectSkillToolResults([message]);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("Contradictory body");
    expect(serialized).toContain(PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE);
    // The redaction copies; history rows are untouched.
    expect(JSON.stringify(message)).toContain("Contradictory body");
  });

  it("ignores global skills and non-skill tool results, and keeps them intact", () => {
    const message: MuxMessage = {
      ...createAgentSkillReadToolMessage({
        id: "global-read",
        skillName: "team-style",
        body: "Global body",
        scope: "global",
      }),
    };
    const bashOnly = nestedRecordsMessage([
      { toolName: "bash", args: { script: "true" }, result: { success: true } },
    ]);
    expect(rowCarriesProjectSkillContent(message)).toBe(false);
    expect(rowCarriesProjectSkillContent(bashOnly)).toBe(false);
    expect(redactProjectSkillToolResults([message, bashOnly])).toEqual([message, bashOnly]);
  });

  it("detects direct project results and synthetic snapshot rows alike", () => {
    const direct = createAgentSkillReadToolMessage({
      id: "direct-read",
      skillName: "repo-conventions",
      body: "Direct body",
    });
    const synthetic = createSyntheticSkillSnapshotMessage({
      id: "synthetic",
      skillName: "repo-conventions",
      body: "Synthetic body",
    });
    expect(rowCarriesProjectSkillContent(direct)).toBe(true);
    expect(rowCarriesProjectSkillContent(synthetic)).toBe(true);
    const [redactedDirect] = redactProjectSkillToolResults([direct]);
    expect(JSON.stringify(redactedDirect)).not.toContain("Direct body");
    expect(rowCarriesProjectSkillContent(redactedDirect)).toBe(false);
  });
});
