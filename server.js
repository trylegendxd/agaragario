const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const WORLD_SIZE = 12000;
const FOOD_COUNT = 1000;
const VIRUS_COUNT = 35;
const TICK_RATE = 35;
const MAX_CELLS = 16;

// How far beyond the visible area to still send entities
const SNAPSHOT_PADDING = 800;

const players = new Map();
const food = [];
const viruses = [];

const chatMessages = [];
const MAX_CHAT_MESSAGES = 40;

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function radiusFromMass(mass) {
  return Math.sqrt(mass) * 4.8;
}

function randomColor() {
  const hue = Math.floor(rand(0, 360));
  return `hsl(${hue}, 80%, 58%)`;
}

function createFood() {
  return {
    id: Math.random().toString(36).slice(2),
    x: rand(-WORLD_SIZE / 2, WORLD_SIZE / 2),
    y: rand(-WORLD_SIZE / 2, WORLD_SIZE / 2),
    r: 8,
    color: `hsl(${Math.floor(rand(0, 360))},85%,60%)`,
    mass: 1
  };
}

function createVirus() {
  return {
    id: Math.random().toString(36).slice(2),
    x: rand(-WORLD_SIZE / 2, WORLD_SIZE / 2),
    y: rand(-WORLD_SIZE / 2, WORLD_SIZE / 2),
    r: 48
  };
}

function totalMass(player) {
  return player.cells.reduce((sum, c) => sum + c.mass, 0);
}

function playerCenter(player) {
  let total = 0;
  let sx = 0;
  let sy = 0;

  for (const cell of player.cells) {
    total += cell.mass;
    sx += cell.x * cell.mass;
    sy += cell.y * cell.mass;
  }

  if (total <= 0) return { x: 0, y: 0 };
  return { x: sx / total, y: sy / total };
}

function respawnCell() {
  return {
    x: rand(-150, 150),
    y: rand(-150, 150),
    mass: 30,
    vx: 0,
    vy: 0,
    mergeTimer: 0
  };
}

function createPlayer(id, name) {
  return {
    id,
    name: (name || "Player").slice(0, 16),
    color: randomColor(),
    mouse: { x: 0, y: 0 },
    wantsSplit: false,
    wantsEject: false,
    cells: [respawnCell()]
  };
}

function addChatMessage(name, text) {
  const cleanName = String(name || "Player").slice(0, 16);
  const cleanText = String(text || "").trim().slice(0, 160);

  if (!cleanText) return;

  const msg = {
    id: Math.random().toString(36).slice(2),
    name: cleanName,
    text: cleanText,
    time: Date.now()
  };

  chatMessages.push(msg);

  while (chatMessages.length > MAX_CHAT_MESSAGES) {
    chatMessages.shift();
  }

  io.sockets.emit("chat", msg);
}

function resetWorldObjects() {
  food.length = 0;
  viruses.length = 0;

  for (let i = 0; i < FOOD_COUNT; i++) {
    food.push(createFood());
  }

  for (let i = 0; i < VIRUS_COUNT; i++) {
    viruses.push(createVirus());
  }
}

