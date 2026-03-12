const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = fs.existsSync("/var/data") ? "/var/data" : __dirname;
const DB_PATH = path.join(DATA_DIR, "pipo.db");

const WORLD_SIZE = 12000;
const FOOD_COUNT = 3000;
const VIRUS_COUNT = 35;
const BOT_COUNT = 8;
const TICK_RATE = 45;
const MAX_CELLS = 16;
const SNAPSHOT_PADDING = 650;
const MAX_CHAT_MESSAGES = 40;
const START_MASS = 30;
const GAME_ENTRY_COST = 1;
const REGISTER_BONUS = 5;

const players = new Map();
const playerByUserId = new Map();
const food = [];
const viruses = [];
const bots = [];
const chatMessages = [];

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    credits REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((col) => col.name === "credits")) {
  db.exec("ALTER TABLE users ADD COLUMN credits REAL NOT NULL DEFAULT 0");
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
});

function wrap(middleware) {
  return (socket, next) => middleware(socket.request, {}, next);
}

io.use(wrap(sessionMiddleware));

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
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

function randomSpawnCell() {
  return {
    x: rand(-WORLD_SIZE / 2 + 400, WORLD_SIZE / 2 - 400),
    y: rand(-WORLD_SIZE / 2 + 400, WORLD_SIZE / 2 - 400),
    mass: START_MASS,
    vx: 0,
    vy: 0,
    mergeTimer: 0
  };
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

function totalMass(entity) {
  return entity.cells.reduce((sum, cell) => sum + cell.mass, 0);
}

function entityCenter(entity) {
  let total = 0;
  let sx = 0;
  let sy = 0;

  for (const cell of entity.cells) {
    total += cell.mass;
    sx += cell.x * cell.mass;
    sy += cell.y * cell.mass;
  }

  if (total <= 0) return { x: 0, y: 0 };
  return { x: sx / total, y: sy / total };
}

function createHumanPlayer(socketId, user, payload) {
  const requestedName = typeof payload === "object" ? payload?.name : payload;
  const requestedColor = typeof payload === "object" ? payload?.color : null;
  const safeName =
    String(requestedName || user.username || "Player").trim().slice(0, 16) ||
    "Player";

  return {
    kind: "human",
    id: socketId,
    userId: user.id,
    username: user.username,
    name: safeName,
    color: requestedColor || randomColor(),
    mouse: { x: 0, y: 0 },
    wantsSplit: false,
    wantsEject: false,
    cells: [randomSpawnCell()],
    alive: true,
    joinedAt: Date.now()
  };
}

function createBot(index) {
  return {
    kind: "bot",
    id: `bot-${index}-${Math.random().toString(36).slice(2, 8)}`,
    name: `Bot ${index + 1}`,
    color: randomColor(),
    mouse: { x: 0, y: 0 },
    wantsSplit: false,
    wantsEject: false,
    cells: [randomSpawnCell()],
    alive: true,
    botIndex: index,
    brainTick: 0
  };
}

function isHuman(entity) {
  return entity.kind === "human";
}

function isBot(entity) {
  return entity.kind === "bot";
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
  while (chatMessages.length > MAX_CHAT_MESSAGES) chatMessages.shift();
  io.emit("chat", msg);
}

function getSessionUser(req) {
  const raw = req.session?.user;
  if (!raw?.id) return null;

  const row = db
    .prepare("SELECT id, username, credits FROM users WHERE id = ?")
    .get(raw.id);

  if (!row) return null;

  req.session.user = {
    id: row.id,
    username: row.username,
    credits: Number(row.credits || 0)
  };

  return req.session.user;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  req.user = user;
  next();
}

const insertCreditTransaction = db.prepare(`
  INSERT INTO credit_transactions (user_id, type, amount, note)
  VALUES (?, ?, ?, ?)
`);

const setUserCredits = db.prepare(`
  UPDATE users SET credits = ? WHERE id = ?
`);

const getUserByUsername = db.prepare(`
  SELECT id, username, password_hash, credits
  FROM users
  WHERE username = ?
`);

const getUserById = db.prepare(`
  SELECT id, username, credits
  FROM users
  WHERE id = ?
`);

const createUserWithBonus = db.transaction((username, passwordHash) => {
  const result = db
    .prepare("INSERT INTO users (username, password_hash, credits) VALUES (?, ?, ?)")
    .run(username, passwordHash, REGISTER_BONUS);

  insertCreditTransaction.run(
    result.lastInsertRowid,
    "register_bonus",
    REGISTER_BONUS,
    "Welcome bonus"
  );

  return result.lastInsertRowid;
});

const addCreditsTx = db.transaction((userId, amount, type, note) => {
  const current = getUserById.get(userId);
  if (!current) throw new Error("USER_NOT_FOUND");

  const nextCredits = Number(current.credits || 0) + Number(amount);
  setUserCredits.run(nextCredits, userId);
  insertCreditTransaction.run(userId, type, amount, note || null);
  return nextCredits;
});

const spendCreditsTx = db.transaction((userId, amount, type, note) => {
  const current = getUserById.get(userId);
  if (!current) throw new Error("USER_NOT_FOUND");

  const currentCredits = Number(current.credits || 0);
  if (currentCredits < amount) {
    const err = new Error("INSUFFICIENT_CREDITS");
    err.code = "INSUFFICIENT_CREDITS";
    throw err;
  }

  const nextCredits = currentCredits - Number(amount);
  setUserCredits.run(nextCredits, userId);
  insertCreditTransaction.run(userId, type, -Math.abs(amount), note || null);
  return nextCredits;
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (username.length < 3 || username.length > 20) {
      return res
        .status(400)
        .json({ error: "Username must be 3-20 characters." });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }

    const existing = getUserByUsername.get(username);
    if (existing) {
      return res.status(409).json({ error: "Username already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = createUserWithBonus(username, passwordHash);
    const user = getUserById.get(userId);

    req.session.user = {
      id: user.id,
      username: user.username,
      credits: Number(user.credits || 0)
    };
    req.session.gameEntryReady = false;

    res.json({
      ok: true,
      user: req.session.user,
      bonusCredits: REGISTER_BONUS
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

    const user = getUserByUsername.get(username);
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
    req.session.gameEntryReady = false;

    res.json({ ok: true, user: req.session.user });
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
  const user = getSessionUser(req);
  res.json({ user: user || null });
});

app.get("/api/balance", requireAuth, (req, res) => {
  res.json({ ok: true, wallet: Number(req.user.credits || 0) });
});

app.get("/api/credits/history", requireAuth, (req, res) => {
  const rows = db
    .prepare(`
      SELECT id, type, amount, note, created_at
      FROM credit_transactions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `)
    .all(req.user.id);

  res.json({ ok: true, items: rows });
});

app.post("/api/credits/add", requireAuth, (req, res) => {
  try {
    const amount = Number(req.body?.amount || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount." });
    }

    const wallet = addCreditsTx(
      req.user.id,
      amount,
      "manual_add",
      "Manual wallet top-up"
    );

    req.session.user.credits = wallet;
    res.json({ ok: true, wallet });
  } catch (err) {
    console.error("ADD CREDITS ERROR:", err);
    res.status(500).json({ error: "Failed to add balance." });
  }
});

app.post("/api/credits/withdraw", requireAuth, (req, res) => {
  try {
    const amount = Number(req.body?.amount || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount." });
    }

    const wallet = spendCreditsTx(
      req.user.id,
      amount,
      "withdraw_request",
      "Withdrawal request"
    );

    req.session.user.credits = wallet;
    res.json({ ok: true, wallet, status: "requested" });
  } catch (err) {
    if (err.code === "INSUFFICIENT_CREDITS") {
      return res.status(400).json({ error: "Not enough balance." });
    }

    console.error("WITHDRAW ERROR:", err);
    res
      .status(500)
      .json({ error: "Failed to create withdrawal request." });
  }
});

app.post("/api/payments/solana/quote", requireAuth, (req, res) => {
  const euros = Number(req.body?.euros || 0);

  if (!Number.isFinite(euros) || euros <= 0) {
    return res.status(400).json({ error: "Invalid amount." });
  }

  res.json({
    ok: true,
    euros,
    credits: euros,
    note: "1 euro = 1 wallet credit",
    message:
      "Quote only. On-chain Solana verification still needs to be implemented."
  });
});

app.post("/api/game/enter", requireAuth, (req, res) => {
  try {
    const alreadySocket = playerByUserId.get(req.user.id);
    if (alreadySocket && players.has(alreadySocket)) {
      return res.json({
        ok: true,
        alreadyInGame: true,
        wallet: Number(req.user.credits || 0)
      });
    }

    const wallet = spendCreditsTx(
      req.user.id,
      GAME_ENTRY_COST,
      "game_entry",
      "Entered a match"
    );

    req.session.user.credits = wallet;
    req.session.gameEntryReady = true;

    req.session.save((err) => {
      if (err) {
        console.error("SESSION SAVE ERROR:", err);
        return res.status(500).json({ error: "Failed to save game session." });
      }

      res.json({
        ok: true,
        wallet,
        cost: GAME_ENTRY_COST
      });
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_CREDITS") {
      return res.status(400).json({ error: "You need at least 1 credit to play." });
    }

    console.error("GAME ENTER ERROR:", err);
    res.status(500).json({ error: "Failed to enter the game." });
  }
});

app.get("/debug/players", (req, res) => {
  res.json({
    playerCount: players.size,
    botCount: bots.length,
    players: [...players.values()].map((p) => ({
      id: p.id,
      userId: p.userId,
      name: p.name,
      totalMass: Math.round(totalMass(p)),
      cells: p.cells.length
    })),
    bots: bots.map((b) => ({
      id: b.id,
      name: b.name,
      totalMass: Math.round(totalMass(b)),
      cells: b.cells.length
    })),
    food: food.length,
    chatMessages: chatMessages.length,
    dbPath: DB_PATH
  });
});

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

function respawnMissingBots() {
  while (bots.length < BOT_COUNT) {
    bots.push(createBot(bots.length));
  }
}

function moveEntity(entity) {
  for (const cell of entity.cells) {
    const speed = 2.9 / Math.pow(cell.mass, 0.16);
    const len = Math.hypot(entity.mouse.x, entity.mouse.y) || 1;
    const dirX = entity.mouse.x / len;
    const dirY = entity.mouse.y / len;
    const distFactor = Math.min(len / 220, 1);

    cell.vx += dirX * speed * distFactor;
    cell.vy += dirY * speed * distFactor;

    cell.vx *= 0.89;
    cell.vy *= 0.89;

    cell.x += cell.vx;
    cell.y += cell.vy;

    if (cell.mergeTimer > 0) cell.mergeTimer--;
  }

  for (let i = 0; i < entity.cells.length; i++) {
    for (let j = i + 1; j < entity.cells.length; j++) {
      const a = entity.cells[i];
      const b = entity.cells[j];
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

  for (const cell of entity.cells) {
    const r = radiusFromMass(cell.mass);
    const bound = WORLD_SIZE / 2 - r;
    cell.x = clamp(cell.x, -bound, bound);
    cell.y = clamp(cell.y, -bound, bound);
  }
}

function splitEntity(entity) {
  if (!entity.wantsSplit) return;
  entity.wantsSplit = false;

  if (entity.cells.length >= MAX_CELLS) return;

  const len = Math.hypot(entity.mouse.x, entity.mouse.y) || 1;
  const dirX = entity.mouse.x / len;
  const dirY = entity.mouse.y / len;
  const newCells = [];

  for (const cell of entity.cells) {
    if (cell.mass < 36) continue;
    if (entity.cells.length + newCells.length >= MAX_CELLS) break;

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

  entity.cells.push(...newCells);
}

function ejectMass(entity) {
  if (!entity.wantsEject) return;
  entity.wantsEject = false;

  const len = Math.hypot(entity.mouse.x, entity.mouse.y) || 1;
  const dirX = entity.mouse.x / len;
  const dirY = entity.mouse.y / len;

  for (const cell of entity.cells) {
    if (cell.mass <= 20) continue;
    cell.mass -= 1;

    food.push({
      id: Math.random().toString(36).slice(2),
      x: clamp(
        cell.x + dirX * (radiusFromMass(cell.mass) + 20),
        -WORLD_SIZE / 2,
        WORLD_SIZE / 2
      ),
      y: clamp(
        cell.y + dirY * (radiusFromMass(cell.mass) + 20),
        -WORLD_SIZE / 2,
        WORLD_SIZE / 2
      ),
      r: 8,
      color: entity.color,
      mass: 1
    });
  }
}

function handleFoodEating(entity) {
  for (const cell of entity.cells) {
    const r = radiusFromMass(cell.mass);
    const rr = (r + 8) * (r + 8);

    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      if (Math.abs(cell.x - f.x) > 120 || Math.abs(cell.y - f.y) > 120) continue;

      if (distanceSq(cell.x, cell.y, f.x, f.y) < rr) {
        cell.mass += f.mass;
        food.splice(i, 1);
      }
    }
  }

  while (food.length < FOOD_COUNT) {
    food.push(createFood());
  }
}

function splitByVirus(entity, cellIndex, virusIndex) {
  const cell = entity.cells[cellIndex];
  if (!cell) return;
  if (entity.cells.length >= MAX_CELLS) return;

  const piecesWanted = Math.min(
    MAX_CELLS - entity.cells.length + 1,
    Math.max(2, Math.min(8, Math.floor(cell.mass / 18)))
  );

  if (piecesWanted < 2) return;

  const partMass = cell.mass / piecesWanted;
  cell.mass = partMass;
  cell.mergeTimer = 300;

  for (let i = 1; i < piecesWanted; i++) {
    const ang = (Math.PI * 2 * i) / piecesWanted;
    entity.cells.push({
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

function handleVirusCollisions(entity) {
  for (let v = viruses.length - 1; v >= 0; v--) {
    const virus = viruses[v];

    for (let c = entity.cells.length - 1; c >= 0; c--) {
      const cell = entity.cells[c];
      const r = radiusFromMass(cell.mass);

      if (
        cell.mass >= 36 &&
        distance(cell.x, cell.y, virus.x, virus.y) < r - virus.r * 0.15
      ) {
        splitByVirus(entity, c, v);
        break;
      }
    }
  }
}

function handleSelfMerge(entity) {
  if (entity.cells.length <= 1) return;

  for (let i = 0; i < entity.cells.length; i++) {
    for (let j = i + 1; j < entity.cells.length; j++) {
      const a = entity.cells[i];
      const b = entity.cells[j];
      const d = distance(a.x, a.y, b.x, b.y);

      if (
        a.mergeTimer <= 0 &&
        b.mergeTimer <= 0 &&
        d < Math.max(radiusFromMass(a.mass), radiusFromMass(b.mass)) * 0.6
      ) {
        a.mass += b.mass;
        entity.cells.splice(j, 1);
        j--;
      }
    }
  }
}

function botThink(bot) {
  if (!bot.cells.length) return;

  const center = entityCenter(bot);
  const biggestMass = Math.max(...bot.cells.map((c) => c.mass));

  let moveX = rand(-100, 100);
  let moveY = rand(-100, 100);

  for (const player of players.values()) {
    if (!player.cells.length) continue;

    const pc = entityCenter(player);
    const d = distance(center.x, center.y, pc.x, pc.y);

    if (d < 1100) {
      moveX += (center.x - pc.x) * 2.2;
      moveY += (center.y - pc.y) * 2.2;
    }
  }

  for (const other of bots) {
    if (other.id === bot.id || !other.cells.length) continue;

    const oc = entityCenter(other);
    const d = distance(center.x, center.y, oc.x, oc.y) || 1;
    const otherMass = totalMass(other);

    if (otherMass > biggestMass * 1.08 && d < 1200) {
      moveX += (center.x - oc.x) * 1.8;
      moveY += (center.y - oc.y) * 1.8;
    } else if (biggestMass > otherMass * 1.18 && d < 1800) {
      moveX += (oc.x - center.x) * 1.2;
      moveY += (oc.y - center.y) * 1.2;
    }
  }

  let nearestFood = null;
  let nearestFoodDist = Infinity;

  for (const f of food) {
    const dx = f.x - center.x;
    const dy = f.y - center.y;
    const dsq = dx * dx + dy * dy;

    if (dsq < nearestFoodDist && dsq < 260 * 260) {
      nearestFoodDist = dsq;
      nearestFood = f;
    }
  }

  if (nearestFood) {
    moveX += (nearestFood.x - center.x) * 0.45;
    moveY += (nearestFood.y - center.y) * 0.45;
  }

  bot.mouse.x = clamp(moveX, -1400, 1400);
  bot.mouse.y = clamp(moveY, -1400, 1400);
}

function eliminateHuman(player, eaterName) {
  const socket = io.sockets.sockets.get(player.id);

  if (socket) {
    socket.emit("dead", {
      by: eaterName || null,
      message: eaterName ? `You were eaten by ${eaterName}.` : "You died."
    });
  }

  player.alive = false;
  players.delete(player.id);

  if (player.userId) {
    playerByUserId.delete(player.userId);
  }

  const req = socket?.request;
  if (req?.session) {
    req.session.gameEntryReady = false;
    req.session.save(() => {});
  }
}

function respawnBotAtIndex(index) {
  bots[index] = createBot(index);
}

function eliminateBot(botIndex) {
  respawnBotAtIndex(botIndex);
}

function handleEntityVsEntity() {
  const livingHumans = [...players.values()];
  const livingBots = bots.filter((b) => b.cells.length > 0);
  const all = [...livingHumans, ...livingBots];

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];

      if (!a.cells.length || !b.cells.length) continue;

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

            if (b.cells.length === 0) {
              if (isHuman(b)) eliminateHuman(b, a.name);
              else if (isBot(b)) eliminateBot(b.botIndex);
            }
          } else if (bc.mass > ac.mass * 1.12 && d < br - ar * 0.3) {
            bc.mass += ac.mass;
            a.cells.splice(ai, 1);

            if (a.cells.length === 0) {
              if (isHuman(a)) eliminateHuman(a, b.name);
              else if (isBot(a)) eliminateBot(a.botIndex);
            }

            break;
          }
        }
      }
    }
  }
}

function buildLeaderboard() {
  const all = [
    ...[...players.values()].filter((p) => p.cells.length > 0),
    ...bots.filter((b) => b.cells.length > 0)
  ];

  return all
    .map((entity) => ({
      name: entity.name,
      mass: Math.round(totalMass(entity))
    }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10);
}

function buildSnapshotFor(targetPlayer) {
  const center = entityCenter(targetPlayer);
  const total = totalMass(targetPlayer);

  const biggestCellMass = targetPlayer.cells.length
    ? Math.max(...targetPlayer.cells.map((c) => c.mass))
    : total;

  const biggestRadius = radiusFromMass(biggestCellMass || START_MASS);
  const visibleRadius = Math.max(2100, biggestRadius * 6 + SNAPSHOT_PADDING);

  const visibleFood = [];
  for (const f of food) {
    if (
      Math.abs(f.x - center.x) <= visibleRadius &&
      Math.abs(f.y - center.y) <= visibleRadius
    ) {
      visibleFood.push(f);
    }
  }

  const visibleViruses = [];
  for (const v of viruses) {
    if (
      Math.abs(v.x - center.x) <= visibleRadius &&
      Math.abs(v.y - center.y) <= visibleRadius
    ) {
      visibleViruses.push(v);
    }
  }

  const visiblePlayers = [];
  const all = [...players.values(), ...bots];

  for (const entity of all) {
    if (!entity.cells.length) continue;

    const pCenter = entityCenter(entity);

    if (
      entity.id !== targetPlayer.id &&
      Math.abs(pCenter.x - center.x) > visibleRadius &&
      Math.abs(pCenter.y - center.y) > visibleRadius
    ) {
      continue;
    }

    visiblePlayers.push({
      id: entity.id,
      name: entity.name,
      color: entity.color,
      totalMass: Math.round(totalMass(entity)),
      isBot: isBot(entity),
      cells: entity.cells.map((c) => ({
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
    wallet: getUserById.get(targetPlayer.userId)?.credits ?? 0,
    debugPlayerCount: players.size,
    debugBotCount: bots.length
  };
}

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("join", (payload) => {
    try {
      const req = socket.request;
      const sessionUser = req.session?.user;

      if (!sessionUser?.id) {
        socket.emit("joinError", { error: "You must be logged in." });
        return;
      }

      const freshUser = getUserById.get(sessionUser.id);
      if (!freshUser) {
        socket.emit("joinError", { error: "User not found." });
        return;
      }

      const existingSocketId = playerByUserId.get(freshUser.id);
      if (
        existingSocketId &&
        existingSocketId !== socket.id &&
        players.has(existingSocketId)
      ) {
        socket.emit("joinError", { error: "You are already in a match." });
        return;
      }

      if (!req.session.gameEntryReady) {
        socket.emit("joinError", {
          error: "Enter the game from the menu first."
        });
        return;
      }

      const player = createHumanPlayer(socket.id, freshUser, payload);
      players.set(socket.id, player);
      playerByUserId.set(freshUser.id, socket.id);

      req.session.gameEntryReady = false;
      req.session.save(() => {});

      socket.emit("chatHistory", chatMessages);
      socket.emit("joined", { ok: true, id: socket.id });

      addChatMessage("SERVER", `${player.name} joined the game`);
    } catch (err) {
      console.error("JOIN ERROR:", err);
      socket.emit("joinError", { error: "Failed to join the match." });
    }
  });

  socket.on("chat", (text) => {
    const player = players.get(socket.id);
    if (!player) return;
    addChatMessage(player.name, text);
  });

  socket.on("input", (input) => {
    const player = players.get(socket.id);
    if (!player) return;

    if (typeof input?.mouseX === "number") player.mouse.x = input.mouseX;
    if (typeof input?.mouseY === "number") player.mouse.y = input.mouseY;
    if (input?.split) player.wantsSplit = true;
    if (input?.eject) player.wantsEject = true;
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);

    if (player) {
      addChatMessage("SERVER", `${player.name} left the game`);
      players.delete(socket.id);

      if (player.userId) {
        playerByUserId.delete(player.userId);
      }
    }

    if (socket.request?.session) {
      socket.request.session.gameEntryReady = false;
      socket.request.session.save(() => {});
    }

    console.log("socket disconnected:", socket.id);
  });
});

function tick() {
  respawnMissingBots();

  for (const bot of bots) {
    botThink(bot);
  }

  for (const entity of [...players.values(), ...bots]) {
    if (!entity.cells.length) continue;

    moveEntity(entity);
    splitEntity(entity);
    ejectMass(entity);
    handleFoodEating(entity);
    handleVirusCollisions(entity);
    handleSelfMerge(entity);
  }

  handleEntityVsEntity();

  while (food.length < FOOD_COUNT) food.push(createFood());
  while (viruses.length < VIRUS_COUNT) viruses.push(createVirus());
  respawnMissingBots();

  for (const [id, player] of players.entries()) {
    const socket = io.sockets.sockets.get(id);
    if (!socket) continue;
    socket.volatile.emit("state", buildSnapshotFor(player));
  }
}

resetWorldObjects();
respawnMissingBots();

setInterval(() => {
  try {
    tick();
  } catch (err) {
    console.error("GAME LOOP ERROR:", err);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Using database: ${DB_PATH}`);
});
