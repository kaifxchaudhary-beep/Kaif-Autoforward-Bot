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
const axios = require('axios');

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

// Track processed statuses
const processedStatuses = new Set();

// Store deleted messages
const deletedMessagesCache = new Map();

// Track current emoji index for round-robin
let currentEmojiIndex = 0;

// Admin numbers (comma separated in env)
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS ? 
    process.env.ADMIN_NUMBERS.split(',').map(n => n.trim()) : ['03039107958'];

// -----------------------------------------------------------------------------
// CONFIGURATION VARIABLES
// -----------------------------------------------------------------------------
// Auto Status
let AUTO_STATUS_VIEW = process.env.AUTO_STATUS_VIEW === 'true' || false;
let AUTO_STATUS_REACT = process.env.AUTO_STATUS_REACT === 'true' || false;
let STATUS_REACT_EMOJI = process.env.STATUS_REACT_EMOJI || '👍,❤️,😂,😍,👏,🔥';

// Anti Delete
let ANTI_DELETE_ENABLED = process.env.ANTI_DELETE_ENABLED === 'true' || false;
let ANTI_DELETE_STATUS = process.env.ANTI_DELETE_STATUS === 'true' || false;

// Anti Link
let ANTI_LINK_ENABLED = process.env.ANTI_LINK_ENABLED === 'true' || false;
let ANTI_LINK_ACTION = process.env.ANTI_LINK_ACTION || 'delete'; // delete, warn, kick
let ALLOWED_LINKS = process.env.ALLOWED_LINKS ? 
    process.env.ALLOWED_LINKS.split(',').map(l => l.trim()) : [];

// Load from botConfig
if (botConfig.autoStatusView !== undefined) AUTO_STATUS_VIEW = botConfig.autoStatusView;
if (botConfig.autoStatusReact !== undefined) AUTO_STATUS_REACT = botConfig.autoStatusReact;
if (botConfig.statusReactEmoji) STATUS_REACT_EMOJI = botConfig.statusReactEmoji;
if (botConfig.antiDeleteEnabled !== undefined) ANTI_DELETE_ENABLED = botConfig.antiDeleteEnabled;
if (botConfig.antiDeleteStatus !== undefined) ANTI_DELETE_STATUS = botConfig.antiDeleteStatus;
if (botConfig.antiLinkEnabled !== undefined) ANTI_LINK_ENABLED = botConfig.antiLinkEnabled;
if (botConfig.antiLinkAction) ANTI_LINK_ACTION = botConfig.antiLinkAction;
if (botConfig.allowedLinks) ALLOWED_LINKS = botConfig.allowedLinks;

let statusReactionEmojis = STATUS_REACT_EMOJI.split(',').map(e => e.trim());