function movePlayer(player) {
  for (const cell of player.cells) {
    const speed = 2.6 / Math.pow(cell.mass, 0.16);
    const len = Math.hypot(player.mouse.x, player.mouse.y) || 1;
    const dirX = player.mouse.x / len;
    const dirY = player.mouse.y / len;
    const distFactor = Math.min(len / 220, 1);

    cell.vx += dirX * speed * distFactor;
    cell.vy += dirY * speed * distFactor;

    cell.vx *= 0.88;
    cell.vy *= 0.88;

    cell.x += cell.vx;
    cell.y += cell.vy;

    if (cell.mergeTimer > 0) cell.mergeTimer--;
  }

  for (let i = 0; i < player.cells.length; i++) {
    for (let j = i + 1; j < player.cells.length; j++) {
      const a = player.cells[i];
      const b = player.cells[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const minD = (radiusFromMass(a.mass) + radiusFromMass(b.mass)) * 0.55;

      if (d < minD) {
        const push = (minD - d) * 0.08;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
  }

  for (const cell of player.cells) {
    const r = radiusFromMass(cell.mass);
    const bound = WORLD_SIZE / 2 - r;
    cell.x = clamp(cell.x, -bound, bound);
    cell.y = clamp(cell.y, -bound, bound);
  }
}

function splitPlayer(player) {
  if (!player.wantsSplit) return;
  player.wantsSplit = false;

  if (player.cells.length >= MAX_CELLS) return;

  const len = Math.hypot(player.mouse.x, player.mouse.y) || 1;
  const dirX = player.mouse.x / len;
  const dirY = player.mouse.y / len;

  const newCells = [];

  for (const cell of player.cells) {
    if (cell.mass < 36) continue;
    if (player.cells.length + newCells.length >= MAX_CELLS) break;

    const childMass = cell.mass / 2;
    cell.mass = childMass;
    const r = radiusFromMass(childMass);

    newCells.push({
      x: cell.x + dirX * (r * 2.2),
      y: cell.y + dirY * (r * 2.2),
      mass: childMass,
      vx: dirX * 22,
      vy: dirY * 22,
      mergeTimer: 220
    });

    cell.mergeTimer = 220;
  }

  player.cells.push(...newCells);
}

function ejectMass(player) {
  if (!player.wantsEject) return;
  player.wantsEject = false;

  const len = Math.hypot(player.mouse.x, player.mouse.y) || 1;
  const dirX = player.mouse.x / len;
  const dirY = player.mouse.y / len;

  for (const cell of player.cells) {
    if (cell.mass <= 20) continue;
    cell.mass -= 1;

    food.push({
      id: Math.random().toString(36).slice(2),
      x: cell.x + dirX * (radiusFromMass(cell.mass) + 20),
      y: cell.y + dirY * (radiusFromMass(cell.mass) + 20),
      r: 8,
      color: "#33c3ff",
      mass: 1
    });
  }
}

function handleFoodEating(player) {
  for (const cell of player.cells) {
    const r = radiusFromMass(cell.mass);

    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      if (Math.abs(cell.x - f.x) > 120 || Math.abs(cell.y - f.y) > 120) continue;

      if (distance(cell.x, cell.y, f.x, f.y) < r + f.r) {
        cell.mass += f.mass;
        food.splice(i, 1);
      }
    }
  }

  while (food.length < FOOD_COUNT) {
    food.push(createFood());
  }
}

function splitByVirus(player, cellIndex, virusIndex) {
  const cell = player.cells[cellIndex];
  if (!cell) return;
  if (player.cells.length >= MAX_CELLS) return;

  const piecesWanted = Math.min(
    MAX_CELLS - player.cells.length + 1,
    Math.max(2, Math.min(8, Math.floor(cell.mass / 18)))
  );

  if (piecesWanted < 2) return;

  const partMass = cell.mass / piecesWanted;
  cell.mass = partMass;
  cell.mergeTimer = 300;

  for (let i = 1; i < piecesWanted; i++) {
    const ang = (Math.PI * 2 * i) / piecesWanted;
    player.cells.push({
      x: cell.x + Math.cos(ang) * 20,
      y: cell.y + Math.sin(ang) * 20,
      mass: partMass,
      vx: Math.cos(ang) * 18,
      vy: Math.sin(ang) * 18,
      mergeTimer: 300
    });
  }

  viruses.splice(virusIndex, 1);
  viruses.push(createVirus());
}

function handleVirusCollisions(player) {
  for (let v = viruses.length - 1; v >= 0; v--) {
    const virus = viruses[v];

    for (let c = player.cells.length - 1; c >= 0; c--) {
      const cell = player.cells[c];
      const r = radiusFromMass(cell.mass);

      if (cell.mass >= 36 && distance(cell.x, cell.y, virus.x, virus.y) < r - virus.r * 0.15) {
        splitByVirus(player, c, v);
        break;
      }
    }
  }
}

function handlePlayerVsPlayer() {
  const list = [...players.values()];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      for (let ai = a.cells.length - 1; ai >= 0; ai--) {
        const ac = a.cells[ai];
        if (!ac) continue;

        for (let bi = b.cells.length - 1; bi >= 0; bi--) {
          const bc = b.cells[bi];
          if (!bc) continue;

          const ar = radiusFromMass(ac.mass);
          const br = radiusFromMass(bc.mass);
          const d = distance(ac.x, ac.y, bc.x, bc.y);

          if (ac.mass > bc.mass * 1.12 && d < ar - br * 0.3) {
            ac.mass += bc.mass;
            b.cells.splice(bi, 1);
          } else if (bc.mass > ac.mass * 1.12 && d < br - ar * 0.3) {
            bc.mass += ac.mass;
            a.cells.splice(ai, 1);
            break;
          }
        }
      }
    }
  }

  for (const player of players.values()) {
    if (player.cells.length === 0) {
      player.cells.push(respawnCell());
    }
  }
}

