import { displayText } from "@/lib/sanitize";

type Block =
  | { kind: "h"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ol"; items: { n: number; text: string }[] };

/** Reads the mandate's plain Markdown subset (headings, numbered rules, paragraphs) into blocks. Text only. */
export function parseMandate(source: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of displayText(source).text.split(/\n{2,}/)) {
    const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    if (lines.every((l) => /^\d+\.\s/.test(l))) {
      blocks.push({
        kind: "ol",
        items: lines.map((l) => {
          const m = /^(\d+)\.\s+(.*)$/.exec(l);
          return { n: Number(m?.[1] ?? 0), text: m?.[2] ?? l };
        }),
      });
    } else if (lines.length === 1 && /^#{1,6}\s/.test(lines[0] ?? "")) {
      blocks.push({ kind: "h", text: (lines[0] ?? "").replace(/^#+\s*/, "") });
    } else {
      blocks.push({ kind: "p", text: lines.join(" ") });
    }
  }
  return blocks;
}

export function MandateText({ source }: { source: string }) {
  return (
    <>
      {parseMandate(source).map((b, i) => {
        const key = `${b.kind}-${i}`;
        if (b.kind === "h") return <h2 key={key}>{b.text}</h2>;
        if (b.kind === "p") return <p key={key}>{b.text}</p>;
        return (
          <ol key={key} start={b.items[0]?.n ?? 1}>
            {b.items.map((it) => (
              <li key={it.n}>{it.text}</li>
            ))}
          </ol>
        );
      })}
    </>
  );
}