// -----------------------------------------------------------------------------
// CONFIG SAVE FUNCTION
// -----------------------------------------------------------------------------
function saveBotConfig() {
    try {
        const configToSave = {
            autoStatusView: AUTO_STATUS_VIEW,
            autoStatusReact: AUTO_STATUS_REACT,
            statusReactEmoji: statusReactionEmojis.join(','),
            antiDeleteEnabled: ANTI_DELETE_ENABLED,
            antiDeleteStatus: ANTI_DELETE_STATUS,
            antiLinkEnabled: ANTI_LINK_ENABLED,
            antiLinkAction: ANTI_LINK_ACTION,
            allowedLinks: ALLOWED_LINKS,
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
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------
function isAdmin(jid) {
    const phoneNumber = jid.split('@')[0];
    return ADMIN_NUMBERS.includes(phoneNumber);
}

function isGroup(jid) {
    return jid.endsWith('@g.us');
}

function extractLinks(text) {
    if (!text) return [];
    const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.(com|org|net|gov|edu|pk|in|uk|au|ca|de|fr|jp|cn|br|ru|app|io|xyz|tech|online|site|club|pk)[^\s]*)/gi;
    return text.match(urlRegex) || [];
}

function isLinkAllowed(link) {
    if (ALLOWED_LINKS.length === 0) return false;
    return ALLOWED_LINKS.some(allowed => link.includes(allowed));
}

// -----------------------------------------------------------------------------
// STATUS HANDLER
// -----------------------------------------------------------------------------
async function handleStatus(sock, statusMessage) {
    try {
        if (!AUTO_STATUS_VIEW && !AUTO_STATUS_REACT) return;
        
        const statusKey = statusMessage.key;
        const statusId = statusKey.id;
        const statusSender = statusKey.participant || statusKey.remoteJid;
        
        if (processedStatuses.has(statusId)) {
            return;
        }
        
        processedStatuses.add(statusId);
        console.log(`📱 New status from: ${statusSender}`);
        
        if (processedStatuses.size > 1000) {
            const iterator = processedStatuses.values();
            for (let i = 0; i < 500; i++) {
                processedStatuses.delete(iterator.next().value);
            }
        }
        
        if (AUTO_STATUS_VIEW) {
            try {
                await sock.readMessages([statusKey]);
                console.log(`👁️ Viewed status from: ${statusSender}`);
            } catch (error) {
                console.error('Error viewing status:', error);
            }
        }
        
        if (AUTO_STATUS_REACT && statusReactionEmojis.length > 0) {
            try {
                const selectedEmoji = statusReactionEmojis[currentEmojiIndex];
                currentEmojiIndex = (currentEmojiIndex + 1) % statusReactionEmojis.length;
                
                await sock.sendMessage(statusSender, {
                    react: {
                        text: selectedEmoji,
                        key: statusKey
                    }
                });
                console.log(`❤️ Reacted to status with ${selectedEmoji}`);
            } catch (error) {
                console.error('Error reacting:', error);
            }
        }
        
    } catch (error) {
        console.error('Error in status handler:', error);
    }
}

// -----------------------------------------------------------------------------
// ANTI DELETE HANDLER
// -----------------------------------------------------------------------------
async function handleAntiDelete(sock, msg) {
    try {
        if (!ANTI_DELETE_ENABLED) return;
        
        const from = msg.key.remoteJid;
        
        // Check for deleted messages in groups
        if (msg.message?.protocolMessage?.type === 0) { // Revoke/Delete message
            const protocolMsg = msg.message.protocolMessage;
            const deletedMsgId = protocolMsg.key.id;
            const deletedMsgFrom = protocolMsg.key.remoteJid;
            
            // Check if we have this message cached
            if (deletedMessagesCache.has(deletedMsgId)) {
                const cachedMsg = deletedMessagesCache.get(deletedMsgId);
                
                const deletedBy = msg.key.participant || msg.key.remoteJid;
                const deletedByName = msg.pushName || 'Unknown';
                
                let caption = `🚫 *MESSAGE DELETED*\n\n`;
                caption += `• Deleted by: ${deletedByName} (${deletedBy.split('@')[0]})\n`;
                caption += `• Chat: ${deletedMsgFrom}\n`;
                caption += `• Time: ${new Date().toLocaleString()}\n\n`;
                
                if (cachedMsg.text) {
                    caption += `*Message Content:*\n${cachedMsg.text}`;
                    await sock.sendMessage(deletedMsgFrom, { text: caption });
                } else if (cachedMsg.media) {
                    caption += `*Media Type:* ${cachedMsg.mediaType}`;
                    await sock.sendMessage(deletedMsgFrom, { text: caption });
                    
                    // Try to resend media if available
                    if (cachedMsg.mediaData) {
                        await sock.sendMessage(deletedMsgFrom, cachedMsg.mediaData);
                    }
                }
                
                console.log(`🚫 Captured deleted message from ${deletedBy}`);
                deletedMessagesCache.delete(deletedMsgId);
            }
        }
        
        // Check for deleted statuses
        if (ANTI_DELETE_STATUS && from === 'status@broadcast' && msg.message?.protocolMessage?.type === 0) {
            console.log(`🚫 Status deleted by ${msg.key.participant || 'Unknown'}`);
        }
        
    } catch (error) {
        console.error('Error in anti-delete handler:', error);
    }
}

// -----------------------------------------------------------------------------
// ANTI LINK HANDLER
// -----------------------------------------------------------------------------
async function handleAntiLink(sock, msg) {
    try {
        if (!ANTI_LINK_ENABLED) return;
        
        const from = msg.key.remoteJid;
        if (!isGroup(from)) return;
        
        const sender = msg.key.participant || msg.key.remoteJid;
        if (isAdmin(sender)) return; // Skip admins
        
        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            "";
        
        const links = extractLinks(text);
        if (links.length === 0) return;
        
        // Check if any link is not allowed
        const hasDisallowedLink = links.some(link => !isLinkAllowed(link));
        
        if (hasDisallowedLink) {
            console.log(`🔗 Link detected in ${from} from ${sender}: ${links.join(', ')}`);
            
            // Delete the message
            if (ANTI_LINK_ACTION === 'delete' || ANTI_LINK_ACTION === 'warn') {
                try {
                    await sock.sendMessage(from, { delete: msg.key });
                    console.log(`🗑️ Deleted link message from ${sender}`);
                } catch (error) {
                    console.error('Error deleting message:', error);
                }
            }
            
            // Send warning
            if (ANTI_LINK_ACTION === 'warn' || ANTI_LINK_ACTION === 'kick') {
                const warnMsg = `⚠️ *Anti-Link System*\n\n@${sender.split('@')[0]}, links are not allowed in this group.`;
                await sock.sendMessage(from, { 
                    text: warnMsg,
                    mentions: [sender]
                });
            }
            
            // Kick member
            if (ANTI_LINK_ACTION === 'kick') {
                try {
                    await sock.groupParticipantsUpdate(from, [sender], 'remove');
                    console.log(`👢 Kicked ${sender} for sending link`);
                } catch (error) {
                    console.error('Error kicking member:', error);
                }
            }
        }
        
    } catch (error) {
        console.error('Error in anti-link handler:', error);
    }
}

// -----------------------------------------------------------------------------
// CACHE MESSAGES FOR ANTI-DELETE
// -----------------------------------------------------------------------------
function cacheMessage(msg) {
    try {
        if (!ANTI_DELETE_ENABLED) return;
        
        const msgId = msg.key.id;
        const msgText = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            "";
        
        let mediaType = null;
        let mediaData = null;
        
        if (msg.message.imageMessage) {
            mediaType = 'Image';
            mediaData = {
                image: msg.message.imageMessage,
                caption: msg.message.imageMessage.caption
            };
        } else if (msg.message.videoMessage) {
            mediaType = 'Video';
            mediaData = {
                video: msg.message.videoMessage,
                caption: msg.message.videoMessage.caption
            };
        } else if (msg.message.audioMessage) {
            mediaType = 'Audio';
        } else if (msg.message.documentMessage) {
            mediaType = 'Document';
        } else if (msg.message.stickerMessage) {
            mediaType = 'Sticker';
        }
        
        deletedMessagesCache.set(msgId, {
            text: msgText,
            media: !!mediaType,
            mediaType: mediaType,
            mediaData: mediaData,
            timestamp: Date.now()
        });
        
        // Limit cache size
        if (deletedMessagesCache.size > 500) {
            const oldestKey = deletedMessagesCache.keys().next().value;
            deletedMessagesCache.delete(oldestKey);
        }
        
    } catch (error) {
        console.error('Error caching message:', error);
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLERS
// -----------------------------------------------------------------------------
async function handleMenuCommand(sock, from) {
    let menuText = `╔════════════════════╗
║   *MUZAMMIL MD BOT*   ║
╚════════════════════╝

*Bot:* Muzammil MD
*Version:* 3.0.0

╔════════════════════╗
║   *BASIC COMMANDS*   ║
╚════════════════════╝

• !ping - Check bot response
• !menu - Show this menu
• !help - Show help

╔════════════════════╗
║   *STATUS COMMANDS*   ║
╚════════════════════╝

• !status - Show settings
• !statusview on/off - Toggle auto view
• !statusreact on/off - Toggle auto react
• !setemojis 👍,❤️,😂 - Set reaction emojis

╔════════════════════╗
║  *ANTI-DELETE COMMANDS*  ║
╚════════════════════╝

• !antidelete on/off - Toggle anti-delete
• !antistatus on/off - Toggle status delete capture
• !deletedcache - Show cache size

╔════════════════════╗
║   *ANTI-LINK COMMANDS*   ║
╚════════════════════╝

• !antilink on/off - Toggle anti-link
• !antilink action delete/warn/kick - Set action
• !allowlink domain.com - Add allowed domain
• !removelink domain.com - Remove allowed domain
• !listlinks - List allowed domains

╔════════════════════╗
║   *CURRENT STATUS*   ║
╚════════════════════╝

• Status View: ${AUTO_STATUS_VIEW ? '✅' : '❌'}
• Status React: ${AUTO_STATUS_REACT ? '✅' : '❌'}
• Anti-Delete: ${ANTI_DELETE_ENABLED ? '✅' : '❌'}
• Anti-Status: ${ANTI_DELETE_STATUS ? '✅' : '❌'}
• Anti-Link: ${ANTI_LINK_ENABLED ? '✅' : '❌'}
• Action: ${ANTI_LINK_ACTION}

_Muzammil MD Bot_`;

    await sock.sendMessage(from, { text: menuText });
}

async function handleHelpCommand(sock, from) {
    let helpText = `╔════════════════════╗
║   *MUZAMMIL MD HELP*   ║
╚════════════════════╝

*BASIC COMMANDS*
!ping - Check bot
!menu - Main menu
!help - This help

*STATUS FEATURES*
!statusview on/off - Auto view status
!statusreact on/off - Auto react to status
!setemojis 👍,❤️,😂 - Set reaction emojis

*ANTI-DELETE FEATURES*
Captures deleted messages and shows who deleted
!antidelete on/off - Enable/disable
!antistatus on/off - Capture deleted statuses

*ANTI-LINK FEATURES*
Blocks links in groups
!antilink on/off - Enable/disable
!antilink action delete/warn/kick - Set action
!allowlink domain.com - Add allowed domain
!removelink domain.com - Remove domain
!listlinks - Show allowed domains

*Note: Some commands are admin only*`;

    await sock.sendMessage(from, { text: helpText });
}

async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Love You😘" });
}

// Status Commands
async function handleStatusCommand(sock, from) {
    let statusText = `*Current Status Settings*

Auto View: ${AUTO_STATUS_VIEW ? '✅ ON' : '❌ OFF'}
Auto React: ${AUTO_STATUS_REACT ? '✅ ON' : '❌ OFF'}

Reaction Emojis:
${statusReactionEmojis.map((e, i) => `${i+1}. ${e}`).join('\n')}

Next Emoji: ${statusReactionEmojis[currentEmojiIndex]}

Processed Statuses: ${processedStatuses.size}`;

    await sock.sendMessage(from, { text: statusText });
}

async function handleStatusViewCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { text: `Auto Status View is currently ${AUTO_STATUS_VIEW ? '✅ ON' : '❌ OFF'}\n\nUse: !statusview on/off` });
        return;
    }
    
    const option = args[0].toLowerCase();
    
    if (option === 'on') {
        AUTO_STATUS_VIEW = true;
        saveBotConfig();
        await sock.sendMessage(from, { text: "✅ Auto Status View is now *ON*" });
    } else if (option === 'off') {
        AUTO_STATUS_VIEW = false;
        saveBotConfig();
        await sock.sendMessage(from, { text: "❌ Auto Status View is now *OFF*" });
    } else {
        await sock.sendMessage(from, { text: "Usage: !statusview on/off" });
    }
}

