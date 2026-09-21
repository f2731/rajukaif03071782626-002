const dns = require('dns');
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (e) {}
/**
 * ⚡ KAIF-MD-V3 ⚡
 * Main Entry Point
 * Developed by Kaif (ixxkaif)
 */
require('dotenv').config();

// Backup original console methods
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

// SSE log clients for dashboard live log streaming
const logClients = new Set();
const broadcastLog = (type, text) => {
    if (!logClients.size) return;
    const payload = `data: ${JSON.stringify({ type, text, timestamp: new Date().toISOString() })}\n\n`;
    for (const clientRes of logClients) {
        try {
            clientRes.write(payload);
        } catch (e) {
            logClients.delete(clientRes);
        }
    }
};

process.on('uncaughtException', (err) => {
    try {
        const msg = `Uncaught Exception: ${err?.stack || err?.message || String(err)}`;
        broadcastLog('error', msg);
        originalConsoleError.apply(console, ['s,? Uncaught Exception:', err?.stack || err?.message || String(err)]);
    } catch (e) {}
});

process.on('unhandledRejection', (reason, promise) => {
    try {
        const msg = `Unhandled Rejection: ${reason?.stack || reason?.message || String(reason)}`;
        broadcastLog('error', msg);
        originalConsoleError.apply(console, ['s,? Unhandled Rejection:', reason?.stack || reason?.message || String(reason)]);
    } catch (e) {}
});

// Filter out noisy libsignal decryption/Bad MAC console spam
const isNoisyLog = (msg) => {
    if (!msg || typeof msg !== 'string') return false;
    return (
        msg.includes('Bad MAC') ||
        msg.includes('Closing session: SessionEntry') ||
        msg.includes('Failed to decrypt message') ||
        msg.includes('Decrypted message with closed session') ||
        msg.includes('Closing open session in favor of incoming prekey bundle') ||
        msg.includes('registrationId:') ||
        msg.includes('currentRatchet:') ||
        msg.includes('ephemeralKeyPair:') ||
        msg.includes('indexInfo:') ||
        msg.includes('pendingPreKey:')
    );
};

const safeFormatArg = (a) => {
    if (a === null || a === undefined) return String(a);
    if (typeof a === 'string') return a;
    if (typeof a === 'object') {
        try {
            return JSON.stringify(a);
        } catch (e) {
            return String(a);
        }
    }
    return String(a);
};

console.error = function (...args) {
    try {
        const msg = args.map(safeFormatArg).join(' ');
        if (isNoisyLog(msg)) return;
        broadcastLog('error', msg);
    } catch (e) {}
    originalConsoleError.apply(console, args);
};

console.log = function (...args) {
    try {
        const msg = args.map(safeFormatArg).join(' ');
        if (isNoisyLog(msg)) return;
        broadcastLog('log', msg);
    } catch (e) {}
    originalConsoleLog.apply(console, args);
};

