
/** Check runtime line numbering against real corpus text and a CRLF fixture. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const root = path.join(__dirname, "..");
  const search = await import(pathToFileURL(path.join(root, "lib", "search.js")).href);
  const docs = await import(pathToFileURL(path.join(root, "lib", "docs.js")).href);
  const dataDir = path.join(root, "data");
  const realCorpus = search.findCorpusRoot(root);
  const sample = "entities/api/not-exposed.md";
  const sourcePath = path.join(realCorpus, sample);
  const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "vrchat-crlf-"));
  try {
    const fixturePath = path.join(fixture, sample);
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, source.replace(/\n/g, "\r\n"));
    assert.ok(fs.readFileSync(fixturePath, "utf8").includes("\r\n"));
    for (const corpus of [realCorpus, fixture]) {
      const store = search.createStore(dataDir, corpus);
      assert.equal(store.bodyOf(sample), source);
      const hits = docs.grepPages([sample], store.bodyOf, "Udon", { maxMatches: 5 });
      assert.ok(hits.ok && hits.matches.length > 0 && !hits.text.includes("\r"));
      const hit = hits.matches[0];
      const page = docs.readPage(store.bodyOf, [sample], hit.path, hit.lineNumber, 1);
      assert.ok(page.ok && !page.text.includes("\r"));
      assert.equal(page.lines[0].number, hit.lineNumber);
      assert.equal(page.lines[0].text, source.split("\n")[hit.lineNumber - 1]);
    }
    console.log("PASS · 发布语料与 CRLF 夹具行号一致");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
