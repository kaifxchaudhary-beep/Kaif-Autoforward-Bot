require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

// Load persistent config
const BOT_CONFIG_FILE = path.join(__dirname, 'botConfig.json');
let botConfig = {};

try {
    if (fs.existsSync(BOT_CONFIG_FILE)) {
        botConfig = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf-8'));
        console.log('✅ Bot config loaded from file');
    }
} catch (e) {
    console.error('Failed to load botConfig.json:', e);
}

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

const QRCode = require('qrcode');

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// Track processed statuses with counters for multiple reactions
const processedStatuses = new Map();

// Authorized number for auto-forward commands
const AUTHORIZED_NUMBER = '03039107958';

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION
// -----------------------------------------------------------------------------
let SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',').map(j => j.trim()).filter(j => j)
    : [];

let TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
    : [];

if (botConfig.sourceJids && Array.isArray(botConfig.sourceJids)) {
    SOURCE_JIDS = [...new Set([...SOURCE_JIDS, ...botConfig.sourceJids])];
}
if (botConfig.targetJids && Array.isArray(botConfig.targetJids)) {
    TARGET_JIDS = [...new Set([...TARGET_JIDS, ...botConfig.targetJids])];
}

const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
    ? process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error(`Invalid regex pattern: ${pattern}`, e);
            return null;
        }
      }).filter(regex => regex !== null)
    : [];

const NEW_TEXT = process.env.NEW_TEXT || '';

// -----------------------------------------------------------------------------
// AUTO STATUS CONFIGURATION
// -----------------------------------------------------------------------------
let AUTO_STATUS_VIEW = process.env.AUTO_STATUS_VIEW === 'true' || false;
let AUTO_STATUS_REACT = process.env.AUTO_STATUS_REACT === 'true' || false;
let AUTO_STATUS_REPLY = process.env.AUTO_STATUS_REPLY === 'true' || false;
let STATUS_REACT_EMOJI = process.env.STATUS_REACT_EMOJI || '👍,❤️,😂';
let STATUS_REPLY_TEXTS = process.env.STATUS_REPLY_TEXTS || 'Nice status!,Awesome!,Love it!';
const MAX_REACTIONS_PER_STATUS = parseInt(process.env.MAX_REACTIONS_PER_STATUS) || 100;
const MIN_REACTION_DELAY = parseInt(process.env.MIN_REACTION_DELAY) || 2000;
const MAX_REACTION_DELAY = parseInt(process.env.MAX_REACTION_DELAY) || 5000;

if (botConfig.autoStatusView !== undefined) AUTO_STATUS_VIEW = botConfig.autoStatusView;
if (botConfig.autoStatusReact !== undefined) AUTO_STATUS_REACT = botConfig.autoStatusReact;
if (botConfig.autoStatusReply !== undefined) AUTO_STATUS_REPLY = botConfig.autoStatusReply;
if (botConfig.statusReactEmoji) STATUS_REACT_EMOJI = botConfig.statusReactEmoji;
if (botConfig.statusReplyTexts) STATUS_REPLY_TEXTS = botConfig.statusReplyTexts;

let statusReactionEmojis = STATUS_REACT_EMOJI.split(',').map(e => e.trim());
let statusReplyTextsArray = STATUS_REPLY_TEXTS.split(',').map(t => t.trim());

