import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  AUTO_RETRY_PREFERENCE_FILE,
  parsePendingRejectedTurnRepairKeys,
  readDurableRejectedTurnKeys,
} from "./rejectedTurnRepairRecord";

describe("rejected-turn repair record", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-rejected-turn-record-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads the outstanding repair keys and a rejected abandon marker without a session", async () => {
    // The post-restart launch sweep harvests before any session exists, so the
    // keys must come from the durable record itself.
    const preferencePath = path.join(tempDir, AUTO_RETRY_PREFERENCE_FILE);
    await fs.writeFile(
      preferencePath,
      JSON.stringify({
        startupAutoRetryAbandon: { reason: "pre_stream_rejected", userMessageId: "u-marker" },
        pendingRejectedTurnRepair: { userMessageIds: ["u-old", "u-new", "u-old"] },
      })
    );
    const keys = await readDurableRejectedTurnKeys(preferencePath);
    expect(keys.success && [...keys.data].sort()).toEqual(["u-marker", "u-new", "u-old"]);
  });

  it("ignores markers with other reasons and still reads the earlier single-key record shape", async () => {
    const preferencePath = path.join(tempDir, AUTO_RETRY_PREFERENCE_FILE);
    await fs.writeFile(
      preferencePath,
      JSON.stringify({
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "u-aborted" },
        pendingRejectedTurnRepair: { userMessageId: "u-legacy" },
      })
    );
    const keys = await readDurableRejectedTurnKeys(preferencePath);
    expect(keys.success && [...keys.data]).toEqual(["u-legacy"]);
    expect(parsePendingRejectedTurnRepairKeys({ userMessageIds: ["a", "", 3, "a"] })).toEqual([
      "a",
    ]);
    expect(parsePendingRejectedTurnRepairKeys(null)).toEqual([]);
  });

  it("yields no keys for a missing file but an unknown state for an unreadable or malformed one", async () => {
    // A missing file is the ordinary "nothing outstanding" case. Anything else
    // hides keys a side channel needs: after a failed stamp this record is the
    // only durable protection, so the caller must fail closed, not empty.
    const preferencePath = path.join(tempDir, AUTO_RETRY_PREFERENCE_FILE);
    const missing = await readDurableRejectedTurnKeys(preferencePath);
    expect(missing.success && missing.data.size).toBe(0);
    await fs.writeFile(preferencePath, "{ not json");
    expect((await readDurableRejectedTurnKeys(preferencePath)).success).toBe(false);
    await fs.writeFile(preferencePath, "null");
    expect((await readDurableRejectedTurnKeys(preferencePath)).success).toBe(false);
    // A directory at the record's path fails the read with something other than ENOENT.
    expect((await readDurableRejectedTurnKeys(tempDir)).success).toBe(false);
  });
});
