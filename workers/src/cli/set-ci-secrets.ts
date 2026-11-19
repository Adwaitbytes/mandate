import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { loadSecretsFile, optionalEnv, parseJurorId } from "../config.ts";
import { loadJurorAccountKey } from "../runtime.ts";

/**
 * Copies the juror keys (from their Foundry keystores) and the model provider keys (from .env.local) into GitHub
 * Actions secrets with `gh secret set`, passing each value on stdin so it never reaches argv, a log or a file.
 * Usage: pnpm -s set-ci-secrets --repo <owner>/<name>
 */
function setSecret(repo: string, name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["secret", "set", name, "--repo", repo], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`gh secret set ${name} exited ${code}`)),
    );
    child.stdin.end(value);
  });
}

async function main(): Promise<void> {
  loadSecretsFile();
  const i = process.argv.indexOf("--repo");
  const repo = i === -1 ? undefined : process.argv[i + 1];
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Pass --repo <owner>/<name>");
  // With JUROR_PRIVATE_KEY set, every juror would resolve to that one key.
  if (optionalEnv("JUROR_PRIVATE_KEY") !== undefined)
    throw new Error("Unset JUROR_PRIVATE_KEY; keys come from the keystores");
  for (const id of ["1", "2", "3"].map(parseJurorId)) {
    const key = await loadJurorAccountKey(id);
    await setSecret(repo, `JUROR_KEY_${id}`, key);
    console.log(`JUROR_KEY_${id} set for ${privateKeyToAccount(key).address}`);
  }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_2", "GROQ_API_KEY", "GEMINI_API_KEY", "GEMINI_API_KEY_2"]) {
    const value = optionalEnv(name);
    if (value === undefined) continue;
    await setSecret(repo, name, value);
    console.log(`${name} set`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
