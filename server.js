const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

// --- LOAD LIBRARY ---
let WebcastPushConnection;
try {
    // Coba load dari node_modules dulu (Standard Railway/NPM)
    WebcastPushConnection = require('tiktok-live-connector').WebcastPushConnection;
} catch (e) {
    try {
        // Fallback ke folder lokal jika user upload folder manual
        WebcastPushConnection = require('./TikTok-Live-Connector-1.2.3/src/index.js').WebcastPushConnection;
    } catch (e2) {
        console.error("[ERROR] Gagal load library TikTok-Live-Connector.");
        process.exit(1);
    }
}

const app = express();
const server = http.createServer(app);

// --- CONFIG CORS (PENTING UNTUK RAILWAY/HOSTING) ---
const io = new Server(server, {
    cors: {
        origin: "*", // Izinkan koneksi dari mana saja (Frontend)
        methods: ["GET", "POST"]
    }
});

// Sajikan file statis (CSS/JS/Gambar jika ada dalam satu folder)
app.use(express.static(__dirname));

// --- ROUTE UTAMA: BUKA GAME SAAT URL DIAKSES ---
app.get('/', (req, res) => {
    // Pastikan nama file sesuai dengan file HTML Anda (kosong.html atau index.html)
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- KONFIGURASI FILTER ---
const BANNED_WORDS = [
    "BUNUH", "MATI", "NAJIS", "ANJING", "BABi", 
    "KONTOL", "MEMEK", "JEMBUT", "NGENTOT", "TOLOL", "BEGO",
    "GOBLOK", "SETAN", "IBLIS", "DADAH", "MAMPUS", "***"
];

const MAX_RAW_LENGTH = 20; 

// --- STATE ---
let tiktokLiveConnection = null;
let activeTargetUser = null;

function disconnectCurrent() {
    if (tiktokLiveConnection) {
        try { tiktokLiveConnection.disconnect(); } catch (e) {}
        tiktokLiveConnection = null;
    }
}

function connectToTikTok(username) {
    if (activeTargetUser !== username) disconnectCurrent();
    activeTargetUser = username;
    
    if (tiktokLiveConnection) disconnectCurrent();

    console.log(`[SERVER] Menghubungkan ke @${username}...`);
    io.emit('status', { type: 'warning', msg: `Connecting to @${username}...` });

    tiktokLiveConnection = new WebcastPushConnection(username);

    tiktokLiveConnection.connect().then(state => {
        console.info(`[TIKTOK] TERHUBUNG! Room ID: ${state.roomId}`);
        io.emit('status', { type: 'success', msg: `LIVE: @${username}` });
    }).catch(err => {
        console.error('[TIKTOK] Gagal connect:', err.message);
        handleReconnect(username, "Gagal Konek (Retrying...)");
    });

    tiktokLiveConnection.on('chat', data => {
        const rawComment = data.comment.trim().toUpperCase();

        if (rawComment.length > MAX_RAW_LENGTH) return;
        if (rawComment.length < 3) return;
        
        let finalGuess = null;
        const isValidWord = (word) => {
            return word.length >= 4 && word.length <= 8 && /^[A-Z]+$/.test(word);
        };

        const noSpaceComment = rawComment.replace(/\s+/g, ''); 
        
        if (isValidWord(noSpaceComment)) {
            finalGuess = noSpaceComment;
        } 
        
        if (!finalGuess) {
            const words = rawComment.split(/[\s.,!?]+/); 
            for (let i = words.length - 1; i >= 0; i--) {
                if (isValidWord(words[i])) {
                    finalGuess = words[i];
                    break; 
                }
            }
        }

        if (finalGuess) {
            const isBanned = BANNED_WORDS.some(badWord => finalGuess.includes(badWord));

            if (!isBanned) {
                console.log(`[TEBAK] ${data.uniqueId}: ${finalGuess}`);
                io.emit('new_guess', {
                    username: data.uniqueId,
                    word: finalGuess,
                    picture: data.profilePictureUrl
                });
            }
        }
    });

    tiktokLiveConnection.on('gift', data => {
        if (data.giftType === 1 && !data.repeatEnd) return;
        io.emit('gift_event', {
            username: data.uniqueId,
            giftName: data.giftName,
            amount: data.repeatCount
        });
    });

    tiktokLiveConnection.on('disconnected', () => {
        handleReconnect(username, "Terputus (Reconnecting...)");
    });
}

function handleReconnect(username, msg) {
    if (activeTargetUser === username) {
        io.emit('status', { type: 'error', msg: msg });
        disconnectCurrent();
        setTimeout(() => {
            if (activeTargetUser === username) connectToTikTok(username);
        }, 5000);
    }
}

io.on('connection', (socket) => {
    console.log('Frontend Connected:', socket.id);
    if (activeTargetUser) socket.emit('status', { type: 'warning', msg: `Reconnecting: @${activeTargetUser}` });
    socket.on('change_username', (username) => {
        activeTargetUser = null;
        connectToTikTok(username);
    });
});

// --- PENTING UNTUK RAILWAY: GUNAKAN PROCESS.ENV.PORT ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n=== SERVER RUNNING ON PORT ${PORT} ===`);
});