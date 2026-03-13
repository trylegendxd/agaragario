const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const EXTRACTION_HOLD_TICKS = 6 * TICK_RATE;
const EXTRACTION_PAYOUT_RATE = 0.95;

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

const WORLD_SIZE = 12000;
const WORLD_RADIUS = WORLD_SIZE / 2;
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
const BOT_FOOD_CAP = 200;

const SPLIT_MERGE_DELAY_TICKS = 35 * TICK_RATE;
const SPLIT_LAUNCH_SPEED = 34;
const EJECT_LAUNCH_DISTANCE = 100;
const EJECT_LAUNCH_SPEED = 26;
const TOUCH_SEPARATION_FACTOR = 1.0;
const PREMERGE_ATTRACTION_FACTOR = 0.006;
const POSTMERGE_ATTRACTION_FACTOR = 0.04;
const EJECT_ORB_MASS = START_MASS;
const EXTRACTION_HOLD_TICKS = 6 * TICK_RATE;
const EXTRACTION_PAYOUT_RATE = 0.95;

const players = new Map();
const playerByUserId = new Map();
const food = [];
const viruses = [];
const bots = [];
const chatMessages = [];

function radiusFromMass(mass) {
  return Math.sqrt(mass) * 4.8;
}

const EJECT_ORB_RADIUS = radiusFromMass(EJECT_ORB_MASS);

const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
});

