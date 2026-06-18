// ─── Estado Global del Cliente ───────────────────────────────────────────────
const state = {
  email: "",
  password: "",
  mode: "local", // "local" o "cloud"
  backendUrl: "http://localhost:8000",
  isConnected: false,
  isScanning: false,
  lastScanTime: "",
  selectedPair: null,
  allPairs: [], // Listado completo de pares recibidos en el último escaneo
  audioContext: null,
  soundEnabled: true,
  strictFilterEnabled: false, // Filtro por R2/Eficiencia/ATR desactivado por defecto (como la terminal)
  settings: {
    adx_min: 50,
    adx_watch_min: 40,
    r2_min: 0.84,
    eff_min: 0.54,
    atr_max_pct: 0.30,
  }
};

let pollIntervalId = null;
let currentPollSpeed = null;

function startPolling(ms) {
  if (pollIntervalId && currentPollSpeed === ms) return;
  if (pollIntervalId) clearInterval(pollIntervalId);
  currentPollSpeed = ms;
  pollIntervalId = setInterval(pollLocalScanStatus, ms);
}

// ─── Inicialización al Cargar la Página ─────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadSavedConfig();
  initDOMEvents();
  initSettingsUI();
  
  // Verificar el estado de conexión inicial en el backend (soporta auto-login)
  checkInitialConnection();

  // Configurar bucle de recarga en local (polling)
  startPolling(5000);
});

async function checkInitialConnection() {
  try {
    const response = await fetch(getApiUrl("/api/status"));
    const data = await response.json();
    if (data.is_connected) {
      state.isConnected = true;
      state.email = data.email || "";
      document.getElementById("input-email").value = state.email;
      updateStatusUI("connected", "CONECTADO");
      toggleSettings(false);
      
      // Sincronizar ajustes al backend
      updateBackendSettings();
      
      // Forzar polling inmediato
      pollLocalScanStatus();
    } else {
      // Si no está conectado pero el navegador tiene credenciales, intentar conectar
      if (state.email && state.password) {
        connectBackend();
      } else {
        // Si no hay datos, abrir panel
        toggleSettings(true);
      }
    }
  } catch (err) {
    console.error("Error comprobando estado inicial:", err);
    if (state.email && state.password) {
      connectBackend();
    } else {
      toggleSettings(true);
    }
  }
}


// ─── Cargar y Guardar Configuración en LocalStorage ──────────────────────────
function loadSavedConfig() {
  state.email = localStorage.getItem("otc_email") || "";
  state.password = localStorage.getItem("otc_password") || "";
  state.mode = localStorage.getItem("otc_mode") || "local";
  state.backendUrl = localStorage.getItem("otc_backend_url") || "http://localhost:8000";
  state.soundEnabled = localStorage.getItem("otc_sound") !== "false";
  state.strictFilterEnabled = localStorage.getItem("otc_strict_filter") === "true";

  // Rellenar UI
  document.getElementById("input-email").value = state.email;
  document.getElementById("input-pass").value = state.password;
  document.getElementById("input-backend-url").value = state.backendUrl;
  document.getElementById("check-sound").checked = state.soundEnabled;
  document.getElementById("check-strict-filter").checked = state.strictFilterEnabled;

  const modeRadios = document.getElementsByName("conn-mode");
  modeRadios.forEach(radio => {
    if (radio.value === state.mode) {
      radio.checked = true;
    }
  });

  updateModeUI();
}

function saveConfigToStorage() {
  localStorage.setItem("otc_email", state.email);
  localStorage.setItem("otc_password", state.password);
  localStorage.setItem("otc_mode", state.mode);
  localStorage.setItem("otc_backend_url", state.backendUrl);
  localStorage.setItem("otc_sound", state.soundEnabled);
  localStorage.setItem("otc_strict_filter", state.strictFilterEnabled);
}

// ─── Enrutador de llamadas de API ────────────────────────────────────────────
function getApiUrl(endpoint) {
  if (state.mode === "local") {
    // Quitar barras sobrantes al final de la URL del backend
    const base = state.backendUrl.replace(/\/$/, "");
    return `${base}${endpoint}`;
  } else {
    // En Vercel Cloud, usar ruta relativa al host actual
    return endpoint;
  }
}

// ─── Gestión del DOM y Eventos ───────────────────────────────────────────────
function initDOMEvents() {
  // Toggle ajustes
  document.getElementById("btn-toggle-settings").addEventListener("click", () => toggleSettings(true));
  document.getElementById("btn-close-settings").addEventListener("click", () => toggleSettings(false));
  document.getElementById("backdrop").addEventListener("click", () => toggleSettings(false));

  // Cambiar modo de conexión
  const modeRadios = document.getElementsByName("conn-mode");
  modeRadios.forEach(radio => {
    radio.addEventListener("change", (e) => {
      state.mode = e.target.value;
      updateModeUI();
    });
  });

  // Guardar y conectar
  document.getElementById("btn-save-settings").addEventListener("click", handleSaveSettings);

  // Cerrar Sesión
  document.getElementById("btn-logout").addEventListener("click", handleLogout);

  // Escanear ahora
  document.getElementById("btn-refresh").addEventListener("click", () => {
    if (state.mode === "local") {
      triggerLocalScan();
    } else {
      runCloudScan();
    }
  });

  // Checkbox de filtro estricto
  document.getElementById("check-strict-filter").addEventListener("change", (e) => {
    state.strictFilterEnabled = e.target.checked;
    saveConfigToStorage();
    filterAndRenderPairs();
  });

  // Filtrado y búsqueda
  document.getElementById("search-input").addEventListener("input", filterAndRenderPairs);
  document.getElementById("filter-dir").addEventListener("change", filterAndRenderPairs);

  // Botón volver en móvil
  const btnBack = document.getElementById("btn-back-to-list");
  if (btnBack) {
    btnBack.addEventListener("click", () => {
      const dashboard = document.getElementById("dashboard-content");
      if (dashboard) {
        dashboard.classList.remove("show-detail");
      }
      state.selectedPair = null;
      document.querySelectorAll(".pair-row").forEach(r => r.classList.remove("active"));
    });
  }
}

