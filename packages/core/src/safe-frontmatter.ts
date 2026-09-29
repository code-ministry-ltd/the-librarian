// The only way this codebase parses or renders Markdown front matter.
//
// gray-matter picks its engine from the text after the opening fence, and its
// defaults include a JavaScript engine that `eval`s the block (`---js`) plus a
// CoffeeScript one. Vault files and imported notes are untrusted text, so those
// engines are replaced with ones that refuse. Always passing options also
// bypasses gray-matter's process-wide parse cache, which otherwise keeps every
// document ever parsed and replays cached results for failed parses.

import matter from "gray-matter";

function refuseExecutableFrontmatter(): never {
  throw new Error(
    "Refusing to evaluate executable front matter: only YAML front matter is supported. " +
      "Remove the language tag after the opening '---'.",
  );
}

const REFUSED = { parse: refuseExecutableFrontmatter, stringify: refuseExecutableFrontmatter };

const SAFE_OPTIONS = {
  engines: {
    javascript: REFUSED,
    js: REFUSED,
    coffee: REFUSED,
    coffeescript: REFUSED,
    cson: REFUSED,
  },
};

export type ParsedFrontmatter = matter.GrayMatterFile<string>;

/** Parse YAML front matter; never evaluates code. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  return matter(raw, SAFE_OPTIONS);
}

/** Render `data` as YAML front matter above `content`; never evaluates code. */
export function stringifyFrontmatter(content: string, data: object): string {
  return matter.stringify(content, data, SAFE_OPTIONS);
}
