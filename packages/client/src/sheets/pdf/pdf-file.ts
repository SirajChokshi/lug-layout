const HEADER = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
const OFFSET_DIGITS = 10;
const GENERATION_DIGITS = 5;
const FREE_GENERATION = 65_535;
const LAST_LATIN1 = 0xff;
const FNV_PRIME = 0x01000193;
const FNV_SEEDS = [0x811c9dc5, 0x050c5d1f, 0x3b9aca07, 0x6c62272e] as const;
const HEX_DIGITS_PER_WORD = 8;
const HEX = 16;
const OCTAL = 8;
const OCTAL_DIGITS = 3;
const FIRST_PRINTABLE = 0x20;
const LAST_ASCII = 0x7e;
const BACKSLASH = 0x5c;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const UTF16_BOM = "FEFF";
const UTF16_UNIT_DIGITS = 4;

export function pdfNumber(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) throw new RangeError(`a PDF can't hold ${value}`);
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes(".") ? fixed.replace(/\.?0+$/u, "") : fixed;
  return trimmed === "-0" ? "0" : trimmed;
}

export function pdfLiteral(bytes: ReadonlyArray<number>): string {
  let out = "(";
  for (const byte of bytes) {
    if (byte === BACKSLASH || byte === OPEN_PAREN || byte === CLOSE_PAREN) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte < FIRST_PRINTABLE || byte > LAST_ASCII) {
      out += `\\${byte.toString(OCTAL).padStart(OCTAL_DIGITS, "0")}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return `${out})`;
}

export function pdfTextString(text: string): string {
  let hex = UTF16_BOM;
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(HEX).toUpperCase().padStart(UTF16_UNIT_DIGITS, "0");
  }
  return `<${hex}>`;
}

function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > LAST_LATIN1)
      throw new RangeError(`a PDF body holds bytes, not U+${code.toString(HEX)}`);
    bytes[i] = code;
  }
  return bytes;
}

function fingerprint(bytes: Uint8Array): string {
  return FNV_SEEDS.map((seed) => {
    let hash = seed;
    for (let i = 0; i < bytes.length; i++) {
      hash = Math.imul(hash ^ (bytes[i] ?? 0), FNV_PRIME) >>> 0;
    }
    return hash.toString(HEX).padStart(HEX_DIGITS_PER_WORD, "0");
  }).join("");
}

export class PdfFile {
  private readonly bodies: Array<string | null> = [];

  reserve(): number {
    this.bodies.push(null);
    return this.bodies.length;
  }

  set(id: number, body: string): void {
    if (this.bodies[id - 1] !== null) throw new Error(`PDF object ${id} is already written`);
    this.bodies[id - 1] = body;
  }

  add(body: string): number {
    const id = this.reserve();
    this.set(id, body);
    return id;
  }

  addStream(content: string): number {
    return this.add(`<< /Length ${latin1Bytes(content).length} >>\nstream\n${content}\nendstream`);
  }

  bytes(root: number, info: number): Uint8Array {
    const parts: string[] = [HEADER];
    const offsets: number[] = [];
    let at = HEADER.length;
    this.bodies.forEach((body, i) => {
      if (body === null) throw new Error(`PDF object ${i + 1} was reserved but never written`);
      const object = `${i + 1} 0 obj\n${body}\nendobj\n`;
      offsets.push(at);
      parts.push(object);
      at += object.length;
    });
    const body = latin1Bytes(parts.join(""));
    const id = fingerprint(body);
    const xref = [
      "xref",
      `0 ${this.bodies.length + 1}`,
      `${"0".repeat(OFFSET_DIGITS)} ${String(FREE_GENERATION)} f\r`,
      ...offsets.map(
        (offset) =>
          `${String(offset).padStart(OFFSET_DIGITS, "0")} ${"0".repeat(GENERATION_DIGITS)} n\r`,
      ),
      "trailer",
      `<< /Size ${this.bodies.length + 1} /Root ${root} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>`,
      "startxref",
      String(at),
      "%%EOF",
      "",
    ].join("\n");
    const tail = latin1Bytes(xref);
    const out = new Uint8Array(body.length + tail.length);
    out.set(body, 0);
    out.set(tail, body.length);
    return out;
  }
}
