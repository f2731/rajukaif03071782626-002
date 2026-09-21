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
const { cleanTempFiles } = require('./wasilib/cleaner');

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
        
// Load persistent config
try {
    if (fs.existsSync(path.join(__dirname, 'botConfig.json'))) {
        const savedConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'botConfig.json')));
        Object.assign(config, savedConfig);
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
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

/**
 * Clean forwarded label from message
 */
function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
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
        
        if (cleanedMessage.protocolMessage) {
            if (cleanedMessage.protocolMessage.type === 14 || 
                cleanedMessage.protocolMessage.type === 26) {
                if (cleanedMessage.protocolMessage.historySyncNotification) {
                    const syncData = cleanedMessage.protocolMessage.historySyncNotification;
                    if (syncData.pushName) {
                        console.log('Newsletter from:', syncData.pushName);
                    }
                }
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
    
    cleanedText = cleanedText.trim();
    return cleanedText;
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
        
        if (cleanedMessage.extendedTextMessage?.contextInfo?.participant) {
            const participant = cleanedMessage.extendedTextMessage.contextInfo.participant;
            if (participant.includes('newsletter') || participant.includes('broadcast')) {
                delete cleanedMessage.extendedTextMessage.contextInfo.participant;
                delete cleanedMessage.extendedTextMessage.contextInfo.stanzaId;
                delete cleanedMessage.extendedTextMessage.contextInfo.remoteJid;
            }
        }
        
        if (cleanedMessage.extendedTextMessage) {
            cleanedMessage.extendedTextMessage.contextInfo = cleanedMessage.extendedTextMessage.contextInfo || {};
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing message:', error);
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Raju-Autoforward-Bot is Working Fast (923071782626)" });
    console.log(`Ping command executed for ${from}`);
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
    console.log(`JID command executed for ${from}`);
}

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

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
    
    if (!text || !text.startsWith('!')) return;
    
            const command = text.trim();
        const lowerCommand = command.toLowerCase();

        try {
            if (lowerCommand === '!ping') {
                await handlePingCommand(sock, from);
            }
            else if (lowerCommand === '!jid') {
                await handleJidCommand(sock, from);
            }
            else if (lowerCommand === '!gjid') {
                await handleGjidCommand(sock, from);
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
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

// Universal JID Cleaner
const cleanJid = (id) => id ? id.split(':')[0].trim() : '';

wasi_sock.ev.on('messages.upsert', async wasi_m => {
    try {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg || !wasi_msg.message) return;

        const rawFrom = wasi_msg.key.remoteJid;
        const cleanFrom = cleanJid(rawFrom);
        const msgContent = wasi_msg.message;

        // Extract Text Properly
        const msgText = (
            msgContent.conversation || 
            msgContent.extendedTextMessage?.text || 
            msgContent.imageMessage?.caption || 
            msgContent.videoMessage?.caption || 
            ''
        ).trim();

        // 1. PING COMMAND
        if (msgText.toLowerCase() === '!ping') {
            await wasi_sock.sendMessage(rawFrom, { text: '⚡ Raju AutoForward Bot Online!' }, { quoted: wasi_msg });
            return;
        }

        // 2. JID COMMAND
        if (msgText.toLowerCase() === '!jid') {
            await wasi_sock.sendMessage(rawFrom, { text: `📍 JID: ${rawFrom}` }, { quoted: wasi_msg });
            return;
        }
        // 3. ALL GROUPS & COMMUNITIES JID LIST
        if (msgText.toLowerCase() === '!gjid') {
            try {
                const getGroups = await wasi_sock.groupFetchAllParticipating();
                const groups = Object.values(getGroups);

                if (groups.length === 0) {
                    await wasi_sock.sendMessage(rawFrom, { text: '❌ Koi group ya community nahi mili.' }, { quoted: wasi_msg });
                    return;
                }

                let txt = '📌 *Groups List:*\n\n';
                groups.forEach((g, i) => {
                    const isComm = g.isCommunity || g.isCommunityAnnounce ? 'Community' : 'Group';
                    txt += `${i + 1}. 📲 *${g.subject}*\n👥 Members: ${g.participants ? g.participants.length : 'N/A'}\n🆔 : \`${g.id}\`\n📝 Type: ${isComm}\n__________________\n\n`;
                });

                await wasi_sock.sendMessage(rawFrom, { text: txt }, { quoted: wasi_msg });
            } catch (err) {
                await wasi_sock.sendMessage(rawFrom, { text: `❌ Error: ${err.message}` }, { quoted: wasi_msg });
            }
            return;
        }
             
// 1. GLOBAL AUTO FORWARD LOGIC (FAST & DIRECT)
try {
    if (!wasi_msg.key.fromMe && rawFrom !== 'status@broadcast') {
        const sessionId = config.sessionId || 'wasi_session';
        const globalCfg = await getCachedGlobalAutoForward(sessionId);
        if (globalCfg?.enabled && globalCfg?.targetJids?.length > 0) {
            const msgId = wasi_msg.key.id;

            const isSourceWatched = (globalCfg.sourceJids || globalCfg.sourceJids.length === 0 || globalCfg.sourceJids.some(s => {
                if (!s) return false;
                const cleanS = s.trim().toLowerCase();
                const cleanD = rawFrom.trim().toLowerCase();
                if (cleanS === cleanD) return true;

                if (rawFrom && cleanS === rawFrom.trim().toLowerCase()) return true;

                const sDigits = cleanS.replace(/\D/g, '');
                const dDigits = cleanD.replace(/\D/g, '');
                if (sDigits && dDigits && sDigits === dDigits) return true;

                return false;
            }));

            if (isSourceWatched) {
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
                            wasi_msg.message,
                            globalCfg.oldTextRegex || null,
                            globalCfg.newText !== undefined ? globalCfg.newText : null
                        );

                        if (relayMsg?.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message;
                        else if (relayMsg?.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message;
                        else if (relayMsg?.viewOnceMessageV2Extension) relayMsg = relayMsg.viewOnceMessageV2Extension.message;
                        else if (relayMsg?.ephemeralMessage) relayMsg = relayMsg.ephemeralMessage.message;

                        let shouldForward = true;
                        if (relayMsg?.imageMessage && globalCfg.forwardPicture === false) shouldForward = false;
                        else if (relayMsg?.videoMessage && globalCfg.forwardVideo === false) shouldForward = false;
                        else if (relayMsg?.audioMessage && globalCfg.forwardAudio === false) shouldForward = false;
                        else if (relayMsg?.documentMessage && globalCfg.forwardDocument === false) shouldForward = false;
                        else if (!relayMsg?.conversation && !relayMsg?.extendedTextMessage && globalCfg.forwardText === false) shouldForward = false;

                        if (shouldForward && relayMsg) {
                            if (globalCfg.autoForwardTimestamp) {
                                const timeStr = '\n\n_[' + new Date().toLocaleTimeString() + ']_';
                                if (relayMsg.conversation) relayMsg.conversation += timeStr;
                                else if (relayMsg.extendedTextMessage?.text) relayMsg.extendedTextMessage.text += timeStr;
                                else if (relayMsg.imageMessage?.caption) relayMsg.imageMessage.caption += timeStr;
                                else if (relayMsg.videoMessage?.caption) relayMsg.videoMessage.caption += timeStr;
                                else if (relayMsg.documentMessage?.caption) relayMsg.documentMessage.caption += timeStr;
                            }

                            enqueueAutoForward({
                                kaif_sock: wasi_sock,
                                targetJids: [...new Set(validTargets)],
                                relayMsg,
                                kaif_origin: rawFrom,
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


// ============================================================
// 🚀 ALL APIS (ADD THESE TO YOUR INDEX.JS)
// ============================================================

// -----------------------------------------------------------------------------
// API: GET STATUS
// -----------------------------------------------------------------------------
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let dbConnected = false;

    // Check database connection
    if (config.mongoDbUrl) {
        try {
            // You can add your actual DB check here
            dbConnected = true; // Placeholder - replace with actual check
        } catch (e) {
            dbConnected = false;
        }
    }

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

// -----------------------------------------------------------------------------
// API: RESTART BOT
// -----------------------------------------------------------------------------
wasi_app.post('/api/restart', async (req, res) => {
    try {
        console.log('🔄 Restarting bot...');
        
        // Clear all sessions
        for (const [sessionId, session] of sessions) {
            if (session.sock) {
                try {
                    session.sock.end(undefined);
                } catch (e) {
                    console.error(`Error ending session ${sessionId}:`, e);
                }
            }
        }
        sessions.clear();
        
        // Restart the main function after a delay
        setTimeout(() => {
            main().catch(err => console.error('Restart error:', err));
        }, 1000);
        
        res.json({ success: true, message: 'Bot restarting...' });
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -----------------------------------------------------------------------------
// API: LOGOUT
// -----------------------------------------------------------------------------
wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (e) {
                console.error('Logout error:', e);
            }
            sessions.delete(sessionId);
            await wasi_clearSession(sessionId);
        }
        
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// -----------------------------------------------------------------------------
// API: GET SESSIONS LIST
// -----------------------------------------------------------------------------
wasi_app.get('/api/sessions', async (req, res) => {
    try {
        const sessionList = Array.from(sessions.keys()).map(id => ({
            sessionId: id,
            isConnected: sessions.get(id)?.isConnected || false
        }));
        
        res.json({
            success: true,
            sessions: sessionList,
            total: sessionList.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
}
// -----------------------------------------------------------------------------
// API: HEALTH CHECK
// -----------------------------------------------------------------------------
wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size
    });
});

// ============================================================
// END OF APIS
// ============================================================

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`✨ Message Cleaning: Forwarded labels removed, Newsletter markers cleaned`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid`);
        console.log(`\n📌 API Endpoints:`);
        console.log(`   GET  /api/status     - Get bot status`);
        console.log(`   POST /api/restart    - Restart bot`);
        console.log(`   POST /api/logout     - Logout bot`);
        console.log(`   GET  /api/sessions   - List all sessions`);
        console.log(`   GET  /api/health     - Health check`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    // 1. Connect DB if configured
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    // 2. Start default session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    // 3. Start server
    wasi_startServer();
}
// Auto memory check and clean restart
setInterval(() => {
    const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memoryUsage > 450) {
        console.log(`⚠️ High Memory Usage detected (${Math.round(memoryUsage)}MB). Restarting process...`);
        process.exit(0); // Heroku will automatically restart the dyno
    }
}, 5 * 60 * 1000);


main();
