#!/usr/bin/env node
// ABOUTME: CLI for TiddlyWiki HTTP API
// ABOUTME: Zero-dependency CRUD, diff, and status. Semantic search via optional deps.

import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "./lib/diff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TIMEOUT_READ = 30_000;
const TIMEOUT_WRITE = 60_000;
const DNS_TIMEOUT = 10_000;

// ── Config ──────────────────────────────────────────────────────────────────

async function loadConfig() {
  const searchPaths = [
    resolve(process.cwd(), "wikis.json"),
    resolve(homedir(), ".config", "tw", "wikis.json"),
    resolve(__dirname, "wikis.json"),
  ];

  for (const p of searchPaths) {
    try {
      const raw = await readFile(p, "utf-8");
      return JSON.parse(raw);
    } catch {
      // not found, try next
    }
  }

  die("No wikis.json found. Searched:\n  " + searchPaths.join("\n  "));
}

function getWikiConfig(config, name) {
  const wiki = config[name];
  if (!wiki) {
    const available = Object.keys(config)
      .filter((k) => k !== "ollama_url")
      .join(", ");
    die(`Unknown wiki "${name}". Available: ${available}`);
  }
  // Attach top-level ollama_url so subcommands can access it
  wiki.__ollamaUrl = config.ollama_url || "http://localhost:11434";
  return wiki;
}

// ── Service Discovery ───────────────────────────────────────────────────────

async function withTimeout(promise, ms, msg) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(msg)), ms)
  );
  return Promise.race([promise, timeout]);
}

async function resolveConsulService(serviceName) {
  const srvRecords = await withTimeout(
    dns.resolveSrv(serviceName),
    DNS_TIMEOUT,
    `DNS SRV resolution timed out for ${serviceName}`
  );

  if (!srvRecords?.length) {
    throw new Error(`No SRV records found for ${serviceName}`);
  }

  const srv = srvRecords[0];
  try {
    const addresses = await withTimeout(
      dns.resolve4(srv.name),
      DNS_TIMEOUT,
      `DNS A record resolution timed out for ${srv.name}`
    );
    return { host: addresses[0] || srv.name, port: srv.port };
  } catch {
    return { host: srv.name, port: srv.port };
  }
}

async function resolveBaseUrl(urlOrService) {
  if (urlOrService.startsWith("http://") || urlOrService.startsWith("https://")) {
    return urlOrService.replace(/\/$/, "");
  }

  if (urlOrService.includes(".service.consul")) {
    const { host, port } = await resolveConsulService(urlOrService);
    return `http://${host}:${port}`;
  }

  return `http://${urlOrService}`;
}

// ── HTTP Client ─────────────────────────────────────────────────────────────

function authHeaders(wiki) {
  const headers = {};
  if (wiki.auth_header && wiki.auth_user) {
    headers[wiki.auth_header] = wiki.auth_user;
  }
  return headers;
}

function writeHeaders(wiki) {
  return {
    ...authHeaders(wiki),
    "Content-Type": "application/json",
    "x-requested-with": "TiddlyWiki",
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function apiFilter(baseUrl, wiki, filter, includeText) {
  const url = `${baseUrl}/recipes/default/tiddlers.json?filter=${encodeURIComponent(filter)}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(wiki) }, TIMEOUT_READ);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`Filter query failed: ${res.status} ${res.statusText}${body ? " — " + body : ""}`);
  }

  let tiddlers = await res.json();

  if (includeText && tiddlers.length > 0) {
    // API excludes text by default; fetch each tiddler individually
    const results = await Promise.allSettled(
      tiddlers.map((t) => apiGet(baseUrl, wiki, t.title))
    );
    tiddlers = results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);
  }

  return tiddlers;
}

async function apiGet(baseUrl, wiki, title) {
  const url = `${baseUrl}/recipes/default/tiddlers/${encodeURIComponent(title)}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(wiki) }, TIMEOUT_READ);

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`GET "${title}" failed: ${res.status} ${res.statusText}${body ? " — " + body : ""}`);
  }

  return await res.json();
}

async function apiPut(baseUrl, wiki, tiddler) {
  const url = `${baseUrl}/recipes/default/tiddlers/${encodeURIComponent(tiddler.title)}`;
  const { revision, bag, ...fields } = tiddler;
  const res = await fetchWithTimeout(
    url,
    { method: "PUT", headers: writeHeaders(wiki), body: JSON.stringify(fields) },
    TIMEOUT_WRITE
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`PUT "${tiddler.title}" failed: ${res.status} ${res.statusText}${body ? " — " + body : ""}`);
  }
}

async function apiDelete(baseUrl, wiki, title) {
  const url = `${baseUrl}/bags/default/tiddlers/${encodeURIComponent(title)}`;
  const res = await fetchWithTimeout(
    url,
    { method: "DELETE", headers: writeHeaders(wiki) },
    TIMEOUT_WRITE
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`DELETE "${title}" failed: ${res.status} ${res.statusText}${body ? " — " + body : ""}`);
  }
}

// ── TiddlyWiki Helpers ──────────────────────────────────────────────────────

