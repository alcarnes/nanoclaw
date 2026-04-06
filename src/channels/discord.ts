import fs from 'fs';
import path from 'path';
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10MB

async function transcribeAudioFile(filePath: string): Promise<string | null> {
  const { readEnvFile: readEnv } = await import('../env.js');
  const secrets = readEnv(['OPENAI_API_KEY']);
  if (!secrets.OPENAI_API_KEY) return null;

  try {
    const audioBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const boundary = `----nanoclaw-${Date.now()}`;
    const parts: Buffer[] = [];

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
      ),
    );
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(audioBuffer);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secrets.OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(
        { status: res.status, errText },
        'Whisper transcription failed',
      );
      return null;
    }

    const data = (await res.json()) as { text: string };
    return data.text;
  } catch (err) {
    logger.error({ err }, 'Whisper transcription error');
    return null;
  }
}

async function downloadAttachment(
  url: string,
  groupFolder: string,
  filename: string,
): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentLength = parseInt(
      res.headers.get('content-length') || '0',
      10,
    );
    if (contentLength > MAX_DOWNLOAD_SIZE) {
      logger.warn(
        { url, size: contentLength },
        'Attachment too large, skipping download',
      );
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_SIZE) {
      logger.warn(
        { url, size: buffer.length },
        'Attachment too large after download',
      );
      return null;
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(attachDir, `${Date.now()}-${safeName}`);
    fs.writeFileSync(destPath, buffer);

    // Return container-relative path (group folder is mounted at /workspace/group)
    return `/workspace/group/attachments/${path.basename(destPath)}`;
  } catch (err) {
    logger.error({ url, err }, 'Failed to download attachment');
    return null;
  }
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// How often to check the gateway connection health (ms)
const HEALTH_CHECK_INTERVAL = 60_000; // 1 minute
// If ws.ping is -1 (no ACK) for this many consecutive checks, reconnect
const MAX_MISSED_PINGS = 3;

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private inputBotId: string | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private reconnecting = false;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    // Resolve the Aaron input bot ID if configured
    const envVars = readEnvFile(['AARON_INPUT_DISCORD_TOKEN']);
    const inputBotToken =
      process.env.AARON_INPUT_DISCORD_TOKEN ||
      envVars.AARON_INPUT_DISCORD_TOKEN ||
      '';
    if (inputBotToken) {
      try {
        const res = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${inputBotToken}` },
        });
        if (res.ok) {
          const botUser = (await res.json()) as {
            id: string;
            username: string;
          };
          this.inputBotId = botUser.id;
          logger.info(
            { inputBotId: this.inputBotId, username: botUser.username },
            'Aaron input bot registered',
          );
        } else {
          logger.warn(
            { status: res.status },
            'Failed to fetch input bot user ID',
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to resolve input bot user ID');
      }
    }

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages — except the Aaron input bot
      const isInputBot =
        this.inputBotId && message.author.id === this.inputBotId;
      if (message.author.bot && !isInputBot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName = isInputBot
        ? 'Aaron'
        : message.member?.displayName ||
          message.author.displayName ||
          message.author.username;
      const sender = isInputBot ? 'aaron-input' : message.author.id;
      const msgId = message.id;

      // Auto-prepend trigger for input bot messages
      if (isInputBot && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — download files so the agent can analyze them
      if (message.attachments.size > 0) {
        const group = this.opts.registeredGroups()[chatJid];
        const attachmentDescriptions: string[] = [];

        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          const name = att.name || 'file';

          // Skip video (too large)
          if (contentType.startsWith('video/')) {
            attachmentDescriptions.push(`[Video: ${name}]`);
            continue;
          }

          // Download images, audio, and documents
          if (group) {
            const localPath = await downloadAttachment(
              att.url,
              group.folder,
              name,
            );
            if (localPath) {
              if (contentType.startsWith('image/')) {
                attachmentDescriptions.push(`[Image: ${localPath}]`);
              } else if (contentType.startsWith('audio/')) {
                // Transcribe audio files
                const groupDir = resolveGroupFolderPath(group.folder);
                const hostPath = path.join(
                  groupDir,
                  'attachments',
                  path.basename(localPath),
                );
                const transcript = await transcribeAudioFile(hostPath);
                if (transcript) {
                  attachmentDescriptions.push(
                    `[Voice transcript: "${transcript}"]`,
                  );
                  logger.info(
                    { name, transcriptLength: transcript.length },
                    'Audio transcribed',
                  );
                } else {
                  attachmentDescriptions.push(`[Audio: ${localPath}]`);
                }
              } else {
                attachmentDescriptions.push(`[File: ${localPath}]`);
              }
              continue;
            }
          }

          // Fallback to placeholder if download failed or group not registered
          if (contentType.startsWith('image/')) {
            attachmentDescriptions.push(`[Image: ${name}]`);
          } else if (contentType.startsWith('audio/')) {
            attachmentDescriptions.push(`[Audio: ${name}]`);
          } else {
            attachmentDescriptions.push(`[File: ${name}]`);
          }
        }

        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        this.startHealthCheck();
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.missedPings = 0;

    this.healthTimer = setInterval(() => {
      if (!this.client || this.reconnecting) return;

      const ping = this.client.ws.ping;

      if (ping === -1) {
        this.missedPings++;
        logger.warn(
          { missedPings: this.missedPings, threshold: MAX_MISSED_PINGS },
          'Discord gateway ping missed (no heartbeat ACK)',
        );

        if (this.missedPings >= MAX_MISSED_PINGS) {
          logger.error('Discord gateway appears dead — forcing reconnect');
          this.reconnect();
        }
      } else {
        if (this.missedPings > 0) {
          logger.info({ ping }, 'Discord gateway heartbeat recovered');
        }
        this.missedPings = 0;
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.stopHealthCheck();

    try {
      if (this.client) {
        this.client.destroy();
        this.client = null;
      }

      logger.info('Discord reconnecting...');
      await this.connect();
      logger.info('Discord reconnected successfully');

      // Notify registered Discord groups about the recovery
      for (const [jid] of Object.entries(this.opts.registeredGroups())) {
        if (this.ownsJid(jid)) {
          this.sendMessage(
            jid,
            `⚠️ ${ASSISTANT_NAME} Discord connection was lost and has been restored. Messages sent during the outage may have been missed.`,
          ).catch(() => {});
        }
      }
    } catch (err) {
      logger.error(
        { err },
        'Discord reconnect failed — will retry next health check',
      );
      // Restart the health check so it tries again
      this.startHealthCheck();
    } finally {
      this.reconnecting = false;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    this.stopHealthCheck();
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  async sendVoice(jid: string, filePath: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;

      const attachment = new AttachmentBuilder(filePath, {
        name: path.basename(filePath),
      });
      await (channel as TextChannel).send({ files: [attachment] });
      logger.info({ jid }, 'Discord voice message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord voice message');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
