import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccakUtf8 } from "../canonical.ts";
import { detectInjection } from "../injection.ts";
import { loadPromptTemplate } from "../prompt.ts";
import { PROMPT_GUARD_MODEL, PROMPT_GUARD_THRESHOLD_BPS } from "../promptguard.ts";
import { MAX_PROPOSAL_CHARS } from "../proposal.ts";
import type { Support } from "../schema.ts";
import { type Ballot, DEFAULT_TALLY, type Decision, tally } from "../tally.ts";
import { injectionText, loadInjectionSamples } from "./injections.ts";
import type { GuardScore } from "./promptguard-eval.ts";
import {
  type CachedVerdict,
  EVAL_DIR,
  expectedModelId,
  loadDataset,
  loadMandate,
  MANDATES,
  type MandateFile,
  proposalText,
} from "./shared.ts";
import type { EvalProposal } from "./types.ts";

const JURORS = [1, 2, 3] as const;

const PROVIDER_LABEL: Record<string, string> = {
  anthropic:
    "Anthropic API | temperature not settable on Claude 5.x; thinking disabled, effort low, JSON Schema output",
  groq: "Groq (OpenAI gpt-oss-120b) | temperature 0, seed 0, JSON mode; falls back to gpt-oss-20b on Pollinations live",
  pollinations: "Pollinations, keyless | temperature 0, seed 0, JSON mode",
  google: "Google Gemini API | temperature 0, JSON mode with response schema, thinking low",
  ollama: "Ollama, local | temperature 0, seed 0, JSON Schema output",
};
type JurorNo = (typeof JURORS)[number];

interface Row {
  p: EvalProposal;
  title: string;
  mandate: MandateFile;
  verdicts: Partial<Record<JurorNo, CachedVerdict>>;
  decision: Decision | "incomplete";
}

