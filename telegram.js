/**
 * telegram.js
 * Helper per le notifiche Telegram. Se i secrets non sono configurati,
 * le funzioni non falliscono: loggano e proseguono (le notifiche sono
 * accessorie, non devono mai bloccare una pubblicazione).
 */

const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

function configured() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

async function sendMessage(text) {
  if (!configured()) {
    console.log('[telegram] secrets mancanti, salto notifica:', text);
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
    const data = await res.json();
    if (!data.ok) console.error('[telegram] sendMessage fallita:', JSON.stringify(data));
  } catch (err) {
    console.error('[telegram] sendMessage errore rete:', err.message);
  }
}

/** Manda una foto dal disco (multipart), con caption. Fallback su sendMessage. */
async function sendPhotoFile(filePath, caption) {
  if (!configured()) {
    console.log('[telegram] secrets mancanti, salto notifica foto:', caption);
    return;
  }
  try {
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', caption);
    form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    const res = await fetch(`${API_BASE}/sendPhoto`, { method: 'POST', body: form });
    const data = await res.json();
    if (!data.ok) {
      console.error('[telegram] sendPhoto fallita:', JSON.stringify(data));
      await sendMessage(caption);
    }
  } catch (err) {
    console.error('[telegram] sendPhoto errore:', err.message);
    await sendMessage(caption);
  }
}

module.exports = { sendMessage, sendPhotoFile };
