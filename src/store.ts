import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Change } from './github.js';
import type { ModelMessage } from '@tanstack/ai';
export type AgentRun = { id: string; key: string; provider: string; model: string; status: string; messages: ModelMessage[]; error: string | null; created: number; updated: number };

export type Conversation = { key: string; session_id: string; turn_id: string | null; touched: number };
export type Proposal = { id: string; channel_id: string; guild_id: string; requester: string; change: Change; status: string; created: number; result: string | null };
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, touched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, guild_id TEXT NOT NULL, requester TEXT NOT NULL, change TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, messages TEXT NOT NULL, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_runs_key_created ON agent_runs(key, created);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, proposal_id TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, created INTEGER NOT NULL);
    `);
    // A process crash may happen after GitHub accepted a write. Never execute these again.
    this.db.exec("UPDATE proposals SET status='unknown' WHERE status='executing'");
    this.db.exec("UPDATE agent_runs SET status='interrupted', error='Erga restarted during this request. Inspect recorded changes before repeating work.' WHERE status='running'");
  }
  saveRun(run: AgentRun) {
    this.db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, messages=excluded.messages, error=excluded.error, updated=excluded.updated')
      .run(run.id, run.key, run.provider, run.model, run.status, JSON.stringify(run.messages), run.error, run.created, Date.now());
  }
  recentRuns(key: string, limit = 10): AgentRun[] {
    return this.db.prepare('SELECT * FROM agent_runs WHERE key=? ORDER BY created DESC, rowid DESC LIMIT ?').all(key, limit)
      .map(row => ({ ...row, messages: JSON.parse(row.messages as string) }) as AgentRun);
  }
  clearRuns(key: string) { this.db.prepare('DELETE FROM agent_runs WHERE key=?').run(key); }
  expireRuns(before: number) { this.db.prepare("DELETE FROM agent_runs WHERE updated<? AND status!='running'").run(before); }
  conversation(key: string) { return this.db.prepare('SELECT * FROM conversations WHERE key=?').get(key) as Conversation | undefined; }
  saveConversation(key: string, session: string, turn: string | null = null) {
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET session_id=excluded.session_id, turn_id=excluded.turn_id, touched=excluded.touched').run(key, session, turn, Date.now());
  }
  forget(key: string) { this.db.prepare('DELETE FROM conversations WHERE key=?').run(key); }
  expired(before: number) { return this.db.prepare('SELECT * FROM conversations WHERE touched < ?').all(before) as Conversation[]; }
  claimRequest(id: string) { return this.db.prepare('INSERT OR IGNORE INTO requests VALUES(?,?)').run(id, Date.now()).changes === 1; }
  call(id: string): { success: boolean; output?: string; error?: string } | undefined {
    const row = this.db.prepare('SELECT result FROM calls WHERE id=?').get(id);
    return row ? JSON.parse(row.result as string) : undefined;
  }
  saveCall(id: string, result: unknown) { this.db.prepare('INSERT OR REPLACE INTO calls VALUES(?,?)').run(id, JSON.stringify(result)); }
  propose(channel: string, guild: string, requester: string, change: Change, id: string = randomUUID()) {
    this.db.prepare('INSERT OR IGNORE INTO proposals VALUES(?,?,?,?,?,?,?,?)').run(id, channel, guild, requester, JSON.stringify(change), 'pending', Date.now(), null);
    return this.proposal(id)!;
  }
  proposal(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
    return row ? { ...row, change: JSON.parse(row.change as string) } as Proposal : undefined;
  }
  claimProposal(id: string) {
    return this.db.prepare("UPDATE proposals SET status='executing' WHERE id=? AND status='pending' AND created>?").run(id, Date.now() - 15 * 60_000).changes === 1;
  }
  cancelProposal(id: string) { return this.db.prepare("UPDATE proposals SET status='cancelled' WHERE id=? AND status='pending'").run(id).changes === 1; }
  finishProposal(id: string, status: string, result: string) { this.db.prepare('UPDATE proposals SET status=?, result=? WHERE id=?').run(status, result, id); }
  audit(id: string, actor: string, event: string) { this.db.prepare('INSERT INTO audit(proposal_id,actor,event,created) VALUES(?,?,?,?)').run(id, actor, event, Date.now()); }
  close() { this.db.close(); }
}
