/**
 * GEOVS — server v3
 * - Same pattern for both players
 * - Round waits for BOTH to answer (or timeout)
 * - First correct answer gets speed bonus; second correct gets smaller bonus
 * - 2.5s between rounds
 */
const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const httpServer = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "client.html"), (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server: httpServer });

// ── 5 levels ────────────────────────────────────────────────────────────────
const LEVELS = [
  { name:"EASY",      rounds:5, timePerRound:15000, patternSize:2, basePoints:100, speedBonus:200 },
  { name:"MEDIUM",    rounds:5, timePerRound:12000, patternSize:3, basePoints:150, speedBonus:250 },
  { name:"HARD",      rounds:5, timePerRound:9000,  patternSize:4, basePoints:200, speedBonus:350 },
  { name:"EXPERT",    rounds:5, timePerRound:6000,  patternSize:5, basePoints:300, speedBonus:500 },
  { name:"LEGENDARY", rounds:5, timePerRound:4000,  patternSize:6, basePoints:500, speedBonus:800 },
];

const SHAPES    = ["square","triangle","circle","diamond","cross","hexagon"];
const COLORS    = ["#FF2D55","#00F5C8","#FFD60A","#0A84FF","#FF9F0A","#BF5AF2","#30D158","#FF6B6B"];
const ROTATIONS = [0, 45, 90, 135, 180];

function seededRand(seed) {
  let s = seed; return () => { s=(s*16807)%2147483647; return (s-1)/2147483646; };
}

// SAME pattern for both players — no playerIndex salt
function generatePattern(size, roundSeed) {
  const rand = seededRand(roundSeed);
  const seq  = [];
  for (let i = 0; i < size + 1; i++) {
    seq.push({
      shape:    SHAPES   [Math.floor(rand() * SHAPES.length)],
      color:    COLORS   [Math.floor(rand() * COLORS.length)],
      rotation: ROTATIONS[Math.floor(rand() * ROTATIONS.length)],
      scale:    0.6 + rand() * 0.4,
    });
  }
  const answer  = seq[seq.length - 1];
  const choices = [{ ...answer }];
  let att = 0;
  while (choices.length < 4 && att++ < 200) {
    const d = {
      shape:    SHAPES   [Math.floor(rand() * SHAPES.length)],
      color:    COLORS   [Math.floor(rand() * COLORS.length)],
      rotation: ROTATIONS[Math.floor(rand() * ROTATIONS.length)],
      scale:    0.6 + rand() * 0.4,
    };
    if (d.shape !== answer.shape || d.color !== answer.color) choices.push(d);
  }
  for (let i = choices.length-1; i > 0; i--) {
    const j = Math.floor(rand()*(i+1));
    [choices[i],choices[j]] = [choices[j],choices[i]];
  }
  return {
    sequence: seq.slice(0, size), answer, choices,
    correctIndex: choices.findIndex(c =>
      c.shape===answer.shape && c.color===answer.color && c.rotation===answer.rotation
    ),
  };
}

const lobbies = new Map();
const makeLobbyId = () => Math.random().toString(36).slice(2,7).toUpperCase();

function createLobby(id) {
  return {
    id, players: [], level: 0,
    roundSeeds: [], phase: "waiting",
    currentRound: 0,
    roundAnswers: [],   // [{playerIndex, correct, timeTaken}]
    roundTimer: null,
    betweenTimer: null,
  };
}

function broadcast(lobby, msg) {
  const d = JSON.stringify(msg);
  lobby.players.forEach(p => { if (p.ws.readyState===1) p.ws.send(d); });
}
function sendTo(ws, msg) { if (ws.readyState===1) ws.send(JSON.stringify(msg)); }

// ── Start a level ────────────────────────────────────────────────────────────
function startLevel(lobby) {
  const cfg = LEVELS[lobby.level];
  lobby.roundSeeds = Array.from({length: cfg.rounds}, () => Math.floor(Math.random()*1e9));
  lobby.players.forEach(p => { p.roundScores=[]; p.streak=0; });
  lobby.currentRound = 0;
  lobby.phase = "countdown";

  broadcast(lobby, {
    type:"countdown", seconds:3,
    level: lobby.level, levelName: cfg.name,
    seeds: lobby.roundSeeds,   // send ALL seeds to client upfront
    config: cfg,
    players: lobby.players.map((p,i) => ({name:p.name, score:p.score, playerIndex:i})),
  });

  setTimeout(() => startRound(lobby, 0), 3300);
}

