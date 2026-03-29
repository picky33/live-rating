const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const mysql = require('mysql2');
const axios = require('axios');
const ioClient = require('socket.io-client');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));
app.use('/videos', express.static('videos'));

/* =========================
   ENV
========================= */

const USE_REMOTE_MASTER = process.env.USE_REMOTE_MASTER === "true";
const MASTER_URL = process.env.MASTER_URL || "";

/* =========================
   AWS HANDSHAKE
========================= */

let awsConnected = false;

async function checkAWSConnection() {
    if (USE_REMOTE_MASTER) return;

    if (!MASTER_URL) {
        awsConnected = false;
        return;
    }

    try {
        await axios.get(`${MASTER_URL}/api/health`);
        awsConnected = true;
    } catch {
        awsConnected = false;
    }
}

setInterval(checkAWSConnection, 3000);

/* =========================
   PUBLIC URL (SMART QR)
========================= */

let publicURL = null;

async function initPublicURL() {

    if (USE_REMOTE_MASTER) {
        try {
            const res = await axios.get('https://api.ipify.org');
            publicURL = `http://${res.data}:3000`;
            console.log(`🌐 Public Vote URL: ${publicURL}/vote.html`);
        } catch {}
    }
}

initPublicURL();

app.get('/api/public-url', (req,res)=>{

    // LOCAL → only show AWS URL if connected
    if (!USE_REMOTE_MASTER) {
        if (awsConnected && MASTER_URL) {
            return res.json({ url: MASTER_URL });
        }
        return res.json({ url: null });
    }

    // AWS → always return its own public URL
    res.json({ url: publicURL });
});

/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health', (req,res)=>{
    res.send("OK");
});

/* =========================
   USER TRACKING
========================= */

function getUserId(req, res) {
    let userId = req.headers.cookie?.match(/uid=([^;]+)/)?.[1];

    if (!userId) {
        userId = crypto.randomUUID();
        res.setHeader('Set-Cookie', `uid=${userId}; Path=/; Max-Age=31536000`);
    }

    return userId;
}

/* =========================
   SETTINGS
========================= */

let reactionCooldown = 10;
let singleVoteMode = true;

/* =========================
   TRACKING
========================= */

const reactionTimestamps = {};
const userVotes = {};
let connectedUsers = 0;

/* =========================
   DB
========================= */

const db = mysql.createPool({
    host: 'db',
    user: 'root',
    password: 'root',
    database: 'live_rating'
});

db.query(`
CREATE TABLE IF NOT EXISTS votes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    video_id INT,
    rating INT
)`);

/* =========================
   VIDEO SYSTEM
========================= */

let playlist = [];
let playOrder = [];
let currentPosition = 0;
let shuffleEnabled = true;

function shuffleArray(array) {
    return array.sort(() => Math.random() - 0.5);
}

function loadPlaylist() {
    const files = fs.readdirSync('./videos')
        .filter(f => f.endsWith('.mp4'));

    playlist = files.map((file, index) => ({
        id: index,
        title: file,
        file_path: `/videos/${file}`
    }));

    generatePlayOrder();
}

function generatePlayOrder() {
    const indices = playlist.map((_, i) => i);
    playOrder = shuffleEnabled ? shuffleArray(indices) : indices;
    currentPosition = 0;
}

function getCurrentVideoIndex() {
    return playOrder[currentPosition] || 0;
}

function emitVideoChange() {
    totalReactions = 0;
    io.emit('reaction_update', totalReactions);
    io.emit('video_changed', getCurrentVideoIndex());
    io.emit('reset_stats');
}

function nextVideo() {
    currentPosition++;
    if (currentPosition >= playOrder.length) generatePlayOrder();
    emitVideoChange();
}

function previousVideo() {
    currentPosition--;
    if (currentPosition < 0) currentPosition = 0;
    emitVideoChange();
}

function toggleShuffle(enabled) {
    shuffleEnabled = enabled;
    generatePlayOrder();
}

loadPlaylist();

/* =========================
   STATS
========================= */

