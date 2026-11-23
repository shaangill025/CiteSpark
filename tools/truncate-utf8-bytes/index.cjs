"use strict";

// Apache-2.0 replacement for truncate-utf8-bytes@1.0.2 (WTFPL, outside the license allowlist), which
// electron-builder reaches through sanitize-filename. Same contract: cut `string` to at most `byteLength`
// UTF-8 bytes without splitting a character or a surrogate pair.
module.exports = function truncate(string, byteLength) {
  if (typeof string !== "string") throw new Error("Input must be string");
  let bytes = 0;
  for (let i = 0; i < string.length; i += 1) {
    const unit = string.charCodeAt(i);
    let width = 1;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = string.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) width = 2;
    }
    bytes += Buffer.byteLength(string.slice(i, i + width));
    if (bytes > byteLength) return string.slice(0, i);
    i += width - 1;
  }
  return string;
};
