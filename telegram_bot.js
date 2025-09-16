const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// -----------------------
// CONFIG LOADING / SAVING
// -----------------------
const CONFIG_PATH = path.join(__dirname, "config.json");
let BOT_CONFIG = {};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    BOT_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH));
  } else {
    BOT_CONFIG = {
      bot_token: "",
      admin_id: "",
      users: {},
      passkeys: {},
      notify_admin_on_access_attempt: true,
      passkey_length: 6
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(BOT_CONFIG, null, 2));
  }
  return BOT_CONFIG;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(BOT_CONFIG, null, 2));
}

function generatePasskey(length = BOT_CONFIG.passkey_length) {
  let result = "";
  for (let i = 0; i < length; i++) result += Math.floor(Math.random() * 10);
  return result;
}

// load config
BOT_CONFIG = loadConfig();

// -----------------------
// TOKEN HANDLING
// -----------------------
async function getBotToken() {
  // 1. Check environment variable
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN;

  // 2. Check config.json
  if (BOT_CONFIG.bot_token && BOT_CONFIG.bot_token.trim() !== "") return BOT_CONFIG.bot_token;

  // 3. Ask user in console (for Termux)
  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Enter your Telegram bot token: ", (answer) => {
      BOT_CONFIG.bot_token = answer.trim();
      saveConfig();
      rl.close();
      resolve(BOT_CONFIG.bot_token);
    });
  });
}

