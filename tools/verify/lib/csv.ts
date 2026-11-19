/** RFC 4180 CSV: quoted fields may hold commas, quotes (doubled) and newlines. The first row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header, ...rows] = records;
  if (header === undefined) return [];
  return rows.map((cells, n) => {
    if (cells.length !== header.length) {
      throw new Error(`CSV row ${n + 2} has ${cells.length} cells, header has ${header.length}`);
    }
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}
