require('dotenv').config();
const axios = require('axios');
const ethers = require('ethers');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');

// --- TELEGRAM INTEGRATION ---


// --- NO CHANGES HERE ---
// We keep the original variable names for full compatibility.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID; // This will now hold "123,456"

// --- NEW INTERNAL LOGIC ---
// This creates an array of IDs from your CHAT_ID variable.
// It's internal to this file and won't affect other parts of your app.
const allChatIds = CHAT_ID ? CHAT_ID.split(',') : [];

let bot;

// This original `if` condition still works perfectly.
if (TELEGRAM_TOKEN && CHAT_ID) {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    // Updated log message to be more informative.
    console.log(`Telegram bot initialized. Broadcasting to ${allChatIds.length} user(s).`);

    // --- NEW: Authorization for incoming commands ---
    // This is crucial for security and a good practice.
    bot.on('message', (msg) => {
        const senderId = msg.chat.id.toString();

        // Check if the person sending a command is in our list.
        if (!allChatIds.includes(senderId)) {
            console.log(`Unauthorized command attempt from user ID: ${senderId}`);
            bot.sendMessage(senderId, "Sorry, you are not authorized to use this bot.");
            return; // Stop processing.
        }

        // You can add commands for authorized users here.
        if (msg.text.toLowerCase() === '/status') {
            bot.sendMessage(senderId, "Bot is active and you are on the notification list.");
        }
    });

} else {
    console.log('Telegram token or chat ID not found. Skipping Telegram integration.');
}

/**
 * --- MODIFIED FUNCTION ---
 * The name and signature are IDENTICAL to your original.
 * The internal logic is changed to broadcast to everyone.
 * The `chatId` parameter is effectively ignored in favor of broadcasting.
 */