// -----------------------------------------------------------------------------
// CONFIG SAVE FUNCTION
// -----------------------------------------------------------------------------
function saveBotConfig() {
    try {
        const configToSave = {
            sourceJids: SOURCE_JIDS,
            targetJids: TARGET_JIDS,
            autoStatusView: AUTO_STATUS_VIEW,
            autoStatusReact: AUTO_STATUS_REACT,
            autoStatusReply: AUTO_STATUS_REPLY,
            statusReactEmoji: statusReactionEmojis.join(','),
            statusReplyTexts: statusReplyTextsArray.join(','),
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(configToSave, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving bot config:', error);
        return false;
    }
}

// -----------------------------------------------------------------------------
// AUTHORIZATION CHECK
// -----------------------------------------------------------------------------
function isAuthorizedForAutoForward(senderJid) {
    const phoneNumber = senderJid.split('@')[0];
    return phoneNumber === AUTHORIZED_NUMBER;
}

function getUnauthorizedMessage() {
    return "❌ *Unauthorized Access*\n\nOnly the authorized admin (03039107958) can use auto-forward commands.\nPlease contact admin to request access.";
}

// -----------------------------------------------------------------------------
// MESSAGE CLEANING FUNCTIONS
// -----------------------------------------------------------------------------
function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        const messageTypes = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
        
        messageTypes.forEach(type => {
            if (cleanedMessage[type]?.contextInfo) {
                cleanedMessage[type].contextInfo.isForwarded = false;
                if (cleanedMessage[type].contextInfo.forwardingScore) {
                    cleanedMessage[type].contextInfo.forwardingScore = 0;
                }
            }
        });
        
        return cleanedMessage;
    } catch (error) {
        return message;
    }
}

function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g, /🔔\s*/g, /📰\s*/g, /🗞️\s*/g,
        /\[NEWSLETTER\]/gi, /\[BROADCAST\]/gi, /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi, /Broadcast:/gi, /Announcement:/gi,
        /Forwarded many times/gi, /Forwarded message/gi,
        /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    return cleanedText.trim();
}

