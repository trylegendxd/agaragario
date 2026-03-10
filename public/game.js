const socket = io();

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const menu = document.getElementById("menu");
const playBtn = document.getElementById("playBtn");
const nameInput = document.getElementById("nameInput");
const massValue = document.getElementById("massValue");
const leaderboardEntries = document.getElementById("leaderboardEntries");

let W = canvas.width = window.innerWidth;
let H = canvas.height = window.innerHeight;

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
  zoom: 1
};

function radiusFromMass(mass) {
  return Math.sqrt(mass) * 4.8;
}

function worldToScreen(x, y) {
  return {
    x: (x - state.cameraX) * state.zoom + W / 2,
    y: (y - state.cameraY) * state.zoom + H / 2
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
  const viewPad = 20;
  const left = state.cameraX - W / (2 * state.zoom) - viewPad;
  const right = state.cameraX + W / (2 * state.zoom) + viewPad;
  const top = state.cameraY - H / (2 * state.zoom) - viewPad;
  const bottom = state.cameraY + H / (2 * state.zoom) + viewPad;

  for (const f of state.food) {
    if (f.x < left || f.x > right || f.y < top || f.y > bottom) continue;
    const s = worldToScreen(f.x, f.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, f.r * state.zoom, 0, Math.PI * 2);
    ctx.fillStyle = f.color;
    ctx.fill();
  }
}

function drawViruses() {
  const viewPad = 80;
  const left = state.cameraX - W / (2 * state.zoom) - viewPad;
  const right = state.cameraX + W / (2 * state.zoom) + viewPad;
  const top = state.cameraY - H / (2 * state.zoom) - viewPad;
  const bottom = state.cameraY + H / (2 * state.zoom) + viewPad;

  for (const virus of state.viruses) {
    if (virus.x < left || virus.x > right || virus.y < top || virus.y > bottom) continue;

    const s = worldToScreen(virus.x, virus.y);
    const rr = virus.r * state.zoom;
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

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (r > 18) {
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
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
    const total = p.cells.reduce((sum, c) => sum + c.mass, 0);
    let sx = 0;
    let sy = 0;
    for (const c of p.cells) {
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

playBtn.addEventListener("click", () => {
  socket.emit("join", nameInput.value.trim() || "Player");
  menu.style.display = "none";
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    socket.emit("join", nameInput.value.trim() || "Player");
    menu.style.display = "none";
  }
});

socket.on("connect", () => {
  state.connected = true;
  state.myId = socket.id;
});

socket.on("state", (serverState) => {
  state.worldSize = serverState.worldSize;
  state.food = serverState.food;
  state.viruses = serverState.viruses;
  state.players = serverState.players;
  state.leaderboard = serverState.leaderboard;
});

setInterval(() => {
  if (!state.connected) return;

  socket.emit("input", {
    mouseX: state.mouseX,
    mouseY: state.mouseY,
    split: state.splitQueued,
    eject: state.ejectQueued
  });

  state.splitQueued = false;
  state.ejectQueued = false;
}, 1000 / 30);

function loop() {
  updateCamera();
  render();
  requestAnimationFrame(loop);
}

loop();