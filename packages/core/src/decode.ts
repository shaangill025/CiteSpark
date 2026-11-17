import { parse, type DefaultTreeAdapterTypes } from "parse5";

/**
 * ENR-02/ENR-03: turn fetched body bytes into text without silent replacement. The encoding comes
 * from, in order: a byte order mark, the Content-Type `charset` parameter, an HTML `<meta>`
 * declaration in the first 1024 bytes (HTML only), and otherwise UTF-8. Decoding is fatal: bytes that
 * are invalid for the chosen encoding, and labels this runtime's TextDecoder does not support, become
 * explicit gaps instead of U+FFFD-filled text. XML encoding declarations are not read, so an XHTML
 * page in a non-UTF-8 encoding needs a header charset or BOM, or it becomes an explicit gap.
 */
export type DecodeResult =
  | { ok: true; text: string; encoding: string }
  | { ok: false; reason: "unsupported_charset" | "invalid_text_encoding"; detail: string };

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const HTML_NS = "http://www.w3.org/1999/xhtml";
/** The HTML prescan window (WHATWG "prescan a byte stream", first 1024 bytes). */
const PRESCAN_BYTES = 1024;

function printable(label: string): string {
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(label.slice(0, 64).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?"));
}

function bomEncoding(body: Uint8Array): string | null {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  return null;
}

function* elements(node: ParentNode): Generator<Element> {
  for (const child of node.childNodes) {
    if ("tagName" in child) {
      yield child;
      yield* elements(child);
    }
  }
}

function attr(el: Element, name: string): string | null {
  return el.attrs.find((a) => a.name === name && !a.namespace)?.value ?? null;
}

/** WHATWG "extract a character encoding from a meta element" for an http-equiv content value. */
function charsetFromContent(content: string): string | null {
  let rest = content;
  for (;;) {
    const at = rest.toLowerCase().indexOf("charset");
    if (at === -1) return null;
    rest = rest.slice(at + "charset".length).replace(/^[\t\n\f\r ]*/, "");
    if (rest[0] !== "=") continue;
    rest = rest.slice(1).replace(/^[\t\n\f\r ]*/, "");
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      const end = rest.indexOf(quote, 1);
      return end === -1 ? null : rest.slice(1, end);
    }
    const value = /^[^\t\n\f\r ;]*/.exec(rest)?.[0] ?? "";
    return value === "" ? null : value;
  }
}

/**
 * The first `<meta charset>` or `<meta http-equiv="content-type">` declaration in the first 1024 bytes,
 * found by parsing those bytes as HTML, so declarations inside script text, comments or attribute
 * values are not mistaken for real elements. Bytes are mapped one-to-one to code points for the scan;
 * every label is ASCII, so the result does not depend on the real encoding.
 */
function metaDeclaredLabel(body: Uint8Array): string | null {
  const prefix = Buffer.from(body.subarray(0, PRESCAN_BYTES)).toString("latin1");
  for (const el of elements(parse(prefix))) {
    if (el.tagName !== "meta" || el.namespaceURI !== HTML_NS) continue;
    const charset = attr(el, "charset");
    if (charset !== null && charset.trim() !== "") return charset.trim();
    if (attr(el, "http-equiv")?.trim().toLowerCase() === "content-type") {
      const declared = charsetFromContent(attr(el, "content") ?? "");
      if (declared !== null && declared.trim() !== "") return declared.trim();
    }
  }
  return null;
}

function decoderFor(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label, { fatal: true });
  } catch {
    // RangeError: unknown label, or one mapped to the "replacement" encoding.
    return null;
  }
}

/** Decode fetched bytes for `mime` ("text/html", "application/xhtml+xml" or "text/plain"). */
export function decodeBody(
  body: Uint8Array,
  mime: string,
  headerCharset: string | null,
): DecodeResult {
  const bom = bomEncoding(body);
  const meta =
    bom === null && headerCharset === null && mime === "text/html" ? metaDeclaredLabel(body) : null;
  const [label, source] =
    bom !== null
      ? [bom, "byte order mark"]
      : headerCharset !== null
        ? [headerCharset, "content-type charset"]
        : meta !== null
          ? [meta, "meta declaration"]
          : ["utf-8", "default"];
  let decoder = decoderFor(label);
  if (decoder !== null && meta !== null) {
    // A meta declaration that was readable as ASCII cannot describe UTF-16, and x-user-defined is
    // read as windows-1252 (WHATWG prescan rules).
    if (decoder.encoding === "utf-16le" || decoder.encoding === "utf-16be") {
      decoder = decoderFor("utf-8");
    } else if (decoder.encoding === "x-user-defined") {
      decoder = decoderFor("windows-1252");
    }
  }
  if (decoder === null) {
    return {
      ok: false,
      reason: "unsupported_charset",
      detail: `${source} ${printable(label)} is not a supported encoding`,
    };
  }
  const encoding = decoder.encoding;
  try {
    return { ok: true, text: decoder.decode(body), encoding };
  } catch {
    return {
      ok: false,
      reason: "invalid_text_encoding",
      detail: `body is not valid ${encoding} (${source})`,
    };
  }
}
