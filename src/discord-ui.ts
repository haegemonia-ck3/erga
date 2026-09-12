import { type MessageCreateOptions, SlashCommandBuilder } from 'discord.js';

export const command = new SlashCommandBuilder().setName('erga').setDescription('Hegemonia’s GitHub teammate')
  .addSubcommand(s => s.setName('ask').setDescription('Ask Erga about GitHub or request a change').addStringOption(o => o.setName('message').setDescription('What would you like Erga to do?').setRequired(true).setMaxLength(6000)))
  .addSubcommand(s => s.setName('status').setDescription('Check the current conversation’s progress'))
  .addSubcommand(s => s.setName('stop').setDescription('Stop work in this conversation'))
  .addSubcommand(s => s.setName('reset').setDescription('Clear this conversation’s agent context'))
  .addSubcommand(s => s.setName('help').setDescription('Examples and access information'));

export const noMentions = { parse: [] as [], repliedUser: false };
export const help = `**Erga · Hegemonia’s GitHub teammate**
Mention me in an allowed channel, or use **/erga ask**. I’ll open a thread. When a thread has only you and me, just send a message. If anyone else joins, **@mention me or reply to one of my messages** (reply pings can be off). I always read the full thread for context.

Try:
• “What’s blocking the next milestone?”
• “Summarize PR #42, including its checks and reviews.”
• “Create a bug issue from the reproduction steps in this thread.”
• “Assign issue #18 to a GitHub username and add it to milestone 3.”
• “Open a draft PR from branch fix-localisation into main.”

Authorized changes are carried out directly, with the result posted once in the thread. No confirmation is needed. Read, write and delete access comes from your configured Discord roles. Closing an issue uses write access; permanent deletion uses delete access.
Use **/erga status**, **/erga stop**, or **/erga reset** in the thread.`;

export function answerMessages(text: string): MessageCreateOptions[] {
  const messages: MessageCreateOptions[] = [];
  let remaining = text;
  let fence = '';
  while (remaining.length) {
    const prefix = fence ? fence + '\n' : '';
    if (prefix.length + remaining.length <= 2000) {
      messages.push({ content: prefix + remaining, allowedMentions: noMentions });
      break;
    }
    // Leave room to close a code fence, only when another message is necessary.
    const limit = 2000 - prefix.length - 4;
    let cut = remaining.lastIndexOf('\n', limit - 1) + 1;
    if (!cut) cut = remaining.lastIndexOf(' ', limit - 1) + 1;
    if (!cut) cut = limit;
    // Keep a priority heading with its first item when it fits in the next message.
    const heading = /(?:^|\n)(#{1,6} [^\n]+\n\s*)$/.exec(remaining.slice(0, cut));
    if (heading && heading.index > 0) cut = heading.index + 1;
    // Do not cut ordinary inline links in the middle of the label or URL.
    for (const link of remaining.matchAll(/\[[^\]\n]*\]\([^\s)]*\)/g)) {
      if (link.index < cut && link.index + link[0].length > cut && link.index > 0) { cut = link.index; break; }
      if (link.index >= cut) break;
    }
    // Avoid splitting an emoji's surrogate pair on a forced long-token boundary.
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1] ?? '') && /[\uDC00-\uDFFF]/.test(remaining[cut] ?? '')) cut--;
    const part = remaining.slice(0, cut);
    for (const match of part.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)/gm)) {
      if (!fence) fence = match[0].trim().slice(0, 80);
      else if (match[1]![0] === fence[0] && !match[2]!.trim()) fence = '';
    }
    const suffix = fence ? '\n' + (fence.startsWith('`') ? '```' : '~~~') : '';
    messages.push({ content: prefix + part + suffix, allowedMentions: noMentions });
    remaining = remaining.slice(cut);
  }
  return messages;
}
