const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const mysql = require('mysql2');
const axios = require('axios');
const ioClient = require('socket.io-client');
const crypto = require('crypto');
const https = require('https');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));
app.use('/videos', express.static('videos'));

app.get('/api/health', (req,res)=>{
    res.send("OK");
});

/* =========================
   ENV
========================= */

const USE_REMOTE_MASTER = process.env.USE_REMOTE_MASTER === "true";
const MASTER_URL = process.env.MASTER_URL || "";
const RESET_DATA_ON_START = process.env.RESET_DATA_ON_START !== "false";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "password";

/* =========================
   USER ID
========================= */

function getUserId(req, res) {
    let uid = req.headers.cookie?.match(/uid=([^;]+)/)?.[1];
    if (!uid) {
        uid = crypto.randomUUID();
        res.setHeader('Set-Cookie', `uid=${uid}; Path=/; Max-Age=31536000`);
    }
    return uid;
}

/* =========================
   SETTINGS
========================= */

let settings = {
    reactionCooldown: 1,
    singleVoteMode: true,
    pollDuration: 40,
    resultsDuration: 20,
    theme: "dark",
    leaderboardMode: "top5"
};
let qrOverrideURL = "";
let qrSecondaryURL = "";
let publicIP = null;

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
)`, (err) => {

    if (err) {
        console.error("❌ Failed to create votes table:", err);
        return;
    }

    if (RESET_DATA_ON_START) {

        db.query('TRUNCATE TABLE votes', (err) => {

            if (err) {
                console.error("❌ Failed to reset vote data:", err);
            } else {
                console.log("🧹 Vote data reset on startup");
            }

        });

    } else {

        console.log("💾 Vote data preserved");
    }
});

/* =========================
   VIDEO SYSTEM (FIXED)
========================= */

let playlist = [];
let playOrder = [];
let currentPosition = 0;
let shuffleEnabled = true;

function shuffleArray(a){
    return a.sort(()=>Math.random()-0.5);
}

function loadPlaylist(){
    const files = fs.readdirSync('./videos')
        .filter(f=>f.endsWith('.mp4'));

    playlist = files.map((f,i)=>({
        id:i,
        title:f,
        file_path:`/videos/${f}`
    }));

    generatePlayOrder();
}

function generatePlayOrder(){
    const idx = playlist.map((_,i)=>i);
    playOrder = shuffleEnabled ? shuffleArray(idx) : idx;
    currentPosition = 0;
}

function getCurrentVideoIndex(){
    return playOrder[currentPosition] || 0;
}

function emitVideoChange(){
    totalReactions = 0;
    io.emit('reaction_update', totalReactions);
    io.emit('video_changed', getCurrentVideoIndex());
    io.emit('reset_stats');
}

function nextVideo(){
    currentPosition++;
    if(currentPosition >= playOrder.length) generatePlayOrder();
    emitVideoChange();
}

function previousVideo(){
    currentPosition--;
    if(currentPosition < 0) currentPosition = 0;
    emitVideoChange();
}

function toggleShuffle(enabled){
    shuffleEnabled = enabled;
    generatePlayOrder();
}

loadPlaylist();

/* =========================
   POLL SYSTEM (RESTORED)
========================= */

let activePoll = null;
let pollTimer = null;
let resultsTimer = null;

function startPoll(data){

    if(pollTimer) clearTimeout(pollTimer);
    if(resultsTimer) clearTimeout(resultsTimer);

    activePoll = {
        question:data.question,
        options:data.options,
        counts:{},
        votingOpen:true
    };

    data.options.forEach((_,i)=>{
        activePoll.counts[i]=0;
    });

    io.emit('poll_started', activePoll);

    pollTimer = setTimeout(()=>{
        activePoll.votingOpen = false;
        io.emit('poll_closed', activePoll);

        resultsTimer = setTimeout(()=>{
            activePoll = null;
            io.emit('poll_cleared');
        }, (data.resultsDuration||30)*1000);

    }, (data.duration||60)*1000);
}

/* =========================
   STATS
========================= */

function updateStats(index){
    db.query(
        'SELECT AVG(rating) avg, COUNT(*) count FROM votes WHERE video_id=?',
        [index],
        (err,res)=>{
            if(err) return;

            io.emit('vote_update',{
                video_id:index,
                avg:(Number(res[0].avg)||0).toFixed(2),
                count:res[0].count||0
            });

            io.emit('leaderboard_refresh');
        }
    );
}

/* =========================
   PROXY
========================= */

let offlineQueue = [];

async function sendToMaster(endpoint,data){
    try{
        console.log("➡️ Sending to AWS:", `${MASTER_URL}${endpoint}`, data);

        await axios.post(`${MASTER_URL}${endpoint}`,data);

        console.log("✅ Sent to AWS successfully");
        return true;
    }catch(err){
        console.log("❌ FAILED to send to AWS:", err.message);
        return false;
    }
}

function handleProxy(endpoint,req,res,localHandler){

    if(!USE_REMOTE_MASTER) return localHandler();

    const userId = req.body.userId || getUserId(req,res);

    sendToMaster(endpoint,{...req.body,userId})
        .catch(()=>offlineQueue.push({endpoint,data:{...req.body,userId}}));

    res.sendStatus(200);
}

/* =========================
   API ROUTES (FIXED)
========================= */

app.get('/api/videos',(req,res)=>res.json(playlist));

app.get('/api/current',(req,res)=>{
    res.json({
        currentIndex:getCurrentVideoIndex(),
        currentVideo:playlist[getCurrentVideoIndex()]
    });
});
app.get('/api/settings', (req,res)=>{
    res.json(settings);
});

/* =========================
   QR CODE URL (ADMIN CONTROLLED)
========================= */
function fetchPublicIP(){

    if (!USE_REMOTE_MASTER) return; // only AWS container

    https.get('https://api.ipify.org', (res) => {

        let data = '';

        res.on('data', chunk => data += chunk);

        res.on('end', () => {

            publicIP = data.trim();

            console.log("\n==============================");
            console.log(`🌐 Public URL: http://${publicIP}:3000/vote.html`);
            console.log("==============================\n");

        });

    }).on('error', (err) => {
        console.log("⚠️ Failed to fetch public IP:", err.message);
    });
}

