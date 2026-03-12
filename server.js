const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"]
});

const DEFAULT_DATA_DIR = fs.existsSync("/var/data") ? "/var/data" : __dirname;
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "pipo.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    credits REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    amount_eur REAL NOT NULL DEFAULT 0,
    credits_delta REAL NOT NULL DEFAULT 0,
    currency TEXT,
    tx_reference TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

try {
  db.exec(`ALTER TABLE users ADD COLUMN credits REAL NOT NULL DEFAULT 0`);
} catch (err) {
  if (!String(err.message || "").includes("duplicate column name")) throw err;
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  }
});

const PORT = process.env.PORT || 3000;
const SOLANA_RECEIVE_ADDRESS = process.env.SOLANA_RECEIVE_ADDRESS || "";
const EUR_TO_CREDITS = 1;

app.use(express.json());
app.use(sessionMiddleware);

const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC_DIR = fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : __dirname;
app.use(express.static(STATIC_DIR));
app.get("/", (req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

const WORLD_SIZE = 12000;
const FOOD_COUNT = 3000;
const VIRUS_COUNT = 35;
const TICK_RATE = 45;
const MAX_CELLS = 16;
const SNAPSHOT_PADDING = 650;
const FOOD_NEAR_CHECK = 160;
const FOOD_NEAR_CHECK_SQ = FOOD_NEAR_CHECK * FOOD_NEAR_CHECK;

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

function distanceSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
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

function createPlayer(id, name, account = null) {
  return {
    id,
    userId: account?.id || null,
    username: account?.username || null,
    name: (name || account?.username || "Player").slice(0, 16),
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
    const speed = 3.1 / Math.pow(cell.mass, 0.16);
    const len = Math.hypot(player.mouse.x, player.mouse.y) || 1;
    const dirX = player.mouse.x / len;
    const dirY = player.mouse.y / len;
    const distFactor = Math.min(len / 180, 1);

    cell.vx += dirX * speed * distFactor;
    cell.vy += dirY * speed * distFactor;

    cell.vx *= 0.84;
    cell.vy *= 0.84;

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
        const push = (minD - d) * 0.1;
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
    if (cell.mass < 36 || player.cells.length + newCells.length >= MAX_CELLS) continue;

    const newMass = cell.mass / 2;
    cell.mass = newMass;

    newCells.push({
      x: cell.x + dirX * radiusFromMass(newMass) * 2,
      y: cell.y + dirY * radiusFromMass(newMass) * 2,
      mass: newMass,
      vx: dirX * 20,
      vy: dirY * 20,
      mergeTimer: 360
    });
  }

  if (newCells.length) {
    player.cells.push(...newCells);
  }
}

function ejectMass(player) {
  if (!player.wantsEject) return;
  player.wantsEject = false;

  for (const cell of player.cells) {
    if (cell.mass <= 26) continue;

    cell.mass -= 1;
    const len = Math.hypot(player.mouse.x, player.mouse.y) || 1;
    const dirX = player.mouse.x / len;
    const dirY = player.mouse.y / len;

    food.push({
      id: Math.random().toString(36).slice(2),
      x: cell.x + dirX * (radiusFromMass(cell.mass) + 16),
      y: cell.y + dirY * (radiusFromMass(cell.mass) + 16),
      r: 8,
      color: player.color,
      mass: 1,
      vx: dirX * 16,
      vy: dirY * 16
    });
  }
}

function handleFoodEating(player) {
  for (const cell of player.cells) {
    const r = radiusFromMass(cell.mass);
    const eatDistSq = (r + 10) * (r + 10);

    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      if (distanceSq(cell.x, cell.y, f.x, f.y) <= eatDistSq) {
        cell.mass += f.mass;
        food[i] = food[food.length - 1];
        food.pop();
      }
    }
  }

  while (food.length < FOOD_COUNT) {
    food.push(createFood());
  }

  for (const f of food) {
    if (typeof f.vx === "number") {
      f.x += f.vx;
      f.y += f.vy;
      f.vx *= 0.9;
      f.vy *= 0.9;

      if (f.vx * f.vx + f.vy * f.vy < 0.01) {
        delete f.vx;
        delete f.vy;
      }
    }
  }
}

function handleVirusCollisions(player) {
  for (const cell of [...player.cells]) {
    const r = radiusFromMass(cell.mass);

    for (const virus of viruses) {
      const eatDist = r + virus.r * 0.6;
      if (distanceSq(cell.x, cell.y, virus.x, virus.y) < eatDist * eatDist && cell.mass > 120) {
        player.cells = player.cells.filter((c) => c !== cell);

        const pieces = Math.min(8, MAX_CELLS - player.cells.length);
        const baseMass = cell.mass / pieces;

        for (let i = 0; i < pieces; i++) {
          const angle = (Math.PI * 2 * i) / pieces;
          player.cells.push({
            x: cell.x + Math.cos(angle) * 20,
            y: cell.y + Math.sin(angle) * 20,
            mass: baseMass,
            vx: Math.cos(angle) * 18,
            vy: Math.sin(angle) * 18,
            mergeTimer: 420
          });
        }
        break;
      }
    }
  }
}

function handleSelfMerge(player) {
  for (let i = 0; i < player.cells.length; i++) {
    for (let j = i + 1; j < player.cells.length; j++) {
      const a = player.cells[i];
      const b = player.cells[j];
      if (a.mergeTimer > 0 || b.mergeTimer > 0) continue;

      const dSq = distanceSq(a.x, a.y, b.x, b.y);
      const rr = Math.max(radiusFromMass(a.mass), radiusFromMass(b.mass));
      if (dSq < (rr * 0.8) * (rr * 0.8)) {
        a.mass += b.mass;
        a.x = (a.x + b.x) / 2;
        a.y = (a.y + b.y) / 2;
        player.cells.splice(j, 1);
        j--;
      }
    }
  }
}

function handlePlayerVsPlayer() {
  const all = [...players.values()];

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const A = all[i];
      const B = all[j];

      for (const a of [...A.cells]) {
        for (const b of [...B.cells]) {
          const rA = radiusFromMass(a.mass);
          const rB = radiusFromMass(b.mass);
          const bigger = a.mass > b.mass * 1.15 ? a : b.mass > a.mass * 1.15 ? b : null;
          const smaller = bigger === a ? b : bigger === b ? a : null;
          if (!bigger || !smaller) continue;

          const dSq = distanceSq(a.x, a.y, b.x, b.y);
          const minEat = Math.max(rA, rB) * 0.9;

          if (dSq < minEat * minEat) {
            bigger.mass += smaller.mass;

            if (smaller === a) {
              A.cells = A.cells.filter((c) => c !== a);
              if (!A.cells.length) {
                A.cells = [respawnCell()];
              }
            } else {
              B.cells = B.cells.filter((c) => c !== b);
              if (!B.cells.length) {
                B.cells = [respawnCell()];
              }
            }
            break;
          }
        }
      }
    }
  }
}

