import { compileWikiPages } from "../src/wiki-compiler.js";
import Database from "better-sqlite3";
import { resolve } from "path";
import { homedir } from "os";

const dbPath = resolve(homedir(), ".prime/prime.db");
const db = new Database(dbPath);

try {
  const result = await compileWikiPages(db);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("ERROR:", err);
} finally {
  db.close();
}
