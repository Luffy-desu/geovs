/**
 * GEOVS — Geometric Versus  |  Server v2
 * 5 difficulty levels, rich scoring, sabotage streaks
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

// ── 5 levels: easy → legendary ─────────────────────────────────────────────
const LEVELS = [
  { name:"EASY",      rounds:4,  timePerRound:18000, patternSize:2, basePoints:100, speedBonus:150 },
  { name:"MEDIUM",    rounds:5,  timePerRound:14000, patternSize:3, basePoints:150, speedBonus:200 },
  { name:"HARD",      rounds:6,  timePerRound:10000, patternSize:4, basePoints:200, speedBonus:300 },
  { name:"EXPERT",    rounds:7,  timePerRound:7000,  patternSize:5, basePoints:300, speedBonus:450 },
  { name:"LEGENDARY", rounds:8,  timePerRound:5000,  patternSize:6, basePoints:500, speedBonus:700 },
];

const SHAPES    = ["square","triangle","circle","diamond","cross","hexagon"];
const COLORS    = ["#FF2D55","#00F5C8","#FFD60A","#0A84FF","#FF9F0A","#BF5AF2","#30D158","#FF6B6B"];
const ROTATIONS = [0, 45, 90, 135, 180];

function seededRand(seed) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646; };
}

function generatePattern(size, roundSeed, playerIndex) {
  const seed = roundSeed + playerIndex * 99991;
  const rand = seededRand(seed);
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
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return {
    sequence: seq.slice(0, size), answer, choices,
    correctIndex: choices.findIndex(c =>
      c.shape === answer.shape && c.color === answer.color && c.rotation === answer.rotation
    ),
  };
}

const lobbies = new Map();
const makeLobbyId = () => Math.random().toString(36).slice(2, 7).toUpperCase();

function createLobby(id) {
  return { id, players: [], level: 0, roundSeeds: [], phase: "waiting", roundTimers: [] };
}

function broadcast(lobby, msg) {
  const d = JSON.stringify(msg);
  lobby.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(d); });
}
function sendTo(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function startLevel(lobby) {
  const cfg = LEVELS[lobby.level];
  lobby.roundSeeds = Array.from({ length: cfg.rounds }, () => Math.floor(Math.random() * 1e9));
  lobby.players.forEach(p => { p.roundIndex = 0; p.streak = 0; });
  lobby.phase = "countdown";
  broadcast(lobby, {
    type: "countdown", seconds: 3,
    level: lobby.level, levelName: cfg.name,
    seeds: lobby.roundSeeds, config: cfg,
    players: lobby.players.map((p, i) => ({ name: p.name, score: p.score, playerIndex: i })),
  });
  setTimeout(() => {
    lobby.phase = "playing";
    broadcast(lobby, { type: "roundStart", roundIndex: 0, timeLimit: cfg.timePerRound });
    scheduleTimeout(lobby, 0);
  }, 3300);
}

function scheduleTimeout(lobby, roundIndex) {
  const cfg = LEVELS[lobby.level];
  if (lobby.roundTimers[roundIndex]) clearTimeout(lobby.roundTimers[roundIndex]);
  lobby.roundTimers[roundIndex] = setTimeout(() => {
    lobby.players.forEach(p => {
      if (p.roundIndex === roundIndex) {
        p.streak = 0;
        p.roundIndex++;
        sendTo(p.ws, { type: "roundTimeout", roundIndex, score: p.score });
      }
    });
    checkLevelComplete(lobby);
  }, cfg.timePerRound + 1200);
}

function advanceRound(lobby, player, playerIndex, roundIndex, choiceIndex, timeTaken) {
  const cfg     = LEVELS[lobby.level];
  const pattern = generatePattern(cfg.patternSize, lobby.roundSeeds[roundIndex], playerIndex);
  const correct = pattern.correctIndex === choiceIndex;

  let points = 0;
  if (correct) {
    const timeRatio  = Math.max(0, 1 - timeTaken / cfg.timePerRound);
    const speedPts   = Math.ceil(timeRatio * cfg.speedBonus);
    player.streak    = (player.streak || 0) + 1;
    const streakMult = Math.min(player.streak, 5);          // max 5× streak
    const streakBonus= (streakMult - 1) * 50;               // +0,+50,+100,+150,+200
    points = cfg.basePoints + speedPts + streakBonus;
  } else {
    player.streak = 0;
  }

  player.score     += points;
  player.roundIndex = roundIndex + 1;

  sendTo(player.ws, {
    type: "roundResult", roundIndex, correct,
    points, score: player.score, streak: player.streak,
    correctIndex: pattern.correctIndex,
    breakdown: correct ? { base: cfg.basePoints, speed: points - cfg.basePoints - (Math.min(player.streak,5)-1)*50, streak: (Math.min(player.streak,5)-1)*50 } : null,
  });

  if (correct) {
    const opp = lobby.players.find((_, i) => i !== playerIndex);
    if (opp) sendTo(opp.ws, { type: "sabotage", seconds: player.streak >= 3 ? 3 : 2, fromPlayer: player.name, streak: player.streak });
  }

  broadcast(lobby, {
    type: "scoreUpdate",
    players: lobby.players.map(p => ({ name: p.name, score: p.score, roundIndex: p.roundIndex, streak: p.streak || 0 })),
  });

  checkLevelComplete(lobby);
}

function checkLevelComplete(lobby) {
  const cfg = LEVELS[lobby.level];
  if (!lobby.players.every(p => p.roundIndex >= cfg.rounds)) return;
  lobby.roundTimers.forEach(t => clearTimeout(t));
  lobby.roundTimers = [];

  if (lobby.level >= LEVELS.length - 1) {
    lobby.phase = "gameOver";
    const sorted = [...lobby.players].sort((a, b) => b.score - a.score);
    broadcast(lobby, {
      type: "gameOver",
      players: lobby.players.map(p => ({ name: p.name, score: p.score })),
      winner: sorted[0].name,
      draw: sorted[0].score === sorted[1]?.score,
    });
  } else {
    lobby.phase = "levelEnd";
    broadcast(lobby, {
      type: "levelEnd", level: lobby.level,
      nextLevelName: LEVELS[lobby.level + 1].name,
      players: lobby.players.map(p => ({ name: p.name, score: p.score })),
    });
    setTimeout(() => { lobby.level++; startLevel(lobby); }, 6000);
  }
}

wss.on("connection", (ws) => {
  let playerLobby = null, playerRef = null, playerIndex = -1;

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "createLobby": {
        const id = makeLobbyId(), lobby = createLobby(id);
        lobbies.set(id, lobby);
        playerRef = { ws, name: (msg.name||"PLAYER_01").slice(0,12), score: 0, roundIndex: 0, streak: 0 };
        playerIndex = 0; lobby.players.push(playerRef); playerLobby = lobby;
        sendTo(ws, { type: "lobbyCreated", lobbyId: id, playerIndex: 0, name: playerRef.name });
        break;
      }
      case "joinLobby": {
        const lobby = lobbies.get(msg.lobbyId?.toUpperCase());
        if (!lobby)                    { sendTo(ws, { type: "error", msg: "Lobby not found" });     return; }
        if (lobby.players.length >= 2) { sendTo(ws, { type: "error", msg: "Lobby is full" });       return; }
        if (lobby.phase !== "waiting") { sendTo(ws, { type: "error", msg: "Game already started" }); return; }
        playerRef = { ws, name: (msg.name||"PLAYER_02").slice(0,12), score: 0, roundIndex: 0, streak: 0 };
        playerIndex = 1; lobby.players.push(playerRef); playerLobby = lobby;
        sendTo(ws, { type: "lobbyJoined", lobbyId: lobby.id, playerIndex: 1, name: playerRef.name });
        broadcast(lobby, { type: "playerJoined", players: lobby.players.map(p => ({ name: p.name })) });
        setTimeout(() => startLevel(lobby), 800);
        break;
      }
      case "answer": {
        if (!playerLobby || !playerRef) return;
        const { roundIndex, choiceIndex, timeTaken } = msg;
        if (playerRef.roundIndex !== roundIndex) return;
        advanceRound(playerLobby, playerRef, playerIndex, roundIndex, choiceIndex, timeTaken);
        break;
      }
      case "restartGame": {
        if (!playerLobby) return;
        playerLobby.roundTimers.forEach(t => clearTimeout(t));
        playerLobby.roundTimers = [];
        playerLobby.level = 0;
        playerLobby.phase = "waiting";
        playerLobby.players.forEach(p => { p.score = 0; p.roundIndex = 0; p.streak = 0; });
        setTimeout(() => startLevel(playerLobby), 300);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!playerLobby) return;
    broadcast(playerLobby, { type: "playerLeft", name: playerRef?.name });
    playerLobby.players = playerLobby.players.filter(p => p !== playerRef);
    if (playerLobby.players.length === 0) lobbies.delete(playerLobby.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => console.log(`\nGEOVS server on port ${PORT}\n`));
