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

// Track processed statuses to avoid duplicate reactions
const processedStatuses = new Set();

// Authorized number for auto-forward commands
const AUTHORIZED_NUMBER = '03039107958'; // Only this number can use auto-forward commands

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION (with dynamic updates)
// -----------------------------------------------------------------------------
let SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',').map(j => j.trim()).filter(j => j)
    : [];

let TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
    : [];

// Load from botConfig if available
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

const NEW_TEXT = process.env.NEW_TEXT
    ? process.env.NEW_TEXT
    : '';

// -----------------------------------------------------------------------------
// AUTO STATUS VIEW & REACT CONFIGURATION (with dynamic updates)
// -----------------------------------------------------------------------------
let AUTO_STATUS_VIEW = process.env.AUTO_STATUS_VIEW === 'true' || false;
let AUTO_STATUS_REACT = process.env.AUTO_STATUS_REACT === 'true' || false;
let AUTO_STATUS_REPLY = process.env.AUTO_STATUS_REPLY === 'true' || false;
let STATUS_REACT_EMOJI = process.env.STATUS_REACT_EMOJI || '👍';
let STATUS_REPLY_TEXT = process.env.STATUS_REPLY_TEXT || 'Nice status!';
const STATUS_REACT_INTERVAL = parseInt(process.env.STATUS_REACT_INTERVAL) || 2000;
const STATUS_VIEW_DELAY = parseInt(process.env.STATUS_VIEW_DELAY) || 1000;
const STATUS_REPLY_DELAY = parseInt(process.env.STATUS_REPLY_DELAY) || 3000;

// Load from botConfig if available
if (botConfig.autoStatusView !== undefined) AUTO_STATUS_VIEW = botConfig.autoStatusView;
if (botConfig.autoStatusReact !== undefined) AUTO_STATUS_REACT = botConfig.autoStatusReact;
if (botConfig.autoStatusReply !== undefined) AUTO_STATUS_REPLY = botConfig.autoStatusReply;
if (botConfig.statusReactEmoji) STATUS_REACT_EMOJI = botConfig.statusReactEmoji;
if (botConfig.statusReplyText) STATUS_REPLY_TEXT = botConfig.statusReplyText;

// Store for status reactions
let statusReactionEmojis = STATUS_REACT_EMOJI.split(',').map(e => e.trim());

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR CONFIG SAVING
// -----------------------------------------------------------------------------

/**
 * Save bot configuration to file
 */
function saveBotConfig() {
    try {
        const configToSave = {
            sourceJids: SOURCE_JIDS,
            targetJids: TARGET_JIDS,
            autoStatusView: AUTO_STATUS_VIEW,
            autoStatusReact: AUTO_STATUS_REACT,
            autoStatusReply: AUTO_STATUS_REPLY,
            statusReactEmoji: statusReactionEmojis.join(','),
            statusReplyText: STATUS_REPLY_TEXT,
            updatedAt: new Date().toISOString()
        };
        
        fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(configToSave, null, 2));
        console.log('✅ Bot config saved to file');
        return true;
    } catch (error) {
        console.error('Error saving bot config:', error);
        return false;
    }
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR AUTHORIZATION
// -----------------------------------------------------------------------------

/**
 * Check if user is authorized for auto-forward commands
 */
function isAuthorizedForAutoForward(senderJid) {
    // Extract phone number from JID (remove @s.whatsapp.net)
    const phoneNumber = senderJid.split('@')[0];
    return phoneNumber === AUTHORIZED_NUMBER;
}

/**
 * Get unauthorized message
 */