function replaceCaption(caption) {
    if (!caption || !OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    return result;
}

function processAndCleanMessage(originalMessage) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(originalMessage));
        cleanedMessage = cleanForwardedLabel(cleanedMessage);
        
        const text = cleanedMessage.conversation ||
            cleanedMessage.extendedTextMessage?.text ||
            cleanedMessage.imageMessage?.caption ||
            cleanedMessage.videoMessage?.caption ||
            cleanedMessage.documentMessage?.caption || '';
        
        if (text) {
            const cleanedText = cleanNewsletterText(text);
            
            if (cleanedMessage.conversation) {
                cleanedMessage.conversation = cleanedText;
            } else if (cleanedMessage.extendedTextMessage?.text) {
                cleanedMessage.extendedTextMessage.text = cleanedText;
            } else if (cleanedMessage.imageMessage?.caption) {
                cleanedMessage.imageMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.videoMessage?.caption) {
                cleanedMessage.videoMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.documentMessage?.caption) {
                cleanedMessage.documentMessage.caption = replaceCaption(cleanedText);
            }
        }
        
        delete cleanedMessage.protocolMessage;
        return cleanedMessage;
    } catch (error) {
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// STATUS HANDLER - MULTIPLE REACTIONS
// -----------------------------------------------------------------------------
async function handleStatus(sock, statusMessage) {
    try {
        if (!AUTO_STATUS_VIEW && !AUTO_STATUS_REACT && !AUTO_STATUS_REPLY) return;
        
        const statusKey = statusMessage.key;
        const statusId = statusKey.id;
        const statusSender = statusKey.participant || statusKey.remoteJid;
        
        let currentCount = processedStatuses.get(statusId) || 0;
        
        if (currentCount === 0) {
            console.log(`📱 New status from: ${statusSender}`);
            console.log(`🎯 Will react up to ${MAX_REACTIONS_PER_STATUS} times`);
        }
        
        currentCount++;
        processedStatuses.set(statusId, currentCount);
        
        if (processedStatuses.size > 100) {
            const oldestKey = processedStatuses.keys().next().value;
            processedStatuses.delete(oldestKey);
        }
        
        console.log(`🔄 Status ${statusId} - Attempt #${currentCount}/${MAX_REACTIONS_PER_STATUS}`);
        
        // View status
        if (AUTO_STATUS_VIEW) {
            try {
                await sock.readMessages([statusKey]);
                console.log(`👁️ View #${currentCount} for status from: ${statusSender}`);
            } catch (error) {
                console.error('Error viewing status:', error);
            }
        }
        
        // React with different emoji
        if (AUTO_STATUS_REACT && statusReactionEmojis.length > 0) {
            try {
                const emojiIndex = (currentCount - 1) % statusReactionEmojis.length;
                const selectedEmoji = statusReactionEmojis[emojiIndex];
                
                await sock.sendMessage(statusSender, {
                    react: {
                        text: selectedEmoji,
                        key: statusKey
                    }
                });
                console.log(`❤️ Reaction #${currentCount} with ${selectedEmoji}`);
            } catch (error) {
                console.error('Error reacting:', error);
            }
        }
        
        // Reply with different text
        if (AUTO_STATUS_REPLY && statusReplyTextsArray.length > 0) {
            try {
                const replyIndex = (currentCount - 1) % statusReplyTextsArray.length;
                const selectedReply = statusReplyTextsArray[replyIndex];
                
                await sock.sendMessage(statusSender, {
                    text: selectedReply,
                    contextInfo: {
                        stanzaId: statusKey.id,
                        participant: statusSender,
                        quotedMessage: statusMessage.message
                    }
                });
                console.log(`💬 Reply #${currentCount}: "${selectedReply}"`);
            } catch (error) {
                console.error('Error replying:', error);
            }
        }
        
        // Schedule next reaction
        if (currentCount < MAX_REACTIONS_PER_STATUS) {
            const nextDelay = Math.floor(Math.random() * (MAX_REACTION_DELAY - MIN_REACTION_DELAY)) + MIN_REACTION_DELAY;
            
            console.log(`⏰ Next reaction in ${nextDelay/1000} seconds`);
            
            setTimeout(() => {
                handleStatus(sock, statusMessage);
            }, nextDelay);
        } else {
            console.log(`✅ Completed ${MAX_REACTIONS_PER_STATUS} reactions for status from: ${statusSender}`);
            processedStatuses.delete(statusId);
        }
        
    } catch (error) {
        console.error('Error in status handler:', error);
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLERS
// -----------------------------------------------------------------------------
async function handleMenuCommand(sock, from, senderJid) {
    const isAuthorized = isAuthorizedForAutoForward(senderJid);
    
    let menuText = `╔════════════════════╗
║   *MUZAMMIL MD BOT*   ║
╚════════════════════╝

*Bot Name:* Muzammil MD
*Developer:* Muzammil
*Version:* 3.0.0

╔════════════════════╗
║   *BASIC COMMANDS*   ║
╚════════════════════╝

• !ping - Check bot response
• !jid - Get current chat JID
• !gjid - List all groups
• !menu - Show this menu
• !help - Detailed help

╔════════════════════╗
║   *STATUS COMMANDS*   ║
╚════════════════════╝

• !statusreact - Reaction settings
• !statusreply - Reply settings

╔════════════════════╗
║ *AUTO-FORWARD COMMANDS* ║
╚════════════════════╝

*Restricted to: 03039107958*

• !addsource <JID> - Add source
• !addtarget <JID> - Add target
• !removesource <JID/num> - Remove source
• !removetarget <JID/num> - Remove target
• !listsources - List sources
• !listtargets - List targets

╔════════════════════╗
║   *CURRENT STATUS*   ║
╚════════════════════╝

• Auto View: ${AUTO_STATUS_VIEW ? '✅' : '❌'}
• Auto React: ${AUTO_STATUS_REACT ? '✅' : '❌'}
• Auto Reply: ${AUTO_STATUS_REPLY ? '✅' : '❌'}
• Max Reactions: ${MAX_REACTIONS_PER_STATUS}
• Sources: ${SOURCE_JIDS.length}
• Targets: ${TARGET_JIDS.length}

_Muzammil MD Bot v3.0_`;

    await sock.sendMessage(from, { text: menuText });
}

async function handleHelpCommand(sock, from, senderJid, command) {
    if (command) {
        const cmd = command.toLowerCase();
        let helpText = '';
        
        const helpMap = {
            'ping': '*!ping*\nCheck if bot is alive\nResponse: Love You😘\nAccess: Everyone',
            'jid': '*!jid*\nGet current chat JID\nAccess: Everyone',
            'gjid': '*!gjid*\nList all groups with details\nAccess: Everyone',
            'menu': '*!menu*\nShow main menu\nAccess: Everyone',
            'statusreact': '*!statusreact*\nManage reaction settings\n• !statusreact - View\n• !statusreact on/off\n• !statusreact 👍,❤️ - Set emojis\nAccess: Everyone',
            'statusreply': '*!statusreply*\nManage reply settings\n• !statusreply - View\n• !statusreply on/off\n• !statusreply text - Set reply\nAccess: Everyone',
            'addsource': '*!addsource*\nAdd source group\nExample: !addsource 123@g.us\nAccess: Admin Only',
            'addtarget': '*!addtarget*\nAdd target group\nExample: !addtarget 456@g.us\nAccess: Admin Only',
            'removesource': '*!removesource*\nRemove source\n!removesource <JID/num>\nAccess: Admin Only',
            'removetarget': '*!removetarget*\nRemove target\n!removetarget <JID/num>\nAccess: Admin Only',
            'listsources': '*!listsources*\nList all sources\nAccess: Admin Only',
            'listtargets': '*!listtargets*\nList all targets\nAccess: Admin Only'
        };
        
        helpText = helpMap[cmd] || `❌ Command '${command}' not found. Use !help`;
        await sock.sendMessage(from, { text: helpText });
    } else {
        let helpSummary = `╔════════════════════╗
║   *MUZAMMIL MD HELP*   ║
╚════════════════════╝

*BASIC (Everyone)*
!ping !jid !gjid !menu

*STATUS (Everyone)*
!statusreact !statusreply

*ADMIN ONLY (03039107958)*
!addsource !addtarget
!removesource !removetarget
!listsources !listtargets

*Details: !help <command>*

_Muzammil MD Bot v3.0_`;

        await sock.sendMessage(from, { text: helpSummary });
    }
}

async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Love You😘" });
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
}

async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            response += `${groupCount}. *${group.subject || 'Unnamed'}*\n`;
            response += `   👥 ${group.participants?.length || 0} members\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   ──────────────\n\n`;
            groupCount++;
        }
        
        response += groupCount === 1 ? "❌ No groups found." : `\n*Total: ${groupCount - 1}*`;
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error fetching groups" });
    }
}

