import { describe, expect, it } from "vitest";
import { BODY_MAX, displayText, sanitizeProposal, splitDescription, TITLE_MAX } from "@/lib/sanitize";

const body = "Send 400 MDV from the treasury to the marketing multisig for one quarter of ads.";

describe("proposal text sanitising", () => {
  it("accepts ordinary text unchanged", () => {
    expect(sanitizeProposal("Fund the marketing pilot", body)).toEqual({
      ok: true,
      title: "Fund the marketing pilot",
      body,
      removed: 0,
    });
  });

  it("removes bidi overrides, zero-width and tag characters and counts them", () => {
    const hidden = `${body}‮evil‬​\u{E0041}\u{E0042}`;
    const r = sanitizeProposal("Title⁦x⁩", hidden);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toBe(`${body}evil`);
      expect(r.title).toBe("Titlex");
      expect(r.removed).toBe(7);
    }
  });

  it("removes control characters but keeps newlines and tabs, and normalises CRLF", () => {
    const r = sanitizeProposal(
      "A title",
      `Line one\u0007 is long enough here\r\n\tLine two\u0000 also long enough`,
    );
    expect(r.ok && r.body).toBe("Line one is long enough here\n\tLine two also long enough");
  });

  it("collapses runs of blank lines and trailing spaces", () => {
    const r = sanitizeProposal(
      "A title",
      `First paragraph that is long enough.   \n\n\n\n\nSecond paragraph.`,
    );
    expect(r.ok && r.body).toBe("First paragraph that is long enough.\n\nSecond paragraph.");
  });

  it("flattens a multi-line title", () => {
    const r = sanitizeProposal("Two\nlines", body);
    expect(r.ok && r.title).toBe("Two lines");
  });

  it("normalises to NFC so a lookalike decomposition hashes the same as what is shown", () => {
    const r = sanitizeProposal("Café fund", body);
    expect(r.ok && r.title).toBe("Café fund");
  });

  it("enforces the limits after cleaning", () => {
    expect(sanitizeProposal("", body)).toMatchObject({ ok: false, field: "title" });
    expect(sanitizeProposal("12345", body)).toMatchObject({ ok: false, field: "title" });
    expect(sanitizeProposal("x".repeat(TITLE_MAX + 1), body)).toMatchObject({ ok: false, field: "title" });
    expect(sanitizeProposal("Title", "too short")).toMatchObject({ ok: false, field: "body" });
    expect(sanitizeProposal("Title", "y".repeat(BODY_MAX + 1))).toMatchObject({ ok: false, field: "body" });
    expect(sanitizeProposal("Title", `${"​".repeat(10_000)}${body}`)).toMatchObject({
      ok: false,
      field: "body",
    });
    expect(sanitizeProposal(42, body)).toMatchObject({ ok: false, field: "title" });
  });

  it("counts length in code points, not UTF-16 units", () => {
    const emojiFree = "\u{1D400}".repeat(BODY_MAX); // mathematical bold A, two UTF-16 units each
    expect(sanitizeProposal("Title", emojiFree).ok).toBe(true);
  });

  it("keeps markup as literal text (React escapes it when printed)", () => {
    const r = sanitizeProposal("<script>alert(1)</script> grant", `<img src=x onerror=alert(1)> ${body}`);
    expect(r.ok && r.title).toBe("<script>alert(1)</script> grant");
  });

  it("cleans and truncates chain text for display", () => {
    expect(displayText("a‮b").text).toBe("ab");
    expect(displayText("abcdef", 3)).toEqual({ text: "abc", truncated: true, removed: 0 });
  });

  it("splits a governor description into title and body", () => {
    expect(splitDescription("# Community marketing fund\n\nSend 400 MDV.")).toEqual({
      title: "Community marketing fund",
      body: "Send 400 MDV.",
    });
    expect(splitDescription("")).toEqual({ title: "Untitled proposal", body: "" });
  });
});
