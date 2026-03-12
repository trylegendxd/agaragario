const socket = io();

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

const landingScreen = document.getElementById("landingScreen");
const startMenuBtn = document.getElementById("startMenuBtn");
const colorInput = document.getElementById("colorInput");
const moneyBg = document.getElementById("moneyBg");
const menuMoneyBg = document.getElementById("menuMoneyBg");

const menu = document.getElementById("menu");
const playBtn = document.getElementById("playBtn");
const nameInput = document.getElementById("nameInput");
const massValue = document.getElementById("massValue");
const leaderboardEntries = document.getElementById("leaderboardEntries");

const chatBox = document.getElementById("chatBox");
const chatMessagesEl = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");

const authPanel = document.getElementById("authPanel");
const authUsername = document.getElementById("authUsername");
const authPassword = document.getElementById("authPassword");
const registerBtn = document.getElementById("registerBtn");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const authStatus = document.getElementById("authStatus");

const walletPanel = document.getElementById("walletPanel");
const walletValue = document.getElementById("walletValue");
const walletAmountInput = document.getElementById("walletAmountInput");
const withdrawAddressInput = document.getElementById("withdrawAddressInput");
const addBalanceBtn = document.getElementById("addBalanceBtn");
const withdrawBtn = document.getElementById("withdrawBtn");
const walletStatus = document.getElementById("walletStatus");
const menuStatus = document.getElementById("menuStatus");

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
  wallet: 0
};

const snapshots = [];
const INTERPOLATION_DELAY = 16;
let isJoinInFlight = false;
let inMatch = false;
let chatOpen = false;
let currentUser = null;

function radiusFromMass(mass) {
  return Math.sqrt(mass) * 4.8;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, body = null) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin"
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok && !data.error) {
    data.error = `Request failed (${res.status})`;
  }

  return data;
}

function setAuthStatus(text, isError = false) {
  if (!authStatus) return;
  authStatus.textContent = text || "";
  authStatus.style.color = isError ? "#c62828" : "#2e7d32";
}

function setWalletStatus(text, isError = false) {
  if (!walletStatus) return;
  walletStatus.textContent = text || "";
  walletStatus.style.color = isError ? "#c62828" : "#2e7d32";
}

function setMenuStatus(text, isError = false) {
  if (!menuStatus) return;
  menuStatus.textContent = text || "";
  menuStatus.style.color = isError ? "#c62828" : "#2e7d32";
}

function formatMoney(value) {
  const num = Number(value || 0);
  return `$${num.toFixed(2)}`;
}

function showLandingOnly() {
  if (landingScreen) landingScreen.classList.remove("hidden");
  if (authPanel) authPanel.classList.add("hidden");
  if (menu) menu.classList.add("hidden");
}

function showLandingWithAuth() {
  if (landingScreen) landingScreen.classList.remove("hidden");
  if (authPanel) authPanel.classList.remove("hidden");
  if (menu) menu.classList.add("hidden");
}

function showMenu() {
  if (landingScreen) landingScreen.classList.add("hidden");
  if (authPanel) authPanel.classList.add("hidden");
  if (menu) menu.classList.remove("hidden");
}

function updateWalletUi(wallet) {
  state.wallet = Number(wallet || 0);
  if (walletValue) walletValue.textContent = formatMoney(state.wallet);
}

function setPlayButtonState(busy = false) {
  if (!playBtn) return;
  playBtn.disabled = busy;
  playBtn.textContent = busy ? "Loading..." : "Enter Game";
}

function setAuthButtonsLoggedIn(loggedIn) {
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !loggedIn);
  if (loginBtn) loginBtn.classList.toggle("hidden", loggedIn);
  if (registerBtn) registerBtn.classList.toggle("hidden", loggedIn);
}

function showLandingWithAuth() {
  if (landingScreen) landingScreen.classList.remove("hidden");
  if (authPanel) authPanel.classList.remove("hidden");
  if (menu) menu.classList.add("hidden");
}

function showMenu() {
  if (landingScreen) landingScreen.classList.add("hidden");
  if (authPanel) authPanel.classList.add("hidden");
  if (menu) menu.classList.remove("hidden");
}