async function handleStatusReactCommand(sock, from, args, senderJid) {
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Status React Settings*\n\n` +
                      `Status: ${AUTO_STATUS_REACT ? '✅ ON' : '❌ OFF'}\n` +
                      `Emojis: ${statusReactionEmojis.join(', ')}\n\n` +
                      `Commands:\n` +
                      `!statusreact on\n` +
                      `!statusreact off\n` +
                      `!statusreact 👍,❤️,😂`
            });
            return;
        }
        
        const firstArg = args[0].toLowerCase();
        
        if (firstArg === 'on') {
            AUTO_STATUS_REACT = true;
            saveBotConfig();
            await sock.sendMessage(from, { text: "✅ Auto Status React is now *ON*" });
            return;
        }
        
        if (firstArg === 'off') {
            AUTO_STATUS_REACT = false;
            saveBotConfig();
            await sock.sendMessage(from, { text: "❌ Auto Status React is now *OFF*" });
            return;
        }
        
        const emojiString = args.join(' ');
        const newEmojis = emojiString.split(',').map(e => e.trim());
        
        if (newEmojis.length === 0) {
            await sock.sendMessage(from, { text: "❌ No emojis provided!" });
            return;
        }
        
        statusReactionEmojis = newEmojis;
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Status reaction emojis updated to: ${newEmojis.join(', ')}` 
        });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error updating status reaction" });
    }
}

