import "fake-indexeddb/auto";

(globalThis as { self?: unknown }).self ??= globalThis;
(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {};
(globalThis as { removeEventListener?: unknown }).removeEventListener ??=
  () => {};

if (!("localStorage" in globalThis)) {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: ((event: { target: NodeFileReader }) => void) | null = null;

  readAsArrayBuffer(blob: Blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.({ target: this });
    });
  }

  readAsBinaryString(blob: Blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = Buffer.from(buffer).toString("binary");
      this.onloadend?.({ target: this });
    });
  }
}

(globalThis as { FileReader?: unknown }).FileReader ??= NodeFileReader;
