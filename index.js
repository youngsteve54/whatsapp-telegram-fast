// index.js
import { main as startTelegramBot } from "./telegram_bot.js";
import { runWhatsAppBot } from "./whatsapp_bot.js";

const run = async () => {
  try {
    // Run both bots at the same time
    await Promise.all([
      startTelegramBot(),
      runWhatsAppBot()
    ]);
  } catch (err) {
    console.error("Error running bots:", err);
    process.exit(1);
  }
};

run();