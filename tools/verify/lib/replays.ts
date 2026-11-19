/**
 * Recorded `make replay` results (evidence/e2e-anvil/<run>/replays/<case>/juror-<n>-<time>.json): each one's
 * "recorded" verdict must equal the rationale document of that run, every pre-check must have passed, and the
 * drifted flag must equal a field-by-field comparison of the replayed verdict with the recorded one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "./repo.ts";

interface Verdict {
  support: string;
  confidenceBps: number;
  injectionFlag: boolean;
}

export interface ReplayCheck {
  file: string;
  run: string;
  caseId: string;
  juror: number;
  model: string;
  drifted: boolean;
  problems: string[];
}

const SUPPORT_LABEL = ["against", "for", "abstain"];

export function checkReplays(): ReplayCheck[] {
  const root = repoPath("evidence/e2e-anvil");
  const out: ReplayCheck[] = [];
  for (const run of readdirSync(root).sort()) {
    const dir = join(root, run, "replays");
    let cases: string[];
    try {
      cases = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const caseId of cases) {
      for (const f of readdirSync(join(dir, caseId)).sort()) {
        const doc = JSON.parse(readFileSync(join(dir, caseId, f), "utf8")) as {
          jurorId: number;
          model: string;
          drifted: boolean;
          checks: string[];
          recorded: Verdict;
          replay: Verdict;
        };
        const problems: string[] = [];
        const rationale = JSON.parse(
          readFileSync(join(root, run, "rationales", caseId, `juror-${doc.jurorId}.json`), "utf8"),
        ) as { support: number; confidenceBps: number; injectionFlag: boolean; model: string };
        const recordedSupport = SUPPORT_LABEL[rationale.support];
        if (doc.recorded.support !== recordedSupport)
          problems.push(`recorded support ${doc.recorded.support} vs rationale ${recordedSupport}`);
        if (doc.recorded.confidenceBps !== rationale.confidenceBps)
          problems.push("recorded confidence differs from the rationale");
        if (doc.recorded.injectionFlag !== rationale.injectionFlag)
          problems.push("recorded injection flag differs from the rationale");
        if (doc.model !== rationale.model)
          problems.push(`replay model ${doc.model} vs rationale ${rationale.model}`);
        for (const c of doc.checks) if (!c.startsWith("ok")) problems.push(`pre-check: ${c}`);
        const drifted =
          doc.replay.support !== doc.recorded.support ||
          doc.replay.confidenceBps !== doc.recorded.confidenceBps ||
          doc.replay.injectionFlag !== doc.recorded.injectionFlag;
        if (drifted !== doc.drifted) problems.push(`drifted flag ${doc.drifted}, comparison says ${drifted}`);
        out.push({
          file: `evidence/e2e-anvil/${run}/replays/${caseId}/${f}`,
          run,
          caseId,
          juror: doc.jurorId,
          model: doc.model,
          drifted,
          problems,
        });
      }
    }
  }
  return out;
}