async function handleStatusReactCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { text: `Auto Status React is currently ${AUTO_STATUS_REACT ? '✅ ON' : '❌ OFF'}\n\nUse: !statusreact on/off` });
        return;
    }
    
    const option = args[0].toLowerCase();
    
    if (option === 'on') {
        AUTO_STATUS_REACT = true;
        saveBotConfig();
        await sock.sendMessage(from, { text: "✅ Auto Status React is now *ON*" });
    } else if (option === 'off') {
        AUTO_STATUS_REACT = false;
        saveBotConfig();
        await sock.sendMessage(from, { text: "❌ Auto Status React is now *OFF*" });
    } else {
        await sock.sendMessage(from, { text: "Usage: !statusreact on/off" });
    }
}

async function handleSetEmojisCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { 
            text: `Current emojis: ${statusReactionEmojis.join(' ')}\n\nUsage: !setemojis 👍,❤️,😂` 
        });
        return;
    }
    
    const emojiString = args.join(' ');
    const newEmojis = emojiString.split(',').map(e => e.trim());
    
    if (newEmojis.length === 0) {
        await sock.sendMessage(from, { text: "❌ No emojis provided!" });
        return;
    }
    
    statusReactionEmojis = newEmojis;
    currentEmojiIndex = 0;
    saveBotConfig();
    
    await sock.sendMessage(from, { 
        text: `✅ Reaction emojis updated to: ${newEmojis.join(' ')}` 
    });
}

