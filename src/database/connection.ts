import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dbPath = process.env.DATABASE_PATH ?? "./data/kyrara.db";
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");