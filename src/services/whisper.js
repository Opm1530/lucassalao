const OpenAI = require('openai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db/database');

function getClient() {
  const apiKey = db.getConfig('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API Key não configurada.');
  return new OpenAI({ apiKey });
}

/**
 * Transcribes an audio base64 string using OpenAI Whisper.
 * @param {string} base64 - Audio content in base64
 * @param {string} mimetype - e.g. 'audio/ogg; codecs=opus'
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(base64, mimetype) {
  const client = getClient();

  // Determine extension from mimetype
  const ext = mimetype.includes('ogg') ? 'ogg'
    : mimetype.includes('mp4') ? 'mp4'
    : mimetype.includes('mpeg') || mimetype.includes('mp3') ? 'mp3'
    : mimetype.includes('webm') ? 'webm'
    : 'ogg';

  // Write to temp file (Whisper API requires a file stream)
  const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));

  try {
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'pt',
    });
    return response.text;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

module.exports = { transcribe };