function updateStats(index) {
    db.query(
        'SELECT AVG(rating) as avg, COUNT(*) as count FROM votes WHERE video_id=?',
        [index],
        (err, results) => {
            if (err) return;

            const avg = Number(results[0].avg) || 0;
            const count = results[0].count || 0;

            io.emit('vote_update', {
                video_id: index,
                avg: avg.toFixed(2),
                count
            });

            io.emit('leaderboard_refresh');
        }
    );
}

/* =========================
   PROXY
========================= */

let offlineQueue = [];
let masterOnline = true;

async function sendToMaster(endpoint, data) {
    try {
        await axios.post(`${MASTER_URL}${endpoint}`, data);
        masterOnline = true;
        return true;
    } catch {
        masterOnline = false;
        return false;
    }
}

function handleProxy(endpoint, req, res, localHandler) {

    if (!USE_REMOTE_MASTER) return localHandler();

    const userId = req.body.userId || getUserId(req, res);

    sendToMaster(endpoint, { ...req.body, userId })
        .catch(() => offlineQueue.push({ endpoint, data:{...req.body,userId} }));

    res.sendStatus(200);
}

/* =========================
   VOTE
========================= */

app.post('/api/vote', (req, res) => {

    const userId = req.body.userId || getUserId(req, res);

    handleProxy('/api/vote', req, res, () => {

        const { rating } = req.body;
        const index = getCurrentVideoIndex();

        if (singleVoteMode) {
            userVotes[userId] = userVotes[userId] || {};

            const existing = userVotes[userId][index];

            if (existing) {
                db.query(
                    'UPDATE votes SET rating=? WHERE id=?',
                    [rating, existing],
                    () => {
                        updateStats(index);
                        res.sendStatus(200);
                    }
                );
                return;
            }
        }

        db.query(
            'INSERT INTO votes (video_id, rating) VALUES (?,?)',
            [index, rating],
            (err, result) => {

                if (singleVoteMode) {
                    userVotes[userId] = userVotes[userId] || {};
                    userVotes[userId][index] = result.insertId;
                }

                updateStats(index);
                res.sendStatus(200);
            }
        );
    });
});

/* =========================
   REACTIONS (FIXED)
========================= */

let totalReactions = 0;

app.post('/api/reaction', (req, res) => {

    const userId = req.body.userId || getUserId(req, res);
    const now = Date.now();

    if (reactionCooldown > 0) {
        const last = reactionTimestamps[userId] || 0;

        if (now - last < reactionCooldown * 1000) {
            return res.status(429).send("Cooldown");
        }

        reactionTimestamps[userId] = now;
    }

    handleProxy('/api/reaction', req, res, () => {

        totalReactions++;
        io.emit('new_reaction', req.body.emoji);
        io.emit('reaction_update', totalReactions);

        res.sendStatus(200);
    });
});

/* =========================
   SOCKET
========================= */

io.on('connection', (socket) => {

    connectedUsers++;
    io.emit('user_count', connectedUsers);

    socket.emit('video_changed', getCurrentVideoIndex());

    socket.emit('settings_update', {
        reactionCooldown,
        singleVoteMode
    });

    socket.on('video_ended', nextVideo);

    socket.on('disconnect', () => {
        connectedUsers--;
        io.emit('user_count', connectedUsers);
    });

    socket.on('admin_control', (data) => {

        if (data.action === "next") nextVideo();
        if (data.action === "previous") previousVideo();
        if (data.action === "shuffle") toggleShuffle(data.enabled);

        if (data.action === "set_reaction_cooldown") {
            reactionCooldown = parseInt(data.value) || 0;
        }

        if (data.action === "toggle_single_vote") {
            singleVoteMode = data.enabled;
        }

        io.emit('settings_update', {
            reactionCooldown,
            singleVoteMode
        });
    });
});

/* =========================
   AWS STATUS BROADCAST
========================= */

setInterval(() => {
    io.emit('aws_status', awsConnected || masterOnline);
}, 2000);

/* =========================
   START
========================= */

server.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");
});