function updateModeUI() {
  const localCtrl = document.getElementById("local-url-control");
  const helpText = document.getElementById("help-text-mode");
  if (state.mode === "local") {
    localCtrl.style.display = "flex";
    helpText.innerHTML = "El modo <b>Local</b> mantiene una conexión abierta continua y escanea en segundo plano sin cold starts ni bloqueos de IP de IQ Option.";
  } else {
    localCtrl.style.display = "none";
    helpText.innerHTML = "El modo <b>Nube (Vercel)</b> realiza una conexión rápida bajo demanda. Puede tardar un poco más en cada escaneo y está sujeta a límites de IP.";
  }
}

function toggleSettings(show) {
  const sidebar = document.getElementById("settings-sidebar");
  const backdrop = document.getElementById("backdrop");
  if (show) {
    sidebar.classList.add("open");
    backdrop.classList.add("open");
  } else {
    sidebar.classList.remove("open");
    backdrop.classList.remove("open");
  }
}

// Inicializa sliders de configuración del scanner
function initSettingsUI() {
  const sliders = [
    { id: "adx-min", key: "adx_min" },
    { id: "adx-watch", key: "adx_watch_min" },
    { id: "r2-min", key: "r2_min", isFloat: true },
    { id: "eff-min", key: "eff_min", isFloat: true },
    { id: "atr-max", key: "atr_max_pct", isFloat: true }
  ];

  sliders.forEach(s => {
    const input = document.getElementById(`slider-${s.id}`);
    const label = document.getElementById(`lbl-${s.id}`);
    
    // Configurar valor inicial
    const savedVal = localStorage.getItem(`setting_${s.key}`);
    if (savedVal !== null) {
      state.settings[s.key] = parseFloat(savedVal);
      input.value = savedVal;
    }
    
    label.textContent = s.isFloat ? Number(state.settings[s.key]).toFixed(2) : state.settings[s.key];

    input.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      state.settings[s.key] = val;
      label.textContent = s.isFloat ? val.toFixed(2) : val;
      localStorage.setItem(`setting_${s.key}`, val);
      
      // Aplicar filtros en tiempo real al cliente
      filterAndRenderPairs();
      
      // Intentar actualizar también en el backend si está conectado
      updateBackendSettings();
    });
  });
}

// ─── Operaciones del Backend ──────────────────────────────────────────────────

async function handleSaveSettings() {
  state.email = document.getElementById("input-email").value.trim();
  state.password = document.getElementById("input-pass").value.trim();
  state.backendUrl = document.getElementById("input-backend-url").value.trim();
  state.soundEnabled = document.getElementById("check-sound").checked;

  if (!state.email || !state.password) {
    alert("Por favor, introduce tu email y contraseña de IQ Option.");
    return;
  }

  saveConfigToStorage();
  toggleSettings(false);
  
  await connectBackend();
}

async function connectBackend() {
  updateStatusUI("connecting", "CONECTANDO...");
  
  try {
    const response = await fetch(getApiUrl("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: state.email,
        password: state.password,
        mode: state.mode
      })
    });

    const data = await response.json();
    if (data.success) {
      state.isConnected = true;
      updateStatusUI("connected", "CONECTADO");
      
      // Sincronizar ajustes del cliente al backend
      updateBackendSettings();

      if (state.mode === "local") {
        pollLocalScanStatus();
      } else {
        // En modo nube, ejecutar primer escaneo manual
        runCloudScan();
      }
    } else {
      state.isConnected = false;
      updateStatusUI("error", "ERROR LOGIN");
      alert(`Error al iniciar sesión: ${data.message}`);
    }
  } catch (err) {
    console.error(err);
    state.isConnected = false;
    updateStatusUI("error", "ERROR CONEXIÓN");
    alert("No se pudo contactar con el backend del escáner. Asegúrate de tener el backend local corriendo.");
  }
}

async function handleLogout() {
  if (confirm("¿Estás seguro de que deseas cerrar la sesión? Se borrarán tus credenciales del navegador.")) {
    // 1. Limpiar localStorage
    localStorage.removeItem("otc_email");
    localStorage.removeItem("otc_password");
    state.email = "";
    state.password = "";

    // 2. Limpiar inputs de la UI
    document.getElementById("input-email").value = "";
    document.getElementById("input-pass").value = "";

    // 3. Llamar al backend para desconectar si está conectado
    try {
      await fetch(getApiUrl("/api/logout"), { method: "POST" });
    } catch (err) {
      console.warn("No se pudo notificar el logout al backend:", err);
    }

    // 4. Actualizar estado e interfaz local
    state.isConnected = false;
    updateStatusUI("disconnected", "DESCONECTADO");
    
    // Limpiar tabla de activos
    state.allPairs = [];
    filterAndRenderPairs();
    
    // Mostrar modal de configuración para volver a iniciar sesión
    toggleSettings(true);
  }
}

