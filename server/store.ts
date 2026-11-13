// The local index: a cache that can always be rebuilt from the files and GitHub. Deleting the
// data directory is safe. node:sqlite is built in, so there is nothing native to compile.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class Store {
  readonly db: DatabaseSync

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'index.sqlite'))
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists cache (key text primary key, json text not null, fetched_at text not null);
    `)
  }

  get<T>(key: string): { value: T; fetchedAt: string } | null {
    const row = this.db.prepare('select json, fetched_at from cache where key = ?').get(key) as { json: string; fetched_at: string } | undefined
    if (!row) return null
    try {
      return { value: JSON.parse(row.json) as T, fetchedAt: row.fetched_at }
    } catch {
      return null
    }
  }

  put(key: string, value: unknown, fetchedAt = new Date().toISOString()) {
    this.db.prepare('insert into cache (key, json, fetched_at) values (?, ?, ?) on conflict(key) do update set json = excluded.json, fetched_at = excluded.fetched_at').run(key, JSON.stringify(value), fetchedAt)
  }

  close() {
    this.db.close()
  }
}
