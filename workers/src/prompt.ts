import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";
import { keccakBytes } from "./canonical.ts";
import { WORKERS_DIR } from "./config.ts";

export const DEFAULT_PROMPT_FILE = "juror.v1.md";

export interface PromptTemplate {
  /** File name under workers/prompts. */
  file: string;
  /** keccak256 of the file bytes exactly as committed. */
  hash: Hex;
  system: string;
  user: string;
}

export interface PromptInput {
  mandateText: string;
  mandateVersion: string;
  mandateHash: Hex;
  proposalText: string;
}

export interface RenderedPrompt {
  system: string;
  user: string;
  delimiter: string;
}

const SYSTEM_MARKER = "<!-- section:system -->";
const USER_MARKER = "<!-- section:user -->";

export function loadPromptTemplate(file: string = DEFAULT_PROMPT_FILE): PromptTemplate {
  if (!/^[\w.-]+\.md$/.test(file)) throw new Error(`Invalid prompt file name: ${file}`);
  const bytes = readFileSync(resolve(WORKERS_DIR, "prompts", file));
  return { file, hash: keccakBytes(bytes), ...splitTemplate(bytes.toString("utf8")) };
}

export function splitTemplate(text: string): { system: string; user: string } {
  const systemAt = text.indexOf(SYSTEM_MARKER);
  const userAt = text.indexOf(USER_MARKER);
  if (systemAt === -1 || userAt === -1 || userAt < systemAt) {
    throw new Error("Prompt template must contain a system section followed by a user section");
  }
  return {
    system: text.slice(systemAt + SYSTEM_MARKER.length, userAt).trim(),
    user: text.slice(userAt + USER_MARKER.length).trim(),
  };
}

/** A fresh delimiter line per call, so proposal text cannot know or forge it in advance. */
export function randomDelimiter(): string {
  return `<<UNTRUSTED_PROPOSAL_${randomBytes(12).toString("hex")}>>`;
}

/**
 * Fills the template in a single pass, so placeholder-looking text inside the proposal or the mandate is never
 * substituted a second time.
 */
export function renderPrompt(
  template: PromptTemplate,
  input: PromptInput,
  makeDelimiter: () => string = randomDelimiter,
): RenderedPrompt {
  let delimiter = makeDelimiter();
  while (input.proposalText.includes(delimiter)) delimiter = makeDelimiter();
  const values: Record<string, string> = {
    MANDATE_TEXT: input.mandateText.trim(),
    MANDATE_VERSION: input.mandateVersion,
    MANDATE_HASH: input.mandateHash,
    PROPOSAL: input.proposalText,
    DELIMITER: delimiter,
  };
  const user = template.user.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => values[key] ?? whole);
  return { system: template.system, user, delimiter };
}
