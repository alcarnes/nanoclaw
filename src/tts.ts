/**
 * Text-to-Speech via OpenAI or ElevenLabs.
 * Uses OpenAI if OPENAI_API_KEY is set, otherwise ElevenLabs if ELEVENLABS_API_KEY is set.
 * Called from the host process (not inside containers).
 */

import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

async function generateOpenAITTS(
  text: string,
  outputDir: string,
  apiKey: string,
): Promise<string | null> {
  const truncated = text.slice(0, 4096);

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'fable',
      input: truncated,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error({ status: res.status, errText }, 'OpenAI TTS failed');
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `tts-${Date.now()}.mp3`);
  fs.writeFileSync(filePath, buffer);

  logger.info(
    { filePath, textLength: truncated.length, provider: 'openai' },
    'TTS generated',
  );
  return filePath;
}

async function generateElevenLabsTTS(
  text: string,
  outputDir: string,
  apiKey: string,
): Promise<string | null> {
  // ElevenLabs has a 5000 char limit per request
  const truncated = text.slice(0, 5000);

  // Voice: "Agent James" — male
  const voiceId = '2GihCseICnKWh53NfUiM';

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: truncated,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    logger.error({ status: res.status, errText }, 'ElevenLabs TTS failed');
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `tts-${Date.now()}.mp3`);
  fs.writeFileSync(filePath, buffer);

  logger.info(
    { filePath, textLength: truncated.length, provider: 'elevenlabs' },
    'TTS generated',
  );
  return filePath;
}

export async function generateTTS(
  text: string,
  outputDir: string,
): Promise<string | null> {
  const secrets = readEnvFile(['OPENAI_API_KEY', 'ELEVENLABS_API_KEY']);

  try {
    if (secrets.OPENAI_API_KEY) {
      return await generateOpenAITTS(text, outputDir, secrets.OPENAI_API_KEY);
    }

    if (secrets.ELEVENLABS_API_KEY) {
      return await generateElevenLabsTTS(
        text,
        outputDir,
        secrets.ELEVENLABS_API_KEY,
      );
    }

    logger.debug('TTS skipped: no ELEVENLABS_API_KEY or OPENAI_API_KEY');
    return null;
  } catch (err) {
    logger.error({ err }, 'TTS generation error');
    return null;
  }
}