function hideMenusForGame() {
  if (landingScreen) landingScreen.classList.add("hidden");
  if (authPanel) authPanel.classList.add("hidden");
  if (menu) menu.classList.add("hidden");
}

function resetGameVisualState() {
  snapshots.length = 0;
  state.food = [];
  state.viruses = [];
  state.players = [];
  state.leaderboard = [];
  state.cameraX = 0;
  state.cameraY = 0;
  state.zoom = 1;
  massValue.textContent = "0";
  leaderboardEntries.innerHTML = "";
  setChatOpen(false);
}

function updateAuthUi(user) {
  currentUser = user || null;
  setAuthButtonsLoggedIn(!!user);
  setPlayButtonState(false);
  isJoinInFlight = false;

  if (user) {
    if (authUsername) authUsername.value = user.username || "";
    if (authPassword) authPassword.value = "";
    updateWalletUi(user.credits || 0);
    setAuthStatus(`Logged in as ${user.username}`);
    setMenuStatus("");
    setWalletStatus("");
    showMenu();
  } else {
    if (authPassword) authPassword.value = "";
    inMatch = false;
    resetGameVisualState();
    updateWalletUi(0);
    setAuthStatus("Not logged in.", false);
    setMenuStatus("");
    setWalletStatus("");
    showLandingOnly();
  }
}

async function refreshWallet() {
  if (!currentUser) return;
  const data = await api("/api/balance");
  if (!data.error && typeof data.wallet !== "undefined") {
    updateWalletUi(data.wallet);
    if (currentUser) currentUser.credits = Number(data.wallet || 0);
  }
}

async function checkSession() {
  try {
    const data = await api("/api/me");
    updateAuthUi(data.user || null);
  } catch (err) {
    console.error("SESSION CHECK ERROR:", err);
    setAuthStatus("Failed to check session.", true);
  }
}

function renderChat() {
  if (!chatMessagesEl) return;

  chatMessagesEl.innerHTML = stateChatMessages
    .map(
      (msg) => `
        <div class="chatMessage">
          <span class="chatName">${escapeHtml(msg.name)}:</span>
          <span>${escapeHtml(msg.text)}</span>
        </div>
      `
    )
    .join("");

  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

const stateChatMessages = [];

function pushChatMessage(msg) {
  stateChatMessages.push(msg);
  while (stateChatMessages.length > 40) {
    stateChatMessages.shift();
  }
  renderChat();
}

function setChatOpen(open) {
  chatOpen = !!open && inMatch;
  if (!chatBox) return;

  chatBox.style.display = chatOpen ? "block" : "none";

  if (chatOpen && chatInput) {
    setTimeout(() => chatInput.focus(), 0);
  } else if (chatInput) {
    chatInput.blur();
  }
}

function spawnMoneySigns(container, count) {
  if (!container) return;

  container.innerHTML = "";

  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "moneySign";
    el.textContent = "$";
    el.style.left = Math.random() * 100 + "%";
    el.style.fontSize = 18 + Math.random() * 42 + "px";
    el.style.animationDuration = 7 + Math.random() * 8 + "s";
    el.style.animationDelay = Math.random() * 8 + "s";
    container.appendChild(el);
  }
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
  if (grid < 8) return;

  const offsetX = ((-state.cameraX * state.zoom) % grid + grid) % grid;
  const offsetY = ((-state.cameraY * state.zoom) % grid + grid) % grid;

  ctx.strokeStyle = "#ececec";
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

    ctx.fillStyle = p.id === state.myId ? "#33c3ff" : (p.isBot ? "#55aa55" : "#888");
    ctx.beginPath();
    ctx.arc(mx, my, p.id === state.myId ? 4 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function updateHud() {
  massValue.textContent = Math.floor(getMyTotalMass());
  leaderboardEntries.innerHTML = state.leaderboard
    .map((entry, i) => `<div>${i + 1}. ${escapeHtml(entry.name)} - ${entry.mass}</div>`)
    .join("");
}

function render() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
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
    food: (serverState.food || []).map((f) => ({ ...f })),
    viruses: (serverState.viruses || []).map((v) => ({ ...v })),
    leaderboard: (serverState.leaderboard || []).map((e) => ({ ...e })),
    wallet: Number(serverState.wallet || 0),
    players: (serverState.players || []).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isBot: !!p.isBot,
      totalMass: p.totalMass,
      cells: (p.cells || []).map((c) => ({ ...c }))
    }))
  };
}

