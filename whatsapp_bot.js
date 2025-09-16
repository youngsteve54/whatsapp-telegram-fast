// whatsapp_bot.js
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

import bot from "./telegram_bot.js"; // Telegram bot bridge
import {
  loadConfig,
  saveWhatsAppSession,
  loadWhatsAppSession,
  saveDeletedMessage
} from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let BOT_CONFIG = loadConfig();

// -----------------------
// TELEGRAM NOTIFY HELPER
// -----------------------
async function notifyUser(userId, text, imgBuffer = null) {
  try {
    if (imgBuffer) {
      await bot.sendPhoto(userId, imgBuffer, { caption: text, parse_mode: "Markdown" });
    } else {
      await bot.sendMessage(userId, text, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error(`[Notify] Failed to notify user ${userId}:`, err.message);
  }
}

// -----------------------
// WHATSAPP MANAGER
// -----------------------
class WhatsAppManager {
  static activeSessions = {}; // user_id -> number -> socket

  static async startSession(userId, number, method = "qr") {
    userId = String(userId);
    number = String(number);

    if (!this.activeSessions[userId]) this.activeSessions[userId] = {};
    if (this.activeSessions[userId][number]) return console.log(`[WhatsAppManager] Session already running: ${number}`);

    const sessionsDir = path.resolve(BOT_CONFIG.whatsapp_sessions_path || "./sessions");
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    const authDir = path.join(sessionsDir, number);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" }))
      },
      logger: P({ level: "silent" })
    });

    sock.ev.on("creds.update", saveCreds);

    // -----------------------
    // CONNECTION UPDATES
    // -----------------------
    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, pairingCode } = update;

      if (method === "qr" && qr) {
        try {
          const qrBuffer = await QRCode.toBuffer(qr, { type: "png" });
          await notifyUser(userId, `Scan this QR to link WhatsApp (${number})`, qrBuffer);
        } catch (err) {
          console.error("[WhatsAppManager] QR generation error:", err);
        }
      }

      if (method === "phone" && pairingCode) {
        await notifyUser(userId, `Your pairing code for WhatsApp (${number}): *${pairingCode}*`);
      }

      if (connection === "close") {
        console.log(`[WhatsAppManager] Connection closed for ${number}`);
        delete this.activeSessions[userId][number];
        await notifyUser(userId, `❌ WhatsApp session closed for ${number}`);
      } else if (connection === "open") {
        console.log(`[WhatsAppManager] Connected: ${number}`);
        await notifyUser(userId, `✅ WhatsApp connected successfully: ${number}`);
      }
    });

    // -----------------------
    // GLOBAL OUTGOING MESSAGE WATCHER
    // -----------------------
    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message) continue;
        if (!msg.key.fromMe) continue; // only outgoing

        const remoteJid = msg.key.remoteJid;

        if (BOT_CONFIG.auto_delete) {
          try {
            await sock.sendMessage(remoteJid, { delete: msg.key }); // delete immediately
            saveDeletedMessage(number, msg); // save deleted for Telegram review
            await notifyUser(userId, `🗑 Outgoing message to ${remoteJid} auto-deleted.`);
            console.log(`[WhatsAppManager] Auto-deleted outgoing message from ${number} to ${remoteJid}`);
          } catch (err) {
            console.error(`[WhatsAppManager] Failed to delete outgoing message (${number}):`, err);
          }
        }
      }
    });

    // -----------------------
    // SAVE SESSION INFO
    // -----------------------
    const sessionData = loadWhatsAppSession(number) || {
      linked_to: userId,
      number,
      status: "active",
      messages_deleted: 0
    };
    saveWhatsAppSession(number, sessionData);

    this.activeSessions[userId][number] = sock;
    return sock;
  }

  static async stopSession(userId, number) {
    userId = String(userId);
    number = String(number);

    if (this.activeSessions[userId] && this.activeSessions[userId][number]) {
      try {
        await this.activeSessions[userId][number].logout();
        await notifyUser(userId, `⚠️ WhatsApp session unlinked for ${number}`);
      } catch (err) {
        console.error(`[WhatsAppManager] Error logging out ${number}:`, err);
      }
      delete this.activeSessions[userId][number];
    }
  }

  static listActiveSessions(userId = null) {
    if (userId) return this.activeSessions[String(userId)] || {};
    return this.activeSessions;
  }

  // -----------------------
  // WATCH ALL ACTIVE SESSIONS FOR OUTGOING MESSAGES
  // -----------------------
  static watchAllSessions() {
    for (const [userId, numbers] of Object.entries(this.activeSessions)) {
      for (const [number, sock] of Object.entries(numbers)) {
        sock.ev.on("messages.upsert", async (m) => {
          const messages = m.messages || [];
          for (const msg of messages) {
            if (!msg.message) continue;
            if (!msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            if (BOT_CONFIG.auto_delete) {
              try {
                await sock.sendMessage(remoteJid, { delete: msg.key });
                saveDeletedMessage(number, msg);
                await notifyUser(userId, `🗑 Outgoing message to ${remoteJid} auto-deleted.`);
              } catch (err) {
                console.error(`[WhatsAppManager] Failed auto-delete (${number}):`, err);
              }
            }
          }
        });
      }
    }
  }
}

// -----------------------
// START ALL SESSIONS
// -----------------------
export async function startAllSessions() {
  BOT_CONFIG = loadConfig();
  for (const [userId, data] of Object.entries(BOT_CONFIG.users)) {
    const numbers = data.numbers || [];
    for (const number of numbers) {
      await WhatsAppManager.startSession(userId, number);
    }
  }
  WhatsAppManager.watchAllSessions(); // start global watcher
}

// -----------------------
// RUN WHATSAPP BOT
// -----------------------
export async function runWhatsAppBot() {
  await startAllSessions();
  console.log("[WhatsAppManager] WhatsApp bot running...");
  setInterval(() => {}, 1000);
}

export { WhatsAppManager };

// -----------------------
// BRIDGE: TELEGRAM EVENTS
// -----------------------
bot.on("link_whatsapp", async ({ userId, number, method }) => {
  await WhatsAppManager.startSession(userId, number, method);
  WhatsAppManager.watchAllSessions();
});

bot.on("unlink_whatsapp", async ({ userId, number }) => {
  await WhatsAppManager.stopSession(userId, number);
});