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
   USER TRACKING (COOKIE)
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

/* =========================
   USER COUNT
========================= */

let connectedUsers = 0;

/* =========================
   DATABASE
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
   VIDEO SYSTEM (FIXED)
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
   POLL SYSTEM
========================= */

let activePoll = null;
let pollTimer = null;
let resultsTimer = null;

function startPoll(data) {

    if (pollTimer) clearTimeout(pollTimer);
    if (resultsTimer) clearTimeout(resultsTimer);

    activePoll = {
        question: data.question,
        options: data.options,
        counts: {},
        votingOpen: true
    };

    data.options.forEach((_, i) => {
        activePoll.counts[i] = 0;
    });

    io.emit('poll_started', activePoll);

    pollTimer = setTimeout(() => {

        activePoll.votingOpen = false;
        io.emit('poll_closed', activePoll);

        resultsTimer = setTimeout(() => {
            activePoll = null;
            io.emit('poll_cleared');
        }, (data.resultsDuration || 30) * 1000);

    }, (data.duration || 60) * 1000);
}

/* =========================
   AWS RELAY (QUEUE)
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

setInterval(async () => {
    if (!USE_REMOTE_MASTER) return;

    const remaining = [];

    for (const item of offlineQueue) {
        const ok = await sendToMaster(item.endpoint, item.data);
        if (!ok) remaining.push(item);
    }

    offlineQueue = remaining;
}, 5000);

/* =========================
   API
========================= */

function handleProxy(endpoint, req, res, localHandler) {
    if (!USE_REMOTE_MASTER) return localHandler();

    sendToMaster(endpoint, req.body)
        .catch(() => offlineQueue.push({ endpoint, data: req.body }));

    res.sendStatus(200);
}

/* VOTE */
app.post('/api/vote', (req, res) => {

    const userId = getUserId(req, res);

    handleProxy('/api/vote', req, res, () => {

        const { rating } = req.body;
        const index = getCurrentVideoIndex();

        if (singleVoteMode) {
            if (!userVotes[userId]) userVotes[userId] = {};

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

/* REACTION */
let totalReactions = 0;

app.post('/api/reaction', (req, res) => {

    const userId = getUserId(req, res);
    const now = Date.now();

    if (reactionCooldown > 0) {
        const last = reactionTimestamps[userId] || 0;
        if (now - last < reactionCooldown * 1000) {
            return res.status(429).send("Cooldown");
        }
        reactionTimestamps[userId] = now;
    }

    io.emit('new_reaction', req.body.emoji);
    totalReactions++;
    io.emit('reaction_update', totalReactions);

    res.sendStatus(200);
});

/* DISTRIBUTION */
app.get('/api/distribution/:id', async (req, res) => {

    const [rows] = await db.promise().query(
        'SELECT rating, COUNT(*) as count FROM votes WHERE video_id=? GROUP BY rating',
        [req.params.id]
    );

    const result = {};
    rows.forEach(r => result[r.rating] = r.count);

    res.json(result);
});

/* LEADERBOARD */
app.get('/api/leaderboard', async (req, res) => {

    const data = [];

    for (let i = 0; i < playlist.length; i++) {
        const [rows] = await db.promise().query(
            'SELECT AVG(rating) as avg, COUNT(*) as count FROM votes WHERE video_id=?',
            [i]
        );

        data.push({
            id: i,
            title: playlist[i].title,
            avg: Number(rows[0].avg) || 0,
            count: rows[0].count || 0
        });
    }

    res.json(data);
});

/* VIDEOS */
app.get('/api/videos', (req, res) => res.json(playlist));

/* CURRENT */
app.get('/api/current', (req, res) => {
    res.json({
        currentIndex: getCurrentVideoIndex(),
        currentVideo: playlist[getCurrentVideoIndex()]
    });
});

/* =========================
   SOCKET
========================= */

if (USE_REMOTE_MASTER) {

    const remote = ioClient(MASTER_URL);

    io.on('connection', (socket) => {

        socket.emit('aws_status', masterOnline);

        remote.onAny((e,...a)=>socket.emit(e,...a));
        socket.onAny((e,...a)=>remote.emit(e,...a));
    });

} else {

    io.on('connection', (socket) => {

        connectedUsers++;
        io.emit('user_count', connectedUsers);

        socket.emit('video_changed', getCurrentVideoIndex());

        socket.emit('settings_update', {
            reactionCooldown,
            singleVoteMode
        });

        if (activePoll) socket.emit('poll_started', activePoll);

        socket.on('disconnect', () => {
            connectedUsers--;
            io.emit('user_count', connectedUsers);
        });

        socket.on('video_ended', nextVideo);

        socket.on('admin_control', (data) => {

            if (data.action === "next") nextVideo();
            if (data.action === "previous") previousVideo();
            if (data.action === "shuffle") toggleShuffle(data.enabled);
            if (data.action === "start_poll") startPoll(data);

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
}

/* =========================
   START
========================= */

server.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");
});
