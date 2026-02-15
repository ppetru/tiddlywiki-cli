---
name: tiddlywiki-cli
description: TiddlyWiki CLI for CRUD, diff, and semantic search via HTTP API. Also covers filter syntax, wikitext, data modeling, and query patterns. Use when working with any TiddlyWiki wiki.
agentskills.io: true
---

# TiddlyWiki CLI

CLI tool for TiddlyWiki's HTTP API. Zero dependencies for CRUD; optional deps for semantic search.

## CLI Reference

```
tw <wiki> filter '<expr>' [--text]                          # query tiddlers (metadata; --text includes body)
tw <wiki> get '<title>'                                     # single tiddler, full content
tw <wiki> put '<title>' --text '...' | --file <path>        # create/update
         [--tags '<tags>'] [--type <type>] [--field k=v ...]
tw <wiki> diff '<title>' --text '...' | --file <path>       # unified diff against current content
tw <wiki> delete '<title>'
tw <wiki> semantic '<query>' [--filter '<pre-filter>'] [--limit N]
tw <wiki> reindex [--force] [--status]
tw <wiki> status                                            # reachability, tiddler count, embeddings
```

Wiki names come from `wikis.json` (search: `./wikis.json` → `~/.config/tw/wikis.json` → `<skill-dir>/wikis.json`).

### Output Format

- All commands output JSON except `diff` (unified diff text to stdout)
- `filter`: array of `{title, tags, modified, type, ...}` — no `text` unless `--text`
- `filter --text` / `get`: full tiddler objects including `text`
- `put` / `delete`: `{"ok": true, "title": "...", "action": "created|updated|deleted"}`

### Workflow Rules

1. **Always `diff` before `put`** when updating existing tiddlers
2. **Check `type` before editing** — preserve content type (wikitext↔markdown)
3. **Metadata first** — `filter` without `--text` is a single request; `--text` does N+1 GETs (one per tiddler). Always pair `--text` with `limit[N]` or batch by time prefix.

```bash
# Diff then write workflow
tw alowiki diff 'Soil Analysis' --file /tmp/updated.md
tw alowiki put 'Soil Analysis' --file /tmp/updated.md

# Create new tiddler (defaults to text/markdown)
tw pispace put 'Meeting Notes' --text '# Notes from today...' --tags 'Meeting 2026'

# Semantic search with pre-filter
tw captainslog semantic 'feeling overwhelmed with work' --filter '[prefix[2025]]' --limit 10

# Pipe to jq for field extraction
tw alowiki filter '[tag[Plants]has[latin-name]]' --text | jq '.[].title'
```

## Filter Syntax

Filters select tiddlers via chained operators. Think piped transformations.

**Structure:** `[op1[param]op2[param]]` — operators in same brackets = AND. Comma-separated runs = OR.

```
[tag[Journal]!tag[agent-generated]search[exercise]]     ← AND: all three conditions
[search[bike]],[search[cycling]],[search[mtb]]           ← OR: any match
[tag[Journal]] -[tag[draft]]                             ← subtract: remove drafts
```

### Operators

| Operator | Example | Notes |
|----------|---------|-------|
| `tag[X]` | `[tag[Journal]]` | Has tag X |
| `!tag[X]` | `[!tag[agent-generated]]` | Lacks tag X |
| `search[X]` | `[search[exercise]]` | Full-text (title + text) |
| `prefix[X]` | `[prefix[2025-11]]` | Title starts with |
| `suffix[X]` | `[suffix[.md]]` | Title ends with |
| `field:F[V]` | `[field:grade[Poor]]` | Custom field equals value |
| `has[F]` | `[has[due]]` | Field exists |
| `!has[F]` | `[!has[draft.of]]` | Field missing |
| `sort[F]` / `!sort[F]` | `[!sort[modified]]` | Ascending / descending sort |
| `limit[N]` | `[limit[10]]` | First N results |
| `!days:modified[-N]` | `[!days:modified[-7]]` | Modified in last N days |
| `!days:created[-N]` | `[!days:created[-30]]` | Created in last N days |
| `each[F]` | `[each[category]]` | Deduplicate by field |
| `is[system]` | `[!is[system]]` | System tiddlers ($:/ prefix) |
| `tagging[]` | `[[Animals]tagging[]]` | Tiddlers tagged with input |
| `tags[]` | `[[MyTiddler]tags[]]` | Tags of input tiddler |
| `links[]` / `backlinks[]` | `[[MyTiddler]backlinks[]]` | Outgoing / incoming links |
| `listed[F]` | `[listed[list]]` | Tiddlers whose list field includes input |
| `count[]` | `[tag[Journal]count[]]` | Count of matches |
| `addprefix[X]` / `addsuffix[X]` | `[addprefix[MAP/]]` | Prepend / append to each title |
| `subfilter[X]` | `[subfilter{filter-tid}]` | Apply sub-filter |

**Variable/tiddler refs:** `[<variable>]` = variable value, `[{tiddler}]` = tiddler's text field.

## Wikitext Syntax

For tiddlers with `type: text/vnd.tiddlywiki` (TW default). Markdown tiddlers use `text/markdown`.

