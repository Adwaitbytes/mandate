import { intEnv, loadSecretsFile, parseJurorId } from "../config.ts";
import { providerForJuror } from "../providers/index.ts";
import { realSleep } from "../providers/types.ts";
import { runtimeFromEnv } from "../runtime.ts";

/**
 * Juror worker. `--once` runs one pass and exits (the scheduled CI job); without it, polls every
 * POLL_INTERVAL_MS. Exit code 1 if any case failed in the last pass, so CI shows it.
 */
async function main(): Promise<void> {
  loadSecretsFile();
  const jurorId = parseJurorId(process.env.JUROR_ID);
  const provider = providerForJuror(jurorId);
  const { rt, poll } = await runtimeFromEnv({ jurorId, provider });
  rt.log(
    `juror ${jurorId} ${rt.account.address} using ${provider.modelId}, prompt ${rt.template.file} ${rt.template.hash}`,
  );

  const once = process.argv.includes("--once");
  const interval = intEnv("POLL_INTERVAL_MS", 30_000);
  for (;;) {
    const s = await poll();
    rt.log(
      `scanned ${s.fromBlock}..${s.toBlock}: ${s.seen} logs, ${s.duplicates} duplicates, ${s.alreadyPosted} already posted, ${s.posted} posted, ${s.skipped} skipped, ${s.failed.length} failed; checkpoint ${s.checkpoint}`,
    );
    if (once) {
      if (s.failed.length > 0) process.exitCode = 1;
      return;
    }
    await realSleep(interval);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