app.get('/api/qr-url', (req,res)=>{
    res.json({ url: qrOverrideURL });
});

app.post('/api/qr-url', (req,res)=>{
    qrOverrideURL = req.body.url || "";
    io.emit('qr_updated', qrOverrideURL); // 🔥 live update
    res.sendStatus(200);
});

/* =========================
   SECOND QR CODE (WIFI / CUSTOM)
========================= */

app.get('/api/qr-secondary', (req,res)=>{
    res.json({ url: qrSecondaryURL });
});

app.post('/api/qr-secondary', (req,res)=>{
    qrSecondaryURL = req.body.url || "";
    io.emit('qr_secondary_updated', qrSecondaryURL);
    res.sendStatus(200);
});

/* LEADERBOARD */

app.get('/api/leaderboard', async (req,res)=>{

    // AWS server: get leaderboard from LOCAL MASTER
    if (USE_REMOTE_MASTER && MASTER_URL) {
        try {

            console.log("📊 Requesting leaderboard from MASTER:",
                `${MASTER_URL}/api/leaderboard`);

            const response = await axios.get(
                `${MASTER_URL}/api/leaderboard`,
                { timeout: 5000 }
            );

            return res.json(response.data);

        } catch (err) {

            console.error(
                "❌ Failed to get leaderboard from MASTER:",
                err.message
            );

            return res.status(503).json({
                error: "Master server unavailable",
                leaderboard: []
            });
        }
    }

    // LOCAL MASTER: read directly from local database
    try {

        const data=[];

        for(let i=0;i<playlist.length;i++){

            const [rows] = await db.promise().query(
                'SELECT AVG(rating) avg, COUNT(*) count FROM votes WHERE video_id=?',
                [i]
            );

            data.push({
                id:i,
                title:playlist[i].title,
                avg:Number(rows[0].avg)||0,
                count:rows[0].count||0
            });
        }

        res.json(data);

    } catch(err) {

        console.error("❌ Failed to build leaderboard:", err.message);

        res.status(500).json({
            error: "Failed to load leaderboard"
        });
    }
});

