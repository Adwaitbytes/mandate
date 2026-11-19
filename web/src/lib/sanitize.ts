/**
 * Proposal text is hostile input twice over: models read it, and this site prints it. Both the visitor's own
 * text and any description read from a governor go through here before display. React escapes markup; this
 * removes the characters that can make printed text say something other than what its bytes say.
 */

// C0 controls except tab and newline, DEL, C1 controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Bidi embeddings, overrides and isolates, marks, zero-width characters, word joiner, BOM, soft hyphen.
const INVISIBLE = /[؜​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
// Unicode tag characters (U+E0000 to U+E007F), used to hide ASCII inside text.
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

export const TITLE_MAX = 120;
export const BODY_MIN = 40;
export const BODY_MAX = 2000;

function strip(text: string): { text: string; removed: number } {
  const normalised = text.normalize("NFC").replace(/\r\n?/g, "\n");
  let removed = 0;
  const count = (m: string) => {
    removed += [...m].length;
    return "";
  };
  const cleaned = normalised.replace(CONTROL, count).replace(INVISIBLE, count).replace(TAGS, count);
  return { text: cleaned, removed };
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const length = (text: string) => [...text].length;

export type ProposalInput =
  | { ok: true; title: string; body: string; removed: number }
  | { ok: false; field: "title" | "body"; error: string };

/** Validates and cleans a visitor's proposal before the relayer files it. */
export function sanitizeProposal(title: unknown, body: unknown): ProposalInput {
  if (typeof title !== "string") return { ok: false, field: "title", error: "Give the proposal a title" };
  if (typeof body !== "string") return { ok: false, field: "body", error: "Write what the proposal does" };
  // Measure before cleaning too, so a huge paste of invisible characters is refused rather than processed.
  if (title.length > TITLE_MAX * 4 || body.length > BODY_MAX * 4) {
    return {
      ok: false,
      field: body.length > BODY_MAX * 4 ? "body" : "title",
      error: "That text is far too long",
    };
  }
  const t = strip(title);
  const b = strip(body);
  const cleanTitle = t.text.replace(/\s+/g, " ").trim();
  const cleanBody = tidy(b.text);
  if (length(cleanTitle) === 0) return { ok: false, field: "title", error: "Give the proposal a title" };
  if (length(cleanTitle) > TITLE_MAX) {
    return { ok: false, field: "title", error: `Keep the title under ${TITLE_MAX} characters` };
  }
  if (!/\p{L}/u.test(cleanTitle)) return { ok: false, field: "title", error: "The title needs some words" };
  if (length(cleanBody) < BODY_MIN) {
    return {
      ok: false,
      field: "body",
      error: `Write at least ${BODY_MIN} characters so the jurors have something to read`,
    };
  }
  if (length(cleanBody) > BODY_MAX) {
    return { ok: false, field: "body", error: `Keep the text under ${BODY_MAX} characters` };
  }
  return { ok: true, title: cleanTitle, body: cleanBody, removed: t.removed + b.removed };
}

/** Cleans text read from chain for display. Truncates rather than refusing, and says so. */
export function displayText(
  text: string,
  max = 20_000,
): { text: string; truncated: boolean; removed: number } {
  const { text: cleaned, removed } = strip(text);
  const tidied = tidy(cleaned);
  const chars = [...tidied];
  if (chars.length <= max) return { text: tidied, truncated: false, removed };
  return { text: chars.slice(0, max).join(""), truncated: true, removed };
}

/** Splits a Governor description into a title (first line, leading # removed) and the rest. */
export function splitDescription(description: string): { title: string; body: string } {
  const { text } = displayText(description);
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).replace(/^#+\s*/, "").trim();
  const rest = newline === -1 ? "" : text.slice(newline + 1).trim();
  return { title: first.length > 0 ? first : "Untitled proposal", body: rest };
}
