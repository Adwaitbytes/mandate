import { ConfigError, intEnv, loadSecretsFile, parseJurorId } from "../config.ts";
import { runPollLoop } from "../loop.ts";
import { providerForJuror } from "../providers/index.ts";
import { runtimeFromEnv } from "../runtime.ts";
import type { PollSummary } from "../watcher.ts";

/** Exit code for a configuration error (sysexits EX_CONFIG); the supervisor does not restart on it. */
const EXIT_CONFIG = 78;

/**
 * Juror worker. `--once` runs one pass and exits (the scheduled CI job), with exit code 1 if any case failed so CI
 * shows it. Without it, polls every POLL_INTERVAL_MS until SIGTERM or SIGINT, which end it after the pass in
 * progress; a failed pass is logged and retried with backoff, never fatal.
 */
async function main(): Promise<void> {
  loadSecretsFile();
  const log = (m: string): void => console.log(`${new Date().toISOString()} ${m}`);
  const jurorId = parseJurorId(process.env.JUROR_ID);
  const provider = providerForJuror(jurorId, { log });
  const { rt, poll } = await runtimeFromEnv({ jurorId, provider, log });
  rt.log(
    `juror ${jurorId} ${rt.account.address} provider chain ${provider.labels.join(" -> ")}, prompt ${rt.template.file} ${rt.template.hash}`,
  );
  const report = (s: PollSummary): void =>
    rt.log(
      `scanned ${s.fromBlock}..${s.toBlock}: ${s.seen} logs, ${s.duplicates} duplicates, ${s.alreadyPosted} already posted, ${s.posted} posted, ${s.skipped} skipped, ${s.failed.length} failed; checkpoint ${s.checkpoint}`,
    );

  if (process.argv.includes("--once")) {
    const s = await poll();
    report(s);
    if (s.failed.length > 0) process.exitCode = 1;
    return;
  }

  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      rt.log(`${signal}: stopping after the pass in progress`);
      stop.abort();
    });
  }
  await runPollLoop({
    poll,
    onPass: report,
    intervalMs: intEnv("POLL_INTERVAL_MS", 30_000),
    log: rt.log,
    signal: stop.signal,
  });
  rt.log("stopped");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(err instanceof ConfigError ? EXIT_CONFIG : 1);
});