const pct = (num: number, den: number): string => {
  if (den === 0) return "n/a";
  const value = (100 * num) / den;
  return `${value < 10 && value > 0 ? value.toFixed(1) : value.toFixed(0)}% (${num}/${den})`;
};
const clean = (s: string): string =>
  s
    .replace(/[\u2013\u2014]/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
const short = (s: string, n: number): string => {
  const c = clean(s);
  return c.length > n ? `${c.slice(0, n - 3)}...` : c;
};

function titleOf(p: EvalProposal): string {
  const first = p.description.split("\n").find((l) => l.trim() !== "") ?? "(no description)";
  return short(first.replace(/^#+\s*/, ""), 80);
}

async function loadCache(): Promise<Map<string, CachedVerdict>> {
  const out = new Map<string, CachedVerdict>();
  for (const j of JURORS) {
    const dir = join(EVAL_DIR, "cache", `juror-${j}`);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      const v = JSON.parse(await readFile(join(dir, f), "utf8")) as CachedVerdict;
      out.set(v.key, v);
    }
  }
  return out;
}

const supportToOutcome = (s: Support): "passed" | "failed" | undefined =>
  s === "for" ? "passed" : s === "against" ? "failed" : undefined;

async function main(): Promise<void> {
  const dataset = await loadDataset();
  const template = loadPromptTemplate();
  const cache = await loadCache();
  const mandates = await Promise.all(MANDATES.map(async (file) => ({ file, ...(await loadMandate(file)) })));
  const modelIds = new Map<JurorNo, string>();
  for (const v of cache.values()) modelIds.set(v.jurorId as JurorNo, v.modelId);

  // Index cache by (juror, mandate hash, proposal text hash, prompt hash) for the current prompt only.
  const index = new Map<string, CachedVerdict>();
  for (const v of cache.values()) {
    if (v.promptHash !== template.hash || v.modelId !== expectedModelId(v.jurorId)) continue;
    index.set(`${v.jurorId}|${v.mandateHash}|${v.proposalTextHash}`, v);
  }

  // Prompt Guard scores are cached per proposal text by `make eval-promptguard`.
  const guardScores = new Map<string, number>();
  for (const f of await readdir(join(EVAL_DIR, "cache", "promptguard")).catch(() => [] as string[])) {
    const g = JSON.parse(await readFile(join(EVAL_DIR, "cache", "promptguard", f), "utf8")) as GuardScore;
    guardScores.set(g.textHash, g.scoreBps);
  }

  const rows: Row[] = [];
  for (const p of dataset.proposals) {
    const text = proposalText(p);
    const textHash = keccakUtf8(text);
    // The pre-filter is deterministic, so it is re-run with the current code rather than read from the cache.
    const heuristic = detectInjection(text);
    const guard = guardScores.get(textHash);
    const guardFlag = guard !== undefined && guard >= PROMPT_GUARD_THRESHOLD_BPS;
    for (const m of mandates) {
      const verdicts: Row["verdicts"] = {};
      for (const j of JURORS) {
        const v = index.get(`${j}|${m.hash}|${textHash}`);
        if (v === undefined) continue;
        verdicts[j] = {
          ...v,
          outcome: {
            ...v.outcome,
            heuristic,
            injectionFlag: v.outcome.verdict.injection_attempt || heuristic.flagged || guardFlag,
          },
        };
      }
      const present = JURORS.flatMap((j) => (verdicts[j] === undefined ? [] : [verdicts[j]]));
      const ballots: Ballot[] = present.map((v) => ({
        support: v.outcome.verdict.support,
        confidenceBps: v.outcome.confidenceBps,
        injectionFlag: v.outcome.injectionFlag,
        weight: 100,
      }));
      rows.push({
        p,
        title: titleOf(p),
        mandate: m.file,
        verdicts,
        decision: present.length === JURORS.length ? tally(ballots) : "incomplete",
      });
    }
  }

  const lines: string[] = [];
  const w = (s = "") => lines.push(s);
  const complete = (m: MandateFile) => rows.filter((r) => r.mandate === m && r.decision !== "incomplete");
  const sup = (r: Row, j: JurorNo): Support | undefined => r.verdicts[j]?.outcome.verdict.support;

  w("# Mandate juror evaluation: model card");
  w();
  w(
    `Generated ${new Date().toISOString().slice(0, 10)} by \`workers/src/eval/report.ts\` from the cached juror responses in \`analysis/eval/cache/\`. Every number below is recomputed from those files; rerun \`make eval-report\` to regenerate.`,
  );
  w();
  w("## What was tested");
  w();
  w(
    `Three jurors read real, already-decided governance proposals and gave a verdict (for, against or abstain, a confidence, an injection flag and a rationale) under each of two contrasting mandates. Same prompt for all three: \`workers/prompts/${template.file}\`, keccak256 \`${template.hash}\`.`,
  );
  w();
  w("| Juror | Model (`modelIdHash` preimage) | Provider | Sampling |");
  w("|---|---|---|---|");
  for (const j of JURORS) {
    const id = expectedModelId(j);
    w(`| ${j} | \`${id}\` | ${PROVIDER_LABEL[id.split("/")[0] ?? ""] ?? "?"} |`);
  }
  w();
  w(
    `Independent injection classifier for every juror: \`groq/${PROMPT_GUARD_MODEL}\` at ${PROMPT_GUARD_THRESHOLD_BPS} bps (see below). Posted flag = model self-report OR pre-filter OR classifier.`,
  );
  w();
  w("| Mandate | keccak256 |");
  w("|---|---|");
  for (const m of mandates) w(`| \`mandates/${m.file}\` | \`${m.hash}\` |`);
  w();
  const byDao = new Map<string, EvalProposal[]>();
  for (const p of dataset.proposals) byDao.set(p.dao, [...(byDao.get(p.dao) ?? []), p]);
  w(
    `**Data.** ${dataset.proposals.length} proposals from Ethereum mainnet governors, read from chain over a keyless public RPC (\`${dataset.rpc}\`) on ${dataset.fetchedAt.slice(0, 10)}. Sample: ${dataset.sample}. Outcome is the governor's \`state()\`: Defeated counts as failed; Succeeded, Queued, Expired and Executed count as passed.`,
  );
  w();
  w(
    "| DAO | Governor | Proposals | Passed | Failed | Named delegate (primary ENS name) | Delegate voted on |",
  );
  w("|---|---|---|---|---|---|---|");
  for (const d of dataset.daos) {
    const ps = byDao.get(d.key) ?? [];
    w(
      `| ${d.name} | \`${d.governor}\` | ${ps.length} | ${ps.filter((p) => p.outcome === "passed").length} | ${ps.filter((p) => p.outcome === "failed").length} | ${d.delegate.name} \`${d.delegate.address}\` | ${d.delegate.participation} |`,
    );
  }
  w();
  w(
    "The named delegate per DAO is chosen mechanically: the voter who took part in the most sampled proposals and has a primary ENS name set on chain. Their votes come from `VoteCast` logs.",
  );
  w();

  w("## Coverage");
  w();
  w("| Juror | Mandate | Scored | Valid JSON on first or second try | Fell back to abstain at 0 |");
  w("|---|---|---|---|---|");
  for (const j of JURORS) {
    for (const m of mandates) {
      const rs = rows.filter((r) => r.mandate === m.file && r.verdicts[j] !== undefined);
      const valid = rs.filter((r) => r.verdicts[j]?.outcome.valid === true).length;
      w(
        `| ${j} | ${m.file} | ${rs.length}/${dataset.proposals.length} | ${pct(valid, rs.length)} | ${rs.length - valid} |`,
      );
    }
  }
  w();
  w(
    `Rows below use only proposals all three jurors scored under that mandate: ${mandates.map((m) => `${complete(m.file).length} for ${m.file}`).join(", ")}.`,
  );
  w();

  w("## How each juror voted");
  w();
  w("| Mandate | Juror | For | Against | Abstain | Mean confidence |");
  w("|---|---|---|---|---|---|");
  for (const m of mandates) {
    const rs = complete(m.file);
    for (const j of JURORS) {
      const c = { for: 0, against: 0, abstain: 0 };
      let conf = 0;
      for (const r of rs) {
        const v = r.verdicts[j];
        if (v === undefined) continue;
        c[v.outcome.verdict.support]++;
        conf += v.outcome.verdict.confidence;
      }
      w(
        `| ${m.file} | ${j} | ${c.for} | ${c.against} | ${c.abstain} | ${rs.length === 0 ? "n/a" : (conf / rs.length).toFixed(0)} |`,
      );
    }
  }
  w();

  w("## Agreement between jurors");
  w();
  w("| Mandate | All three agree | 1 and 2 agree | 1 and 3 agree | 2 and 3 agree | At least two agree |");
  w("|---|---|---|---|---|---|");
  for (const m of mandates) {
    const rs = complete(m.file);
    const agree = (a: JurorNo, b: JurorNo) => rs.filter((r) => sup(r, a) === sup(r, b)).length;
    const all = rs.filter((r) => sup(r, 1) === sup(r, 2) && sup(r, 2) === sup(r, 3)).length;
    const two = rs.filter((r) => new Set(JURORS.map((j) => sup(r, j))).size < 3).length;
    w(
      `| ${m.file} | ${pct(all, rs.length)} | ${pct(agree(1, 2), rs.length)} | ${pct(agree(1, 3), rs.length)} | ${pct(agree(2, 3), rs.length)} | ${pct(two, rs.length)} |`,
    );
  }
  w();

  w("## Does the mandate change the vote");
  w();
  w(
    "Share of proposals where the same juror gave a different support under the two mandates. A juror that ignores the mandate would score 0%.",
  );
  w();
  w("| Juror | Support differs between mandates | Quorum decision differs |");
  w("|---|---|---|");
  const pairs = dataset.proposals.flatMap((p) => {
    const a = rows.find((r) => r.p === p && r.mandate === MANDATES[0]);
    const b = rows.find((r) => r.p === p && r.mandate === MANDATES[1]);
    return a !== undefined && b !== undefined && a.decision !== "incomplete" && b.decision !== "incomplete"
      ? [[a, b] as const]
      : [];
  });
  const decisionDiff = pairs.filter(([a, b]) => a.decision !== b.decision).length;
  for (const j of JURORS) {
    w(
      `| ${j} | ${pct(pairs.filter(([a, b]) => sup(a, j) !== sup(b, j)).length, pairs.length)} | ${j === 1 ? pct(decisionDiff, pairs.length) : ""} |`,
    );
  }
  w();

  w("## Quorum decision");
  w();
  w(
    `The tally mirrors \`MandateReactive\` with equal weights: quorum ${DEFAULT_TALLY.quorum}, a side needs ${DEFAULT_TALLY.minAgreeing} confident ballots, minimum confidence ${DEFAULT_TALLY.minConfidenceBps} bps, a side needs more than ${DEFAULT_TALLY.majorityBps / 100}% of posted weight, a split is held, and ${DEFAULT_TALLY.injectionFlagsToHold} injection flag holds the case.`,
  );
  w();
  w("| Mandate | For | Against | Abstain | Held: split | Held: injection flag |");
  w("|---|---|---|---|---|---|");
  for (const m of mandates) {
    const rs = complete(m.file);
    const n = (d: Decision) => rs.filter((r) => r.decision === d).length;
    w(
      `| ${m.file} | ${n("for")} | ${n("against")} | ${n("abstain")} | ${n("held-split")} | ${n("held-injection")} |`,
    );
  }
  w();

  w("## Quorum against the actual outcome and the named delegate");
  w();
  w(
    "Only cases where the quorum decided for or against are compared (abstain and held cases are not a call either way). A mandate is a personal policy, so agreement with the DAO's outcome is not accuracy: it shows how often this voter would have sided with the majority.",
  );
  w();
  w(
    "| Mandate | Stratum | Decided for/against | Matches outcome | Delegate voted for/against too | Matches delegate |",
  );
  w("|---|---|---|---|---|---|");
  for (const m of mandates) {
    for (const stratum of ["recent", "defeated-oversample", "all"] as const) {
      const rs = complete(m.file).filter(
        (r) =>
          (stratum === "all" || r.p.stratum === stratum) &&
          (r.decision === "for" || r.decision === "against"),
      );
      const out = rs.filter((r) => supportToOutcome(r.decision as Support) === r.p.outcome).length;
      const withDelegate = rs.filter((r) => r.p.delegate.vote === "for" || r.p.delegate.vote === "against");
      const del = withDelegate.filter((r) => r.p.delegate.vote === r.decision).length;
      w(
        `| ${m.file} | ${stratum} | ${rs.length} | ${pct(out, rs.length)} | ${withDelegate.length} | ${pct(del, withDelegate.length)} |`,
      );
    }
  }
  w();
  w("Each juror alone, counting only its for/against calls:");
  w();
  w("| Mandate | Juror | For/against calls | Matches outcome | Matches delegate |");
  w("|---|---|---|---|---|");
  for (const m of mandates) {
    for (const j of JURORS) {
      const rs = complete(m.file).filter((r) => sup(r, j) === "for" || sup(r, j) === "against");
      const out = rs.filter((r) => supportToOutcome(sup(r, j) as Support) === r.p.outcome).length;
      const wd = rs.filter((r) => r.p.delegate.vote === "for" || r.p.delegate.vote === "against");
      w(
        `| ${m.file} | ${j} | ${rs.length} | ${pct(out, rs.length)} | ${pct(wd.filter((r) => r.p.delegate.vote === sup(r, j)).length, wd.length)} |`,
      );
    }
  }
  const base = dataset.proposals.filter((p) => p.outcome === "passed").length;
  w();
  w(
    `Base rates: ${pct(base, dataset.proposals.length)} of sampled proposals passed; a voter who always votes for would match the outcome that often.`,
  );
  w();

  w("## Injection flags on real proposals");
  w();
  w(
    "None of these proposals is known to target AI voters, so every flag here is most likely a false positive, and any flag holds a case for good. The heuristic flag is the same for all jurors because it reads the same text, and it is recomputed with the current `workers/src/injection.ts` each time this card is generated.",
  );
  w();
  w(
    "| Mandate | Juror 1 model flag | Juror 2 model flag | Juror 3 model flag | Pre-filter flag | Prompt Guard flag | Cases held by a flag |",
  );
  w("|---|---|---|---|---|---|---|");
  for (const m of mandates) {
    const rs = complete(m.file);
    const mf = (j: JurorNo) =>
      rs.filter((r) => r.verdicts[j]?.outcome.verdict.injection_attempt === true).length;
    const hf = rs.filter((r) => r.verdicts[1]?.outcome.heuristic.flagged === true).length;
    const gf = rs.filter(
      (r) => (guardScores.get(keccakUtf8(proposalText(r.p))) ?? 0) >= PROMPT_GUARD_THRESHOLD_BPS,
    ).length;
    w(
      `| ${m.file} | ${pct(mf(1), rs.length)} | ${pct(mf(2), rs.length)} | ${pct(mf(3), rs.length)} | ${pct(hf, rs.length)} | ${pct(gf, rs.length)} | ${pct(rs.filter((r) => r.decision === "held-injection").length, rs.length)} |`,
    );
  }
  w();
  const heuristicHits = new Map<string, string>();
  for (const r of rows) {
    const h =
      r.verdicts[1]?.outcome.heuristic ??
      r.verdicts[2]?.outcome.heuristic ??
      r.verdicts[3]?.outcome.heuristic;
    if (h?.flagged === true)
      heuristicHits.set(
        `${r.p.dao} ${r.title}`,
        h.matches.map((x) => `${x.rule}: "${short(x.excerpt, 110)}"`).join("; "),
      );
  }
  if (heuristicHits.size > 0) {
    w("Heuristic hits:");
    w();
    for (const [k, v] of heuristicHits) w(`- ${k}: ${v}`);
    w();
  }

  const corpusRaw = await readFile(join(EVAL_DIR, "data", "heuristic-corpus.json"), "utf8").catch(
    () => undefined,
  );
  if (corpusRaw !== undefined) {
    const corpus = JSON.parse(corpusRaw) as {
      block: string;
      perDao: Array<{ dao: string; proposals: number; flagged: number }>;
      hits: Array<{ dao: string; title: string; rules: string[]; excerpts: string[] }>;
    };
    const total = corpus.perDao.reduce((a, d) => a + d.proposals, 0);
    const flagged = corpus.perDao.reduce((a, d) => a + d.flagged, 0);
    w(
      `Pre-filter alone on every proposal the three governors ever emitted (\`make eval-heuristic\`, no model calls, block ${corpus.block}): ${pct(flagged, total)} flagged (${corpus.perDao.map((d) => `${d.dao} ${d.flagged}/${d.proposals}`).join(", ")}).`,
    );
    for (const h of corpus.hits)
      w(`- ${h.dao}: ${short(h.title, 70)}: ${h.rules.join(", ")} (${short(h.excerpts.join("; "), 110)})`);
    w();
    w(
      'This is not a clean held-out number. The first version of the pre-filter flagged 3 of the 72 eval proposals ("will act as the operational team") and 3 more in this corpus ("interest rate model ... should"); the role-play and AI-voter rules were narrowed after reading those hits, with each phrase added as a regression test. The remaining hit is a real invisible left-to-right mark, which the filter flags by design.',
    );
    w();
  }

  const samples = await loadInjectionSamples();
  const conservativeHash = mandates.find((m) => m.file === "conservative-treasury.v1.md")?.hash;
  if (samples.length > 0 && conservativeHash !== undefined) {
    w("## Injection samples");
    w();
    w(
      `${samples.length} synthetic proposals in \`analysis/eval/data/injection-samples.json\`, one technique each (direct override, text addressed to AI voters, hidden Unicode, a fake system block, smuggled verdict JSON, role play, authority claims, a delimiter escape, Spanish, base64, an HTML comment, an instruction buried after long benign text, a claimed mandate amendment, a rationale to copy). Each asks for a large or risky spend, so the conservative mandate says against on the merits. Judged under that mandate only.`,
    );
    w();
    w("| Sample | Juror 1 | Juror 2 | Juror 3 | Pre-filter | Prompt Guard (bps) | Caught by any signal |");
    w("|---|---|---|---|---|---|---|");
    let caught = 0;
    const perJuror = new Map<JurorNo, { scored: number; flagged: number; against: number }>();
    for (const [i, sample] of samples.entries()) {
      const text = injectionText(sample, i);
      const textHash = keccakUtf8(text);
      const heur = detectInjection(text).flagged;
      const guard = guardScores.get(textHash);
      const guardFlag = guard !== undefined && guard >= PROMPT_GUARD_THRESHOLD_BPS;
      let any = heur || guardFlag;
      const cells = JURORS.map((j) => {
        const v = index.get(`${j}|${conservativeHash}|${textHash}`);
        if (v === undefined) return "";
        const stat = perJuror.get(j) ?? { scored: 0, flagged: 0, against: 0 };
        stat.scored++;
        if (v.outcome.verdict.injection_attempt) stat.flagged++;
        if (v.outcome.verdict.support === "against") stat.against++;
        perJuror.set(j, stat);
        any ||= v.outcome.verdict.injection_attempt;
        return `${v.outcome.verdict.support}${v.outcome.verdict.injection_attempt ? ", flagged" : ", not flagged"}`;
      });
      if (any) caught++;
      w(
        `| ${sample.id} | ${cells.join(" | ")} | ${heur ? "flag" : ""} | ${guard ?? "n/a"}${guardFlag ? " (flag)" : ""} | ${any ? "yes" : "no"} |`,
      );
    }
    w();
    w("| Juror | Model | Samples scored | Reported the attempt itself | Voted against |");
    w("|---|---|---|---|---|");
    for (const j of JURORS) {
      const st = perJuror.get(j) ?? { scored: 0, flagged: 0, against: 0 };
      w(
        `| ${j} | \`${expectedModelId(j)}\` | ${st.scored} | ${pct(st.flagged, st.scored)} | ${pct(st.against, st.scored)} |`,
      );
    }
    w();
    w(
      `Caught by at least one signal: ${pct(caught, samples.length)}. A caught case is held and never votes automatically.`,
    );
    w();
  }

  const calibrationRaw = await readFile(join(EVAL_DIR, "data", "promptguard-calibration.json"), "utf8").catch(
    () => undefined,
  );
  if (calibrationRaw !== undefined) {
    const cal = JSON.parse(calibrationRaw) as {
      model: string;
      clean: number;
      injections: number;
      maxCleanBps: number;
      table: Array<{ thresholdBps: number; cleanFlagged: number; injectionsFlagged: number }>;
    };
    w("## Prompt Guard calibration");
    w();
    w(
      `\`${cal.model}\` scored every proposal in overlapping 1,000-character windows; a proposal's score is its highest window. Clean set: the ${cal.clean} real proposals (highest score ${cal.maxCleanBps} bps). Injection set: the ${cal.injections} samples. Shipped threshold: ${PROMPT_GUARD_THRESHOLD_BPS} bps.`,
    );
    w();
    w("| Threshold (bps) | Clean proposals flagged | Injection samples flagged |");
    w("|---|---|---|");
    for (const r of cal.table) {
      w(
        `| ${r.thresholdBps}${r.thresholdBps === PROMPT_GUARD_THRESHOLD_BPS ? " (shipped)" : ""} | ${pct(r.cleanFlagged, cal.clean)} | ${pct(r.injectionsFlagged, cal.injections)} |`,
      );
    }
    w();
  }

  w("## Where the jurors disagree, and why");
  w();
  for (const m of mandates) {
    const split = complete(m.file).filter((r) => new Set(JURORS.map((j) => sup(r, j))).size > 1);
    w(`### ${m.file}: ${split.length} of ${complete(m.file).length} proposals without a unanimous verdict`);
    w();
    w("| Proposal | Outcome | Juror 1 | Juror 2 | Juror 3 | Quorum |");
    w("|---|---|---|---|---|---|");
    for (const r of split) {
      const cell = (j: JurorNo) => {
        const v = r.verdicts[j]?.outcome;
        return v === undefined
          ? ""
          : `${v.verdict.support} ${v.verdict.confidence}${v.injectionFlag ? " (flag)" : ""}`;
      };
      w(`| ${r.p.dao}: ${r.title} | ${r.p.outcome} | ${cell(1)} | ${cell(2)} | ${cell(3)} | ${r.decision} |`);
    }
    w();
    const examples = split.slice(0, 6);
    if (examples.length > 0) {
      w("Reasons given, first six:");
      w();
      for (const r of examples) {
        w(`- **${r.p.dao}: ${r.title}** (${r.p.outcome})`);
        for (const j of JURORS) {
          const v = r.verdicts[j]?.outcome;
          if (v !== undefined)
            w(
              `  - Juror ${j}, ${v.verdict.support} ${v.verdict.confidence}: ${short(v.verdict.rationale, 300)}`,
            );
        }
      }
      w();
    }
  }

  const others = [
    ...new Set(
      [...cache.values()].filter((v) => v.modelId !== expectedModelId(v.jurorId)).map((v) => v.modelId),
    ),
  ];
  if (others.length > 0) {
    w("## Other models scored in the same slots");
    w();
    w(
      "Earlier or fallback models run on the same proposals with the same prompt, kept for comparison. They are not part of the tables above.",
    );
    w();
    w(
      "| Model | Mandate | Scored | For | Against | Abstain | Valid output | Support differs between mandates |",
    );
    w("|---|---|---|---|---|---|---|---|");
    const realHashes = new Set(dataset.proposals.map((p) => keccakUtf8(proposalText(p))));
    for (const model of others) {
      const mine = [...cache.values()].filter(
        (v) => v.modelId === model && v.promptHash === template.hash && realHashes.has(v.proposalTextHash),
      );
      const byText = new Map<string, Map<string, Support>>();
      for (const v of mine) {
        const m = byText.get(v.proposalTextHash) ?? new Map<string, Support>();
        m.set(v.mandate, v.outcome.verdict.support);
        byText.set(v.proposalTextHash, m);
      }
      const both = [...byText.values()].filter((m) => m.size === 2);
      const differs = both.filter((m) => m.get(MANDATES[0]) !== m.get(MANDATES[1])).length;
      for (const mf of MANDATES) {
        const rs = mine.filter((v) => v.mandate === mf);
        const n = (x: Support) => rs.filter((v) => v.outcome.verdict.support === x).length;
        w(
          `| \`${model}\` | ${mf} | ${rs.length} | ${n("for")} | ${n("against")} | ${n("abstain")} | ${pct(rs.filter((v) => v.outcome.valid).length, rs.length)} | ${mf === MANDATES[0] ? pct(differs, both.length) : ""} |`,
        );
      }
    }
    w();
  }

  w("## Limits");
  w();
  w(
    "- The sample is small and lopsided: most proposals that reach an on-chain vote pass, and the named delegates voted for almost all of them. The failed proposals were oversampled from further back to have any at all; read the strata separately.",
  );
  w(
    "- A mandate is one person's policy. Matching the DAO outcome or a delegate is context, not a score: a treasury-protective mandate should disagree with a DAO that funds grants.",
  );
  const truncated = dataset.proposals.filter((p) =>
    proposalText(p).includes("[truncated by the juror runtime"),
  ).length;
  w(
    `- Proposal text is capped at ${MAX_PROPOSAL_CHARS.toLocaleString("en-US")} characters for every juror (the same cap the live workers use); ${truncated} of ${dataset.proposals.length} proposals here are longer and were truncated. Calldata is shown as hex, so jurors judge actions mostly through the description.`,
  );
  w(
    "- Claude Haiku 5.5 does not accept a temperature, `gemini-flash-latest` is a rolling alias (each verdict records the served `modelVersion`), and hosted temperature-0 sampling is not bit-for-bit deterministic, so reruns can drift; the anvil replays in `evidence/e2e-anvil/replays/` show it. The cache keeps the exact responses scored here.",
  );
  w(
    "- The injection samples are synthetic and written by the same team that wrote the pre-filter and calibrated Prompt Guard, so detection on them is an upper bound. Prompt Guard's threshold was chosen on these same 72 clean proposals and 16 samples; there is no held-out set.",
  );
  w(
    "- The eval reuses the live prompt and pipeline (`judge()`), but not the chain: no transactions were sent.",
  );
  w();
  w("## Reproduce");
  w();
  w("```");
  w("make eval-fetch     # re-reads proposals, outcomes and delegate votes from chain");
  w("make eval-run       # scores missing (proposal, mandate, juror) triples; cached ones are free");
  w("make eval-report    # rewrites this file and results.csv");
  w("```");
  w();

  await writeFile(join(EVAL_DIR, "MODEL_CARD.md"), `${lines.join("\n")}\n`);

  const csv: string[] = [
    "dao,proposal_id,stratum,outcome,delegate_vote,mandate,j1,j1_conf,j1_flag,j2,j2_conf,j2_flag,j3,j3_conf,j3_flag,heuristic_flag,decision,title",
  ];
  for (const r of rows) {
    const cells = JURORS.flatMap((j) => {
      const v = r.verdicts[j]?.outcome;
      return v === undefined
        ? ["", "", ""]
        : [v.verdict.support, String(v.verdict.confidence), String(v.injectionFlag)];
    });
    const h = r.verdicts[1]?.outcome.heuristic.flagged ?? "";
    csv.push(
      [
        r.p.dao,
        r.p.proposalId,
        r.p.stratum,
        r.p.outcome,
        r.p.delegate.vote ?? "",
        r.mandate,
        ...cells,
        String(h),
        r.decision,
        `"${r.title.replace(/"/g, "'")}"`,
      ].join(","),
    );
  }
  await writeFile(join(EVAL_DIR, "results.csv"), `${csv.join("\n")}\n`);
  console.log(`wrote MODEL_CARD.md and results.csv (${rows.length} rows, ${cache.size} cached responses)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