const {
    DisconnectReason,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { kaif_connectSession, kaif_requestPairingCode, kaif_clearSession } = require('./kaiflib/session');
const {
    kaif_connectDatabase,
    kaif_getGroupSettings,
    kaif_isDbConnected,
    kaif_getGlobalAutoForward,
    kaif_updateGlobalAutoForward,
    kaif_getBotConfig,
    kaif_updateBotConfig,
    kaif_saveMessage,
    kaif_getMessage,
    kaif_purgeOldMessages
} = require('./kaiflib/database');
const config = require('./kaif');
const qrcode = require('qrcode');

const kaif_app = express();
const kaif_port = process.env.PORT || 3000;

// In-memory store for fast anti-delete tracking
const msgStore = new Map();

// In-memory Group Metadata Cache for 0ms Command Speed
const groupMetadataCache = new Map();

// Global in-memory cache for WhatsApp LID -> Phone JID resolution
const lidToPhoneMap = new Map();

async function resolveLidToPhone(sock, senderJid, originJid, kaif_msg) {
    if (!senderJid) return senderJid;
    if (senderJid.endsWith('@s.whatsapp.net')) return senderJid;

    if (lidToPhoneMap.has(senderJid)) return lidToPhoneMap.get(senderJid);
    const cleanLid = senderJid.split('@')[0];
    if (lidToPhoneMap.has(cleanLid)) return lidToPhoneMap.get(cleanLid);

    // 1. Resolve via group participants if in a group (@g.us)
    if (originJid && originJid.endsWith('@g.us')) {
        try {
            const gMeta = await getCachedGroupMetadata(sock, originJid).catch(() => null);
            if (gMeta && gMeta.participants) {
                for (const p of gMeta.participants) {
                    if (p.lid && p.id) {
                        const normLid = jidNormalizedUser(p.lid);
                        const normId = jidNormalizedUser(p.id);
                        lidToPhoneMap.set(normLid, normId);
                        lidToPhoneMap.set(normLid.split('@')[0], normId);
                    }
                }
                if (lidToPhoneMap.has(senderJid)) return lidToPhoneMap.get(senderJid);
                if (lidToPhoneMap.has(cleanLid)) return lidToPhoneMap.get(cleanLid);
            }
        } catch (e) {}
    }

    // 2. Resolve via Baileys SignalRepository LID Mapping
    try {
        if (sock?.signalRepository?.lidMapping) {
            const mapped = await sock.signalRepository.lidMapping.getPNForLID(senderJid).catch(() => null)
                || await sock.signalRepository.lidMapping.getPNForLID(cleanLid).catch(() => null);
            if (mapped) {
                const norm = jidNormalizedUser(mapped.includes('@') ? mapped : mapped + '@s.whatsapp.net');
                lidToPhoneMap.set(senderJid, norm);
                lidToPhoneMap.set(cleanLid, norm);
                return norm;
            }
        }
    } catch (e) {}

    // 3. Resolve via Baileys AuthState LID Mapping
    try {
        if (sock?.authState?.keys?.get) {
            const res = await sock.authState.keys.get('lid-mapping', [cleanLid, senderJid]).catch(() => null);
            if (res) {
                const val = res[cleanLid] || res[senderJid];
                if (val && typeof val === 'string') {
                    const norm = jidNormalizedUser(val.includes('@') ? val : val + '@s.whatsapp.net');
                    lidToPhoneMap.set(senderJid, norm);
                    lidToPhoneMap.set(cleanLid, norm);
                    return norm;
                }
            }
        }
    } catch (e) {}

    return senderJid;
}

// In-Memory Config Caching for 0ms Response Speed
const botConfigCacheMap = new Map();
const globalAutoForwardCacheMap = new Map();

async function getCachedBotConfig(sessionId) {
    const cached = botConfigCacheMap.get(sessionId);
    if (cached && (Date.now() - cached.timestamp < 10000)) {
        return cached.data;
    }
    try {
        const data = await kaif_getBotConfig(sessionId);
        if (data) botConfigCacheMap.set(sessionId, { data, timestamp: Date.now() });
        return data;
    } catch (e) {
        return cached ? cached.data : null;
    }
}

async function getCachedGlobalAutoForward(sessionId) {
    const cached = globalAutoForwardCacheMap.get(sessionId);
    if (cached && (Date.now() - cached.timestamp < 10000)) {
        return cached.data;
    }
    try {
        const data = await kaif_getGlobalAutoForward(sessionId);
        if (data) globalAutoForwardCacheMap.set(sessionId, { data, timestamp: Date.now() });
        return data;
    } catch (e) {
        return cached ? cached.data : null;
    }
}

function invalidateConfigCaches(sessionId) {
    botConfigCacheMap.delete(sessionId);
    globalAutoForwardCacheMap.delete(sessionId);
}
global.invalidateConfigCaches = invalidateConfigCaches;

/// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// SEQUENTIAL ANTI-DELETE QUEUE (PREVENTS MIXING OF TEXT & MEDIA)
// -----------------------------------------------------------------------------
const antiDeleteQueue = [];
let isProcessingAntiDeleteQueue = false;

async function processAntiDeleteQueue() {
    if (isProcessingAntiDeleteQueue || antiDeleteQueue.length === 0) return;
    isProcessingAntiDeleteQueue = true;

    while (antiDeleteQueue.length > 0) {
        const task = antiDeleteQueue.shift();
        const { kaif_sock, ownerJid, infoText, mentions, fullMsgData } = task;

        try {
            // 1. Send Header for THIS specific message
            await kaif_sock.sendMessage(ownerJid, {
                text: infoText,
                mentions
            });

            // 2. Relay media immediately for THIS specific message
            if (fullMsgData?.message) {
                const cleanOriginal = unwrapMessage(fullMsgData.message);
                if (cleanOriginal.imageMessage || cleanOriginal.videoMessage || cleanOriginal.audioMessage || cleanOriginal.documentMessage || cleanOriginal.stickerMessage) {
                    const cleanMediaMsg = processAndCleanMessage(fullMsgData.message);
                    await kaif_sock.relayMessage(ownerJid, cleanMediaMsg, {
                        messageId: kaif_sock.generateMessageTag()
                    });
                }
            }

            // 3. Small 350ms delay so WhatsApp app renders each Header + Media together in 1-to-1 order
            await new Promise(resolve => setTimeout(resolve, 350));
        } catch (e) {
            console.error('[ANTIDELETE-QUEUE] Error sending recovery:', e.message);
        }
    }

    isProcessingAntiDeleteQueue = false;
}

function enqueueAntiDelete(item) {
    antiDeleteQueue.push(item);
    processAntiDeleteQueue().catch(err => {
        console.error('[ANTIDELETE-QUEUE] Queue execution error:', err.message);
        isProcessingAntiDeleteQueue = false;
    });
}

// INSTANT PARALLEL AUTO-FORWARD QUEUE & SANITIZED JID DISPATCH
// -----------------------------------------------------------------------------
function sanitizeJid(input) {
    if (!input || typeof input !== 'string') return null;
    let str = input.trim().toLowerCase();
    const keywords = ['global', 'set', 'add', 'on', 'off', 'clear', 'source_jids', 'target_jids', 'sources', 'targets', 'source', 'target', 'src', 'tgt', 'dest', 'type', 'types', 'status'];
    if (keywords.includes(str)) return null;

    const parts = str.split(/\s+/);
    const lastPart = parts[parts.length - 1];
    if (lastPart.endsWith('@g.us') || lastPart.endsWith('@s.whatsapp.net') || lastPart.endsWith('@newsletter') || lastPart.endsWith('@lid')) {
        return lastPart;
    }

    const digits = str.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length >= 15) return `${digits}@g.us`;
    if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
    return null;
}

const processedAutoForwardMsgSet = new Set();
const autoForwardQueue = [];
let isProcessingAutoForwardQueue = false;