// Anti-Delete Commands
async function handleAntiDeleteCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { text: `Anti-Delete is currently ${ANTI_DELETE_ENABLED ? '✅ ON' : '❌ OFF'}\n\nUse: !antidelete on/off` });
        return;
    }
    
    const option = args[0].toLowerCase();
    
    if (option === 'on') {
        ANTI_DELETE_ENABLED = true;
        saveBotConfig();
        await sock.sendMessage(from, { text: "✅ Anti-Delete is now *ON*" });
    } else if (option === 'off') {
        ANTI_DELETE_ENABLED = false;
        saveBotConfig();
        await sock.sendMessage(from, { text: "❌ Anti-Delete is now *OFF*" });
    } else {
        await sock.sendMessage(from, { text: "Usage: !antidelete on/off" });
    }
}

async function handleAntiStatusCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { text: `Anti-Delete Status is currently ${ANTI_DELETE_STATUS ? '✅ ON' : '❌ OFF'}\n\nUse: !antistatus on/off` });
        return;
    }
    
    const option = args[0].toLowerCase();
    
    if (option === 'on') {
        ANTI_DELETE_STATUS = true;
        saveBotConfig();
        await sock.sendMessage(from, { text: "✅ Anti-Delete Status is now *ON*" });
    } else if (option === 'off') {
        ANTI_DELETE_STATUS = false;
        saveBotConfig();
        await sock.sendMessage(from, { text: "❌ Anti-Delete Status is now *OFF*" });
    } else {
        await sock.sendMessage(from, { text: "Usage: !antistatus on/off" });
    }
}

