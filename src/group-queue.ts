import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  responseJid: string | null; // JID that most recently piped a message (for response routing)
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  // Folder-level locking: prevents two containers for the same shared folder
  private activeFolders = new Map<string, string>(); // folder -> active JID
  private jidFolders = new Map<string, string>(); // JID -> folder
  // Groups that exceeded max retries — retried by periodic recovery sweep
  private failedGroups = new Set<string>();

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        responseJid: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /** Register a JID's folder mapping for folder-level locking. */
  setGroupFolder(jid: string, folder: string): void {
    this.jidFolders.set(jid, folder);
  }

  /** Check if a JID's folder already has an active container (via a sibling JID). */
  private isFolderActive(groupJid: string): string | undefined {
    const folder = this.jidFolders.get(groupJid);
    if (!folder) return undefined;
    return this.activeFolders.get(folder);
  }

  /** Get all JIDs that share a folder with the given JID. */
  private getSiblingJids(groupJid: string): string[] {
    const folder = this.jidFolders.get(groupJid);
    if (!folder) return [];
    const siblings: string[] = [];
    for (const [jid, f] of this.jidFolders) {
      if (f === folder && jid !== groupJid) siblings.push(jid);
    }
    return siblings;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    // Check if a sibling JID's container is already running for this folder
    const activeSibling = this.isFolderActive(groupJid);
    if (activeSibling) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeSibling },
        'Sibling container active for shared folder, message queued',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    // Set folder lock synchronously before async start
    const folder = this.jidFolders.get(groupJid);
    if (folder) this.activeFolders.set(folder, groupJid);

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    // Check if a sibling JID's container is already running for this folder
    const activeSibling = this.isFolderActive(groupJid);
    if (activeSibling) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeSibling },
        'Sibling container active for shared folder, task queued',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Set folder lock synchronously before async start
    const folder = this.jidFolders.get(groupJid);
    if (folder) this.activeFolders.set(folder, groupJid);

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  /**
   * Send a follow-up message to the active container via IPC file.
   * Supports cross-JID piping for shared folders.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    let state = this.getGroup(groupJid);
    let targetFolder = state.groupFolder;

    // Cross-JID piping: if this JID has no active container, check if a
    // sibling JID (shared folder) has one and pipe to that instead.
    if (!state.active || !targetFolder) {
      const folder = this.jidFolders.get(groupJid);
      if (folder) {
        const activeJid = this.activeFolders.get(folder);
        if (activeJid && activeJid !== groupJid) {
          const sibState = this.getGroup(activeJid);
          if (
            sibState.active &&
            sibState.groupFolder &&
            !sibState.isTaskContainer
          ) {
            state = sibState;
            targetFolder = sibState.groupFolder;
          }
        }
      }
    }

    if (!state.active || !targetFolder || state.isTaskContainer) return false;
    state.idleWaiting = false;

    // Track which JID most recently piped a message — used for response routing
    state.responseJid = groupJid;

    const inputDir = path.join(DATA_DIR, 'ipc', targetFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the JID that most recently piped a message to this group's container. */
  getResponseJid(groupJid: string): string | null {
    const state = this.groups.get(groupJid);
    if (state?.responseJid) return state.responseJid;
    // Check siblings
    const folder = this.jidFolders.get(groupJid);
    if (folder) {
      const activeJid = this.activeFolders.get(folder);
      if (activeJid) {
        const activeState = this.groups.get(activeJid);
        if (activeState?.responseJid) return activeState.responseJid;
      }
    }
    return null;
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    // Ensure folder lock is set (may already be set by enqueueMessageCheck)
    const folder = this.jidFolders.get(groupJid);
    if (folder) this.activeFolders.set(folder, groupJid);

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.responseJid = null;
      this.activeCount--;
      // Drain this JID and sibling JIDs before clearing the folder lock
      this.drainGroup(groupJid);
      this.drainSiblings(groupJid);
      const folder = this.jidFolders.get(groupJid);
      if (folder) this.activeFolders.delete(folder);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    // Ensure folder lock is set
    const folder = this.jidFolders.get(groupJid);
    if (folder) this.activeFolders.set(folder, groupJid);

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.responseJid = null;
      this.activeCount--;
      // Drain this JID and sibling JIDs before clearing the folder lock
      this.drainGroup(groupJid);
      this.drainSiblings(groupJid);
      const folder = this.jidFolders.get(groupJid);
      if (folder) this.activeFolders.delete(folder);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded — persisting for recovery sweep',
      );
      state.retryCount = 0;
      // Persist the failed JID so the periodic recovery sweep can retry it
      this.failedGroups.add(groupJid);
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  /** Check if sibling JIDs (same folder) have pending work and drain them. */
  private drainSiblings(groupJid: string): void {
    for (const sibJid of this.getSiblingJids(groupJid)) {
      const sibState = this.getGroup(sibJid);
      if (sibState.pendingMessages || sibState.pendingTasks.length > 0) {
        // Remove from waitingGroups if present (drainGroup will handle it)
        const idx = this.waitingGroups.indexOf(sibJid);
        if (idx !== -1) this.waitingGroups.splice(idx, 1);
        this.drainGroup(sibJid);
      }
    }
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Skip if a sibling's container is already running for the same folder
      if (this.isFolderActive(nextJid)) {
        // Re-queue so it gets picked up when the sibling finishes
        if (!this.waitingGroups.includes(nextJid)) {
          this.waitingGroups.push(nextJid);
        }
        continue;
      }

      // Set folder lock before starting
      const folder = this.jidFolders.get(nextJid);
      if (folder) this.activeFolders.set(folder, nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      } else {
        // Nothing pending — release the folder lock
        if (folder) this.activeFolders.delete(folder);
      }
    }
  }

  /**
   * Retry groups that previously exceeded max retries.
   * Called periodically from the scheduler loop.
   */
  recoverFailedGroups(): void {
    if (this.shuttingDown || this.failedGroups.size === 0) return;

    const recovered = [...this.failedGroups];
    this.failedGroups.clear();

    for (const groupJid of recovered) {
      const state = this.getGroup(groupJid);
      if (state.pendingMessages || state.pendingTasks.length > 0) {
        logger.info({ groupJid }, 'Recovery sweep: retrying failed group');
        this.enqueueMessageCheck(groupJid);
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