function getUnauthorizedMessage() {
    return "❌ *Unauthorized Access*\n\nOnly the authorized admin can use auto-forward commands.\nPlease contact admin @03039107958 to request access.";
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

/**
 * Clean forwarded label from message
 */
function cleanForwardedLabel(message) {
    try {
        // Clone the message to avoid modifying original
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        // Remove forwarded flag from different message types
        if (cleanedMessage.extendedTextMessage?.contextInfo) {
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.extendedTextMessage.contextInfo.forwardingScore) {
                cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.imageMessage?.contextInfo) {
            cleanedMessage.imageMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.imageMessage.contextInfo.forwardingScore) {
                cleanedMessage.imageMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.videoMessage?.contextInfo) {
            cleanedMessage.videoMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.videoMessage.contextInfo.forwardingScore) {
                cleanedMessage.videoMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.audioMessage?.contextInfo) {
            cleanedMessage.audioMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.audioMessage.contextInfo.forwardingScore) {
                cleanedMessage.audioMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.documentMessage?.contextInfo) {
            cleanedMessage.documentMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.documentMessage.contextInfo.forwardingScore) {
                cleanedMessage.documentMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

/**
 * Clean newsletter/information markers from text
 */
function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g,
        /🔔\s*/g,
        /📰\s*/g,
        /🗞️\s*/g,
        /\[NEWSLETTER\]/gi,
        /\[BROADCAST\]/gi,
        /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi,
        /Broadcast:/gi,
        /Announcement:/gi,
        /Forwarded many times/gi,
        /Forwarded message/gi,
        /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    return cleanedText.trim();
}

/**
 * Replace caption text using regex patterns
 */
function replaceCaption(caption) {
    if (!caption) return caption;
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    return result;
}

/**
 * Process and clean a message completely
 */
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
        console.error('Error processing message:', error);
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// STATUS HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Handle auto status view and react
 */
async function handleStatus(sock, statusMessage) {
    try {
        if (!AUTO_STATUS_VIEW && !AUTO_STATUS_REACT && !AUTO_STATUS_REPLY) return;
        
        const statusKey = statusMessage.key;
        const statusId = statusKey.id;
        
        if (processedStatuses.has(statusId)) return;
        
        processedStatuses.add(statusId);
        
        if (processedStatuses.size > 1000) {
            const iterator = processedStatuses.values();
            for (let i = 0; i < 500; i++) {
                processedStatuses.delete(iterator.next().value);
            }
        }
        
        const statusSender = statusKey.participant || statusKey.remoteJid;
        console.log(`📱 New status from: ${statusSender}`);
        
        if (AUTO_STATUS_VIEW) {
            setTimeout(async () => {
                try {
                    await sock.readMessages([statusKey]);
                    console.log(`👁️ Viewed status from: ${statusSender}`);
                } catch (error) {
                    console.error('Error viewing status:', error);
                }
            }, STATUS_VIEW_DELAY);
        }
        
        if (AUTO_STATUS_REACT && statusReactionEmojis.length > 0) {
            setTimeout(async () => {
                try {
                    const randomEmoji = statusReactionEmojis[Math.floor(Math.random() * statusReactionEmojis.length)];
                    
                    await sock.sendMessage(statusSender, {
                        react: {
                            text: randomEmoji,
                            key: statusKey
                        }
                    });
                    console.log(`❤️ Reacted to status from: ${statusSender} with ${randomEmoji}`);
                } catch (error) {
                    console.error('Error reacting to status:', error);
                }
            }, STATUS_REACT_INTERVAL);
        }
        
        if (AUTO_STATUS_REPLY && STATUS_REPLY_TEXT) {
            setTimeout(async () => {
                try {
                    await sock.sendMessage(statusSender, {
                        text: STATUS_REPLY_TEXT,
                        contextInfo: {
                            stanzaId: statusKey.id,
                            participant: statusSender,
                            quotedMessage: statusMessage.message
                        }
                    });
                    console.log(`💬 Replied to status from: ${statusSender} with: "${STATUS_REPLY_TEXT}"`);
                } catch (error) {
                    console.error('Error replying to status:', error);
                }
            }, STATUS_REPLY_DELAY);
        }
        
    } catch (error) {
        console.error('Error in status handler:', error);
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Handle !menu command - Show all commands
 */
async function handleMenuCommand(sock, from, senderJid) {
    const isAuthorized = isAuthorizedForAutoForward(senderJid);
    
    let menuText = `╔════════════════════╗
║   *MUZAMMIL MD BOT*   ║
╚════════════════════╝

*Bot Name:* Muzammil MD
*Developer:* Muzammil
*Version:* 2.0.0

╔════════════════════╗
║   *BASIC COMMANDS*   ║
╚════════════════════╝

• !ping - Check bot response (Love You😘)
• !jid - Get current chat JID
• !gjid - List all groups with details
• !menu - Show this menu
• !help - Detailed help for all commands

╔════════════════════╗
║   *STATUS COMMANDS*   ║
╚════════════════════╝

• !statusreact - View/change status reaction settings
• !statusreply - View/change status reply settings

╔════════════════════╗
║ *AUTO-FORWARD COMMANDS* ║
╚════════════════════╝

*Note: These commands are restricted to admin only (03039107958)*

• !addsource <JID> - Add source group
• !addtarget <JID> - Add target group
• !removesource <JID/num> - Remove source
• !removetarget <JID/num> - Remove target
• !listsources - List all source JIDs
• !listtargets - List all target JIDs

╔════════════════════╗
║   *CURRENT STATUS*   ║
╚════════════════════╝

• Auto Status View: ${AUTO_STATUS_VIEW ? '✅ ON' : '❌ OFF'}
• Auto Status React: ${AUTO_STATUS_REACT ? '✅ ON' : '❌ OFF'}
• Auto Status Reply: ${AUTO_STATUS_REPLY ? '✅ ON' : '❌ OFF'}
• Sources: ${SOURCE_JIDS.length}
• Targets: ${TARGET_JIDS.length}

╔════════════════════╗
║      *CONTACT*      ║
╚════════════════════╝

• Admin: 03039107958
• For auto-forward commands, contact admin

_Muzammil MD Bot - Your WhatsApp Assistant_`;

    await sock.sendMessage(from, { text: menuText });
    console.log(`Menu command executed for ${from}`);
}

/**
 * Handle !help command - Detailed help
 */
async function handleHelpCommand(sock, from, senderJid, command) {
    const isAuthorized = isAuthorizedForAutoForward(senderJid);
    
    if (command) {
        // Show help for specific command
        const cmd = command.toLowerCase();
        let helpText = '';
        
        switch(cmd) {
            case 'ping':
                helpText = `*Command:* !ping\n*Description:* Check if bot is alive\n*Response:* Love You😘\n*Access:* Everyone`;
                break;
            case 'jid':
                helpText = `*Command:* !jid\n*Description:* Get current chat JID\n*Example:* !jid\n*Access:* Everyone`;
                break;
            case 'gjid':
                helpText = `*Command:* !gjid\n*Description:* List all groups with names, members count, and JIDs\n*Access:* Everyone`;
                break;
            case 'menu':
                helpText = `*Command:* !menu\n*Description:* Show main menu with all commands\n*Access:* Everyone`;
                break;
            case 'statusreact':
                helpText = `*Command:* !statusreact\n*Description:* Manage status reaction settings\n*Subcommands:*\n• !statusreact - View settings\n• !statusreact on - Enable\n• !statusreact off - Disable\n• !statusreact 👍,❤️ - Set emojis\n*Access:* Everyone`;
                break;
            case 'statusreply':
                helpText = `*Command:* !statusreply\n*Description:* Manage status reply settings\n*Subcommands:*\n• !statusreply - View settings\n• !statusreply on - Enable\n• !statusreply off - Disable\n• !statusreply <text> - Set reply text\n*Access:* Everyone`;
                break;
            case 'addsource':
                helpText = `*Command:* !addsource\n*Description:* Add source group for auto-forward\n*Example:* !addsource 1234567890@g.us\n*Access:* Admin Only (03039107958)`;
                break;
            case 'addtarget':
                helpText = `*Command:* !addtarget\n*Description:* Add target group for auto-forward\n*Example:* !addtarget 1234567890@g.us\n*Access:* Admin Only (03039107958)`;
                break;
            case 'removesource':
                helpText = `*Command:* !removesource\n*Description:* Remove source group\n*Usage:* !removesource <JID or number>\n*Examples:* !removesource 1234567890@g.us or !removesource 1\n*Access:* Admin Only (03039107958)`;
                break;
            case 'removetarget':
                helpText = `*Command:* !removetarget\n*Description:* Remove target group\n*Usage:* !removetarget <JID or number>\n*Examples:* !removetarget 1234567890@g.us or !removetarget 1\n*Access:* Admin Only (03039107958)`;
                break;
            case 'listsources':
                helpText = `*Command:* !listsources\n*Description:* List all source JIDs\n*Access:* Admin Only (03039107958)`;
                break;
            case 'listtargets':
                helpText = `*Command:* !listtargets\n*Description:* List all target JIDs\n*Access:* Admin Only (03039107958)`;
                break;
            default:
                helpText = `❌ Command '${command}' not found. Use !help for all commands.`;
        }
        
        await sock.sendMessage(from, { text: helpText });
    } else {
        // Show all commands summary
        let helpSummary = `╔════════════════════╗
║   *MUZAMMIL MD HELP*   ║
╚════════════════════╝

*BASIC COMMANDS (Everyone)*
• !ping - Check bot response
• !jid - Get chat JID
• !gjid - List all groups
• !menu - Show main menu

*STATUS COMMANDS (Everyone)*
• !statusreact - Reaction settings
• !statusreply - Reply settings

*AUTO-FORWARD COMMANDS (Admin Only - 03039107958)*
• !addsource - Add source
• !addtarget - Add target
• !removesource - Remove source
• !removetarget - Remove target
• !listsources - List sources
• !listtargets - List targets

*Get detailed help:*
!help <command>
Example: !help addsource

_Muzammil MD Bot v2.0_`;

        await sock.sendMessage(from, { text: helpSummary });
    }
    
    console.log(`Help command executed for ${from}`);
}

/**
 * Handle !ping command
 */
async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Love You😘" });
    console.log(`Ping command executed for ${from}`);
}

/**
 * Handle !jid command
 */
async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
    console.log(`JID command executed for ${from}`);
}

/**
 * Handle !gjid command
 */
async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            let groupType = "Simple Group";
            if (group.isCommunity) {
                groupType = "Community";
            } else if (group.isCommunityAnnounce) {
                groupType = "Community Announcement";
            } else if (group.parentGroup) {
                groupType = "Subgroup";
            }
            
            response += `${groupCount}. *${groupName}*\n`;
            response += `   👥 Members: ${participantsCount}\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   📝 Type: ${groupType}\n`;
            response += `   ──────────────\n\n`;
            
            groupCount++;
        }
        
        if (groupCount === 1) {
            response = "❌ No groups found. You are not in any groups.";
        } else {
            response += `\n*Total Groups: ${groupCount - 1}*`;
        }
        
        await sock.sendMessage(from, { text: response });
        console.log(`GJID command executed. Sent ${groupCount - 1} groups list.`);
        
    } catch (error) {
        console.error('Error fetching groups:', error);
        await sock.sendMessage(from, { 
            text: "❌ Error fetching groups list. Please try again later." 
        });
    }
}

