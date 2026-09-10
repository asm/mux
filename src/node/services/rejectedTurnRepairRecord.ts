import { readFile } from "node:fs/promises";
import { Err, Ok, type Result } from "@/common/types/result";
import { isErrnoWithCode } from "@/node/utils/fs";

/**
 * Per-workspace auto-retry preference file (sessions/<workspaceId>/…). Besides
 * the opt-out and the startup abandon marker it carries the durable
 * rejected-turn repair record: the row keys of consent-refused turns whose
 * provider-ineligibility stamp is still outstanding.
 */
export const AUTO_RETRY_PREFERENCE_FILE = "auto-retry-preference.json";

/**
 * Keys of a persisted `pendingRejectedTurnRepair` record (the earlier single-key
 * shape included). LENIENT: the live session heals a malformed record on its
 * next state write, so it keeps whatever keys are readable. Side channels use
 * the strict reader below instead.
 */
export function parsePendingRejectedTurnRepairKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const parsed = value as { userMessageIds?: unknown; userMessageId?: unknown };
  const candidates: unknown[] = Array.isArray(parsed.userMessageIds)
    ? parsed.userMessageIds
    : [parsed.userMessageId];
  return [
    ...new Set(
      candidates.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    ),
  ];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * STRICT shape check for a present repair record: `{ userMessageIds: string[] }`
 * (every entry a non-empty string) or the legacy `{ userMessageId: string }`.
 * Returns null for anything else — a present-but-invalid record must not read
 * as "no keys outstanding".
 */
function parseStrictRepairKeys(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const parsed = value as { userMessageIds?: unknown; userMessageId?: unknown };
  if (parsed.userMessageIds !== undefined) {
    if (!Array.isArray(parsed.userMessageIds) || !parsed.userMessageIds.every(isNonEmptyString)) {
      return null;
    }
    return [...new Set(parsed.userMessageIds)];
  }
  if (isNonEmptyString(parsed.userMessageId)) {
    return [parsed.userMessageId];
  }
  return null;
}

/**
 * Row keys of rejected turns that a workspace WITHOUT a live session must still
 * treat as provider-ineligible: the outstanding repair record plus the key of a
 * `pre_stream_rejected` abandon marker. Side channels that run before or
 * without session recovery (the post-restart memory-harvest launch sweep,
 * refine) read these so a turn whose durable stamp failed cannot reach another
 * provider through them.
 *
 * A missing file is the ordinary case — nothing outstanding — and yields an
 * empty set. Any other read failure, a malformed document, or a present but
 * invalid nested field (a repair record whose keys are not strings, a marker
 * with a non-string key) is Err: the quarantine state is then UNKNOWN, and
 * after a failed stamp this record is the only durable key protecting the
 * turn, so callers must skip their provider request instead of treating the
 * state as empty. A live session rewrites the file on its next state change,
 * which heals it.
 */
export async function readDurableRejectedTurnKeys(
  preferencePath: string
): Promise<Result<Set<string>, string>> {
  let raw: string;
  try {
    raw = await readFile(preferencePath, "utf-8");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return Ok(new Set());
    }
    const reason = error instanceof Error ? error.message : String(error);
    return Err(`cannot read ${preferencePath}: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Err(`malformed record at ${preferencePath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return Err(`malformed record at ${preferencePath}`);
  }
  const record = parsed as {
    startupAutoRetryAbandon?: unknown;
    pendingRejectedTurnRepair?: unknown;
  };
  const keys = new Set<string>();
  if (record.pendingRejectedTurnRepair != null) {
    const repairKeys = parseStrictRepairKeys(record.pendingRejectedTurnRepair);
    if (repairKeys === null) {
      return Err(`malformed pendingRejectedTurnRepair record at ${preferencePath}`);
    }
    for (const key of repairKeys) {
      keys.add(key);
    }
  }
  if (record.startupAutoRetryAbandon != null) {
    const abandon = record.startupAutoRetryAbandon;
    if (typeof abandon !== "object" || Array.isArray(abandon)) {
      return Err(`malformed startupAutoRetryAbandon marker at ${preferencePath}`);
    }
    const { reason, userMessageId } = abandon as { reason?: unknown; userMessageId?: unknown };
    // A key-less marker is legitimate (a refused resume that could not read the
    // tail); a present non-string key is not.
    if (
      !isNonEmptyString(reason) ||
      (userMessageId !== undefined && !isNonEmptyString(userMessageId))
    ) {
      return Err(`malformed startupAutoRetryAbandon marker at ${preferencePath}`);
    }
    if (reason === "pre_stream_rejected" && userMessageId !== undefined) {
      keys.add(userMessageId);
    }
  }
  return Ok(keys);
}
