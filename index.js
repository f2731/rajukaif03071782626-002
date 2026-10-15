require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');
const { cleanTempFiles } = require('./wasilib/cleaner');

// Load persistent config
const CONFIG_FILE = path.join(__dirname, 'botConfig.json');
try {
    if (fs.existsSync(CONFIG_FILE)) {
        const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE));
        Object.assign(config, savedConfig);
    }
} catch (e) {
    console.error('Failed to load botConfig.json:', e);
}

// Default state for main auto forward
if (typeof config.autoForwardEnabled === 'undefined') config.autoForwardEnabled = true;
if (typeof config.albumForwardEnabled === 'undefined') config.albumForwardEnabled = true;

// Helper to save config state
function saveBotConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Failed to save botConfig.json:', e);
    }
}

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

const QRCode = require('qrcode');

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));
// Auto Clear Memory every 30 minutes
setInterval(() => {
    try {
        cleanTempFiles(true);
    } catch (e) {
        console.error('Auto clean error:', e.message);
    }
}, 30 * 60 * 1000);

// -----------------------------------------------------------------------------
// AUTO FORWARD & ADVANCED MULTI-GROUP MAPPING CONFIGURATION
// -----------------------------------------------------------------------------
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

// Helper to parse ADVANCED_MAPPING from Heroku Env
function getAdvancedMappings() {
    const rawMapping = process.env.ADVANCED_MAPPING || '';
    if (!rawMapping) return [];
    
    return rawMapping.split(';').map(rule => {
        const parts = rule.trim().split(':');
        if (parts.length >= 2) {
            return {
                source: parts[0].trim(),
                target: parts[1].trim(),
                types: parts[2] ? parts[2].toLowerCase().split(',').map(t => t.trim()) : ['document', 'image', 'video', 'album', 'text', 'voice', 'sticker']
            };
        }
        return null;
    }).filter(Boolean);
}

// Helper to get target JIDs for manual forwarding
function getTargetJids() {
    return process.env.TARGET_JIDS ? process.env.TARGET_JIDS.split(',').map(id => id.trim()).filter(Boolean) : [];
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------
function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g, /🔔\s*/g, /📰\s*/g, /🗞\s*/g,
        /[NEWSLETTER]/gi, /[BROADCAST]/gi, /[ANNOUNCEMENT]/gi,
        /Newsletter:/gi, /Broadcast:/gi, /Announcement:/gi,
        /Forwarded many times/gi, /Forwarded message/gi, /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    return cleanedText.trim();
}

function replaceCaption(caption) {
    if (!caption) return caption;
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    return result;
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Raju-Autoforward-Bot is Working Fast (923071782626)" });
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
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            response += `${groupCount}. *${groupName}*\n`;
            response += `   👥 Members: ${participantsCount}\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   ──────────────\n\n`;
            groupCount++;
        }
        
        if (groupCount === 1) {
            response = "❌ No groups found.";
        } else {
            response += `\n*Total Groups: ${groupCount - 1}*`;
        }
        
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        console.error('Error fetching groups:', error);
        await sock.sendMessage(from, { text: "❌ Error fetching groups list." });
    }
}

// 🔗 NEW COMMAND: FETCH ALL GROUP LINKS
async function handleGroupLinksCommand(sock, from) {
    try {
        await sock.sendMessage(from, { text: "⏳ Tamam groups ke links fetch kiye ja rahe hain, bara-e-karam intezar karein..." });
        
        const groups = await sock.groupFetchAllParticipating();
        let response = "🔗 *All Groups Invite Links:*\n\n";
        let count = 1;

        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            let inviteLink = "Link Not Available (Bot might not be admin)";
            
            try {
                const code = await sock.groupInviteCode(jid);
                if (code) {
                    inviteLink = `https://chat.whatsapp.com/${code}`;
                }
            } catch (err) {
                // Agar bot admin nahi hai ya link fetch nahi ho saka
                inviteLink = "❌ Admin required or restricted";
            }

            response += `${count}. *${groupName}*\n`;
            response += `   🔗 Link: ${inviteLink}\n`;
            response += `   🆔 JID: \`${jid}\`\n`;
            response += `   ──────────────────\n\n`;
            count++;
        }

        if (count === 1) {
            response = "❌ Koi group nahi mila.";
        }

        // Agar message bohot lamba ho toh parts mein bhejna pad sakta hai, yahan direct bhej rahe hain
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        console.error('Group Links Error:', error);
        await sock.sendMessage(from, { text: `❌ Links nikalne mein masla aaya: ${error.message}` });
    }
}

