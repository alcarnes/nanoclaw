#!/usr/bin/env npx tsx
/**
 * One-time migration: consolidate discord_main and telegram_main into a shared
 * "personal" folder. Safe to re-run (idempotent guards on each step).
 *
 * Usage: npx tsx scripts/migrate-shared-folder.ts
 * Prerequisites: NanoClaw must be stopped first.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

const NEW_FOLDER = 'personal';
const OLD_FOLDERS = ['discord_main', 'telegram_main'];

// JIDs to register under the shared folder
const JIDS = [
  {
    jid: 'dc:1486486449292578816',
    name: 'Jiles Personal',
    trigger: '@Jiles',
    requiresTrigger: false,
    isMain: false,
  },
  {
    jid: 'tg:8463942961',
    name: 'Jiles Personal',
    trigger: '@Jiles',
    requiresTrigger: false,
    isMain: false,
  },
  {
    jid: 'dc:1482940187267956821',
    name: 'Jiles Personal',
    trigger: '@Jiles',
    requiresTrigger: false,
    isMain: false,
  },
];

function log(msg: string): void {
  console.log(`[migrate] ${msg}`);
}

function copyDirContents(src: string, dest: string, label: string): void {
  if (!fs.existsSync(src)) {
    log(`  Skip ${label}: source ${src} does not exist`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (fs.existsSync(destPath)) {
      log(`  Skip ${label}/${entry.name}: already exists`);
      continue;
    }
    if (entry.isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  log(`  Copied ${label}`);
}

function main(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  log('Starting shared folder migration...');

  // Step 1: Create personal group directory
  const personalDir = path.join(GROUPS_DIR, NEW_FOLDER);
  fs.mkdirSync(path.join(personalDir, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(personalDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(personalDir, 'conversations'), { recursive: true });
  log('Step 1: Created groups/personal/ directories');

  // Step 2: Merge content from old folders
  for (const oldFolder of OLD_FOLDERS) {
    const oldDir = path.join(GROUPS_DIR, oldFolder);
    copyDirContents(
      path.join(oldDir, 'attachments'),
      path.join(personalDir, 'attachments'),
      `${oldFolder}/attachments`,
    );
    copyDirContents(
      path.join(oldDir, 'conversations'),
      path.join(personalDir, 'conversations'),
      `${oldFolder}/conversations`,
    );
    copyDirContents(
      path.join(oldDir, 'logs'),
      path.join(personalDir, 'logs'),
      `${oldFolder}/logs`,
    );
    // Copy CLAUDE.md if it exists
    const claudeMd = path.join(oldDir, 'CLAUDE.md');
    const destClaudeMd = path.join(personalDir, `CLAUDE-from-${oldFolder}.md`);
    if (fs.existsSync(claudeMd) && !fs.existsSync(destClaudeMd)) {
      fs.copyFileSync(claudeMd, destClaudeMd);
      log(`  Copied ${oldFolder}/CLAUDE.md`);
    }
  }
  log('Step 2: Merged old folder contents');

  // Step 3: Create session and IPC directories
  const sessionDir = path.join(DATA_DIR, 'sessions', NEW_FOLDER, '.claude');
  fs.mkdirSync(sessionDir, { recursive: true });
  // Copy settings.json from discord_main if available
  const srcSettings = path.join(
    DATA_DIR,
    'sessions',
    'discord_main',
    '.claude',
    'settings.json',
  );
  const destSettings = path.join(sessionDir, 'settings.json');
  if (fs.existsSync(srcSettings) && !fs.existsSync(destSettings)) {
    fs.copyFileSync(srcSettings, destSettings);
    log('  Copied settings.json from discord_main');
  }

  const ipcDir = path.join(DATA_DIR, 'ipc', NEW_FOLDER);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  log('Step 3: Created session and IPC directories');

  // Step 4: Update database
  const db = new Database(DB_PATH);

  // Drop UNIQUE constraint on folder if it still exists
  const tableInfo = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='registered_groups'`,
    )
    .get() as { sql: string } | undefined;
  if (tableInfo?.sql?.includes('UNIQUE')) {
    db.exec(`
      CREATE TABLE registered_groups_new (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0
      );
      INSERT INTO registered_groups_new SELECT * FROM registered_groups;
      DROP TABLE registered_groups;
      ALTER TABLE registered_groups_new RENAME TO registered_groups;
    `);
    log('  Dropped UNIQUE constraint on folder');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // Delete old registered_groups rows
    const deleteStmt = db.prepare(
      'DELETE FROM registered_groups WHERE jid = ?',
    );
    for (const { jid } of JIDS) {
      deleteStmt.run(jid);
    }

    // Insert new rows pointing to shared folder
    const insertStmt = db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const { jid, name, trigger, requiresTrigger, isMain } of JIDS) {
      insertStmt.run(
        jid,
        name,
        NEW_FOLDER,
        trigger,
        now,
        null,
        requiresTrigger ? 1 : 0,
        isMain ? 1 : 0,
      );
    }

    // Update scheduled tasks
    db.prepare(
      `UPDATE scheduled_tasks SET group_folder = ? WHERE group_folder IN (${OLD_FOLDERS.map(() => '?').join(',')})`,
    ).run(NEW_FOLDER, ...OLD_FOLDERS);

    // Delete old session rows, let new session be created on first run
    for (const oldFolder of OLD_FOLDERS) {
      db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(oldFolder);
    }

    // Clear stale lastAgentTimestamp entries from router_state
    const agentTsRow = db
      .prepare(`SELECT value FROM router_state WHERE key = 'last_agent_timestamp'`)
      .get() as { value: string } | undefined;
    if (agentTsRow) {
      try {
        const agentTs = JSON.parse(agentTsRow.value);
        // Remove entries for old JIDs that no longer exist
        // (new entries will be initialized on startup)
        db.prepare(
          `INSERT OR REPLACE INTO router_state (key, value) VALUES ('last_agent_timestamp', ?)`,
        ).run(JSON.stringify(agentTs));
      } catch {
        // Corrupted, reset
        db.prepare(
          `INSERT OR REPLACE INTO router_state (key, value) VALUES ('last_agent_timestamp', '{}')`,
        ).run();
      }
    }

    db.exec('COMMIT');
    log('Step 4: Database updated');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Database update failed, rolled back:', err);
    db.close();
    process.exit(1);
  }
  db.close();

  // Step 5: Archive old folders
  for (const oldFolder of OLD_FOLDERS) {
    // Archive group folders
    const oldGroupDir = path.join(GROUPS_DIR, oldFolder);
    const archivedGroupDir = path.join(GROUPS_DIR, `${oldFolder}.archived`);
    if (fs.existsSync(oldGroupDir) && !fs.existsSync(archivedGroupDir)) {
      fs.renameSync(oldGroupDir, archivedGroupDir);
      log(`  Archived groups/${oldFolder}`);
    }

    // Archive session directories
    const oldSessionDir = path.join(DATA_DIR, 'sessions', oldFolder);
    const archivedSessionDir = path.join(
      DATA_DIR,
      'sessions',
      `${oldFolder}.archived`,
    );
    if (fs.existsSync(oldSessionDir) && !fs.existsSync(archivedSessionDir)) {
      fs.renameSync(oldSessionDir, archivedSessionDir);
      log(`  Archived data/sessions/${oldFolder}`);
    }
  }
  log('Step 5: Old folders archived');

  log('');
  log('Migration complete! Verify with:');
  log(
    `  sqlite3 ${DB_PATH} "SELECT jid, folder FROM registered_groups"`,
  );
  log(
    `  sqlite3 ${DB_PATH} "SELECT group_folder, chat_jid FROM scheduled_tasks"`,
  );
}

main();
