// utils.js
import fs from "fs";
import path from "path";
import { promisify } from "util";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const exists = promisify(fs.exists);

// -----------------------
// CONFIG LOADING / SAVING
// -----------------------
let CONFIG = {};

export function loadConfig(configPath = "./config.json") {
  if (fs.existsSync(configPath)) {
    CONFIG = JSON.parse(fs.readFileSync(configPath));
  } else {
    CONFIG = {
      users: {},
      passkeys: {},
      admin_id: "",
      bot_token: "",
      whatsapp_sessions_path: "./sessions/",
      deleted_messages_path: "./deleted_messages/",
      deleted_messages_limit: 1000,
      log_deleted_messages: true,
      log_user_activity: true,
      passkey_length: 6,
      check_interval: 0.1,
      notify_admin_on_access_attempt: true,
    };
    fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
  }

  fs.mkdirSync(CONFIG.whatsapp_sessions_path, { recursive: true });
  fs.mkdirSync(CONFIG.deleted_messages_path, { recursive: true });
  return CONFIG;
}

export function saveConfig(config = null, configPath = "./config.json") {
  if (config) CONFIG = config;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
}

// -----------------------
// USER MANAGEMENT
// -----------------------
export function getUser(userId) {
  return CONFIG.users[String(userId)];
}

export async function addUser(userId) {
  userId = String(userId);
  if (CONFIG.users[userId]) return false;
  CONFIG.users[userId] = { numbers: [], activity_log: [], active: false };
  saveConfig();
  return true;
}

export async function removeUser(userId) {
  const removed = CONFIG.users[String(userId)];
  delete CONFIG.users[String(userId)];
  saveConfig();
  return removed;
}

export async function logUserActivity(userId, message) {
  if (!CONFIG.log_user_activity) return;
  const user = getUser(userId);
  if (user) {
    const timestamp = new Date().toISOString();
    user.activity_log.push({ time: timestamp, message });
    saveConfig();
  }
}

// -----------------------
// PASSKEY MANAGEMENT
// -----------------------
export function generatePasskey(length = CONFIG.passkey_length) {
  let result = "";
  for (let i = 0; i < length; i++) result += Math.floor(Math.random() * 10);
  return result;
}

export async function assignPasskey(userId) {
  const key = generatePasskey();
  CONFIG.passkeys[key] = String(userId);
  saveConfig();
  return key;
}

export async function validatePasskey(userId, key) {
  const validUser = CONFIG.passkeys[key];
  if (!validUser || String(userId) !== String(validUser)) return false;
  delete CONFIG.passkeys[key];
  saveConfig();
  return true;
}

// -----------------------
// WHATSAPP SESSION MANAGEMENT
// -----------------------
export async function saveWhatsAppSession(number, sessionData) {
  const dir = CONFIG.whatsapp_sessions_path;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${number}.json`);
  await writeFile(filePath, JSON.stringify(sessionData, null, 2));
}

export async function loadWhatsAppSession(number) {
  const filePath = path.join(CONFIG.whatsapp_sessions_path, `${number}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf-8"));
}

export function listWhatsAppSessions() {
  const dir = CONFIG.whatsapp_sessions_path;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => path.basename(f, ".json"));
}

// -----------------------
// DELETED MESSAGES HANDLING
// -----------------------
export async function saveDeletedMessage(number, message) {
  if (!CONFIG.log_deleted_messages) return;
  const dir = CONFIG.deleted_messages_path;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${number}.json`);

  let messages = [];
  if (fs.existsSync(filePath)) messages = JSON.parse(await readFile(filePath, "utf-8"));

  messages.push({ time: new Date().toISOString(), message });

  if (messages.length > CONFIG.deleted_messages_limit) messages = messages.slice(-CONFIG.deleted_messages_limit);

  await writeFile(filePath, JSON.stringify(messages, null, 2));
}

export async function loadDeletedMessages(number) {
  const filePath = path.join(CONFIG.deleted_messages_path, `${number}.json`);
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(await readFile(filePath, "utf-8"));
}

export async function clearDeletedMessages(number) {
  const filePath = path.join(CONFIG.deleted_messages_path, `${number}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}