/* DISTRIBUTION */

app.get('/api/distribution/:id', async (req,res)=>{

    // AWS server: ask LOCAL MASTER
    if (USE_REMOTE_MASTER && MASTER_URL) {
        try {

            const response = await axios.get(
                `${MASTER_URL}/api/distribution/${req.params.id}`,
                { timeout: 5000 }
            );

            return res.json(response.data);

        } catch(err) {

            console.error(
                "❌ Failed to get distribution from MASTER:",
                err.message
            );

            return res.status(503).json({});
        }
    }

    // LOCAL MASTER
    try {

        const [rows] = await db.promise().query(
            'SELECT rating, COUNT(*) count FROM votes WHERE video_id=? GROUP BY rating',
            [req.params.id]
        );

        const out={};

        rows.forEach(r=>{
            out[r.rating]=r.count;
        });

        res.json(out);

    } catch(err) {

        console.error(
            "❌ Failed to get distribution:",
            err.message
        );

        res.status(500).json({});
    }
});

/* =========================
   VOTE + REACTION
========================= */

app.post('/api/vote',(req,res)=>{
    const userId = req.body.userId || getUserId(req,res);

    handleProxy('/api/vote',req,res,()=>{

        const index=getCurrentVideoIndex();
        const rating=req.body.rating;

        userVotes[userId]=userVotes[userId]||{};

        if(settings.singleVoteMode && userVotes[userId][index]){
            db.query(
                'UPDATE votes SET rating=? WHERE id=?',
                [rating,userVotes[userId][index]],
                ()=>{updateStats(index);res.sendStatus(200);}
            );
            return;
        }

        db.query(
            'INSERT INTO votes (video_id,rating) VALUES (?,?)',
            [index,rating],
            (e,r)=>{
                userVotes[userId][index]=r.insertId;
                updateStats(index);
                res.sendStatus(200);
            }
        );
    });
});

let totalReactions=0;

app.post('/api/reaction',(req,res)=>{
    const userId=req.body.userId||getUserId(req,res);

    const now=Date.now();
    if(settings.reactionCooldown>0){
        const last=reactionTimestamps[userId]||0;
        if(now-last<settings.reactionCooldown*1000)
            return res.status(429).send("Cooldown");
        reactionTimestamps[userId]=now;
    }

    handleProxy('/api/reaction',req,res,()=>{
        totalReactions++;
        io.emit('new_reaction',req.body.emoji);
        io.emit('reaction_update',totalReactions);
        res.sendStatus(200);
    });
});

/* POLL VOTE */

app.post('/api/poll_vote',(req,res)=>{
    handleProxy('/api/poll_vote',req,res,()=>{

        if(!activePoll || !activePoll.votingOpen)
            return res.status(403).send("Closed");

        const i=req.body.optionIndex;
        if(activePoll.counts[i]!==undefined)
            activePoll.counts[i]++;

        io.emit('poll_update',activePoll);
        res.sendStatus(200);
    });
});

/* =========================
   SOCKET (FULL FIX)
========================= */

