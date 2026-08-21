/**
 * Corpus loader + provenance separation — ADR-0003 §1, §7.
 *
 * The offline mirror reads the ledger; reports draw on realized/replayed/
 * synthetic classes and SAY which. Synthetic sessions live in a separate
 * partition, never silently merged with real traffic.
 */
import { readFile } from "node:fs/promises";
import type { CacheLedger, ItemLedger, TurnLedger } from "./types.ts";

export type Provenance = "realized" | "synthetic";

export interface Corpus {
  turns: TurnLedger[];
  items: ItemLedger[];
  caches: CacheLedger[];
  provenance: Provenance;
  sources: string[];
  parameterSetVersions: string[];
  modelIds: string[];
}

export async function loadCorpus(paths: string[], provenance: Provenance = "realized"): Promise<Corpus> {
  const turns: TurnLedger[] = [];
  const items: ItemLedger[] = [];
  const caches: CacheLedger[] = [];
  for (const path of paths) {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.t === "turn") turns.push(rec as unknown as TurnLedger);
      else if (rec.t === "item") items.push(rec as unknown as ItemLedger);
      else if (rec.t === "cache") caches.push(rec as unknown as CacheLedger);
    }
  }
  const versions = [...new Set(turns.map((t) => t.parameterSetVersion))];
  const models = [...new Set(turns.map((t) => t.modelId))];
  return { turns, items, caches, provenance, sources: [...paths], parameterSetVersions: versions, modelIds: models };
}

/** Every report emits a corpus card (0003 §3): coverage + missing labels + param versions. */
export function corpusCard(corpus: Corpus): CorpusCard {
  const kinds = new Set<string>();
  let unreported = 0;
  for (const c of corpus.caches) {
    if (c.divergence === "unreported") unreported += 1;
  }
  for (const t of corpus.turns) for (const e of t.layout) {
    if (e.id.startsWith("lens:")) kinds.add("lens");
    else if (e.id.startsWith("goal")) kinds.add("goal");
    else if (e.id.startsWith("err")) kinds.add("error");
    else if (e.id.startsWith("turn-")) kinds.add("episodic");
    else kinds.add("standing");
  }
  return {
    provenance: corpus.provenance,
    sessions: corpus.sources.length,
    turns: corpus.turns.length,
    items: corpus.items.length,
    cacheRecords: corpus.caches.length,
    kinds: Array.from(kinds),
    unreportedShare: corpus.caches.length > 0 ? unreported / corpus.caches.length : null,
    parameterSetVersions: corpus.parameterSetVersions,
    modelIds: corpus.modelIds,
  };
}

export interface CorpusCard {
  provenance: Provenance;
  sessions: number;
  turns: number;
  items: number;
  cacheRecords: number;
  kinds: string[];
  unreportedShare: number | null;
  parameterSetVersions: string[];
  modelIds: string[];
}