/**
 * Handle !statusreact command
 */
async function handleStatusReactCommand(sock, from, args, senderJid) {
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Current Status React Settings:*\n\n` +
                      `Status: ${AUTO_STATUS_REACT ? '✅ ON' : '❌ OFF'}\n` +
                      `Emojis: ${statusReactionEmojis.join(', ')}\n\n` +
                      `*Commands:*\n` +
                      `!statusreact on - Turn ON\n` +
                      `!statusreact off - Turn OFF\n` +
                      `!statusreact 👍,❤️,😂 - Set emojis`
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
        
        const validEmojis = newEmojis.filter(e => e.match(/^(\p{Extended_Pictographic}|\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])$/u));
        
        if (validEmojis.length === 0) {
            await sock.sendMessage(from, { text: "❌ No valid emojis provided!" });
            return;
        }
        
        statusReactionEmojis.length = 0;
        statusReactionEmojis.push(...validEmojis);
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Status reaction emojis updated to: ${validEmojis.join(', ')}` 
        });
        
    } catch (error) {
        console.error('Error in statusreact command:', error);
        await sock.sendMessage(from, { text: "❌ Error updating status reaction emojis" });
    }
}

/**
 * Handle !statusreply command
 */
async function handleStatusReplyCommand(sock, from, args, senderJid) {
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Current Status Reply Settings:*\n\n` +
                      `Status: ${AUTO_STATUS_REPLY ? '✅ ON' : '❌ OFF'}\n` +
                      `Reply Text: "${STATUS_REPLY_TEXT}"\n\n` +
                      `*Commands:*\n` +
                      `!statusreply on - Turn ON\n` +
                      `!statusreply off - Turn OFF\n` +
                      `!statusreply Nice photo! - Set reply text`
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
        
        const replyText = args.join(' ');
        if (replyText.length > 200) {
            await sock.sendMessage(from, { text: "❌ Reply text too long! Maximum 200 characters." });
            return;
        }
        
        STATUS_REPLY_TEXT = replyText;
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Auto Status Reply text updated to: "${replyText}"` 
        });
        
    } catch (error) {
        console.error('Error in statusreply command:', error);
        await sock.sendMessage(from, { text: "❌ Error updating status reply" });
    }
}

