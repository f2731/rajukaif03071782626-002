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
const QRCode = require('qrcode');

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

// -----------------------------------------------------------------------------
// SESSION STATE & TIMEOUTS
// -----------------------------------------------------------------------------
const sessions = new Map();
const qrTimeouts = new Map();
const keepAliveIntervals = new Map();

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
// HELPER FUNCTIONS FOR MESSAGE CLEANING (1 & 2)
// -----------------------------------------------------------------------------

// (1) Forwarded Label Removal
function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        const contextFields = [
            'extendedTextMessage', 'imageMessage', 'videoMessage', 
            'audioMessage', 'documentMessage', 'stickerMessage'
        ];
        
        contextFields.forEach(field => {
            if (cleanedMessage[field]?.contextInfo) {
                cleanedMessage[field].contextInfo.isForwarded = false;
                if (cleanedMessage[field].contextInfo.forwardingScore) {
                    cleanedMessage[field].contextInfo.forwardingScore = 0;
                }
            }
        });
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

// (2) Newsletter & Broadcast Cleanup
function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g, /🔔\s*/g, /📰\s*/g, /🗞️\s*/g,
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
// (4) KEEP-ALIVE MECHANISM
// -----------------------------------------------------------------------------
function startKeepAlive(sessionId, sock) {
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }
    
    console.log(`🔄 Starting keep-alive for session: ${sessionId}`);
    
    const interval = setInterval(async () => {
        try {
            const session = sessions.get(sessionId);
            if (!session || !session.isConnected || !session.sock) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
                return;
            }
            await session.sock.sendPresenceAvailable();
        } catch (error) {
            if (error.message?.includes('reconnecting')) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
            }
        }
    }, 30000); // Har 30 seconds baad
    
    keepAliveIntervals.set(sessionId, interval);
}

