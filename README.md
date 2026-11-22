# Site Generator Speed

[![Competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/kai0x3/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/kai0x3/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for the make.fun bounty [Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` exports `run(input)`, which builds one generated site and returns
the output tree (every written path mapped to its file text) byte for byte
the way the reference generator does: front matter with its exact refusal
messages, permalinks and slug de-duplication, the line-based Markdown
dialect, collections, tags, and the `{{ }}` / `{% %}` template language.

The speed comes from how the work is done, not from doing less of it:

- HTML escaping scans a span once and only slices where a character really
  changes, instead of escaping character by character.
- Inline Markdown works on index ranges in the original string and escapes
  plain runs in bulk; only strong/emphasis/link segments recurse.
- Front matter and the Markdown lexer classify lines with direct character
  checks instead of layered regular expressions.
- Word counting for reading time is a single pass rather than a global
  regex match, and slug computation is memoised per build because tag
  names and headings repeat constantly.
- Templates are parsed once per case into node trees and rendered with a
  small scope-chain lookup.

`main.ts` is the harness driver: it reads the cases, answers each with
`run`, and writes the answers file. Everything is dependency-free plain
JavaScript/TypeScript source; nothing is installed and nothing is cached
between cases.
