const socket = io();

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const menu = document.getElementById("menu");
const playBtn = document.getElementById("playBtn");
const nameInput = document.getElementById("nameInput");
const massValue = document.getElementById("massValue");
const leaderboardEntries = document.getElementById("leaderboardEntries");

let W = (canvas.width = window.innerWidth);
let H = (canvas.height = window.innerHeight);

window.addEventListener("resize", () => {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
});

const state = {
  connected: false,
  worldSize: 12000,
  food: [],
  viruses: [],
  players: [],
  leaderboard: [],
  myId: null,
  mouseX: 0,
  mouseY: 0,
  splitQueued: false,
  ejectQueued: false,
  cameraX: 0,
  cameraY: 0,
  zoom: 1,
};

const snapshots = [];
const INTERPOLATION_DELAY = 100;

function radiusFromMass(mass) {
  return Math.sqrt(mass) * 4.8;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function worldToScreen(x, y) {
  return {
    x: (x - state.cameraX) * state.zoom + W / 2,
    y: (y - state.cameraY) * state.zoom + H / 2,
  };
}

function getMyPlayer() {
  return state.players.find((p) => p.id === state.myId) || null;
}

function getMyCenter() {
  const me = getMyPlayer();
  if (!me || !me.cells.length) return { x: 0, y: 0 };

  let total = 0;
  let sx = 0;
  let sy = 0;

  for (const cell of me.cells) {
    total += cell.mass;
    sx += cell.x * cell.mass;
    sy += cell.y * cell.mass;
  }

  return { x: sx / total, y: sy / total };
}

function getMyTotalMass() {
  const me = getMyPlayer();
  if (!me) return 0;
  return me.cells.reduce((sum, c) => sum + c.mass, 0);
}

function updateCamera() {
  const me = getMyPlayer();
  if (!me || !me.cells.length) return;

  const center = getMyCenter();
  const totalMass = getMyTotalMass();
  const biggestCellMass = Math.max(...me.cells.map((c) => c.mass));
  const biggestRadius = radiusFromMass(biggestCellMass);

  state.cameraX += (center.x - state.cameraX) * 0.12;
  state.cameraY += (center.y - state.cameraY) * 0.12;

  const fitZoomX = (W * 0.22) / Math.max(biggestRadius, 1);
  const fitZoomY = (H * 0.22) / Math.max(biggestRadius, 1);
  const fitZoom = Math.min(fitZoomX, fitZoomY);
  const massZoom = 1.1 / Math.pow(Math.max(totalMass, 20), 0.16);
  const targetZoom = Math.min(fitZoom, massZoom);

  state.zoom += (targetZoom - state.zoom) * 0.12;
  state.zoom = Math.max(0.02, Math.min(1.2, state.zoom));
}

function drawGrid() {
  const grid = 50 * state.zoom;
  if (grid < 8) return;

  const offsetX = ((-state.cameraX * state.zoom) % grid + grid) % grid;
  const offsetY = ((-state.cameraY * state.zoom) % grid + grid) % grid;

  ctx.strokeStyle = "#eeeeee";
  ctx.lineWidth = 1;

  for (let x = offsetX; x <= W; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  for (let y = offsetY; y <= H; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const left = (-state.worldSize / 2 - state.cameraX) * state.zoom + W / 2;
  const top = (-state.worldSize / 2 - state.cameraY) * state.zoom + H / 2;
  const size = state.worldSize * state.zoom;

  ctx.strokeStyle = "#cfcfcf";
  ctx.lineWidth = 3;
  ctx.strokeRect(left, top, size, size);
}

function drawFood() {
  for (const f of state.food) {
    const s = worldToScreen(f.x, f.y);
    const rr = f.r * state.zoom;

    if (s.x < -rr || s.x > W + rr || s.y < -rr || s.y > H + rr) continue;

    ctx.beginPath();
    ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = f.color;
    ctx.fill();
  }
}

function drawViruses() {
  for (const virus of state.viruses) {
    const s = worldToScreen(virus.x, virus.y);
    const rr = virus.r * state.zoom;
    if (s.x < -rr * 1.5 || s.x > W + rr * 1.5 || s.y < -rr * 1.5 || s.y > H + rr * 1.5) {
      continue;
    }

    const spikes = 18;

    ctx.beginPath();
    for (let i = 0; i <= spikes; i++) {
      const a = (i / spikes) * Math.PI * 2;
      const rad = rr * (i % 2 === 0 ? 1.14 : 0.88);
      const px = s.x + Math.cos(a) * rad;
      const py = s.y + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = "#33d65c";
    ctx.fill();
    ctx.strokeStyle = "#239842";
    ctx.lineWidth = Math.max(1, 2 * state.zoom);
    ctx.stroke();
  }
}

function drawPlayers() {
  const sorted = [...state.players].sort((a, b) => {
    const am = a.cells.reduce((s, c) => s + c.mass, 0);
    const bm = b.cells.reduce((s, c) => s + c.mass, 0);
    return am - bm;
  });

  for (const player of sorted) {
    for (const cell of player.cells) {
      const s = worldToScreen(cell.x, cell.y);
      const r = radiusFromMass(cell.mass) * state.zoom;

      if (s.x < -r * 2 || s.x > W + r * 2 || s.y < -r * 2 || s.y > H + r * 2) continue;

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (r > 18) {
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${Math.max(12, r * 0.28)}px Arial`;
        ctx.fillText(player.name, s.x, s.y - 2);
        ctx.font = `${Math.max(10, r * 0.2)}px Arial`;
        ctx.fillText(Math.floor(cell.mass), s.x, s.y + 16);
      }
    }
  }
}

function drawMinimap() {
  const mapW = 170;
  const mapH = 170;
  const x = W - mapW - 16;
  const y = H - mapH - 16;

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(x, y, mapW, mapH);
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, mapW, mapH);

  for (const virus of state.viruses) {
    const mx = x + ((virus.x + state.worldSize / 2) / state.worldSize) * mapW;
    const my = y + ((virus.y + state.worldSize / 2) / state.worldSize) * mapH;
    ctx.fillStyle = "#33d65c";
    ctx.fillRect(mx - 1, my - 1, 3, 3);
  }

  for (const p of state.players) {
    if (!p.cells.length) continue;

    let total = 0;
    let sx = 0;
    let sy = 0;

    for (const c of p.cells) {
      total += c.mass;
      sx += c.x * c.mass;
      sy += c.y * c.mass;
    }

    const centerX = sx / total;
    const centerY = sy / total;

    const mx = x + ((centerX + state.worldSize / 2) / state.worldSize) * mapW;
    const my = y + ((centerY + state.worldSize / 2) / state.worldSize) * mapH;

    ctx.fillStyle = p.id === state.myId ? "#33c3ff" : "#888";
    ctx.beginPath();
    ctx.arc(mx, my, p.id === state.myId ? 4 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function updateHud() {
  massValue.textContent = Math.floor(getMyTotalMass());
  leaderboardEntries.innerHTML = state.leaderboard
    .map((entry, i) => `<div>${i + 1}. ${entry.name} - ${entry.mass}</div>`)
    .join("");
}

function render() {
  ctx.clearRect(0, 0, W, H);
  drawGrid();
  drawFood();
  drawViruses();
  drawPlayers();
  drawMinimap();
  updateHud();
}

function cloneStateForSnapshot(serverState) {
  return {
    worldSize: serverState.worldSize,
    food: serverState.food.map((f) => ({ ...f })),
    viruses: serverState.viruses.map((v) => ({ ...v })),
    leaderboard: serverState.leaderboard.map((e) => ({ ...e })),
    players: serverState.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      totalMass: p.totalMass,
      cells: p.cells.map((c) => ({ ...c })),
    })),
  };
}

function interpolatePlayers(older, newer, alpha) {
  const oldMap = new Map(older.players.map((p) => [p.id, p]));
  const newMap = new Map(newer.players.map((p) => [p.id, p]));
  const out = [];

  for (const [id, newPlayer] of newMap) {
    const oldPlayer = oldMap.get(id) || newPlayer;

    out.push({
      ...newPlayer,
      cells: newPlayer.cells.map((newCell, i) => {
        const oldCell = oldPlayer.cells[i] || newCell;
        return {
          ...newCell,
          x: lerp(oldCell.x, newCell.x, alpha),
          y: lerp(oldCell.y, newCell.y, alpha),
        };
      }),
    });
  }

  return out;
}

function getInterpolatedState() {
  if (snapshots.length === 0) return null;
  if (snapshots.length === 1) return snapshots[0].state;

  const renderTime = Date.now() - INTERPOLATION_DELAY;

  let older = snapshots[0];
  let newer = snapshots[snapshots.length - 1];

  for (let i = 0; i < snapshots.length - 1; i++) {
    if (
      snapshots[i].time <= renderTime &&
      snapshots[i + 1].time >= renderTime
    ) {
      older = snapshots[i];
      newer = snapshots[i + 1];
      break;
    }
  }

  if (renderTime >= snapshots[snapshots.length - 1].time) {
    return snapshots[snapshots.length - 1].state;
  }

  const span = newer.time - older.time || 1;
  const alpha = Math.max(0, Math.min(1, (renderTime - older.time) / span));

  return {
    worldSize: newer.state.worldSize,
    food: newer.state.food,
    viruses: newer.state.viruses,
    leaderboard: newer.state.leaderboard,
    players: interpolatePlayers(older.state, newer.state, alpha),
  };
}

window.addEventListener("mousemove", (e) => {
  state.mouseX = e.clientX - W / 2;
  state.mouseY = e.clientY - H / 2;
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    state.splitQueued = true;
  }
  if (e.key === "w" || e.key === "W") {
    state.ejectQueued = true;
  }
});

function joinGame() {
  socket.emit("join", nameInput.value.trim() || "Player");
  menu.style.display = "none";
}

playBtn.addEventListener("click", joinGame);

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    joinGame();
  }
});

socket.on("connect", () => {
  state.connected = true;
  state.myId = socket.id;
});

socket.on("disconnect", () => {
  state.connected = false;
});

socket.on("state", (serverState) => {
  console.log("debugPlayerCount:", serverState.debugPlayerCount);
  snapshots.push({
    time: Date.now(),
    state: cloneStateForSnapshot(serverState),
  });

  while (snapshots.length > 10) {
    snapshots.shift();
  }
});

setInterval(() => {
  if (!state.connected) return;

  socket.emit("input", {
    mouseX: state.mouseX,
    mouseY: state.mouseY,
    split: state.splitQueued,
    eject: state.ejectQueued,
  });

  state.splitQueued = false;
  state.ejectQueued = false;
}, 1000 / 30);

function loop() {
  const interpolated = getInterpolatedState();

  if (interpolated) {
    state.worldSize = interpolated.worldSize;
    state.food = interpolated.food;
    state.viruses = interpolated.viruses;
    state.players = interpolated.players;
    state.leaderboard = interpolated.leaderboard;
  }

  updateCamera();
  render();
  requestAnimationFrame(loop);
}

loop();

