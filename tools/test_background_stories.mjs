import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const dataPath = require.resolve("../铺面查看器/player/static/background-stories-data.js");
const storiesPath = require.resolve("../铺面查看器/player/static/background-stories.js");
const builtInCatalog = require(dataPath);
const serialTest = (name, fn) => test(name, {concurrency: false}, fn);

function freshStories() {
  delete require.cache[storiesPath];
  return require(storiesPath);
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  focus() {}
  showModal() { this.open = true; }
  close() {
    this.open = false;
    this.dispatch("close");
  }
  querySelector(selector) {
    if (selector.includes(" ")) {
      const [parentSelector, childSelector] = selector.split(/\s+/, 2);
      return this.querySelector(parentSelector)?.querySelector(childSelector) ?? null;
    }
    const matches = node => {
      if (selector.startsWith(".")) return node.className.split(/\s+/).includes(selector.slice(1));
      if (selector.startsWith("#")) return node.id === selector.slice(1);
      return node.tagName === selector.toUpperCase();
    };
    for (const child of this.children) {
      if (matches(child)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function installHarness(t, {fetchImpl, song = null, withDocument = false} = {}) {
  const previousCatalog = globalThis.JUBEAT_BACKGROUND_STORIES;
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;

  globalThis.JUBEAT_BACKGROUND_STORIES = builtInCatalog;
  globalThis.fetch = fetchImpl;
  if (withDocument) {
    globalThis.document = {
      body: new FakeElement("body"),
      createElement: tagName => new FakeElement(tagName),
      getElementById: id => id === button.id ? button : null,
    };
  }

  const button = new FakeElement("button");
  button.id = "btnBackgroundStory";
  button.hidden = true;
  button.disabled = true;
  const app = {
    state: {song},
    els: {btnBackgroundStory: button},
    visitors: {event() {}},
    resourcePath: path => path,  // real app-base.js resolves deployment prefixes
  };
  const Stories = freshStories();

  t.after(() => {
    if (previousCatalog === undefined) delete globalThis.JUBEAT_BACKGROUND_STORIES;
    else globalThis.JUBEAT_BACKGROUND_STORIES = previousCatalog;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    delete require.cache[storiesPath];
  });

  return {Stories, app, button};
}

function externalCatalog() {
  const id = "arcade_99999999";
  return {
    schemaVersion: 2,
    sourceDocuments: 1,
    documentCount: 1,
    mappedDocumentCount: 1,
    unresolvedCount: 0,
    records: {
      [id]: {
        id,
        documents: [{
          title: "外部资料",
          source: "external.md",
          sourceVersion: "jubeat",
          fields: [],
          sections: [{title: "背景知识", text: "来自离线曲库的外部故事。"}],
        }],
      },
    },
    unresolvedDocuments: [],
  };
}

serialTest("looks up background data only by stable song ID", t => {
  const {Stories} = installHarness(t);
  const catalog = globalThis.JUBEAT_BACKGROUND_STORIES;
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.sourceDocuments, 16);
  assert.equal(catalog.documentCount, 2449);
  assert.equal(catalog.mappedDocumentCount, 2437);
  assert.equal(catalog.unresolvedCount, 12);
  assert.equal(catalog.documentCount, catalog.mappedDocumentCount + catalog.unresolvedCount);
  assert.equal(Stories.recordFor("C032"), null);
  assert.equal(Stories.recordFor("jubeatchina_991000006"), null);
  assert.equal(Stories.recordFor("arcade_11000068").documents[0].title, "fallen leaves");
  assert.equal(Stories.recordFor({id:"arcade_11000163"}).documents[0].title, "Devil’s Rule");
  assert.equal(
    Stories.recordFor({id:"jubeat/首次收录/arcade_11000068"}).documents[0].title,
    "fallen leaves",
  );
  assert.equal(
    Stories.recordFor("jubeat-festo/首次收录/arcade_11000163").documents[0].title,
    "Devil’s Rule",
  );
  assert.equal(
    Stories.recordFor("jubeat-plus/首次收录/16_jubeat_plus_100000712").documents[0].title,
    "Endless Chain～2人でトリガーをひこう～ The second term",
  );
  assert.equal(
    Stories.recordFor("jubeat-china/首次收录/jubeatchina_990000001").documents[0].title,
    "Dash Dash Groovy Rush!!!",
  );
  assert.equal(
    Stories.recordFor("音乐魔方/C017 Celestial Axis").documents[0].title,
    "Celestial Axis",
  );
  assert.equal(Stories.recordFor("fallen leaves"), null);
  assert.equal(Stories.recordFor(""), null);
  assert.equal(Stories.recordFor(null), null);
  for (const item of catalog.unresolvedDocuments) {
    assert.equal(Stories.recordFor(item.id || ""), null);
  }
});

serialTest("checked-in catalog keeps every document and caveat", t => {
  const {Stories} = installHarness(t);
  const record = Stories.recordFor("arcade_11000068");
  assert.equal(record.documents.length, 1);
  const sections = new Map(record.documents[0].sections.map(item => [item.title, item.text]));
  assert.match(sections.get("背景知识"), /猫叉Master/);
  assert.ok(sections.has("资料来源"));
  assert.match(sections.get("核验边界"), /核|来源|停止|403|412/);
});

serialTest("independent [ 2 ] chart keeps its full research article", t => {
  const {Stories} = installHarness(t);
  const record = Stories.recordFor("arcade_11001003");
  assert.equal(record.documents[0].title, "New Decade [ 2 ]");
  const sections = new Map(record.documents[0].sections.map(item => [item.title, item.text]));
  assert.match(sections.get("背景知识"), /HOLD/);
  assert.ok(sections.get("背景知识").length > 200);
});

serialTest("button visibility follows the song and recording mode", t => {
  const {Stories, app, button} = installHarness(t, {withDocument: true});

  Stories.install(app, {loadExternal: false});
  assert.equal(button.hidden, true);
  assert.equal(button.disabled, true);

  const knownSong = {
    id: "jubeat/首次收录/arcade_11000068",
    title: "fallen leaves",
    artist: "猫叉Master",
  };
  app.state.song = knownSong;
  Stories.select(knownSong);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);

  button.dispatch("click");
  const dialog = globalThis.document.body.querySelector(".story-dialog");
  assert.equal(dialog.open, true);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  const noStorySong = {id: "not-in-the-catalog", title: "No Story", artist: "Unknown"};
  app.state.song = noStorySong;
  Stories.select(noStorySong);
  assert.equal(button.hidden, true);
  assert.equal(button.disabled, true);
  assert.equal(dialog.open, false);

  globalThis.__recActive = true;
  app.state.song = knownSong;
  Stories.select(knownSong);
  assert.equal(button.hidden, true);
  assert.equal(button.disabled, true);
  button.dispatch("click");
  assert.equal(dialog.open, false);
  globalThis.__recActive = false;
});

serialTest("valid external catalog merges into the built-in catalog and updates lookup", async t => {
  const catalog = externalCatalog();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    return {ok: true, json: async () => catalog};
  };
  const song = {id: "jubeat/首次收录/arcade_99999999", title: "外部曲目", artist: "测试作者"};
  const {Stories, app, button} = installHarness(t, {song});

  Stories.install(app, {loadExternal: false});
  assert.equal(calls.length, 0);
  assert.equal(Stories.recordFor(song), null);
  assert.equal(button.hidden, true);

  globalThis.fetch = fetchImpl;
  await Stories.loadExternalCatalog();
  assert.deepEqual(calls, [{url: "data/background-stories.json", options: {cache: "no-cache"}}]);
  // External catalogs are an optional delta: built-in 2430 records must survive,
  // external records are merged in by id.
  const merged = globalThis.JUBEAT_BACKGROUND_STORIES;
  assert.equal(merged.schemaVersion, 2);
  assert.equal(merged.records.arcade_99999999, catalog.records.arcade_99999999);
  assert.ok(Object.keys(merged.records).length > 1);
  assert.ok(Stories.recordFor("arcade_11000068"), "built-in lookup must survive the merge");
  assert.equal(Stories.recordFor("arcade_99999999").documents[0].title, "外部资料");
  assert.equal(Stories.recordFor(song).documents[0].sections[0].text, "来自离线曲库的外部故事。");
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
});

serialTest("failed external fetch keeps the built-in catalog", async t => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const song = {id: "jubeat/首次收录/arcade_11000068", title: "fallen leaves", artist: "猫叉Master"};
  const {Stories, app, button} = installHarness(t, {song});

  Stories.install(app, {loadExternal: false});
  assert.equal(button.hidden, false);
  globalThis.fetch = fetchImpl;
  await Stories.loadExternalCatalog();
  assert.equal(globalThis.JUBEAT_BACKGROUND_STORIES, builtInCatalog);
  assert.equal(Stories.recordFor("arcade_11000068").documents[0].title, "fallen leaves");
  assert.equal(button.hidden, false);
});

