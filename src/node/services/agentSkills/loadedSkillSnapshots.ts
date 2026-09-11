import { createHash } from "crypto";
import YAML from "yaml";

import assert from "@/common/utils/assert";
import { MAX_POST_COMPACTION_LOADED_SKILLS } from "@/common/constants/attachments";
import type { LoadedSkillSnapshot } from "@/common/types/attachment";
import type { AgentSkillFrontmatter, AgentSkillScope } from "@/common/types/agentSkill";
import type { ModelMessage, MuxMessage } from "@/common/types/message";
import { AgentSkillPackageSchema, AgentSkillScopeSchema } from "@/common/orpc/schemas/agentSkill";
import {
  extractAgentSkillBodyFromSnapshotText,
  isNormalizedAgentSkillBodyTruncated,
  normalizeAgentSkillSnapshotBody,
  renderAgentSkillSnapshotText,
} from "@/common/utils/agentSkills/skillSnapshot";

export interface PersistedLoadedSkillSnapshotInput {
  name?: unknown;
  scope?: unknown;
  body?: unknown;
  frontmatterYaml?: unknown;
  truncated?: unknown;
}

interface CreateLoadedSkillSnapshotArgs {
  name: string;
  scope: unknown;
  body: string;
  frontmatterYaml?: string;
  alreadyNormalized?: boolean;
  truncated?: boolean;
}

function normalizeFrontmatterYaml(frontmatterYaml: string | undefined): string | undefined {
  if (typeof frontmatterYaml !== "string") {
    return undefined;
  }

  const trimmed = frontmatterYaml.trimEnd();
  return trimmed.length > 0 ? trimmed : undefined;
}

function computeLoadedSkillSnapshotSha256(args: {
  name: string;
  scope: AgentSkillScope;
  body: string;
  frontmatterYaml?: string;
}): string {
  const snapshotText = renderAgentSkillSnapshotText({
    name: args.name,
    scope: args.scope,
    body: args.body,
  });

  return createHash("sha256")
    .update(
      JSON.stringify({
        snapshotText,
        ...(args.frontmatterYaml !== undefined ? { frontmatterYaml: args.frontmatterYaml } : {}),
      })
    )
    .digest("hex");
}

export function createLoadedSkillSnapshot(
  args: CreateLoadedSkillSnapshotArgs
): LoadedSkillSnapshot {
  assert(typeof args.name === "string" && args.name.trim().length > 0, "skill name is required");
  assert(typeof args.body === "string", "skill body must be a string");

  const parsedScope = AgentSkillScopeSchema.safeParse(args.scope);
  assert(parsedScope.success, "loaded skill snapshot scope must be valid");

  const normalizedFrontmatterYaml = normalizeFrontmatterYaml(args.frontmatterYaml);
  const normalizedBody = normalizeAgentSkillSnapshotBody(args.body, {
    alreadyNormalized: args.alreadyNormalized,
    truncated: args.truncated,
  });

  const snapshot: LoadedSkillSnapshot = {
    name: args.name.trim(),
    scope: parsedScope.data,
    sha256: computeLoadedSkillSnapshotSha256({
      name: args.name.trim(),
      scope: parsedScope.data,
      body: normalizedBody.body,
      frontmatterYaml: normalizedFrontmatterYaml,
    }),
    body: normalizedBody.body,
    ...(normalizedFrontmatterYaml !== undefined
      ? { frontmatterYaml: normalizedFrontmatterYaml }
      : {}),
    ...(normalizedBody.truncated ? { truncated: true } : {}),
  };

  assert(snapshot.sha256.length > 0, "loaded skill snapshot must include a sha256");
  return snapshot;
}

export function stringifyAgentSkillFrontmatter(frontmatter: AgentSkillFrontmatter): string {
  const yaml = YAML.stringify(frontmatter).trimEnd();
  assert(yaml.length > 0, "agent skill frontmatter yaml must not be empty");
  return yaml;
}

