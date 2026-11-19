import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Paths inside the evidence directory. caseId must be a decimal string and jurorId 1 to 3. */
export const evidencePaths = {
  rationale: (caseId: string, jurorId: number) =>
    join("rationales", safeCase(caseId), `juror-${safeJuror(jurorId)}.json`),
  caseDir: (caseId: string) => join("cases", safeCase(caseId)),
  verdictLog: (caseId: string, jurorId: number) =>
    join("cases", safeCase(caseId), "verdicts", `juror-${safeJuror(jurorId)}.json`),
};

function safeCase(caseId: string): string {
  if (!/^\d{1,78}$/.test(caseId)) throw new Error(`Invalid case id for a path: ${caseId}`);
  return caseId;
}

function safeJuror(jurorId: number): number {
  if (!Number.isInteger(jurorId) || jurorId < 1 || jurorId > 16)
    throw new Error(`Invalid juror id: ${jurorId}`);
  return jurorId;
}

export interface EvidenceFile {
  /** Path relative to the evidence directory. */
  path: string;
  content: string;
}

export interface RationaleStore {
  /** Writes files and makes them publicly reachable before returning. Returns the public URL of each path. */
  publish(files: EvidenceFile[], message: string): Promise<Map<string, string>>;
  read(path: string): Promise<string | undefined>;
}

/**
 * Files under `evidence/` in this repository, served from raw GitHub URLs once pushed. `fs` mode only writes
 * (local runs and tests); `git` mode also commits and pushes, retrying on a concurrent push from another juror.
 */
export class RepoEvidenceStore implements RationaleStore {
  constructor(
    private readonly evidenceDir: string,
    private readonly publicBaseUrl: string,
    private readonly mode: "fs" | "git",
  ) {}

  async publish(files: EvidenceFile[], message: string): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    for (const file of files) {
      const full = join(this.evidenceDir, file.path);
      await mkdir(dirname(full), { recursive: true });
      const tmp = `${full}.tmp`;
      await writeFile(tmp, file.content);
      await rename(tmp, full);
      urls.set(file.path, `${this.publicBaseUrl.replace(/\/+$/, "")}/${file.path.split("\\").join("/")}`);
    }
    if (this.mode === "git")
      await this.commitAndPush(
        files.map((f) => join(this.evidenceDir, f.path)),
        message,
      );
    return urls;
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.evidenceDir, path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async commitAndPush(paths: string[], message: string): Promise<void> {
    const cwd = this.evidenceDir;
    const rel = paths.map((p) => relative(cwd, p));
    await run("git", ["add", "--", ...rel], { cwd });
    const staged = await run("git", ["diff", "--cached", "--name-only"], { cwd });
    if (staged.stdout.trim() === "") return;
    await run("git", ["commit", "-m", message, "--", ...rel], { cwd });
    for (let attempt = 1; ; attempt++) {
      try {
        await run("git", ["push"], { cwd });
        return;
      } catch (err) {
        if (attempt >= 5)
          throw new Error(`git push failed after ${attempt} attempts: ${(err as Error).message}`);
        await run("git", ["pull", "--rebase"], { cwd });
      }
    }
  }
}