app.use(express.json());
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      credits NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id
    ON credit_transactions(user_id)
  `);
}

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

function randomColor() {
  const hue = Math.floor(rand(0, 360));
  return `hsl(${hue}, 80%, 58%)`;
}

function randomSpawnCell() {
  const p = randomPointInCircle(WORLD_RADIUS - 400);
  return {
    x: p.x,
    y: p.y,
    mass: START_MASS,
    vx: 0,
    vy: 0,
    mergeTimer: 0
  };
}

function createFood() {
  const p = randomPointInCircle(WORLD_RADIUS - 8);
  return {
    id: Math.random().toString(36).slice(2),
    x: p.x,
    y: p.y,
    vx: 0,
    vy: 0,
    r: 8,
    color: `hsl(${Math.floor(rand(0, 360))},85%,60%)`,
    mass: 1
  };
}

function createVirus() {
  const p = randomPointInCircle(WORLD_RADIUS - 48);
  return {
    id: Math.random().toString(36).slice(2),
    x: p.x,
    y: p.y,
    r: 48
  };
}

function randomPointInCircle(maxRadius) {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * maxRadius;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

function clampToWorldCircle(x, y, radius = 0) {
  const maxDist = Math.max(0, WORLD_RADIUS - radius);
  const dist = Math.hypot(x, y) || 1;

  if (dist <= maxDist) {
    return { x, y };
  }

  const scale = maxDist / dist;
  return {
    x: x * scale,
    y: y * scale
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
  userId: Number(user.id),
  username: user.username,
  name: safeName,
  color: requestedColor || randomColor(),
  mouse: { x: 0, y: 0 },
  wantsSplit: false,
  wantsEject: false,
  wantsExtract: false,
  extracting: false,
  extractTicks: 0,
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
    cashValue: 0,
    cells: [randomSpawnCell()],
    alive: true,
    botIndex: index
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

async function getUserByUsername(username) {
  const { rows } = await pool.query(
    `
    SELECT id, username, password_hash, credits
    FROM users
    WHERE username = $1
    `,
    [username]
  );

  if (!rows[0]) return null;

  return {
    id: Number(rows[0].id),
    username: rows[0].username,
    password_hash: rows[0].password_hash,
    credits: Number(rows[0].credits || 0)
  };
}

async function completeExtraction(player) {
  const socket = io.sockets.sockets.get(player.id);
  if (!player || !socket) return;

  const totalValue = Number(player.cashValue || 0);
  const payout = Number((totalValue * EXTRACTION_PAYOUT_RATE).toFixed(2));

  try {
    if (payout > 0) {
      const wallet = await addCreditsTx(
        player.userId,
        payout,
        "extraction_payout",
        `Extracted from match (${Math.round(EXTRACTION_PAYOUT_RATE * 100)}% payout)`
      );

      if (socket.request?.session?.user) {
        socket.request.session.user.credits = wallet;
      }
    }

    players.delete(player.id);
    if (player.userId) {
      playerByUserId.delete(player.userId);
    }

    if (socket.request?.session) {
      socket.request.session.gameEntryReady = false;
      socket.request.session.save(() => {});
    }

    socket.emit("extracted", {
      payout,
      kept: totalValue,
      message: `You extracted ${payout.toFixed(2)} back to your wallet.`
    });

    addChatMessage("SERVER", `${player.name} extracted from the match`);
  } catch (err) {
    console.error("EXTRACTION ERROR:", err);
    socket.emit("extractFailed", { error: "Failed to extract." });
    player.extracting = false;
    player.extractTicks = 0;
    player.wantsExtract = false;
  }
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `
    SELECT id, username, credits
    FROM users
    WHERE id = $1
    `,
    [id]
  );

  if (!rows[0]) return null;

  return {
    id: Number(rows[0].id),
    username: rows[0].username,
    credits: Number(rows[0].credits || 0)
  };
}

async function createUserWithBonus(username, passwordHash) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const insertUser = await client.query(
      `
      INSERT INTO users (username, password_hash, credits)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [username, passwordHash, REGISTER_BONUS]
    );

    const userId = Number(insertUser.rows[0].id);

    await client.query(
      `
      INSERT INTO credit_transactions (user_id, type, amount, note)
      VALUES ($1, $2, $3, $4)
      `,
      [userId, "register_bonus", REGISTER_BONUS, "Welcome bonus"]
    );

    await client.query("COMMIT");
    return userId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function addCreditsTx(userId, amount, type, note) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const currentRes = await client.query(
      `SELECT id, credits FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (!currentRes.rows[0]) {
      throw new Error("USER_NOT_FOUND");
    }

    const currentCredits = Number(currentRes.rows[0].credits || 0);
    const nextCredits = currentCredits + Number(amount);

    await client.query(`UPDATE users SET credits = $1 WHERE id = $2`, [
      nextCredits,
      userId
    ]);

    await client.query(
      `
      INSERT INTO credit_transactions (user_id, type, amount, note)
      VALUES ($1, $2, $3, $4)
      `,
      [userId, type, amount, note || null]
    );

    await client.query("COMMIT");
    return nextCredits;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function spendCreditsTx(userId, amount, type, note) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const currentRes = await client.query(
      `SELECT id, credits FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (!currentRes.rows[0]) {
      throw new Error("USER_NOT_FOUND");
    }

    const currentCredits = Number(currentRes.rows[0].credits || 0);
    if (currentCredits < amount) {
      const err = new Error("INSUFFICIENT_CREDITS");
      err.code = "INSUFFICIENT_CREDITS";
      throw err;
    }

    const nextCredits = currentCredits - Number(amount);

    await client.query(`UPDATE users SET credits = $1 WHERE id = $2`, [
      nextCredits,
      userId
    ]);

    await client.query(
      `
      INSERT INTO credit_transactions (user_id, type, amount, note)
      VALUES ($1, $2, $3, $4)
      `,
      [userId, type, -Math.abs(amount), note || null]
    );

    await client.query("COMMIT");
    return nextCredits;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getSessionUser(req) {
  const raw = req.session?.user;
  if (!raw?.id) return null;

  const row = await getUserById(raw.id);
  if (!row) return null;

  req.session.user = {
    id: row.id,
    username: row.username,
    credits: Number(row.credits || 0)
  };

  return req.session.user;
}

async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: "You must be logged in." });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    res.status(500).json({ error: "Authentication failed." });
  }
}

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

    const existing = await getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: "Username already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = await createUserWithBonus(username, passwordHash);
    const user = await getUserById(userId);

    req.session.user = {
      id: user.id,
      username: user.username,
      credits: Number(user.credits || 0)
    };
    req.session.gameEntryReady = false;

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("REGISTER SESSION SAVE ERROR:", saveErr);
        return res.status(500).json({ error: "Failed to register." });
      }

      res.json({
        ok: true,
        user: req.session.user,
        bonusCredits: REGISTER_BONUS
      });
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

    const user = await getUserByUsername(username);
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

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("LOGIN SESSION SAVE ERROR:", saveErr);
        return res.status(500).json({ error: "Failed to log in." });
      }

      res.json({ ok: true, user: req.session.user });
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

