export class SourceTextCache {
  #entries = new Map();
  #bytes = 0;

  constructor({ maxBytes = 32 * 1024 * 1024, maxEntries = 8 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError("Source cache limits must be nonnegative safe integers.");
    }
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  set(key, fingerprint, text) {
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= previous.text.length * 2;
      this.#entries.delete(key);
    }
    // UTF-16 accounting bounds text even when V8 stores ASCII more compactly.
    const bytes = text.length * 2;
    if (bytes > this.maxBytes || this.maxEntries === 0) return;
    while (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      this.#bytes -= this.#entries.get(oldest).text.length * 2;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, Object.freeze({ fingerprint, text }));
    this.#bytes += bytes;
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }
}