function handleSelfMerge(player) {
  if (player.cells.length <= 1) return;

  for (let i = 0; i < player.cells.length; i++) {
    for (let j = i + 1; j < player.cells.length; j++) {
      const a = player.cells[i];
      const b = player.cells[j];
      const d = distance(a.x, a.y, b.x, b.y);

      if (a.mergeTimer <= 0 && b.mergeTimer <= 0 && d < Math.max(radiusFromMass(a.mass), radiusFromMass(b.mass)) * 0.6) {
        a.mass += b.mass;
        player.cells.splice(j, 1);
        j--;
      }
    }
  }
}

function buildLeaderboard() {
  return [...players.values()]
    .map((p) => ({
      name: p.name,
      mass: Math.round(totalMass(p))
    }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10);
}

function buildSnapshotFor(targetPlayer) {
  const center = playerCenter(targetPlayer);
  const total = totalMass(targetPlayer);
  const biggestCellMass = targetPlayer.cells.length
    ? Math.max(...targetPlayer.cells.map((c) => c.mass))
    : total;

  const biggestRadius = radiusFromMass(biggestCellMass);
  const visibleRadius = Math.max(2200, biggestRadius * 6 + SNAPSHOT_PADDING);

  const visibleFood = [];
  for (const f of food) {
    if (Math.abs(f.x - center.x) > visibleRadius) continue;
    if (Math.abs(f.y - center.y) > visibleRadius) continue;
    visibleFood.push(f);
  }

  const visibleViruses = [];
  for (const v of viruses) {
    if (Math.abs(v.x - center.x) > visibleRadius) continue;
    if (Math.abs(v.y - center.y) > visibleRadius) continue;
    visibleViruses.push(v);
  }

  const visiblePlayers = [];
  for (const p of players.values()) {
    const pCenter = playerCenter(p);

    if (
      p.id !== targetPlayer.id &&
      Math.abs(pCenter.x - center.x) > visibleRadius &&
      Math.abs(pCenter.y - center.y) > visibleRadius
    ) {
      continue;
    }

    visiblePlayers.push({
      id: p.id,
      name: p.name,
      color: p.color,
      totalMass: Math.round(totalMass(p)),
      cells: p.cells.map((c) => ({
        x: c.x,
        y: c.y,
        mass: c.mass
      }))
    });
  }

  visiblePlayers.sort((a, b) => a.totalMass - b.totalMass);

  return {
    worldSize: WORLD_SIZE,
    food: visibleFood,
    viruses: visibleViruses,
    players: visiblePlayers,
    leaderboard: buildLeaderboard(),
    debugPlayerCount: players.size
  };
}

app.get("/debug/players", (req, res) => {
  res.json({
    playerCount: players.size,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      totalMass: Math.round(totalMass(p)),
      cells: p.cells.length
    })),
    chatMessages: chatMessages.length
  });
});

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("join", (payload) => {
  const name = typeof payload === "string" ? payload : payload?.name;
  const color = typeof payload === "object" ? payload?.color : null;

  const player = createPlayer(socket.id, name);
  if (color) player.color = color;
    players.set(socket.id, player);
    console.log("joined:", socket.id, name, "total players:", players.size);

    socket.emit("chatHistory", chatMessages);
    addChatMessage("SERVER", `${player.name} joined the game`);
  });

  socket.on("chat", (text) => {
    const player = players.get(socket.id);
    if (!player) return;
    addChatMessage(player.name, text);
  });

  socket.on("input", (input) => {
    const player = players.get(socket.id);
    if (!player) return;

    if (typeof input.mouseX === "number") player.mouse.x = input.mouseX;
    if (typeof input.mouseY === "number") player.mouse.y = input.mouseY;
    if (input.split) player.wantsSplit = true;
    if (input.eject) player.wantsEject = true;
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    if (player) {
      addChatMessage("SERVER", `${player.name} left the game`);
    }
    players.delete(socket.id);
    console.log("disconnected:", socket.id, "total players:", players.size);
  });
});

resetWorldObjects();

setInterval(() => {
  try {
    for (const player of players.values()) {
      movePlayer(player);
      splitPlayer(player);
      ejectMass(player);
      handleFoodEating(player);
      handleVirusCollisions(player);
      handleSelfMerge(player);
    }

    handlePlayerVsPlayer();

    for (const [id, player] of players.entries()) {
      const socket = io.sockets.sockets.get(id);
      if (!socket) continue;
      socket.emit("state", buildSnapshotFor(player));
    }
  } catch (err) {
    console.error("GAME LOOP ERROR:", err);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