async function processAutoForwardQueue() {
    if (isProcessingAutoForwardQueue || autoForwardQueue.length === 0) return;
    isProcessingAutoForwardQueue = true;

    while (autoForwardQueue.length > 0) {
        const task = autoForwardQueue.shift();
        const { kaif_sock, targetJids, relayMsg, kaif_origin, msgId } = task;

        await Promise.all(targetJids.map(async (targetJid) => {
            const cleanTarget = sanitizeJid(targetJid);
            if (!cleanTarget) return;

            const cleanOrigin = kaif_origin.trim().toLowerCase();
            if (cleanTarget === cleanOrigin) return;

            const tDigits = cleanTarget.replace(/\D/g, '');
            const oDigits = cleanOrigin.replace(/\D/g, '');
            if (tDigits && oDigits && tDigits === oDigits && !cleanTarget.endsWith('@g.us') && !cleanTarget.endsWith('@newsletter')) {
                return;
            }

            try {
                // Ensure 100% clean, un-labeled message (no forwarded tag, no channel branding)
                const itemRelayMsg = JSON.parse(JSON.stringify(relayMsg));
                const targetBlocks = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
                targetBlocks.forEach(block => {
                    if (itemRelayMsg[block]) {
                        if (itemRelayMsg[block].contextInfo) {
                            delete itemRelayMsg[block].contextInfo.isForwarded;
                            delete itemRelayMsg[block].contextInfo.forwardingScore;
                            delete itemRelayMsg[block].contextInfo.forwardedNewsletterMessageInfo;
                            delete itemRelayMsg[block].contextInfo.externalAdReply;
                            delete itemRelayMsg[block].contextInfo.newsletterJid;
                            delete itemRelayMsg[block].contextInfo.newsletterName;
                            delete itemRelayMsg[block].contextInfo.newsletterServerMessageId;
                            itemRelayMsg[block].contextInfo.isForwarded = false;
                            itemRelayMsg[block].contextInfo.forwardingScore = 0;
                        }
                        delete itemRelayMsg[block].isForwarded;
                        delete itemRelayMsg[block].forwardingScore;
                    }
                });

                if (itemRelayMsg.contextInfo) {
                    delete itemRelayMsg.contextInfo.isForwarded;
                    delete itemRelayMsg.contextInfo.forwardingScore;
                    delete itemRelayMsg.contextInfo.forwardedNewsletterMessageInfo;
                    itemRelayMsg.contextInfo.isForwarded = false;
                    itemRelayMsg.contextInfo.forwardingScore = 0;
                }

                await kaif_sock.relayMessage(cleanTarget, itemRelayMsg, {
                    messageId: kaif_sock.generateMessageTag()
                });
                console.log(`🚀 [GLOBAL-FORWARD] Clean forwarded message ${msgId || ''} from ${kaif_origin} to ${cleanTarget}`);
            } catch (err) {
                console.error(`[GLOBAL-FORWARD] Failed for ${cleanTarget}:`, err.message);
            }
        }));
    }

    isProcessingAutoForwardQueue = false;
}

function enqueueAutoForward(item) {
    autoForwardQueue.push(item);
    processAutoForwardQueue().catch(err => {
        console.error('[AUTO-FORWARD-QUEUE] Error:', err.message);
        isProcessingAutoForwardQueue = false;
    });
}
async function getCachedGroupMetadata(sock, jid) {
    const cached = groupMetadataCache.get(jid);
    if (cached && (Date.now() - cached.timestamp < 3 * 60 * 1000)) {
        return cached.data;
    }
    try {
        const data = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, { data, timestamp: Date.now() });
        return data;
    } catch (e) {
        if (cached?.data) return cached.data;
        throw e;
    }
}

// Helper to prune in-memory message store entries older than 6 hours
function unwrapMessage(msg) {
    if (!msg) return {};
    let m = msg;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    if (m.editedMessage?.message) m = m.editedMessage.message;
    return m;
}

function parseNumberList(input, fallback = []) {
    if (!input) return fallback;
    if (Array.isArray(input)) return input.map(s => String(s).trim()).filter(Boolean);
    if (typeof input === 'string') return input.split(',').map(s => s.trim()).filter(Boolean);
    return [String(input)];
}

function normalizePhoneNumber(num) {
    if (!num) return '';
    let cleaned = String(num).replace(/\D/g, '');
    if (!cleaned) return '';
    if (cleaned.startsWith('03') && cleaned.length === 11) {
        cleaned = '92' + cleaned.slice(1);
    } else if (cleaned.startsWith('0') && cleaned.length === 11) {
        cleaned = '92' + cleaned.slice(1);
    } else if (cleaned.length === 10 && cleaned.startsWith('3')) {
        cleaned = '92' + cleaned;
    }
    return cleaned;
}

function formatPhoneToJid(num) {
    if (!num) return null;
    if (typeof num === 'string' && num.endsWith('@s.whatsapp.net')) {
        const userPart = num.split('@')[0];
        const norm = normalizePhoneNumber(userPart);
        return norm ? `${norm}@s.whatsapp.net` : num;
    }
    const clean = normalizePhoneNumber(num);
    return clean ? `${clean}@s.whatsapp.net` : null;
}

function pruneInMemoryStore() {
    const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
    let prunedCount = 0;
    for (const [id, msgObj] of msgStore.entries()) {
        const timestamp = msgObj._receivedAt || (msgObj.messageTimestamp ? msgObj.messageTimestamp * 1000 : 0);
        if (timestamp && timestamp < sixHoursAgo) {
            msgStore.delete(id);
            prunedCount++;
        }
    }
    if (prunedCount > 0) {
        console.log(`🧹 RAM Pruner: Removed ${prunedCount} cached messages older than 6 hours.`);
    }
}

// -----------------------------------------------------------------------------
// PLUGIN LOADER
// -----------------------------------------------------------------------------
const kaif_plugins = new Map();

