import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";

import {
  IMAGE_TOKEN_ESTIMATE,
  PDF_MAX_PAGES_ESTIMATE,
  PDF_TOKENS_PER_PAGE_ESTIMATE,
} from "@/common/constants/contextBudget";

import { estimatePdfAttachmentTokens } from "./pdfTokenEstimate";

function pdfDataUrl(body: string | Buffer): string {
  const bytes = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  return `data:application/pdf;base64,${bytes.toString("base64")}`;
}

function flateObjectStream(objectNumber: number, content: string): Buffer {
  const compressed = deflateSync(Buffer.from(content, "latin1"));
  return Buffer.concat([
    Buffer.from(
      `${objectNumber} 0 obj\n<< /Type /ObjStm /First 0 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\r\n`,
      "latin1"
    ),
    compressed,
    Buffer.from("\r\nendstream\nendobj\n", "latin1"),
  ]);
}

/** Page dictionaries packed into one FlateDecode object stream (PDF 1.5+ writers). */
function objectStreamPdf(pageCount: number, options?: { separateTreeStream?: boolean }): Buffer {
  const objects = Array.from(
    { length: pageCount },
    (_, index) => `${index + 2} 0 << /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] >>`
  ).join("\n");
  return Buffer.concat([
    Buffer.from("%PDF-1.5\n", "latin1"),
    ...(options?.separateTreeStream === true
      ? [flateObjectStream(100, `1 0 << /Type /Pages /Kids [] /Count ${pageCount} >>`)]
      : []),
    flateObjectStream(101, objects),
    Buffer.from("%%EOF\n", "latin1"),
  ]);
}

describe("estimatePdfAttachmentTokens", () => {
  it("prices visible page objects per page", () => {
    const pages = Array.from(
      { length: 3 },
      (_, index) => `${index + 1} 0 obj\n<< /Type /Page /Parent 9 0 R >>\nendobj`
    ).join("\n");
    const pdf = `%PDF-1.4\n${pages}\n9 0 obj\n<< /Type /Pages /Kids [1 0 R 2 0 R 3 0 R] /Count 3 >>\nendobj\n`;
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(3 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("counts page objects stored in compressed object streams", () => {
    // A highly compressible 40-page document is a few hundred bytes on the
    // wire: a size-based fallback would price it near the image floor while
    // the provider bills forty pages.
    const url = pdfDataUrl(objectStreamPdf(40));
    expect(estimatePdfAttachmentTokens(url)).toBe(40 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("does not add a compressed page tree count to the page objects of another stream", () => {
    // The tree's /Count and the page dictionaries live in different object
    // streams: the two sources are compared, never summed (a 2x estimate would
    // force compaction of a request that fits).
    const url = pdfDataUrl(objectStreamPdf(40, { separateTreeStream: true }));
    expect(estimatePdfAttachmentTokens(url)).toBe(40 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("uses the page tree count when the page objects themselves are not visible", () => {
    const pdf = "%PDF-1.5\n1 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 12 >>\nendobj\n";
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(12 * PDF_TOKENS_PER_PAGE_ESTIMATE);
  });

  it("assumes the provider page cap when no page count can be recovered", () => {
    // An object stream that does not inflate (encrypted, another filter): the
    // compressed size bounds nothing, so the estimate is the cap providers enforce.
    const pdf =
      "%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length 8 >>\nstream\r\nnotzlib!\r\nendstream\nendobj\n";
    expect(estimatePdfAttachmentTokens(pdfDataUrl(pdf))).toBe(
      PDF_MAX_PAGES_ESTIMATE * PDF_TOKENS_PER_PAGE_ESTIMATE
    );
    expect(estimatePdfAttachmentTokens("https://example.com/a.pdf")).toBe(IMAGE_TOKEN_ESTIMATE);
  });
});
