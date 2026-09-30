import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

// A parte da API do R2 que o backup usa (put/get/list/delete), gravando numa pasta local.

export class FsBucket {
  private root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  /** Impede que uma chave saia da pasta (ex.: "../"). */
  private path(key: string) {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error("chave inválida");
    return p;
  }

  async put(key: string, value: Uint8Array | ArrayBuffer | string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const data = typeof value === "string" ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    // Grava num temporário e renomeia: um arquivo pela metade nunca aparece com o nome final.
    const tmp = `${p}.tmp-${process.pid}`;
    await writeFile(tmp, data);
    await rename(tmp, p);
    return this.head(key);
  }

  async head(key: string) {
    try {
      const s = await stat(this.path(key));
      return { key, size: s.size, uploaded: s.mtime };
    } catch {
      return null;
    }
  }

  async get(key: string) {
    let data: Buffer;
    try {
      data = await readFile(this.path(key));
    } catch {
      return null;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return {
      key,
      size: bytes.length,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async list(opts: { prefix?: string; cursor?: string } = {}) {
    const prefix = opts.prefix ?? "";
    const objects: { key: string; size: number; uploaded: Date }[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.includes(".tmp-")) {
          const key = relative(this.root, full).split(sep).join("/");
          if (key.startsWith(prefix)) {
            const s = await stat(full);
            objects.push({ key, size: s.size, uploaded: s.mtime });
          }
        }
      }
    };
    await walk(this.root);
    objects.sort((a, b) => a.key.localeCompare(b.key));
    return { objects, truncated: false as const, delimitedPrefixes: [] };
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) await rm(this.path(k), { force: true });
  }

  asR2() {
    return this as unknown as R2Bucket;
  }
}