async function sendNotification(message, chatId = CHAT_ID) {
    console.log(message.replace(/[*_`[\]()~>#+\-=|{}.!]/g, '\\$&')); 

    if (bot) {
        // THE CORE CHANGE: Loop over the array we created at the top.
        for (const id of allChatIds) {
            try {
                // Send the message to each user in the list.
                await bot.sendMessage(id, message, { parse_mode: 'Markdown' });
            } catch (error) {
                // This prevents the bot from crashing if one user has blocked it.
                console.error(`Telegram Error: Could not send to ${id}. Reason:`, error.message);
            }
        }
    }
}

// Configuration
const GECKO_API_URL = 'https://api.geckoterminal.com/api/v2/networks/base/pools/0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59/trades';
const QUERY_PARAMS = { trade_volume_in_usd_greater_than: 0, token: 'base' };
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const TREND_THRESHOLD_PERCENTAGE = 0.03;
const LOG_FILE = 'trading_log.csv';

// Contract and wallet setup (rest of the config is the same)
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contractABI = ["function openLong() external", "function closeLong() external", "function findOutWhatTheFuckIsGoingOn() external", "function cleanUp() external", "function withdrawAll() external", "function owner() external view returns (address)", "function USDC() external view returns (address)", "function any(address target, bytes data) external"];
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);
const MTOKEN_ABI = ["function borrowBalanceCurrent(address account) external view returns (uint256)"];
const mWETH = new ethers.Contract('0x628ff693426583D9a7FB391E54366292F509D457', MTOKEN_ABI, wallet);
const mUSDC = new ethers.Contract('0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', MTOKEN_ABI, wallet);
const GAS_CONFIG = { gasLimit: 3000000, gasPrice: ethers.utils.parseUnits('0.1', 'gwei') };

// State tracking
let positionState = { type: 'none', entryPrice: 0, entryTime: null, txHash: null, positionSize: 0, cumulativePnl: 0 };

// ... (handleRevert, savePosition, logTrade, analyzePrices functions remain unchanged) ...
async function handleRevert(error, txHash) {
    if (error.code === 'CALL_EXCEPTION') {
        const revertMessage = `🚨 *Transaction Reverted* 🚨\nTx Hash: \`${txHash}\`\nFinding out what the fuck is going on...`;
        await sendNotification(revertMessage);
        try {
            const tx = await contract.findOutWhatTheFuckIsGoingOn(GAS_CONFIG);
            await sendNotification(`🔍 Diagnostic transaction sent: \`${tx.hash}\``);
            await tx.wait();
            await sendNotification("✅ On-chain diagnosis complete.");
        } catch (diagError) {
            await sendNotification(`❌ Error running diagnosis: \`${diagError.message}\``);
        }
    }
}

try {
    if (fs.existsSync('position.json')) {
        positionState = JSON.parse(fs.readFileSync('position.json', 'utf8'));
        if (positionState.positionSize === undefined) positionState.positionSize = 0;
        if (positionState.cumulativePnl === undefined) positionState.cumulativePnl = 0;
        console.log('Loaded previous state:', positionState);
    }
} catch (error) {
    console.log('No previous state found, starting fresh');
}

function savePosition() {
    fs.writeFileSync('position.json', JSON.stringify(positionState, null, 2));
}

function logTrade(tradeData) {
    const header = 'type,entryPrice,exitPrice,entryTime,exitTime,duration,pnl,pnlPercent,txHashOpen,txHashClose\n';
    const row = [tradeData.type, tradeData.entryPrice, tradeData.exitPrice, tradeData.entryTime, tradeData.exitTime, tradeData.duration, tradeData.pnl, tradeData.pnlPercent, tradeData.txHashOpen, tradeData.txHashClose].join(',') + '\n';
    try {
        if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, header);
        fs.appendFileSync(LOG_FILE, row);
        console.log('Trade logged successfully to', LOG_FILE);
    } catch (error) {
        console.error('Error writing to log file:', error.message);
    }
}

function analyzePrices(prices) {
    const numPrices = prices.map(p => parseFloat(p));
    if (numPrices.length < 2) return { trend: 'sideways', changeAmount: 0, percentage: 0, currentPrice: numPrices.length === 1 ? numPrices[0] : (positionState.type !== 'none' ? positionState.entryPrice : 0) };
    const oldestPrice = numPrices[0];
    const newestPrice = numPrices[numPrices.length - 1];
    const priceChange = newestPrice - oldestPrice;
    const percentage = (priceChange / oldestPrice) * 100;
    let trend = 'sideways';
    if (percentage > TREND_THRESHOLD_PERCENTAGE) trend = 'up';
    else if (percentage < -TREND_THRESHOLD_PERCENTAGE) trend = 'down';
    return { trend, changeAmount: priceChange, percentage, currentPrice: newestPrice };
}


async function closePosition(currentPrice, triggeredBy = 'system') {
    if (positionState.type === 'none') return true; // Return true if there's nothing to close

    let tx;
    try {
        await sendNotification(`⏳ Closing *${positionState.type.toUpperCase()}* position... (Triggered by ${triggeredBy})`);
        const closeFn = `close${positionState.type.charAt(0).toUpperCase() + positionState.type.slice(1)}`;
        tx = await contract[closeFn](GAS_CONFIG);
        await sendNotification(`Transaction Sent: [view on BaseScan](https://basescan.org/tx/${tx.hash})`);
        await tx.wait();

        const exitTime = new Date();
        const duration = getPositionDuration(positionState.entryTime, exitTime);
        const pnlRatio = positionState.type === 'long' ? (currentPrice - positionState.entryPrice) / positionState.entryPrice : (positionState.entryPrice - currentPrice) / positionState.entryPrice;
        const finalPnl = pnlRatio * (positionState.positionSize || 0);
        const pnlPercent = pnlRatio * 100;
        
        positionState.cumulativePnl = (positionState.cumulativePnl || 0) + finalPnl;

        const pnlIcon = finalPnl >= 0 ? '✅' : '🔻';
        const closeMessage = `
${pnlIcon} *Position Closed* ${pnlIcon}
*Type*: ${positionState.type.toUpperCase()}
*P&L*: ${finalPnl > 0 ? '+' : ''}$${finalPnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)
*Running P&L*: $${positionState.cumulativePnl.toFixed(2)}
*Close Tx*: [view on BaseScan](https://basescan.org/tx/${tx.hash})
        `;
        await sendNotification(closeMessage.trim());

        logTrade({ type: positionState.type.toUpperCase(), entryPrice: positionState.entryPrice, exitPrice: currentPrice, entryTime: positionState.entryTime, exitTime: exitTime.toISOString(), duration, pnl: finalPnl, pnlPercent, txHashOpen: positionState.txHash, txHashClose: tx.hash });
        
        positionState = { type: 'none', entryPrice: 0, entryTime: null, txHash: null, positionSize: 0, cumulativePnl: positionState.cumulativePnl };
        savePosition();

        return true;
    } catch (error) {
        await sendNotification(`❌ *Error closing position*: ${error.message}`);
        if (tx) await handleRevert(error, tx.hash);
        return false;
    }
}

// ... (executeStrategy, getPositionDuration functions remain unchanged) ...
async function executeStrategy(trend, currentPrice) {
    try {
        if (trend === 'sideways') {
            console.log('Price movement not significant. Holding or waiting.');
            return;
        }
        if (trend === 'down' && positionState.type === 'long') {
            await sendNotification(` Trend reversed. Closing current ${positionState.type} position.`);
            const closed = await closePosition(currentPrice, 'strategy');
            if (!closed) {
                await sendNotification('⚠️ Failed to close position, skipping new trade.');
                return;
            }
        }
        let tx;
        let newPositionType = 'none';
        if (trend === 'up' && positionState.type !== 'long') newPositionType = 'long';
        if (newPositionType !== 'none') {
            try {
                await sendNotification(`📈 Trend is *${trend.toUpperCase()}*. Opening *${newPositionType.toUpperCase()}* position...`);
                const openFn = `open${newPositionType.charAt(0).toUpperCase() + newPositionType.slice(1)}`;
                tx = await contract[openFn](GAS_CONFIG);
                await sendNotification(`Transaction Sent: [view on BaseScan](https://basescan.org/tx/${tx.hash})`);
                await tx.wait();
                positionState.type = newPositionType;
                positionState.entryPrice = currentPrice;
                positionState.entryTime = new Date().toISOString();
                positionState.txHash = tx.hash;
                positionState.positionSize = await getActualPositionSize();
                savePosition();
                const openIcon = newPositionType === 'long' ? '🟢' : '🔴';
                const openMessage = `
${openIcon} *${newPositionType.toUpperCase()} Position Opened* ${openIcon}
*Entry Price*: $${currentPrice.toFixed(2)}
*Position Size*: $${positionState.positionSize.toFixed(2)}
*Tx Hash*: [view on BaseScan](https://basescan.org/tx/${tx.hash})
                `;
                await sendNotification(openMessage.trim());
            } catch (error) {
                await sendNotification(`❌ *Trade execution error*: ${error.message}`);
                if (tx) await handleRevert(error, tx.hash);
            }
        }
    } catch (error) {
        await sendNotification(`🚨 *Strategy Error*: ${error.message}`);
    }
}

function getPositionDuration(entryTime, exitTime = new Date()) {
    if (!entryTime) return '0s';
    const start = new Date(entryTime);
    const seconds = Math.floor((exitTime - start) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}


async function fetchPrices() {
    try {
        const response = await axios.get(GECKO_API_URL, { params: QUERY_PARAMS });
        const trades = response.data.data;
        const wethPrices = trades.filter(trade => trade.attributes.from_token_address.toLowerCase() === WETH_ADDRESS.toLowerCase()).map(trade => trade.attributes.price_from_in_usd).slice(0, 20).reverse();
        console.clear();
        console.log('Last 20 trades (oldest to newest):', wethPrices);
        const analysis = analyzePrices(wethPrices);
        console.log(`Interval Trend: ${analysis.trend.toUpperCase()}, Change: ${analysis.percentage.toFixed(2)}%`);
        if (positionState.type !== 'none') {
            const pnlRatio = positionState.type === 'long' ? (analysis.currentPrice - positionState.entryPrice) / positionState.entryPrice : (positionState.entryPrice - analysis.currentPrice) / positionState.entryPrice;
            const pnl = pnlRatio * (positionState.positionSize || 0);
            const pnlPercent = pnlRatio * 100;
            console.log('\nCurrent Position:', { type: positionState.type.toUpperCase(), positionSize: `$${(positionState.positionSize || 0).toFixed(2)}`, entryPrice: `$${positionState.entryPrice.toFixed(2)}`, currentPrice: `$${analysis.currentPrice.toFixed(2)}`, duration: getPositionDuration(positionState.entryTime), pnl: `${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)` });
        } else {
            console.log('\nNo position currently open');
        }
        await executeStrategy(analysis.trend, analysis.currentPrice);
    } catch (error) {
        await sendNotification(`🚨 *Main Loop Error*: ${error.message}`);
    }
    setTimeout(fetchPrices, 7500);
}

// --- UPDATED STARTUP MESSAGE ---
async function startBot() {
    const startupMessage = `
🤖 *Trading Bot Started*
Monitoring for opportunities...

*Available commands:*
\`/status\` - Check current P&L and position
\`/close\` - Close position and withdraw all funds
    `;
    await sendNotification(startupMessage.trim());
    fetchPrices();
}
startBot();

async function getLatestWethPrice() {
    try {
        const response = await axios.get(GECKO_API_URL, { params: { ...QUERY_PARAMS, limit: 1 } });
        const latestTrade = response.data.data[0];
        if (latestTrade) return parseFloat(latestTrade.attributes.price_from_in_usd);
        throw new Error("Could not fetch latest trade from GeckoTerminal.");
    } catch (error) {
        console.error("Error fetching latest WETH price:", error.message);
        throw error;
    }
}

if (bot) {
    bot.onText(/\/status/, async (msg) => {
        // ... (this handler is unchanged)
        const chatId = msg.chat.id;
        let statusMessage = `📈 *Running P&L*: $${(positionState.cumulativePnl || 0).toFixed(2)}\n\n`;
        if (positionState.type === 'none') {
            statusMessage += "⚪️ *No active position.*";
            bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
            return;
        }
        try {
            const currentPrice = await getLatestWethPrice();
            const pnlRatio = positionState.type === 'long' ? (currentPrice - positionState.entryPrice) / positionState.entryPrice : (positionState.entryPrice - currentPrice) / positionState.entryPrice;
            const pnl = pnlRatio * positionState.positionSize;
            const pnlPercent = pnlRatio * 100;
            const pnlIcon = pnl >= 0 ? '💹' : '📉';
            statusMessage += `*Current Position: ${positionState.type.toUpperCase()}*\n--------------------------------------\n*Entry Price*: $${positionState.entryPrice.toFixed(4)}\n*Current Price*: $${currentPrice.toFixed(4)}\n*Position Size*: $${positionState.positionSize.toFixed(2)}\n*Duration*: ${getPositionDuration(positionState.entryTime)}\n${pnlIcon} *Unrealized P&L*: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`;
            bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, "Sorry, I couldn't fetch the latest price for the status report.");
        }
    });

    // --- RENAMED COMMAND ---
    // The command is now /close instead of /close_and_withdraw
    bot.onText(/\/close/, async (msg) => {
        // SECURITY CHECK
        if (msg.chat.id.toString() !== CHAT_ID) {
            sendNotification("🔐 Unauthorized command attempt.", msg.chat.id);
            return;
        }

        await sendNotification("✅ Received `/close` command. Initiating shutdown sequence...");

        // Step 1: Close the current position
        let closedSuccessfully = false;
        if (positionState.type === 'none') {
            await sendNotification("No active position to close. Proceeding to withdraw...");
            closedSuccessfully = true; // Nothing to close, so we can proceed
        } else {
            try {
                await sendNotification("Fetching current price to close position...");
                const currentPrice = await getLatestWethPrice();
                closedSuccessfully = await closePosition(currentPrice, 'manual /close');
            } catch (error) {
                await sendNotification(`❌ Could not fetch price to close position: ${error.message}. Aborting.`);
                return;
            }
        }
        
        // Step 2: Withdraw all funds ONLY if closing was successful
        if (closedSuccessfully) {
            let withdrawTx;
            try {
                await sendNotification("⏳ Attempting to withdraw all funds from contract...");
                withdrawTx = await contract.withdrawAll(GAS_CONFIG);
                await sendNotification(`Withdrawal transaction sent: [view on BaseScan](https://basescan.org/tx/${withdrawTx.hash})`);
                await withdrawTx.wait();
                await sendNotification("✅ *Withdrawal Successful!* All funds have been sent to the owner's wallet.");
            } catch (error) {
                await sendNotification(`❌ *Withdrawal Failed*: ${error.message}`);
                if (withdrawTx) {
                    await handleRevert(error, withdrawTx.hash);
                }
            }
        } else {
             await sendNotification("❌ Position close failed. Aborting withdrawal.");
        }
    });
}

async function getActualPositionSize() {
    try {
        const borrowedAmountWETH = await mWETH.borrowBalanceCurrent(process.env.CONTRACT_ADDRESS);
        const borrowedAmountWETHEther = ethers.utils.formatEther(borrowedAmountWETH);
        const borrowedAmountUSDC = await mUSDC.borrowBalanceCurrent(process.env.CONTRACT_ADDRESS);
        const borrowedAmountUSDCFormatted = ethers.utils.formatUnits(borrowedAmountUSDC, 6);
        const wethBalance = parseFloat(borrowedAmountWETHEther);
        const usdcBalance = parseFloat(borrowedAmountUSDCFormatted);
        if (wethBalance > 0) {
            const currentWethPrice = await getLatestWethPrice();
            return wethBalance * currentWethPrice;
        } else if (usdcBalance > 0) {
            return usdcBalance;
        }
        return positionState.positionSize;
    } catch (error) {
        await sendNotification(`⚠️ *Could not get position size*: ${error.message}`);
        return positionState.positionSize;
    }
}