/**
 * Handle !addsource command
 */
async function handleAddSourceCommand(sock, from, args, senderJid) {
    // Check authorization
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Current Source JIDs:*\n${SOURCE_JIDS.map(j => `• ${j}`).join('\n') || 'None'}\n\n` +
                      `Usage: !addsource <JID>\n` +
                      `Example: !addsource 1234567890@g.us`
            });
            return;
        }
        
        const newJid = args[0].trim();
        
        if (!newJid.includes('@')) {
            await sock.sendMessage(from, { text: "❌ Invalid JID format! Must contain @" });
            return;
        }
        
        if (SOURCE_JIDS.includes(newJid)) {
            await sock.sendMessage(from, { text: "❌ This JID already exists in sources!" });
            return;
        }
        
        SOURCE_JIDS.push(newJid);
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Added source JID: ${newJid}\nTotal sources: ${SOURCE_JIDS.length}` 
        });
        
    } catch (error) {
        console.error('Error in addsource command:', error);
        await sock.sendMessage(from, { text: "❌ Error adding source JID" });
    }
}

/**
 * Handle !addtarget command
 */
async function handleAddTargetCommand(sock, from, args, senderJid) {
    // Check authorization
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Current Target JIDs:*\n${TARGET_JIDS.map(j => `• ${j}`).join('\n') || 'None'}\n\n` +
                      `Usage: !addtarget <JID>\n` +
                      `Example: !addtarget 1234567890@g.us`
            });
            return;
        }
        
        const newJid = args[0].trim();
        
        if (!newJid.includes('@')) {
            await sock.sendMessage(from, { text: "❌ Invalid JID format! Must contain @" });
            return;
        }
        
        if (TARGET_JIDS.includes(newJid)) {
            await sock.sendMessage(from, { text: "❌ This JID already exists in targets!" });
            return;
        }
        
        TARGET_JIDS.push(newJid);
        saveBotConfig();
        
        await sock.sendMessage(from, { 
            text: `✅ Added target JID: ${newJid}\nTotal targets: ${TARGET_JIDS.length}` 
        });
        
    } catch (error) {
        console.error('Error in addtarget command:', error);
        await sock.sendMessage(from, { text: "❌ Error adding target JID" });
    }
}

/**
 * Handle !removesource command
 */
async function handleRemoveSourceCommand(sock, from, args, senderJid) {
    // Check authorization
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Current Source JIDs:*\n${SOURCE_JIDS.map((j, i) => `${i+1}. ${j}`).join('\n') || 'None'}\n\n` +
                      `Usage: !removesource <JID or number>\n` +
                      `Example: !removesource 1234567890@g.us or !removesource 1`
            });
            return;
        }
        
        const input = args[0].trim();
        
        if (/^\d+$/.test(input)) {
            const index = parseInt(input) - 1;
            if (index >= 0 && index < SOURCE_JIDS.length) {
                const removed = SOURCE_JIDS.splice(index, 1)[0];
                saveBotConfig();
                await sock.sendMessage(from, { text: `✅ Removed source JID: ${removed}` });
                return;
            } else {
                await sock.sendMessage(from, { text: `❌ Invalid index! Please use 1-${SOURCE_JIDS.length}` });
                return;
            }
        }
        
        const index = SOURCE_JIDS.indexOf(input);
        if (index === -1) {
            await sock.sendMessage(from, { text: "❌ JID not found in sources!" });
            return;
        }
        
        SOURCE_JIDS.splice(index, 1);
        saveBotConfig();
        await sock.sendMessage(from, { text: `✅ Removed source JID: ${input}` });
        
    } catch (error) {
        console.error('Error in removesource command:', error);
        await sock.sendMessage(from, { text: "❌ Error removing source JID" });
    }
}