async function updateBackendSettings() {
  if (!state.isConnected) return;
  
  try {
    // Traducir atr_max_pct a valor absoluto para el python
    const payload = { ...state.settings };
    payload.atr_max_pct = payload.atr_max_pct / 100; // Ej: 0.30% -> 0.003
    
    await fetch(getApiUrl("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: payload })
    });
  } catch (err) {
    console.error("Error sincronizando ajustes con el backend:", err);
  }
}

// Local polling: Consulta el estado del backend y resultados cacheados en modo local
async function pollLocalScanStatus() {
  if (state.mode !== "local" || !state.isConnected) return;

  try {
    // 1. Consultar estado del backend
    const statusResp = await fetch(getApiUrl("/api/status"));
    const statusData = await statusResp.json();

    if (!statusData.is_connected) {
      updateStatusUI("error", "DESCONECTADO API");
      state.isConnected = false;
      startPolling(5000); // Volver a polling normal si se desconecta
      return;
    }

    if (statusData.is_scanning) {
      startPolling(800); // Polling rápido durante el escaneo
      
      const prog = statusData.scan_progress || 0;
      const activePair = statusData.scan_active_pair ? statusData.scan_active_pair.replace("-OTC", "") : "";
      const idx = statusData.scan_index || 0;
      const total = statusData.scan_total || 0;
      
      let statusText = `ESCANEANDO (${prog}%)`;
      if (activePair && idx && total) {
        statusText = `ESCANEANDO: ${activePair} ${idx}/${total} (${prog}%)`;
      }
      
      updateStatusUI("scanning", statusText);
      document.getElementById("scan-progress-bar").style.width = `${prog}%`;
      if (state.allPairs.length === 0) {
        document.querySelectorAll(".loading-placeholder").forEach(el => {
          el.innerHTML = `<span class="radar-pulse-icon" style="display:inline-block; margin-right:8px; vertical-align:middle;"></span> Conectado a la API. Descargando velas de los 172 activos OTC por primera vez... <b>${prog}%</b>`;
        });
      }
    } else {
      startPolling(5000); // Polling normal
      updateStatusUI("connected", "CONECTADO");
      document.getElementById("scan-progress-bar").style.width = "0%";
    }

    // 2. Consultar resultados más recientes
    const resultsResp = await fetch(getApiUrl("/api/results"));
    const resultsData = await resultsResp.json();
    
    if (resultsData.timestamp && resultsData.timestamp !== state.lastScanTime) {
      state.lastScanTime = resultsData.timestamp;
      state.allPairs = resultsData.data || [];
      
      document.getElementById("last-scan-time").textContent = state.lastScanTime;
      document.getElementById("total-assets").textContent = resultsData.pairs_scanned || 0;
      
      filterAndRenderPairs();
      playSynthChime("scan_done");
    }
  } catch (err) {
    console.error("Error al consultar estado local:", err);
  }
}

// Forzar un escaneo inmediato en el backend local
async function triggerLocalScan() {
  if (!state.isConnected) {
    alert("Inicia sesión primero.");
    return;
  }
  updateStatusUI("scanning", "ESCANEANDO...");
  document.getElementById("scan-progress-bar").style.width = "20%";
  
  try {
    await fetch(getApiUrl("/api/scan_now"), { method: "POST" });
    // Inmediatamente consultamos el estado
    setTimeout(pollLocalScanStatus, 1000);
  } catch (err) {
    console.error(err);
  }
}


