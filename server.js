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
    reactionCooldown: 10,
    singleVoteMode: true,
    pollDuration: 60,
    resultsDuration: 30
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
    host:'db',
    user:'root',
    password:'root',
    database:'live_rating'
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
        await axios.post(`${MASTER_URL}${endpoint}`,data);
        return true;
    }catch{
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

    const data=[];

    for(let i=0;i<playlist.length;i++){
        const [rows] = await db.promise().query(
            'SELECT AVG(rating) avg, COUNT(*) count FROM votes WHERE video_id=?',[i]
        );

        data.push({
            id:i,
            title:playlist[i].title,
            avg:Number(rows[0].avg)||0,
            count:rows[0].count||0
        });
    }

    res.json(data);
});

/* DISTRIBUTION */

app.get('/api/distribution/:id', async (req,res)=>{
    const [rows]=await db.promise().query(
        'SELECT rating, COUNT(*) count FROM votes WHERE video_id=? GROUP BY rating',
        [req.params.id]
    );

    const out={};
    rows.forEach(r=>out[r.rating]=r.count);
    res.json(out);
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

    // AWS RELAY MODE
    const remoteSocket = ioClient(MASTER_URL);

    io.on('connection', (socket) => {

        // Forward ALL events from local → AWS clients
        remoteSocket.onAny((event, ...args) => {
            socket.emit(event, ...args);
        });

        // Forward AWS → local
        socket.onAny((event, ...args) => {
            remoteSocket.emit(event, ...args);
        });

        socket.emit('aws_status', true);
    });

} else {

    // LOCAL MASTER MODE

    io.on('connection', (socket) => {

        connectedUsers++;
        io.emit('user_count', connectedUsers);

        socket.emit('video_changed', getCurrentVideoIndex());

        // 🔥 CRITICAL: SEND POLL STATE
        if (activePoll) {
            socket.emit('poll_started', activePoll);
        }

        socket.emit('settings_update', settings);

        socket.on('disconnect', () => {
            connectedUsers--;
            io.emit('user_count', connectedUsers);
        });

        socket.on('video_ended', nextVideo);

        socket.on('admin_control', (d) => {

            if (d.action === "next") nextVideo();
            if (d.action === "previous") previousVideo();
            if (d.action === "shuffle") toggleShuffle(d.enabled);

            if (d.action === "start_poll") {
                startPoll(d);
            }

            if (d.action === "set_reaction_cooldown") {

                settings.reactionCooldown = parseInt(d.value) || 0;

                // 🔥 forward to AWS
                if (MASTER_URL) {
                    axios.post(`${MASTER_URL}/api/settings`, {
                        reactionCooldown: settings.reactionCooldown
                    });
                }
            }

            if (d.action === "toggle_single_vote") {

                settings.singleVoteMode = d.enabled;

                if (MASTER_URL) {
                    axios.post(`${MASTER_URL}/api/settings`, {
                        singleVoteMode: settings.singleVoteMode
                    });
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

app.post('/api/settings', (req,res)=>{

    // merge new values
    settings = {
        ...settings,
        ...req.body
    };

    // broadcast to all clients
    io.emit('settings_update', settings);

    res.sendStatus(200);
});

/* =========================
   START
========================= */

server.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");
    fetchPublicIP(); // 🔥 important
});
