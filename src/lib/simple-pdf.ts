/**
 * Minimal text-only PDF writer (Helvetica, US Letter). Used for fictional
 * seed documents, test fixtures and draft printouts. Produces a valid PDF 1.4
 * file with a correct cross-reference table so standard parsers can read it.
 */

const WIDTH = 612;
const HEIGHT = 792;
const MARGIN = 54;
const LINE = 14;
const MAX_CHARS = 92;

function escapeText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, "?");
}

function wrap(line: string): string[] {
  if (line.length <= MAX_CHARS) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(" ", MAX_CHARS);
    if (cut <= 0) cut = MAX_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/** Each inner array is one page; long pages flow onto extra pages. */
export function buildPdf(pages: string[][], title = "Document"): Buffer {
  const perPage = Math.floor((HEIGHT - 2 * MARGIN) / LINE);
  const laidOut: string[][] = [];
  for (const page of pages) {
    const lines = page.flatMap(wrap);
    for (let i = 0; i < Math.max(lines.length, 1); i += perPage) laidOut.push(lines.slice(i, i + perPage));
  }

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add(""); // placeholder
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const infoId = add(`<< /Title (${escapeText(title)}) /Producer (EscrowFlow) >>`);
  const pageIds: number[] = [];
  for (const lines of laidOut) {
    const ops = ["BT", "/F1 10 Tf", `${LINE} TL`, `${MARGIN} ${HEIGHT - MARGIN} Td`];
    lines.forEach((l, i) => ops.push(i === 0 ? `(${escapeText(l)}) Tj` : `T* (${escapeText(l)}) Tj`));
    ops.push("ET");
    const stream = ops.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
