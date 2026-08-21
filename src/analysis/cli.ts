/**
 * Analysis CLI — ADR-0003 offline mirror entry point.
 *
 *   bun src/analysis/cli.ts corpus <ledger.jsonl...>   — corpus card
 *   bun src/analysis/cli.ts reports <ledger.jsonl...>  — all six reports
 *   bun src/analysis/cli.ts refit <ledger.jsonl...>    — refit diagnostics
 *   bun src/analysis/cli.ts synthetic                  — synthetic generator validation
 */
import { loadCorpus } from "../optimizer/corpus.ts";
import { reportValueForecast, reportHazard, reportRot, reportDecision } from "../optimizer/reports.ts";
import { reportCacheBelief, reportCostVsBaselines } from "../optimizer/replay.ts";
import { refitMuAlpha } from "../optimizer/refit.ts";
import { generateSynthetic, DEFAULT_SPEC } from "../optimizer/synthetic.ts";
import { paramSetV1 } from "../optimizer/params.ts";

const cmd = process.argv[2];
const args = process.argv.slice(3);

switch (cmd) {
  case "corpus": {
    if (args.length === 0) { console.error("usage: cli.ts corpus <ledger.jsonl...>"); process.exit(1); }
    const c = await loadCorpus(args);
    console.log(JSON.stringify(cardOf(c), null, 2));
    break;
  }
  case "reports": {
    if (args.length === 0) { console.error("usage: cli.ts reports <ledger.jsonl...>"); process.exit(1); }
    const c = await loadCorpus(args);
    console.log(JSON.stringify({
      r1_cache: reportCacheBelief(c.caches),
      r2_value: reportValueForecast(c),
      r3_hazard: reportHazard(c),
      r4_rot: reportRot(c),
      r5_decision: reportDecision(c),
      r6_cost: reportCostVsBaselines(c.caches, paramSetV1(c.modelIds[0] ?? "default")),
    }, null, 2));
    break;
  }
  case "refit": {
    if (args.length === 0) { console.error("usage: cli.ts refit <ledger.jsonl...>"); process.exit(1); }
    const c = await loadCorpus(args);
    console.log(JSON.stringify(refitMuAlpha(c), null, 2));
    break;
  }
  case "synthetic": {
    const { corpus, truth } = generateSynthetic(DEFAULT_SPEC);
    console.log("planted:", JSON.stringify(truth));
    const r3 = reportHazard(corpus);
    console.log("hazard report:", JSON.stringify(r3.byBasis, null, 2));
    break;
  }
  default:
    console.error("commands: corpus | reports | refit | synthetic");
    process.exit(1);
}

function cardOf(c: Awaited<ReturnType<typeof loadCorpus>>) {
  return c; // corpus card via reports; direct corpus dump for v1
}
