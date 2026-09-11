import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { LoadedSkillSnapshot } from "@/common/types/attachment";
import {
  createMuxMessage,
  type ModelMessage,
  type MuxMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import type { ResolvedAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";
import { PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE } from "@/node/services/agentSkills/loadedSkillSnapshots";
import type { HistoryService } from "@/node/services/historyService";
import {
  createUnknownSendMessageError,
  ROUTED_SKILL_TRUST_REVOKED_MESSAGE,
} from "@/node/services/utils/sendMessageError";

import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";

const USER_MODEL = "anthropic:claude-fable-5";

describe("AgentSession.sendMessage (per-skill model routing)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  const tempDirs: string[] = [];
  const sessions: Array<{ dispose: () => Promise<void> }> = [];
  afterEach(async () => {
    // Safety net: a failed assertion above a test's own dispose() must not
    // leak a live session into the rest of the file, and temp skill trees
    // must not accumulate in the OS temp dir.
    for (const session of sessions.splice(0)) {
      try {
        await session.dispose();
      } catch {
        // Already disposed by the test body.
      }
    }
    await historyCleanup?.();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function createWorkspaceWithSkill(args: { skillName: string; metadataYaml?: string }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mux-skill-routing-"));
    tempDirs.push(tmp);
    const skillDir = path.join(tmp, ".mux", "skills", args.skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const skillMarkdown = `---\nname: ${args.skillName}\ndescription: Test skill\n${args.metadataYaml ?? ""}---\n\nDo the thing.\n`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown, "utf-8");
    return tmp;
  }

  async function createRoutingHarness(args: {
    workspacePath: string;
    /** Default true: routing fixtures exercise trusted-project behavior. */
    projectTrusted?: boolean;
    /** Workspace kind for the metadata (scratch workdirs never route project skills). */
    workspaceKind?: string;
    configValues?: {
      modelClasses?: Record<string, string>;
      skillModelClasses?: Record<string, string>;
      routePriority?: string[];
    };
    /** When provided, getProvidersConfigSafe sees this map (enables the availability check). */
    providersConfig?: Record<string, { isConfigured: boolean; isEnabled?: boolean }>;
  }) {
    const workspaceId = "ws-skill-routing";
    const workspaceMeta = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: args.workspacePath,
      namedWorkspacePath: args.workspacePath,
      runtimeConfig: { type: "local" },
      ...(args.workspaceKind != null ? { kind: args.workspaceKind } : {}),
    } as unknown as FrontendWorkspaceMetadata;

    const streamed: StreamMessageOptions[] = [];
    const streamMessage = mock((opts: StreamMessageOptions) => {
      streamed.push(opts);
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });

    const config = {
      srcDir: "/tmp",
      sessionsDir: "/tmp",
      getSessionDir: mock((_workspaceId: string) => "/tmp"),
      loadConfigOrDefault: mock(() => ({
        ...args.configValues,
        // Project-scope frontmatter routing requires Project Trust; these
        // fixtures write skills into the workspace's own project.
        projects: new Map(
          args.projectTrusted === false ? [] : [[args.workspacePath, { trusted: true }]]
        ),
      })),
    } as unknown as Config;

    const { session, cleanup, historyService, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      aiServiceOverrides: {
        getWorkspaceMetadata: mock((_id: string) => Promise.resolve(Ok(workspaceMeta))),
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
        ...(args.providersConfig != null
          ? { getProvidersConfig: mock(() => args.providersConfig) }
          : {}),
      } as unknown as Partial<AIService>,
      captureEvents: true,
    });
    historyCleanup = cleanup;
    sessions.push(session);
    return { session, streamed, historyService, events };
  }

  /** Force the next send onto the on-send compaction path (mirrors the autoCompaction fixtures). */
  function forceOnSendCompaction(session: object): void {
    (session as { compactionMonitor: unknown }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    };
  }

  /** Revoke Project Trust the instant routing consent is granted (before the later rechecks). */
  function revokeTrustAfterRouting(
    session: object,
    harnessArgs: Parameters<typeof createRoutingHarness>[0]
  ): void {
    const withResolve = session as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );
  }

  function skillSendOptions(overrides?: Record<string, unknown>) {
    return {
      model: USER_MODEL,
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/done",
        skillName: "done",
        scope: "project",
      },
      ...overrides,
    };
  }

  it("streams a metadata-bound skill on its class model with resolved thinking", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    // The accepted-send payload reports the routed model and thinking so the
    // frontend can attribute send telemetry to what actually streams.
    expect(result.success && result.data?.routedModel).toBe(KNOWN_MODELS.HAIKU.id);
    expect(result.success && result.data?.routedThinkingLevel).toBe("off");
    expect(streamed).toHaveLength(1);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    // "+0" is model-relative: haiku's lowest allowed level is "off".
    expect(streamed[0].thinkingLevel).toBe("off");
    await session.dispose();
  });

  it("ignores project-skill frontmatter bindings in untrusted projects", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // Repo-controlled frontmatter must not reroute the transcript to a
    // different configured provider without Project Trust: the send streams
    // on the workspace model as if the skill were unbound.
    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed).toHaveLength(1);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    await session.dispose();
  });

  it("never routes scratch-workspace project skills via frontmatter, even though scratch is app-trusted", async () => {
    // Scratch workdirs hold cloned third-party repos whose .xum/skills are
    // discovered; app-level scratch trust (isWorkspaceProjectTrusted) must not
    // extend to provider-selection consent.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      workspaceKind: "scratch",
      // Even an (impossible in practice) trusted-projects entry must not help:
      // the scratch guard fires before the project-trust lookup.
      projectTrusted: true,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed[0].modelString).toBe(USER_MODEL);
    await session.dispose();
  });

  it("rejects the routed turn when trust is revoked between routing and materialization", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    // Retained by loadConfigOrDefault's closure, so flipping projectTrusted
    // below is observed by the next trust read.
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed } = await createRoutingHarness(harnessArgs);

    // Revoke trust the instant routing consent is granted: the
    // materialization-time re-read must reject the routed turn — exempting
    // the pre-resolved package would ship the repo-controlled snapshot (and
    // keep the class route) to the alternate provider without consent.
    const withResolve = session as unknown as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }
    expect(streamed).toHaveLength(0);
    await session.dispose();
  });

  it("rejects a revoked TABLE-bound route too (no fast path hides the invocation)", async () => {
    // The trusted table-binding path used to skip package resolution, which
    // left the routed invocation unidentifiable at recheck time — revocation
    // then merely omitted the snapshot while the conversation still streamed
    // on the class provider.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
    };
    const { session, streamed } = await createRoutingHarness(harnessArgs);

    const withResolve = session as unknown as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }
    expect(streamed).toHaveLength(0);
    await session.dispose();
  });

  it("preserves a queued send rejected by the trust recheck", async () => {
    // A dequeued prompt's composer already cleared: the recheck rejection
    // must leave a durable transcript row (like the routing/pricing/PDF
    // gates) instead of silently dropping it while the queue moves on.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);

    const withResolve = session as unknown as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions(), {
      dequeued: true,
      enqueuedAtMs: 123,
    });
    expect(result.success).toBe(false);
    expect(streamed).toHaveLength(0);

    const history = await historyService.getLastMessages("ws-skill-routing", 5);
    expect(history.success).toBe(true);
    const preserved = history.success
      ? history.data.find((msg) => msg.metadata?.preStreamRejected === true)
      : undefined;
    expect(preserved?.role).toBe("user");
    expect(preserved?.parts?.[0]).toMatchObject({ type: "text", text: "Use skill done" });
    await session.dispose();
  });

  it("late revocation surfaces as an accepted pre-stream failure, not a retryable Err", async () => {
    // Trust flips AFTER materialization (its internal recheck saw consent):
    // the pre-stream consent gate must stop the dispatch — and because the
    // turn's rows are durable by then, it must NOT return a pre-acceptance
    // Err (the renderer would restore a draft that duplicates the persisted
    // row). The visible record is the emitted stream error.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);

    const withMaterialize = session as unknown as {
      materializeAgentSkillSnapshots: (...materializeArgs: unknown[]) => Promise<unknown>;
    };
    const originalMaterialize = withMaterialize.materializeAgentSkillSnapshots.bind(session);
    spyOn(withMaterialize, "materializeAgentSkillSnapshots").mockImplementation(
      async (...materializeArgs: unknown[]) => {
        const materialized = await originalMaterialize(...materializeArgs);
        harnessArgs.projectTrusted = false;
        return materialized;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    // Accepted, but no provider request happened: the renderer must not
    // attribute send telemetry to the ambient model for this turn.
    expect(result.success && result.data).toEqual({ acceptedWithoutStream: true });
    expect(streamed).toHaveLength(0);

    // The turn's own row persisted exactly once — no rejected-copy duplicate.
    const history = await historyService.getLastMessages("ws-skill-routing", 10);
    expect(history.success).toBe(true);
    if (history.success) {
      const userRows = history.data.filter(
        (msg) => msg.role === "user" && !msg.metadata?.synthetic
      );
      expect(userRows).toHaveLength(1);
    }
    await session.dispose();
  });

  it("does not let an untrusted project skill inherit a name-keyed table binding", async () => {
    // Shadow protection: the table entry's consent belongs to whatever skill
    // the user knew by this name (typically global/built-in), and project
    // skills win name collisions — so in an UNTRUSTED project a repo-shipped
    // shadow must not route via the table either.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed[0].modelString).toBe(USER_MODEL);
    await session.dispose();
  });

  it("lets the config skillModelClasses table win over frontmatter metadata", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0", big: "anthropic:claude-opus-5+high" },
        skillModelClasses: { done: "big" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.OPUS.id);
    expect(streamed[0].thinkingLevel).toBe("high");
    await session.dispose();
  });

  it("routes a table-bound skill that has no frontmatter metadata", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    await session.dispose();
  });

  it("never re-routes sends that carry an explicit model override (skipSkillModelRouting)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ skipSkillModelRouting: true })
    );
    expect(result.success).toBe(true);
    // No routing applied — the accepted-send payload must not name a model.
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed[0].modelString).toBe(USER_MODEL);
    expect(streamed[0].thinkingLevel).toBeUndefined();
    await session.dispose();
  });

  it("still routes sends that only skip settings persistence (thinking-only one-shots)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // "/+2 /done" sets skipAiSettingsPersistence (to protect preferences) with
    // no model override — class routing must still apply to the model while
    // the explicit thinking level wins over the class default.
    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ skipAiSettingsPersistence: true, thinkingLevel: "medium" })
    );
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    expect(streamed[0].thinkingLevel).toBe("medium");
    // The payload reports the effective level even when the one-shot rode
    // through unchanged — telemetry must see what the routed stream runs at.
    expect(result.success && result.data?.routedThinkingLevel).toBe("medium");
    await session.dispose();
  });

  it("re-resolves a numeric one-shot thinking index against the routed model", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku" } },
    });

    // "/+0 /done" typed on a workspace model whose lowest allowed level is
    // "medium": the frontend resolves thinkingLevel against the WORKSPACE
    // ladder and passes the raw index alongside. The routed model's ladder
    // differs (haiku's index 0 is "off"), so the re-resolved index — not the
    // pre-resolved level — must win.
    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({
        skipAiSettingsPersistence: true,
        thinkingLevel: "medium",
        oneShotThinkingIndex: 0,
      })
    );
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    expect(streamed[0].thinkingLevel).toBe("off");
    await session.dispose();
  });

  it("leaves frontmatter bindings to an undefined class inert (streams the caller's model)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: tiny\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // Skills the user does not own must not fail sends just because some
    // other class is configured — an undefined frontmatter class is inert.
    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    await session.dispose();
  });

  it("fails the send with an actionable error on a dangling table binding", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // The table is the user's own routing intent: naming a class that no
      // longer exists must error loudly, not silently unroute.
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "tiny" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    // The error must name the class so the user knows which mapping to fix.
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain('"tiny"');
    expect(streamed).toHaveLength(0);
    await session.dispose();
  });

  it("honors frontmatter routing when a hand-edited table entry is blank", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // A blank table value (hand-edit meaning "no override") must not
      // suppress the frontmatter read and silently unroute the skill.
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "  " } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    await session.dispose();
  });

  it("fails the send with an actionable error when the class value is invalid", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // Hand-edited config can hold values the strict-on-write path would
      // have rejected; the send must not silently ignore them.
      configValues: { modelClasses: { small: "not-a-model" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain('"small"');
    expect(streamed).toHaveLength(0);
    await session.dispose();
  });

  it("fails the send when no configured route can serve the class model", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, routePriority: ["direct"] },
      providersConfig: { anthropic: { isConfigured: false } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain(KNOWN_MODELS.HAIKU.id);
    expect(streamed).toHaveLength(0);
    await session.dispose();
  });

  it("routes normally when the class model has a configured route", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, routePriority: ["direct"] },
      providersConfig: { anthropic: { isConfigured: true, isEnabled: true } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    await session.dispose();
  });

  it("repairs an unstamped rejected turn before an accepted manual send commits its partial", async () => {
    // Startup recovery racing a manual send: the rejected turn's row stamp
    // AND its partial delete both failed before the restart, so only the
    // abandon marker still names the rejected row. Acceptance must repair
    // BEFORE it clears that marker, and the request build BEFORE it commits
    // partials — otherwise the unstamped prompt and the in-flight assistant
    // ride the very next provider request.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-rejected", "user", "refused prompt", { timestamp: 1 })
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("a-rejected", "assistant", "in-flight answer", {
        timestamp: 2,
        partial: true,
      })
    );
    (
      session as unknown as {
        startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      }
    ).startupAutoRetryAbandon = { reason: "pre_stream_rejected", userMessageId: "u-rejected" };

    const result = await session.sendMessage("next prompt", { model: USER_MODEL, agentId: "exec" });
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    const requestIds = streamed[0].messages.map((message) => message.id);
    expect(requestIds).not.toContain("u-rejected");
    expect(requestIds).not.toContain("a-rejected");

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    // Durably stamped (transcript-visible, provider-ineligible), partial gone.
    expect(history.data.find((m) => m.id === "u-rejected")?.metadata?.preStreamRejected).toBe(true);
    expect(history.data.some((m) => m.id === "a-rejected")).toBe(false);
    expect(await historyService.readPartial(workspaceId)).toBeNull();
    await session.dispose();
  });

  /**
   * Post-compaction fixtures for the attachment-channel consent tests: a
   * project skill read BEFORE a compaction boundary survives only inside the
   * loaded-skills attachment — the request rows no longer carry its snapshot.
   */
  const pendingLoadedSkills: LoadedSkillSnapshot[] = [
    { name: "repo-conventions", scope: "project", sha256: "a".repeat(64), body: "Repo rules." },
    { name: "team-style", scope: "global", sha256: "b".repeat(64), body: "Global rules." },
  ];

  /** Route a GLOBAL skill (routable in untrusted projects) with pending post-compaction state. */
  async function sendRoutedGlobalSkillWithPendingState(
    harnessArgs: Parameters<typeof createRoutingHarness>[0],
    extras?: {
      /** Rows persisted before the send (earlier turns of the conversation). */
      seedHistory?: (historyService: HistoryService) => Promise<void>;
      /** Post-compaction loaded skills to inject; defaults to the shared fixture set. */
      loadedSkills?: LoadedSkillSnapshot[];
    }
  ) {
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
    // The fixture skill lives in the project tree; present it as GLOBAL so
    // the invocation itself carries no project content and routes in an
    // untrusted project — only the attachment channel is under test.
    const withReader = session as unknown as {
      buildSkillReader: (...args: unknown[]) => (skillName: string) => Promise<ResolvedAgentSkill>;
      compactionHandler: { peekPendingState: () => Promise<unknown> };
    };
    const originalBuild = withReader.buildSkillReader.bind(session);
    spyOn(withReader, "buildSkillReader").mockImplementation((...args: unknown[]) => {
      const read = originalBuild(...args);
      return async (skillName: string) => {
        const resolved = await read(skillName);
        return { ...resolved, package: { ...resolved.package, scope: "global" as const } };
      };
    });
    spyOn(withReader.compactionHandler, "peekPendingState").mockResolvedValue({
      diffs: [],
      loadedSkills: extras?.loadedSkills ?? pendingLoadedSkills,
      readFiles: [],
    });
    await extras?.seedHistory?.(historyService);

    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/done",
          skillName: "done",
          scope: "global",
        },
      })
    );
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    const loadedSkillsAttachment = streamed[0].postCompactionAttachments?.find(
      (attachment) => attachment.type === "loaded_skills_snapshot"
    );
    return { session, streamed, loadedSkillsAttachment };
  }

  it("drops project-scope loaded skills from a routed request's attachments in an untrusted project", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, loadedSkillsAttachment } =
      await sendRoutedGlobalSkillWithPendingState({
        workspacePath,
        projectTrusted: false,
        configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
      });

    // The request rows carry no project snapshot, so only the attachment
    // could have shipped repo-controlled content to the class provider.
    expect(loadedSkillsAttachment?.skills.map((skill) => skill.name)).toEqual(["team-style"]);
    // Nothing project-scoped was kept, so the provider-boundary gate has
    // nothing to guard.
    expect(await streamed[0].preDispatchConsentGate?.()).toBeNull();
    await session.dispose();
  });

  it("arms the provider-boundary gate on project-scope loaded skills kept under trust", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
    };
    const { session, streamed, loadedSkillsAttachment } =
      await sendRoutedGlobalSkillWithPendingState(harnessArgs);

    // Trusted: the project skill rides along...
    expect(loadedSkillsAttachment?.skills.map((skill) => skill.name)).toEqual([
      "repo-conventions",
      "team-style",
    ]);
    // ...and a revocation between request assembly and the provider call
    // must still reject, even though no request ROW is project-scoped.
    harnessArgs.projectTrusted = false;
    const rejection = await streamed[0].preDispatchConsentGate?.();
    expect(JSON.stringify(rejection)).toMatch(/trust was revoked/i);
    await session.dispose();
  });

  it("rolls back the on-send compaction request when the pre-snapshot consent recheck refuses", async () => {
    // On-send compaction persists its request row (carrying the prompt as the
    // pending follow-up) BEFORE the consent recheck runs. A refusal that left
    // that row behind would let startup recovery resume the compaction and
    // dispatch a prompt whose send was reported failed.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
    forceOnSendCompaction(session);
    revokeTrustAfterRouting(session, harnessArgs);

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }
    expect(streamed).toHaveLength(0);

    const history = await historyService.getHistoryFromLatestBoundary("ws-skill-routing");
    if (!history.success) throw new Error(history.error);
    expect(
      history.data.some((message) => message.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(false);
    expect(history.data).toHaveLength(0);
    await session.dispose();
  });

  it("fails closed when the refused compaction request cannot be rolled back", async () => {
    // deleteMessages can fail with the row still on disk. The refusal must
    // then stamp the surviving compaction request provider-ineligible and key
    // the abandon marker to it, so neither request assembly nor startup
    // replay can pick up the prompt it carries.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, historyService } = await createRoutingHarness(harnessArgs);
    forceOnSendCompaction(session);
    revokeTrustAfterRouting(session, harnessArgs);
    const deleteSpy = spyOn(historyService, "deleteMessages").mockResolvedValue(
      Err("history locked")
    );
    try {
      const result = await session.sendMessage("Use skill done", skillSendOptions());
      expect(result.success).toBe(false);
    } finally {
      deleteSpy.mockRestore();
    }

    const history = await historyService.getHistoryFromLatestBoundary("ws-skill-routing");
    if (!history.success) throw new Error(history.error);
    const compactionRequest = history.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    if (compactionRequest == null) throw new Error("expected the unremovable row to survive");
    expect(compactionRequest.metadata?.preStreamRejected).toBe(true);
    const abandon = (
      session as unknown as {
        startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      }
    ).startupAutoRetryAbandon;
    expect(abandon).toEqual({ reason: "pre_stream_rejected", userMessageId: compactionRequest.id });
    await session.dispose();
  });

  it("keeps a durable repair key when the acceptance-time restamp fails", async () => {
    // The accepted send legitimately clears the abandon marker; if the repair
    // it ran first could only quarantine the rows in memory, a durable key
    // must survive for the next request build (or a post-crash startup) to
    // finish the stamp.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-rejected", "user", "refused prompt", { timestamp: 1 })
    );
    const internals = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      pendingRejectedTurnRepair: { userMessageIds: string[] } | null;
      repairUnstampedRejectedTurn: () => Promise<{ durable: boolean; partialSecured: boolean }>;
    };
    internals.startupAutoRetryAbandon = {
      reason: "pre_stream_rejected",
      userMessageId: "u-rejected",
    };

    const stampSpy = spyOn(historyService, "markMessagesPreStreamRejected").mockResolvedValue(
      Err("disk full")
    );
    try {
      const result = await session.sendMessage("next prompt", {
        model: USER_MODEL,
        agentId: "exec",
      });
      expect(result.success).toBe(true);
    } finally {
      stampSpy.mockRestore();
    }
    // The in-memory quarantine protected THIS request...
    expect(streamed).toHaveLength(1);
    expect(streamed[0].messages.map((message) => message.id)).not.toContain("u-rejected");
    // ...the accepted send cleared the marker as it always does...
    expect(internals.startupAutoRetryAbandon).toBeNull();
    // ...but the repair key survived it.
    expect(internals.pendingRejectedTurnRepair).toEqual({ userMessageIds: ["u-rejected"] });

    // The next repair pass completes the durable stamp and retires the record.
    expect((await internals.repairUnstampedRejectedTurn()).durable).toBe(true);
    expect(internals.pendingRejectedTurnRepair).toBeNull();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-rejected")?.metadata?.preStreamRejected).toBe(true);
    await session.dispose();
  });

  it("stamps a resumed routed turn's rows when the resume is refused for revoked trust", async () => {
    // A same-session retry or startup recovery replays the ORIGINAL accepted
    // turn; the resume path holds none of its row keys. A refusal must still
    // leave those rows provider-ineligible (and the abandon marker keyed) —
    // otherwise the next accepted manual send clears the marker and ships
    // the project content after all.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, historyService } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
    });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snap-routed", "user", "Do the thing.", {
        timestamp: 1,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "routed" },
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-routed", "user", "Use skill done", { timestamp: 2 })
    );

    const result = await session.resumeStream(
      { model: USER_MODEL, agentId: "exec" },
      { routedProjectConsent: true }
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-routed")?.metadata?.preStreamRejected).toBe(true);
    expect(history.data.find((m) => m.id === "snap-routed")?.metadata?.preStreamRejected).toBe(
      true
    );
    const abandon = (
      session as unknown as {
        startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      }
    ).startupAutoRetryAbandon;
    expect(abandon).toEqual({ reason: "pre_stream_rejected", userMessageId: "u-routed" });
    await session.dispose();
  });

  it("emits a refusal once: the gate for pre-start, the stream error path for per-step", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, events } = await createRoutingHarness(harnessArgs);
    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    const gate = streamed[0].preDispatchConsentGate;
    if (gate == null) throw new Error("routed turn must carry the provider-boundary gate");

    harnessArgs.projectTrusted = false;
    const streamErrorCount = () => events.filter((event) => event.type === "stream-error").length;
    const before = streamErrorCount();
    // Per-step: StreamManager throws the refusal through its standard failure
    // pipeline, which emits the visible row — a second one here would leave
    // two error rows for one refusal.
    expect(JSON.stringify(await gate({ midStream: true }))).toMatch(/trust was revoked/i);
    expect(streamErrorCount()).toBe(before);
    // Pre-start: nothing else surfaces the refusal.
    expect(JSON.stringify(await gate())).toMatch(/trust was revoked/i);
    expect(streamErrorCount()).toBe(before + 1);
    await session.dispose();
  });

  it("keeps the routed turn's consent gate on the active stream context for internal retries", async () => {
    // The post-compaction context_exceeded retry rebuilds the stream inside
    // AgentSession (outside StreamManager's gate-preserving recreations); it
    // must find the gate here or the rebuilt history reaches the class
    // provider unverified.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });
    const contextOf = () =>
      (session as unknown as { activeStreamContext?: { routedConsentRejection?: unknown } })
        .activeStreamContext;

    expect((await session.sendMessage("Use skill done", skillSendOptions())).success).toBe(true);
    expect(typeof contextOf()?.routedConsentRejection).toBe("function");
    await session.dispose();
  });

  it("leaves non-skill sends untouched even with routing configured", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("plain message", {
      model: USER_MODEL,
      agentId: "exec",
    });
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    await session.dispose();
  });

  /** Bounded poll for background stream startup: the mocked stream never ends, so idle-waits cannot serve. */
  async function waitFor(condition: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function appendRoutedTurnRows(
    historyService: Pick<HistoryService, "appendToHistory">,
    workspaceId: string
  ): Promise<void> {
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snap-routed", "user", "Do the thing.", {
        timestamp: 1,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "routed" },
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-routed", "user", "Use skill done", { timestamp: 2 })
    );
  }

  it("stamps a refused resumed turn from the key its resume request carries", async () => {
    // Startup recovery's tail scan and the accepted send both know the row
    // they arm a resume for, so the refusal must not depend on re-reading the
    // tail: a read failure there would persist a key-less marker that the next
    // accepted send retires as a no-op — project rows still provider-eligible.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, historyService } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
    });
    const workspaceId = "ws-skill-routing";
    await appendRoutedTurnRows(historyService, workspaceId);

    const tailSpy = spyOn(historyService, "getLastMessages").mockResolvedValue(Err("EIO"));
    try {
      const result = await session.resumeStream(
        { model: USER_MODEL, agentId: "exec" },
        { routedProjectConsent: true, userMessageId: "u-routed" }
      );
      expect(result.success).toBe(false);
    } finally {
      tailSpy.mockRestore();
    }
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-routed")?.metadata?.preStreamRejected).toBe(true);
    expect(history.data.find((m) => m.id === "snap-routed")?.metadata?.preStreamRejected).toBe(
      true
    );
    const abandon = (
      session as unknown as {
        startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      }
    ).startupAutoRetryAbandon;
    expect(abandon).toEqual({ reason: "pre_stream_rejected", userMessageId: "u-routed" });
    await session.dispose();
  });

  it("identifies a key-less refusal from the tail before the next accepted send clears it", async () => {
    // No carried key and an unreadable tail: the marker persists key-less.
    // Nothing streams while it stands, so the passes that run before it can be
    // cleared (startup; acceptance, excluding the row the accepted send itself
    // just persisted) identify the refused turn as the newest retry-eligible
    // row and stamp it — never retiring the refusal as a no-op.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
    });
    const workspaceId = "ws-skill-routing";
    await appendRoutedTurnRows(historyService, workspaceId);
    const internals = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    const tailSpy = spyOn(historyService, "getLastMessages").mockResolvedValue(Err("EIO"));
    try {
      const refused = await session.resumeStream(
        { model: USER_MODEL, agentId: "exec" },
        { routedProjectConsent: true }
      );
      expect(refused.success).toBe(false);
    } finally {
      tailSpy.mockRestore();
    }
    expect(internals.startupAutoRetryAbandon).toEqual({ reason: "pre_stream_rejected" });

    const accepted = await session.sendMessage("next prompt", {
      model: USER_MODEL,
      agentId: "exec",
    });
    expect(accepted.success).toBe(true);
    expect(streamed).toHaveLength(1);
    const requestIds = streamed[0].messages.map((message) => message.id);
    expect(requestIds).not.toContain("u-routed");
    expect(requestIds).not.toContain("snap-routed");
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-routed")?.metadata?.preStreamRejected).toBe(true);
    expect(history.data.find((m) => m.id === "snap-routed")?.metadata?.preStreamRejected).toBe(
      true
    );
    // The accepted send's own row was never mistaken for the refused turn.
    const acceptedRow = history.data.find(
      (m) => m.role === "user" && m.metadata?.synthetic !== true && m.id !== "u-routed"
    );
    if (acceptedRow == null) throw new Error("expected the accepted send's row");
    expect(acceptedRow.metadata?.preStreamRejected).toBeUndefined();
    expect(requestIds).toContain(acceptedRow.id);
    expect(internals.startupAutoRetryAbandon).toBeNull();
    await session.dispose();
  });

  it("stamps the persisted compaction request on a late refusal of an on-send-compacted routed turn", async () => {
    // On-send compaction persists ONLY the compaction request — the prompt
    // rides its deferred follow-up. A refusal at the post-acceptance gate must
    // key on that row: stamping the never-written user row skips as success,
    // and startup recovery would resume the real row, prompt included,
    // without routed consent.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
    forceOnSendCompaction(session);
    const result = await session.sendMessage("Use skill done", skillSendOptions(), {
      // Acceptance is the last hop before stream startup: revoke in between.
      onAccepted: () => {
        harnessArgs.projectTrusted = false;
      },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data?.acceptedWithoutStream).toBe(true);
    expect(streamed).toHaveLength(0);
    const history = await historyService.getHistoryFromLatestBoundary("ws-skill-routing");
    if (!history.success) throw new Error(history.error);
    const compactionRequest = history.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    if (compactionRequest == null) throw new Error("expected the compaction request row");
    expect(compactionRequest.metadata?.preStreamRejected).toBe(true);
    const internals = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      lastAutoRetryResumeRequest?: { userMessageId?: string; routedProjectConsent?: boolean };
    };
    expect(internals.startupAutoRetryAbandon).toEqual({
      reason: "pre_stream_rejected",
      userMessageId: compactionRequest.id,
    });
    // The same row keys the resume state, and its persisted retry options
    // make a startup resume re-verify trust like the turn itself.
    expect(internals.lastAutoRetryResumeRequest?.userMessageId).toBe(compactionRequest.id);
    expect(compactionRequest.metadata?.retrySendOptions?.routedProjectConsent).toBe(true);
    await session.dispose();
  });

  it("repairs each outstanding key on its own and retires only verified ones", async () => {
    // An older unstampable refusal must not be retired by a newer refusal
    // whose row is already stamped: the marker names the newer row, the record
    // the older one, and each is verified independently.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-old", "user", "older refused prompt", { timestamp: 1 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-new", "user", "newer refused prompt", {
        timestamp: 2,
        preStreamRejected: true,
      })
    );
    const internals = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      pendingRejectedTurnRepair: { userMessageIds: string[] } | null;
      repairUnstampedRejectedTurn: () => Promise<{ durable: boolean; partialSecured: boolean }>;
    };
    internals.pendingRejectedTurnRepair = { userMessageIds: ["u-old"] };
    internals.startupAutoRetryAbandon = { reason: "pre_stream_rejected", userMessageId: "u-new" };

    const realStamp = historyService.markMessagesPreStreamRejected.bind(historyService);
    const stampSpy = spyOn(historyService, "markMessagesPreStreamRejected").mockImplementation(
      (wsId: string, ids: string[]) =>
        ids.includes("u-old") ? Promise.resolve(Err("disk full")) : realStamp(wsId, ids)
    );
    try {
      expect((await internals.repairUnstampedRejectedTurn()).durable).toBe(false);
    } finally {
      stampSpy.mockRestore();
    }
    // The older key stays outstanding...
    expect(internals.pendingRejectedTurnRepair).toEqual({ userMessageIds: ["u-old"] });
    // ...until its own rows verify.
    expect((await internals.repairUnstampedRejectedTurn()).durable).toBe(true);
    expect(internals.pendingRejectedTurnRepair).toBeNull();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-old")?.metadata?.preStreamRejected).toBe(true);
    await session.dispose();
  });

  it("deletes only the refused turn's partial, never a later turn's", async () => {
    // The repair record survives later accepted sends by design. A partial
    // left by one of those later turns (a crash mid-stream) belongs to that
    // turn — deleting it would discard its output or pending tool state and
    // make startup replay it.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-old", "user", "refused prompt", { timestamp: 1 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-later", "user", "later prompt", { timestamp: 2 })
    );
    const writeResult = await historyService.writePartial(
      workspaceId,
      createMuxMessage("a-later", "assistant", "later partial output", {
        timestamp: 3,
        partial: true,
      })
    );
    if (!writeResult.success) throw new Error(writeResult.error);
    const internals = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      pendingRejectedTurnRepair: { userMessageIds: string[] } | null;
      repairUnstampedRejectedTurn: () => Promise<{ durable: boolean; partialSecured: boolean }>;
    };
    internals.startupAutoRetryAbandon = null;
    internals.pendingRejectedTurnRepair = { userMessageIds: ["u-old"] };

    expect((await internals.repairUnstampedRejectedTurn()).durable).toBe(true);
    expect((await historyService.readPartial(workspaceId))?.id).toBe("a-later");
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-old")?.metadata?.preStreamRejected).toBe(true);
    expect(internals.pendingRejectedTurnRepair).toBeNull();

    // A surviving partial is the refused turn's only while that turn is the newest.
    internals.pendingRejectedTurnRepair = { userMessageIds: ["u-later"] };
    expect((await internals.repairUnstampedRejectedTurn()).durable).toBe(true);
    expect(await historyService.readPartial(workspaceId)).toBeNull();
    await session.dispose();
  });

  it("attributes a background-started skill send only once its startup reaches the provider", async () => {
    // Edits answer before the late consent gate runs, so the renderer cannot
    // settle their dispatch attribution: the response reports it deferred and
    // the backend records it when startup actually streams.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-edit", "user", "old prompt", { timestamp: 1 })
    );
    const captureSpy = spyOn(
      session as unknown as { captureBackendMessageSent: (args: unknown) => Promise<void> },
      "captureBackendMessageSent"
    ).mockResolvedValue(undefined);

    const accepted = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ editMessageId: "u-edit" })
    );
    expect(accepted.success).toBe(true);
    expect(accepted.success && accepted.data?.queued).toBe(true);
    await waitFor(() => captureSpy.mock.calls.length === 1, "backend dispatch attribution");
    expect(streamed).toHaveLength(1);
    expect(captureSpy.mock.calls[0][0]).toMatchObject({ model: KNOWN_MODELS.HAIKU.id });
    await session.dispose();
  });

  it("records nothing for a background-started skill send the late gate refuses", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService, events } = await createRoutingHarness(harnessArgs);
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-edit", "user", "old prompt", { timestamp: 1 })
    );
    const captureSpy = spyOn(
      session as unknown as { captureBackendMessageSent: (args: unknown) => Promise<void> },
      "captureBackendMessageSent"
    ).mockResolvedValue(undefined);

    const accepted = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ editMessageId: "u-edit" }),
      {
        onAccepted: () => {
          harnessArgs.projectTrusted = false;
        },
      }
    );
    expect(accepted.success).toBe(true);
    // Deferred, not attributed: the renderer must not record it either.
    expect(accepted.success && accepted.data?.queued).toBe(true);
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "stream-error" && /trust was revoked/i.test(JSON.stringify(event))
        ),
      "the refusal's visible error"
    );
    expect(streamed).toHaveLength(0);
    expect(captureSpy).not.toHaveBeenCalled();
    await session.dispose();
  });

  it("threads an inherited consent gate through a replacement send's dispatch, row and retry state", async () => {
    // A compaction replacing a routed stream routes nothing itself but reads
    // that stream's project snapshot (possibly on the class model): it must
    // refuse with the inherited verdict at its provider boundary, stamp its own
    // row on refusal, and seed the consent obligation into its retry state and
    // persisted row so resumes re-verify trust too.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    let trustRevoked = true;
    const inheritedGate = () =>
      Promise.resolve(
        trustRevoked ? createUnknownSendMessageError(ROUTED_SKILL_TRUST_REVOKED_MESSAGE) : null
      );
    const internals = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      lastAutoRetryResumeRequest?: { userMessageId?: string; routedProjectConsent?: boolean };
    };
    const replacementOptions = { model: USER_MODEL, agentId: "compact" };

    // Refused pre-start: accepted without a stream, own row stamped and keyed.
    const refused = await session.sendMessage("Continue", replacementOptions, {
      synthetic: true,
      agentInitiated: true,
      inheritedConsentRejection: inheritedGate,
    });
    expect(refused.success).toBe(true);
    expect(refused.success && refused.data?.acceptedWithoutStream).toBe(true);
    expect(streamed).toHaveLength(0);
    let history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    const refusedRow = history.data.find((m) => m.role === "user");
    if (refusedRow == null) throw new Error("expected the replacement's row");
    expect(refusedRow.metadata?.preStreamRejected).toBe(true);
    expect(refusedRow.metadata?.retrySendOptions?.routedProjectConsent).toBe(true);
    expect(internals.startupAutoRetryAbandon).toEqual({
      reason: "pre_stream_rejected",
      userMessageId: refusedRow.id,
    });

    // Allowed: the gate rides to the provider boundary; the retry state
    // carries the obligation and the row to stamp.
    trustRevoked = false;
    const allowed = await session.sendMessage("Continue", replacementOptions, {
      synthetic: true,
      agentInitiated: true,
      inheritedConsentRejection: inheritedGate,
    });
    expect(allowed.success).toBe(true);
    expect(streamed).toHaveLength(1);
    const gate = streamed[0].preDispatchConsentGate;
    if (gate == null)
      throw new Error("replacement send must carry the gate to the provider boundary");
    history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    const allowedRow = history.data.find((m) => m.role === "user" && m.id !== refusedRow.id);
    if (allowedRow == null) throw new Error("expected the allowed replacement's row");
    expect(internals.lastAutoRetryResumeRequest).toMatchObject({
      routedProjectConsent: true,
      userMessageId: allowedRow.id,
    });
    trustRevoked = true;
    expect(JSON.stringify(await gate({ midStream: true }))).toMatch(/trust was revoked/i);
    await session.dispose();
  });

  it("carries the consent gate and row key into the compaction context_exceeded retry", async () => {
    // The retry recreates the stream inside AgentSession, outside
    // StreamManager's gate-preserving recreations, and a later auto-retry of
    // the retry resumes through resumeStream: both must keep verifying trust
    // and know the row to stamp on refusal.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session } = await createRoutingHarness({ workspacePath });
    const gate = () => Promise.resolve(null);
    const baseOptions = { model: "anthropic:claude-sonnet-4-5", agentId: "compact" };
    const privateSession = session as unknown as {
      maybeRetryCompactionOnContextExceeded: (data: {
        messageId: string;
        errorType?: string;
      }) => Promise<boolean>;
      lastAutoRetryResumeRequest?: { routedProjectConsent?: boolean; userMessageId?: string };
      activeCompactionRequest?: unknown;
      activeStreamContext?: unknown;
      activeStreamUserMessageId?: string;
      supports1MContextRetry: unknown;
      is1MContextEnabledForModel: unknown;
      withAnthropic1MContext: unknown;
      finalizeCompactionRetry: unknown;
      streamWithHistory: unknown;
    };
    privateSession.activeCompactionRequest = {
      id: "compaction-request-1",
      modelString: baseOptions.model,
      options: baseOptions,
      source: "auto-compaction",
    };
    privateSession.activeStreamContext = {
      modelString: baseOptions.model,
      options: baseOptions,
      agentInitiated: true,
      providersConfig: null,
      routedConsentRejection: gate,
    };
    privateSession.activeStreamUserMessageId = "u-compaction";
    privateSession.supports1MContextRetry = mock(() => true);
    privateSession.is1MContextEnabledForModel = mock(() => false);
    privateSession.withAnthropic1MContext = mock(() => ({
      ...baseOptions,
      providerOptions: { anthropic: { use1MContext: true } },
    }));
    privateSession.finalizeCompactionRetry = mock(() => Promise.resolve());
    const streamWithHistoryMock = mock((..._args: unknown[]) =>
      Promise.resolve({
        success: false as const,
        error: { type: "runtime_start_failed" as const, message: "retry startup failed" },
      })
    );
    privateSession.streamWithHistory = streamWithHistoryMock;

    await privateSession.maybeRetryCompactionOnContextExceeded({
      messageId: "assistant-retry",
      errorType: "context_exceeded",
    });
    expect(streamWithHistoryMock).toHaveBeenCalledTimes(1);
    // The gate is the trailing streamWithHistory argument (after the coordinator
    // preparation/budget/snapshot slots), so match it by position from the end.
    const retryArgs = streamWithHistoryMock.mock.calls[0];
    expect(retryArgs[retryArgs.length - 1]).toBe(gate);
    expect(privateSession.lastAutoRetryResumeRequest).toMatchObject({
      routedProjectConsent: true,
      userMessageId: "u-compaction",
    });
    await session.dispose();
  });

  it("repairs unstamped rejected rows before an edit truncates them", async () => {
    // After a restart the in-memory quarantine is empty and startup recovery
    // runs asynchronously; an edit that truncates the tail must not hand the
    // rejected prompt (and its project snapshot) to the abandoned-branch
    // summarizer or retire the repair key with the rows: the durable repair
    // stamps them first.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-first", "user", "first prompt", { timestamp: 1 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a-first", "assistant", "first answer", { timestamp: 2 })
    );
    await appendRoutedTurnRows(historyService, workspaceId);
    const internals = session as unknown as {
      pendingRejectedTurnRepair: { userMessageIds: string[] } | null;
      loadAutoRetryEnabledPreference: () => Promise<boolean>;
    };
    // The record is what startup's one-time state load found on disk; seed it
    // after that load so the edit path sees a loaded record, not a reset.
    await internals.loadAutoRetryEnabledPreference();
    internals.pendingRejectedTurnRepair = { userMessageIds: ["u-routed"] };

    const order: string[] = [];
    const realStamp = historyService.markMessagesPreStreamRejected.bind(historyService);
    const stampSpy = spyOn(historyService, "markMessagesPreStreamRejected").mockImplementation(
      (wsId: string, ids: string[]) => {
        order.push(`stamp:${[...ids].sort().join(",")}`);
        return realStamp(wsId, ids);
      }
    );
    const realTruncate = historyService.truncateAfterMessage.bind(historyService);
    const truncateSpy = spyOn(historyService, "truncateAfterMessage").mockImplementation(((
      ...args: Parameters<typeof realTruncate>
    ) => {
      order.push("truncate");
      return realTruncate(...args);
    }) as typeof historyService.truncateAfterMessage);
    try {
      const result = await session.sendMessage("edited first prompt", {
        model: USER_MODEL,
        agentId: "exec",
        editMessageId: "u-first",
      });
      expect(result.success).toBe(true);
    } finally {
      stampSpy.mockRestore();
      truncateSpy.mockRestore();
    }
    expect(order[0]).toBe("stamp:snap-routed,u-routed");
    expect(order.indexOf("truncate")).toBeGreaterThan(0);
    expect(internals.pendingRejectedTurnRepair).toBeNull();
    await session.dispose();
  });

  it("reports accepted-without-stream when startup never reached the provider", async () => {
    // streamWithHistory resolves Ok from its pre-provider abort checks without
    // delivering; the accepted-send payload (and the backend attribution that
    // keys on it) must not claim a dispatch for that.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });
    const streamSpy = spyOn(
      session as unknown as { streamWithHistory: (...args: unknown[]) => Promise<unknown> },
      "streamWithHistory"
    ).mockResolvedValue(Ok(undefined));
    try {
      const result = await session.sendMessage("Use skill done", skillSendOptions());
      expect(result.success).toBe(true);
      expect(result.success && result.data?.acceptedWithoutStream).toBe(true);
      expect(result.success && result.data?.routedModel).toBeUndefined();
    } finally {
      streamSpy.mockRestore();
    }
    expect(streamed).toHaveLength(0);
    await session.dispose();
  });

  it("builds a token-budget rollover request with the routed turn's consent gate", async () => {
    // A prepared request bakes its turn options in at preparation, not at
    // start(): the gate must be part of the rollover preparation or the class
    // provider gets the fresh window's copied project snapshot with no verdict.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session } = await createRoutingHarness({ workspacePath });
    const prepared: Array<{ preDispatchConsentGate?: unknown }> = [];
    const aiService = (session as unknown as { aiService: Record<string, unknown> }).aiService;
    aiService.prepareStreamMessage = mock((opts: { preDispatchConsentGate?: unknown }) => {
      prepared.push(opts);
      return Promise.resolve(
        Ok({
          start: () => Promise.resolve(Err("not started in this test")),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        })
      );
    });
    const gate = mock(() => Promise.resolve(null));
    const internals = session as unknown as {
      prepareRolloverRequest: (...args: unknown[]) => Promise<unknown>;
    };
    await internals.prepareRolloverRequest(
      [],
      USER_MODEL,
      { model: USER_MODEL, agentId: "exec" },
      {},
      false,
      undefined,
      undefined,
      gate
    );
    expect(prepared).toHaveLength(1);
    expect(prepared[0].preDispatchConsentGate).toBe(gate);
    await session.dispose();
  });

  it("bakes the routed turn's consent gate into the proactive on-send rollover request", async () => {
    // With token-budget windows on, an over-budget routed send rolls into a
    // fresh window BEFORE acceptance and prepares its provider request right
    // there. A prepared request bakes its turn options in at preparation, so
    // that call — not the later streamWithHistory one — must carry the gate,
    // armed by the copied project snapshot.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed } = await createRoutingHarness(harnessArgs);
    const internals = session as unknown as {
      aiService: { prepareStreamMessage: { mock: { calls: unknown[][] } } };
      prepareContextBudgetSend: (...args: unknown[]) => Promise<unknown>;
      checkFreshContextBudget: (...args: unknown[]) => Promise<unknown>;
    };
    // Force the rollover branch: a budget prefix headed by a rollover boundary.
    spyOn(internals, "prepareContextBudgetSend").mockResolvedValue(
      Ok({
        prefix: [
          createMuxMessage("rollover-boundary", "assistant", "", {
            timestamp: Date.now(),
            contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
            muxMetadata: {
              type: "context-window-rollover",
              rolloverId: "rollover-1",
              reason: "on-send",
              previousWindowId: "window-0",
            } as unknown as MuxMessageMetadata,
          }),
        ],
        requestAssemblySnapshot: {},
      })
    );
    spyOn(internals, "checkFreshContextBudget").mockResolvedValue(Ok(undefined));

    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ experiments: { tokenBudget: true } })
    );
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    const prepared = internals.aiService.prepareStreamMessage.mock.calls;
    expect(prepared).toHaveLength(1);
    const gate = (
      prepared[0][0] as {
        preDispatchConsentGate?: (context?: { midStream?: boolean }) => Promise<unknown>;
      }
    ).preDispatchConsentGate;
    if (gate == null) throw new Error("rollover preparation must carry the routed turn's gate");
    expect(await gate()).toBeNull();
    // The snapshot-backed retry state the request build refreshed must still
    // carry the accepted send's consent obligation and refused-row key: a
    // retry after a transient failure resumes through resumeStream, which
    // re-verifies trust only from these fields.
    const resumeState = (
      session as unknown as {
        lastAutoRetryResumeRequest?: {
          requestAssemblySnapshot?: unknown;
          routedProjectConsent?: boolean;
          userMessageId?: string;
        };
      }
    ).lastAutoRetryResumeRequest;
    expect(resumeState?.requestAssemblySnapshot).toBeDefined();
    expect(resumeState?.routedProjectConsent).toBe(true);
    expect(typeof resumeState?.userMessageId).toBe("string");
    harnessArgs.projectTrusted = false;
    expect(JSON.stringify(await gate({ midStream: true }))).toMatch(/trust was revoked/i);
    await session.dispose();
  });

  it("does not attribute a compaction-deferred background skill send when the compaction stream starts", async () => {
    // A background-started skill send (a startup-dispatched follow-up; edits
    // skip on-send compaction) that triggers on-send compaction is deferred
    // ({ queued: true }): what starts in the background is the compaction
    // request. dispatchPendingFollowUp attributes the skill when it actually
    // streams; capturing at compaction start would double-count it against
    // the compaction model.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });
    forceOnSendCompaction(session);
    const captureSpy = spyOn(
      session as unknown as { captureBackendMessageSent: (args: unknown) => Promise<void> },
      "captureBackendMessageSent"
    ).mockResolvedValue(undefined);

    const accepted = await session.sendMessage("Use skill done", skillSendOptions(), {
      startStreamInBackground: true,
    });
    expect(accepted.success).toBe(true);
    expect(accepted.success && accepted.data?.queued).toBe(true);
    await waitFor(() => streamed.length === 1, "the compaction stream's start");
    // What streamed is the compaction request, not the skill.
    expect(
      streamed[0].messages.some((row) => row.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captureSpy).not.toHaveBeenCalled();
    await session.dispose();
  });

  it("inherits the routed stream's consent gate on the continuous-compaction fallback send", async () => {
    // The stream stopped for a continuous fold that could not fast-apply: the
    // recovery send (a compaction or a plain continuation) streams the routed
    // stream's project content again, so it keeps verifying that stream's
    // consent — and the folded continuation persists the obligation for the
    // dispatches that no longer hold the gate.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session } = await createRoutingHarness({ workspacePath });
    const gate = () => Promise.resolve(null);
    const context = {
      modelString: KNOWN_MODELS.HAIKU.id,
      options: { model: KNOWN_MODELS.HAIKU.id, agentId: "exec" },
      agentInitiated: false,
      providersConfig: null,
      routedConsentRejection: gate,
    };
    const internals = session as unknown as {
      coordinator: {
        beginCompactionObservation: (kind: string) => symbol | undefined;
        setCompactionStage: (token: symbol, stage: string) => void;
        finishCompactionObservation: (token: symbol) => boolean;
      };
      finishContinuousCompaction: (
        applied: boolean,
        context: unknown,
        token: symbol
      ) => Promise<void>;
      buildContinuousCompactionFollowUp: (context: unknown) => { routedProjectConsent?: boolean };
    };
    expect(internals.buildContinuousCompactionFollowUp(context).routedProjectConsent).toBe(true);
    expect(
      internals.buildContinuousCompactionFollowUp({ ...context, routedConsentRejection: undefined })
        .routedProjectConsent
    ).toBeUndefined();

    const sendSpy = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
    const token = internals.coordinator.beginCompactionObservation("continuous");
    if (token == null) throw new Error("expected a compaction observation token");
    internals.coordinator.setCompactionStage(token, "stopping");
    internals.coordinator.setCompactionStage(token, "stopped");
    await internals.finishContinuousCompaction(false, context, token);
    internals.coordinator.finishCompactionObservation(token);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const internal = sendSpy.mock.calls[0][2] as { inheritedConsentRejection?: unknown };
    expect(internal.inheritedConsentRejection).toBe(gate);
    await session.dispose();
  });

  it("re-verifies Project Trust when dispatching a persisted routed follow-up", async () => {
    // A routed stream's continuation can outlive its gate on the summary row
    // (legacy mid-stream compaction, a fast-apply whose dispatch never ran
    // before a restart): the dispatch reconstructs the gate from durable trust
    // and seeds the obligation into retry state. Least privilege: only a
    // request that actually carries project content needs consent.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = { workspacePath };
    const { session, historyService } = await createRoutingHarness(harnessArgs);
    const workspaceId = "ws-skill-routing";
    const appended = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary-routed", "assistant", "Summary of the routed work", {
        timestamp: Date.now(),
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue",
            model: KNOWN_MODELS.HAIKU.id,
            agentId: "exec",
            routedProjectConsent: true,
          },
        },
      })
    );
    expect(appended.success).toBe(true);
    const sendSpy = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));

    expect(await session.dispatchPendingCompactionFollowUpIfNeeded("summary-routed")).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const internal = sendSpy.mock.calls[0][2] as {
      inheritedConsentRejection?: (carries?: boolean, midStream?: boolean) => Promise<unknown>;
    };
    const gate = internal.inheritedConsentRejection;
    if (gate == null) throw new Error("a routed follow-up must dispatch with a consent gate");
    expect(await gate(true)).toBeNull();
    harnessArgs.projectTrusted = false;
    expect(await gate(false)).toBeNull();
    expect(JSON.stringify(await gate(true, true))).toMatch(/trust was revoked/i);
    const resumeState = (
      session as unknown as { lastAutoRetryResumeRequest?: { routedProjectConsent?: boolean } }
    ).lastAutoRetryResumeRequest;
    expect(resumeState).toMatchObject({ routedProjectConsent: true });
    await session.dispose();
  });

  /** An earlier turn's assistant row holding a project skill the model read with agent_skill_read. */
  function projectSkillReadRow(id: string, body: string) {
    return createMuxMessage(id, "assistant", "", { timestamp: Date.now() }, [
      {
        type: "dynamic-tool",
        toolName: "agent_skill_read",
        toolCallId: `${id}-call`,
        state: "output-available",
        input: { name: "repo-conventions" },
        output: {
          success: true,
          skill: {
            scope: "project",
            directoryName: "repo-conventions",
            frontmatter: { name: "repo-conventions", description: "Repository conventions" },
            body,
          },
        },
      },
    ]);
  }

  async function seedProjectSkillReadTurn(historyService: HistoryService): Promise<void> {
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-earlier", "user", "Read the repo conventions", { timestamp: Date.now() })
    );
    await historyService.appendToHistory(
      workspaceId,
      projectSkillReadRow("a-skill-read", "PROJECT SKILL BODY FROM TOOL")
    );
  }

  it("redacts project skills read through agent_skill_read from a routed request in an untrusted project", async () => {
    // A project skill the model loaded with the tool in an earlier turn lives
    // inside an assistant tool-result row, not in metadata.agentSkillSnapshot:
    // the routed request's consent scan must cover that channel too, and the
    // redaction must keep the call/result pairing the provider requires.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed } = await sendRoutedGlobalSkillWithPendingState(
      {
        workspacePath,
        projectTrusted: false,
        configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
      },
      { seedHistory: seedProjectSkillReadTurn, loadedSkills: [] }
    );

    const request = JSON.stringify(streamed[0].messages);
    expect(request).not.toContain("PROJECT SKILL BODY FROM TOOL");
    expect(request).toContain(PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE);
    expect(
      streamed[0].messages.some((row) =>
        row.parts.some(
          (part) => part.type === "dynamic-tool" && part.toolCallId === "a-skill-read-call"
        )
      )
    ).toBe(true);
    // Nothing project-scoped was kept, so the gate has nothing to guard.
    expect(await streamed[0].preDispatchConsentGate?.()).toBeNull();
    await session.dispose();
  });

  it("arms the provider-boundary gate on a project skill read through agent_skill_read under trust", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
    };
    const { session, streamed } = await sendRoutedGlobalSkillWithPendingState(harnessArgs, {
      seedHistory: seedProjectSkillReadTurn,
      loadedSkills: [],
    });

    // Trusted: the tool result rides along unredacted...
    expect(JSON.stringify(streamed[0].messages)).toContain("PROJECT SKILL BODY FROM TOOL");
    // ...and a revocation between request assembly and the provider call must
    // still reject, with no snapshot row or attachment in the request.
    harnessArgs.projectTrusted = false;
    expect(JSON.stringify(await streamed[0].preDispatchConsentGate?.())).toMatch(
      /trust was revoked/i
    );
    await session.dispose();
  });

  it("refuses to build a request while a refused turn's partial is not secured", async () => {
    // The repair reports an unsecured partial when the refused turn's surviving
    // in-flight assistant could not be deleted (or history could not be read to
    // tell whose partial it is): committing it would promote it into an
    // unmarked history row a later repair no longer finds. The request must not
    // be built at all — unlike outstanding row stamps, which the in-memory
    // quarantine covers (see the acceptance-time restamp test above).
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService, events } = await createRoutingHarness({
      workspacePath,
    });
    const internals = session as unknown as {
      repairUnstampedRejectedTurn: () => Promise<{ durable: boolean; partialSecured: boolean }>;
    };
    spyOn(internals, "repairUnstampedRejectedTurn").mockResolvedValue({
      durable: false,
      partialSecured: false,
    });
    const commit = spyOn(historyService, "commitPartial");

    const result = await session.sendMessage("Hello", { model: USER_MODEL, agentId: "exec" });
    expect(streamed).toHaveLength(0);
    expect(commit).not.toHaveBeenCalled();
    const surfaced = result.success ? JSON.stringify(events) : JSON.stringify(result.error);
    expect(surfaced).toContain("could not be secured");
    await session.dispose();
  });

  it("keeps refusing sends until a refused turn's record reaches disk", async () => {
    // Both durable records fail: the row stamp (twice) and the preference-file
    // write. The refusal still completes — the rows are quarantined in memory —
    // but until a record lands, a crash would leave them provider-eligible, so
    // the visible error says so and no request may leave.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService, events } = await createRoutingHarness(harnessArgs);
    const internals = session as unknown as {
      persistAutoRetryState: () => Promise<void>;
      autoRetryStateUnrecorded: boolean;
      unstampedRejectedRowIds: Set<string>;
    };
    const stampSpy = spyOn(historyService, "markMessagesPreStreamRejected").mockResolvedValue(
      Err("disk full")
    );
    const persistSpy = spyOn(internals, "persistAutoRetryState").mockImplementation(() => {
      internals.autoRetryStateUnrecorded = true;
      return Promise.resolve();
    });
    try {
      // Revoke trust once the turn is accepted (rows durable) so the LATE gate
      // refuses and has rows to stamp; a pre-acceptance refusal rolls back.
      const refused = await session.sendMessage("Use skill done", skillSendOptions(), {
        onAccepted: () => {
          harnessArgs.projectTrusted = false;
        },
      });
      expect(refused.success).toBe(true);
      expect(refused.success && refused.data?.acceptedWithoutStream).toBe(true);
      expect(streamed).toHaveLength(0);
      expect(internals.unstampedRejectedRowIds.size).toBeGreaterThan(0);
      expect(
        events.some(
          (event) =>
            event.type === "stream-error" &&
            /could not be recorded on disk/i.test(JSON.stringify(event))
        )
      ).toBe(true);

      // Only process memory protects the refused rows: the next request is refused.
      const blocked = await session.sendMessage("plain follow-up", {
        model: USER_MODEL,
        agentId: "exec",
      });
      const surfaced = blocked.success ? JSON.stringify(events) : JSON.stringify(blocked.error);
      expect(surfaced).toContain("could not be secured");
      expect(streamed).toHaveLength(0);
    } finally {
      stampSpy.mockRestore();
      persistSpy.mockRestore();
    }

    // The disk recovered: the repair stamps the rows for real and sends resume.
    const resumed = await session.sendMessage("plain follow-up", {
      model: USER_MODEL,
      agentId: "exec",
    });
    expect(resumed.success).toBe(true);
    expect(streamed).toHaveLength(1);
    await session.dispose();
  });

  it("excludes the whole turn of an outstanding repair key even when its rows never reached the quarantine", async () => {
    // A repair pass that could not read history leaves the key on record but
    // cannot quarantine the rows in memory; request assembly and the
    // abandoned-branch summarizer must still drop that turn — prompt and
    // snapshot prefix — by the key alone.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session } = await createRoutingHarness({ workspacePath });
    const internals = session as unknown as {
      pendingRejectedTurnRepair: { userMessageIds: string[] } | null;
      loadAutoRetryEnabledPreference: () => Promise<boolean>;
      excludeRejectedRows: (rows: MuxMessage[]) => MuxMessage[];
    };
    await internals.loadAutoRetryEnabledPreference();
    internals.pendingRejectedTurnRepair = { userMessageIds: ["u-routed"] };
    const rows = [
      createMuxMessage("u-first", "user", "first prompt", { timestamp: 1 }),
      createMuxMessage("snap-routed", "user", "project skill body", {
        timestamp: 2,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "x" },
      }),
      createMuxMessage("u-routed", "user", "refused prompt", { timestamp: 3 }),
      createMuxMessage("u-later", "user", "later prompt", { timestamp: 4 }),
    ];
    expect(internals.excludeRejectedRows(rows).map((row) => row.id)).toEqual([
      "u-first",
      "u-later",
    ]);
    await session.dispose();
  });

  it("arms the per-step gate when a project skill is read through the tool mid-stream", async () => {
    // A routed global skill starts with no project content, so the gate is
    // bound unarmed at assembly. Its first step then reads a project skill
    // through agent_skill_read while trusted: the next step's messages carry
    // that body, so a revocation after the tool ran must stop the next
    // provider call — the gate re-scans the step's messages.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
    };
    const { session, streamed } = await sendRoutedGlobalSkillWithPendingState(harnessArgs, {
      loadedSkills: [],
    });
    const gate = streamed[0].preDispatchConsentGate;
    if (gate == null) throw new Error("a routed send must carry the gate");
    harnessArgs.projectTrusted = false;
    // Nothing project-scoped in the request itself: still allowed.
    expect(await gate({ midStream: true })).toBeNull();
    const stepMessages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "agent_skill_read",
            output: {
              type: "json",
              value: {
                success: true,
                skill: {
                  scope: "project",
                  directoryName: "repo-conventions",
                  frontmatter: { name: "repo-conventions", description: "Repository conventions" },
                  body: "PROJECT SKILL BODY FROM TOOL",
                },
              },
            },
          },
        ],
      },
    ];
    expect(JSON.stringify(await gate({ midStream: true, stepMessages }))).toMatch(
      /trust was revoked/i
    );
    await session.dispose();
  });

  it("arms a manual resume from the persisted row's routed consent", async () => {
    // The renderer's Retry resumes through the public path with no internal
    // consent arguments; the replayed row's persisted retry options (seeded at
    // acceptance) must arm the same checks startup recovery applies.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({ workspacePath });
    await historyService.appendToHistory(
      "ws-skill-routing",
      createMuxMessage("u-routed", "user", "Use skill done", {
        timestamp: 1,
        retrySendOptions: { model: USER_MODEL, agentId: "exec", routedProjectConsent: true },
      })
    );

    const resumed = await session.resumeStream({ model: USER_MODEL, agentId: "exec" });
    expect(resumed.success).toBe(true);
    expect(streamed).toHaveLength(1);
    // The gate rides to the provider boundary and the retry state carries the
    // obligation plus the row to stamp.
    expect(streamed[0].preDispatchConsentGate).toBeDefined();
    const resumeState = (
      session as unknown as {
        lastAutoRetryResumeRequest?: { routedProjectConsent?: boolean; userMessageId?: string };
      }
    ).lastAutoRetryResumeRequest;
    expect(resumeState).toMatchObject({ routedProjectConsent: true, userMessageId: "u-routed" });
    await session.dispose();
  });

  it("persists the consent obligation widened by an inline project reference", async () => {
    // The user row's retry options seed routedProjectConsent from the invoked
    // package's scope; an inline $project-skill reference is only discovered
    // by materialization, later. Startup recovery and manual Retry read the
    // obligation from the persisted row, so the widened value must reach it —
    // the in-memory resume state alone dies with the process.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
    };
    const relabelInvokedPackageAsGlobal = (session: object) => {
      const withResolve = session as unknown as {
        resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
      };
      const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
      spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
        async (...resolveArgs: unknown[]) => {
          const resolved = await originalResolve(...resolveArgs);
          // The invoked package itself is global, so the seed is false.
          const override = resolved as {
            kind?: string;
            resolvedPackage?: { package: { scope: string } };
          };
          if (override.kind === "override" && override.resolvedPackage != null) {
            override.resolvedPackage.package.scope = "global";
          }
          return resolved;
        }
      );
    };
    const persistedConsent = async (
      historyService: Awaited<ReturnType<typeof createRoutingHarness>>["historyService"]
    ) => {
      const history = await historyService.getHistoryFromLatestBoundary("ws-skill-routing");
      if (!history.success) throw new Error(history.error);
      const row = history.data.find(
        (message) => message.role === "user" && message.metadata?.synthetic !== true
      );
      return row?.metadata?.retrySendOptions?.routedProjectConsent;
    };

    // Control: a routed global invocation with no project content seeds no obligation.
    {
      const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
      relabelInvokedPackageAsGlobal(session);
      expect((await session.sendMessage("Use skill done", skillSendOptions())).success).toBe(true);
      expect(streamed).toHaveLength(1);
      expect(await persistedConsent(historyService)).toBeUndefined();
      await session.dispose();
    }

    // Materialization discovers an inline project reference: the persisted row
    // and the live resume state both carry the widened obligation.
    {
      const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
      relabelInvokedPackageAsGlobal(session);
      const withMaterialize = session as unknown as {
        materializeAgentSkillSnapshots: (
          ...args: unknown[]
        ) => Promise<{ messages: unknown[]; carriesProjectSkillContent: boolean }>;
      };
      const originalMaterialize = withMaterialize.materializeAgentSkillSnapshots.bind(session);
      spyOn(withMaterialize, "materializeAgentSkillSnapshots").mockImplementation(
        async (...args: unknown[]) => ({
          ...(await originalMaterialize(...args)),
          carriesProjectSkillContent: true,
        })
      );
      expect((await session.sendMessage("Use skill done", skillSendOptions())).success).toBe(true);
      expect(streamed).toHaveLength(1);
      expect(await persistedConsent(historyService)).toBe(true);
      const resumeState = (
        session as unknown as { lastAutoRetryResumeRequest?: { routedProjectConsent?: boolean } }
      ).lastAutoRetryResumeRequest;
      expect(resumeState?.routedProjectConsent).toBe(true);
      await session.dispose();
    }
  });

  it("refuses a manual resume while the tail's consent record cannot be read", async () => {
    // FAIL CLOSED: an unreadable tail is not "no consent obligation". The
    // replayed row may be a routed project-skill turn whose trust has since
    // been revoked; resuming it unrouted would dispatch the project content
    // without the gate.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({ workspacePath });
    await historyService.appendToHistory(
      "ws-skill-routing",
      createMuxMessage("u-routed", "user", "Use skill done", {
        timestamp: 1,
        retrySendOptions: { model: USER_MODEL, agentId: "exec", routedProjectConsent: true },
      })
    );

    const readSpy = spyOn(historyService, "getHistoryFromLatestBoundary").mockResolvedValue(
      Err("disk error")
    );
    try {
      const resumed = await session.resumeStream({ model: USER_MODEL, agentId: "exec" });
      expect(resumed.success).toBe(false);
      expect(JSON.stringify(resumed)).toMatch(/could not be read/);
    } finally {
      readSpy.mockRestore();
    }
    expect(streamed).toHaveLength(0);
    await session.dispose();
  });

  it("refuses sends while the durable repair record is malformed instead of reading it as empty", async () => {
    // The record names the refused turns whose row stamp failed, and nothing
    // else knows them: a record that cannot be parsed is an UNKNOWN
    // quarantine, so no request leaves, and the malformed value is written
    // back verbatim so side channels keep failing closed after a restart.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const probe = await createRoutingHarness({ workspacePath });
    const internals = (session: object) =>
      session as unknown as {
        getAutoRetryPreferencePath(): string;
        persistAutoRetryState(): Promise<void>;
      };
    const preferencePath = internals(probe.session).getAutoRetryPreferencePath();
    await probe.session.dispose();
    const malformedRecord = { userMessageIds: 42 };
    try {
      await fs.mkdir(path.dirname(preferencePath), { recursive: true });
      await fs.writeFile(
        preferencePath,
        JSON.stringify({ pendingRejectedTurnRepair: malformedRecord }) + "\n"
      );
      const { session, streamed } = await createRoutingHarness({ workspacePath });
      const refused = await session.sendMessage("next prompt", {
        model: USER_MODEL,
        agentId: "exec",
      });
      expect(refused.success).toBe(false);
      expect(JSON.stringify(refused)).toMatch(/record of refused turns/);
      expect(streamed).toHaveLength(0);

      // A state write preserves the malformed record rather than healing it
      // into "no keys".
      await internals(session).persistAutoRetryState();
      expect(JSON.parse(await fs.readFile(preferencePath, "utf-8"))).toEqual({
        pendingRejectedTurnRepair: malformedRecord,
      });
      await session.dispose();

      // A torn document (the file exists but is not JSON) is the same unknown.
      await fs.writeFile(preferencePath, "{ not json");
      const torn = await createRoutingHarness({ workspacePath });
      const refusedAgain = await torn.session.sendMessage("next prompt", {
        model: USER_MODEL,
        agentId: "exec",
      });
      expect(refusedAgain.success).toBe(false);
      expect(JSON.stringify(refusedAgain)).toMatch(/record of refused turns/);
      expect(torn.streamed).toHaveLength(0);
      await internals(torn.session).persistAutoRetryState();
      expect(await fs.readFile(preferencePath, "utf-8")).toBe("{ not json");
      await torn.session.dispose();
    } finally {
      await fs.rm(preferencePath, { force: true });
    }
  });

  it("refuses a manual resume of a routed row once trust is revoked and stamps it", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = { workspacePath };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-routed", "user", "Use skill done", {
        timestamp: 1,
        retrySendOptions: { model: USER_MODEL, agentId: "exec", routedProjectConsent: true },
      })
    );
    harnessArgs.projectTrusted = false;

    const refused = await session.resumeStream({ model: USER_MODEL, agentId: "exec" });
    expect(refused.success).toBe(false);
    if (!refused.success) expect(JSON.stringify(refused.error)).toMatch(/trust was revoked/i);
    expect(streamed).toHaveLength(0);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((row) => row.id === "u-routed")?.metadata?.preStreamRejected).toBe(
      true
    );
    await session.dispose();
  });

  it("repairs a refused turn before a heartbeat reset seals it behind a boundary", async () => {
    // A restart can run the heartbeat reset before startup recovery repaired a
    // refused turn whose stamp failed. The rows must be stamped BEFORE the
    // boundary lands (the repair cannot reach them afterwards), and the pending
    // state carried over for the heartbeat follow-up must not cache the turn's
    // project snapshot.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await appendRoutedTurnRows(historyService, workspaceId);
    const internals = session as unknown as {
      pendingRejectedTurnRepair: { userMessageIds: string[] } | null;
      loadAutoRetryEnabledPreference: () => Promise<boolean>;
      compactionHandler: {
        peekPendingState: () => Promise<{ loadedSkills: Array<{ name: string }> } | null>;
      };
    };
    await internals.loadAutoRetryEnabledPreference();
    internals.pendingRejectedTurnRepair = { userMessageIds: ["u-routed"] };

    const result = await session.appendHeartbeatContextResetBoundary({
      boundaryText: "Heartbeat context reset",
      pendingFollowUp: { text: "Continue", model: USER_MODEL, agentId: "exec" },
    });
    expect(result.success).toBe(true);
    // Stamped before the boundary sealed them (the repair record retired)...
    const rows: MuxMessage[] = [];
    const read = await historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
      rows.push(...chunk);
    });
    expect(read.success).toBe(true);
    for (const id of ["snap-routed", "u-routed"]) {
      expect(rows.find((row) => row.id === id)?.metadata?.preStreamRejected).toBe(true);
    }
    expect(internals.pendingRejectedTurnRepair).toBeNull();
    // ...and nothing project-scoped rode into the carried-over pending state.
    const pending = await internals.compactionHandler.peekPendingState();
    expect(pending?.loadedSkills.some((skill) => skill.name === "done") ?? false).toBe(false);
    await session.dispose();
  });

  it("attributes a background-started skill follow-up once, on its delivery", async () => {
    // Startup recovery dispatches pending follow-ups in the background: the
    // send answers { queued: true } and its background completion attributes
    // the skill when delivery succeeds. The dispatch path must not record a
    // second event on that deferred answer.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed, historyService } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });
    await historyService.appendToHistory(
      "ws-skill-routing",
      createMuxMessage("summary-skill", "assistant", "Summary of the work", {
        timestamp: Date.now(),
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Use skill done",
            model: USER_MODEL,
            agentId: "exec",
            muxMetadata: {
              type: "agent-skill",
              rawCommand: "/done",
              skillName: "done",
              scope: "project",
            },
          },
        },
      })
    );
    const captureSpy = spyOn(
      session as unknown as { captureBackendMessageSent: (args: unknown) => Promise<void> },
      "captureBackendMessageSent"
    ).mockResolvedValue(undefined);

    expect(await session.dispatchPendingCompactionFollowUpIfNeeded("summary-skill", true)).toBe(
      true
    );
    await waitFor(() => streamed.length === 1, "the follow-up's stream");
    await waitFor(() => captureSpy.mock.calls.length >= 1, "the delivery attribution");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captureSpy).toHaveBeenCalledTimes(1);
    await session.dispose();
  });
});