async function handleStatusReplyCommand(sock, from, args, senderJid) {
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Status Reply Settings*\n\n` +
                      `Status: ${AUTO_STATUS_REPLY ? '✅ ON' : '❌ OFF'}\n` +
                      `Replies: ${statusReplyTextsArray.join(', ')}\n\n` +
                      `Commands:\n` +
                      `!statusreply on\n` +
                      `!statusreply off\n` +
                      `!statusreply text1,text2,text3`
            });
            return;
        }
        
        const firstArg = args[0].toLowerCase();
        
        if (firstArg === 'on') {
            AUTO_STATUS_REPLY = true;
            saveBotConfig();
            await sock.sendMessage(from, { text: "✅ Auto Status Reply is now *ON*" });
            return;
        }
        
        if (firstArg === 'off') {
            AUTO_STATUS_REPLY = false;
            saveBotConfig();
            await sock.sendMessage(from, { text: "❌ Auto Status Reply is now *OFF*" });
            return;
        }
        
        const replyString = args.join(' ');
        const newReplies = replyString.split(',').map(t => t.trim());
        
        if (newReplies.length === 0) {
            await sock.sendMessage(from, { text: "❌ No reply texts provided!" });
            return;
        }
        
        statusReplyTextsArray = newReplies;
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Status reply texts updated to: ${newReplies.join(', ')}` 
        });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error updating status reply" });
    }
}

// Auto-Forward Command Handlers (Authorized Only)
async function handleAddSourceCommand(sock, from, args, senderJid) {
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `Current sources:\n${SOURCE_JIDS.map(j => `• ${j}`).join('\n') || 'None'}\n\nUsage: !addsource <JID>`
            });
            return;
        }
        
        const newJid = args[0].trim();
        
        if (!newJid.includes('@')) {
            await sock.sendMessage(from, { text: "❌ Invalid JID format!" });
            return;
        }
        
        if (SOURCE_JIDS.includes(newJid)) {
            await sock.sendMessage(from, { text: "❌ JID already exists!" });
            return;
        }
        
        SOURCE_JIDS.push(newJid);
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Added source: ${newJid}\nTotal: ${SOURCE_JIDS.length}` 
        });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error adding source" });
    }
}

async function handleAddTargetCommand(sock, from, args, senderJid) {
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `Current targets:\n${TARGET_JIDS.map(j => `• ${j}`).join('\n') || 'None'}\n\nUsage: !addtarget <JID>`
            });
            return;
        }
        
        const newJid = args[0].trim();
        
        if (!newJid.includes('@')) {
            await sock.sendMessage(from, { text: "❌ Invalid JID format!" });
            return;
        }
        
        if (TARGET_JIDS.includes(newJid)) {
            await sock.sendMessage(from, { text: "❌ JID already exists!" });
            return;
        }
        
        TARGET_JIDS.push(newJid);
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Added target: ${newJid}\nTotal: ${TARGET_JIDS.length}` 
        });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error adding target" });
    }
}

async function handleRemoveSourceCommand(sock, from, args, senderJid) {
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `Sources:\n${SOURCE_JIDS.map((j, i) => `${i+1}. ${j}`).join('\n') || 'None'}\n\nUsage: !removesource <JID/num>`
            });
            return;
        }
        
        const input = args[0].trim();
        
        if (/^\d+$/.test(input)) {
            const index = parseInt(input) - 1;
            if (index >= 0 && index < SOURCE_JIDS.length) {
                const removed = SOURCE_JIDS.splice(index, 1)[0];
                saveBotConfig();
                await sock.sendMessage(from, { text: `✅ Removed source: ${removed}` });
                return;
            }
        }
        
        const index = SOURCE_JIDS.indexOf(input);
        if (index === -1) {
            await sock.sendMessage(from, { text: "❌ JID not found!" });
            return;
        }
        
        SOURCE_JIDS.splice(index, 1);
        saveBotConfig();
        await sock.sendMessage(from, { text: `✅ Removed source: ${input}` });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error removing source" });
    }
}

