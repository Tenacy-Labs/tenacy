/**
 * Semantic session memory — roadmap item (docs/design.md), jcode concept.
 *
 * Cross-session episodic memory backed by bun:sqlite. Keyword recall via FTS5
 * (BM25); an optional embedding hook blends cosine similarity when the host
 * provides one. The store is host-side by design (ops.* trust boundary):
 * the model reaches it through intents, never by holding the DB handle.
 *
 * Determinism note: FTS5 BM25 ordering is stable for a fixed corpus; ids are
 * integers so recall order is reproducible. No timestamps influence ranking.
 */
import { Database } from "bun:sqlite";

export type MemoryKind = "episodic" | "fact" | "skill" | "session" | "note";

export interface MemoryRow {
  id: number;
  kind: MemoryKind;
  text: string;
  meta: string | null;         // JSON object as stored
  session: string | null;      // originating session name, if any
  embedding: string | null;    // JSON number[] when an embedder ran
  created_at: number;
}

export interface RememberOptions {
  kind?: MemoryKind;
  meta?: Record<string, unknown>;
  session?: string;
}

export interface SearchHit {
  row: MemoryRow;
  /** Normalized score. FTS-only: descending synthetic (1.0 → 1/n). Blend: max of the two. */
  score: number;
  source: "fts" | "embedding" | "blend";
}

/** Optional host-provided embedder. Pure function text -> vector. */
export type EmbeddingFn = (text: string) => number[];

export interface MemoryStoreOptions {
  path?: string;               // file path; ":memory:" for in-process DB
  embedder?: EmbeddingFn;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class MemoryStore {
  readonly db: Database;
  readonly path: string;
  #embedder: EmbeddingFn | null;

  constructor(opts: MemoryStoreOptions = {}) {
    this.path = opts.path ?? ":memory:";
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.#embedder = opts.embedder ?? null;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        meta TEXT,
        session TEXT,
        embedding TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(text, content='memories', content_rowid='id');
    `);
  }

  setEmbedder(fn: EmbeddingFn | null): void { this.#embedder = fn; }

  remember(text: string, opts: RememberOptions = {}): MemoryRow {
    const kind = opts.kind ?? "episodic";
    const meta = opts.meta !== undefined ? JSON.stringify(opts.meta) : null;
    const embedding = this.#embedder !== null ? JSON.stringify(this.#embedder(text)) : null;
    this.db.query(
      "INSERT INTO memories (kind, text, meta, session, embedding, created_at) VALUES (?,?,?,?,?,?)",
    ).run(kind, text, meta, opts.session ?? null, embedding, Date.now());
    const id = Number((this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    this.db.query("INSERT INTO memories_fts (rowid, text) VALUES (?,?)").run(id, text);
    return this.get(id)!;
  }

  get(id: number): MemoryRow | undefined {
    return this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  }

  /** Keyword search via FTS5 BM25. Query is FTS5 syntax; empty → []. */
  searchFts(query: string, limit = 5, kind?: MemoryKind): SearchHit[] {
    const q = query.trim();
    if (q === "") return [];
    const sql = kind !== undefined
      ? "SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ? AND m.kind = ? ORDER BY f.rank LIMIT ?"
      : "SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ? ORDER BY f.rank LIMIT ?";
    const rows = (this.db.query(sql).all(
      ...(kind !== undefined ? [q, kind, limit] : [q, limit]),
    )) as MemoryRow[];
    // BM25 ordered already; expose descending synthetic scores for the blender.
    return rows.map((row, i) => ({ row, score: (rows.length - i) / rows.length, source: "fts" as const }));
  }

  /** Embedding search: cosine over stored vectors (skips rows without one). */
  searchEmbedding(query: string, limit = 5, kind?: MemoryKind): SearchHit[] {
    if (this.#embedder === null) return [];
    const q = this.#embedder(query);
    const rows = (kind !== undefined
      ? this.db.query("SELECT * FROM memories WHERE embedding IS NOT NULL AND kind = ?").all(kind)
      : this.db.query("SELECT * FROM memories WHERE embedding IS NOT NULL").all()
    ) as MemoryRow[];
    return rows
      .map((row) => ({ row, score: cosine(q, JSON.parse(row.embedding!) as number[]), source: "embedding" as const }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
      .slice(0, limit);
  }

  /**
   * Default recall: blend FTS + embedding when an embedder exists, FTS alone
   * otherwise. Blend keeps the best normalized score per row.
   */
  search(query: string, limit = 5, kind?: MemoryKind): SearchHit[] {
    const fts = this.searchFts(query, limit, kind);
    const emb = this.searchEmbedding(query, limit, kind);
    if (emb.length === 0) return fts;
    const byId = new Map<number, SearchHit>();
    for (const h of fts) byId.set(h.row.id, { ...h, source: "blend" });
    for (const h of emb) {
      const prev = byId.get(h.row.id);
      if (prev === undefined || h.score > prev.score) byId.set(h.row.id, { ...h, source: "blend" });
    }
    const out = [...byId.values()];
    out.sort((a, b) => b.score - a.score || a.row.id - b.row.id);
    return out.slice(0, limit);
  }

  count(): number {
    return Number((this.db.query("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n);
  }

  close(): void { this.db.close(); }
}