// -----------------------------------------------------------------------------
// (3 & 5) SESSION MANAGEMENT & AUTO RECONNECTION
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (qrTimeouts.has(sessionId)) {
        clearTimeout(qrTimeouts.get(sessionId));
        qrTimeouts.delete(sessionId);
    }
    
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }

    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            startKeepAlive(sessionId, existing.sock);
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
        startupNotified: false,
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
            
            if (keepAliveIntervals.has(sessionId)) {
                clearInterval(keepAliveIntervals.get(sessionId));
                keepAliveIntervals.delete(sessionId);
            }
            
            if (qrTimeouts.has(sessionId)) {
                clearTimeout(qrTimeouts.get(sessionId));
                qrTimeouts.delete(sessionId);
            }
            
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 440;

            if (isLoggedOut) {
                console.log(`❌ Session ${sessionId} logged out. Removing session.`);
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
                return;
            }

            // Exponential backoff delay for auto-reconnection
            const delay = Math.min(3000 * Math.pow(1.5, sessionState.reconnectAttempts), 30000);
            sessionState.reconnectAttempts += 1;

            console.log(`Session ${sessionId}: Connection closed, reconnecting in ${delay}ms (attempt ${sessionState.reconnectAttempts})`);

            setTimeout(() => {
                if (!sessions.has(sessionId) || !sessions.get(sessionId).isConnected) {
                    startSession(sessionId);
                }
            }, delay);

        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            sessionState.reconnectAttempts = 0;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);

            // Send startup notification to admin
            if (!sessionState.startupNotified) {
                try {
                    await wasi_sock.sendMessage(ADMIN_JID, {
                        text: `🤖 *Bot Started Successfully*\n\n📱 Session: ${sessionId}\n⏰ Time: ${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}\n\n✅ WhatsApp connection is active.`
                    });
                    sessionState.startupNotified = true;
                    console.log(`📩 Startup notification sent to admin ${ADMIN_NUMBER}`);
                } catch (e) {
                    console.error('Startup admin notification failed:', e.message);
                }
            }

            // Start Keep-Alive
            startKeepAlive(sessionId, wasi_sock);

            try {
                await wasi_sock.sendPresenceAvailable();
            } catch (e) {}
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
                await wasi_sock.sendMessage(rawFrom, { text: '🛡 Anti-Link protection enabled for members only!' }, { quoted: wasi_msg });
                return;
            }
            if (msgText.toLowerCase() === '!antilink off') {
                config.antiLinkEnabled = false;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '⚠️ Anti-Link protection disabled!' }, { quoted: wasi_msg });
                return;
            }

            // Anti-Link/Text Protection
            if (config.antiLinkEnabled && isGroup && !wasi_msg.key.fromMe) {
                const hasLink = /https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\b/i.test(msgText) || msgText.includes('wa.me/');
                const isPlainOrLinkText = !!(msgContent.conversation || msgContent.extendedTextMessage);
                const isVoiceMessage = !!(msgContent.audioMessage && msgContent.audioMessage.ptt);
                const isStatusMention = msgText.toLowerCase().includes("'s status") || msgText.includes("This group was mentioned");

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
                        console.error('❌ Anti-protection kick error:', err.message);
                    }
                }
            }
                 
            // Auto-Forward Logic
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

            const allowedTypes = (process.env.FORWARD_TYPES || 'video,image,document')
                .toLowerCase()
                .split(',')
                .map(t => t.trim());

            const isVideo = !!(msgContent.videoMessage || msgContent.ephemeralMessage?.message?.videoMessage || msgContent.viewOnceMessage?.message?.videoMessage || msgContent.viewOnceMessageV2?.message?.videoMessage);
            const isImage = !!(msgContent.imageMessage || msgContent.ephemeralMessage?.message?.imageMessage || msgContent.viewOnceMessage?.message?.imageMessage || msgContent.viewOnceMessageV2?.message?.imageMessage);
            const isDocument = !!(msgContent.documentMessage || msgContent.ephemeralMessage?.message?.documentMessage);
            const isAlbum = !!(msgContent.groupInviteMessage || msgContent.pollCreationMessage || msgContent.buttonsMessage || msgContent.templateMessage || msgContent.listMessage || msgContent.reactionMessage || msgContent.albumMessage);

            let shouldForward = false;
            if (isVideo && allowedTypes.includes('video')) shouldForward = true;
            if (isImage && allowedTypes.includes('image')) shouldForward = true;
            if (isDocument && allowedTypes.includes('document')) shouldForward = true;
            if (isAlbum) shouldForward = true;

            if (shouldForward) {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        // Clean Message using helper functions (1 & 2)
                        let cleanMessage = cleanForwardedLabel(wasi_msg.message);

                        const textFields = ['conversation', 'extendedTextMessage'];
                        textFields.forEach(field => {
                            if (cleanMessage[field]) {
                                let txt = cleanMessage[field].text || cleanMessage[field];
                                if (typeof txt === 'string') {
                                    let cleaned = cleanNewsletterText(txt);
                                    if (field === 'conversation') cleanMessage.conversation = cleaned;
                                    else cleanMessage.extendedTextMessage.text = cleaned;
                                }
                            }
                        });

                        if (cleanMessage.imageMessage?.caption) {
                            cleanMessage.imageMessage.caption = replaceCaption(cleanNewsletterText(cleanMessage.imageMessage.caption));
                        }
                        if (cleanMessage.videoMessage?.caption) {
                            cleanMessage.videoMessage.caption = replaceCaption(cleanNewsletterText(cleanMessage.videoMessage.caption));
                        }
                        if (cleanMessage.documentMessage?.caption) {
                            cleanMessage.documentMessage.caption = replaceCaption(cleanNewsletterText(cleanMessage.documentMessage.caption));
                        }

                        try {
                            await wasi_sock.sendMessage(targetJid, cleanMessage);
                        } catch (mediaErr) {
                            await wasi_sock.relayMessage(targetJid, cleanMessage, { messageId: wasi_msg.key.id });
                        }

                        console.log(`[+] Media forwarded from ${cleanFrom} to ${targetJid}`);
                        break;
                    } catch (err) {
                        console.error(`[!] Attempt ${attempt} failed for ${targetJid}:`, err.message);
                        if (attempt < 3) await new Promise(res => setTimeout(res, 3000));
                    }
                }
            }

        } catch (e) {
            console.error('❌ General Error:', e.message);
        }
    });
}

// -----------------------------------------------------------------------------
// APIS
// -----------------------------------------------------------------------------
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
        activeSessions: Array.from(sessions.keys()),
        keepAliveActive: keepAliveIntervals.has(sessionId)
    });
});

wasi_app.post('/api/restart', async (req, res) => {
    try {
        for (const [sessionId, interval] of keepAliveIntervals) clearInterval(interval);
        keepAliveIntervals.clear();
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
        
        if (keepAliveIntervals.has(sessionId)) {
            clearInterval(keepAliveIntervals.get(sessionId));
            keepAliveIntervals.delete(sessionId);
        }
        
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
        isConnected: sessions.get(id)?.isConnected || false,
        keepAliveActive: keepAliveIntervals.has(id)
    }));
    res.json({ success: true, sessions: sessionList, total: sessionList.length });
});

wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        keepAliveCount: keepAliveIntervals.size
    });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🛡️ Simple Source:Target Mapping & All Cleaning Features Configured Successfully!`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

main().catch(err => console.error('Main startup error:', err));
