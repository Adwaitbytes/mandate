import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { keccakUtf8 } from "../canonical.ts";
import { type JurorId, loadSecretsFile, optionalEnv, parseJurorId } from "../config.ts";
import { judge } from "../judge.ts";
import { loadPromptTemplate } from "../prompt.ts";
import { providerForJuror } from "../providers/index.ts";
import type { Provider } from "../providers/types.ts";
import {
  type CachedVerdict,
  cacheKey,
  cachePath,
  loadDataset,
  loadMandate,
  MANDATES,
  proposalText,
  readCached,
} from "./shared.ts";

/**
 * Scores every proposal under both mandates with each juror. Responses are cached on disk by
 * (model, prompt hash, mandate hash, proposal text hash), so a rerun only calls the models for missing pairs
 * and an interrupted run resumes. EVAL_JURORS picks jurors (default 1,2,3); EVAL_LIMIT caps proposals.
 */
async function main(): Promise<void> {
  loadSecretsFile();
  const jurorIds = (optionalEnv("EVAL_JURORS") ?? "1,2,3").split(",").map((s) => parseJurorId(s.trim()));
  const limit = Number(optionalEnv("EVAL_LIMIT") ?? "100000");
  const dataset = await loadDataset();
  const template = loadPromptTemplate();
  const mandates = await Promise.all(MANDATES.map(async (file) => ({ file, ...(await loadMandate(file)) })));
  const proposals = dataset.proposals.slice(0, limit);

  const work = proposals.flatMap((p) => {
    const text = proposalText(p);
    return mandates.map((m) => ({ p, text, textHash: keccakUtf8(text), m }));
  });

  const runJuror = async (
    jurorId: JurorId,
  ): Promise<{ jurorId: JurorId; cached: number; ran: number; failed: number }> => {
    const provider: Provider = providerForJuror(jurorId, false);
    let cached = 0;
    let ran = 0;
    let failed = 0;
    for (const { p, text, textHash, m } of work) {
      const key = cacheKey(provider.modelId, template.hash, m.hash, textHash);
      if ((await readCached(jurorId, key)) !== undefined) {
        cached++;
        continue;
      }
      try {
        const outcome = await judge(provider, template, {
          mandateText: m.text,
          mandateVersion: "eval",
          mandateHash: m.hash,
          proposalText: text,
        });
        const record: CachedVerdict = {
          key,
          jurorId,
          modelId: provider.modelId,
          promptHash: template.hash,
          mandate: m.file,
          mandateHash: m.hash,
          dao: p.dao,
          proposalId: p.proposalId,
          proposalTextHash: textHash,
          createdAt: new Date().toISOString(),
          outcome,
        };
        const path = cachePath(jurorId, key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
        ran++;
        console.log(
          `juror ${jurorId} ${p.dao} ${p.proposalId.slice(0, 12)} ${m.file}: ${outcome.verdict.support} ${outcome.verdict.confidence}${outcome.valid ? "" : " (invalid output)"}`,
        );
      } catch (err) {
        failed++;
        console.error(
          `juror ${jurorId} ${p.dao} ${p.proposalId.slice(0, 12)} ${m.file}: ${(err as Error).message}`,
        );
      }
    }
    return { jurorId, cached, ran, failed };
  };

  const results = await Promise.all(jurorIds.map(runJuror));
  for (const r of results)
    console.log(`juror ${r.jurorId}: ${r.cached} cached, ${r.ran} new, ${r.failed} failed`);
  if (results.some((r) => r.failed > 0)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