// ── Start a round ────────────────────────────────────────────────────────────
function startRound(lobby, roundIndex) {
  const cfg = LEVELS[lobby.level];
  lobby.phase = "playing";
  lobby.currentRound = roundIndex;
  lobby.roundAnswers = [];   // reset answers for this round

  broadcast(lobby, {
    type: "roundStart",
    roundIndex,
    totalRounds: cfg.rounds,
    timeLimit: cfg.timePerRound,
    seed: lobby.roundSeeds[roundIndex],  // same seed → same pattern for both
  });

  // Auto-timeout if not everyone answers in time
  if (lobby.roundTimer) clearTimeout(lobby.roundTimer);
  lobby.roundTimer = setTimeout(() => {
    // Force-submit anyone who hasn't answered
    lobby.players.forEach((p, i) => {
      const already = lobby.roundAnswers.find(a => a.playerIndex === i);
      if (!already) {
        lobby.roundAnswers.push({ playerIndex: i, choiceIndex: -1, timeTaken: cfg.timePerRound, correct: false, timedOut: true });
      }
    });
    resolveRound(lobby);
  }, cfg.timePerRound + 500);
}

// ── Called when a player submits an answer ───────────────────────────────────
function submitAnswer(lobby, playerIndex, choiceIndex, timeTaken) {
  const cfg     = LEVELS[lobby.level];
  const seed    = lobby.roundSeeds[lobby.currentRound];
  const pattern = generatePattern(cfg.patternSize, seed);
  const correct = pattern.correctIndex === choiceIndex;

  // Ignore duplicate answers
  if (lobby.roundAnswers.find(a => a.playerIndex === playerIndex)) return;

  lobby.roundAnswers.push({ playerIndex, choiceIndex, timeTaken, correct });

  // Tell this player immediately that their answer was received
  sendTo(lobby.players[playerIndex].ws, {
    type: "answerAck",
    correct,
    correctIndex: pattern.correctIndex,
    roundIndex: lobby.currentRound,
  });

  // If both players have answered → resolve now
  if (lobby.roundAnswers.length >= lobby.players.length) {
    if (lobby.roundTimer) clearTimeout(lobby.roundTimer);
    resolveRound(lobby);
  }
}

// ── Resolve round — score everyone, send results, schedule next round ────────
function resolveRound(lobby) {
  const cfg       = LEVELS[lobby.level];
  const roundIndex = lobby.currentRound;
  const seed      = lobby.roundSeeds[roundIndex];
  const pattern   = generatePattern(cfg.patternSize, seed);

  // Sort correct answers by time (fastest first)
  const correctAnswers = lobby.roundAnswers
    .filter(a => a.correct)
    .sort((a, b) => a.timeTaken - b.timeTaken);

  const results = lobby.players.map((p, i) => {
    const ans     = lobby.roundAnswers.find(a => a.playerIndex === i) || { correct:false, timeTaken:cfg.timePerRound, timedOut:true };
    let points    = 0;
    let breakdown = null;

    if (ans.correct) {
      const position    = correctAnswers.findIndex(a => a.playerIndex === i); // 0=first, 1=second
      const timeRatio   = Math.max(0, 1 - ans.timeTaken / cfg.timePerRound);
      const speedPts    = Math.ceil(timeRatio * cfg.speedBonus);
      const positionMult= position === 0 ? 1.0 : 0.6;  // first correct = full, second = 60%
      p.streak          = (p.streak||0) + 1;
      const streakBonus = Math.min(p.streak - 1, 4) * 50;
      points = Math.ceil((cfg.basePoints + speedPts) * positionMult) + streakBonus;
      breakdown = {
        base: Math.ceil(cfg.basePoints * positionMult),
        speed: Math.ceil(speedPts * positionMult),
        streak: streakBonus,
        firstBonus: position === 0,
      };
    } else {
      p.streak = 0;
    }

    p.score += points;
    p.roundScores.push(points);

    return {
      playerIndex: i,
      name: p.name,
      correct: ans.correct,
      timedOut: ans.timedOut || false,
      choiceIndex: ans.choiceIndex,
      points,
      score: p.score,
      streak: p.streak,
      breakdown,
    };
  });

  lobby.phase = "roundEnd";

  broadcast(lobby, {
    type: "roundEnd",
    roundIndex,
    correctIndex: pattern.correctIndex,
    results,
    players: lobby.players.map(p => ({name:p.name, score:p.score, streak:p.streak||0})),
  });

  // Schedule next round or level end
  const nextRound = roundIndex + 1;
  if (lobby.betweenTimer) clearTimeout(lobby.betweenTimer);

  if (nextRound < cfg.rounds) {
    lobby.betweenTimer = setTimeout(() => startRound(lobby, nextRound), 2800);
  } else {
    lobby.betweenTimer = setTimeout(() => endLevel(lobby), 2800);
  }
}