// -----------------------
// TELEGRAM BOT SETUP
// -----------------------
(async () => {
  const token = await getBotToken();
  const bot = new TelegramBot(token, { polling: true });

  // -----------------------
  // USER COMMANDS
  // -----------------------
  bot.onText(/\/start/, (msg) => {
    const userId = String(msg.from.id);
    if (!BOT_CONFIG.users[userId]) {
      bot.sendMessage(msg.chat.id, "You are not registered. Request access from the admin.");
      if (BOT_CONFIG.notify_admin_on_access_attempt)
        bot.sendMessage(BOT_CONFIG.admin_id, `User ${userId} attempted access.`);
      return;
    }
    bot.sendMessage(msg.chat.id, "Welcome! You can link/unlink WhatsApp numbers and review deleted messages.");
  });

  bot.onText(/\/request_passkey/, (msg) => {
    const userId = String(msg.from.id);
    if (!BOT_CONFIG.users[userId]) {
      const key = generatePasskey();
      BOT_CONFIG.passkeys[key] = userId;
      saveConfig();
      bot.sendMessage(BOT_CONFIG.admin_id, `User ${userId} requested access. Passkey: ${key}`);
      bot.sendMessage(msg.chat.id, "Request sent to admin. Await passkey.");
    }
  });

  bot.onText(/\/verify (.+)/, (msg, match) => {
    const userId = String(msg.from.id);
    const key = match[1];
    if (BOT_CONFIG.passkeys[key] === userId) {
      BOT_CONFIG.users[userId] = { active: true, numbers: [], deleted_messages: [] };
      delete BOT_CONFIG.passkeys[key];
      saveConfig();
      bot.sendMessage(msg.chat.id, "✅ Access granted!");
    } else {
      bot.sendMessage(msg.chat.id, "❌ Invalid or expired passkey!");
    }
  });

  // -----------------------
  // LINK / UNLINK HANDLING
  // -----------------------
  bot.onText(/\/link (.+)/, (msg, match) => {
    const userId = String(msg.from.id);
    if (!BOT_CONFIG.users[userId]) return bot.sendMessage(msg.chat.id, "You are not authorized.");

    const number = match[1];
    bot.sendMessage(msg.chat.id, `Choose how to link WhatsApp number *${number}*:`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📷 QR Code", callback_data: `link_qr_${number}` },
            { text: "📱 Phone Number", callback_data: `link_num_${number}` },
            { text: "❌ Unlink", callback_data: `unlink_${number}` }
          ]
        ]
      }
    });
  });

  bot.on("callback_query", (query) => {
    const userId = String(query.from.id);
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!BOT_CONFIG.users[userId]) return bot.sendMessage(chatId, "You are not authorized.");

    if (data.startsWith("link_qr_")) {
      const number = data.replace("link_qr_", "");
      bot.sendMessage(chatId, `🔗 Linking *${number}* via QR Code...`, { parse_mode: "Markdown" });
      bot.emit("link_whatsapp", { userId, number, method: "qr" });

    } else if (data.startsWith("link_num_")) {
      const number = data.replace("link_num_", "");
      bot.sendMessage(chatId, `🔗 Linking *${number}* via Phone Number...`, { parse_mode: "Markdown" });
      bot.emit("link_whatsapp", { userId, number, method: "phone" });

    } else if (data.startsWith("unlink_")) {
      const number = data.replace("unlink_", "");
      bot.sendMessage(chatId, `❌ Unlinking WhatsApp number *${number}*...`, { parse_mode: "Markdown" });
      bot.emit("unlink_whatsapp", { userId, number });

    } else if (data.startsWith("keep_") || data.startsWith("delete_")) {
      const userData = BOT_CONFIG.users[userId];
      if (!userData || !userData.deleted_messages) return;

      const msgId = data.split("_")[1];
      if (data.startsWith("keep_")) {
        userData.deleted_messages = userData.deleted_messages.filter(m => m.id !== msgId);
        bot.sendMessage(chatId, "✅ Message restored (won't be deleted).");
      } else {
        userData.deleted_messages = userData.deleted_messages.filter(m => m.id !== msgId);
        bot.sendMessage(chatId, "🗑 Message deleted permanently.");
      }
      saveConfig();
    }

    bot.answerCallbackQuery(query.id);
  });

  // -----------------------
  // DELETED MESSAGES
  // -----------------------
  bot.onText(/\/deleted_messages/, (msg) => {
    const userId = String(msg.from.id);
    if (!BOT_CONFIG.users[userId]) return bot.sendMessage(msg.chat.id, "You are not authorized.");

    const userData = BOT_CONFIG.users[userId];
    const deleted = userData.deleted_messages || [];
    if (!deleted.length) return bot.sendMessage(msg.chat.id, "No deleted messages.");

    deleted.forEach((m, idx) => {
      const text = `Message ${idx + 1} to ${m.to}:\n${m.body || "[Media/Unknown]"}`;
      bot.sendMessage(msg.chat.id, text, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Keep", callback_data: `keep_${m.id}` }],
            [{ text: "🗑 Delete permanently", callback_data: `delete_${m.id}` }]
          ]
        ]
      });
    });
  });

  // -----------------------
  // ADMIN COMMANDS
  // -----------------------
  bot.onText(/\/add_user (.+)/, (msg, match) => {
    if (String(msg.from.id) !== String(BOT_CONFIG.admin_id)) return;
    const newUserId = String(match[1]);
    BOT_CONFIG.users[newUserId] = { active: false, numbers: [], deleted_messages: [] };
    saveConfig();
    bot.sendMessage(msg.chat.id, `User ${newUserId} added successfully.`);
  });

  bot.onText(/\/remove_user (.+)/, (msg, match) => {
    if (String(msg.from.id) !== String(BOT_CONFIG.admin_id)) return;
    const targetId = String(match[1]);
    delete BOT_CONFIG.users[targetId];
    saveConfig();
    bot.sendMessage(msg.chat.id, `User ${targetId} removed successfully.`);
  });

  bot.onText(/\/view_user (.+)/, (msg, match) => {
    if (String(msg.from.id) !== String(BOT_CONFIG.admin_id)) return;
    const targetId = String(match[1]);
    const userInfo = BOT_CONFIG.users[targetId];
    bot.sendMessage(msg.chat.id, userInfo ? JSON.stringify(userInfo, null, 2) : "User not found.");
  });

  bot.onText(/\/list_users/, (msg) => {
    if (String(msg.from.id) !== String(BOT_CONFIG.admin_id)) return;
    const usersList = Object.entries(BOT_CONFIG.users)
      .map(([uid, data]) => `${uid}: ${JSON.stringify(data)}`)
      .join("\n");
    bot.sendMessage(msg.chat.id, usersList || "No users found.");
  });

  console.log("Telegram bot running...");
  module.exports = bot;
})();