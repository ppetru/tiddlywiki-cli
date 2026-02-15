# tiddlywiki-cli

CLI for TiddlyWiki's HTTP API — CRUD, diff, and semantic search.

Designed as an [agentskills.io](https://agentskills.io/) skill: AI agents learn TiddlyWiki filter syntax, wikitext, and data modeling patterns alongside the CLI.

## Install

Requires Node.js ≥ 20.

```bash
git clone https://github.com/ppetru/tiddlywiki-cli.git
```

For semantic search (optional):

```bash
cd tiddlywiki-cli && npm install
# Requires Ollama running with nomic-embed-text model
```

## Configure

Create `~/.config/tw/wikis.json`:

```json
{
  "mywiki": {
    "url": "http://localhost:8080"
  }
}
```

For Consul service discovery:

```json
{
  "mywiki": {
    "url": "mywiki.service.consul",
    "auth_header": "X-Custom-Auth",
    "auth_user": "username"
  }
}
```

Config search order: `./wikis.json` → `~/.config/tw/wikis.json` → `<install-dir>/wikis.json`

## Usage

```bash
# Query tiddlers (metadata only)
tw mywiki filter '[tag[Journal]!sort[modified]limit[10]]'

# Include full text
tw mywiki filter '[search[topic]]' --text

# Get single tiddler
tw mywiki get 'My Tiddler'

# Create/update tiddler
tw mywiki put 'New Tiddler' --text '# Hello' --tags 'Tag1 Tag2'
tw mywiki put 'New Tiddler' --file ./content.md --type text/markdown

# Diff before writing
tw mywiki diff 'Existing Tiddler' --text 'Updated content'
tw mywiki put 'Existing Tiddler' --text 'Updated content'

# Delete
tw mywiki delete 'Old Tiddler'

# Semantic search (requires optional deps + Ollama)
tw mywiki semantic 'conceptual query here' --limit 10
tw mywiki reindex --force

# Wiki status
tw mywiki status
```

Output is JSON — pipe to `jq` for processing:

```bash
tw mywiki filter '[tag[Plants]]' --text | jq '.[].title'
```

## Agent Skill

When installed, agents get:
- CLI tool reference
- TiddlyWiki filter syntax and operators
- Wikitext and widget reference
- Data modeling patterns and anti-patterns
- Common query recipes

See [SKILL.md](SKILL.md) for the full skill content.

## License

MIT
