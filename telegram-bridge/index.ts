/**
 * Telegram Bridge — HTTP server that sends messages as your Telegram user account.
 * NanoClaw picks them up like any other message from you.
 *
 * POST /send         { "message": "text" }
 * POST /send-wait    { "message": "text", "timeout": 30 }  — waits for Jiles' response
 * GET  /health
 */

import { createServer } from 'http';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'session.json');
const ENV_FILE = path.join(__dirname, '..', '.env');
const PORT = parseInt(process.env.BRIDGE_PORT || '3002', 10);

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

// ── Telegram Client ──────────────────────────────────────────

const apiId = parseInt(readEnvValue('TELEGRAM_API_ID'), 10);
const apiHash = readEnvValue('TELEGRAM_API_HASH');
const botUsername = readEnvValue('TELEGRAM_BOT_USERNAME') || 'acarnes_jiles_bot';
// Send messages to the bot — this creates the private chat where NanoClaw listens
const chatTarget = botUsername;

if (!apiId || !apiHash) {
  console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env');
  process.exit(1);
}

if (!fs.existsSync(SESSION_FILE)) {
  console.error('No session.json found. Run: npm run auth');
  process.exit(1);
}

const { session } = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
  connectionRetries: 3,
});

await client.connect();
console.log(`Telegram user client connected`);

// ── Response Listener ────────────────────────────────────────
// Listens for messages from the bot so /send-wait can return them.

interface PendingResponse {
  resolve: (text: string) => void;
  timer: NodeJS.Timeout;
}

const pendingResponses: PendingResponse[] = [];

client.addEventHandler(async (event) => {
  const message = event.message;
  if (!message) return;

  // Log all incoming messages for debugging
  const senderId = message.senderId?.toString() || 'unknown';
  console.log(`[incoming] senderId=${senderId} text=${(message.text || '').slice(0, 80)}`);

  // Get the sender entity to check username
  let senderUsername = '';
  try {
    if (message.senderId) {
      const sender = await message.getSender();
      senderUsername = (sender as any)?.username?.toLowerCase() || '';
      console.log(`[incoming] resolved username=${senderUsername}`);
    }
  } catch (err) {
    console.log(`[incoming] could not resolve sender: ${err}`);
  }

  // Check if the message is from the bot
  if (senderUsername !== botUsername.toLowerCase()) return;

  console.log(`[incoming] Bot response: ${(message.text || '').slice(0, 100)}`);

  // Save as last response
  lastBotResponse = { text: message.text || '', timestamp: Date.now() };

  // Resolve the oldest pending response
  const pending = pendingResponses.shift();
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve(message.text || '');
  }
}, new NewMessage({}));

function waitForResponse(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = pendingResponses.findIndex((p) => p.timer === timer);
      if (idx !== -1) pendingResponses.splice(idx, 1);
      resolve(null);
    }, timeoutMs);

    pendingResponses.push({ resolve: resolve as (text: string) => void, timer });
  });
}

// ── Last Response Buffer ─────────────────────────────────────
// Stores the most recent bot response so /last-response can return it.

let lastBotResponse: { text: string; timestamp: number } | null = null;

// ── HTTP Server ──────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // CORS for iOS Shortcuts
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: client.connected }));
    return;
  }

  if (req.method === 'GET' && req.url === '/last-response') {
    if (lastBotResponse) {
      const ageSeconds = Math.round((Date.now() - lastBotResponse.timestamp) / 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: lastBotResponse.text, age: ageSeconds }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: null, age: null }));
    }
    return;
  }

  if (req.method === 'POST' && (req.url === '/send' || req.url === '/send-wait')) {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const message = body.message;

        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "message" field' }));
          return;
        }

        // Send as the user
        await client.sendMessage(chatTarget, { message });
        console.log(`Sent: ${message.slice(0, 80)}...`);

        if (req.url === '/send-wait') {
          const timeoutMs = (body.timeout || 60) * 1000;
          const response = await waitForResponse(timeoutMs);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            sent: true,
            response: response || null,
            timedOut: response === null,
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sent: true }));
        }
      } catch (err) {
        console.error('Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Telegram bridge listening on http://0.0.0.0:${PORT}`);
  console.log(`  POST /send       — send message as you`);
  console.log(`  POST /send-wait  — send and wait for Jiles' response`);
  console.log(`  GET  /health     — check status`);
});
