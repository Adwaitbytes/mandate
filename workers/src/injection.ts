/**
 * Deterministic prompt-injection pre-filter. It runs on the raw proposal text before any model sees it and
 * sets the injection flag independently of the model, so a model that is itself fooled cannot clear the flag.
 *
 * The rules aim at text that addresses an automated reader. Ordinary governance language ("Vote FOR to
 * approve the grant") is deliberately not matched on its own, because a false flag holds a case for good.
 */

export interface InjectionMatch {
  rule: InjectionRule;
  excerpt: string;
}

export interface InjectionReport {
  flagged: boolean;
  matches: InjectionMatch[];
}

export type InjectionRule =
  | "override-instructions"
  | "system-prompt-mimicry"
  | "role-play"
  | "addresses-ai-voter"
  | "coerced-vote"
  | "output-manipulation"
  | "delimiter-escape"
  | "hidden-unicode";

interface PatternRule {
  rule: InjectionRule;
  pattern: RegExp;
}

const AI_NOUN =
  "(?:ai|a\\.i\\.|llm|large language model|language model|model|assistant|chatbot|bot|agent|juror|jury|automated (?:voter|delegate|system)|ai (?:voter|delegate|juror))";

const PATTERNS: readonly PatternRule[] = [
  {
    rule: "override-instructions",
    pattern:
      /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|the|system|original)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|directives|guidelines|context|messages?|mandate)\b/i,
  },
  {
    rule: "override-instructions",
    pattern: /\b(?:new|updated|revised|real|actual|true)\s+(?:system\s+)?instructions?\s*[:-]/i,
  },
  {
    rule: "system-prompt-mimicry",
    pattern:
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:system|assistant|developer|user)\s*(?:prompt|message)?\s*:|<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|instructions?|assistant)>|\bBEGIN (?:SYSTEM|NEW) PROMPT\b|\bend of (?:system )?prompt\b/i,
  },
  {
    rule: "role-play",
    pattern:
      /\b(?:you are now|from now on,? you|pretend (?:to be|you are|that you)|act as (?:an?|the|my)\b|role-?play as|you will now (?:act|behave|respond)|switch(?:ing)? to (?:developer|dan|jailbreak) mode|\bDAN\b mode)/i,
  },
  {
    rule: "addresses-ai-voter",
    pattern: new RegExp(
      `\\b(?:dear|attention|note to|hey|hello|to (?:the|any|all))\\s+${AI_NOUN}s?\\b|\\b(?:if|when) you are an? ${AI_NOUN}\\b|\\bas an? ${AI_NOUN}\\b,? you\\b|\\b${AI_NOUN}s?\\b[^.\\n]{0,60}\\b(?:must|should|shall|need to|are (?:required|instructed) to)\\s+(?:vote|support|approve|reject|answer|respond|output|return|mark|set)\\b`,
      "i",
    ),
  },
  {
    rule: "coerced-vote",
    pattern:
      /\b(?:you must|you have to|you are required to|always|automatically|unconditionally)\s+(?:vote|approve|support|answer)\b[^.\n]{0,20}\b(?:for|yes|in favou?r|against|no)\b|\bvote\s+(?:for|yes|in favou?r)\b[^.\n]{0,40}\bregardless\b|\bregardless of (?:the|your|any) (?:mandate|policy|instructions?|rules)\b/i,
  },
  {
    rule: "output-manipulation",
    pattern:
      /"(?:support|confidence|injection_attempt|cited_mandate_clauses)"\s*:|\binjection_attempt\b|\b(?:set|report|give|output)\s+(?:your\s+|the\s+)?confidence\s+(?:to|of|at|as)\b|\b(?:respond|reply|answer|output)\s+(?:only\s+)?(?:with|in)\s+(?:json|the following|exactly)\b/i,
  },
  {
    rule: "delimiter-escape",
    pattern:
      /<<\s*\/?\s*UNTRUSTED|\bUNTRUSTED_PROPOSAL\b|\bEND OF (?:THE )?(?:PROPOSAL|UNTRUSTED|DATA)\b|<\/(?:proposal|data|untrusted)>/i,
  },
];

/**
 * Zero-width characters, bidirectional controls, Unicode tag characters (used to smuggle invisible ASCII) and
 * other format characters that have no business in a governance proposal. A single byte-order mark at the very
 * start is tolerated.
 */
const HIDDEN_UNICODE = /[​-‏‪-‮⁠-⁤⁦-⁩⁪-⁯﻿­᠎]|[\u{E0000}-\u{E007F}]/u;

const EXCERPT_RADIUS = 60;

export function detectInjection(text: string): InjectionReport {
  const matches: InjectionMatch[] = [];
  const body = text.startsWith("﻿") ? text.slice(1) : text;

  const hidden = HIDDEN_UNICODE.exec(body);
  if (hidden !== null) {
    const codePoint = hidden[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "?";
    matches.push({ rule: "hidden-unicode", excerpt: `U+${codePoint} at offset ${hidden.index}` });
  }

  // Match against a view with invisible characters removed so they cannot split a keyword.
  const visible = body.replace(new RegExp(HIDDEN_UNICODE.source, "gu"), "").normalize("NFKC");
  for (const { rule, pattern } of PATTERNS) {
    const found = pattern.exec(visible);
    if (found === null) continue;
    if (matches.some((m) => m.rule === rule)) continue;
    matches.push({ rule, excerpt: excerptAround(visible, found.index, found[0].length) });
  }

  return { flagged: matches.length > 0, matches };
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}