```
! H1  !! H2  !!! H3                          Headings
''bold''  //italic//  __underline__           Inline formatting
~~strike~~  `code`
[[Link]]  [[Display|Target]]                  Internal links
[[Text|https://url]]                          External links
* bullet  ** nested  # numbered               Lists
---                                           Horizontal rule
| H1 | H2 |h                                 Table header
| c1 | c2 |                                  Table row
> blockquote                                  Blockquote

{{Tiddler}}                                   Transclude content
{{Tiddler!!field}}                            Transclude field
{{!!field}}                                   Field from current tiddler
{{Tiddler||Template}}                         Transclude via template
{{{ [tag[X]] }}}                              Filtered transclusion
{{{ [tag[X]] ||Template }}}                   Filtered transclusion + template
```

### Widgets

```xml
<!-- Iterate filter results -->
<$list filter="[tag[Journal]!sort[created]limit[10]]"><$link/><br/></$list>

<!-- Conditional (emptyMessage for else) -->
<$list filter="[tag[todo]!tag[done]limit[1]]" emptyMessage="All done!">Open tasks remain.</$list>

<!-- Variables ($let preferred; $vars is legacy equivalent) -->
<$let myvar="value"><<myvar>></$let>

<!-- Actions -->
<$button>
  <$action-setfield $tiddler="T" $field="status" $value="done"/>
  <$action-navigate $to="Target"/>
</$button>

<!-- Dynamic list rendering -->
<<list-links "[tag[Journal]!sort[modified]limit[10]]">>
```

## Data Modeling

TiddlyWiki slices info into **smallest meaningful units** (tiddlers) connected by tags, fields, and links. Small pieces loosely joined.

### Tiddler Fields

| Field | Purpose |
|-------|---------|
| `title` | Unique ID (required) |
| `text` | Content body |
| `tags` | Space-separated; multi-word in `[[double brackets]]` |
| `type` | `text/vnd.tiddlywiki` or `text/markdown` |
| `created` / `modified` | Timestamps: `YYYYMMDDHHmmSSsss` |
| `creator` / `modifier` | User strings |
| `list` | Ordered title list (controls child display order) |
| `caption` | Display name (TOC, tabs) |
| `color` / `icon` | Visual presentation |

Custom fields are first-class — any field name works and is filterable.

### Tags as Structure

Tags replace folders. A tag is a reference to another tiddler (which can itself have content/tags).

- `[tag[Animals]tag[todo]]` = intersection (animal tasks)
- Tag tiddler's `list` field controls child order
- `list-before` / `list-after` on children for positioning
- Tag chains model hierarchy: `Animals → Rabbits → Infrastructure → tasks`

### Patterns

- **Tags as categories**: `[Rabbits SubProject todo]` — belongs to all three, queryable via intersections
- **Custom fields for attributes**: `grade: Poor`, `priority: Red`, `due: 20260301` — filterable with `field:name[value]`
- **Templates for consistent creation**: define template tiddler, reference with `$param`
- **Transclusion over duplication**: same text in two places → one transcludes the other

### Anti-Patterns

- **Monolithic tiddlers** — split by concern (goals ≠ tracking ≠ history)
- **Metadata in prose** — use fields for anything you'll filter on
- **Markdown + widgets** — markdown can't use `<$list>`, `{{transclusion}}`, etc. Use wikitext for interactive content
- **Flat tags** — use tag chains for hierarchy

## Query Patterns

### Common Queries

```bash
# Recent entries (metadata only — fast, single request)
tw wiki filter '[tag[Journal]!tag[agent-generated]!sort[modified]limit[10]]'

# Specific date (full content)
tw wiki get '2026-02-15'

# Month range with content
tw wiki filter '[tag[Journal]prefix[2025-11]sort[title]]' --text

# Full-text search with OR (multiple terms)
tw wiki filter '[search[bike]],[search[cycling]],[search[mtb]]' --text

# Open tasks
tw wiki filter '[tag[todo]!tag[done]!sort[modified]]'

# Tiddlers with specific field value
tw wiki filter '[field:grade[Poor]sort[title]]' --text

# Graph traversal
tw wiki filter '[[My Tiddler]backlinks[]]'        # what links to X?
tw wiki filter '[[My Tiddler]links[]]'             # what does X link to?
tw wiki filter '[[Animals]tagging[]]'              # children of a tag

# Count
tw wiki filter '[tag[Journal]prefix[2025]count[]]'
```

### Pagination for Large Results

```bash
# Step 1: survey (no --text, single request)
tw wiki filter '[tag[Journal]prefix[2024]sort[title]]' | jq 'length'

# Step 2: batch by month if large
tw wiki filter '[tag[Journal]prefix[2024-01]sort[title]]' --text
tw wiki filter '[tag[Journal]prefix[2024-02]sort[title]]' --text

# Or use jq to slice
tw wiki filter '[tag[Journal]prefix[2024]sort[title]]' --text | jq '.[0:25]'
```

### Semantic Search

Uses local embeddings (nomic-embed-text via Ollama, sqlite-vec). Best for conceptual queries where keywords are unpredictable.

- Natural phrases (5-10 words): `"feeling overwhelmed about work commitments"`
- Combine with `--filter` for precision: `--filter '[prefix[2024]]'`
- Start with `--limit 20` metadata, narrow to `--limit 5` with full text
- Falls back gracefully if Ollama unavailable
