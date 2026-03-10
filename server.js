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
const FOOD_COUNT = 1800;
const VIRUS_COUNT = 35;
const TICK_RATE = 30;
const MAX_CELLS = 16;

const players = new Map();
const food = [];
const viruses = [];

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

function createPlayer(id, name) {
  return {
    id,
    name: (name || "Player").slice(0, 16),
    color: randomColor(),
    mouse: { x: 0, y: 0 },
    wantsSplit: false,
    wantsEject: false,
    cells: [
      {
        x: rand(-1000, 1000),
        y: rand(-1000, 1000),
        mass: 30,
        vx: 0,
        vy: 0,
        mergeTimer: 0
      }
    ]
  };
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

  for (const [id, player] of players) {
    if (player.cells.length === 0) {
      player.cells.push({
        x: rand(-1000, 1000),
        y: rand(-1000, 1000),
        mass: 30,
        vx: 0,
        vy: 0,
        mergeTimer: 0
      });
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

function buildSnapshot() {
  const playerList = [...players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      totalMass: Math.round(totalMass(p)),
      cells: p.cells.map((c) => ({
        x: c.x,
        y: c.y,
        mass: c.mass
      }))
    }))
    .sort((a, b) => b.totalMass - a.totalMass);

  return {
    worldSize: WORLD_SIZE,
    food,
    viruses,
    players: playerList,
    leaderboard: playerList.slice(0, 10).map((p) => ({
      name: p.name,
      mass: p.totalMass
    }))
  };
}

io.on("connection", (socket) => {
  socket.on("join", (name) => {
    const player = createPlayer(socket.id, name);
    players.set(socket.id, player);
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
    players.delete(socket.id);
  });
});

resetWorldObjects();

setInterval(() => {
  for (const player of players.values()) {
    movePlayer(player);
    splitPlayer(player);
    ejectMass(player);
    handleFoodEating(player);
    handleVirusCollisions(player);
    handleSelfMerge(player);
  }

  handlePlayerVsPlayer();

  io.sockets.emit("state", buildSnapshot());
}, 1000 / TICK_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});