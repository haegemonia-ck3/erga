import { z } from 'zod';

const csv = (s: string | undefined) => (s ?? '').split(',').map(v => v.trim()).filter(Boolean);
const snowflake = z.string().regex(/^\d{17,20}$/, 'Expected a Discord ID (enable Developer Mode → Copy ID)');
export function modelConfig(env = process.env) {
  const provider = z.enum(['gemini', 'openai', 'anthropic']).parse(env.AI_PROVIDER || 'gemini');
  const keyName = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[provider];
  const apiKey = env[keyName]?.trim();
  if (!apiKey) throw new PublicError(`Missing ${keyName}. Configure it in the service environment.`);
  const model = env.AI_MODEL?.trim() || (provider === 'gemini' ? 'gemini-3.8-flash' : undefined);
  if (!model) throw new PublicError('Set AI_MODEL for the selected provider.');
  return { provider, model, apiKey };
}
export type GitHubAppConfig = { appId: string; installationId: string; privateKey?: string; privateKeyPath?: string };
export function config(env = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}. Configure it in .env.local.`);
    return value;
  };
  const positive = (key: string, fallback: number, max: number) => z.coerce.number().int().min(1).max(max).parse(env[key] || fallback);
  const roles = (key: string) => z.array(z.union([snowflake, z.literal('everyone')])).parse(csv(env[key]));
  const app: GitHubAppConfig | undefined = env.GITHUB_APP_ID ? { appId: required('GITHUB_APP_ID'), installationId: required('GITHUB_INSTALLATION_ID'), privateKey: env.GITHUB_PRIVATE_KEY?.trim() || undefined, privateKeyPath: env.GITHUB_PRIVATE_KEY_PATH?.trim() || undefined } : undefined;
  if (app && !app.privateKey && !app.privateKeyPath) throw new PublicError('Set GITHUB_PRIVATE_KEY to the PEM contents, or GITHUB_PRIVATE_KEY_PATH to a local PEM file.');
  return {
    ...modelConfig(env),
    discordToken: required('DISCORD_TOKEN'), applicationId: snowflake.parse(required('DISCORD_APPLICATION_ID')),
    guildId: snowflake.parse(required('DISCORD_GUILD_ID')),
    channelIds: z.array(snowflake).min(1).parse(csv(env.DISCORD_CHANNEL_IDS)),
    readRoleIds: roles('DISCORD_READ_ROLE_IDS'), writeRoleIds: roles('DISCORD_WRITE_ROLE_IDS'), deleteRoleIds: roles('DISCORD_DELETE_ROLE_IDS'),
    githubApp: app, githubToken: app ? undefined : required('GITHUB_TOKEN'),
    repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).min(1).parse(csv(env.GITHUB_REPOSITORIES)),
    databasePath: env.DATABASE_PATH || (env.RAILWAY_VOLUME_MOUNT_PATH ? `${env.RAILWAY_VOLUME_MOUNT_PATH}/erga.sqlite` : 'data/erga.sqlite'),
    sessionTtlHours: positive('SESSION_TTL_HOURS', 168, 8760),
    turnTimeoutSeconds: positive('TURN_TIMEOUT_SECONDS', 300, 1800),
    maxActiveTurns: positive('MAX_ACTIVE_TURNS', 3, 20),
    maxModelSteps: positive('MAX_MODEL_STEPS', 20, 100),
  };
}
export type Config = ReturnType<typeof config>;
export type Actor = { userId: string; guildId: string; channelId: string; parentId: string | null; roleIds: string[] };
const hasRole = (roles: string[], a: Actor) => roles.includes('everyone') || a.roleIds.some(id => roles.includes(id));
export function allowedChannel(c: Pick<Config, 'guildId' | 'channelIds'>, a: Actor) {
  return a.guildId === c.guildId && (c.channelIds.includes(a.channelId) || (!!a.parentId && c.channelIds.includes(a.parentId)));
}
type Policy = Pick<Config, 'guildId' | 'channelIds' | 'readRoleIds' | 'writeRoleIds' | 'deleteRoleIds'>;
export function mayRead(c: Policy, a: Actor) {
  return allowedChannel(c, a) && hasRole([...c.readRoleIds, ...c.writeRoleIds, ...c.deleteRoleIds], a);
}
export function mayWrite(c: Policy, a: Actor) {
  return allowedChannel(c, a) && hasRole([...c.writeRoleIds, ...c.deleteRoleIds], a);
}
export function mayDelete(c: Policy, a: Actor) {
  return allowedChannel(c, a) && hasRole(c.deleteRoleIds, a);
}

export function safeError(error: unknown): string {
  if (error instanceof z.ZodError) return `Invalid configuration or arguments: ${error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  if (error instanceof PublicError) return error.message;
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return `Service request failed (HTTP ${String(error.status)}). Check access, permissions, and service limits.`;
  // Never log SDK/fetch request objects, which can contain authorization headers.
  return error instanceof PublicError ? error.message : 'An unexpected service error occurred. Check connectivity and configuration; do not blindly retry changes.';
}
export class PublicError extends Error {}
