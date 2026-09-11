import { createHash } from "crypto";
import YAML from "yaml";

import assert from "@/common/utils/assert";
import { MAX_POST_COMPACTION_LOADED_SKILLS } from "@/common/constants/attachments";
import type { LoadedSkillSnapshot } from "@/common/types/attachment";
import type { AgentSkillFrontmatter, AgentSkillScope } from "@/common/types/agentSkill";
import { isTurnStartingUserRow, type ModelMessage, type MuxMessage } from "@/common/types/message";
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
  if (summaryCarriesProjectSkillContent(message)) {
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
export function toolOutputCarriesProjectSkillContent(toolName: unknown, output: unknown): boolean {
  if (toolName === "agent_skill_read") return outputRetainsProjectSkill(output);
  if (toolName === "agent_skill_read_file") return outputIsProjectSkillFile(output);
  if (toolName === "code_execution") {
    // The execution's own provenance stamp (CodeExecutionResult
    // .carriesProjectSkillContent) covers content the guest copied into the
    // return value or console and records kernel-mode compaction dropped;
    // the nested scan covers outputs persisted before the stamp existed.
    return (
      outputIsStampedCodeExecution(output) ||
      nestedSkillContentRecords(output).some((record) =>
        toolOutputCarriesProjectSkillContent(record.toolName, record.result)
      )
    );
  }
  return false;
}

function outputIsStampedCodeExecution(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { carriesProjectSkillContent?: unknown }).carriesProjectSkillContent === true
  );
}

/**
 * Replaces the text of a summary row (compaction or abandoned branch) that
 * summarized — or, lacking a provenance stamp, may have summarized — project
 * skill content, in a REQUEST copy for an untrusted workspace (history is
 * untouched).
 */
export const COMPACTION_SUMMARY_WITHHELD_MESSAGE =
  "[Summary withheld: it may summarize project skill content and this " +
  "workspace's project is not trusted.]";

/**
 * Whether a summary row must be treated as project skill content: stamped
 * TRUE, or a summary row written before provenance was tracked (no stamp) —
 * its text may quote a project skill, so across the trust boundary it is
 * unknown and counts as carrying until a newer summary replaces it. Summaries
 * stamped FALSE were verified clean at summarization.
 */
function summaryCarriesProjectSkillContent(message: MuxMessage): boolean {
  const metadata = message.metadata;
  if (metadata?.carriesProjectSkillContent === true) return true;
  if (metadata?.carriesProjectSkillContent === false) return false;
  const kind = metadata?.muxMetadata?.type;
  return (
    metadata?.compactionBoundary === true ||
    (metadata?.compacted !== undefined && metadata.compacted !== false) ||
    kind === "compaction-summary" ||
    kind === "branch-summary"
  );
}

/**
 * Replaces an assistant row that replied to a project skill invocation, in a
 * REQUEST copy for an untrusted workspace (history is untouched): the reply
 * can quote the (dropped) snapshot in prose, tool arguments or tool results.
 */
export const PROJECT_SKILL_TURN_WITHHELD_MESSAGE =
  "[Assistant turn withheld: it replied to a project skill invocation and this " +
  "workspace's project is not trusted.]";

/**
 * Request-copy withholding for an UNTRUSTED workspace's routed request — every
 * channel repository-controlled project skill content takes into a request:
 *
 * 1. project-scope skill snapshot rows are dropped;
 * 2. the assistant rows of the turns those snapshots opened are withheld
 *    whole — the model's reply can quote the snapshot in prose, tool
 *    arguments or tool results, and a row's dynamic-tool parts hold call and
 *    result together, so replacing the row keeps the pairing consistent;
 * 3. tool results carrying project skills, tainted code executions and
 *    provenance-stamped summaries are redacted (redactProjectSkillToolResults).
 *
 * Rows are copied, never mutated.
 */
export function withholdProjectSkillContentFromRequest(messages: MuxMessage[]): MuxMessage[] {
  const kept: MuxMessage[] = [];
  // A turn persists its snapshot prefix immediately before its user row, so a
  // project snapshot marks the NEXT turn-starting user row's turn. Synthetic
  // user rows that are not turns of their own (a <system-file-update>
  // notification between the user row and its reply, other snapshot prefixes)
  // leave the turn tracking untouched.
  let projectPrefixPending = false;
  let inProjectTurn = false;
  for (const message of messages) {
    if (message.role === "user") {
      if (message.metadata?.agentSkillSnapshot?.scope === "project") {
        projectPrefixPending = true;
        continue;
      }
      if (isTurnStartingUserRow(message)) {
        inProjectTurn = projectPrefixPending;
        projectPrefixPending = false;
      }
      kept.push(message);
      continue;
    }
    kept.push(
      inProjectTurn
        ? { ...message, parts: [{ type: "text", text: PROJECT_SKILL_TURN_WITHHELD_MESSAGE }] }
        : message
    );
  }
  return redactProjectSkillToolResults(kept);
}

/**
 * Replaces the prose of an assistant row whose project skill tool output was
 * withheld, in a REQUEST copy (history is untouched): the text may quote it.
 */
export const PROJECT_SKILL_TEXT_WITHHELD_MESSAGE =
  "[Assistant text withheld: it followed a project skill read and this workspace's " +
  "project is not trusted.]";

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

/**
 * A tainted code_execution output is withheld WHOLE: the guest can copy a
 * nested project skill result into the return value or console output, so
 * redacting the nested record alone would leave the copies. The replacement
 * keeps the result's shape (a failed execution) so the call/result pairing
 * survives, and the stamp so a later scan still classifies it.
 */
function redactCodeExecutionOutput(output: unknown): { output: unknown; changed: boolean } {
  if (!toolOutputCarriesProjectSkillContent("code_execution", output)) {
    return { output, changed: false };
  }
  const duration = (output as { duration_ms?: unknown }).duration_ms;
  return {
    output: {
      success: false,
      error: PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE,
      toolCalls: [],
      consoleOutput: [],
      duration_ms: typeof duration === "number" ? duration : 0,
      carriesProjectSkillContent: true,
    },
    changed: true,
  };
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
    // A summary carrying project skill provenance (stamped, or a legacy
    // summary whose provenance is unknown — see
    // MuxMessageMetadata.carriesProjectSkillContent) is plain assistant text
    // with no structure to redact around: its text is withheld whole, the row
    // (and the context boundary it marks) kept.
    if (summaryCarriesProjectSkillContent(message)) {
      return {
        ...message,
        parts: [{ type: "text", text: COMPACTION_SUMMARY_WITHHELD_MESSAGE }],
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
    if (!changed) return message;
    // The stream persists a tool result and the prose that follows it in ONE
    // assistant row, and that prose can be the model's copy of the withheld
    // output. A tainted row therefore loses its text (and reasoning) as well;
    // the tool parts keep the call/result pairing.
    return {
      ...message,
      parts: parts
        .filter((part) => part.type !== "reasoning")
        .map((part) =>
          part.type === "text" ? { ...part, text: PROJECT_SKILL_TEXT_WITHHELD_MESSAGE } : part
        ),
    };
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
