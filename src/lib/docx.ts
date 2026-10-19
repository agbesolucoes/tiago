// Leitura do texto de um .docx (Word) sem dependências: o arquivo é um zip, e o texto fica em word/document.xml.
// Usa só DecompressionStream, que existe no navegador, no Node e na Cloudflare.

export class DocxError extends Error {}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

async function inflate(data: Uint8Array) {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Conteúdo de um arquivo dentro do zip, ou null se ele não existir. */
async function readZipEntry(zip: Uint8Array, wanted: string): Promise<Uint8Array | null> {
  // Fim do diretório central: assinatura 0x06054b50 nos últimos 64 KB (o comentário do zip pode vir depois).
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (u32(zip, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new DocxError("o arquivo não é um .docx válido");
  const count = u16(zip, end + 10);
  let p = u32(zip, end + 16);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (u32(zip, p) !== 0x02014b50) break;
    const method = u16(zip, p + 10);
    const size = u32(zip, p + 20);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      if (u32(zip, local) !== 0x04034b50) throw new DocxError("o arquivo não é um .docx válido");
      const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
      const data = zip.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflate(data);
      throw new DocxError("compressão do .docx não suportada");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Texto corrido do XML do Word: parágrafos e linhas de tabela viram quebras de linha. */
export function documentXmlToText(xml: string) {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<\/w:(p|tr)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? m;
    })
    .replace(/[ \t]*\|\s*\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function docxToText(bytes: Uint8Array) {
  const xml = await readZipEntry(bytes, "word/document.xml");
  if (!xml) throw new DocxError("o arquivo não é um .docx válido");
  return documentXmlToText(new TextDecoder().decode(xml));
}
