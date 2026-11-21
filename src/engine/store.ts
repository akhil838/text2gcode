/** IndexedDB persistence: uploaded font files and cached glyph-sheet conversions. */
import type { ConvertOptions } from "./convert";
import type { StrokeFont } from "./output";

export interface StoredFont {
  id: string;
  filename: string;
  /** Display name; defaults to the name inside the font (or the file name for .jhf). */
  name?: string;
  bytes: Uint8Array;
  options: ConvertOptions;
  added: number;
}

interface StoredSheet {
  key: string; // `${fontId}|${options json}`
  fontId: string;
  font: StrokeFont;
}

// Storage names use "ttf2hershey"; changing them would orphan fonts and pages already saved in users' browsers.
const DB_NAME = "ttf2hershey";
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("fonts", { keyPath: "id" });
      d.createObjectStore("sheets", { keyPath: "key" }).createIndex("fontId", "fontId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(store: "fonts" | "sheets", mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = op(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
  });
}

export const store = {
  fonts: () => run<StoredFont[]>("fonts", "readonly", (s) => s.getAll()),
  putFont: (f: StoredFont) => run<void>("fonts", "readwrite", (s) => s.put(f)),
  async removeFont(id: string) {
    await run<void>("fonts", "readwrite", (s) => s.delete(id));
    const keys = await run<IDBValidKey[]>("sheets", "readonly", (s) => s.index("fontId").getAllKeys(id));
    for (const key of keys) await run<void>("sheets", "readwrite", (s) => s.delete(key));
  },
  sheet: (key: string) => run<StoredSheet | undefined>("sheets", "readonly", (s) => s.get(key)),
  putSheet: (sheet: StoredSheet) => run<void>("sheets", "readwrite", (s) => s.put(sheet)),
};