app.get("/api/me", async (req, res) => {
  try {
    const user = await getSessionUser(req);
    res.json({ user: user || null });
  } catch (err) {
    console.error("ME ERROR:", err);
    res.status(500).json({ user: null });
  }
});

app.get("/api/balance", requireAuth, (req, res) => {
  res.json({ ok: true, wallet: Number(req.user.credits || 0) });
});

app.get("/api/credits/history", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT id, type, amount, note, created_at
      FROM credit_transactions
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT 50
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      items: rows.map((row) => ({
        id: Number(row.id),
        type: row.type,
        amount: Number(row.amount),
        note: row.note,
        created_at: row.created_at
      }))
    });
  } catch (err) {
    console.error("CREDITS HISTORY ERROR:", err);
    res.status(500).json({ error: "Failed to load history." });
  }
});

app.post("/api/credits/add", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount." });
    }

    const wallet = await addCreditsTx(
      req.user.id,
      amount,
      "manual_add",
      "Manual wallet top-up"
    );

    req.session.user.credits = wallet;
    req.session.save(() => {});
    res.json({ ok: true, wallet });
  } catch (err) {
    console.error("ADD CREDITS ERROR:", err);
    res.status(500).json({ error: "Failed to add balance." });
  }
});

app.post("/api/credits/withdraw", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount || 0);
    const address = String(req.body?.address || "").trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount." });
    }

    if (!address) {
      return res.status(400).json({ error: "Missing Solana wallet address." });
    }

    const wallet = await spendCreditsTx(
      req.user.id,
      amount,
      "withdraw_request",
      `Withdrawal request to ${address}`
    );

    req.session.user.credits = wallet;
    req.session.save(() => {});
    res.json({ ok: true, wallet, status: "requested" });
  } catch (err) {
    if (err.code === "INSUFFICIENT_CREDITS") {
      return res.status(400).json({ error: "Not enough balance." });
    }

    console.error("WITHDRAW ERROR:", err);
    res.status(500).json({ error: "Failed to create withdrawal request." });
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
    message: "Quote only. On-chain Solana verification still needs to be implemented."
  });
});