async function handleRemoveTargetCommand(sock, from, args, senderJid) {
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `Targets:\n${TARGET_JIDS.map((j, i) => `${i+1}. ${j}`).join('\n') || 'None'}\n\nUsage: !removetarget <JID/num>`
            });
            return;
        }
        
        const input = args[0].trim();
        
        if (/^\d+$/.test(input)) {
            const index = parseInt(input) - 1;
            if (index >= 0 && index < TARGET_JIDS.length) {
                const removed = TARGET_JIDS.splice(index, 1)[0];
                saveBotConfig();
                await sock.sendMessage(from, { text: `✅ Removed target: ${removed}` });
                return;
            }
        }
        
        const index = TARGET_JIDS.indexOf(input);
        if (index === -1) {
            await sock.sendMessage(from, { text: "❌ JID not found!" });
            return;
        }
        
        TARGET_JIDS.splice(index, 1);
        saveBotConfig();
        await sock.sendMessage(from, { text: `✅ Removed target: ${input}` });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error removing target" });
    }
}

async function handleListSourcesCommand(sock, from, senderJid) {
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (SOURCE_JIDS.length === 0) {
            await sock.sendMessage(from, { text: "📋 No source JIDs configured." });
            return;
        }
        
        let response = "📋 *Source JIDs:*\n\n";
        SOURCE_JIDS.forEach((jid, index) => {
            response += `${index + 1}. \`${jid}\`\n`;
        });
        response += `\nTotal: ${SOURCE_JIDS.length}`;
        
        await sock.sendMessage(from, { text: response });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error listing sources" });
    }
}

async function handleListTargetsCommand(sock, from, senderJid) {
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (TARGET_JIDS.length === 0) {
            await sock.sendMessage(from, { text: "📋 No target JIDs configured." });
            return;
        }
        
        let response = "📋 *Target JIDs:*\n\n";
        TARGET_JIDS.forEach((jid, index) => {
            response += `${index + 1}. \`${jid}\`\n`;
        });
        response += `\nTotal: ${TARGET_JIDS.length}`;
        
        await sock.sendMessage(from, { text: response });
        
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error listing targets" });
    }
}

