// ABOUTME: Semantic search via local embeddings — optional deps, graceful fallback
// ABOUTME: Uses better-sqlite3 + sqlite-vec + Ollama (nomic-embed-text)

import { promises as dns } from "node:dns";

// ── Dynamic Imports (fail gracefully) ───────────────────────────────────────

let Database, sqliteVec, encode;

async function loadDeps() {
  try {
    const bsq = await import("better-sqlite3");
    Database = bsq.default;
  } catch {
    throw new Error(
      "better-sqlite3 not installed. Run: cd " +
        import.meta.dirname +
        "/.. && npm install"
    );
  }

  try {
    const sv = await import("sqlite-vec");
    sqliteVec = sv;
  } catch {
    throw new Error(
      "sqlite-vec not installed. Run: cd " +
        import.meta.dirname +
        "/.. && npm install"
    );
  }

  try {
    const tok = await import("gpt-tokenizer");
    encode = tok.encode;
  } catch {
    throw new Error(
      "gpt-tokenizer not installed. Run: cd " +
        import.meta.dirname +
        "/.. && npm install"
    );
  }
}

// ── Ollama Client ───────────────────────────────────────────────────────────

const TIMEOUT_EMBED = 120_000;
const TIMEOUT_HEALTH = 10_000;
const DNS_TIMEOUT = 10_000;