/**
 * Handle !removetarget command
 */
async function handleRemoveTargetCommand(sock, from, args, senderJid) {
    // Check authorization
    if (!isAuthorizedForAutoForward(senderJid)) {
        await sock.sendMessage(from, { text: getUnauthorizedMessage() });
        return;
    }
    
    try {
        if (!args || args.length === 0) {
            await sock.sendMessage(from, { 
                text: `*Current Target JIDs:*\n${TARGET_JIDS.map((j, i) => `${i+1}. ${j}`).join('\n') || 'None'}\n\n` +
                      `Usage: !removetarget <JID or number>\n` +
                      `Example: !removetarget 1234567890@g.us or !removetarget 1`
            });
            return;
        }
        
        const input = args[0].trim();
        
        if (/^\d+$/.test(input)) {
            const index = parseInt(input) - 1;
            if (index >= 0 && index < TARGET_JIDS.length) {
                const removed = TARGET_JIDS.splice(index, 1)[0];
                saveBotConfig();
                await sock.sendMessage(from, { text: `✅ Removed target JID: ${removed}` });
                return;
            } else {
                await sock.sendMessage(from, { text: `❌ Invalid index! Please use 1-${TARGET_JIDS.length}` });
                return;
            }
        }
        
        const index = TARGET_JIDS.indexOf(input);
        if (index === -1) {
            await sock.sendMessage(from, { text: "❌ JID not found in targets!" });
            return;
        }
        
        TARGET_JIDS.splice(index, 1);
        saveBotConfig();
        await sock.sendMessage(from, { text: `✅ Removed target JID: ${input}` });
        
    } catch (error) {
        console.error('Error in removetarget command:', error);
        await sock.sendMessage(from, { text: "❌ Error removing target JID" });
    }
}

