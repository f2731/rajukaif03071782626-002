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

// Default state agar config mein na ho
if (typeof config.autoForwardEnabled === 'undefined') {
    config.autoForwardEnabled = true; // By default ON rahega
}

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
// AUTO FORWARD & SIMPLE MAPPING CONFIGURATION
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

let FORWARD_MAP = {};
try {
    if (process.env.FORWARD_MAP) {
        process.env.FORWARD_MAP.split(',').forEach(pair => {
            const [src, target] = pair.split(':');
            if (src && target) {
                FORWARD_MAP[src.trim()] = target.trim();
            }
        });
    }
} catch (e) {
    console.error('Failed to parse FORWARD_MAP:', e);
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------
function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g, /🔔\s*/g, /📰\s*/g, /🗞️️\s*/g,
        /\[NEWSLETTER\]/gi, /\[BROADCAST\]/gi, /\[ANNOUNCEMENT\]/gi,
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
            if (msgText.toLowerCase() === '!fullpp' || msgText.toLowerCase() === 'fullpp') {
                await handleFullPpCommand(wasi_sock, wasi_msg, rawFrom);
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
            // ⚡ ULTRA-FAST ZERO-MEMORY ALBUM & HEAVY FILE RELAY LOGIC (99+ VIDEOS)
            // =========================================================================
            if (config.autoForwardEnabled === false) return;

            let targetJid = null;
            
            const matchedSourceKey = Object.keys(FORWARD_MAP).find(src => cleanFrom.includes(cleanJid(src)));
            if (matchedSourceKey) {
                targetJid = FORWARD_MAP[matchedSourceKey];
            } else {
                const sourceList = (process.env.SOURCE_JIDS || '').split(',').map(id => cleanJid(id));
                if (sourceList.length > 0 && sourceList[0] !== '' && !sourceList.some(src => cleanFrom.includes(src))) return;
                const targets = (process.env.TARGET_JIDS || '').split(',').map(id => id.trim()).filter(Boolean);
                targetJid = targets[0]; 
            }

            if (!targetJid) return;

            // Har tarha ke media, albums (10, 20, 99+ videos) aur heavy files ke liye universal check
            if (wasi_msg.message) {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        let cleanMessage = JSON.parse(JSON.stringify(wasi_msg.message));

                        const cleanContext = (obj) => {
                            if (!obj || typeof obj !== 'object') return;
                            if (obj.contextInfo) {
                                delete obj.contextInfo.forwardingScore;
                                delete obj.contextInfo.isForwarded;
                                obj.contextInfo.participant = "Raju Boss +923071782626";
                            }
                            for (let key of Object.keys(obj)) {
                                if (typeof obj[key] === 'object') {
                                    cleanContext(obj[key]);
                                }
                            }
                        };
                        cleanContext(cleanMessage);

                        // Caption replacement agar maujood ho
                        if (cleanMessage.imageMessage?.caption) {
                            cleanMessage.imageMessage.caption = replaceCaption(cleanMessage.imageMessage.caption);
                        }
                        if (cleanMessage.videoMessage?.caption) {
                            cleanMessage.videoMessage.caption = replaceCaption(cleanMessage.videoMessage.caption);
                        }
                        if (cleanMessage.documentMessage?.caption) {
                            cleanMessage.documentMessage.caption = replaceCaption(cleanMessage.documentMessage.caption);
                        }

                        // Direct Server-to-Server Relay (Bina download kiye bari se bari multi-video albums bhejne ke liye)
                        await wasi_sock.relayMessage(targetJid, cleanMessage, { messageId: wasi_msg.key.id });

                        console.log(`[+] High-speed multi-video album/media forwarded from ${cleanFrom} to ${targetJid}`);
                        break;
                    } catch (err) {
                        console.error(`[!] Attempt ${attempt} relay failed for ${targetJid}:`, err.message);
                        if (attempt < 3) await new Promise(res => setTimeout(res, 3000));
                    }
                }
            }

        } catch (e) {
            console.error('❌ General Error:', e.message);
        }
    });
}

// ============================================================
// 🚀 ALL APIS
// ============================================================

wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let dbConnected = false;

    if (config.mongoDbUrl) dbConnected = true;

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
        dbConnected,
        dbConfigured: !!config.mongoDbUrl,
        phoneNumber: connected ? 'Connected ✅' : '-',
        lastActive: new Date().toISOString(),
        activeSessions: Array.from(sessions.keys())
    });
});

wasi_app.post('/api/restart', async (req, res) => {
    try {
        for (const [sessionId, session] of sessions) {
            if (session.sock) {
                try { session.sock.end(undefined); } catch (e) {}
            }
        }
        sessions.clear();
        setTimeout(() => { main().catch(err => console.error(err)); }, 1000);
        res.json({ success: true, message: 'Bot restarting...' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (session && session.sock) {
            try { await session.sock.logout(); } catch (e) {}
            sessions.delete(sessionId);
            await wasi_clearSession(sessionId);
        }
        
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.get('/api/sessions', async (req, res) => {
    const sessionList = Array.from(sessions.keys()).map(id => ({
        sessionId: id,
        isConnected: sessions.get(id)?.isConnected || false
    }));
    res.json({ success: true, sessions: sessionList, total: sessionList.length });
});

wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size
    });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🛡️ Simple Source:Target Mapping Configured Successfully!`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

main().catch(err => console.error('Main startup error:', err));