function kaif_loadPlugins() {
    const pluginDir = path.join(__dirname, 'kaifplugins');
    if (!fs.existsSync(pluginDir)) return;

    const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js'));
    
    for (const file of files) {
        try {
            const relPath = './kaifplugins/' + file;
            delete require.cache[require.resolve(relPath)];
            const plugin = require(relPath);
            if (plugin && plugin.name) {
                const name = plugin.name.toLowerCase();
                kaif_plugins.set(name, plugin);
                const aliases = plugin.aliases || plugin.alias;
                if (aliases && Array.isArray(aliases)) {
                    aliases.forEach(a => kaif_plugins.set(a.toLowerCase(), plugin));
                }
            }
        } catch (e) {
            console.error(`Failed to load plugin ${file}:`, e.message);
        }
    }
    console.log(`✅ Loaded ${kaif_plugins.size} core commands.`);
}

// -----------------------------------------------------------------------------
// TEXT REPLACEMENT & CLEANING CONFIG
// -----------------------------------------------------------------------------
const { processAndCleanMessage, cleanTempFiles } = require('./kaiflib/cleaner');

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// Middleware & Disable ETag caching for real-time APIs
kaif_app.set('etag', false);
kaif_app.use(express.json());
kaif_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
kaif_app.get('/ping', (req, res) => res.status(200).send('pong'));