app.post("/api/game/enter", requireAuth, async (req, res) => {
  try {
    const freshUser = await getUserById(req.user.id);
    if (!freshUser) {
      return res.status(404).json({ error: "User not found." });
    }

    const existingSocketId = playerByUserId.get(req.user.id);
    if (existingSocketId && players.has(existingSocketId)) {
      return res.json({
        ok: true,
        alreadyInGame: true,
        wallet: Number(freshUser.credits || 0)
      });
    }

    if (Number(freshUser.credits || 0) < GAME_ENTRY_COST) {
      return res.status(400).json({
        error: "You need at least 1 credit to play."
      });
    }

    req.session.gameEntryReady = true;
    req.session.save((err) => {
      if (err) {
        console.error("SESSION SAVE ERROR:", err);
        return res.status(500).json({ error: "Failed to save game session." });
      }

      res.json({
        ok: true,
        wallet: Number(freshUser.credits || 0),
        cost: GAME_ENTRY_COST
      });
    });
  } catch (err) {
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
    chatMessages: chatMessages.length
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
  if (entity.extracting) {
  for (const cell of entity.cells) {
    cell.vx *= 0.6;
    cell.vy *= 0.6;
    cell.x += cell.vx;
    cell.y += cell.vy;

    if (cell.mergeTimer > 0) cell.mergeTimer--;
  }

  for (const cell of entity.cells) {
    const r = radiusFromMass(cell.mass);
    const bound = WORLD_SIZE / 2 - r;
    cell.x = clamp(cell.x, -bound, bound);
    cell.y = clamp(cell.y, -bound, bound);
  }

  return;
 }
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

      const ar = radiusFromMass(a.mass);
      const br = radiusFromMass(b.mass);
      const desiredSeparation = (ar + br) * TOUCH_SEPARATION_FACTOR;

      if (d < desiredSeparation) {
        const push = (desiredSeparation - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;

        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;

        const relVx = b.vx - a.vx;
        const relVy = b.vy - a.vy;
        const inwardSpeed = relVx * nx + relVy * ny;

        if (inwardSpeed < 0) {
          const correction = inwardSpeed * 0.5;
          a.vx += nx * correction;
          a.vy += ny * correction;
          b.vx -= nx * correction;
          b.vy -= ny * correction;
        }
      }

      if (d > desiredSeparation) {
        const nx = dx / d;
        const ny = dy / d;
        const attraction =
          a.mergeTimer > 0 || b.mergeTimer > 0
            ? PREMERGE_ATTRACTION_FACTOR
            : POSTMERGE_ATTRACTION_FACTOR;

        a.vx += nx * attraction;
        a.vy += ny * attraction;
        b.vx -= nx * attraction;
        b.vy -= ny * attraction;
      }
    }
  }

    for (const cell of entity.cells) {
    const r = radiusFromMass(cell.mass);
    const clamped = clampToWorldCircle(cell.x, cell.y, r);
    cell.x = clamped.x;
    cell.y = clamped.y;
  }
}

function updateExtraction(entity) {
  if (!isHuman(entity)) return;
  if (!entity.cells.length) return;

  if (entity.wantsExtract) {
    entity.extracting = true;
    entity.extractTicks += 1;
    entity.mouse.x = 0;
    entity.mouse.y = 0;
    entity.wantsSplit = false;
    entity.wantsEject = false;
  } else {
    entity.extracting = false;
    entity.extractTicks = 0;
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
    const spawnDistance = r * 3.4;

    newCells.push({
      x: cell.x + dirX * spawnDistance,
      y: cell.y + dirY * spawnDistance,
      mass: childMass,
      vx: dirX * SPLIT_LAUNCH_SPEED,
      vy: dirY * SPLIT_LAUNCH_SPEED,
      mergeTimer: SPLIT_MERGE_DELAY_TICKS
    });

    cell.vx -= dirX * 4;
    cell.vy -= dirY * 4;
    cell.mergeTimer = SPLIT_MERGE_DELAY_TICKS;
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
    if (cell.mass <= EJECT_ORB_MASS + 10) continue;

    cell.mass -= EJECT_ORB_MASS;

    const px = clamp(
      cell.x + dirX * (radiusFromMass(cell.mass) + EJECT_LAUNCH_DISTANCE),
      -WORLD_SIZE / 2,
      WORLD_SIZE / 2
    );
    const py = clamp(
      cell.y + dirY * (radiusFromMass(cell.mass) + EJECT_LAUNCH_DISTANCE),
      -WORLD_SIZE / 2,
      WORLD_SIZE / 2
    );

    food.push({
      id: Math.random().toString(36).slice(2),
      x: px,
      y: py,
      vx: dirX * EJECT_LAUNCH_SPEED,
      vy: dirY * EJECT_LAUNCH_SPEED,
      r: EJECT_ORB_RADIUS,
      color: entity.color,
      mass: EJECT_ORB_MASS
    });
  }
}

function moveEjectedFood() {
  for (const f of food) {
    if (typeof f.vx !== "number" || typeof f.vy !== "number") continue;

    f.x += f.vx;
    f.y += f.vy;

    f.vx *= 0.92;
    f.vy *= 0.92;

    const clamped = clampToWorldCircle(f.x, f.y, f.r || 8);
    f.x = clamped.x;
    f.y = clamped.y;

    if (Math.abs(f.vx) < 0.05) f.vx = 0;
    if (Math.abs(f.vy) < 0.05) f.vy = 0;
  }
}

function handleFoodEating(entity) {
  let botRemainingFoodGrowth = Infinity;

  if (isBot(entity)) {
    const currentMass = totalMass(entity);
    botRemainingFoodGrowth = Math.max(0, BOT_FOOD_CAP - currentMass);

    if (botRemainingFoodGrowth <= 0) {
      while (food.length < FOOD_COUNT) {
        food.push(createFood());
      }
      return;
    }
  }

  for (const cell of entity.cells) {
    const r = radiusFromMass(cell.mass);

    for (let i = food.length - 1; i >= 0; i--) {
      if (isBot(entity) && botRemainingFoodGrowth <= 0) break;

      const f = food[i];
      const fr = typeof f.r === "number" ? f.r : 8;
      const quickRange = r + fr + 24;

      if (Math.abs(cell.x - f.x) > quickRange || Math.abs(cell.y - f.y) > quickRange) {
        continue;
      }

      const eatDistSq = (r + fr) * (r + fr);

      if (distanceSq(cell.x, cell.y, f.x, f.y) < eatDistSq) {
        if (isBot(entity)) {
          const gain = Math.min(f.mass, botRemainingFoodGrowth);
          if (gain <= 0) continue;
          cell.mass += gain;
          botRemainingFoodGrowth -= gain;
        } else {
          cell.mass += f.mass;
        }

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
  cell.mergeTimer = SPLIT_MERGE_DELAY_TICKS;

  for (let i = 1; i < piecesWanted; i++) {
    const ang = (Math.PI * 2 * i) / piecesWanted;
    entity.cells.push({
      x: cell.x + Math.cos(ang) * 35,
      y: cell.y + Math.sin(ang) * 35,
      mass: partMass,
      vx: Math.cos(ang) * 22,
      vy: Math.sin(ang) * 22,
      mergeTimer: SPLIT_MERGE_DELAY_TICKS
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

      if (a.mergeTimer > 0 || b.mergeTimer > 0) continue;

      const d = distance(a.x, a.y, b.x, b.y);
      const ar = radiusFromMass(a.mass);
      const br = radiusFromMass(b.mass);

      if (d <= ar + br + 1) {
        a.mass += b.mass;
        a.vx = (a.vx + b.vx) * 0.5;
        a.vy = (a.vy + b.vy) * 0.5;
        entity.cells.splice(j, 1);
        j--;
      }
    }
  }
}

function botThink(bot) {
  if (!bot.cells.length) return;

  const center = entityCenter(bot);
  const botMass = totalMass(bot);

  let moveX = rand(-100, 100);
  let moveY = rand(-100, 100);

  for (const player of players.values()) {
    if (!player.cells.length) continue;

    const pc = entityCenter(player);
    const d = distance(center.x, center.y, pc.x, pc.y);
    const playerMass = totalMass(player);

    if (playerMass > botMass * 1.08 && d < 1300) {
      moveX += (center.x - pc.x) * 2.4;
      moveY += (center.y - pc.y) * 2.4;
    }
  }

  for (const other of bots) {
    if (other.id === bot.id || !other.cells.length) continue;

    const oc = entityCenter(other);
    const d = distance(center.x, center.y, oc.x, oc.y) || 1;
    const otherMass = totalMass(other);

    if (otherMass > botMass * 1.08 && d < 1300) {
      moveX += (center.x - oc.x) * 2.0;
      moveY += (center.y - oc.y) * 2.0;
    } else if (botMass > otherMass * 1.18 && d < 1800) {
      moveX += (oc.x - center.x) * 1.4;
      moveY += (oc.y - center.y) * 1.4;
    }
  }

  if (botMass < BOT_FOOD_CAP) {
    let nearestFood = null;
    let nearestFoodDist = Infinity;

    for (const f of food) {
      const dx = f.x - center.x;
      const dy = f.y - center.y;
      const dsq = dx * dx + dy * dy;

      if (dsq < nearestFoodDist && dsq < 320 * 320) {
        nearestFoodDist = dsq;
        nearestFood = f;
      }
    }

    if (nearestFood) {
      moveX += (nearestFood.x - center.x) * 0.55;
      moveY += (nearestFood.y - center.y) * 0.55;
    }
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
              a.cashValue = Number(a.cashValue || 0) + Number(b.cashValue || 0);
              b.cashValue = 0;

              if (isHuman(b)) eliminateHuman(b, a.name);
              else if (isBot(b)) eliminateBot(b.botIndex);
            }
          } else if (bc.mass > ac.mass * 1.12 && d < br - ar * 0.3) {
            bc.mass += ac.mass;
            a.cells.splice(ai, 1);

            if (a.cells.length === 0) {
              b.cashValue = Number(b.cashValue || 0) + Number(a.cashValue || 0);
              a.cashValue = 0;

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
      mass: Math.round(totalMass(entity)),
      value: Number(entity.cashValue || 0)
    }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10);
}

async function buildSnapshotFor(targetPlayer) {
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
      cashValue: Number(entity.cashValue || 0),
      extracting: !!entity.extracting,
      extractTicks: Number(entity.extractTicks || 0),
      isBot: isBot(entity),
      cells: entity.cells.map((c) => ({
        x: c.x,
        y: c.y,
        mass: c.mass
      }))
    });
  }

  visiblePlayers.sort((a, b) => a.totalMass - b.totalMass);

  const freshUser = await getUserById(targetPlayer.userId);

  return {
    worldSize: WORLD_SIZE,
    food: visibleFood,
    viruses: visibleViruses,
    players: visiblePlayers,
    leaderboard: buildLeaderboard(),
    wallet: freshUser?.credits ?? 0,
    debugPlayerCount: players.size,
    debugBotCount: bots.length
  };
}

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("join", async (payload) => {
    try {
      const req = socket.request;
      const sessionUser = req.session?.user;

      if (!sessionUser?.id) {
        socket.emit("joinError", { error: "You must be logged in." });
        return;
      }

      const freshUser = await getUserById(sessionUser.id);
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
        socket.emit("joinError", { error: "Enter the game from the menu first." });
        return;
      }

      if (Number(freshUser.credits || 0) < GAME_ENTRY_COST) {
        socket.emit("joinError", { error: "Not enough balance to play." });
        return;
      }

      const wallet = await spendCreditsTx(
        freshUser.id,
        GAME_ENTRY_COST,
        "game_entry",
        "Entered a match"
      );

      req.session.user = {
        id: freshUser.id,
        username: freshUser.username,
        credits: wallet
      };
      req.session.gameEntryReady = false;

      req.session.save(async (saveErr) => {
        if (saveErr) {
          console.error("SESSION SAVE ERROR AFTER JOIN:", saveErr);

          try {
            const refundedWallet = await addCreditsTx(
              freshUser.id,
              GAME_ENTRY_COST,
              "game_entry_refund",
              "Refund after failed join save"
            );

            req.session.user = {
              id: freshUser.id,
              username: freshUser.username,
              credits: refundedWallet
            };

            req.session.save(() => {});
          } catch (refundErr) {
            console.error("REFUND ERROR:", refundErr);
          }

          socket.emit("joinError", { error: "Failed to save session." });
          return;
        }

        const player = createHumanPlayer(
          socket.id,
          {
            id: freshUser.id,
            username: freshUser.username
          },
          payload
        );

        players.set(socket.id, player);
        playerByUserId.set(freshUser.id, socket.id);

        socket.emit("chatHistory", chatMessages);
        socket.emit("joined", {
          ok: true,
          wallet
        });

        addChatMessage("SERVER", `${player.name} joined the game`);
      });
    } catch (err) {
      console.error("JOIN ERROR:", err);

      if (err.code === "INSUFFICIENT_CREDITS") {
        socket.emit("joinError", { error: "Not enough balance to play." });
        return;
      }

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
    if (typeof input?.extracting === "boolean") player.wantsExtract = input.extracting;
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);

    if (player) {
      addChatMessage("SERVER", `${player.name} left the game`);
      players.delete(socket.id);

      if (player.userId) {
        playerByUserId.delete(player.userId);
      }

      if (socket.request?.session) {
        socket.request.session.gameEntryReady = false;
        socket.request.session.save(() => {});
      }
    }

    console.log("socket disconnected:", socket.id);
  });
});

