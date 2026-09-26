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
// SESSION STATE & MESSAGE STORE (FOR ANTI-DELETE / VIEW ONCE)
// -----------------------------------------------------------------------------
const sessions = new Map();
const messageStore = new Map(); // Store recent messages for Anti-Delete & View Once

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));
setInterval(() => {
    try {
        cleanTempFiles(true);
    } catch (e) {
        console.error('Auto clean error:', e.message);
    }
}, 30 * 60 * 1000);

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION
// -----------------------------------------------------------------------------
const SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',')
    : [];

const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',')
    : [];

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

    // -----------------------------------------------------------------------------
    // MESSAGE STORE LISTENER (TRACKING MESSAGES FOR ANTI-DELETE & VIEW ONCE)
    // -----------------------------------------------------------------------------
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        try {
            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg || !wasi_msg.message) return;

            const rawFrom = wasi_msg.key.remoteJid;
            const isGroup = rawFrom.endsWith('@g.us');
            const cleanFrom = cleanJid(rawFrom);
            const msgContent = wasi_msg.message;
            const senderJid = wasi_msg.key.participant || wasi_msg.key.remoteJid;
            const botOwnerJid = wasi_sock.user.id; // Bot owner ka personal chat JID

            // Save message in store for anti-delete feature (Keep last 500 messages)
            if (wasi_msg.key && wasi_msg.key.id) {
                messageStore.set(wasi_msg.key.id, {
                    msg: wasi_msg,
                    rawFrom: rawFrom,
                    senderJid: senderJid,
                    timestamp: Date.now()
                });
                
                // Limit store size to prevent high memory usage
                if (messageStore.size > 500) {
                    const oldestKey = messageStore.keys().next().value;
                    messageStore.delete(oldestKey);
                }
            }

            // =========================================================================
            // 👀 ANTI-VIEW ONCE / VIEW ONCE EXTRACTOR
            // =========================================================================
            const viewOnceMsg = msgContent.viewOnceMessage?.message || 
                                msgContent.viewOnceMessageV2?.message || 
                                msgContent.ephemeralMessage?.message?.viewOnceMessage?.message;

            if (viewOnceMsg) {
                try {
                    console.log(`[!] View Once message detected from ${senderJid} in ${rawFrom}`);
                    let decryptedMsg = viewOnceMsg;
                    
                    // Convert View Once back to normal media message object
                    let mediaType = Object.keys(viewOnceMsg)[0];
                    if (viewOnceMsg[mediaType]) {
                        viewOnceMsg[mediaType].viewOnce = false; // Remove view once restriction
                    }

                    let captionText = viewOnceMsg[mediaType]?.caption || '';
                    let notificationText = `🔓 *Anti-View Once Caught!*\n👤 *From:* @${senderJid.split('@')[0]}\n📍 *Chat:* ${isGroup ? 'Group' : 'Personal'}\n${captionText ? `📝 *Caption:* ${captionText}` : ''}`;

                    // Send notification and media to bot owner's personal chat (or current chat if it's personal)
                    const sendTarget = isGroup ? botOwnerJid : rawFrom;
                    
                    await wasi_sock.sendMessage(sendTarget, { text: notificationText, mentions: [senderJid] });
                    await wasi_sock.sendMessage(sendTarget, { forward: wasi_msg });
                } catch (voErr) {
                    console.error('❌ Anti-View Once Error:', voErr.message);
                }
            }

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

            // -------------------------------------------------------------------------
            // ⚙️ ANTILINK ON / OFF COMMANDS
            // -------------------------------------------------------------------------
            if (msgText.toLowerCase() === '!antilink on') {
                config.antiLinkEnabled = true;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '🛡️ Anti-Link & Anti-Text Protection has been enabled (ON) for members only! Admins are completely bypassed.' }, { quoted: wasi_msg });
                return;
            }
            if (msgText.toLowerCase() === '!antilink off') {
                config.antiLinkEnabled = false;
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: '⚠️ Anti-Link & Anti-Text Protection has been disabled (OFF)!' }, { quoted: wasi_msg });
                return;
            }

            // =========================================================================
            // 🛡️ ANTI-TEXT & ANTI-LINK PROTECTION (BYPASS FOR ADMINS)
            // =========================================================================
            if (config.antiLinkEnabled && isGroup && !wasi_msg.key.fromMe) {
                const hasLink = /https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\b/i.test(msgText) || msgText.includes('wa.me/');
                const isPlainOrLinkText = !!(msgContent.conversation || msgContent.extendedTextMessage);

                if (hasLink || isPlainOrLinkText) {
                    try {
                        const groupMetadata = await wasi_sock.groupMetadata(rawFrom);
                        const participants = groupMetadata.participants || [];
                        const senderParticipant = participants.find(p => p.id === senderJid);
                        const isAdmin = senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin');

                        if (isAdmin) {
                            return; 
                        }

                        await wasi_sock.sendMessage(rawFrom, { delete: wasi_msg.key });
                        await wasi_sock.groupParticipantsUpdate(rawFrom, [senderJid], 'remove');
                        console.log(`[!] Removed normal member ${senderJid} for sending text/link in group ${rawFrom}`);
                        return;
                    } catch (err) {
                        console.error('❌ Anti-text/link kick error:', err.message);
                    }
                }
            }
                 
            // =========================================================================
            // ⚡ FORWARD TYPE FILTERING LOGIC
            // =========================================================================
            const sourceList = (process.env.SOURCE_JIDS || '').split(',').map(id => cleanJid(id));
            if (sourceList.length > 0 && sourceList[0] !== '' && !sourceList.some(src => cleanFrom.includes(src))) return;

            const targetList = (process.env.TARGET_JIDS || '').split(',').map(id => id.trim()).filter(Boolean);
            if (targetList.length === 0) return;

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
                for (const targetJid of targetList) {
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

                            try {
                                await wasi_sock.sendMessage(targetJid, cleanMessage);
                            } catch (mediaErr) {
                                await wasi_sock.relayMessage(targetJid, cleanMessage, { messageId: wasi_msg.key.id });
                            }

                            console.log(`[+] Allowed Media forwarded to ${targetJid}`);
                            break;
                        } catch (err) {
                            console.error(`[!] Attempt ${attempt} failed for ${targetJid}:`, err.message);
                            if (attempt < 3) await new Promise(res => setTimeout(res, 3000));
                        }
                    }
                    
                    await new Promise(res => setTimeout(res, 1500));
                }
            }

        } catch (e) {
            console.error('❌ General Error:', e.message);
        }
    });

    // -----------------------------------------------------------------------------
    // 🗑️ ANTI-DELETE EVENT LISTENER (CATCHES DELETED MESSAGES & SENDS TO OWNER)
    // -----------------------------------------------------------------------------
    wasi_sock.ev.on('messages.update', async (updates) => {
        try {
            for (const update of updates) {
                // Check if message was revoked/deleted for everyone
                if (update.update && update.update.message === null) {
                    const msgId = update.key.id;
                    const storedData = messageStore.get(msgId);

                    if (storedData) {
                        const deletedMsg = storedData.msg;
                        const senderJid = storedData.senderJid;
                        const chatJid = storedData.rawFrom;
                        const botOwnerJid = wasi_sock.user.id;

                        // Don't trigger if bot itself deleted its own message
                        if (deletedMsg.key.fromMe) return;

                        console.log(`[!] Deleted message caught from ${senderJid} in chat ${chatJid}`);

                        let textContent = deletedMsg.message.conversation || 
                                          deletedMsg.message.extendedTextMessage?.text || 
                                          deletedMsg.message.imageMessage?.caption || 
                                          deletedMsg.message.videoMessage?.caption || 
                                          '*(Media / No Text)*';

                        let alertMessage = `🚨 *Anti-Delete Alert!*\n\n` +
                                           `👤 *Sender:* @${senderJid.split('@')[0]}\n` +
                                           `📍 *Chat/Group ID:* \`${chatJid}\`\n` +
                                           `💬 *Deleted Text/Content:* ${textContent}`;

                        // Send alert and forwarded deleted message directly to bot owner's personal chat
                        await wasi_sock.sendMessage(botOwnerJid, { text: alertMessage, mentions: [senderJid] });
                        
                        // Forward the actual deleted media/text message to owner as well
                        try {
                            await wasi_sock.sendMessage(botOwnerJid, { forward: deletedMsg });
                        } catch (fwdErr) {
                            console.error('Failed to forward deleted media:', fwdErr.message);
                        }
                    }
                }
            }
        } catch (err) {
            console.error('❌ Anti-Delete Error:', err.message);
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
        res.status(500).json({ success: false, error: error.message exact: false });
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
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🛡️ Anti-Delete & Anti-View Once Features Fully Integrated!`);
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
