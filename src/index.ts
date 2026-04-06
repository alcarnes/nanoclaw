import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getMessagesSinceForFolder,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher, stopIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { generateTTS } from './tts.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop, stopSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  // Populate queue's folder mapping for folder-level locking
  for (const [jid, group] of Object.entries(registeredGroups)) {
    queue.setGroupFolder(jid, group.folder);
  }
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/** Get all JIDs that share a folder (from in-memory map, no DB query). */
function getJidsForFolder(folder: string): string[] {
  return Object.entries(registeredGroups)
    .filter(([_, g]) => g.folder === folder)
    .map(([jid]) => jid);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  queue.setGroupFolder(jid, group.folder);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Shared folder support: fetch messages from all JIDs sharing this folder
  const folderJids = getJidsForFolder(group.folder);
  let missedMessages: NewMessage[];

  if (folderJids.length > 1) {
    // Compute earliest cursor across all sibling JIDs
    const earliestTimestamp = folderJids.reduce((min, jid) => {
      const ts = lastAgentTimestamp[jid] || '';
      return ts < min ? ts : min;
    }, lastAgentTimestamp[chatJid] || '');
    missedMessages = getMessagesSinceForFolder(
      folderJids,
      earliestTimestamp,
      ASSISTANT_NAME,
    );
  } else {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
  }

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Track whether the most recent user input was a voice message.
  // This is mutable so piped follow-up messages can update it.
  let lastInputWasVoice = missedMessages.some(
    (m) =>
      m.content.startsWith('[Voice transcript:') ||
      m.content.startsWith('[Voice:'),
  );

  // Save previous cursors for ALL sibling JIDs so we can roll back on error.
  const previousCursors: Record<string, string> = {};
  for (const jid of folderJids) {
    previousCursors[jid] = lastAgentTimestamp[jid] || '';
  }

  // Advance per-JID cursors only to each JID's own max timestamp
  for (const jid of folderJids) {
    const maxTs = missedMessages
      .filter((m) => m.chat_jid === jid)
      .reduce(
        (max, m) => (m.timestamp > max ? m.timestamp : max),
        lastAgentTimestamp[jid] || '',
      );
    if (maxTs) lastAgentTimestamp[jid] = maxTs;
  }
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // Route response to the JID that most recently sent a message
        // (may differ from chatJid if a piped message came from another channel)
        const responseJid = queue.getResponseJid(chatJid) || chatJid;
        const responseChannel = findChannel(channels, responseJid) || channel;
        await responseChannel.sendMessage(responseJid, text);
        outputSentToUser = true;

        // Generate TTS for voice transcript responses (non-fatal)
        if (lastInputWasVoice && channel.sendVoice) {
          try {
            const groupDir = resolveGroupFolderPath(group.folder);
            const ttsPath = await generateTTS(
              text,
              path.join(groupDir, 'attachments'),
            );
            if (ttsPath) {
              await channel.sendVoice(chatJid, ttsPath);
            }
          } catch (err) {
            logger.warn({ err }, 'TTS failed (non-fatal)');
          }
          // Reset after responding — next piped message starts fresh
          lastInputWasVoice = false;
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursors for ALL sibling JIDs so retries can re-process
    for (const [jid, prev] of Object.entries(previousCursors)) {
      lastAgentTimestamp[jid] = prev;
    }
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursors for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

function stopMessageLoop(): void {
  messageLoopRunning = false;
  logger.info('Message loop stopped');
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (messageLoopRunning) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Group messages by JID, then deduplicate by folder
        const messagesByJid = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByJid.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByJid.set(msg.chat_jid, [msg]);
          }
        }

        // Deduplicate by folder: merge sibling JIDs' messages
        const processedFolders = new Set<string>();
        for (const [chatJid, groupMessages] of messagesByJid) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          // Skip if we already processed this folder (shared folder dedup)
          if (processedFolders.has(group.folder)) continue;
          processedFolders.add(group.folder);

          // Collect all JIDs and messages for this folder
          const folderJids = getJidsForFolder(group.folder);
          const allFolderMessages: NewMessage[] = [];
          const contributingJids: string[] = [];
          for (const jid of folderJids) {
            const jidMsgs = messagesByJid.get(jid);
            if (jidMsgs) {
              allFolderMessages.push(...jidMsgs);
              contributingJids.push(jid);
            }
          }

          // Find a JID with a trigger (for trigger checking)
          let triggerJid: string | undefined;
          const allowlistCfg = loadSenderAllowlist();
          for (const jid of contributingJids) {
            const jidGroup = registeredGroups[jid];
            if (!jidGroup) continue;
            const isMainGroup = jidGroup.isMain === true;
            const needsTrigger =
              !isMainGroup && jidGroup.requiresTrigger !== false;
            if (!needsTrigger) {
              triggerJid = jid;
              break;
            }
            const jidMsgs = messagesByJid.get(jid) || [];
            const hasTrigger = jidMsgs.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me || isTriggerAllowed(jid, m.sender, allowlistCfg)),
            );
            if (hasTrigger) {
              triggerJid = jid;
              break;
            }
          }

          if (!triggerJid) continue; // No trigger found across any JID

          const triggerChannel = findChannel(channels, triggerJid);
          if (!triggerChannel) {
            logger.warn(
              { chatJid: triggerJid },
              'No channel owns JID, skipping messages',
            );
            continue;
          }

          // Pull all messages since lastAgentTimestamp for the folder
          let messagesToSend: NewMessage[];
          if (folderJids.length > 1) {
            const earliestTimestamp = folderJids.reduce((min, jid) => {
              const ts = lastAgentTimestamp[jid] || '';
              return ts < min ? ts : min;
            }, lastAgentTimestamp[triggerJid] || '');
            messagesToSend = getMessagesSinceForFolder(
              folderJids,
              earliestTimestamp,
              ASSISTANT_NAME,
            );
          } else {
            const allPending = getMessagesSince(
              triggerJid,
              lastAgentTimestamp[triggerJid] || '',
              ASSISTANT_NAME,
            );
            messagesToSend =
              allPending.length > 0 ? allPending : allFolderMessages;
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(triggerJid, formatted)) {
            logger.debug(
              { chatJid: triggerJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Per-JID cursor advancement
            for (const jid of folderJids) {
              const maxTs = messagesToSend
                .filter((m) => m.chat_jid === jid)
                .reduce(
                  (max, m) => (m.timestamp > max ? m.timestamp : max),
                  lastAgentTimestamp[jid] || '',
                );
              if (maxTs) lastAgentTimestamp[jid] = maxTs;
            }
            saveState();
            // Show typing indicator on each contributing JID's channel
            for (const jid of contributingJids) {
              const ch = findChannel(channels, jid);
              ch?.setTyping?.(jid, true)?.catch((err) =>
                logger.warn(
                  { chatJid: jid, err },
                  'Failed to set typing indicator',
                ),
              );
            }
          } else {
            // No active container — enqueue the trigger JID for a new one
            queue.enqueueMessageCheck(triggerJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  const recoveredFolders = new Set<string>();
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (recoveredFolders.has(group.folder)) continue;

    const folderJids = getJidsForFolder(group.folder);
    // Find which JID has the most recent pending message
    let bestJid = chatJid;
    let bestTs = '';
    for (const jid of folderJids) {
      const pending = getMessagesSince(
        jid,
        lastAgentTimestamp[jid] || '',
        ASSISTANT_NAME,
      );
      if (
        pending.length > 0 &&
        pending[pending.length - 1].timestamp > bestTs
      ) {
        bestJid = jid;
        bestTs = pending[pending.length - 1].timestamp;
      }
    }
    if (bestTs) {
      logger.info(
        { group: group.name, bestJid },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(bestJid);
    }
    recoveredFolders.add(group.folder);
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Broadcast a status message to all registered groups
  const broadcastStatus = async (text: string) => {
    for (const [jid] of Object.entries(registeredGroups)) {
      const ch = findChannel(channels, jid);
      if (ch) {
        try {
          await ch.sendMessage(jid, text);
        } catch (err) {
          logger.warn({ jid, err }, 'Failed to send status broadcast');
        }
      }
    }
  };

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');

    // 1. Broadcast shutdown notice while channels are still connected
    try {
      await broadcastStatus(
        `⚙️ ${ASSISTANT_NAME} is restarting — back shortly.`,
      );
    } catch {
      /* best-effort */
    }

    // 2. Stop subsystem loops so they don't enqueue new work
    stopMessageLoop();
    stopSchedulerLoop();
    stopIpcWatcher();

    // 3. Drain in-flight container work
    await queue.shutdown(10000);

    // 4. Close credential proxy (no new API calls)
    proxyServer.close();

    // 5. Disconnect channels last
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels in parallel with timeouts.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  const CHANNEL_CONNECT_TIMEOUT = 30_000; // 30 seconds per channel

  const pendingChannels: { name: string; channel: Channel }[] = [];
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    pendingChannels.push({ name: channelName, channel });
  }

  const connectResults = await Promise.allSettled(
    pendingChannels.map(({ name, channel }) =>
      Promise.race([
        channel.connect().then(() => ({ name, channel })),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `${name} connect timed out after ${CHANNEL_CONNECT_TIMEOUT / 1000}s`,
                ),
              ),
            CHANNEL_CONNECT_TIMEOUT,
          ),
        ),
      ]),
    ),
  );

  for (const result of connectResults) {
    if (result.status === 'fulfilled') {
      channels.push(result.value.channel);
    } else {
      logger.error({ err: result.reason }, 'Channel failed to connect');
    }
  }

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Notify all groups that the system is back online
  broadcastStatus(`✅ ${ASSISTANT_NAME} is back online.`).catch(() => {});
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