// -----------------------------------------------------------------------------
// COMMAND PROCESSOR
// -----------------------------------------------------------------------------
async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
    
    if (!text || !text.startsWith('!')) return;
    
    const commandParts = text.trim().toLowerCase().split(/\s+/);
    const command = commandParts[0];
    const args = commandParts.slice(1);
    
    try {
        switch (command) {
            case '!ping': await handlePingCommand(sock, from); break;
            case '!jid': await handleJidCommand(sock, from); break;
            case '!gjid': await handleGjidCommand(sock, from); break;
            case '!menu': await handleMenuCommand(sock, from, senderJid); break;
            case '!help': await handleHelpCommand(sock, from, senderJid, args[0]); break;
            case '!statusreact': await handleStatusReactCommand(sock, from, args, senderJid); break;
            case '!statusreply': await handleStatusReplyCommand(sock, from, args, senderJid); break;
            case '!addsource': await handleAddSourceCommand(sock, from, args, senderJid); break;
            case '!addtarget': await handleAddTargetCommand(sock, from, args, senderJid); break;
            case '!removesource': await handleRemoveSourceCommand(sock, from, args, senderJid); break;
            case '!removetarget': await handleRemoveTargetCommand(sock, from, args, senderJid); break;
            case '!listsources': await handleListSourcesCommand(sock, from, senderJid); break;
            case '!listtargets': await handleListTargetsCommand(sock, from, senderJid); break;
            default: break;
        }
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            return;
        }
        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

    const sessionState = { sock: null, isConnected: false, qr: null };
    sessions.set(sessionId, sessionState);

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
    sessionState.sock = wasi_sock;

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.isConnected = false;
            console.log(`QR generated for session: ${sessionId}`);
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected`);
            console.log(`📱 Status: View=${AUTO_STATUS_VIEW}, React=${AUTO_STATUS_REACT}, Reply=${AUTO_STATUS_REPLY}`);
            console.log(`📡 Auto-Forward: ${SOURCE_JIDS.length} sources → ${TARGET_JIDS.length} targets`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // Message Handler
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const isStatus = wasi_msg.key.remoteJid === 'status@broadcast';
        
        if (isStatus) {
            await handleStatus(wasi_sock, wasi_msg);
            return;
        }

        const wasi_origin = wasi_msg.key.remoteJid;
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption || "";

        if (wasi_text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg);
        }

        if (SOURCE_JIDS.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            try {
                let relayMsg = processAndCleanMessage(wasi_msg.message);
                if (!relayMsg) return;

                if (relayMsg.viewOnceMessageV2)
                    relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage)
                    relayMsg = relayMsg.viewOnceMessage.message;

                const isMedia = relayMsg.imageMessage || relayMsg.videoMessage || 
                               relayMsg.audioMessage || relayMsg.documentMessage || relayMsg.stickerMessage;

                let isEmojiOnly = false;
                if (relayMsg.conversation) {
                    const emojiRegex = /^(?:\p{Extended_Pictographic}|\s)+$/u;
                    isEmojiOnly = emojiRegex.test(relayMsg.conversation);
                }

                if (!isMedia && !isEmojiOnly) return;

                if (relayMsg.imageMessage?.caption) {
                    relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption);
                }
                if (relayMsg.videoMessage?.caption) {
                    relayMsg.videoMessage.caption = replaceCaption(relayMsg.videoMessage.caption);
                }

                console.log(`📦 Forwarding from ${wasi_origin}`);

                for (const targetJid of TARGET_JIDS) {
                    try {
                        await wasi_sock.relayMessage(targetJid, relayMsg, { messageId: wasi_sock.generateMessageTag() });
                        console.log(`✅ Forwarded to ${targetJid}`);
                    } catch (err) {
                        console.error(`Failed to forward to ${targetJid}:`, err.message);
                    }
                }
            } catch (err) {
                console.error('Auto Forward Error:', err.message);
            }
        }
    });
}

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;

    if (session) {
        connected = session.isConnected;
        if (session.qr) {
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) { }
        }
    }

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        activeSessions: Array.from(sessions.keys()),
        authorizedNumber: AUTHORIZED_NUMBER,
        statusFeatures: {
            autoView: AUTO_STATUS_VIEW,
            autoReact: AUTO_STATUS_REACT,
            autoReply: AUTO_STATUS_REPLY,
            reactionEmojis: statusReactionEmojis,
            replyTexts: statusReplyTextsArray,
            maxReactions: MAX_REACTIONS_PER_STATUS
        },
        forwardConfig: {
            sources: SOURCE_JIDS,
            targets: TARGET_JIDS
        }
    });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`\n🌐 Server running on port ${wasi_port}`);
        console.log(`🤖 Bot Name: Muzammil MD`);
        console.log(`🔐 Admin: ${AUTHORIZED_NUMBER}`);
        console.log(`\n📱 STATUS FEATURES:`);
        console.log(`   👁️ Auto View: ${AUTO_STATUS_VIEW ? 'ON' : 'OFF'}`);
        console.log(`   ❤️ Auto React: ${AUTO_STATUS_REACT ? 'ON' : 'OFF'}`);
        console.log(`   💬 Auto Reply: ${AUTO_STATUS_REPLY ? 'ON' : 'OFF'}`);
        console.log(`   🔄 Max Reactions: ${MAX_REACTIONS_PER_STATUS}`);
        console.log(`\n📡 AUTO FORWARD:`);
        console.log(`   📤 Sources: ${SOURCE_JIDS.length}`);
        console.log(`   📥 Targets: ${TARGET_JIDS.length}`);
        console.log(`\n📋 Commands: !menu for all commands\n`);
    });
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) console.log('✅ Database connected');
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);
    wasi_startServer();
}

main();