/**
 * Handle !listsources command
 */
async function handleListSourcesCommand(sock, from, senderJid) {
    // Check authorization
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
        console.error('Error in listsources command:', error);
        await sock.sendMessage(from, { text: "❌ Error listing source JIDs" });
    }
}

/**
 * Handle !listtargets command
 */
async function handleListTargetsCommand(sock, from, senderJid) {
    // Check authorization
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
        console.error('Error in listtargets command:', error);
        await sock.sendMessage(from, { text: "❌ Error listing target JIDs" });
    }
}

/**
 * Process incoming messages for commands
 */
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
            case '!ping':
                await handlePingCommand(sock, from);
                break;
            case '!jid':
                await handleJidCommand(sock, from);
                break;
            case '!gjid':
                await handleGjidCommand(sock, from);
                break;
            case '!menu':
                await handleMenuCommand(sock, from, senderJid);
                break;
            case '!help':
                await handleHelpCommand(sock, from, senderJid, args[0]);
                break;
            case '!statusreact':
                await handleStatusReactCommand(sock, from, args, senderJid);
                break;
            case '!statusreply':
                await handleStatusReplyCommand(sock, from, args, senderJid);
                break;
            case '!addsource':
                await handleAddSourceCommand(sock, from, args, senderJid);
                break;
            case '!addtarget':
                await handleAddTargetCommand(sock, from, args, senderJid);
                break;
            case '!removesource':
                await handleRemoveSourceCommand(sock, from, args, senderJid);
                break;
            case '!removetarget':
                await handleRemoveTargetCommand(sock, from, args, senderJid);
                break;
            case '!listsources':
                await handleListSourcesCommand(sock, from, senderJid);
                break;
            case '!listtargets':
                await handleListTargetsCommand(sock, from, senderJid);
                break;
            default:
                // Unknown command - ignore
                break;
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
            console.log(`Session ${sessionId} is already connected.`);
            return;
        }

        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null,
        reconnectAttempts: 0,
    };
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

            console.log(`Session ${sessionId}: Connection closed, reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => {
                    startSession(sessionId);
                }, 3000);
            } else {
                console.log(`Session ${sessionId} logged out. Removing.`);
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
            
            console.log(`📱 Status Auto Features:`);
            console.log(`   👁️ Auto View: ${AUTO_STATUS_VIEW ? 'ON' : 'OFF'}`);
            console.log(`   ❤️ Auto React: ${AUTO_STATUS_REACT ? 'ON' : 'OFF'} (${statusReactionEmojis.join(', ')})`);
            console.log(`   💬 Auto Reply: ${AUTO_STATUS_REPLY ? 'ON' : 'OFF'} (${STATUS_REPLY_TEXT})`);
            console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
            console.log(`🔐 Authorized Number: ${AUTHORIZED_NUMBER}`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // -------------------------------------------------------------------------
    // MESSAGE HANDLER
    // -------------------------------------------------------------------------
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const isStatus = wasi_msg.key.remoteJid === 'status@broadcast';
        
        // Handle status messages
        if (isStatus) {
            await handleStatus(wasi_sock, wasi_msg);
            return;
        }

        const wasi_origin = wasi_msg.key.remoteJid;
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption ||
            wasi_msg.message.documentMessage?.caption || "";

        // COMMAND HANDLER
        if (wasi_text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg);
        }

        // AUTO FORWARD LOGIC
        if (SOURCE_JIDS.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            try {
                let relayMsg = processAndCleanMessage(wasi_msg.message);
                if (!relayMsg) return;

                if (relayMsg.viewOnceMessageV2)
                    relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage)
                    relayMsg = relayMsg.viewOnceMessage.message;

                const isMedia = relayMsg.imageMessage ||
                    relayMsg.videoMessage ||
                    relayMsg.audioMessage ||
                    relayMsg.documentMessage ||
                    relayMsg.stickerMessage;

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
                if (relayMsg.documentMessage?.caption) {
                    relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption);
                }

                console.log(`📦 Forwarding (cleaned) from ${wasi_origin}`);

                for (const targetJid of TARGET_JIDS) {
                    try {
                        await wasi_sock.relayMessage(
                            targetJid,
                            relayMsg,
                            { messageId: wasi_sock.generateMessageTag() }
                        );
                        console.log(`✅ Clean message forwarded to ${targetJid}`);
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
            replyText: STATUS_REPLY_TEXT
        },
        forwardConfig: {
            sources: SOURCE_JIDS,
            targets: TARGET_JIDS,
            sourceCount: SOURCE_JIDS.length,
            targetCount: TARGET_JIDS.length
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
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🤖 Bot Name: Muzammil MD`);
        console.log(`🔐 Authorized Number: ${AUTHORIZED_NUMBER}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`✨ Message Cleaning: Forwarded labels removed, Newsletter markers cleaned`);
        console.log(`🤖 Bot Commands: !menu, !help, !ping, !jid, !gjid, !statusreact, !statusreply, !addsource, !addtarget, !removesource, !removetarget, !listsources, !listtargets`);
        
        console.log(`📱 Status Features:`);
        console.log(`   👁️ Auto View: ${AUTO_STATUS_VIEW ? 'ON' : 'OFF'}`);
        console.log(`   ❤️ Auto React: ${AUTO_STATUS_REACT ? 'ON' : 'OFF'} (${statusReactionEmojis.join(', ')})`);
        console.log(`   💬 Auto Reply: ${AUTO_STATUS_REPLY ? 'ON' : 'OFF'} (${STATUS_REPLY_TEXT})`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);
    wasi_startServer();
}

main();
