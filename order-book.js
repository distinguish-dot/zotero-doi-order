/* Ordering metadata only. This module never changes Zotero items. */
var DOIOrderBook = (() => {
  function normalize(value) {
    let text = String(value || "").trim();
    try { text = decodeURIComponent(text); } catch (_) {}
    const match = text.match(/10\.\d{4,9}\/[^\s|]+/i);
    if (!match) return "";
    text = match[0].replace(/[.,;，。；]+$/, "");
    while (text.endsWith(")") && (text.match(/\)/g) || []).length > (text.match(/\(/g) || []).length) text = text.slice(0, -1);
    return text.toLowerCase();
  }
  function normalizeURL(value) {
    try {
      const url = new URL(String(value).trim());
      if (!['https:', 'http:'].includes(url.protocol)) return "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return (url.host.toLowerCase().replace(/^www\./, "") + decodeURIComponent(url.pathname)).replace(/\/$/, "") + url.search;
    } catch (_) { return ""; }
  }
  function titleKey(value) {
    return String(value || "").replace(/<[^>]+>/g, " ").normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }
  function field(item, name) {
    try { return item.getField(name) || ""; } catch (_) { return ""; }
  }
  function unique(values) { return [...new Set(values.map(normalize).filter(Boolean))]; }
  function entry(value) {
    if (typeof value === 'string') value = { doi: normalize(value) };
    const doi = normalize(value.doi);
    const url = normalizeURL(value.url) ? String(value.url) : "";
    const title = String(value.title || "").trim();
    const citation = String(value.citation || "").trim();
    const id = doi ? 'doi:' + doi : url ? 'url:' + normalizeURL(url) : 'ref:' + titleKey(title || citation);
    if (id === 'ref:') throw new Error('Empty reference entry');
    const number = Number(value.number);
    return { id, doi, url, title, citation, number: Number.isSafeInteger(number) && number > 0 ? number : null };
  }
  function parseList(text, extractIdentifiers) {
    const output = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const prefix = line.match(/^(?:\[(\d+)\]\s*|(\d+)[.)、：:]\s+)/);
      const number = prefix ? Number(prefix[1] || prefix[2]) : null;
      const body = prefix ? line.slice(prefix[0].length) : line;
      const pieces = body.split(/\s*\|\s*/);
      const title = pieces.length > 1 ? pieces.slice(1).join(' | ') : '';
      const ids = extractIdentifiers(body).filter(id => id.DOI);
      if (ids.length) {
        ids.forEach((id, index) => output.push(entry({ doi: id.DOI, title,
          number: number === null ? null : number + index, citation: body })));
        continue;
      }
      const url = body.match(/https?:\/\/[^\s|]+/i)?.[0].replace(/[.,;，。；]+$/, '') || '';
      if (url || (number && body.length >= 25)) output.push(entry({ url, title, citation: body, number }));
    }
    return output;
  }
  class Book {
    constructor(serialized = '') {
      this.data = { version: 2, scopes: {} };
      if (serialized) {
        const data = JSON.parse(serialized);
        if (![1, 2].includes(data.version) || !data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) throw new Error('Unsupported ordering data');
        for (const [scope, record] of Object.entries(data.scopes)) {
          if (!record.bindings || typeof record.bindings !== 'object' || Array.isArray(record.bindings)
            || typeof record.enabled !== 'boolean') throw new Error('Invalid ordering data');
          let entries;
          if (data.version === 1) {
            if (!Array.isArray(record.dois) || !record.dois.every(x => typeof x === 'string')) throw new Error('Invalid ordering data');
            entries = unique(record.dois).map((doi, index) => entry({ doi, number: index + 1 }));
          } else {
            if (!Array.isArray(record.entries)) throw new Error('Invalid ordering data');
            entries = record.entries.map(entry);
          }
          this.data.scopes[scope] = { entries, dois: entries.filter(e => e.doi).map(e => e.doi),
            bindings: Object.fromEntries(Object.entries(record.bindings).map(([key, id]) =>
              [key, data.version === 1 ? 'doi:' + normalize(id) : id])), enabled: record.enabled };
          if (record.manualKeys !== undefined) {
            if (!Array.isArray(record.manualKeys) || !record.manualKeys.every(key => typeof key === 'string' && key)
              || new Set(record.manualKeys).size !== record.manualKeys.length
              || typeof record.manualDrag !== 'boolean') throw new Error('Invalid manual ordering data');
            Object.assign(this.data.scopes[scope], { manualKeys: [...record.manualKeys], manualDrag: record.manualDrag });
          }
        }
      }
      this.cache = new Map();
    }
    record(scope) { return this.data.scopes[scope]; }
    remember(scope, values, replace = false) {
      if (!scope) throw new Error('No collection or library selected');
      const input = values.map(entry);
      if (!input.length) throw new Error('No reference found');
      const old = this.record(scope) || { entries: [], bindings: {}, enabled: true };
      const entries = replace ? [] : old.entries.map(e => ({ ...e }));
      const used = new Map(entries.map(e => [e.id, e]));
      let next = Math.max(0, ...entries.map(e => e.number || 0));
      for (const item of input) {
        if (used.has(item.id)) {
          const existing = used.get(item.id);
          if (item.title) existing.title = item.title;
          continue;
        }
        const number = replace && item.number ? item.number : next + 1;
        if (entries.some(e => e.number === number)) throw new Error('Reference list contains duplicate numbers');
        const added = { ...item, number };
        entries.push(added); used.set(added.id, added); next = Math.max(next, number);
      }
      this.data.scopes[scope] = { entries, dois: entries.filter(e => e.doi).map(e => e.doi),
        bindings: { ...old.bindings }, enabled: true };
      this.cache.delete(scope);
      return values.every(v => typeof v === 'string') ? unique(values) : input;
    }
    candidates(reference, items) {
      const regular = items.filter(item => !item.parentItemID && item.isRegularItem?.());
      if (reference.doi) return regular.filter(item => normalize(field(item, 'DOI')) === reference.doi);
      const url = normalizeURL(reference.url);
      const byURL = url ? regular.filter(item => normalizeURL(field(item, 'url')) === url) : [];
      if (byURL.length) return byURL;
      const title = titleKey(reference.title);
      const citation = titleKey(reference.citation);
      const byTitle = regular.filter(item => {
        const candidate = titleKey(field(item, 'title'));
        return candidate.length >= 15 && (title ? candidate === title : citation.includes(candidate));
      });
      return byTitle.length === 1 ? byTitle : [];
    }
    bind(scope, items) {
      const record = this.record(scope);
      if (!record) return;
      for (const item of items) if (item.key) delete record.bindings[item.key];
      for (const reference of record.entries) {
        for (const item of this.candidates(reference, items)) if (item.key) record.bindings[item.key] = reference.id;
      }
    }
    rank(scope, item) {
      const record = this.record(scope);
      if (!record || item.parentItemID || !item.isRegularItem?.()) return 0;
      if (record.manualKeys) {
        const index = record.manualKeys.indexOf(item.key);
        return index < 0 ? 0 : index + 1;
      }
      if (!this.cache.has(scope)) this.cache.set(scope, new Map(record.entries.map(e => [e.id, e.number])));
      const ranks = this.cache.get(scope);
      return ranks.get(record.bindings[item.key]) || ranks.get('doi:' + normalize(field(item, 'DOI'))) || 0;
    }
    missing(scope, values, items) {
      const record = this.record(scope);
      return values.filter(value => {
        const reference = entry(value);
        return !this.candidates(reference, items).length && !items.some(item =>
          !item.parentItemID && item.isRegularItem?.() && record?.bindings[item.key] === reference.id);
      });
    }
    serialize() { return JSON.stringify(this.data); }
    beginManual(scope, items) {
      if (!scope) throw new Error('No collection or library selected');
      const record = this.record(scope) || { entries: [], dois: [], bindings: {}, enabled: true };
      const keys = [...new Set(items.filter(item => !item.parentItemID && item.isRegularItem?.())
        .map(item => item.key).filter(Boolean))];
      // Retain hidden/stale keys so filtering or a temporary absence cannot erase order.
      record.manualKeys = [...keys, ...(record.manualKeys || []).filter(key => !keys.includes(key))];
      record.manualDrag = true;
      record.enabled = true;
      this.data.scopes[scope] = record;
    }
    moveManual(scope, keys, target, after) {
      const record = this.record(scope);
      if (!record?.manualDrag || !record.manualKeys?.includes(target)) return false;
      const selected = new Set(keys);
      if (!selected.size || selected.has(target) || [...selected].some(key => !record.manualKeys.includes(key))) return false;
      const moving = record.manualKeys.filter(key => selected.has(key));
      const rest = record.manualKeys.filter(key => !selected.has(key));
      rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, ...moving);
      if (rest.every((key, index) => key === record.manualKeys[index])) return false;
      record.manualKeys = rest;
      return true;
    }
    restoreList(scope) {
      const record = this.record(scope);
      if (!record) return;
      delete record.manualKeys;
      delete record.manualDrag;
      record.enabled = true;
    }
  }
  return { Book, normalize, normalizeURL, titleKey, unique, parseList };
})();
if (typeof module !== 'undefined') module.exports = DOIOrderBook;
