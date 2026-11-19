import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, keccakUtf8 } from "../canonical.ts";
import { loadSecretsFile, optionalEnv, parseJurorId, REPO_DIR } from "../config.ts";
import { judge } from "../judge.ts";
import { loadPromptTemplate } from "../prompt.ts";
import { providerForJuror, providerForModelId } from "../providers/index.ts";
import { evidencePaths } from "../store.ts";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const RecordedSchema = z.object({
  caseId: z.string(),
  mandateVersion: z.string(),
  mandateHash: hex32,
  model: z.string(),
  promptFile: z.string(),
  promptHash: hex32,
  proposalTextHash: hex32,
  support: z.number().int().min(0).max(2),
  supportLabel: z.enum(["for", "against", "abstain"]),
  confidenceBps: z.number().int().min(0).max(10_000),
  injectionFlag: z.boolean(),
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * `make replay CASE=<id> JUROR=<n>`: re-runs a juror on the proposal text and mandate snapshot recorded in
 * evidence/cases/<id>/ and compares support, confidence and the injection flag with the published rationale.
 * Writes the replay to evidence/replays/<id>/. `--strict` exits 2 on any drift.
 */
async function main(): Promise<void> {
  loadSecretsFile();
  const caseId = arg("case") ?? optionalEnv("CASE");
  if (caseId === undefined || !/^\d+$/.test(caseId)) throw new Error("Pass --case <id> (or CASE=<id>)");
  const jurorId = parseJurorId(arg("juror") ?? optionalEnv("JUROR") ?? process.env.JUROR_ID);
  const evidence = optionalEnv("EVIDENCE_DIR") ?? join(REPO_DIR, "evidence");

  const caseDir = join(evidence, evidencePaths.caseDir(caseId));
  const rationaleBytes = await readFile(join(evidence, evidencePaths.rationale(caseId, jurorId)), "utf8");
  const recorded = RecordedSchema.parse(JSON.parse(rationaleBytes));
  const proposalText = await readFile(join(caseDir, "proposal.txt"), "utf8");
  const mandateText = await readFile(join(caseDir, "mandate.md"), "utf8");

  const checks: string[] = [];
  const check = (ok: boolean, what: string) => checks.push(`${ok ? "ok      " : "MISMATCH"} ${what}`);
  check(
    keccakUtf8(mandateText) === recorded.mandateHash.toLowerCase(),
    "mandate snapshot hashes to the recorded mandateHash",
  );
  check(
    keccakUtf8(proposalText) === recorded.proposalTextHash.toLowerCase(),
    "proposal snapshot hashes to the recorded proposalTextHash",
  );
  const verdictLog = await readFile(join(evidence, evidencePaths.verdictLog(caseId, jurorId)), "utf8").catch(
    () => undefined,
  );
  if (verdictLog !== undefined) {
    const onChain = z.object({ rationaleHash: hex32, txHash: hex32 }).parse(JSON.parse(verdictLog));
    check(
      keccakUtf8(rationaleBytes) === onChain.rationaleHash.toLowerCase(),
      `rationale file hashes to the rationaleHash posted in ${onChain.txHash}`,
    );
  }

  const template = loadPromptTemplate(recorded.promptFile);
  check(
    template.hash === recorded.promptHash.toLowerCase(),
    `prompt ${recorded.promptFile} is unchanged since the verdict`,
  );
  const provider =
    optionalEnv("PROVIDER") === undefined ? providerForModelId(recorded.model) : providerForJuror(jurorId);
  check(
    provider.modelId === recorded.model,
    `replaying with the recorded model ${recorded.model} (now ${provider.modelId})`,
  );

  const outcome = await judge(provider, template, {
    mandateText,
    mandateVersion: recorded.mandateVersion,
    mandateHash: recorded.mandateHash as `0x${string}`,
    proposalText,
  });

  const drift = {
    support: outcome.verdict.support !== recorded.supportLabel,
    confidenceBps: outcome.confidenceBps - recorded.confidenceBps,
    injectionFlag: outcome.injectionFlag !== recorded.injectionFlag,
  };
  const drifted = drift.support || drift.injectionFlag || Math.abs(drift.confidenceBps) > 1000;

  console.log(`Replay of case ${caseId}, juror ${jurorId}`);
  for (const c of checks) console.log(`  ${c}`);
  console.log(
    `  support      recorded ${recorded.supportLabel.padEnd(8)} replay ${outcome.verdict.support.padEnd(8)} ${drift.support ? "DRIFT" : "same"}`,
  );
  console.log(
    `  confidence   recorded ${String(recorded.confidenceBps).padEnd(8)} replay ${String(outcome.confidenceBps).padEnd(8)} delta ${drift.confidenceBps} bps`,
  );
  console.log(
    `  injection    recorded ${String(recorded.injectionFlag).padEnd(8)} replay ${String(outcome.injectionFlag).padEnd(8)} ${drift.injectionFlag ? "DRIFT" : "same"}`,
  );
  console.log(
    `  verdict      ${drifted ? "DRIFTED (support, flag, or confidence by more than 1000 bps)" : "reproduced"}`,
  );

  const createdAt = new Date().toISOString();
  const out = join(evidence, "replays", caseId, `juror-${jurorId}-${createdAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(join(evidence, "replays", caseId), { recursive: true });
  await writeFile(
    out,
    `${canonicalJson({
      caseId,
      jurorId,
      model: outcome.modelId,
      createdAt,
      checks,
      recorded: {
        support: recorded.supportLabel,
        confidenceBps: recorded.confidenceBps,
        injectionFlag: recorded.injectionFlag,
      },
      replay: {
        support: outcome.verdict.support,
        confidenceBps: outcome.confidenceBps,
        injectionFlag: outcome.injectionFlag,
        valid: outcome.valid,
        rationale: outcome.verdict.rationale,
      },
      drifted,
    })}\n`,
  );
  console.log(`  written to ${out}`);
  if (process.argv.includes("--strict") && (drifted || checks.some((c) => c.startsWith("MISMATCH"))))
    process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