// Dashboard APIs
// SSE Real-Time Logs Stream
kaif_app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    logClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'info', text: 'Connected to live log stream', timestamp: new Date().toISOString() })}\n\n`);

    // Heroku H15 prevention: Keep connection alive every 20 seconds
    const heartbeat = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        } catch (e) {}
    }, 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        logClients.delete(res);
    });
});

kaif_app.get('/api/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const sessionId = config.sessionId || 'kaif_session';
    const session = sessions.get(sessionId);
    res.json({
        sessionId: config.sessionId,
        connected: session?.isConnected || false,
        qr: session?.qr || null,
        pairingCode: session?.pairingCode || null,
        dbConnected: kaif_isDbConnected()
    });
});

kaif_app.post('/api/pairing-code', async (req, res) => {
    try {
        const sessionId = config.sessionId || 'kaif_session';
        const session = sessions.get(sessionId);

        if (!session || !session.sock) {
            return res.status(400).json({ success: false, error: 'Session not ready yet. Please wait and try again.' });
        }

        const { phoneNumber } = req.body || {};
        const code = await kaif_requestPairingCode(session.sock, phoneNumber);

        const cleanCode = String(code || '').replace(/[^A-Z0-9]/g, '');
        session.pairingCode = code;

        res.json({
            success: true,
            pairingCode: code,
            rawCode: cleanCode,
            phoneNumber,
            code
        });
    } catch (e) {
        console.error('POST /api/pairing-code Error:', e.message);
        res.status(400).json({ success: false, error: e.message });
    }
});

kaif_app.get('/api/config', async (req, res) => {
    try {
        const sessionId = config.sessionId || 'kaif_session';
        const botCfg = await getCachedBotConfig(sessionId);
        const globalCfg = await getCachedGlobalAutoForward(sessionId);
        res.json({
            antiDelete: botCfg ? botCfg.antiDelete !== false : true,
            autoStatusSeen: botCfg ? botCfg.autoStatusSeen !== false : true,
            autoStatusReact: botCfg ? botCfg.autoStatusReact !== false : true,
            autoForwardEnabled: globalCfg ? globalCfg.enabled !== false : false,
            sourceJids: globalCfg?.sourceJids || [],
            targetJids: globalCfg?.targetJids || [],
            oldTextRegex: globalCfg?.oldTextRegex || [],
            newText: globalCfg?.newText || "",
            forwardPicture: globalCfg ? globalCfg.forwardPicture !== false : true,
            forwardVideo: globalCfg ? globalCfg.forwardVideo !== false : true,
            forwardAudio: globalCfg ? globalCfg.forwardAudio !== false : true,
            forwardDocument: globalCfg ? globalCfg.forwardDocument !== false : true,
            forwardText: globalCfg ? globalCfg.forwardText !== false : true
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

kaif_app.post('/api/config', async (req, res) => {
    try {
        const sessionId = config.sessionId || 'kaif_session';
        const {
            antiDelete,
            autoStatusSeen,
            autoStatusReact,
            autoForwardEnabled,
            sourceJids,
            targetJids,
            oldTextRegex,
            newText,
            forwardPicture,
            forwardVideo,
            forwardAudio,
            forwardDocument,
            forwardText
        } = req.body;

        await kaif_updateBotConfig(sessionId, {
            antiDelete: antiDelete ?? true,
            autoStatusSeen: autoStatusSeen ?? true,
            autoStatusReact: autoStatusReact ?? true
        });

        await kaif_updateGlobalAutoForward(sessionId, {
            enabled: autoForwardEnabled ?? false,
            sourceJids: Array.isArray(sourceJids) ? sourceJids : (sourceJids || '').split(',').map(s => s.trim()).filter(Boolean),
            targetJids: Array.isArray(targetJids) ? targetJids : (targetJids || '').split(',').map(t => t.trim()).filter(Boolean),
            oldTextRegex: Array.isArray(oldTextRegex) ? oldTextRegex : (oldTextRegex || '').split(',').map(r => r.trim()).filter(Boolean),
            newText: newText || "",
            forwardPicture: forwardPicture ?? true,
            forwardVideo: forwardVideo ?? true,
            forwardAudio: forwardAudio ?? true,
            forwardDocument: forwardDocument ?? true,
            forwardText: forwardText ?? true
        });

        invalidateConfigCaches(sessionId);
        res.json({ success: true, message: 'Settings saved successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

kaif_app.post('/api/clean', async (req, res) => {
    try {
        const sessionId = config.sessionId || 'kaif_session';
        const result = cleanTempFiles(true);
        pruneInMemoryStore();
        const purgedCount = await kaif_purgeOldMessages(sessionId, 6);

        res.json({
            success: true,
            message: `Refreshed! Cleaned ${result.cleanedCount} temp files and purged ${purgedCount} messages older than 6 hours from database!`
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

kaif_app.post('/api/reset-session', async (req, res) => {
    try {
        const newSessionId = await resetAndStartNewSession();
        res.json({
            success: true,
            sessionId: newSessionId,
            message: `Session reset successfully! New session: ${newSessionId}. Please scan the new QR code.`
        });
    } catch (e) {
        console.error('Reset Session error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) return;
        if (existing.sock) {
            try {
                existing.sock.ev.removeAllListeners('connection.update');
                existing.sock.end(undefined);
            } catch (e) {}
            sessions.delete(sessionId);
        }
    }

    console.log(`📡 Starting session: ${sessionId}`);
    const sessionState = { sock: null, isConnected: false, qr: null, pairingCode: null, isReadyForPairing: false };
    sessions.set(sessionId, sessionState);

    const { kaif_sock, saveCreds } = await kaif_connectSession(false, sessionId);
    sessionState.sock = kaif_sock;

    console.log(`📡 [${sessionId}] Socket created, listening for events...`);

    kaif_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.isReadyForPairing = true;
            try {
                sessionState.qr = await qrcode.toDataURL(qr);
                console.log(`📸 New QR Code generated for [${sessionId}]`);
            } catch (e) {
                console.error('Failed to generate QR:', e.message);
            }
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            sessionState.qr = null;
            sessionState.pairingCode = null;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            console.log(`Session ${sessionId}: Connection closed, reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                sessions.delete(sessionId);
                await kaif_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            sessionState.pairingCode = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    kaif_sock.ev.on('creds.update', saveCreds);

    // -------------------------------------------------------------------------
    // BATCH MESSAGE HANDLER (Optimized 0ms response speed)
    // -------------------------------------------------------------------------
    kaif_sock.ev.on('messages.upsert', async kaif_m => {
        if (!kaif_m.messages || !Array.isArray(kaif_m.messages)) return;
        const isLiveNotify = kaif_m.type === 'notify';

        for (const kaif_msg of kaif_m.messages) {
            if (!kaif_msg || !kaif_msg.message) continue;

            const kaif_origin = kaif_msg.key.remoteJid;
            const botJid = kaif_sock.user?.id ? jidNormalizedUser(kaif_sock.user.id) : '';
            const kaif_sender = kaif_msg.key.fromMe
                ? botJid
                : jidNormalizedUser(kaif_msg.key.participant || kaif_origin);

            const realMsg = unwrapMessage(kaif_msg.message);

            const kaif_text = realMsg.conversation ||
                realMsg.extendedTextMessage?.text ||
                realMsg.imageMessage?.caption ||
                realMsg.videoMessage?.caption ||
                realMsg.documentMessage?.caption || "";

// 👑 1. SUPER OWNER & SENDER IDENTIFICATION (With LID Resolution & Core Number Matching)
            const superOwnerList = parseNumberList(
                config.superOwners,
                ['923298634113', '923453684061', '923466859436']
            );
            const ownerList = parseNumberList(
                config.ownerNumber,
                ['923453684061']
            );

            const combinedOwners = [...new Set([...superOwnerList, ...ownerList])];

            const superCores = superOwnerList
                .map(n => normalizePhoneNumber(n).slice(-9))
                .filter(c => c.length >= 7);

            const allOwnerCores = combinedOwners
                .map(n => normalizePhoneNumber(n).slice(-9))
                .filter(c => c.length >= 7);

            let realPhoneJid = await resolveLidToPhone(kaif_sock, kaif_sender, kaif_origin, kaif_msg);

            let keyStr = '';
            try { keyStr = JSON.stringify(kaif_msg.key || {}); } catch(e) {}

            const rawSenderData = [
                kaif_origin,
                kaif_sender,
                realPhoneJid,
                kaif_msg.key?.participant,
                kaif_msg.pushName,
                keyStr
            ].filter(Boolean).join(' ');

            const normalizedSender = normalizePhoneNumber(realPhoneJid || kaif_sender || '');
            const cleanSender = (realPhoneJid || kaif_sender || '').replace(/\D/g, '');

            const rawSenderWithNormalized = rawSenderData + ' ' + normalizedSender;
            const isSuperOwner = superCores.some(core => rawSenderWithNormalized.includes(core));
            const isOwnerMessage = allOwnerCores.some(core => rawSenderData.includes(core));

            // Diagnostic Logger
            if (!kaif_msg.key.fromMe) {
                console.log(`[MSG-TRACE] origin:${kaif_origin} sender:${kaif_sender} realPhone:${realPhoneJid} isSuper:${isSuperOwner}`);
            }

            // 👑 2. AUTO CROWN REACTION (ONLY LIVE MESSAGES FROM SUPER / OWNERS)
            if (
                (isSuperOwner || isOwnerMessage || kaif_msg.key?.fromMe) &&
                isLiveNotify &&
                kaif_msg?.key &&
                kaif_origin !== 'status@broadcast'
            ) {
                kaif_sock.sendMessage(kaif_origin, {
                    react: {
                        text: '\u{1F451}',
                        key: kaif_msg.key
                    }
                }).catch(e => console.error('[SUPER-OWNER-REACT] Error:', e.message));
                console.log(`[SUPER-OWNER-REACT] Reacted with 👑 to super owner message from ${realPhoneJid || kaif_sender}`);
            }

            // Save message asynchronously without blocking the execution chain
            if (kaif_msg.key?.id) {
                kaif_msg._receivedAt = Date.now();
                msgStore.set(kaif_msg.key.id, kaif_msg);
                if (msgStore.size > 500) {
                    const firstKey = msgStore.keys().next().value;
                    msgStore.delete(firstKey);
                }

                // Asynchronous MongoDB write (non-blocking)
                kaif_saveMessage(sessionId, {
                    msgId: kaif_msg.key.id,
                    remoteJid: kaif_origin,
                    sender: kaif_sender,
                    body: kaif_text,
                    fullMsgData: kaif_msg
                }).catch(() => {});
            }

            // 0. AUTO STATUS SEEN & REACT
            if (kaif_origin === 'status@broadcast') {
                try {
                    const botCfg = await getCachedBotConfig(sessionId);
                    if (botCfg ? botCfg.autoStatusSeen !== false : true) {
                        await kaif_sock.readMessages([kaif_msg.key]);
                    }
                    if (botCfg ? botCfg.autoStatusReact !== false : true) {
                        await kaif_sock.sendMessage('status@broadcast', {
                            react: { text: '❤️', key: kaif_msg.key }
                        }, { statusJidList: [kaif_msg.key.participant] });
                    }
                } catch (e) {}
                continue;
            }

            // 0.5 ADVANCED ANTI-DELETE DETECTION & RECOVERY (SEQUENTIAL PRIVATE DM PAIRING)
            const protocolMsg = kaif_msg.message?.protocolMessage || realMsg?.protocolMessage;
            if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.type === 1)) {
                const keyToRevoke = protocolMsg.key;
                if (keyToRevoke?.id && !kaif_msg.key?.fromMe) {
                    try {
                        const botCfg = await getCachedBotConfig(sessionId);
                        const isAntiDeleteActive = botCfg ? botCfg.antiDelete !== false : true;

                        if (isAntiDeleteActive) {
                            let deletedMsg = msgStore.get(keyToRevoke.id);
                            let body = null;
                            let fullMsgData = null;

                            if (deletedMsg) {
                                fullMsgData = deletedMsg;
                                const innerReal = unwrapMessage(deletedMsg.message);
                                body = innerReal?.conversation ||
                                    innerReal?.extendedTextMessage?.text ||
                                    innerReal?.imageMessage?.caption ||
                                    innerReal?.videoMessage?.caption ||
                                    innerReal?.documentMessage?.caption || null;
                            } else {
                                const dbMsg = await kaif_getMessage(sessionId, keyToRevoke.id);
                                if (dbMsg) {
                                    fullMsgData = dbMsg.fullMsgData || null;
                                    body = dbMsg.body || null;
                                }
                            }

                            if (fullMsgData) {
                                const chatJid = kaif_origin;
                                const originalSender = fullMsgData.key?.participant || fullMsgData.key?.remoteJid || kaif_sender;
                                const deleterJid = kaif_msg.key?.participant || kaif_msg.key?.remoteJid || kaif_sender;

                                const originalPhone = (originalSender || '').replace(/\D/g, '');
                                const deleterPhone = (deleterJid || '').replace(/\D/g, '');

                                const originalNumStr = originalPhone ? `@${originalPhone}` : 'Unknown';
                                const deleterNumStr = deleterPhone ? `@${deleterPhone}` : 'Unknown';

                                const isGroup = chatJid.endsWith('@g.us');
                                let groupName = chatJid;
                                if (isGroup) {
                                    try {
                                        const meta = await getCachedGroupMetadata(kaif_sock, chatJid);
                                        groupName = meta?.subject || chatJid;
                                    } catch (e) {
                                        groupName = chatJid;
                                    }
                                }

                                console.log(`🗑️ [ANTIDELETE] Deleted message recovered from ${chatJid} by ${deleterJid}`);

                                let infoText = `🗑️ *DELETED MESSAGE RECOVERED*\n\n` +
                                    `👤 *Original Sender:* ${originalNumStr}\n`;

                                if (isGroup && deleterJid !== originalSender) {
                                    infoText += `🗑️ *Deleted By:* ${deleterNumStr}\n`;
                                }

                                infoText += `⏰ *Time:* ${new Date().toLocaleString()}\n`;
                                if (isGroup) {
                                    infoText += `📍 *Group:* ${groupName}\n`;
                                }

                                if (body) {
                                    infoText += `\n📝 *Message Content:* ${body}`;
                                } else {
                                    infoText += `\n📁 *Media / Attachment Below:*`;
                                }

                                const mentions = [];
                                if (originalPhone) mentions.push(originalSender);
                                if (isGroup && deleterJid !== originalSender && deleterPhone) mentions.push(deleterJid);

                                const botSelf = jidNormalizedUser(kaif_sock.user?.id || '');
                                const ownerJid = botSelf || (botCfg?.ownerJid || (botCfg?.ownerNumber ? botCfg.ownerNumber.replace(/\D/g, '') + '@s.whatsapp.net' : null));

                                if (ownerJid) {
                                    enqueueAntiDelete({
                                        kaif_sock,
                                        ownerJid,
                                        infoText,
                                        mentions,
                                        fullMsgData
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[ANTIDELETE] Recovery Error:', e.message);
                    }
                }
            }

            // 1. GLOBAL AUTO FORWARD LOGIC (FAST & DIRECT)
            try {
                if (!kaif_msg.key?.fromMe && kaif_origin !== 'status@broadcast') {
                    const globalCfg = await getCachedGlobalAutoForward(sessionId);
                    if (globalCfg?.enabled && globalCfg.targetJids?.length > 0) {
                        const msgId = kaif_msg.key?.id;

                        const isSourceMatched = (!globalCfg.sourceJids || globalCfg.sourceJids.length === 0) ||
                            globalCfg.sourceJids.some(s => {
                                if (!s) return false;
                                const cleanS = s.trim().toLowerCase();
                                const cleanO = kaif_origin.trim().toLowerCase();
                                if (cleanS === cleanO) return true;

                                if (kaif_sender && cleanS === kaif_sender.trim().toLowerCase()) return true;
                                if (realPhoneJid && cleanS === realPhoneJid.trim().toLowerCase()) return true;

                                const sDigits = cleanS.replace(/\D/g, '');
                                const oDigits = cleanO.replace(/\D/g, '');
                                if (sDigits && oDigits && sDigits === oDigits) return true;

                                const pDigits = (realPhoneJid || kaif_sender || '').replace(/\D/g, '');
                                if (sDigits && pDigits && sDigits === pDigits) return true;

                                return false;
                            });

                        if (isSourceMatched) {
                            const validTargets = (globalCfg.targetJids || []).map(t => sanitizeJid(t)).filter(Boolean);

                            if (validTargets.length > 0) {
                                if (msgId && processedAutoForwardMsgSet.has(msgId)) {
                                    // Already processed
                                } else {
                                    if (msgId) {
                                        processedAutoForwardMsgSet.add(msgId);
                                        if (processedAutoForwardMsgSet.size > 1000) {
                                            const firstVal = processedAutoForwardMsgSet.values().next().value;
                                            processedAutoForwardMsgSet.delete(firstVal);
                                        }
                                    }

                                    let relayMsg = processAndCleanMessage(
                                        kaif_msg.message,
                                        globalCfg?.oldTextRegex || null,
                                        globalCfg?.newText !== undefined ? globalCfg.newText : null
                                    );

                                    if (relayMsg?.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message;
                                    if (relayMsg?.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message;
                                    if (relayMsg?.viewOnceMessageV2Extension) relayMsg = relayMsg.viewOnceMessageV2Extension.message;
                                    if (relayMsg?.ephemeralMessage) relayMsg = relayMsg.ephemeralMessage.message;

                                    let shouldForward = true;
                                    if (relayMsg?.imageMessage && globalCfg.forwardPicture === false) shouldForward = false;
                                    else if (relayMsg?.videoMessage && globalCfg.forwardVideo === false) shouldForward = false;
                                    else if (relayMsg?.audioMessage && globalCfg.forwardAudio === false) shouldForward = false;
                                    else if (relayMsg?.documentMessage && globalCfg.forwardDocument === false) shouldForward = false;
                                    else if ((relayMsg?.conversation || relayMsg?.extendedTextMessage) && globalCfg.forwardText === false) shouldForward = false;

                                    if (shouldForward && relayMsg) {
                                        if (globalCfg.autoForwardTimestamp) {
                                            const timeStr = '\n\n_[' + new Date().toLocaleTimeString() + ']_';
                                            if (relayMsg.conversation) relayMsg.conversation += timeStr;
                                            else if (relayMsg.extendedTextMessage?.text) relayMsg.extendedTextMessage.text += timeStr;
                                            else if (relayMsg.imageMessage) relayMsg.imageMessage.caption = (relayMsg.imageMessage.caption || '') + timeStr;
                                            else if (relayMsg.videoMessage) relayMsg.videoMessage.caption = (relayMsg.videoMessage.caption || '') + timeStr;
                                            else if (relayMsg.documentMessage) relayMsg.documentMessage.caption = (relayMsg.documentMessage.caption || '') + timeStr;
                                        }

                                        enqueueAutoForward({
                                            kaif_sock,
                                            targetJids: [...new Set(validTargets)],
                                            relayMsg,
                                            kaif_origin,
                                            msgId
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('[GLOBAL-AUTO-FORWARD] Error:', err.message);
            }

            // 2. AUTO VIEW ONCE (RECOVER / ANTI-VV)
            try {
                const rawMsg = kaif_msg.message;
                let viewOnceContent = null;

                if (rawMsg?.viewOnceMessageV2) {
                    viewOnceContent = rawMsg.viewOnceMessageV2.message;
                } else if (rawMsg?.viewOnceMessage) {
                    viewOnceContent = rawMsg.viewOnceMessage.message;
                } else if (rawMsg?.viewOnceMessageV2Extension) {
                    viewOnceContent = rawMsg.viewOnceMessageV2Extension.message;
                } else {
                    if (rawMsg?.imageMessage?.viewOnce) viewOnceContent = { imageMessage: rawMsg.imageMessage };
                    else if (rawMsg?.videoMessage?.viewOnce) viewOnceContent = { videoMessage: rawMsg.videoMessage };
                    else if (rawMsg?.audioMessage?.viewOnce) viewOnceContent = { audioMessage: rawMsg.audioMessage };
                }

                if (viewOnceContent && !kaif_msg.key?.fromMe) {
                    const botConfig = await getCachedBotConfig(sessionId);
                    const autoVVEnabled = botConfig ? (botConfig.autoViewOnce !== false && botConfig.antiViewOnce !== false) : true;

                    if (autoVVEnabled) {
                        console.log('🔓 [AUTO-VV] ViewOnce Message Detected! Recovering...');
                        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

                        const actualMsg = viewOnceContent.imageMessage ||
                            viewOnceContent.videoMessage ||
                            viewOnceContent.audioMessage;

                        if (actualMsg) {
                            let type = '';
                            if (viewOnceContent.imageMessage) type = 'image';
                            else if (viewOnceContent.videoMessage) type = 'video';
                            else if (viewOnceContent.audioMessage) type = 'audio';

                            if (type) {
                                const stream = await downloadContentFromMessage(actualMsg, type);
                                let buffer = Buffer.from([]);
                                for await (const chunk of stream) {
                                    buffer = Buffer.concat([buffer, chunk]);
                                }

                                if (buffer.length > 0) {
                                    const destination = meJid || (botConfig?.ownerJid || (botConfig?.ownerNumber ? botConfig.ownerNumber.replace(/\D/g, '') + '@s.whatsapp.net' : null));
                                    if (destination) {
                                        await kaif_sock.sendMessage(destination, {
                                            [type]: buffer,
                                            caption: '🔓 *ViewOnce Recovered*\nfrom @' + (kaif_sender ? kaif_sender.split('@')[0] : '') + '\n> KAIF-MD-V3',
                                            contextInfo: { mentionedJid: kaif_sender ? [kaif_sender] : [] }
                                        }, { quoted: kaif_msg });
                                        console.log('✅ [AUTO-VV] ViewOnce recovered and sent to self/owner.');
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (vvErr) {
                console.error('[AUTO-VV] Recovery Error:', vvErr.message);
            }

            // 2.5 AUTO READ MESSAGES
            try {
                const botConfig = await getCachedBotConfig(sessionId);
                if (botConfig?.autoRead && !kaif_msg.key?.fromMe) {
                    await kaif_sock.readMessages([kaif_msg.key]);
                }
            } catch (arErr) {
                console.error('[AUTO-READ] Error:', arErr.message);
            }

            // 3. COMMAND HANDLER
            const prefix = '.'; 
            if (kaif_text.trim().startsWith(prefix)) {
                const kaif_parts = kaif_text.trim().slice(prefix.length).trim().split(/\s+/);
                const kaif_cmd_input = kaif_parts[0].toLowerCase();
                const kaif_args = kaif_parts.slice(1);

                if (kaif_plugins.has(kaif_cmd_input)) {
                    const plugin = kaif_plugins.get(kaif_cmd_input);
                    try {
                        const isGroup = kaif_origin.endsWith('@g.us');
                        let kaif_isAdmin = false;
                        if (isGroup) {
                            try {
                                const groupMetadata = await getCachedGroupMetadata(kaif_sock, kaif_origin);
                                const senderMod = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === kaif_sender);
                                kaif_isAdmin = (senderMod?.admin === 'admin' || senderMod?.admin === 'superadmin');
                            } catch (e) { }
                        }

                        const isOwner = kaif_msg.key.fromMe || isSuperOwner || allOwnerNumbers.some(num => num && cleanSender.includes(num));

                        console.log(`🤖 Executing command [.${kaif_cmd_input}] from ${kaif_sender} in ${kaif_origin}`);

                        await plugin.kaif_handler(kaif_sock, kaif_origin, {
                            kaif_sender,
                            kaif_msg,
                            kaif_args,
                            sessionId,
                            kaif_text,
                            kaif_isGroup: isGroup,
                            kaif_isAdmin,
                            kaif_isOwner: isOwner,
                            kaif_isSudo: isOwner,
                            kaif_isSuperOwner: isSuperOwner,
                            kaif_plugins
                        });
                    } catch (err) {
                        console.error(`Error in plugin ${kaif_cmd_input}:`, err.message);
                    }
                }
            }
        }
    });
}

// Reset session and advance to next pattern session ID
async function resetAndStartNewSession() {
    const oldSessionId = config.sessionId || 'kaif_session';

    if (sessions.has(oldSessionId)) {
        const existing = sessions.get(oldSessionId);
        if (existing && existing.sock) {
            try {
                existing.sock.ev.removeAllListeners('connection.update');
                existing.sock.end(undefined);
            } catch (e) {}
        }
        sessions.delete(oldSessionId);
    }

    try {
        await kaif_clearSession(oldSessionId);
    } catch (e) {
        console.error('Clear MongoDB session error:', e.message);
    }

    const sessionIdFile = path.join(__dirname, '.session_id');
    if (fs.existsSync(sessionIdFile)) {
        try { fs.unlinkSync(sessionIdFile); } catch (e) {}
    }

    delete require.cache[require.resolve('./kaif')];
    const freshConfig = require('./kaif');
    config.sessionId = freshConfig.sessionId;

    console.log(`🔄 Session Reset: Advancing to new session ID: ${config.sessionId}`);

    await startSession(config.sessionId);
    return config.sessionId;
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    // 1. Start Dashboard Server IMMEDIATELY
    kaif_app.listen(kaif_port, () => {
        console.log(`🌐 Dashboard running on port ${kaif_port}`);
    });

    // 2. Load Core Commands
    kaif_loadPlugins();

    // 3. Schedule Automatic 6-Hour Memory Refresh & Cleanup
    cleanTempFiles(false);
    pruneInMemoryStore();

    // Background job running every 6 hours
    setInterval(async () => {
        const activeSessionId = config.sessionId || 'kaif_session';
        cleanTempFiles(false);
        pruneInMemoryStore();
        const purgedCount = await kaif_purgeOldMessages(activeSessionId, 6);
        if (purgedCount > 0) {
            console.log(`🧹 6-Hour Auto-Refresh: Purged ${purgedCount} expired messages from MongoDB.`);
        }
    }, 6 * 60 * 60 * 1000);

    // 4. Initialize Bot in Background
    (async () => {
        try {
            // Connect Database
            if (config.mongoDbUrl) {
                const dbResult = await kaif_connectDatabase(config.mongoDbUrl);
                if (dbResult) console.log('✅ Database connected');
            }

            // Start default session
            const sessionId = config.sessionId || 'kaif_session';
            await startSession(sessionId);
        } catch (err) {
            console.error('❌ Initialization Error:', err);
        }
    })();
}

main();