function twTimestamp(date = new Date()) {
  const p = (n, w = 2) => n.toString().padStart(w, "0");
  return (
    date.getUTCFullYear().toString() +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    p(date.getUTCMilliseconds(), 3)
  );
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function cmdFilter(baseUrl, wiki, args) {
  const filter = args[0];
  if (!filter) die("Usage: tw <wiki> filter '<expression>' [--text]");

  const includeText = args.includes("--text");
  const tiddlers = await apiFilter(baseUrl, wiki, filter, includeText);
  out(tiddlers);
}

async function cmdGet(baseUrl, wiki, args) {
  const title = args[0];
  if (!title) die("Usage: tw <wiki> get '<title>'");

  const tiddler = await apiGet(baseUrl, wiki, title);
  if (tiddler === null) die(`Tiddler "${title}" not found`, 1);
  out(tiddler);
}

async function cmdPut(baseUrl, wiki, wikiConfig, args) {
  const title = args[0];
  if (!title) die("Usage: tw <wiki> put '<title>' --text '<content>' | --file <path> [--tags '<tags>'] [--type <type>] [--field key=value ...]");

  const opts = parseOpts(args.slice(1));
  let text = opts.text;

  if (opts.file) {
    try {
      text = await readFile(opts.file, "utf-8");
    } catch (err) {
      die(`Cannot read file "${opts.file}": ${err.message}`);
    }
  }

  if (text === undefined) die("--text or --file is required");

  // Check if tiddler exists (for update vs create)
  const existing = await apiGet(baseUrl, wikiConfig, title);
  const now = twTimestamp();
  const modifier = wikiConfig.auth_user || "tw-cli";

  let tiddler;
  if (existing) {
    // Update: preserve existing fields, overlay new ones
    tiddler = { ...existing };
    tiddler.text = text;
    tiddler.modified = now;
    tiddler.modifier = modifier;
    if (opts.tags !== undefined) tiddler.tags = opts.tags;
    if (opts.type !== undefined) tiddler.type = opts.type;
    for (const [k, v] of Object.entries(opts.fields)) {
      tiddler[k] = v;
    }
  } else {
    // Create: new tiddler with defaults
    tiddler = {
      title,
      text,
      type: opts.type || "text/markdown",
      tags: opts.tags || "",
      created: now,
      creator: modifier,
      modified: now,
      modifier,
    };
    for (const [k, v] of Object.entries(opts.fields)) {
      tiddler[k] = v;
    }
  }

  await apiPut(baseUrl, wikiConfig, tiddler);
  out({ ok: true, title, action: existing ? "updated" : "created" });
}

async function cmdDiff(baseUrl, wiki, args) {
  const title = args[0];
  if (!title) die("Usage: tw <wiki> diff '<title>' --text '<content>' | --file <path>");

  const opts = parseOpts(args.slice(1));
  let newText = opts.text;

  if (opts.file) {
    try {
      newText = await readFile(opts.file, "utf-8");
    } catch (err) {
      die(`Cannot read file "${opts.file}": ${err.message}`);
    }
  }

  if (newText === undefined) die("--text or --file is required");

  const existing = await apiGet(baseUrl, wiki, title);
  if (existing === null) {
    // New tiddler — show as all additions
    process.stdout.write(createTwoFilesPatch(title, title, "", newText));
    return;
  }

  const oldText = existing.text || "";
  if (oldText === newText) {
    process.stderr.write("No changes\n");
    return;
  }

  process.stdout.write(createTwoFilesPatch(title, title, oldText, newText));
}

async function cmdDelete(baseUrl, wiki, args) {
  const title = args[0];
  if (!title) die("Usage: tw <wiki> delete '<title>'");

  await apiDelete(baseUrl, wiki, title);
  out({ ok: true, title, action: "deleted" });
}

async function loadSemantic() {
  try {
    return await import("./lib/semantic.js");
  } catch (err) {
    if (err.message?.includes("not installed")) die(err.message);
    die(
      `Semantic search requires optional dependencies.\nRun: cd ${__dirname} && npm install\n\n${err.message}`
    );
  }
}

function requireEmbeddingsDb(wikiConfig, wikiName) {
  if (!wikiConfig.embeddings_db) {
    die(
      `No embeddings_db configured for wiki "${wikiName}".\nAdd "embeddings_db": "/path/to/wiki.db" to wikis.json`
    );
  }
  return wikiConfig.embeddings_db;
}

function getOllamaUrl(config) {
  return config.__ollamaUrl || "http://localhost:11434";
}

async function cmdSemantic(baseUrl, wikiName, wikiConfig, args) {
  const query = args[0];
  if (!query) die("Usage: tw <wiki> semantic '<query>' [--filter '<pre-filter>'] [--limit N]");

  const opts = parseOpts(args.slice(1));
  const limit = opts.fields.limit ? parseInt(opts.fields.limit, 10) : 10;
  const dbPath = requireEmbeddingsDb(wikiConfig, wikiName);
  const ollamaUrl = getOllamaUrl(wikiConfig);

  const sem = await loadSemantic();

  // If --filter provided, first fetch matching titles, then search within those
  // For now, semantic search covers the whole index; --filter is future work
  // (would need per-search DB filtering by title list)

  const results = await sem.search({
    query,
    dbPath,
    ollamaUrl,
    limit,
  });

  out(results);
}

async function cmdReindex(baseUrl, wikiName, wikiConfig, args) {
  const force = args.includes("--force");
  const statusOnly = args.includes("--status");
  const dbPath = requireEmbeddingsDb(wikiConfig, wikiName);
  const ollamaUrl = getOllamaUrl(wikiConfig);

  const sem = await loadSemantic();

  const result = await sem.reindex({
    dbPath,
    ollamaUrl,
    force,
    statusOnly,
    fetchFilter: (filter, includeText) => apiFilter(baseUrl, wikiConfig, filter, includeText),
    fetchTiddler: (title) => apiGet(baseUrl, wikiConfig, title),
    onProgress: (msg) => process.stderr.write(msg + "\n"),
  });

  out(result);
}

async function cmdStatus(baseUrl, wiki, wikiConfig) {
  try {
    // Quick reachability check + count (metadata only, no text)
    const all = await apiFilter(baseUrl, wikiConfig, "[!is[system]]", false);
    const count = all.length;

    // Most recently modified (sort client-side since we already have the data)
    all.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
    const lastModified = all[0]?.modified || "unknown";

    const info = {
      wiki,
      url: wikiConfig.url,
      reachable: true,
      tiddler_count: count,
      last_modified: lastModified,
    };

    // Check embeddings if configured
    if (wikiConfig.embeddings_db) {
      info.embeddings_db = wikiConfig.embeddings_db;
      try {
        await readFile(wikiConfig.embeddings_db);
        info.embeddings_available = true;
        // Try to get detailed stats if deps available
        try {
          const sem = await import("./lib/semantic.js");
          info.embeddings = await sem.status({ dbPath: wikiConfig.embeddings_db });
        } catch {
          // Optional deps not installed — that's fine
        }
      } catch {
        info.embeddings_available = false;
      }
    }

    out(info);
  } catch (err) {
    out({ wiki, url: wikiConfig.url, reachable: false, error: err.message });
  }
}

// ── Arg Parsing ─────────────────────────────────────────────────────────────

function parseOpts(args) {
  const opts = { text: undefined, file: undefined, tags: undefined, type: undefined, fields: {} };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--text" && i + 1 < args.length) {
      opts.text = args[++i];
    } else if (arg === "--file" && i + 1 < args.length) {
      opts.file = args[++i];
    } else if (arg === "--tags" && i + 1 < args.length) {
      opts.tags = args[++i];
    } else if (arg === "--type" && i + 1 < args.length) {
      opts.type = args[++i];
    } else if (arg === "--field" && i + 1 < args.length) {
      const kv = args[++i];
      const eq = kv.indexOf("=");
      if (eq === -1) die(`--field value must be key=value, got: ${kv}`);
      opts.fields[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }

  return opts;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

// ── Main ────────────────────────────────────────────────────────────────────

const USAGE = `Usage: tw <wiki> <command> [args...]

Commands:
  filter '<expression>' [--text]       Query tiddlers via filter
  get '<title>'                        Get a single tiddler
  put '<title>' --text '...' | --file <path>
      [--tags '<tags>'] [--type <type>] [--field key=value ...]
  diff '<title>' --text '...' | --file <path>
  delete '<title>'
  semantic '<query>' [--limit N]       Semantic search (requires npm install)
  reindex [--force] [--status]         Update embeddings index
  status

Wiki names come from wikis.json (searched: ./wikis.json, ~/.config/tw/wikis.json, <skill-dir>/wikis.json)`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(USAGE + "\n");
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  const wikiName = args[0];
  const command = args[1];
  const rest = args.slice(2);

  const config = await loadConfig();
  const wikiConfig = getWikiConfig(config, wikiName);

  let baseUrl;
  try {
    baseUrl = await resolveBaseUrl(wikiConfig.url);
  } catch (err) {
    die(`Cannot resolve wiki "${wikiName}" (${wikiConfig.url}): ${err.message}`);
  }

  switch (command) {
    case "filter":
      await cmdFilter(baseUrl, wikiConfig, rest);
      break;
    case "get":
      await cmdGet(baseUrl, wikiConfig, rest);
      break;
    case "put":
      await cmdPut(baseUrl, wikiConfig, wikiConfig, rest);
      break;
    case "diff":
      await cmdDiff(baseUrl, wikiConfig, rest);
      break;
    case "delete":
      await cmdDelete(baseUrl, wikiConfig, rest);
      break;
    case "status":
      await cmdStatus(baseUrl, wikiName, wikiConfig);
      break;
    case "semantic":
      await cmdSemantic(baseUrl, wikiName, wikiConfig, rest);
      break;
    case "reindex":
      await cmdReindex(baseUrl, wikiName, wikiConfig, rest);
      break;
    default:
      die(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

main().catch((err) => {
  die(err.message);
});