function getMessageTextContent(message: MuxMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<MuxMessage["parts"][number], { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function extractLoadedSkillSnapshotFromToolOutput(output: unknown): LoadedSkillSnapshot | null {
  if (typeof output !== "object" || output == null || Array.isArray(output)) {
    return null;
  }

  const toolResult = output as { success?: unknown; skill?: unknown };
  if (toolResult.success !== true) {
    return null;
  }

  const parsedSkill = AgentSkillPackageSchema.safeParse(toolResult.skill);
  if (!parsedSkill.success) {
    return null;
  }

  const skill = parsedSkill.data;
  return createLoadedSkillSnapshot({
    name: skill.frontmatter.name,
    scope: skill.scope,
    body: skill.body,
    frontmatterYaml: stringifyAgentSkillFrontmatter(skill.frontmatter),
  });
}

function extractLoadedSkillSnapshotFromSyntheticMessage(
  message: MuxMessage
): LoadedSkillSnapshot | null {
  const snapshotMeta = message.metadata?.agentSkillSnapshot;
  if (!snapshotMeta) {
    return null;
  }

  const snapshotText = getMessageTextContent(message);
  if (snapshotText.length === 0) {
    return null;
  }

  const body = extractAgentSkillBodyFromSnapshotText(snapshotText, {
    name: snapshotMeta.skillName,
    scope: snapshotMeta.scope,
  });
  if (body == null) {
    return null;
  }

  return createLoadedSkillSnapshot({
    name: snapshotMeta.skillName,
    scope: snapshotMeta.scope,
    body,
    frontmatterYaml: snapshotMeta.frontmatterYaml,
    alreadyNormalized: true,
    truncated: isNormalizedAgentSkillBodyTruncated(body),
  });
}

/**
 * Nested agent_skill_read calls inside a code_execution part (exclusive PTC):
 * skill reads happen as nested xum.agent_skill_read calls, so the outer part
 * is named "code_execution" and the results live in its output's toolCalls
 * records. Classic PTC records retain the full result (snapshot recoverable);
 * kernel-compacted records drop result contents, so nothing survives there —
 * extractLoadedSkillSnapshotFromToolOutput rejects those records naturally.
 */
function extractLoadedSkillSnapshotsFromCodeExecutionOutput(
  output: unknown
): LoadedSkillSnapshot[] {
  if (typeof output !== "object" || output === null) return [];
  const toolCalls = (output as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) return [];

  const snapshots: LoadedSkillSnapshot[] = [];
  for (const record of toolCalls as Array<Record<string, unknown>>) {
    if (typeof record !== "object" || record === null) continue;
    if (record.toolName !== "agent_skill_read" || record.error !== undefined) continue;
    // Nested history is untrusted: an explicit ok:false marks the call failed
    // even when a schema-valid result rides alongside (r18). Other nested
    // extractors treat ok:false as authoritative failure — do the same here so
    // contradictory rows cannot inject a skill snapshot into later requests.
    if (record.ok === false) continue;
    const snapshot = extractLoadedSkillSnapshotFromToolOutput(record.result);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function extractLoadedSkillSnapshotsFromMessage(message: MuxMessage): LoadedSkillSnapshot[] {
  const snapshots: LoadedSkillSnapshot[] = [];

  for (const part of message.parts) {
    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      continue;
    }

    if (part.toolName === "code_execution") {
      snapshots.push(...extractLoadedSkillSnapshotsFromCodeExecutionOutput(part.output));
      continue;
    }

    if (part.toolName !== "agent_skill_read") {
      continue;
    }

    const snapshot = extractLoadedSkillSnapshotFromToolOutput(part.output);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  if (snapshots.length > 0) {
    return snapshots;
  }

  const syntheticSnapshot = extractLoadedSkillSnapshotFromSyntheticMessage(message);
  return syntheticSnapshot ? [syntheticSnapshot] : [];
}

export function mergeLoadedSkillSnapshots(snapshots: LoadedSkillSnapshot[]): LoadedSkillSnapshot[] {
  const byScopeAndName = new Map<string, LoadedSkillSnapshot>();

  for (const snapshot of snapshots) {
    const key = `${snapshot.scope}:${snapshot.name}`;
    if (byScopeAndName.has(key)) {
      byScopeAndName.delete(key);
    }
    byScopeAndName.set(key, snapshot);
  }

  const deduped = [...byScopeAndName.values()];
  if (deduped.length <= MAX_POST_COMPACTION_LOADED_SKILLS) {
    return deduped;
  }

  return deduped.slice(-MAX_POST_COMPACTION_LOADED_SKILLS);
}

/**
 * Whether a history row carries repository-controlled PROJECT skill content by
 * any channel: a synthetic skill snapshot row, an `agent_skill_read` result or
 * an `agent_skill_read_file` result (direct, or nested inside a code_execution
 * part) whose skill is project-scoped. The routed-request consent scan must
 * see them all — a project skill (or one of its referenced files) the model
 * read through a tool in an earlier turn persists inside an assistant
 * tool-result row, not in `metadata.agentSkillSnapshot`.
 */
export function rowCarriesProjectSkillContent(message: MuxMessage): boolean {
  if (message.metadata?.agentSkillSnapshot?.scope === "project") {
    return true;
  }
  // A compaction summary stamped with the provenance of the rows it replaced:
  // its text may quote a project skill the summarized turns loaded.
  if (message.metadata?.carriesProjectSkillContent === true) {
    return true;
  }
  return message.parts.some((part) => {
    if (part.type !== "dynamic-tool" || part.state !== "output-available") return false;
    return toolOutputCarriesProjectSkillContent(part.toolName, part.output);
  });
}

/** The tools whose results can carry a project skill's body or referenced files. */
const SKILL_CONTENT_TOOLS = new Set(["agent_skill_read", "agent_skill_read_file"]);

/**
 * Whether one tool's output (direct part output, nested code_execution record
 * result, or a step message's tool-result value) carries project skill content.
 * code_execution outputs are inspected record by record.
 */
function toolOutputCarriesProjectSkillContent(toolName: unknown, output: unknown): boolean {
  if (toolName === "agent_skill_read") return outputRetainsProjectSkill(output);
  if (toolName === "agent_skill_read_file") return outputIsProjectSkillFile(output);
  if (toolName === "code_execution") {
    return nestedSkillContentRecords(output).some((record) =>
      toolOutputCarriesProjectSkillContent(record.toolName, record.result)
    );
  }
  return false;
}

/**
 * Replaces the text of a compaction summary that summarized project skill
 * content, in a REQUEST copy for an untrusted workspace (history is untouched).
 */
export const COMPACTION_SUMMARY_WITHHELD_MESSAGE =
  "[Compaction summary withheld: it summarized project skill content and this " +
  "workspace's project is not trusted.]";

/** Replaces a withheld project skill's tool output in a REQUEST copy (history is untouched). */
export const PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE =
  "Project skill content withheld: Project Trust is not granted for this workspace.";

/**
 * Confidentiality check for a persisted agent_skill_read result, deliberately
 * looser than the snapshot extractor: any retained result whose skill is
 * project-scoped counts, whether or not the call is recorded as successful (a
 * contradictory nested `ok: false` record still carries the body the extractor
 * discards) and whether or not the package validates fully. The scan is about
 * what would leave for the provider, not about what is usable.
 */
function outputRetainsProjectSkill(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  const skill = (output as { skill?: unknown }).skill;
  if (typeof skill !== "object" || skill === null) return false;
  return (skill as { scope?: unknown }).scope === "project";
}

/**
 * A persisted agent_skill_read_file success result: the referenced file of a
 * skill, tagged with the skill's scope (`skillScope`). Results written before
 * the tag existed carry no provenance and count as project content — fail
 * closed rather than let a repository file through unlabeled.
 */
function outputIsProjectSkillFile(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  const result = output as { success?: unknown; skillScope?: unknown };
  if (result.success !== true) return false;
  return result.skillScope === "project" || result.skillScope === undefined;
}

/** Every nested skill-content record of a code_execution output, regardless of its status. */
function nestedSkillContentRecords(
  output: unknown
): Array<{ toolName?: unknown; result?: unknown }> {
  if (typeof output !== "object" || output === null) return [];
  const toolCalls = (output as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.filter(
    (record): record is { toolName?: unknown; result?: unknown } =>
      typeof record === "object" &&
      record !== null &&
      typeof (record as { toolName?: unknown }).toolName === "string" &&
      SKILL_CONTENT_TOOLS.has((record as { toolName: string }).toolName)
  );
}

function redactCodeExecutionOutput(output: unknown): { output: unknown; changed: boolean } {
  if (typeof output !== "object" || output === null) return { output, changed: false };
  const toolCalls = (output as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) return { output, changed: false };
  let changed = false;
  const redactedCalls = toolCalls.map((record: unknown) => {
    if (typeof record !== "object" || record === null) return record;
    const call = record as { toolName?: unknown; result?: unknown };
    if (!toolOutputCarriesProjectSkillContent(call.toolName, call.result)) {
      return record;
    }
    changed = true;
    return { ...call, result: { success: false, error: PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE } };
  });
  return changed
    ? { output: { ...output, toolCalls: redactedCalls }, changed }
    : { output, changed };
}

/**
 * Request-copy redaction for an UNTRUSTED workspace's routed request: every
 * project-scope `agent_skill_read` result (direct or nested in code_execution)
 * is replaced with a withheld marker in the tool's failure shape, so the
 * tool-call/result pairing the provider requires stays intact while the
 * repository-controlled body never leaves for the class provider. Mirrors the
 * synthetic-snapshot omission; rows are copied, never mutated.
 */
export function redactProjectSkillToolResults(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((message) => {
    // A provenance-stamped compaction summary (see
    // MuxMessageMetadata.carriesProjectSkillContent) is plain assistant text
    // with no structure to redact around: its text is withheld whole, the row
    // (and the context boundary it marks) kept.
    if (message.metadata?.carriesProjectSkillContent === true) {
      return {
        ...message,
        parts: [{ type: "text", text: COMPACTION_SUMMARY_WITHHELD_MESSAGE, state: "done" }],
      };
    }
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") return part;
      if (
        SKILL_CONTENT_TOOLS.has(part.toolName) &&
        toolOutputCarriesProjectSkillContent(part.toolName, part.output)
      ) {
        changed = true;
        return {
          ...part,
          output: { success: false, error: PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE },
        };
      }
      if (part.toolName === "code_execution") {
        const redacted = redactCodeExecutionOutput(part.output);
        if (redacted.changed) {
          changed = true;
          return { ...part, output: redacted.output };
        }
      }
      return part;
    });
    return changed ? { ...message, parts } : message;
  });
}

/**
 * Project skill content inside a step's provider-facing messages: tool results
 * appended by EARLIER STEPS OF THE SAME STREAM (a routed global skill reading a
 * project skill through agent_skill_read, directly or nested in a
 * code_execution call). The request scan ran before those steps existed, so
 * the per-step consent gate re-scans with this before every provider call.
 */
export function stepMessagesCarryProjectSkillContent(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (part.type !== "tool-result") return false;
      const output: unknown = part.output;
      // AI SDK tool outputs are typed envelopes ({ type: "json", value }); older
      // rows carry the bare value.
      const value =
        typeof output === "object" && output !== null && "value" in output
          ? (output as { value: unknown }).value
          : output;
      return toolOutputCarriesProjectSkillContent(part.toolName, value);
    });
  });
}

export function extractLoadedSkillSnapshotsFromMessages(
  messages: MuxMessage[]
): LoadedSkillSnapshot[] {
  assert(Array.isArray(messages), "extractLoadedSkillSnapshotsFromMessages requires messages");

  const snapshots: LoadedSkillSnapshot[] = [];
  for (const message of messages) {
    snapshots.push(...extractLoadedSkillSnapshotsFromMessage(message));
  }

  return mergeLoadedSkillSnapshots(snapshots);
}
