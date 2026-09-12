import { createHash } from 'node:crypto';
import { mayDelete, mayRead, mayWrite, PublicError, safeError, type Actor, type Config } from './config.js';
import { changeSchema, GitHub, GitHubError } from './github.js';
import { Store } from './store.js';

export class Changes {
  constructor(private config: Config, private store: Store, private github: GitHub) {}
  async execute(raw: unknown, actor: Actor, callKey: string) {
    const change = changeSchema.parse(raw);
    this.github.repo(change.repository);
    const permitted = change.operation.startsWith('delete_') ? mayDelete(this.config, actor) : mayWrite(this.config, actor);
    if (!permitted) throw new PublicError('Your Discord roles do not permit this change. Ask a teammate with the appropriate role.');
    // Keep a durable ledger before writing, including across a crash before tool-result storage.
    const id = createHash('sha256').update(callKey).digest('hex').slice(0, 24);
    this.store.propose(actor.channelId, actor.guildId, actor.userId, change, id);
    const p = this.get(id, actor);
    if (p.requester !== actor.userId || JSON.stringify(p.change) !== JSON.stringify(change)) throw new PublicError('This tool call is already associated with a different request.');
    if (p.status === 'applied') return this.outcome(p.id, p.change.operation, JSON.parse(p.result!));
    if (!this.store.claimProposal(id)) throw new PublicError(`This change has expired or is already ${this.store.proposal(id)?.status}. Check GitHub before requesting another.`);
    this.store.audit(id, actor.userId, 'requested');
    try {
      const result = await this.github.change(p.change);
      if (p.change.operation === 'merge_pull_request' && result.merged !== true) throw new PublicError('GitHub did not confirm that the PR was merged.');
      const summary = JSON.stringify(result);
      this.store.finishProposal(id, 'applied', summary);
      this.store.audit(id, actor.userId, 'applied');
      return this.outcome(id, p.change.operation, result);
    } catch (error) {
      // HTTP rejection is definitive; lost responses and server errors are ambiguous.
      const status = error instanceof GitHubError && error.status < 500 ? 'failed' : 'unknown';
      this.store.finishProposal(id, status, safeError(error));
      this.store.audit(id, actor.userId, status);
      throw new PublicError(status === 'unknown' ? 'GitHub’s response was inconclusive. Check GitHub before requesting this change again; Erga will not repeat it automatically.' : safeError(error));
    }
  }
  private outcome(id: string, operation: string, result: unknown) {
    return { id, status: 'applied' as const, operation, result };
  }
  get(id: string, actor: Actor) {
    const p = this.store.proposal(id);
    if (!p || p.channel_id !== actor.channelId || p.guild_id !== actor.guildId || !mayRead(this.config, actor)) throw new PublicError('This change is not available in this conversation.');
    return p;
  }
  retireLegacy(id: string, actor: Actor) {
    const p = this.get(id, actor);
    if (this.store.cancelProposal(id)) this.store.audit(id, actor.userId, 'obsolete_button');
    return p.status === 'applied'
      ? 'This change was already applied. Erga now carries out new requests directly; no confirmation is needed.'
      : 'This approval button is no longer active. Mention Erga or reply to it with your request; authorized changes now run directly.';
  }
}
