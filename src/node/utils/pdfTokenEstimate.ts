import { inflateSync } from "node:zlib";

import {
  IMAGE_TOKEN_ESTIMATE,
  PDF_MAX_PAGES_ESTIMATE,
  PDF_TOKENS_PER_PAGE_ESTIMATE,
} from "@/common/constants/contextBudget";

/** Page dictionaries (`/Type /Page`), not the `/Pages` tree nodes. */
const PAGE_OBJECT_PATTERN = /\/Type\s*\/Page(?![s])/g;
/** Page-tree nodes carry their descendant page count: `/Type /Pages ... /Count N`. */
const PAGE_TREE_COUNT_PATTERN = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g;
/** Stream dictionaries sit right before the `stream` keyword; this window covers them. */
const STREAM_DICTIONARY_WINDOW_CHARS = 512;
/** Inflation bounds: a hostile stream must not expand without limit. */
const MAX_INFLATED_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_TOTAL_BYTES = 64 * 1024 * 1024;

function countPageObjects(text: string): number {
  return text.match(PAGE_OBJECT_PATTERN)?.length ?? 0;
}

function maxPageTreeCount(text: string): number {
  let max = 0;
  for (const match of text.matchAll(PAGE_TREE_COUNT_PATTERN)) {
    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count > max) max = count;
  }
  return max;
}

/**
 * Decoded contents of the document's FlateDecode streams: modern writers keep
 * page dictionaries in compressed object streams, where a raw scan sees none.
 * Bounded; streams that do not inflate (encrypted, other filters, corrupt)
 * are skipped.
 */
function inflatedStreams(bytes: Buffer, text: string): string[] {
  const inflated: string[] = [];
  let total = 0;
  let cursor = 0;
  while (total < MAX_INFLATED_TOTAL_BYTES) {
    const keywordAt = text.indexOf("stream", cursor);
    if (keywordAt === -1) break;
    const endAt = text.indexOf("endstream", keywordAt + "stream".length);
    if (endAt === -1) break;
    cursor = endAt + "endstream".length;
    // "endstream" contains "stream": skip the closing keyword's own match.
    if (text.slice(Math.max(0, keywordAt - 3), keywordAt) === "end") continue;
    const dictionary = text.slice(
      Math.max(0, keywordAt - STREAM_DICTIONARY_WINDOW_CHARS),
      keywordAt
    );
    if (!dictionary.includes("/FlateDecode")) continue;
    let dataStart = keywordAt + "stream".length;
    if (text[dataStart] === "\r") dataStart++;
    if (text[dataStart] === "\n") dataStart++;
    try {
      const data = inflateSync(bytes.subarray(dataStart, endAt), {
        maxOutputLength: MAX_INFLATED_STREAM_BYTES,
      });
      total += data.length;
      inflated.push(data.toString("latin1"));
    } catch {
      // Not an inflatable stream; the caller falls back to the page cap.
    }
  }
  return inflated;
}

/**
 * Conservative token cost of a PDF attachment. Providers bill a PDF per page
 * (extracted text plus a page image), so pages are priced at the per-page
 * upper bound. Page objects are counted in the raw bytes together with the
 * page tree's `/Count`; when neither is visible the FlateDecode streams are
 * inflated (object streams hold the page dictionaries of most modern PDFs)
 * and scanned the same way. When no source recovers a page count, the
 * provider's page cap is assumed: a compressed byte size cannot bound a page
 * count, and under-estimating lets the pre-send check skip compaction only to
 * fail at dispatch.
 */
export function estimatePdfAttachmentTokens(url: string): number {
  if (!url.startsWith("data:")) return IMAGE_TOKEN_ESTIMATE;
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1 || !url.slice(0, commaIndex).includes(";base64")) {
    return IMAGE_TOKEN_ESTIMATE;
  }
  const bytes = Buffer.from(url.slice(commaIndex + 1), "base64");
  const text = bytes.toString("latin1");
  let pageObjects = countPageObjects(text);
  let treeCount = maxPageTreeCount(text);
  if (pageObjects === 0 && treeCount === 0) {
    for (const decoded of inflatedStreams(bytes, text)) {
      // Page objects are summed across streams (each dictionary lives in
      // exactly one); the tree count is a maximum. The two sources are
      // compared once below, never added to each other.
      pageObjects += countPageObjects(decoded);
      treeCount = Math.max(treeCount, maxPageTreeCount(decoded));
    }
  }
  const pages = Math.max(pageObjects, treeCount);
  return (pages > 0 ? pages : PDF_MAX_PAGES_ESTIMATE) * PDF_TOKENS_PER_PAGE_ESTIMATE;
}
