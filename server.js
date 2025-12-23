const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

// --- LOAD LIBRARY ---
let WebcastPushConnection;
try {
    // 1. Coba load dari node_modules (Cara Standar Railway/Hosting)
    WebcastPushConnection = require('tiktok-live-connector').WebcastPushConnection;
} catch (e) {
    try {
        // 2. Fallback: Coba load dari folder manual (Jika Anda upload folder library)
        // Sesuaikan path ini jika nama folder Anda berbeda!
        WebcastPushConnection = require('./TikTok-Live-Connector-1.2.3/src/index.js').WebcastPushConnection;
    } catch (e2) {
        console.error("[ERROR] Library TikTok-Live-Connector tidak ditemukan!");
        console.error("Solusi: Pastikan 'package.json' ada dan berisi dependency 'tiktok-live-connector'.");
        process.exit(1);
    }
}

const app = express();
const server = http.createServer(app);

// --- CONFIG CORS (PENTING UNTUK MENGHINDARI BLOKIR) ---
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Sajikan file statis (CSS/JS/Gambar)
app.use(express.static(__dirname));

// --- ROUTE UTAMA ---
app.get('/', (req, res) => {
    // PENTING: Pastikan nama file ini SAMA PERSIS dengan file HTML yang Anda upload.
    // Jika nama file Anda 'index.html', ganti 'kosong.html' menjadi 'index.html'
    const htmlFile = 'index.html'; 
    
    res.sendFile(path.join(__dirname, htmlFile), (err) => {
        if (err) {
            res.status(500).send(`Error: File ${htmlFile} tidak ditemukan di server! Pastikan file sudah ter-upload.`);
        }
    });
});

// --- KONFIGURASI FILTER ---
const BANNED_WORDS = [
    "BUNUH", "MATI", "NAJIS", "ANJING", "BABi", 
    "KONTOL", "MEMEK", "JEMBUT", "NGENTOT", "TOLOL", "BEGO",
    "GOBLOK", "SETAN", "IBLIS", "DADAH", "MAMPUS", "***"
];

const MAX_RAW_LENGTH = 50; // Naikkan sedikit agar command panjang terbaca

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

        // --- 1. HANDLING COMMAND (!myrank dll) ---
        // Jika chat dimulai dengan tanda seru '!', kirim langsung ke frontend
        // tanpa validasi kata 5 huruf.
        if (rawComment.startsWith('!')) {
             console.log(`[COMMAND] ${data.uniqueId}: ${rawComment}`);
             io.emit('new_guess', {
                uniqueId: data.uniqueId,
                nickname: data.nickname,
                word: rawComment, // Kirim command apa adanya
                picture: data.profilePictureUrl
            });
            return; // Stop proses tebakan, ini cuma command
        }

        // --- 2. HANDLING TEBAKAN GAME ---
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
                console.log(`[TEBAK] ${data.uniqueId} (${data.nickname}): ${finalGuess}`);
                io.emit('new_guess', {
                    uniqueId: data.uniqueId, // Gunakan ini sebagai ID unik
                    nickname: data.nickname, // Gunakan ini untuk display nama
                    word: finalGuess,
                    picture: data.profilePictureUrl
                });
            }
        }
    });

    tiktokLiveConnection.on('gift', data => {
        if (data.giftType === 1 && !data.repeatEnd) return;
        io.emit('gift_event', {
            uniqueId: data.uniqueId,
            nickname: data.nickname, // Kirim nickname gifter
            giftName: data.giftName,
            amount: data.repeatCount
        });
    });

    // --- EVENT LISTENER UNTUK LIKE ---
    tiktokLiveConnection.on('like', data => {
        io.emit('like', {
            uniqueId: data.uniqueId,
            nickname: data.nickname, // Kirim nickname yang like
            likeCount: data.likeCount, 
            totalLikeCount: data.totalLikeCount
        });
    });
    // ---------------------------------------------

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

// --- BAGIAN PALING PENTING UNTUK RAILWAY ---
// Railway akan memberikan port via process.env.PORT
// Jika variabel itu tidak ada, barulah kita pakai 3000 (untuk test di laptop sendiri)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`\n=== SERVER BERJALAN DI PORT ${PORT} ===`);
});