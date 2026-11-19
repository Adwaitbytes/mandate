import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const CheckpointSchema = z.object({ lastScannedBlock: z.string().regex(/^\d+$/) });

export interface CheckpointStore {
  load(): Promise<bigint | undefined>;
  save(lastScannedBlock: bigint): Promise<void>;
}

/** A one-field JSON file, written atomically. Losing it is safe: the watcher re-scans and skips posted cases. */
export class FileCheckpoint implements CheckpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<bigint | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return BigInt(CheckpointSchema.parse(JSON.parse(raw)).lastScannedBlock);
  }

  async save(lastScannedBlock: bigint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ lastScannedBlock: lastScannedBlock.toString() })}\n`);
    await rename(tmp, this.path);
  }
}

export class MemoryCheckpoint implements CheckpointStore {
  constructor(public value: bigint | undefined = undefined) {}
  async load(): Promise<bigint | undefined> {
    return this.value;
  }
  async save(lastScannedBlock: bigint): Promise<void> {
    this.value = lastScannedBlock;
  }
}