function interpolatePlayers(older, newer, alpha) {
  const oldMap = new Map((older.players || []).map((p) => [p.id, p]));
  const newMap = new Map((newer.players || []).map((p) => [p.id, p]));
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
          y: lerp(oldCell.y, newCell.y, alpha)
        };
      })
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
    if (snapshots[i].time <= renderTime && snapshots[i + 1].time >= renderTime) {
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
    wallet: newer.state.wallet,
    players: interpolatePlayers(older.state, newer.state, alpha)
  };
}

window.addEventListener("mousemove", (e) => {
  state.mouseX = e.clientX - W / 2;
  state.mouseY = e.clientY - H / 2;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "\\") {
    e.preventDefault();

    if (inMatch) {
      setChatOpen(!chatOpen);
    }
    return;
  }

  if (chatOpen) return;
  if (!inMatch) return;

  if (e.code === "Space") {
    e.preventDefault();
    state.splitQueued = true;
  }

  if (e.key === "w" || e.key === "W") {
    state.ejectQueued = true;
  }
});

async function joinGame() {
  if (isJoinInFlight || inMatch) return;

  if (!currentUser) {
    setAuthStatus("You must log in first.", true);
    showLandingWithAuth();
    return;
  }

  isJoinInFlight = true;
  setPlayButtonState(true);
  setMenuStatus("");
  setWalletStatus("");

  try {
    const data = await api("/api/game/enter", {});

    if (data.error) {
      setMenuStatus(data.error, true);
      return;
    }

    socket.emit("join", {
      name: (nameInput?.value || "").trim() || "Player",
      color: colorInput ? colorInput.value : "#33c3ff"
    });
  } catch (err) {
    console.error("JOIN GAME ERROR:", err);
    setMenuStatus("Failed to start match.", true);
  } finally {
    isJoinInFlight = false;
    if (!inMatch) setPlayButtonState(false);
  }
}

async function handleAddBalance() {
  if (!currentUser) return;

  const amount = Number(walletAmountInput?.value || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    setWalletStatus("Enter a valid amount.", true);
    return;
  }

  addBalanceBtn.disabled = true;
  withdrawBtn.disabled = true;
  setWalletStatus("Adding balance...");

  try {
    const data = await api("/api/credits/add", { amount });
    if (data.error) {
      setWalletStatus(data.error, true);
      return;
    }

    updateWalletUi(data.wallet);
    currentUser.credits = Number(data.wallet || 0);
    if (walletAmountInput) walletAmountInput.value = "";
    setWalletStatus("Balance added successfully.");
  } catch (err) {
    console.error("ADD BALANCE ERROR:", err);
    setWalletStatus("Failed to add balance.", true);
  } finally {
    addBalanceBtn.disabled = false;
    withdrawBtn.disabled = false;
  }
}

async function handleWithdraw() {
  if (!currentUser) return;

  const amount = Number(walletAmountInput?.value || 0);
  const address = String(withdrawAddressInput?.value || "").trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    setWalletStatus("Enter a valid withdrawal amount.", true);
    return;
  }

  if (!address) {
    setWalletStatus("Enter your Solana wallet address.", true);
    return;
  }

  addBalanceBtn.disabled = true;
  withdrawBtn.disabled = true;
  setWalletStatus("Creating withdrawal request...");

  try {
    const data = await api("/api/credits/withdraw", { amount, address });
    if (data.error) {
      setWalletStatus(data.error, true);
      return;
    }

    updateWalletUi(data.wallet);
    currentUser.credits = Number(data.wallet || 0);
    if (walletAmountInput) walletAmountInput.value = "";
    setWalletStatus("Withdrawal request submitted.");
  } catch (err) {
    console.error("WITHDRAW ERROR:", err);
    setWalletStatus("Failed to withdraw.", true);
  } finally {
    addBalanceBtn.disabled = false;
    withdrawBtn.disabled = false;
  }
}

playBtn?.addEventListener("click", joinGame);

nameInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    joinGame();
  }
});