async function handleDeletedCacheCommand(sock, from, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    await sock.sendMessage(from, { 
        text: `📦 Deleted Messages Cache: ${deletedMessagesCache.size} messages` 
    });
}

// Anti-Link Commands
async function handleAntiLinkCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { text: `Anti-Link is currently ${ANTI_LINK_ENABLED ? '✅ ON' : '❌ OFF'}\nAction: ${ANTI_LINK_ACTION}\n\nUse: !antilink on/off` });
        return;
    }
    
    const option = args[0].toLowerCase();
    
    if (option === 'on') {
        ANTI_LINK_ENABLED = true;
        saveBotConfig();
        await sock.sendMessage(from, { text: "✅ Anti-Link is now *ON*" });
    } else if (option === 'off') {
        ANTI_LINK_ENABLED = false;
        saveBotConfig();
        await sock.sendMessage(from, { text: "❌ Anti-Link is now *OFF*" });
    } else if (option === 'action' && args[1]) {
        const action = args[1].toLowerCase();
        if (['delete', 'warn', 'kick'].includes(action)) {
            ANTI_LINK_ACTION = action;
            saveBotConfig();
            await sock.sendMessage(from, { text: `✅ Anti-Link action set to: *${action}*` });
        } else {
            await sock.sendMessage(from, { text: "❌ Invalid action! Use: delete/warn/kick" });
        }
    } else {
        await sock.sendMessage(from, { text: "Usage: !antilink on/off\n!antilink action delete/warn/kick" });
    }
}

async function handleAllowLinkCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { text: `Usage: !allowlink domain.com` });
        return;
    }
    
    const domain = args[0].toLowerCase();
    
    if (ALLOWED_LINKS.includes(domain)) {
        await sock.sendMessage(from, { text: `❌ ${domain} is already allowed` });
        return;
    }
    
    ALLOWED_LINKS.push(domain);
    saveBotConfig();
    await sock.sendMessage(from, { text: `✅ Added ${domain} to allowed links` });
}

async function handleRemoveLinkCommand(sock, from, args, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (!args || args.length === 0) {
        await sock.sendMessage(from, { text: `Usage: !removelink domain.com` });
        return;
    }
    
    const domain = args[0].toLowerCase();
    const index = ALLOWED_LINKS.indexOf(domain);
    
    if (index === -1) {
        await sock.sendMessage(from, { text: `❌ ${domain} not found in allowed links` });
        return;
    }
    
    ALLOWED_LINKS.splice(index, 1);
    saveBotConfig();
    await sock.sendMessage(from, { text: `✅ Removed ${domain} from allowed links` });
}

async function handleListLinksCommand(sock, from, sender) {
    if (!isAdmin(sender)) {
        await sock.sendMessage(from, { text: "❌ Admin only command!" });
        return;
    }
    
    if (ALLOWED_LINKS.length === 0) {
        await sock.sendMessage(from, { text: "📋 No allowed links configured" });
        return;
    }
    
    let response = "📋 *Allowed Links:*\n\n";
    ALLOWED_LINKS.forEach((link, index) => {
        response += `${index + 1}. ${link}\n`;
    });
    
    await sock.sendMessage(from, { text: response });
}

