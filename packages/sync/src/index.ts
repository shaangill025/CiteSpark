export {
  joinNote,
  mergeFrontmatter,
  NAMESPACE,
  NOTE_SCHEMA_VERSION,
  readNamespace,
  splitNote,
  type FrontmatterMerge,
  type MetadataConflict,
  type SplitNote,
} from "./frontmatter.ts";
export {
  identify,
  type BindingState,
  type IdentityDecision,
  type KnownBinding,
  type ScannedFile,
} from "./identity.ts";
export {
  mergeNote,
  type ContentConflict,
  type MergeNoteOptions,
  type NoteConflict,
  type NoteMerge,
  type NoteVersions,
  type ReadOnlyBodyConflict,
  type SchemaConflict,
  type SourceEdit,
} from "./merge-note.ts";
export {
  merge3,
  merge3Value,
  type ConflictHunk,
  type TextMerge,
  type ValueMerge,
} from "./merge-text.ts";
export {
  getBinding,
  listBindings,
  listConflicts,
  mergeConflictRecord,
  recordConflict,
  saveBinding,
  setConflictStatus,
  type Binding,
  type BindingKey,
  type ConflictKind,
  type ConflictRecord,
  type ConflictStatus,
} from "./persistence.ts";
export {
  escapeSectionText,
  parseBody,
  renderBody,
  renderSections,
  SECTION_NAMES,
  unescapeSectionText,
  type RenderSections,
  type SectionName,
  type Segment,
} from "./sections.ts";
export { contentHash, splitLines } from "./text.ts";
