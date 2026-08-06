import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

// __dirname is globally available in CommonJS, but if ts-node is running in a way that it's not, 
// we can define a fallback or just trust it.

export async function initDb() {
  const db = await open({
    filename: path.join(__dirname, 'netflop.db'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      startDate TEXT NOT NULL,
      initialBalance INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      memberId TEXT NOT NULL,
      amount INTEGER NOT NULL,
      date TEXT NOT NULL,
      FOREIGN KEY (memberId) REFERENCES members (id)
    );
  `);

  return db;
}
