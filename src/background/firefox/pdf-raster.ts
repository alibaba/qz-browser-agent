/** Wrap JPEG bitmaps in one PDF. Each image is one page, sized in points from the bitmap. */

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]);

export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9) return null;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (SOF_MARKERS.has(marker)) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function jpegsToPdf(images: readonly Uint8Array[], note = ""): Uint8Array {
  if (!images.length) throw new Error("PDF raster has no pages");
  const pages = images.map(image => {
    const size = jpegSize(image);
    if (!size) throw new Error("PDF raster JPEG is missing its size");
    return { image, ...size };
  });
  const caption = note.trim();
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  const add = (bytes: Uint8Array) => {
    parts.push(bytes);
    cursor += bytes.length;
  };
  const addText = (text: string) => add(encoder.encode(text));
  const startObject = (id: number) => {
    offsets[id] = cursor;
    addText(`${id} 0 obj\n`);
  };
  const endObject = () => addText("\nendobj\n");
  addText("%PDF-1.4\n");
  const imageCount = pages.length;
  const count = imageCount + (caption ? 1 : 0);
  const pageId = (index: number) => 3 + index;
  const contentId = (index: number) => 3 + count + index;
  const imageId = (index: number) => 3 + count * 2 + index;
  const fontId = 3 + count * 2 + imageCount;
  startObject(1);
  addText("<< /Type /Catalog /Pages 2 0 R >>");
  endObject();
  startObject(2);
  const kids = Array.from({ length: count }, (_value, index) => `${pageId(index)} 0 R`).join(" ");
  addText(`<< /Type /Pages /Count ${count} /Kids [${kids}] >>`);
  endObject();
  pages.forEach((page, index) => {
    startObject(pageId(index));
    addText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${contentId(index)} 0 R /Resources << /XObject << /Im0 ${imageId(index)} 0 R >> >> >>`);
    endObject();
  });
  pages.forEach((page, index) => {
    const content = `q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`;
    startObject(contentId(index));
    addText(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
    endObject();
  });
  pages.forEach((page, index) => {
    startObject(imageId(index));
    addText(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`);
    add(page.image);
    addText("\nendstream");
    endObject();
  });
  if (caption) {
    const noteIndex = imageCount;
    startObject(pageId(noteIndex));
    addText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 120] /Contents ${contentId(noteIndex)} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    endObject();
    const content = `BT /F1 12 Tf 36 70 Td (${pdfEscape(caption)}) Tj ET`;
    startObject(contentId(noteIndex));
    addText(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
    endObject();
    startObject(fontId);
    addText("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    endObject();
  }
  const xref = cursor;
  const size = caption ? fontId + 1 : 3 + imageCount * 3;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) table += `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`;
  addText(`${table}trailer << /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const out = new Uint8Array(cursor);
  let written = 0;
  for (const part of parts) {
    out.set(part, written);
    written += part.length;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (first << 16) | (second << 8) | third;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    out += index + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return out;
}
