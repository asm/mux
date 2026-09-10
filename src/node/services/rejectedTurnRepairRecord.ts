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

/** Keys of a persisted `pendingRejectedTurnRepair` record (the earlier single-key shape included). */
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

/**
 * Row keys of rejected turns that a workspace WITHOUT a live session must still
 * treat as provider-ineligible: the outstanding repair record plus the key of a
 * `pre_stream_rejected` abandon marker. Side channels that run before or
 * without session recovery (the post-restart memory-harvest launch sweep,
 * refine) read these so a turn whose durable stamp failed cannot reach another
 * provider through them.
 *
 * A missing file is the ordinary case — nothing outstanding — and yields an
 * empty set. Any other read failure, or a malformed record, is Err: the
 * quarantine state is then UNKNOWN, and after a failed stamp this record is
 * the only durable key protecting the turn, so callers must skip their
 * provider request instead of treating the state as empty. A live session
 * rewrites the file on its next state change, which heals it.
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
  if (typeof parsed !== "object" || parsed === null) {
    return Err(`malformed record at ${preferencePath}`);
  }
  const record = parsed as {
    startupAutoRetryAbandon?: { reason?: unknown; userMessageId?: unknown };
    pendingRejectedTurnRepair?: unknown;
  };
  const keys = new Set(parsePendingRejectedTurnRepairKeys(record.pendingRejectedTurnRepair));
  const abandon = record.startupAutoRetryAbandon;
  if (
    abandon?.reason === "pre_stream_rejected" &&
    typeof abandon.userMessageId === "string" &&
    abandon.userMessageId.trim().length > 0
  ) {
    keys.add(abandon.userMessageId);
  }
  return Ok(keys);
}