// ── End level ────────────────────────────────────────────────────────────────
function endLevel(lobby) {
  if (lobby.level >= LEVELS.length - 1) {
    lobby.phase = "gameOver";
    const sorted = [...lobby.players].sort((a,b) => b.score - a.score);
    broadcast(lobby, {
      type: "gameOver",
      players: lobby.players.map(p => ({name:p.name, score:p.score})),
      winner: sorted[0].name,
      draw: sorted[0].score === (sorted[1]?.score||0),
    });
  } else {
    lobby.phase = "levelEnd";
    broadcast(lobby, {
      type: "levelEnd",
      level: lobby.level,
      nextLevelName: LEVELS[lobby.level+1].name,
      players: lobby.players.map(p => ({name:p.name, score:p.score})),
    });
    setTimeout(() => { lobby.level++; startLevel(lobby); }, 5000);
  }
}

// ── WebSocket connections ────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  let playerLobby = null, playerRef = null, playerIndex = -1;

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "createLobby": {
        const id = makeLobbyId(), lobby = createLobby(id);
        lobbies.set(id, lobby);
        playerRef   = { ws, name:(msg.name||"PLAYER_01").slice(0,12), score:0, streak:0, roundScores:[] };
        playerIndex = 0;
        lobby.players.push(playerRef);
        playerLobby = lobby;
        sendTo(ws, {type:"lobbyCreated", lobbyId:id, playerIndex:0, name:playerRef.name});
        break;
      }
      case "joinLobby": {
        const lobby = lobbies.get(msg.lobbyId?.toUpperCase());
        if (!lobby)                    { sendTo(ws,{type:"error",msg:"Lobby not found"});    return; }
        if (lobby.players.length >= 2) { sendTo(ws,{type:"error",msg:"Lobby is full"});      return; }
        if (lobby.phase !== "waiting") { sendTo(ws,{type:"error",msg:"Game already started"});return; }
        playerRef   = { ws, name:(msg.name||"PLAYER_02").slice(0,12), score:0, streak:0, roundScores:[] };
        playerIndex = 1;
        lobby.players.push(playerRef);
        playerLobby = lobby;
        sendTo(ws, {type:"lobbyJoined", lobbyId:lobby.id, playerIndex:1, name:playerRef.name});
        broadcast(lobby, {type:"playerJoined", players:lobby.players.map(p=>({name:p.name}))});
        setTimeout(() => startLevel(lobby), 800);
        break;
      }
      case "answer": {
        if (!playerLobby || playerLobby.phase !== "playing") return;
        const { roundIndex, choiceIndex, timeTaken } = msg;
        if (roundIndex !== playerLobby.currentRound) return;
        submitAnswer(playerLobby, playerIndex, choiceIndex, timeTaken);
        break;
      }
      case "restartGame": {
        if (!playerLobby) return;
        if (playerLobby.roundTimer)   clearTimeout(playerLobby.roundTimer);
        if (playerLobby.betweenTimer) clearTimeout(playerLobby.betweenTimer);
        playerLobby.level = 0;
        playerLobby.phase = "waiting";
        playerLobby.players.forEach(p => { p.score=0; p.streak=0; p.roundScores=[]; });
        setTimeout(() => startLevel(playerLobby), 300);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!playerLobby) return;
    if (playerLobby.roundTimer)   clearTimeout(playerLobby.roundTimer);
    if (playerLobby.betweenTimer) clearTimeout(playerLobby.betweenTimer);
    broadcast(playerLobby, {type:"playerLeft", name:playerRef?.name});
    playerLobby.players = playerLobby.players.filter(p => p !== playerRef);
    if (playerLobby.players.length === 0) lobbies.delete(playerLobby.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => console.log(`GEOVS server on port ${PORT}`));
