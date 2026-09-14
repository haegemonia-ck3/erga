import { ChannelType, PermissionFlagsBits, type ForumChannel, type TextChannel, type ThreadChannel } from 'discord.js';

export function isConversationChannel(channel: unknown): channel is TextChannel | ThreadChannel {
  return !!channel && typeof channel === 'object' && 'type' in channel &&
    [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type as number);
}

// Forum parents can be allowlisted; conversations run inside their post threads.
export function isConfiguredChannel(channel: unknown): channel is TextChannel | ThreadChannel | ForumChannel {
  return isConversationChannel(channel) || !!channel && typeof channel === 'object' && 'type' in channel && channel.type === ChannelType.GuildForum;
}

export function requiredChannelPermissions(channel: TextChannel | ThreadChannel | ForumChannel): Record<string, bigint> {
  const required: Record<string, bigint> = {
    ViewChannel: PermissionFlagsBits.ViewChannel,
    ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
    SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
    AttachFiles: PermissionFlagsBits.AttachFiles,
    EmbedLinks: PermissionFlagsBits.EmbedLinks,
  };
  if (!channel.isThread()) required.SendMessages = PermissionFlagsBits.SendMessages;
  // Discord ignores CreatePublicThreads for forums; posting there uses SendMessages.
  if (channel.type === ChannelType.GuildText) required.CreatePublicThreads = PermissionFlagsBits.CreatePublicThreads;
  return required;
}
