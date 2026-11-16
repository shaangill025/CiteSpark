import { createHash } from "node:crypto";

/** SHA-256 of the exact bytes (UTF-8 for strings), prefixed with the algorithm. */
export function contentHash(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Splits into lines that keep their terminators, so `splitLines(t).join("") === t`. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export interface TextForm {
  text: string;
  bom: boolean;
  crlf: boolean;
}

/** Strips a UTF-8 BOM and converts CRLF to LF so EOL style alone never looks like an edit. */
export function normalize(raw: string): TextForm {
  const bom = raw.startsWith("\uFEFF");
  const body = bom ? raw.slice(1) : raw;
  const crlf = body.includes("\r\n");
  return { text: crlf ? body.replace(/\r\n/g, "\n") : body, bom, crlf };
}

/** Re-applies the BOM and line-ending style of `form` to LF text. */
export function denormalize(text: string, form: Pick<TextForm, "bom" | "crlf">): string {
  const eol = form.crlf ? text.replace(/\n/g, "\r\n") : text;
  return form.bom ? `\uFEFF${eol}` : eol;
}
