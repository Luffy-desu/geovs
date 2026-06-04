# GEOVS — Geometric Versus

A 1v1 local-network abstract pattern puzzle game. Both players connect over the same Wi-Fi, each solve abstract shape sequences, and sabotage each other in real time.

---

## Quick Start

```bash
# 1. Install the only dependency
npm install

# 2. Run the server
node server.js
```

The terminal will print your local network address, e.g.:
```
╔═══════════════════════════════════════╗
║         GEOVS  —  Game Server         ║
╠═══════════════════════════════════════╣
║  Local:   http://localhost:3000        ║
║  Network: http://192.168.1.42:3000    ║
╚═══════════════════════════════════════╝
```

**Player 1** opens `http://localhost:3000`  
**Player 2** opens `http://192.168.1.42:3000` (the network address) on a different device or browser tab

> **No build tools, no bundler, no framework** — pure Node.js + vanilla JS.

---

## How to Play

1. **Player 1** enters a callsign and clicks **Create Match**
2. A 5-letter lobby code appears (e.g. `XKQF7`)
3. **Player 2** enters their callsign, pastes the code, clicks **Join Match**
4. Game starts automatically with a 3-second countdown

### Gameplay

Each round, you see a sequence of geometric shapes and must choose which shape **completes the pattern** from 4 options.

- **Correct answer** → score based on speed (up to +300 pts)
- **Correct answer** also → **sabotages your opponent** by stealing 2 seconds from their timer
- **Wrong or timeout** → 0 points for that round

### Levels

| Level | Rounds | Timer | Pattern Length |
|-------|--------|-------|----------------|
| 1     | 5      | 15s   | 3 shapes       |
| 2     | 7      | 11s   | 4 shapes       |
| 3     | 10     | 8s    | 5 shapes       |

Each player gets a **different pattern** each round — you can't copy your opponent.

---

## Architecture

```
geovs/
├── server.js      ← Node.js HTTP + WebSocket server
├── client.html    ← Complete game client (HTML + CSS + Canvas JS)
└── package.json   ← Only dependency: ws
```

### How it works

**server.js** does three things:
1. Serves `client.html` via HTTP on port 3000
2. Manages lobbies and game state via WebSocket
3. Generates reproducible patterns using a seeded PRNG

**client.html** contains everything for the browser:
- Lobby/menu/game screens
- HTML5 Canvas rendering for patterns and background animation
- WebSocket client
- Local pattern generation (mirrors server logic with player-specific seed offset)
- Timer bar, progress pips, sabotage overlay, score HUD

### WebSocket message protocol

| Direction       | Type            | Payload                          |
|----------------|-----------------|----------------------------------|
| Client → Server | `createLobby`   | `{name}`                         |
| Client → Server | `joinLobby`     | `{lobbyId, name}`                |
| Client → Server | `answer`        | `{roundIndex, choiceIndex, timeTaken}` |
| Server → Client | `lobbyCreated`  | `{lobbyId, playerIndex}`         |
| Server → Client | `gameState`     | `{level, config, seeds, players}`|
| Server → Client | `roundStart`    | `{roundIndex, timeLimit}`        |
| Server → Client | `roundResult`   | `{correct, bonus, score}`        |
| Server → Client | `sabotage`      | `{seconds, fromPlayer}`          |
| Server → Client | `scoreUpdate`   | `{players[]}`                    |
| Server → Client | `levelEnd`      | `{level, players[]}`             |
| Server → Client | `gameOver`      | `{winner, players[]}`            |

---

## Customising

**Change timers or round counts** — edit `DIFFICULTY` in both `server.js` and `client.html` (they must match):
```js
const DIFFICULTY = [
  { rounds: 5,  timePerRound: 15000, patternSize: 3 },
  { rounds: 7,  timePerRound: 11000, patternSize: 4 },
  { rounds: 10, timePerRound:  8000, patternSize: 5 },
];
```

**Add new shapes** — add to the `SHAPES` array and add a drawing case in both `drawShape()` and `drawShapeToCanvas()` in `client.html`.

**Change port** — `PORT=8080 node server.js`
