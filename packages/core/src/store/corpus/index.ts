// Corpus module — markdown vault I/O for the markdown rearchitecture
// (spec 035 §F1 / Phase 1). Frontmatter today; wikilink parsing and vault
// file I/O land in follow-on increments.

export {
  type CorpusDocument,
  type CorpusFrontmatter,
  CorpusFrontmatterSchema,
  parseDocument,
  serializeDocument,
} from "./frontmatter.js";
export {
  type Wikilink,
  parseWikilinks,
  renameWikilinkTarget,
  repointWikilinkTargets,
} from "./wikilink.js";
export {
  type Vault,
  type VaultOptions,
  UnsafeVaultPathError,
  createVault,
  resolveVaultPath,
  scopeVault,
} from "./vault.js";
export { type RepointLinksStore, relinkVault, repointMemoryLinks } from "./link-integrity.js";
export {
  type VaultLinkIndex,
  type VaultLinkIndexOptions,
  buildVaultLinkIndex,
} from "./vault-links.js";
export {
  type InboxDeps,
  type InboxItem,
  type InboxItemRef,
  type InboxSubmissionHints,
  type ReapResult,
  type ReapStaleClaimsOptions,
  DEFAULT_MAX_INBOX_ATTEMPTS,
  type WriteInboxOptions,
  claimInboxItem,
  completeInboxItem,
  listInbox,
  parseInboxItem,
  reapStaleClaims,
  releaseStaleClaims,
  serializeInboxItem,
  writeInbox,
} from "./inbox.js";