async function handleFullPpCommand(sock, wasi_msg, from) {
    try {
        const quoted = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const messageType = Object.keys(wasi_msg.message)[0];
        
        let targetMsg = wasi_msg;
        if (messageType === 'extendedTextMessage' && quoted) {
            targetMsg = {
                key: {
                    remoteJid: from,
                    id: wasi_msg.message.extendedTextMessage.contextInfo.stanzaId,
                    participant: wasi_msg.message.extendedTextMessage.contextInfo.participant
                },
                message: quoted
            };
        }

        const isImg = targetMsg.message?.imageMessage || targetMsg.message?.ephemeralMessage?.message?.imageMessage;
        if (!isImg) {
            await sock.sendMessage(from, { text: "❌ Bara-e-karam koi tasveer bhejiye ya kisi tasveer ko reply karke !fullpp likhiye." });
            return;
        }

        const stream = await downloadMediaMessage(targetMsg, 'buffer', {}, { 
            logger: console,
            reuploadRequest: sock.updateMediaMessage 
        });

        const botId = sock.user.id;
        await sock.updateProfilePicture(botId, stream);
        await sock.sendMessage(from, { text: "✅ Bot ki profile picture kamyabi se update ho gayi hai!" });
    } catch (error) {
        console.error('FullPP Error:', error);
        await sock.sendMessage(from, { text: `❌ Profile picture update karne mein masla aaya: ${error.message}` });
    }
}