if (USE_REMOTE_MASTER) {

    const remoteSocket = ioClient(MASTER_URL);

    io.on('connection', (socket) => {

        remoteSocket.onAny((event, ...args) => {
            socket.emit(event, ...args);
        });

        socket.emit('aws_status', true);
    });

} else {

    // LOCAL MASTER MODE

    io.on('connection', (socket) => {

        connectedUsers++;
        io.emit('user_count', connectedUsers);

        socket.emit('video_changed', getCurrentVideoIndex());

        if (activePoll) {
            socket.emit(
                activePoll.votingOpen
                    ? 'poll_started'
                    : 'poll_closed',
                activePoll
            );
        }

        socket.emit('settings_update', settings);

        socket.on('disconnect', () => {
            connectedUsers--;
            io.emit('user_count', connectedUsers);
        });

        socket.on('video_ended', nextVideo);

        socket.on('admin_control', (d) => {

            if (!d.auth || d.auth !== ADMIN_PASS) {
                console.log("❌ Unauthorized admin attempt");
                return;
            }
            
            if (d.action === "set_theme") {

                settings.theme = d.value;

                if (MASTER_URL) {
                    sendToMaster('/api/settings', settings);
                }
            }

            if (d.action === "next") nextVideo();
            if (d.action === "previous") previousVideo();
            if (d.action === "shuffle") toggleShuffle(d.enabled);

            if (d.action === "start_poll") {
                startPoll(d);
            }

            if (d.action === "set_reaction_cooldown") {

                settings.reactionCooldown = parseInt(d.value) || 0;

                if (MASTER_URL) {
                    sendToMaster('/api/settings', settings);
                }
            }

            if (d.action === "toggle_single_vote") {

                settings.singleVoteMode = d.enabled;

                if (MASTER_URL) {
                    sendToMaster('/api/settings', settings);
                }
            }
            
            if (d.action === "set_leaderboard_mode") {

                settings.leaderboardMode =
                    d.value === "full" ? "full" : "top5";

                if (MASTER_URL) {
                    sendToMaster('/api/settings', settings);
                }
            }

            io.emit('settings_update', settings);
        });
    });
}

/* =========================
   AWS STATUS (FIX)
========================= */

let awsOnline = false;

// Only check from LOCAL
if (!USE_REMOTE_MASTER && MASTER_URL) {

    setInterval(async () => {
        try {
            await axios.get(`${MASTER_URL}/api/health`);
            awsOnline = true;
        } catch {
            awsOnline = false;
        }

        io.emit('aws_status', awsOnline);
    }, 3000);
}

/* =========================
   SETTINGS SYNC (MASTER + AWS)
========================= */

app.post('/api/settings', (req, res) => {

    // Merge incoming settings
    settings = {
        ...settings,
        ...req.body
    };

    /*
     * =========================
     * AWS SETTINGS LOGGING
     * =========================
     */

    if (USE_REMOTE_MASTER) {

        if (req.body.reactionCooldown !== undefined) {
            console.log(
                `🔥 AWS RECEIVED REACTION COOLDOWN: ${req.body.reactionCooldown} seconds`
            );
        }

        if (req.body.singleVoteMode !== undefined) {
            console.log(
                `🔥 AWS RECEIVED SINGLE VOTE MODE: ${
                    req.body.singleVoteMode ? "ENABLED" : "DISABLED"
                }`
            );
        }

        if (req.body.theme !== undefined) {
            console.log(
                `🔥 AWS RECEIVED THEME: ${req.body.theme}`
            );
        }

        if (req.body.leaderboardMode !== undefined) {
            console.log(
                `🔥 AWS RECEIVED LEADERBOARD MODE: ${req.body.leaderboardMode}`
            );
        }

        // Also show the complete settings object
        console.log(
            "🔥 AWS SETTINGS NOW:",
            settings
        );
    }

    // Broadcast updated settings to connected clients
    io.emit('settings_update', settings);

    res.sendStatus(200);
});

/* =========================
   START
========================= */

server.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");
    console.log("RESET_DATA_ON_START:", RESET_DATA_ON_START);
    fetchPublicIP(); // 🔥 important
});
