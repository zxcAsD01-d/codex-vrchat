
import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createStore, findCorpusRoot } from "./search.js";
import { grepPages } from "./docs.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const store = createStore(join(root, "data"), findCorpusRoot(root));
const { pattern, include } = workerData;
parentPort.postMessage(grepPages(store.index.map((entry) => entry.path), store.bodyOf, pattern, { include }));