// -----------------------------------------------------------------------------
// 🎬 MOVIE SEARCH HANDLER FUNCTION
// -----------------------------------------------------------------------------
async function handleMovieSearchCommand(sock, wasi_msg, from, msgText) {
    const query = msgText.replace(/^!movie/i, "").trim();
    if (!query) {
        await sock.sendMessage(from, { text: "❌ Bara-e-karam movie ka naam likhein. Misal ke tor par: `!movie Batman`" }, { quoted: wasi_msg });
        return;
    }

    await sock.sendMessage(from, { text: `🔍 Searching for "${query}" on HDHub4u...` }, { quoted: wasi_msg });

    try {
        const searchUrl = `https://new2.hdhub4u.free/?s=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        const $ = cheerio.load(data);
        let results = [];

        $('a').each((i, element) => {
            const href = $(element).attr('href');
            const title = $(element).text().trim();
            if (href && title && title.toLowerCase().includes(query.toLowerCase()) && href.includes('hdhub4u')) {
                if (!results.some(r => r.url === href)) {
                    results.push({ title, url: href });
                }
            }
        });

        if (results.length === 0) {
            await sock.sendMessage(from, { text: "❌ Maazrat, is naam se koi movie nahi mili ya website par protection/layout change hai." }, { quoted: wasi_msg });
            return;
        }

        let response = `🎬 *Search Results for "${query}":*\n\n`;
        results.slice(0, 3).forEach((item, index) => {
            response += `${index + 1}. *${item.title}*\n🔗 Link: ${item.url}\n\n`;
        });

        await sock.sendMessage(from, { text: response }, { quoted: wasi_msg });

    } catch (error) {
        console.error('Movie Search Error:', error);
        await sock.sendMessage(from, { text: `❌ Movie dhoondne mein masla aaya: ${error.message}` }, { quoted: wasi_msg });
    }
}

// -----------------------------------------------------------------------------
// 📢 HIDETAGALL COMMAND HANDLER FUNCTION
// -----------------------------------------------------------------------------
async function handleTagAllCommand(sock, wasi_msg, from, isGroup, msgText) {
    if (!isGroup) {
        await sock.sendMessage(from, { text: "❌ Yeh command sirf groups mein istemal ho sakti hai!" }, { quoted: wasi_msg });
        return;
    }

    try {
        const groupMetadata = await sock.groupMetadata(from);
        const participants = groupMetadata.participants || [];
        
        const customMessage = msgText.slice(7).trim() || "No message provided.";
        
        let text = `📢 *Attention Everyone!*\n\n*Message:* ${customMessage}\n\n`;
        let mentions = [];

        for (let mem of participants) {
            mentions.push(mem.id);
        }

        await sock.sendMessage(from, { text: text, mentions: mentions }, { quoted: wasi_msg });
    } catch (error) {
        console.error('TagAll Error:', error);
        await sock.sendMessage(from, { text: `❌ Tagall chalane mein masla aaya: ${error.message}` }, { quoted: wasi_msg });
    }
}

// -----------------------------------------------------------------------------
// 🔗 JOIN GROUP COMMAND HANDLER FUNCTION
// -----------------------------------------------------------------------------
async function handleJoinCommand(sock, wasi_msg, from) {
    try {
        const quoted = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const messageType = Object.keys(wasi_msg.message)[0];
        
        let targetText = "";
        
        if (messageType === 'extendedTextMessage' && quoted) {
            targetText = quoted.conversation || 
                         quoted.extendedTextMessage?.text || 
                         quoted.imageMessage?.caption || 
                         quoted.videoMessage?.caption || "";
        }
        
        const msgText = wasi_msg.message.conversation || wasi_msg.message.extendedTextMessage?.text || "";
        const argsText = msgText.replace(/^!join/i, "").trim();
        
        const fullSearchText = targetText + " " + argsText;
        
        const match = fullSearchText.match(/(?:https:\/\/)?chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/i);
        
        if (!match || !match[1]) {
            await sock.sendMessage(from, { text: "❌ Bara-e-karam kisi aise message par reply karein jis mein WhatsApp group ka link ho, ya sath link likhein (e.g., `!join [link]`)." }, { quoted: wasi_msg });
            return;
        }
        
        const inviteCode = match[1];
        const res = await sock.groupAcceptInvite(inviteCode);
        
        await sock.sendMessage(from, { text: `✅ Bot kamyabi se group join kar chuka hai! (ID: ${res})` }, { quoted: wasi_msg });
    } catch (error) {
        console.error('Join Error:', error);
        await sock.sendMessage(from, { text: `❌ Group join karne mein nakami hui: ${error.message}` }, { quoted: wasi_msg });
    }
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) return;

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
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            if (shouldReconnect) {
                setTimeout(() => { startSession(sessionId); }, 3000);
            } else {
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    const cleanJid = (id) => id ? id.split(':')[0].trim() : '';

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        try {
            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg || !wasi_msg.message) return;

            const rawFrom = wasi_msg.key.remoteJid;
            const isGroup = rawFrom.endsWith('@g.us');
            const cleanFrom = cleanJid(rawFrom);
            const msgContent = wasi_msg.message;
            const senderJid = wasi_msg.key.participant || wasi_msg.key.remoteJid;

            const msgText = (
                msgContent.conversation || 
                msgContent.extendedTextMessage?.text || 
                msgContent.imageMessage?.caption || 
                msgContent.videoMessage?.caption || 
                ''
            ).trim();

            if (msgText.toLowerCase() === '!ping') {
                await handlePingCommand(wasi_sock, rawFrom);
                return;
            }
            if (msgText.toLowerCase() === '!jid') {
                await handleJidCommand(wasi_sock, rawFrom);
                return;
            }
            if (msgText.toLowerCase() === '!gjid') {
                await handleGjidCommand(wasi_sock, rawFrom);
                return;
            }
            // 🔗 Command execution check
            if (msgText.toLowerCase() === '!grouplinks' || msgText.toLowerCase() === '!links') {
                await handleGroupLinksCommand(wasi_sock, rawFrom);
                return;
            }
            if (msgText.toLowerCase() === '!fullpp' || msgText.toLowerCase() === 'fullpp') {
                await handleFullPpCommand(wasi_sock, wasi_msg, rawFrom);
                return;
            }

            if (msgText.toLowerCase().startsWith('!movie')) {
                await handleMovieSearchCommand(wasi_sock, wasi_msg, rawFrom, msgText);
                return;
            }

            if (msgText.toLowerCase().startsWith('!tagall')) {
                await handleTagAllCommand(wasi_sock, wasi_msg, rawFrom, isGroup, msgText);
                return;
            }

            if (msgText.toLowerCase().startsWith('!join')) {
                await handleJoinCommand(wasi_sock, wasi_msg, rawFrom);
                return;
            }

            // MANUAL FORWARD COMMAND (!forward)
            if (msgText.toLowerCase().startsWith('!forward')) {
                try {
                    const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quotedMsg) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Bara-e-karam us message ko reply karke !forward likhen jo aap bhejwana chahte hain!' }, { quoted: wasi_msg });
                        return;
                    }

                    let forwardContent = JSON.parse(JSON.stringify(quotedMsg));
                    if (forwardContent.viewOnceMessageV2) {
                        forwardContent = forwardContent.viewOnceMessageV2.message;
                    } else if (forwardContent.viewOnceMessage) {
                        forwardContent = forwardContent.viewOnceMessage.message;
                    } else if (forwardContent.documentWithCaptionMessage) {
                        forwardContent = forwardContent.documentWithCaptionMessage.message;
                    }

                    const args = msgText.split(' ');
                    let targetList = [];

                    if (args.length > 1 && args[1].includes('@')) {
                        targetList = [args[1].trim()];
                    } else {
                        targetList = getTargetJids();
                    }

                    if (targetList.length === 0) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Koi target JID configure nahi hai!' }, { quoted: wasi_msg });
                        return;
                    }

                    let successCount = 0;
                    for (const targetJid of targetList) {
                        try {
                            let finalPayload = JSON.parse(JSON.stringify(forwardContent));
                            
                            const messageTypes = ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'];
                            for (const type of messageTypes) {
                                if (finalPayload[type]?.contextInfo) {
                                    delete finalPayload[type].contextInfo.forwardingScore;
                                    delete finalPayload[type].contextInfo.isForwarded;
                                    finalPayload[type].contextInfo.participant = "Raju Boss +923071782626";
                                }
                            }

                            await wasi_sock.relayMessage(targetJid, finalPayload, { messageId: wasi_msg.key.id });
                            successCount++;
                        } catch (mediaErr) {
                            console.error(`Forward error for ${targetJid}:`, mediaErr.message);
                        }
                        await new Promise(resolve => setTimeout(resolve, 800));
                    }

                    if (successCount > 0) {
                        await wasi_sock.sendMessage(rawFrom, { text: '✅ Message (Document/Media) kamyabi se forward kar diya gaya hai!' }, { quoted: wasi_msg });
                    } else {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Message forward nahi ho saka. Console log check karein.' }, { quoted: wasi_msg });
                    }
                } catch (err) {
                    await wasi_sock.sendMessage(rawFrom, { text: `❌ Forward karne mein nakami: ${err.message}` }, { quoted: wasi_msg });
                }
                return;
            }

            // Main Auto-Forward Command
            if (msgText.toLowerCase() === '!autoforward on') {
                config.autoForwardEnabled = true;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '🟢 Auto-Forwarding has been enabled (ON) successfully!' }, { quoted: wasi_msg });
                return;
            }
            if (msgText.toLowerCase() === '!autoforward off') {
                config.autoForwardEnabled = false;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '🔴 Auto-Forwarding has been disabled (OFF) successfully!' }, { quoted: wasi_msg });
                return;
            }

            if (msgText.toLowerCase() === '!antilink on') {
                config.antiLinkEnabled = true;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '🛡 Anti-Link protection enabled (ON)!' }, { quoted: wasi_msg });
                return;
            }
            if (msgText.toLowerCase() === '!antilink off') {
                config.antilinkEnabled = false; 
                config.antiLinkEnabled = false;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '⚠️ Anti-Link protection disabled (OFF)!' }, { quoted: wasi_msg });
                return;
            }

            // Anti-protection checks...
            if (config.antiLinkEnabled && isGroup && !wasi_msg.key.fromMe) {
                const hasLink = /https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\b/i.test(msgText) || msgText.includes('wa.me/');
                const isPlainOrLinkText = !!(msgContent.conversation || msgContent.extendedTextMessage);
                const isVoiceMessage = !!(msgContent.audioMessage && msgContent.audioMessage.ptt);
                const isStatusMention = msgText.toLowerCase().includes("'s status") || 
                                        msgText.includes("This group was mentioned") || 
                                        msgContent.extendedTextMessage?.contextInfo?.quotedMessage?.protocolMessage?.type === 3;

                if (hasLink || isPlainOrLinkText || isVoiceMessage || isStatusMention) {
                    try {
                        const groupMetadata = await wasi_sock.groupMetadata(rawFrom);
                        const participants = groupMetadata.participants || [];
                        const senderParticipant = participants.find(p => p.id === senderJid);
                        const isAdmin = senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin');

                        if (isAdmin) return; 

                        await wasi_sock.sendMessage(rawFrom, { delete: wasi_msg.key });
                        await wasi_sock.groupParticipantsUpdate(rawFrom, [senderJid], 'remove');
                        return; 
                    } catch (err) {
                        console.error('❌ Anti-protection error:', err.message);
                    }
                }
            }
                 
            // =========================================================================
            // ⚡ ADVANCED MULTI-MAPPING ROUTING LOGIC (ONLY ADVANCED_MAPPING)
            // =========================================================================
            if (config.autoForwardEnabled === false) return;
            if (!isGroup) return;

            // Media Type Checks
            const isText = !!(msgContent.conversation || msgContent.extendedTextMessage);
            const isImage = !!msgContent.imageMessage;
            const isVideo = !!msgContent.videoMessage;
            const isDocument = !!msgContent.documentMessage;
            const isSticker = !!msgContent.stickerMessage;
            const isVoice = !!(msgContent.audioMessage && msgContent.audioMessage.ptt);
            
            const isAlbum = !!(
                msgContent.albumMessage || 
                msgContent.messageContextInfo?.messageAssociation ||
                msgContent.ephemeralMessage?.message?.albumMessage ||
                msgContent.viewOnceMessageV2?.message?.albumMessage
            );

            // Check advanced mappings from Heroku Config Vars
            const mappings = getAdvancedMappings();
            const matchingRules = mappings.filter(rule => cleanFrom.includes(cleanJid(rule.source)));

            if (matchingRules.length === 0) return;

            let currentMsgType = '';
            if (isDocument) currentMsgType = 'document';
            else if
