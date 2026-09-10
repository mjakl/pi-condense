import { join } from "node:path";
import { createHash } from "node:crypto";
import { hashToolResult } from "./content-hash.js";

/** Replace anything outside [A-Za-z0-9_-] so the id can't escape the blob dir. */
export function sanitizeId(toolCallId: string): string {
  return toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function blobDirFor(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}-blobs`);
}

export function blobPathFor(sessionDir: string, sessionId: string, toolCallId: string): string {
  const base = sanitizeId(toolCallId);
  // Hash every unsanitized key: even short keys can sanitize identically.
  // ASCII prefix + "." + 16-hex hash + ".txt" stays within 255 bytes.
  const name = `${base.slice(0, 234)}.${createHash("sha1").update(toolCallId).digest("hex").slice(0, 16)}.txt`;
  return join(blobDirFor(sessionDir, sessionId), name);
}

/** Head of `text` capped at `maxBytes` (UTF-8 safe), preferring a line boundary. */
export function headPreview(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  let slice = buf.subarray(0, end).toString("utf8");
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl > 0) slice = slice.slice(0, lastNl);
  return slice;
}

interface SpillableRecord {
  toolName: string;
  resultText: string;
  spillBytes?: number;
  resultPreview?: string;
  spillPath?: string;
  contentHash?: string;
}

/** Mutates archival storage only; spilling does not establish summary coverage. */
export function applySpill(record: SpillableRecord, spillPath: string, previewBytes: number): void {
  record.spillBytes = Buffer.byteLength(record.resultText, "utf8");
  record.resultPreview = headPreview(record.resultText, previewBytes);
  record.spillPath = spillPath;
  record.contentHash = hashToolResult(record.toolName, record.resultText);
  record.resultText = "";
}