async function tick() {
  respawnMissingBots();

  for (const bot of bots) {
    botThink(bot);
  }

  moveEjectedFood();

  for (const entity of [...players.values(), ...bots]) {
  if (!entity.cells.length) continue;

  updateExtraction(entity);
  moveEntity(entity);
  splitEntity(entity);
  ejectMass(entity);
  handleFoodEating(entity);
  handleVirusCollisions(entity);
  handleSelfMerge(entity);
}

const finishedExtractions = [...players.values()].filter(
  (p) => p.extracting && p.extractTicks >= EXTRACTION_HOLD_TICKS
);

for (const player of finishedExtractions) {
  await completeExtraction(player);
}

  handleEntityVsEntity();

  while (food.length < FOOD_COUNT) food.push(createFood());
  while (viruses.length < VIRUS_COUNT) viruses.push(createVirus());
  respawnMissingBots();

  for (const [id, player] of players.entries()) {
    const sock = io.sockets.sockets.get(id);
    if (!sock) continue;

    try {
      const snapshot = await buildSnapshotFor(player);
      sock.volatile.emit("state", snapshot);
    } catch (err) {
      console.error("SNAPSHOT ERROR:", err);
    }
  }
}

resetWorldObjects();
respawnMissingBots();

async function start() {
  await initDb();

  setInterval(() => {
    tick().catch((err) => {
      console.error("GAME LOOP ERROR:", err);
    });
  }, 1000 / TICK_RATE);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error("STARTUP ERROR:", err);
  process.exit(1);
});




