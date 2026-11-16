import { diff3Merge } from "node-diff3";
import { splitLines } from "./text.ts";

export interface ConflictHunk {
  /** 0-based line index of the hunk in the base text. */
  baseLine: number;
  base: string;
  vault: string;
  library: string;
}

export type TextMerge = { clean: true; text: string } | { clean: false; hunks: ConflictHunk[] };

/**
 * Line-level three-way merge (diff3). Changes from one side merge automatically. Overlapping or
 * adjacent changes from both sides are a conflict, never last-write-wins (SYN-03). Identical
 * changes on both sides are not a conflict.
 */
export function merge3(base: string, vault: string, library: string): TextMerge {
  if (vault === library || library === base) return { clean: true, text: vault };
  if (vault === base) return { clean: true, text: library };
  const regions = diff3Merge(splitLines(vault), splitLines(base), splitLines(library), {
    excludeFalseConflicts: true,
  });
  const out: string[] = [];
  const hunks: ConflictHunk[] = [];
  for (const r of regions) {
    if (r.ok) out.push(...r.ok);
    else
      hunks.push({
        baseLine: r.conflict.oIndex,
        base: r.conflict.o.join(""),
        vault: r.conflict.a.join(""),
        library: r.conflict.b.join(""),
      });
  }
  return hunks.length > 0 ? { clean: false, hunks } : { clean: true, text: out.join("") };
}

/** Three-way choice for an opaque value. `undefined` means the value is absent on that side. */
export type ValueMerge<T> = { clean: true; value: T } | { clean: false };

export function merge3Value<T>(
  base: T,
  vault: T,
  library: T,
  equal: (a: T, b: T) => boolean,
): ValueMerge<T> {
  if (equal(vault, library) || equal(library, base)) return { clean: true, value: vault };
  if (equal(vault, base)) return { clean: true, value: library };
  return { clean: false };
}
