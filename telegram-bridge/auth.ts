/**
 * One-time Telegram user authentication.
 * Run this interactively: npm run auth
 * It will ask for your phone number and a code Telegram sends you.
 * The session is saved to session.json and reused by the bridge server.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'session.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

function readEnvValue(key: string): string {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      if (trimmed.slice(0, eqIdx).trim() === key) {
        return trimmed.slice(eqIdx + 1).trim();
      }
    }
  } catch {}
  return '';
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const apiId = parseInt(readEnvValue('TELEGRAM_API_ID'), 10);
  const apiHash = readEnvValue('TELEGRAM_API_HASH');

  if (!apiId || !apiHash) {
    console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env');
    console.error('Get these from https://my.telegram.org > API development tools');
    process.exit(1);
  }

  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => prompt('Phone number (with country code, e.g. +1...): '),
    phoneCode: () => prompt('Code from Telegram: '),
    password: () => prompt('2FA password (if enabled): '),
    onError: (err) => console.error('Auth error:', err),
  });

  const session = client.session.save() as unknown as string;
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ session }, null, 2));
  console.log('\nAuthentication successful! Session saved to session.json');
  console.log('You can now start the bridge server: npm start');

  await client.disconnect();
}

main();
