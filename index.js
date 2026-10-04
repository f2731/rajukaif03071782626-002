require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    downloadMediaMessage,
    Browsers
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

/* 
  📌 Simple Direct Mapping Setup:
*/
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
// (1) & (2) HELPER FUNCTIONS FOR MESSAGE & NEWSLETTER CLEANING
// -----------------------------------------------------------------------------
function cleanForwardedLabel(msgContent) {
    if (!msgContent || typeof msgContent !== 'object') return;
    if (msgContent.contextInfo) {
        delete msgContent.contextInfo.forwardingScore;
        delete msgContent.contextInfo.isForwarded;
    }
    for (let key of Object.keys(msgContent)) {
        if (typeof msgContent[key] === 'object' && msgContent[key] !== null) {
            cleanForwardedLabel(msgContent[key]);
        }
    }
}

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
    let text = cleanNewsletterText(caption);
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return text;
    
    let result = text;
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
// (3), (4) & (5) SESSION MANAGEMENT, KEEP-ALIVE & AUTO RECONNECTION SETUP
// -----------------------------------------------------------------------------
function startKeepAlive(sock) {
    if (sock.keepAliveInterval) clearInterval(sock.keepAliveInterval);
    sock.keepAliveInterval = setInterval(async () => {
        try {
            if (sock && sock.ws && sock.ws.readyState === sock.ws.OPEN) {
                await sock.sendPresenceUpdate('available');
                console.log('🔄 Keep-Alive presence signal sent successfully.');
            }
        } catch (error) {
            console.error('❌ Keep-Alive error:', error.message);
        }
    }, 30 * 1000); // Har 30 seconds ke baad
}

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) return;

        if (existing.sock) {
            if (existing.sock.keepAliveInterval) clearInterval(existing.sock.keepAliveInterval);
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

    // Keep-Alive Mechanism Shuru Karna
    startKeepAlive(wasi_sock);

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.isConnected = false;
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            if (wasi_sock.keepAliveInterval) clearInterval(wasi_sock.keepAliveInterval);

            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            if (shouldReconnect) {
                sessionState.reconnectAttempts++;
                // Exponential backoff delay calculation
                const delay = Math.min(1000 * Math.pow(2, sessionState.reconnectAttempts), 30000);
                console.log(`⚠️️ Connection closed. Reconnecting in ${delay / 1000} seconds (Attempt ${sessionState.reconnectAttempts})...`);
                setTimeout(() => { startSession(sessionId); }, delay);
            } else {
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
                console.log('❌ Session logged out permanently.');
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            sessionState.reconnectAttempts = 0; // Reset attempts on successful connection
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);

            // Admin ko startup/reconnection par notification bhejna
            try {
                const adminJid = wasi_sock.user?.id ? jidNormalizedUser(wasi_sock.user.id) : null;
                if (adminJid) {
                    await wasi_sock.sendMessage(adminJid, { text: `🚀 Bot successfully connected and online! Session ID: ${sessionId}` });
                }
            } catch (err) {
                console.error('Failed to send startup notification to admin:', err.message);
            }
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

            const msgText = cleanNewsletterText(
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

            // -------------------------------------------------------------------------
            // ⚙️ ANTILINK ON / OFF COMMANDS
            // -------------------------------------------------------------------------
            if (msgText.toLowerCase() === '!antilink on') {
                config.antiLinkEnabled = true;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '🛡️ Anti-Link, Anti-Text, Anti-Voice Note & Anti-Status Protection has been enabled (ON) for members only! Admins are completely bypassed.' }, { quoted: wasi_msg });
                return;
            }
            if (msgText.toLowerCase() === '!antilink off') {
                config.antiLinkEnabled = false;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '⚠️ Anti-Link, Anti-Text, Anti-Voice Note & Anti-Status Protection has been disabled (OFF)!' }, { quoted: wasi_msg });
                return;
            }

            // =========================================================================
            // 🛡️ ANTI-TEXT, ANTI-LINK, ANTI-VOICE NOTE (PTT) & ANTI-STATUS PROTECTION
            // =========================================================================
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

                        if (isAdmin) {
                            console.log(`[!] Admin ${senderJid} sent restricted content in group ${rawFrom}. Bypassed completely.`);
                            return; 
                        }

                        await wasi_sock.sendMessage(rawFrom, { delete: wasi_msg.key });
                        await wasi_sock.groupParticipantsUpdate(rawFrom, [senderJid], 'remove');
                        console.log(`[!] Removed normal member ${senderJid} for sending restricted content/voice note in group ${rawFrom}`);
                        return; 
                    } catch (err) {
                        console.error('❌ Anti-protection kick error (Make sure bot is admin):', err.message);
                    }
                }
            }
                 
            // =========================================================================
            // ⚡ SIMPLE SOURCE:TARGET FORWARD MAPPING LOGIC
            // =========================================================================
            let targetJid = null;
            
            const matchedSourceKey = Object.keys(FORWARD_MAP).find(src => cleanFrom.includes(cleanJid(src)));
            if (matchedSourceKey) {
                targetJid = FORWARD_MAP[matchedSourceKey];
            } else {
                const sourceList = (process.env.SOURCE_JIDS || '').split(',').map(id => cleanJid(id));
                if (sourceList.length > 0 && sourceList[0] !== '' && !sourceList.some(src => cleanFrom.includes(src))) return;
                const targets = (process.env.TARGET_JIDS || '').split(',').map(id => id.trim()).filter(Boolean);
                targetJid = targets[0]; // Fallback to first target
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
                        let cleanMessage = JSON.parse(JSON.stringify(wasi_msg.message));

                        // (1) Forwarded Label Removal function call
                        cleanForwardedLabel(cleanMessage);

                        if (cleanMessage.imageMessage?.caption) {
                            cleanMessage.imageMessage.caption = replaceCaption(cleanMessage.imageMessage.caption);
                        }
                        if (cleanMessage.videoMessage?.caption) {
                            cleanMessage.videoMessage.caption = replaceCaption(cleanMessage.videoMessage.caption);
                        }
                        if (cleanMessage.documentMessage?.caption) {
                            cleanMessage.documentMessage.caption = replaceCaption(cleanMessage.documentMessage.caption);
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
                try { 
                    if (session.sock.keepAliveInterval) clearInterval(session.sock.keepAliveInterval);
                    session.sock.end(undefined); 
                } catch (e) {}
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
            try { 
                if (session.sock.keepAliveInterval) clearInterval(session.sock.keepAliveInterval);
                await session.sock.logout(); 
            } catch (e) {}
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

// -------------------------------------------------------------
// SERVER START
// -----------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🛡️ Simple Source:Target Mapping Configured Successfully!`);
    });
}

// -------------------------------------------------------------
// MAIN STARTUP
// -------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

main().catch(err => console.error('Main startup error:', err));
