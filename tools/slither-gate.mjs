#!/usr/bin/env node
// Gate on a Slither JSON report: fail on any High finding that tools/slither-triage.json has not reviewed.
// Medium and Low findings are counted and printed, never fatal. Node built-ins only; copied into each repo.
//
// A finding is keyed by its detector and the first line of its description with source line ranges removed, so
// unrelated edits that move code do not invalidate a review, while a changed signature or new finding does.
//
// Usage: node tools/slither-gate.mjs <slither.json> [tools/slither-triage.json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {string} description */
export function findingKey(check, description) {
  const first = description.split("\n", 1)[0] ?? "";
  return `${check}: ${first.replace(/\s*\([^()]*#\d+(?:-\d+)?\)/g, "").trim()}`;
}

/**
 * @param {{ success: boolean, error: unknown, results?: { detectors?: { check: string, impact: string, description: string }[] } }} report
 * @param {{ high: { key: string, decision: string, reason: string }[] }} triage
 */
export function evaluate(report, triage) {
  if (!report.success) throw new Error(`slither did not finish: ${String(report.error)}`);
  const detectors = report.results?.detectors ?? [];
  const reviewed = new Map(triage.high.map((t) => [t.key, t]));
  /** @type {Record<string, number>} */
  const counts = {};
  const untriaged = [];
  const accepted = [];
  const seenKeys = new Set();
  for (const d of detectors) {
    counts[d.impact] = (counts[d.impact] ?? 0) + 1;
    if (d.impact !== "High") continue;
    const key = findingKey(d.check, d.description);
    seenKeys.add(key);
    const entry = reviewed.get(key);
    if (entry && entry.reason.trim().length > 0) accepted.push({ key, entry });
    else untriaged.push({ key, description: d.description.trim() });
  }
  const stale = triage.high.filter((t) => !seenKeys.has(t.key)).map((t) => t.key);
  return { counts, untriaged, accepted, stale };
}

function main(argv) {
  const [reportPath, triagePath = "tools/slither-triage.json"] = argv;
  if (!reportPath) {
    process.stderr.write("usage: slither-gate.mjs <slither.json> [slither-triage.json]\n");
    return 2;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const triage = JSON.parse(readFileSync(triagePath, "utf8"));
  if (!Array.isArray(triage.high)) throw new Error(`${triagePath}: "high" must be an array`);
  const { counts, untriaged, accepted, stale } = evaluate(report, triage);

  const order = ["High", "Medium", "Low", "Informational", "Optimization"];
  const summary = order
    .filter((k) => counts[k])
    .map((k) => `${k} ${counts[k]}`)
    .join(", ");
  process.stdout.write(`slither: ${summary || "no findings"}\n`);
  for (const a of accepted) process.stdout.write(`  reviewed  ${a.key}\n            ${a.entry.decision}\n`);
  for (const s of stale) process.stdout.write(`  stale triage entry (no longer reported): ${s}\n`);
  for (const u of untriaged) {
    process.stdout.write(`::error title=Untriaged Slither High finding::${u.key}\n${u.description}\n`);
  }
  if (untriaged.length > 0) {
    process.stdout.write(
      `${untriaged.length} High finding(s) need a fix or a reviewed entry in ${triagePath} (key as printed above)\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