// -----------------------------------------------------------------------------
// COMMAND PROCESSOR
// -----------------------------------------------------------------------------
async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";
    
    if (!text || !text.startsWith('!')) return;
    
    const commandParts = text.trim().toLowerCase().split(/\s+/);
    const command = commandParts[0];
    const args = commandParts.slice(1);
    
    try {
        switch (command) {
            case '!ping': await handlePingCommand(sock, from); break;
            case '!menu': await handleMenuCommand(sock, from); break;
            case '!help': await handleHelpCommand(sock, from); break;
            
            // Status commands
            case '!status': await handleStatusCommand(sock, from); break;
            case '!statusview': await handleStatusViewCommand(sock, from, args, sender); break;
            case '!statusreact': await handleStatusReactCommand(sock, from, args, sender); break;
            case '!setemojis': await handleSetEmojisCommand(sock, from, args, sender); break;
            
            // Anti-Delete commands
            case '!antidelete': await handleAntiDeleteCommand(sock, from, args, sender); break;
            case '!antistatus': await handleAntiStatusCommand(sock, from, args, sender); break;
            case '!deletedcache': await handleDeletedCacheCommand(sock, from, sender); break;
            
            // Anti-Link commands
            case '!antilink': await handleAntiLinkCommand(sock, from, args, sender); break;
            case '!allowlink': await handleAllowLinkCommand(sock, from, args, sender); break;
            case '!removelink': await handleRemoveLinkCommand(sock, from, args, sender); break;
            case '!listlinks': await handleListLinksCommand(sock, from, sender); break;
            
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
            console.log(`\n📱 STATUS FEATURES:`);
            console.log(`   View: ${AUTO_STATUS_VIEW ? 'ON' : 'OFF'}, React: ${AUTO_STATUS_REACT ? 'ON' : 'OFF'}`);
            console.log(`\n🛡️ ANTI-DELETE: ${ANTI_DELETE_ENABLED ? 'ON' : 'OFF'}, Status: ${ANTI_DELETE_STATUS ? 'ON' : 'OFF'}`);
            console.log(`\n🔗 ANTI-LINK: ${ANTI_LINK_ENABLED ? 'ON' : 'OFF'}, Action: ${ANTI_LINK_ACTION}`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // Message Handler
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        // Cache messages for anti-delete
        cacheMessage(wasi_msg);

        // Handle status messages
        if (wasi_msg.key.remoteJid === 'status@broadcast') {
            await handleStatus(wasi_sock, wasi_msg);
        }

        // Handle anti-delete
        await handleAntiDelete(wasi_sock, wasi_msg);

        // Handle anti-link
        await handleAntiLink(wasi_sock, wasi_msg);

        // Handle commands
        const text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            "";
        
        if (text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg);
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
        admins: ADMIN_NUMBERS,
        features: {
            status: {
                view: AUTO_STATUS_VIEW,
                react: AUTO_STATUS_REACT,
                emojis: statusReactionEmojis
            },
            antiDelete: {
                enabled: ANTI_DELETE_ENABLED,
                status: ANTI_DELETE_STATUS,
                cacheSize: deletedMessagesCache.size
            },
            antiLink: {
                enabled: ANTI_LINK_ENABLED,
                action: ANTI_LINK_ACTION,
                allowedLinks: ALLOWED_LINKS
            }
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
        console.log(`👑 Admins: ${ADMIN_NUMBERS.join(', ')}`);
        console.log(`\n📱 STATUS:`);
        console.log(`   View: ${AUTO_STATUS_VIEW ? 'ON' : 'OFF'}, React: ${AUTO_STATUS_REACT ? 'ON' : 'OFF'}`);
        console.log(`   Emojis: ${statusReactionEmojis.join(' ')}`);
        console.log(`\n🛡️ ANTI-DELETE: ${ANTI_DELETE_ENABLED ? 'ON' : 'OFF'}`);
        console.log(`   Status Delete: ${ANTI_DELETE_STATUS ? 'ON' : 'OFF'}`);
        console.log(`\n🔗 ANTI-LINK: ${ANTI_LINK_ENABLED ? 'ON' : 'OFF'}`);
        console.log(`   Action: ${ANTI_LINK_ACTION}`);
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
