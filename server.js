const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const mysql = require('mysql2');
const axios = require('axios');
const ioClient = require('socket.io-client');

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
const MASTER_URL = process.env.MASTER_URL || "http://localhost:3000";

/* =========================
   MYSQL
========================= */

const db = mysql.createPool({
    host: 'db',
    user: 'root',
    password: 'root',
    database: 'live_rating'
});

/* =========================
   DB INIT
========================= */

function initDatabase() {
    db.query(`
        CREATE TABLE IF NOT EXISTS votes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            video_id INT NOT NULL,
            rating INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

initDatabase();

/* =========================
   OFFLINE QUEUE (AWS)
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

async function flushQueue() {
    if (!USE_REMOTE_MASTER || offlineQueue.length === 0) return;

    const remaining = [];

    for (const item of offlineQueue) {
        const success = await sendToMaster(item.endpoint, item.data);
        if (!success) remaining.push(item);
    }

    offlineQueue = remaining;
}

setInterval(flushQueue, 5000);

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
        'SELECT AVG(rating) as avg, COUNT(*) as count FROM votes WHERE video_id = ?',
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
   POLL SYSTEM (FIXED)
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
   API
========================= */

function handleProxy(endpoint, req, res, localHandler) {

    if (!USE_REMOTE_MASTER) {
        return localHandler();
    }

    sendToMaster(endpoint, req.body).then(success => {
        if (!success) {
            offlineQueue.push({ endpoint, data: req.body });
        }
    });

    res.sendStatus(200);
}

/* VOTE */
app.post('/api/vote', (req, res) => {
    handleProxy('/api/vote', req, res, () => {

        const { rating } = req.body;
        const index = getCurrentVideoIndex();

        db.query(
            'INSERT INTO votes (video_id, rating) VALUES (?,?)',
            [index, rating],
            (err) => {
                if (err) return res.sendStatus(500);
                updateStats(index);
                res.sendStatus(200);
            }
        );
    });
});

/* REACTIONS */
let totalReactions = 0;

app.post('/api/reaction', (req, res) => {

    if (USE_REMOTE_MASTER) {
        sendToMaster('/api/reaction', req.body)
            .catch(() => offlineQueue.push({ endpoint:'/api/reaction', data:req.body }));
        return res.sendStatus(200);
    }

    totalReactions++;
    io.emit('new_reaction', req.body.emoji);
    io.emit('reaction_update', totalReactions);

    res.sendStatus(200);
});

/* POLL VOTE */
app.post('/api/poll_vote', (req, res) => {

    handleProxy('/api/poll_vote', req, res, () => {

        if (!activePoll || !activePoll.votingOpen) {
            return res.status(403).send("Closed");
        }

        const { optionIndex } = req.body;

        if (activePoll.counts[optionIndex] !== undefined) {
            activePoll.counts[optionIndex]++;
        }

        io.emit('poll_update', activePoll);
        res.sendStatus(200);
    });
});

/* =========================
   READ ROUTES
========================= */

app.get('/api/videos', (req,res)=> res.json(playlist));

app.get('/api/current', (req,res)=>{
    res.json({
        currentIndex:getCurrentVideoIndex(),
        currentVideo:playlist[getCurrentVideoIndex()]
    });
});

/* =========================
   LEADERBOARD (FIXED)
========================= */

app.get('/api/leaderboard', async (req, res) => {

    if (USE_REMOTE_MASTER) {
        try {
            const r = await axios.get(`${MASTER_URL}/api/leaderboard`);
            return res.json(r.data);
        } catch {
            return res.json([]);
        }
    }

    try {
        const data = [];

        for (let i = 0; i < playlist.length; i++) {

            const [rows] = await db.promise().query(
                'SELECT AVG(rating) as avg, COUNT(*) as count FROM votes WHERE video_id = ?',
                [i]
            );

            data.push({
                id: i,
                title: playlist[i]?.title || "Unknown",
                avg: Number(rows[0].avg) || 0,
                count: rows[0].count || 0
            });
        }

        res.json(data);

    } catch (err) {
        console.error("Leaderboard error:", err);
        res.json([]);
    }
});

/* =========================
   DISTRIBUTION (FIXED)
========================= */

app.get('/api/distribution/:id', async (req, res) => {

    const videoId = parseInt(req.params.id);

    if (USE_REMOTE_MASTER) {
        try {
            const r = await axios.get(`${MASTER_URL}/api/distribution/${videoId}`);
            return res.json(r.data);
        } catch {
            return res.json({});
        }
    }

    try {
        const [rows] = await db.promise().query(
            'SELECT rating, COUNT(*) as count FROM votes WHERE video_id = ? GROUP BY rating',
            [videoId]
        );

        const result = {};

        rows.forEach(r => {
            result[r.rating] = r.count;
        });

        res.json(result);

    } catch (err) {
        console.error("Distribution error:", err);
        res.json({});
    }
});

/* =========================
   SOCKET
========================= */

if (USE_REMOTE_MASTER) {

    const remoteSocket = ioClient(MASTER_URL);

    io.on('connection', (socket) => {

        socket.emit('aws_status', masterOnline);

        remoteSocket.onAny((event, ...args) => {
            socket.emit(event, ...args);
        });

        socket.onAny((event, ...args) => {
            remoteSocket.emit(event, ...args);
        });
    });

} else {

    io.on('connection', (socket) => {

        socket.emit('video_changed', getCurrentVideoIndex());

        /* 🔥 IMPORTANT FIX */
        if (activePoll) {
            socket.emit('poll_started', activePoll);
        }

        socket.on('video_ended', nextVideo);

        socket.on('admin_control', (data) => {

            if (data.action === "next") nextVideo();
            if (data.action === "previous") previousVideo();
            if (data.action === "shuffle") toggleShuffle(data.enabled);

            /* 🔥 POLL FIX */
            if (data.action === "start_poll") {
                startPoll(data);
            }
        });
    });
}

/* =========================
   AWS STATUS
========================= */

setInterval(() => {
    io.emit('aws_status', masterOnline);
}, 3000);

/* =========================
   START
========================= */
const https = require('https');

function logPublicIP() {

    if (!USE_REMOTE_MASTER) return; // only for AWS mode

    https.get('https://api.ipify.org', (res) => {

        let data = '';

        res.on('data', chunk => data += chunk);

        res.on('end', () => {
            console.log("\n==============================");
            console.log(`🌐 Public URL: http://${data}:3000/vote.html`);
            console.log("==============================\n");
        });

    }).on('error', () => {
        console.log("Could not fetch public IP");
    });
}
server.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");

    logPublicIP(); // 🔥 ADD THIS
});