// Escaneo en la nube: Petición HTTP simple con credenciales
async function runCloudScan() {
  if (!state.email || !state.password) {
    alert("Ingresa credenciales primero.");
    return;
  }
  
  state.isScanning = true;
  updateStatusUI("scanning", "CONECTANDO...");
  document.getElementById("scan-progress-bar").style.width = "5%";

  try {
    const url = getApiUrl(`/api/scan?email=${encodeURIComponent(state.email)}&password=${encodeURIComponent(state.password)}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Fallo del servidor: ${response.statusText}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      
      // Keep the last partial line in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim().startsWith("data:")) {
          const jsonStr = line.replace(/^data:\s*/, "").trim();
          if (!jsonStr) continue;
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === "status") {
              updateStatusUI("scanning", event.message.toUpperCase());
            } else if (event.type === "progress") {
              const activePair = event.active_pair ? event.active_pair.replace("-OTC", "") : "";
              const idx = event.index;
              const total = event.total;
              const prog = Math.round((idx / total) * 100);
              
              updateStatusUI("scanning", `ESCANEANDO: ${activePair} ${idx}/${total} (${prog}%)`);
              document.getElementById("scan-progress-bar").style.width = `${prog}%`;
            } else if (event.type === "results") {
              document.getElementById("scan-progress-bar").style.width = "100%";
              
              state.lastScanTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              state.allPairs = event.data || [];
              
              document.getElementById("last-scan-time").textContent = state.lastScanTime;
              document.getElementById("total-assets").textContent = event.pairs_scanned || 0;
              
              updateStatusUI("connected", "CONECTADO");
              filterAndRenderPairs();
              playSynthChime("scan_done");
            } else if (event.type === "error") {
              throw new Error(event.message);
            }
          } catch (e) {
            console.error("Error parseando evento SSE:", e);
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
    updateStatusUI("error", "ERROR CONEXIÓN");
    alert(`Error al contactar con la nube: ${err.message}`);
  } finally {
    state.isScanning = false;
    setTimeout(() => {
      document.getElementById("scan-progress-bar").style.width = "0%";
    }, 1000);
  }
}

function updateStatusUI(cls, text) {
  const badge = document.getElementById("conn-status");
  badge.className = `status-badge ${cls}`;
  badge.textContent = text;

  const loginInputs = document.getElementById("login-inputs-container");
  const loggedInContainer = document.getElementById("logged-in-container");
  const loggedEmailText = document.getElementById("logged-email-text");
  const saveBtn = document.getElementById("btn-save-settings");

  if (state.isConnected) {
    if (loginInputs) loginInputs.style.display = "none";
    if (loggedInContainer) loggedInContainer.style.display = "block";
    if (loggedEmailText) loggedEmailText.textContent = state.email;
    if (saveBtn) saveBtn.textContent = "GUARDAR CONFIGURACIÓN";
  } else {
    if (loginInputs) loginInputs.style.display = "block";
    if (loggedInContainer) loggedInContainer.style.display = "none";
    if (saveBtn) saveBtn.textContent = "GUARDAR Y CONECTAR";
  }
}

// ─── Filtrado y Renderizado de UI ──────────────────────────────────────────

function filterAndRenderPairs() {
  const query = document.getElementById("search-input").value.toUpperCase().trim();
  const dirFilter = document.getElementById("filter-dir").value;

  // Filtrar según el input de búsqueda, dirección y los sliders del cliente en tiempo real
  const filtered = state.allPairs.filter(p => {
    // 1. Filtro de búsqueda
    if (query && !p.pair.toUpperCase().includes(query)) return false;

    // 2. Filtro de dirección
    if (dirFilter !== "ALL" && p.direction !== dirFilter) return false;

    // 3. Filtros dinámicos de sliders (Solo si el Filtro Estricto está activo)
    if (state.strictFilterEnabled) {
      if (p.r2 < state.settings.r2_min) return false;
      if (p.eff < state.settings.eff_min) return false;
      if (p.atr_pct > state.settings.atr_max_pct) return false;
    }

    return true;
  });

  // Dividir los pares filtrados en TOP y OPERABLES basados en el slider del cliente
  const topList = filtered.filter(p => p.adx >= state.settings.adx_min);
  const watchList = filtered.filter(p => p.adx >= state.settings.adx_watch_min && p.adx < state.settings.adx_min);

  // Renderizar
  renderPairsGroup("list-top", topList);
  renderPairsGroup("list-operables", watchList);

  // Actualizar contadores
  document.getElementById("count-top").textContent = topList.length;
  document.getElementById("count-operables").textContent = watchList.length;
  
  // Si tenemos un activo seleccionado, actualizar su panel si sigue en la lista
  if (state.selectedPair) {
    const updated = state.allPairs.find(p => p.pair === state.selectedPair.pair);
    if (updated) {
      state.selectedPair = updated;
      renderDetailPanel(updated);
    }
  }
}

function renderPairsGroup(elementId, list) {
  const container = document.getElementById(elementId);
  container.innerHTML = "";

  if (list.length === 0) {
    container.innerHTML = `<div class="loading-placeholder" style="padding: 15px; font-size: 11px;">Ninguno cumple los filtros</div>`;
    return;
  }

  list.forEach(p => {
    const row = document.createElement("div");
    row.className = `pair-row ${state.selectedPair && state.selectedPair.pair === p.pair ? "active" : ""}`;
    row.id = `pair-row-${p.pair}`;
    
    const isUp = p.direction === "UP";
    const arrow = isUp ? "▲" : "▼";
    const arrowClass = isUp ? "up" : "down";
    
    // Badge de score
    let scoreClass = "low-score";
    if (p.score >= 72) scoreClass = "top-score";
    else if (p.score >= 52) scoreClass = "watch-score";

    row.innerHTML = `
      <div class="pair-info-left">
        <span class="pair-dir-arrow ${arrowClass}">${arrow}</span>
        <span class="pair-symbol">${p.pair.replace("-OTC", "")}</span>
      </div>
      <div class="pair-info-right">
        <span class="pair-score-badge ${scoreClass}">${Math.round(p.score)}</span>
        <span class="pair-adx-val">${p.adx.toFixed(1)}</span>
      </div>
    `;

    row.addEventListener("click", () => {
      // Remover clase activo anterior
      document.querySelectorAll(".pair-row").forEach(r => r.classList.remove("active"));
      row.classList.add("active");
      
      state.selectedPair = p;
      renderDetailPanel(p);

      // En móvil, activar la vista de detalle
      const dashboard = document.getElementById("dashboard-content");
      if (dashboard) {
        dashboard.classList.add("show-detail");
      }
    });

    container.appendChild(row);
  });
}

// Renderizar panel de detalles
function renderDetailPanel(p) {
  document.getElementById("detail-placeholder").style.display = "none";
  const container = document.getElementById("detail-data");
  container.style.display = "flex";

  // Rellenar cabecera
  document.getElementById("detail-pair-name").textContent = p.pair;
  document.getElementById("detail-pair-price").textContent = p.price.toFixed(5);
  
  const isUp = p.direction === "UP";
  const badge = document.getElementById("detail-dir-badge");
  badge.className = `dir-badge ${isUp ? "buy" : "sell"}`;
  badge.querySelector(".arrow").textContent = isUp ? "▲" : "▼";
  badge.querySelector(".text").textContent = isUp ? "COMPRA" : "VENTA";

  // Actualizar métricas del panel con barras
  updateMetricValue("score", p.score, 100, "%");
  updateMetricValue("adx", p.adx, 80, "");
  updateMetricValue("r2", p.r2, 1, "", 3);
  updateMetricValue("eff", p.eff, 1, "", 3);
  updateMetricValue("space", p.space_pct, 0.2, "%", 3);
  updateMetricValue("atr", p.atr_pct, 0.4, "%", 3);

  // Obstáculo S/R
  const obstacleLabel = document.getElementById("val-obstacle");
  if (p.obstacle !== null) {
    obstacleLabel.textContent = p.obstacle.toFixed(5);
  } else {
    obstacleLabel.textContent = "Ninguno";
  }

  // Metadatos
  const phase = document.getElementById("val-phase");
  phase.textContent = p.phase;
  phase.className = `val-badge ${p.phase === "FRESCA" ? "green" : ""}`;

  const momentum = document.getElementById("val-momentum");
  momentum.textContent = p.momentum;
  momentum.className = `val-badge ${p.momentum === "ACELE" ? "green" : ""}`;

  const struct = document.getElementById("val-structure");
  struct.textContent = p.structure ? "SALUDABLE" : "DEBIL";
  struct.className = `val-badge ${p.structure ? "green" : ""}`;

  document.getElementById("val-cif").textContent = `${p.cif}/${(state.settings.adx_momentum_lookback || 5) * 2}`;

  // Soft notes
  const notesContainer = document.getElementById("soft-notes-container");
  notesContainer.innerHTML = "";
  if (p.soft_notes && p.soft_notes.length > 0) {
    p.soft_notes.forEach(note => {
      const tag = document.createElement("span");
      tag.className = "soft-note-tag";
      tag.textContent = note.toUpperCase();
      notesContainer.appendChild(tag);
    });
  } else {
    const tag = document.createElement("span");
    tag.className = "optimum-tag";
    tag.textContent = "CONTEXTO TÉCNICO ÓPTIMO";
    notesContainer.appendChild(tag);
  }

  // Dibujar gráfico SVG
  drawSvgChart(p);
}

function updateMetricValue(id, value, maxVal, unit, decimals = 1) {
  const textElem = document.getElementById(`val-${id}`);
  const barElem = document.getElementById(`bar-${id}`);
  
  if (textElem && barElem) {
    textElem.textContent = `${value.toFixed(decimals)}${unit}`;
    
    // Calcular porcentaje de barra
    const pct = Math.max(0, Math.min(100, (value / maxVal) * 100));
    barElem.style.width = `${pct}%`;
  }
}

// ─── Generación de Gráfico SVG de Velas ─────────────────────────────────────

function drawSvgChart(p) {
  const container = document.getElementById("svg-chart-container");
  container.innerHTML = "";

  const candles = p.chart_candles || [];
  if (candles.length === 0) {
    container.innerHTML = `<div class="loading-placeholder">Sin datos de velas</div>`;
    return;
  }

  const width = container.clientWidth;
  const height = container.clientHeight;

  // Márgenes del gráfico para dejar espacio a los ejes
  const marginLeft = 10;
  const marginRight = 60;
  const marginTop = 15;
  const marginBottom = 20;

  // Encontrar valores min y max para escalar el eje Y
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  
  let yMax = Math.max(...highs);
  let yMin = Math.min(...lows);
  
  // Agregar un margen del 5% arriba y abajo en el gráfico
  const marginY = (yMax - yMin) * 0.05 || 0.0001;
  yMax += marginY;
  yMin -= marginY;

  // Calcular las líneas de EMA en base a los cierres
  const closes = candles.map(c => c.c);
  const ema5 = calcEMA(closes, 5);
  const ema13 = calcEMA(closes, 13);

  // Crear SVG
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");

  // Gradiente de fondo para el área del gráfico
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  grad.setAttribute("id", "chart-bg-grad");
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0");
  grad.setAttribute("y2", "1");
  
  const stop1 = document.createElementNS("http://www.w3.org/2000/svg", "stop");
  stop1.setAttribute("offset", "0%");
  stop1.setAttribute("stop-color", "rgba(11, 15, 26, 0.4)");
  
  const stop2 = document.createElementNS("http://www.w3.org/2000/svg", "stop");
  stop2.setAttribute("offset", "100%");
  stop2.setAttribute("stop-color", "rgba(6, 9, 19, 0.8)");
  
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Función de mapeo de coordenadas
  const getX = (index) => (index / (candles.length - 1)) * (width - marginLeft - marginRight) + marginLeft;
  const getY = (price) => height - ((price - yMin) / (yMax - yMin)) * (height - marginTop - marginBottom) - marginBottom;

  // Dibujar fondo y marco del gráfico
  const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bgRect.setAttribute("x", marginLeft);
  bgRect.setAttribute("y", marginTop);
  bgRect.setAttribute("width", width - marginLeft - marginRight);
  bgRect.setAttribute("height", height - marginTop - marginBottom);
  bgRect.setAttribute("fill", "url(#chart-bg-grad)");
  bgRect.setAttribute("stroke", "var(--border-color)");
  bgRect.setAttribute("stroke-width", "1");
  svg.appendChild(bgRect);

  // 1. Dibujar cuadricula horizontal sutil y etiquetas de precio
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const val = yMin + (i / gridLines) * (yMax - yMin);
    const y = getY(val);
    
    // Línea horizontal
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", marginLeft);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - marginRight);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "rgba(30, 41, 73, 0.4)");
    line.setAttribute("stroke-width", "0.8");
    line.setAttribute("stroke-dasharray", "2 2");
    svg.appendChild(line);
    
    // Etiqueta del precio en el eje Y (derecha)
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", width - marginRight + 5);
    text.setAttribute("y", y + 3);
    text.setAttribute("fill", "var(--text-muted)");
    text.setAttribute("font-size", "9px");
    text.setAttribute("font-family", "var(--font-mono)");
    text.textContent = val.toFixed(5);
    svg.appendChild(text);
  }

  // 1.5 Dibujar cuadricula vertical y marcas de tiempo en el eje X (abajo)
  const numTimeLabels = 4;
  const indexStep = Math.floor(candles.length / numTimeLabels);
  for (let i = 0; i < numTimeLabels; i++) {
    const idx = Math.min(i * indexStep + Math.floor(indexStep / 2), candles.length - 1);
    const x = getX(idx);
    const candle = candles[idx];
    
    // Línea vertical
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x);
    line.setAttribute("y1", marginTop);
    line.setAttribute("x2", x);
    line.setAttribute("y2", height - marginBottom);
    line.setAttribute("stroke", "rgba(30, 41, 73, 0.4)");
    line.setAttribute("stroke-width", "0.8");
    line.setAttribute("stroke-dasharray", "2 2");
    svg.appendChild(line);
    
    // Etiqueta del tiempo en el eje X
    const timeStr = new Date(candle.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", x);
    text.setAttribute("y", height - 5);
    text.setAttribute("fill", "var(--text-muted)");
    text.setAttribute("font-size", "9px");
    text.setAttribute("font-family", "var(--font-mono)");
    text.setAttribute("text-anchor", "middle");
    text.textContent = timeStr;
    svg.appendChild(text);
  }

  // 2. Dibujar línea de obstáculo S/R si existe
  if (p.obstacle !== null && p.obstacle >= yMin && p.obstacle <= yMax) {
    const obstacleY = getY(p.obstacle);
    
    const srLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    srLine.setAttribute("x1", marginLeft);
    srLine.setAttribute("y1", obstacleY);
    srLine.setAttribute("x2", width - marginRight);
    srLine.setAttribute("y2", obstacleY);
    srLine.setAttribute("stroke", "var(--neon-purple)");
    srLine.setAttribute("stroke-width", "1.5");
    srLine.setAttribute("stroke-dasharray", "4 4");
    svg.appendChild(srLine);

    const srText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    srText.setAttribute("x", width - marginRight - 60);
    srText.setAttribute("y", obstacleY - 4);
    srText.setAttribute("fill", "var(--neon-purple)");
    srText.setAttribute("font-size", "10px");
    srText.setAttribute("font-family", "var(--font-mono)");
    srText.textContent = "S/R ZONA";
    svg.appendChild(srText);
  }

  // 3. Dibujar velas japonesas (wicks y bodies)
  const chartWidth = width - marginLeft - marginRight;
  const candleWidth = Math.max(2, (chartWidth / candles.length) * 0.7);

  candles.forEach((c, i) => {
    const x = getX(i);
    const yOpen = getY(c.o);
    const yClose = getY(c.c);
    const yHigh = getY(c.h);
    const yLow = getY(c.l);
    
    const isBullish = c.c >= c.o;
    const color = isBullish ? "var(--neon-green)" : "var(--neon-red)";

    // Wick (sombra)
    const wick = document.createElementNS("http://www.w3.org/2000/svg", "line");
    wick.setAttribute("x1", x);
    wick.setAttribute("y1", yHigh);
    wick.setAttribute("x2", x);
    wick.setAttribute("y2", yLow);
    wick.setAttribute("stroke", color);
    wick.setAttribute("stroke-width", "1.2");
    svg.appendChild(wick);

    // Body (cuerpo relleno sólido al estilo broker)
    const body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const rHeight = Math.max(1.5, Math.abs(yClose - yOpen));
    const rY = Math.min(yOpen, yClose);

    body.setAttribute("x", x - candleWidth / 2);
    body.setAttribute("y", rY);
    body.setAttribute("width", candleWidth);
    body.setAttribute("height", rHeight);
    body.setAttribute("fill", color);
    body.setAttribute("stroke", color);
    body.setAttribute("stroke-width", "0.5");
    svg.appendChild(body);
  });

  // 4. Dibujar líneas EMA 5 y EMA 13
  const drawEmaPath = (emaValues, color) => {
    let pathData = "";
    emaValues.forEach((val, i) => {
      const x = getX(i);
      const y = getY(val);
      if (i === 0) pathData += `M ${x} ${y}`;
      else pathData += ` L ${x} ${y}`;
    });

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "1.5");
    svg.appendChild(path);
  };

  if (ema5.length > 0) drawEmaPath(ema5, "var(--neon-green)");
  if (ema13.length > 0) drawEmaPath(ema13, "var(--neon-amber)");

  // 5. Dibujar línea de precio actual de la última vela
  const lastCandle = candles[candles.length - 1];
  const currentPrice = lastCandle.c;
  const currentPriceY = getY(currentPrice);
  const currentPriceColor = lastCandle.c >= lastCandle.o ? "var(--neon-green)" : "var(--neon-red)";

  const currentPriceLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  currentPriceLine.setAttribute("x1", marginLeft);
  currentPriceLine.setAttribute("y1", currentPriceY);
  currentPriceLine.setAttribute("x2", width - marginRight);
  currentPriceLine.setAttribute("y2", currentPriceY);
  currentPriceLine.setAttribute("stroke", currentPriceColor);
  currentPriceLine.setAttribute("stroke-width", "1");
  currentPriceLine.setAttribute("stroke-dasharray", "3 3");
  svg.appendChild(currentPriceLine);

  // Etiqueta del precio actual en el eje Y
  const priceBadgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  
  const priceBadgeRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  priceBadgeRect.setAttribute("x", width - marginRight + 2);
  priceBadgeRect.setAttribute("y", currentPriceY - 7);
  priceBadgeRect.setAttribute("width", marginRight - 4);
  priceBadgeRect.setAttribute("height", 14);
  priceBadgeRect.setAttribute("rx", 3);
  priceBadgeRect.setAttribute("fill", currentPriceColor);
  priceBadgeGroup.appendChild(priceBadgeRect);

  const priceBadgeText = document.createElementNS("http://www.w3.org/2000/svg", "text");
  priceBadgeText.setAttribute("x", width - marginRight + (marginRight / 2));
  priceBadgeText.setAttribute("y", currentPriceY + 4);
  priceBadgeText.setAttribute("fill", "var(--bg-main)");
  priceBadgeText.setAttribute("font-size", "9px");
  priceBadgeText.setAttribute("font-family", "var(--font-mono)");
  priceBadgeText.setAttribute("font-weight", "700");
  priceBadgeText.setAttribute("text-anchor", "middle");
  priceBadgeText.textContent = currentPrice.toFixed(5);
  priceBadgeGroup.appendChild(priceBadgeText);
  svg.appendChild(priceBadgeGroup);

  // 6. Configurar Crosshair interactivo
  const crosshairV = document.createElementNS("http://www.w3.org/2000/svg", "line");
  crosshairV.setAttribute("stroke", "rgba(255, 255, 255, 0.4)");
  crosshairV.setAttribute("stroke-width", "0.8");
  crosshairV.setAttribute("stroke-dasharray", "3 3");
  crosshairV.style.pointerEvents = "none";
  crosshairV.style.display = "none";
  svg.appendChild(crosshairV);

  const crosshairH = document.createElementNS("http://www.w3.org/2000/svg", "line");
  crosshairH.setAttribute("stroke", "rgba(255, 255, 255, 0.4)");
  crosshairH.setAttribute("stroke-width", "0.8");
  crosshairH.setAttribute("stroke-dasharray", "3 3");
  crosshairH.style.pointerEvents = "none";
  crosshairH.style.display = "none";
  svg.appendChild(crosshairH);

  // Grupos para etiquetas dinámicas de ejes del crosshair
  const crosshairYLabel = document.createElementNS("http://www.w3.org/2000/svg", "g");
  crosshairYLabel.style.pointerEvents = "none";
  crosshairYLabel.style.display = "none";
  svg.appendChild(crosshairYLabel);

  const crosshairXLabel = document.createElementNS("http://www.w3.org/2000/svg", "g");
  crosshairXLabel.style.pointerEvents = "none";
  crosshairXLabel.style.display = "none";
  svg.appendChild(crosshairXLabel);

  // Rectángulo invisible para capturar eventos de ratón
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  overlay.setAttribute("x", marginLeft);
  overlay.setAttribute("y", marginTop);
  overlay.setAttribute("width", width - marginLeft - marginRight);
  overlay.setAttribute("height", height - marginTop - marginBottom);
  overlay.setAttribute("fill", "transparent");
  overlay.style.cursor = "crosshair";
  svg.appendChild(overlay);

  // Inicializar HUD con la última vela
  updateHUD(lastCandle);

  overlay.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (width / rect.width);
    const mouseY = (e.clientY - rect.top) * (height / rect.height);

    let index = Math.round(((mouseX - marginLeft) / chartWidth) * (candles.length - 1));
    index = Math.max(0, Math.min(candles.length - 1, index));

    const snappedX = getX(index);
    const candle = candles[index];

    // Mostrar líneas
    crosshairV.setAttribute("x1", snappedX);
    crosshairV.setAttribute("y1", marginTop);
    crosshairV.setAttribute("x2", snappedX);
    crosshairV.setAttribute("y2", height - marginBottom);
    crosshairV.style.display = "block";

    crosshairH.setAttribute("x1", marginLeft);
    crosshairH.setAttribute("y1", mouseY);
    crosshairH.setAttribute("x2", width - marginRight);
    crosshairH.setAttribute("y2", mouseY);
    crosshairH.style.display = "block";

    // Actualizar etiqueta del eje Y (precio)
    const priceVal = yMin + ((height - mouseY - marginBottom) / (height - marginTop - marginBottom)) * (yMax - yMin);
    crosshairYLabel.innerHTML = "";
    
    const yRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    yRect.setAttribute("x", width - marginRight + 2);
    yRect.setAttribute("y", mouseY - 7);
    yRect.setAttribute("width", marginRight - 4);
    yRect.setAttribute("height", 14);
    yRect.setAttribute("rx", 3);
    yRect.setAttribute("fill", "var(--neon-cyan)");
    crosshairYLabel.appendChild(yRect);
    
    const yText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    yText.setAttribute("x", width - marginRight + (marginRight / 2));
    yText.setAttribute("y", mouseY + 4);
    yText.setAttribute("fill", "var(--bg-main)");
    yText.setAttribute("font-size", "9px");
    yText.setAttribute("font-family", "var(--font-mono)");
    yText.setAttribute("font-weight", "700");
    yText.setAttribute("text-anchor", "middle");
    yText.textContent = priceVal.toFixed(5);
    crosshairYLabel.appendChild(yText);
    crosshairYLabel.style.display = "block";

    // Actualizar etiqueta del eje X (tiempo)
    crosshairXLabel.innerHTML = "";
    
    const xRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    xRect.setAttribute("x", snappedX - 25);
    xRect.setAttribute("y", height - marginBottom + 2);
    xRect.setAttribute("width", 50);
    xRect.setAttribute("height", 14);
    xRect.setAttribute("rx", 3);
    xRect.setAttribute("fill", "var(--neon-cyan)");
    crosshairXLabel.appendChild(xRect);
    
    const timeStr = new Date(candle.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const xText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    xText.setAttribute("x", snappedX);
    xText.setAttribute("y", height - marginBottom + 12);
    xText.setAttribute("fill", "var(--bg-main)");
    xText.setAttribute("font-size", "9px");
    xText.setAttribute("font-family", "var(--font-mono)");
    xText.setAttribute("font-weight", "700");
    xText.setAttribute("text-anchor", "middle");
    xText.textContent = timeStr;
    crosshairXLabel.appendChild(xText);
    crosshairXLabel.style.display = "block";

    // Actualizar HUD
    updateHUD(candle);
  });

  overlay.addEventListener("mouseleave", () => {
    crosshairV.style.display = "none";
    crosshairH.style.display = "none";
    crosshairYLabel.style.display = "none";
    crosshairXLabel.style.display = "none";
    
    // Resetear HUD a la última vela
    updateHUD(lastCandle);
  });

  container.appendChild(svg);
}

// Actualiza el HUD del panel del gráfico con los valores OHLC de la vela actual
function updateHUD(candle) {
  const hudO = document.getElementById("hud-o");
  const hudH = document.getElementById("hud-h");
  const hudL = document.getElementById("hud-l");
  const hudC = document.getElementById("hud-c");
  
  if (hudO && hudH && hudL && hudC) {
    hudO.textContent = candle.o.toFixed(5);
    hudH.textContent = candle.h.toFixed(5);
    hudL.textContent = candle.l.toFixed(5);
    hudC.textContent = candle.c.toFixed(5);
    
    const isBullish = candle.c >= candle.o;
    const cls = isBullish ? "up" : "down";
    
    hudO.className = cls;
    hudH.className = cls;
    hudL.className = cls;
    hudC.className = cls;
  }
}

function showChartTooltip(e, candle, index, x, y) {}
function hideChartTooltip() {}

// Cálculos auxiliares para EMA
function calcEMA(prices, period) {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i-1] * (1 - k));
  }
  return ema;
}

// ─── Alertas Sonoras (Web Audio API) ──────────────────────────────────────────

function playSynthChime(type) {
  if (!state.soundEnabled) return;

  try {
    // Inicializar el contexto de audio si es la primera vez
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const ctx = state.audioContext;
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    if (type === "scan_done") {
      // Un sonido sutil y agradable al finalizar el escaneo (un acorde menor de neón)
      const now = ctx.currentTime;
      playNote(440, now, 0.12);     // La (A4)
      playNote(554.37, now + 0.05, 0.12); // Do# (C#5)
      playNote(659.25, now + 0.10, 0.25); // Mi (E5)
    }
  } catch (err) {
    console.warn("No se pudo reproducir audio sintetizado:", err);
  }
}

function playNote(frequency, startTime, duration) {
  const ctx = state.audioContext;
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc.type = "sine"; // Onda senoidal suave
  osc.frequency.setValueAtTime(frequency, startTime);

  gainNode.gain.setValueAtTime(0.06, startTime); // Volumen suave
  gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}
