// Markdown-backed store implementation (plan 036 Phase 2), built behind
// the `LibrarianStore` interfaces — the vault of markdown documents IS the
// storage layer.

export { parseMemoryDocument, serializeMemoryDocument } from "./memory-doc.js";
export { parseHandoffDocument, serializeHandoffDocument } from "./handoff-doc.js";
export { parseProjectDocument, serializeProjectDocument } from "./project-doc.js";
export {
  parseProjectUpdateDocument,
  serializeProjectUpdateDocument,
} from "./project-update-doc.js";
export {
  parseProjectSuggestionDocument,
  serializeProjectSuggestionDocument,
} from "./project-suggestion-doc.js";
export {
  type MarkdownHandoffStoreDeps,
  createMarkdownHandoffStore,
} from "./markdown-handoff-store.js";
export {
  type MarkdownMemoryStoreDeps,
  createMarkdownMemoryStore,
} from "./markdown-memory-store.js";
export {
  type MarkdownProjectStoreDeps,
  createMarkdownProjectStore,
} from "./markdown-project-store.js";
export {
  type MarkdownProjectUpdateStoreDeps,
  createMarkdownProjectUpdateStore,
} from "./markdown-project-update-store.js";
export {
  type MarkdownProjectSuggestionStoreDeps,
  createMarkdownProjectSuggestionStore,
} from "./markdown-project-suggestion-store.js";
