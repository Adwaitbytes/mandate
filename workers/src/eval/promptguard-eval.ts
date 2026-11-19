import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { keccakUtf8 } from "../canonical.ts";
import { loadSecretsFile, requireEnv } from "../config.ts";
import { PROMPT_GUARD_THRESHOLD_BPS, PromptGuard } from "../promptguard.ts";
import { injectionText, loadInjectionSamples } from "./injections.ts";
import { EVAL_DIR, loadDataset, proposalText } from "./shared.ts";

export interface GuardScore {
  textHash: string;
  modelId: string;
  scoreBps: number;
  windows: number;
}

export const guardCachePath = (textHash: string): string =>
  join(EVAL_DIR, "cache", "promptguard", `${textHash.slice(2, 18)}.json`);

export async function readGuard(textHash: string): Promise<GuardScore | undefined> {
  try {
    const g = JSON.parse(await readFile(guardCachePath(textHash), "utf8")) as GuardScore;
    return g.textHash === textHash ? g : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Scores the 72 real proposals (treated as clean) and the 16 injection samples with Prompt Guard, caches each
 * score, and writes the calibration table: for each threshold, false positives on clean text and detections on
 * injections. The chosen threshold is the lowest one with zero false positives on the clean set.
 */
async function main(): Promise<void> {
  loadSecretsFile();
  const guard = new PromptGuard(requireEnv("GROQ_API_KEY"));
  const dataset = await loadDataset();
  const samples = await loadInjectionSamples();
  const items = [
    ...dataset.proposals.map((p) => ({
      kind: "clean" as const,
      id: `${p.dao}:${p.proposalId.slice(0, 12)}`,
      text: proposalText(p),
    })),
    ...samples.map((s, i) => ({ kind: "injection" as const, id: s.id, text: injectionText(s, i) })),
  ];
  const scored: Array<{ kind: "clean" | "injection"; id: string; scoreBps: number }> = [];
  for (const item of items) {
    const textHash = keccakUtf8(item.text);
    let g = await readGuard(textHash);
    if (g === undefined) {
      const r = await guard.score(item.text);
      g = { textHash, modelId: r.modelId, scoreBps: r.scoreBps, windows: r.windows };
      await mkdir(dirname(guardCachePath(textHash)), { recursive: true });
      await writeFile(guardCachePath(textHash), `${JSON.stringify(g, null, 2)}\n`);
      console.log(`${item.kind} ${item.id}: ${g.scoreBps} bps over ${g.windows} windows`);
    }
    scored.push({ kind: item.kind, id: item.id, scoreBps: g.scoreBps });
  }
  const clean = scored.filter((s) => s.kind === "clean");
  const inj = scored.filter((s) => s.kind === "injection");
  const thresholds = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 9500, 9900, 9990];
  const table = thresholds.map((t) => ({
    thresholdBps: t,
    cleanFlagged: clean.filter((s) => s.scoreBps >= t).length,
    injectionsFlagged: inj.filter((s) => s.scoreBps >= t).length,
  }));
  const maxClean = Math.max(...clean.map((s) => s.scoreBps));
  const recommended = thresholds.find((t) => t > maxClean) ?? null;
  await writeFile(
    join(EVAL_DIR, "data", "promptguard-calibration.json"),
    `${JSON.stringify({ model: guard.modelId, clean: clean.length, injections: inj.length, maxCleanBps: maxClean, recommendedThresholdBps: recommended, shippedThresholdBps: PROMPT_GUARD_THRESHOLD_BPS, table, scores: scored }, null, 2)}\n`,
  );
  console.table(table);
  console.log(`max clean score ${maxClean} bps; lowest listed threshold above it: ${recommended}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