async function fetchTimeout(url, opts, ms, label) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } catch (err) {
    if (err.name === "AbortError")
      throw new Error(`${label} timed out after ${ms}ms`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function resolveOllamaUrl(urlOrService) {
  if (
    urlOrService.startsWith("http://") ||
    urlOrService.startsWith("https://")
  ) {
    return urlOrService.replace(/\/$/, "");
  }

  if (urlOrService.includes(".service.consul")) {
    const srvRecords = await Promise.race([
      dns.resolveSrv(urlOrService),
      new Promise((_, r) =>
        setTimeout(() => r(new Error("DNS SRV timeout")), DNS_TIMEOUT)
      ),
    ]);
    if (!srvRecords?.length)
      throw new Error(`No SRV records for ${urlOrService}`);
    const srv = srvRecords[0];
    let host = srv.name;
    try {
      const addrs = await dns.resolve4(srv.name);
      if (addrs[0]) host = addrs[0];
    } catch {
      /* use hostname */
    }
    return `http://${host}:${srv.port}`;
  }

  return `http://${urlOrService}`;
}

async function ollamaHealth(baseUrl) {
  try {
    const res = await fetchTimeout(baseUrl, {}, TIMEOUT_HEALTH, "health");
    return res.ok;
  } catch {
    return false;
  }
}

async function ollamaEmbed(baseUrl, model, texts) {
  const res = await fetchTimeout(
    `${baseUrl}/api/embed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    },
    TIMEOUT_EMBED,
    `embed(${texts.length} texts)`
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama embed failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.embeddings;
}

// ── Text Chunking ───────────────────────────────────────────────────────────

function chunkText(text, maxTokens = 6000) {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const paraTokens = encode(para);
    const test = current ? `${current}\n\n${para}` : para;
    const testCount = encode(test).length;

    if (testCount > maxTokens && current) {
      chunks.push(current.trim());
      current = para;
    } else if (paraTokens.length > maxTokens) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      // Split oversized paragraph by sentences
      const sentences = para.split(/[.!?]+\s+/);
      let sentChunk = "";
      for (const s of sentences) {
        const full = s + (s.match(/[.!?]$/) ? "" : ".");
        const test2 = sentChunk ? `${sentChunk} ${full}` : full;
        if (encode(test2).length > maxTokens && sentChunk) {
          chunks.push(sentChunk.trim());
          sentChunk = full;
        } else {
          sentChunk = test2;
        }
      }
      if (sentChunk) current = sentChunk;
    } else {
      current = test;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

// ── Database ────────────────────────────────────────────────────────────────

const MISSING_TIMESTAMP = "00000000000000000";

function openDb(dbPath) {
  const db = new Database(dbPath);
  sqliteVec.load(db);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entry_embeddings USING vec0(
      embedding float[768]
    );

    CREATE TABLE IF NOT EXISTS embedding_metadata (
      id INTEGER PRIMARY KEY,
      tiddler_title TEXT NOT NULL,
      chunk_id NOT NULL,
      chunk_text TEXT NOT NULL,
      created TEXT,
      modified TEXT,
      tags TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_status (
      tiddler_title TEXT PRIMARY KEY,
      last_modified TEXT NOT NULL,
      last_indexed TEXT NOT NULL,
      total_chunks INTEGER NOT NULL DEFAULT 1,
      indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'indexed',
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_status_modified
      ON sync_status(last_modified);
    CREATE INDEX IF NOT EXISTS idx_embedding_metadata_tiddler
      ON embedding_metadata(tiddler_title);
  `);

  // Migration: empty timestamps → sentinel
  db.prepare(
    `UPDATE sync_status SET last_modified = ? WHERE last_modified = ''`
  ).run(MISSING_TIMESTAMP);

  return db;
}

function dbInsertEmbedding(db, title, chunkId, embedding, chunkText, meta) {
  const buf = Buffer.from(new Float32Array(embedding).buffer);

  const embResult = db
    .prepare(`INSERT INTO entry_embeddings(rowid, embedding) VALUES (NULL, ?)`)
    .run(buf);
  const rowid = embResult.lastInsertRowid;

  db.prepare(
    `INSERT INTO embedding_metadata(id, tiddler_title, chunk_id, chunk_text, created, modified, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(rowid, title, chunkId, chunkText, meta.created, meta.modified, meta.tags);
}

function dbSearch(db, queryEmbedding, limit) {
  const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
  return db
    .prepare(
      `SELECT m.tiddler_title, m.chunk_id, m.chunk_text, m.created, m.modified, m.tags, e.distance
       FROM entry_embeddings e
       JOIN embedding_metadata m ON e.rowid = m.id
       WHERE e.embedding MATCH ? AND k = ?`
    )
    .all(buf, limit);
}

function dbDeleteTiddler(db, title) {
  const rows = db
    .prepare(`SELECT id FROM embedding_metadata WHERE tiddler_title = ?`)
    .all(title);
  db.prepare(`DELETE FROM embedding_metadata WHERE tiddler_title = ?`).run(
    title
  );
  const del = db.prepare(`DELETE FROM entry_embeddings WHERE rowid = ?`);
  for (const r of rows) del.run(r.id);
  db.prepare(`DELETE FROM sync_status WHERE tiddler_title = ?`).run(title);
}

function dbUpdateSync(db, title, lastModified, totalChunks, status, errorMsg) {
  db.prepare(
    `INSERT OR REPLACE INTO sync_status(tiddler_title, last_modified, last_indexed, total_chunks, status, error_message)
     VALUES (?, ?, datetime('now'), ?, ?, ?)`
  ).run(title, lastModified, totalChunks, status, errorMsg);
}

function dbGetSync(db, title) {
  return db
    .prepare(
      `SELECT tiddler_title, last_modified, last_indexed, total_chunks, status, error_message
       FROM sync_status WHERE tiddler_title = ?`
    )
    .get(title);
}

function dbStats(db) {
  const embeddings =
    db.prepare(`SELECT COUNT(*) as c FROM entry_embeddings`).get()?.c ?? 0;
  const indexed =
    db.prepare(`SELECT COUNT(*) as c FROM sync_status`).get()?.c ?? 0;
  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) as c FROM sync_status GROUP BY status`
    )
    .all();
  return { embeddings, indexed, byStatus };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search for tiddlers semantically similar to a query string.
 *
 * @param {object} opts
 * @param {string} opts.query - Natural language query
 * @param {string} opts.dbPath - Path to embeddings SQLite DB
 * @param {string} opts.ollamaUrl - Ollama URL or Consul service name
 * @param {string} [opts.model] - Embedding model (default: nomic-embed-text)
 * @param {number} [opts.limit] - Max results (default: 10)
 * @returns {Promise<object[]>} Search results with distance scores
 */
export async function search({
  query,
  dbPath,
  ollamaUrl,
  model = "nomic-embed-text",
  limit = 10,
}) {
  await loadDeps();

  const baseUrl = await resolveOllamaUrl(ollamaUrl);
  if (!(await ollamaHealth(baseUrl))) {
    throw new Error(`Ollama not reachable at ${baseUrl}`);
  }

  const db = openDb(dbPath);
  try {
    const [qEmb] = await ollamaEmbed(baseUrl, model, [
      `search_query: ${query}`,
    ]);
    const results = dbSearch(db, qEmb, limit);

    // Deduplicate by tiddler title (keep best match per tiddler)
    const seen = new Map();
    for (const r of results) {
      if (!seen.has(r.tiddler_title) || r.distance < seen.get(r.tiddler_title).distance) {
        seen.set(r.tiddler_title, r);
      }
    }
    return [...seen.values()];
  } finally {
    db.close();
  }
}

/**
 * Reindex tiddlers — incremental by default, full with force.
 *
 * @param {object} opts
 * @param {string} opts.dbPath - Path to embeddings SQLite DB
 * @param {string} opts.ollamaUrl - Ollama URL or Consul service name
 * @param {string} [opts.model] - Embedding model
 * @param {boolean} [opts.force] - Re-embed everything
 * @param {boolean} [opts.statusOnly] - Just return stats, don't reindex
 * @param {function} opts.fetchFilter - async (filter, includeText) => tiddler[]
 * @param {function} opts.fetchTiddler - async (title) => tiddler|null
 * @param {function} [opts.onProgress] - (msg) => void
 * @returns {Promise<object>} Stats about what was done
 */
export async function reindex({
  dbPath,
  ollamaUrl,
  model = "nomic-embed-text",
  force = false,
  statusOnly = false,
  fetchFilter,
  fetchTiddler,
  onProgress = () => {},
}) {
  await loadDeps();

  const db = openDb(dbPath);

  try {
    const stats = dbStats(db);

    if (statusOnly) {
      return {
        action: "status",
        ...stats,
      };
    }

    const baseUrl = await resolveOllamaUrl(ollamaUrl);
    if (!(await ollamaHealth(baseUrl))) {
      throw new Error(`Ollama not reachable at ${baseUrl}`);
    }

    // Phase 1: Get all non-system tiddlers (metadata only)
    onProgress("Fetching tiddler list...");
    const allTiddlers = await fetchFilter("[!is[system]sort[title]]", false);

    // Filter out filesystem paths (un-imported .tid files)
    const validTiddlers = allTiddlers.filter(
      (t) => !t.title.startsWith("/") && !t.title.includes(".tid")
    );
    onProgress(`Found ${validTiddlers.length} tiddlers`);

    // Phase 2: Determine what needs indexing
    const toIndex = [];
    const validTitles = new Set(validTiddlers.map((t) => t.title));

    if (force) {
      toIndex.push(...validTiddlers);
      onProgress(`Force mode: re-indexing all ${toIndex.length} tiddlers`);
    } else {
      for (const t of validTiddlers) {
        const sync = dbGetSync(db, t.title);
        const mod = t.modified || MISSING_TIMESTAMP;

        if (!sync) {
          toIndex.push(t);
        } else if (sync.last_modified !== mod) {
          toIndex.push(t);
        } else if (sync.status === "error") {
          // Retry errors after 24h
          const elapsed =
            Date.now() - new Date(sync.last_indexed).getTime();
          if (elapsed > 24 * 60 * 60 * 1000) toIndex.push(t);
        }
      }
      onProgress(`${toIndex.length} tiddlers need indexing`);
    }

    // Phase 3: Delete reconciliation — remove DB entries for deleted tiddlers
    const allSynced = db
      .prepare(`SELECT tiddler_title FROM sync_status`)
      .all()
      .map((r) => r.tiddler_title);
    let deleted = 0;
    for (const title of allSynced) {
      if (!validTitles.has(title)) {
        dbDeleteTiddler(db, title);
        deleted++;
      }
    }
    if (deleted > 0) onProgress(`Removed ${deleted} deleted tiddlers from index`);

    // Phase 4: Index tiddlers in batches
    const result = { indexed: 0, empty: 0, errors: 0, deleted, skipped: 0 };
    const BATCH = 5;

    for (let i = 0; i < toIndex.length; i += BATCH) {
      const batch = toIndex.slice(i, i + BATCH);

      await Promise.all(
        batch.map(async (meta) => {
          try {
            const full = await fetchTiddler(meta.title);
            if (!full || !full.text) {
              dbUpdateSync(
                db,
                meta.title,
                meta.modified || MISSING_TIMESTAMP,
                0,
                "empty",
                null
              );
              result.empty++;
              return;
            }

            // Delete old embeddings first
            dbDeleteTiddler(db, meta.title);

            const chunks = chunkText(full.text);
            const prefixed = chunks.map((c) => `search_document: ${c}`);
            const embeddings = await ollamaEmbed(baseUrl, model, prefixed);

            for (let j = 0; j < chunks.length; j++) {
              dbInsertEmbedding(db, full.title, j, embeddings[j], chunks[j], {
                created: full.created || "",
                modified: full.modified || "",
                tags: full.tags || "",
              });
            }

            dbUpdateSync(
              db,
              full.title,
              full.modified || MISSING_TIMESTAMP,
              chunks.length,
              "indexed",
              null
            );
            result.indexed++;
          } catch (err) {
            dbUpdateSync(
              db,
              meta.title,
              meta.modified || MISSING_TIMESTAMP,
              0,
              "error",
              err.message
            );
            result.errors++;
          }
        })
      );

      const done = Math.min(i + BATCH, toIndex.length);
      onProgress(`Progress: ${done}/${toIndex.length}`);
    }

    const final = dbStats(db);
    return {
      action: "reindex",
      newly_indexed: result.indexed,
      empty: result.empty,
      errors: result.errors,
      deleted: result.deleted,
      total_indexed: final.indexed,
      total_embeddings: final.embeddings,
      byStatus: final.byStatus,
    };
  } finally {
    db.close();
  }
}

/**
 * Get embeddings stats for a wiki.
 */
export async function status({ dbPath }) {
  await loadDeps();
  const db = openDb(dbPath);
  try {
    return dbStats(db);
  } finally {
    db.close();
  }
}