startMenuBtn?.addEventListener("click", () => {
  if (authPanel) authPanel.classList.remove("hidden");
});

if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const text = chatInput.value.trim();
      if (text) {
        socket.emit("chat", text);
        chatInput.value = "";
      }
    }

    if (e.key === "Escape" || e.key === "\\") {
      e.preventDefault();
      setChatOpen(false);
    }

    e.stopPropagation();
  });
}

registerBtn?.addEventListener("click", async () => {
  try {
    const username = authUsername.value.trim();
    const password = authPassword.value;

    const data = await api("/api/register", { username, password });
    if (data.error) {
      setAuthStatus(data.error, true);
      return;
    }

    updateAuthUi(data.user);
    setMenuStatus("Welcome bonus received: $5.00");
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    setAuthStatus("Failed to register.", true);
  }
});

loginBtn?.addEventListener("click", async () => {
  try {
    const username = authUsername.value.trim();
    const password = authPassword.value;

    const data = await api("/api/login", { username, password });
    if (data.error) {
      setAuthStatus(data.error, true);
      return;
    }

    updateAuthUi(data.user);
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    setAuthStatus("Failed to log in.", true);
  }
});

logoutBtn?.addEventListener("click", async () => {
  try {
    await api("/api/logout", {});
    updateAuthUi(null);
  } catch (err) {
    console.error("LOGOUT ERROR:", err);
    setAuthStatus("Failed to log out.", true);
  }
});

addBalanceBtn?.addEventListener("click", handleAddBalance);
withdrawBtn?.addEventListener("click", handleWithdraw);

socket.on("connect", () => {
  state.connected = true;
  state.myId = socket.id;
});

socket.on("disconnect", () => {
  state.connected = false;
  inMatch = false;
  setPlayButtonState(false);
  resetGameVisualState();

  if (currentUser) {
    showMenu();
    setMenuStatus("Connection lost. Back in menu.", true);
  } else {
    showLandingWithAuth();
  }
});

socket.on("joined", () => {
  inMatch = true;
  hideMenusForGame();
  setPlayButtonState(false);
  setMenuStatus("");
  setWalletStatus("");
});

socket.on("joinError", (data) => {
  inMatch = false;
  setPlayButtonState(false);
  showMenu();
  setMenuStatus(data?.error || "Failed to join match.", true);
});

socket.on("dead", async (data) => {
  inMatch = false;
  resetGameVisualState();
  showMenu();
  setPlayButtonState(false);
  setMenuStatus(data?.message || "You died and returned to the menu.", true);
  await refreshWallet();
});

socket.on("chatHistory", (history) => {
  stateChatMessages.length = 0;
  for (const msg of history || []) {
    stateChatMessages.push(msg);
  }
  renderChat();
});

socket.on("chat", (msg) => {
  pushChatMessage(msg);
});

socket.on("state", (serverState) => {
  snapshots.push({
    time: Date.now(),
    state: cloneStateForSnapshot(serverState)
  });

  while (snapshots.length > 10) {
    snapshots.shift();
  }

  if (typeof serverState.wallet !== "undefined") {
    updateWalletUi(serverState.wallet);
    if (currentUser) currentUser.credits = Number(serverState.wallet || 0);
  }
});

setInterval(() => {
  if (!state.connected || !inMatch) return;

  socket.emit("input", {
    mouseX: state.mouseX,
    mouseY: state.mouseY,
    split: state.splitQueued,
    eject: state.ejectQueued
  });

  state.splitQueued = false;
  state.ejectQueued = false;
}, 1000 / 60);

function loop() {
  const interpolated = getInterpolatedState();

  if (interpolated) {
    state.worldSize = interpolated.worldSize;
    state.food = interpolated.food;
    state.viruses = interpolated.viruses;
    state.players = interpolated.players;
    state.leaderboard = interpolated.leaderboard;

    if (typeof interpolated.wallet !== "undefined") {
      updateWalletUi(interpolated.wallet);
    }
  }

  updateCamera();
  render();
  requestAnimationFrame(loop);
}

spawnMoneySigns(moneyBg, 28);
spawnMoneySigns(menuMoneyBg, 28);
checkSession();
loop();
setPlayButtonState(false);


