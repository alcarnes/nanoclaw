import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Derive a short channel tag from a JID prefix. */
function channelTag(jid: string): string {
  if (jid.startsWith('dc:')) return '[Discord]';
  if (jid.startsWith('tg:')) return '[Telegram]';
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net'))
    return '[WhatsApp]';
  if (jid.startsWith('sl:')) return '[Slack]';
  if (jid.startsWith('sg:')) return '[Signal]';
  if (jid.startsWith('gm:')) return '[Gmail]';
  return '';
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  // Detect multi-channel messages for attribution
  const distinctJids = new Set(messages.map((m) => m.chat_jid));
  const isMultiChannel = distinctJids.size > 1;

  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const senderName = isMultiChannel
      ? `${channelTag(m.chat_jid)} ${m.sender_name}`
      : m.sender_name;
    return `<message sender="${escapeXml(senderName)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