serialTest("invalid external catalogs keep the built-in catalog", async t => {
  const invalidCatalogs = {
    "wrong schema": {...externalCatalog(), schemaVersion: 1},
    "records array": {...externalCatalog(), records: []},
    "record id mismatch": (() => {
      const catalog = externalCatalog();
      catalog.records.arcade_99999999.id = "arcade_other";
      return catalog;
    })(),
    "missing documents": (() => {
      const catalog = externalCatalog();
      catalog.records.arcade_99999999.documents = [];
      return catalog;
    })(),
    "invalid section text": (() => {
      const catalog = externalCatalog();
      catalog.records.arcade_99999999.documents[0].sections[0].text = 42;
      return catalog;
    })(),
  };

  for (const [name, catalog] of Object.entries(invalidCatalogs)) {
    await t.test(name, async t => {
      const fetchImpl = async () => ({ok: true, json: async () => catalog});
      const song = {id: "jubeat/首次收录/arcade_11000068", title: "fallen leaves", artist: "猫叉Master"};
      const {Stories, app, button} = installHarness(t, {song});
      Stories.install(app, {loadExternal: false});
      assert.equal(button.hidden, false);
      globalThis.fetch = fetchImpl;
      await Stories.loadExternalCatalog();
      assert.equal(globalThis.JUBEAT_BACKGROUND_STORIES, builtInCatalog);
      assert.equal(Stories.recordFor("arcade_11000068").documents[0].title, "fallen leaves");
      assert.equal(Stories.recordFor("arcade_99999999"), null);
      assert.equal(button.hidden, false);
    });
  }
});
