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
   ENV CONFIG
========================= */

const USE_REMOTE_MASTER = process.env.USE_REMOTE_MASTER === "true";
const MASTER_URL = process.env.MASTER_URL || "http://localhost:3000";

/* =========================
   OFFLINE QUEUE
========================= */

let offlineQueue = [];
let masterOnline = true;

async function sendToMaster(endpoint, data) {
    try {
        await axios.post(`${MASTER_URL}${endpoint}`, data);
        masterOnline = true;
        return true;
    } catch (err) {
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
   MYSQL
========================= */

const db = mysql.createPool({
    host: 'db',
    user: 'root',
    password: 'root',
    database: 'live_rating'
});

/* =========================
   UPDATE STATS (FIX)
========================= */

function updateStats(index) {
    db.query(
        'SELECT AVG(rating) as avg, COUNT(*) as count FROM votes WHERE video_id = ?',
        [index],
        (err, results) => {

            if (err) {
                console.error("Stats error:", err);
                return;
            }

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
   HELPER (PROXY HANDLER)
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

/* =========================
   VOTE
========================= */

app.post('/api/vote', (req, res) => {

    handleProxy('/api/vote', req, res, () => {

        const { rating } = req.body;
        const index = getCurrentVideoIndex();

        db.query(
            'INSERT INTO votes (video_id, rating) VALUES (?,?)',
            [index, rating],
            (err) => {
                if (err) {
                    console.error("Vote insert error:", err);
                    return res.sendStatus(500);
                }

                updateStats(index);
                res.sendStatus(200);
            }
        );
    });
});

/* =========================
   REACTIONS
========================= */

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

/* =========================
   POLL SYSTEM
========================= */

let activePoll = null;

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

app.get('/api/videos', async (req,res)=>{
    if (USE_REMOTE_MASTER) {
        const r = await axios.get(`${MASTER_URL}/api/videos`);
        return res.json(r.data);
    }
    res.json(playlist);
});

app.get('/api/current', async (req,res)=>{
    if (USE_REMOTE_MASTER) {
        const r = await axios.get(`${MASTER_URL}/api/current`);
        return res.json(r.data);
    }
    res.json({
        currentIndex:getCurrentVideoIndex(),
        currentVideo:playlist[getCurrentVideoIndex()]
    });
});

app.get('/api/leaderboard', async (req,res)=>{
    if (USE_REMOTE_MASTER) {
        const r = await axios.get(`${MASTER_URL}/api/leaderboard`);
        return res.json(r.data);
    }

    const data = [];

    for (let i = 0; i < playlist.length; i++) {
        const [rows] = await db.promise().query(
            'SELECT AVG(rating) as avg, COUNT(*) as count FROM votes WHERE video_id = ?',
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

/* =========================
   SOCKET HANDLING
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

        socket.on('video_ended', nextVideo);

        socket.on('admin_control', (data) => {
            if (data.action === "next") nextVideo();
            if (data.action === "previous") previousVideo();
            if (data.action === "shuffle") toggleShuffle(data.enabled);
        });
    });
}

/* =========================
   AWS STATUS BROADCAST
========================= */

setInterval(() => {
    io.emit('aws_status', masterOnline);
}, 3000);

/* =========================
   START
========================= */

server.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");
});