function buildLeaderboard() {
  return [...players.values()]
    .map((player) => ({
      id: player.id,
      name: player.name,
      totalMass: Math.round(totalMass(player))
    }))
    .sort((a, b) => b.totalMass - a.totalMass)
    .slice(0, 10);
}

function buildSnapshotFor(player) {
  const center = playerCenter(player);

  const visibleFood = [];
  const visibleViruses = [];
  const visiblePlayers = [];

  for (const f of food) {
    if (distanceSq(f.x, f.y, center.x, center.y) <= (WORLD_SIZE * 0.18) * (WORLD_SIZE * 0.18) ||
        distanceSq(f.x, f.y, center.x, center.y) <= FOOD_NEAR_CHECK_SQ) {
      visibleFood.push({
        id: f.id,
        x: Math.round(f.x * 10) / 10,
        y: Math.round(f.y * 10) / 10,
        r: f.r,
        color: f.color
      });
    }
  }

  for (const v of viruses) {
    if (Math.abs(v.x - center.x) <= WORLD_SIZE * 0.25 && Math.abs(v.y - center.y) <= WORLD_SIZE * 0.25) {
      visibleViruses.push(v);
    }
  }

  for (const other of players.values()) {
    const otherCenter = playerCenter(other);
    if (Math.abs(otherCenter.x - center.x) > WORLD_SIZE * 0.3 + SNAPSHOT_PADDING ||
        Math.abs(otherCenter.y - center.y) > WORLD_SIZE * 0.3 + SNAPSHOT_PADDING) {
      continue;
    }

    visiblePlayers.push({
      id: other.id,
      name: other.name,
      color: other.color,
      totalMass: Math.round(totalMass(other)),
      cells: other.cells.map((c) => ({
        x: Math.round(c.x * 10) / 10,
        y: Math.round(c.y * 10) / 10,
        mass: Math.round(c.mass * 10) / 10
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

function getSessionUser(req) {
  return req.session.user || null;
}

function getFreshSessionUser(req) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.id) return null;

  const user = db.prepare("SELECT id, username, credits FROM users WHERE id = ?").get(sessionUser.id);
  if (!user) return null;

  req.session.user = {
    id: user.id,
    username: user.username,
    credits: Number(user.credits || 0)
  };

  return req.session.user;
}

function requireAuth(req, res, next) {
  const user = getFreshSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  req.user = user;
  next();
}

const addCreditsStmt = db.prepare(`
  UPDATE users
  SET credits = ROUND(credits + ?, 2)
  WHERE id = ?
`);

const insertCreditTxStmt = db.prepare(`
  INSERT INTO credit_transactions
    (user_id, kind, amount_eur, credits_delta, currency, tx_reference, status, metadata_json)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getUserCreditsStmt = db.prepare("SELECT credits FROM users WHERE id = ?");

const applyCreditChange = db.transaction((userId, creditsDelta, details = {}) => {
  addCreditsStmt.run(creditsDelta, userId);
  insertCreditTxStmt.run(
    userId,
    details.kind || "manual",
    Number(details.amountEur || 0),
    Number(creditsDelta || 0),
    details.currency || null,
    details.txReference || null,
    details.status || "completed",
    details.metadata ? JSON.stringify(details.metadata) : null
  );
  const row = getUserCreditsStmt.get(userId);
  return Number(row?.credits || 0);
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: "Username must be 3-20 characters." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (existing) {
      return res.status(409).json({ error: "Username already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db
      .prepare("INSERT INTO users (username, password_hash, credits) VALUES (?, ?, ?)")
      .run(username, passwordHash, 0);

    req.session.user = {
      id: result.lastInsertRowid,
      username,
      credits: 0
    };

    res.json({
      ok: true,
      user: getFreshSessionUser(req)
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Failed to register." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    const user = db
      .prepare("SELECT id, username, password_hash, credits FROM users WHERE username = ?")
      .get(username);

    if (!user) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      credits: Number(user.credits || 0)
    };

    res.json({
      ok: true,
      user: getFreshSessionUser(req)
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Failed to log in." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({
    user: getFreshSessionUser(req)
  });
});

app.get("/api/balance", requireAuth, (req, res) => {
  res.json({
    ok: true,
    credits: req.user.credits
  });
});

app.get("/api/credits/history", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, kind, amount_eur, credits_delta, currency, tx_reference, status, created_at
       FROM credit_transactions
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 50`
    )
    .all(req.user.id);

  res.json({ ok: true, history: rows });
});

app.post("/api/credits/add", requireAuth, (req, res) => {
  const amountEur = Number(req.body?.amountEur);
  if (!Number.isFinite(amountEur) || amountEur <= 0) {
    return res.status(400).json({ error: "amountEur must be a positive number." });
  }

  const creditsToAdd = Math.round(amountEur * EUR_TO_CREDITS * 100) / 100;
  const credits = applyCreditChange(req.user.id, creditsToAdd, {
    kind: "manual_topup",
    amountEur,
    currency: "EUR",
    txReference: String(req.body?.txReference || "") || null,
    metadata: {
      source: "api_credits_add"
    }
  });

  req.session.user.credits = credits;

  res.json({
    ok: true,
    credits,
    addedCredits: creditsToAdd
  });
});

app.post("/api/credits/spend", requireAuth, (req, res) => {
  const creditsToSpend = Number(req.body?.credits);
  if (!Number.isFinite(creditsToSpend) || creditsToSpend <= 0) {
    return res.status(400).json({ error: "credits must be a positive number." });
  }

  if (req.user.credits < creditsToSpend) {
    return res.status(400).json({ error: "Not enough credits." });
  }

  const roundedSpend = Math.round(creditsToSpend * 100) / 100;
  const credits = applyCreditChange(req.user.id, -roundedSpend, {
    kind: "spend",
    amountEur: 0,
    currency: "CREDITS",
    txReference: String(req.body?.reason || "") || null,
    metadata: {
      reason: String(req.body?.reason || "")
    }
  });

  req.session.user.credits = credits;

  res.json({
    ok: true,
    credits,
    spentCredits: roundedSpend
  });
});

app.post("/api/payments/solana/quote", requireAuth, (req, res) => {
  const amountEur = Number(req.body?.amountEur);
  if (!Number.isFinite(amountEur) || amountEur <= 0) {
    return res.status(400).json({ error: "amountEur must be a positive number." });
  }

  const roundedEur = Math.round(amountEur * 100) / 100;
  const credits = Math.round(roundedEur * EUR_TO_CREDITS * 100) / 100;
  const reference = `pipo-${req.user.id}-${Date.now()}`;

  insertCreditTxStmt.run(
    req.user.id,
    "solana_quote",
    roundedEur,
    0,
    "EUR",
    reference,
    "pending",
    JSON.stringify({
      address: SOLANA_RECEIVE_ADDRESS || null,
      note: "Awaiting on-chain confirmation"
    })
  );

  res.json({
    ok: true,
    amountEur: roundedEur,
    credits,
    receiveAddress: SOLANA_RECEIVE_ADDRESS,
    reference,
    note: "Quote created. To credit balances automatically, add a Solana webhook/verification step."
  });
});

app.get("/debug/players", (req, res) => {
  res.json({
    playerCount: players.size,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      userId: p.userId,
      totalMass: Math.round(totalMass(p)),
      cells: p.cells.length
    })),
    chatMessages: chatMessages.length,
    dbPath: DB_PATH,
    dataDir: DATA_DIR
  });
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.on("connection", (socket) => {
  socket.on("join", (payload) => {
    const sessionUser = getFreshSessionUser(socket.request);
    const requestedName = typeof payload === "string" ? payload : payload?.name;
    const color = typeof payload === "object" ? payload?.color : null;

    const player = createPlayer(socket.id, requestedName, sessionUser);
    if (color) player.color = color;

    players.set(socket.id, player);

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
      socket.volatile.emit("state", buildSnapshotFor(player));
    }
  } catch (err) {
    console.error("GAME LOOP ERROR:", err);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Using database: ${DB_PATH}`);
  console.log(`Using data directory: ${DATA_DIR}`);
});
