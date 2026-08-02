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
  autoScanEnabled: false, // Escaneo automático desactivado por defecto para no perder la lista
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
  initTimerUI();
  
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
      if (data.email) {
        state.email = data.email;
        document.getElementById("input-email").value = state.email;
      }
      updateStatusUI("connected", "CONECTADO");
      toggleSettings(false);
      updateBackendSettings();
      pollLocalScanStatus();
    } else {
      if (state.email && state.password) {
        connectBackend();
      } else {
        // Si el backend reporta error previo, mostrar estado de error
        if (data.conn_error) {
          updateStatusUI("error", "ERROR CONEXIÓN");
        }
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
  state.autoScanEnabled = localStorage.getItem("otc_auto_scan") === "true";

  // Rellenar UI
  document.getElementById("input-email").value = state.email;
  document.getElementById("input-pass").value = state.password;
  document.getElementById("input-backend-url").value = state.backendUrl;
  document.getElementById("check-sound").checked = state.soundEnabled;
  document.getElementById("check-strict-filter").checked = state.strictFilterEnabled;
  const autoScanCheck = document.getElementById("check-auto-scan");
  if (autoScanCheck) autoScanCheck.checked = state.autoScanEnabled;

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
  localStorage.setItem("otc_auto_scan", state.autoScanEnabled);
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

  // Toggle visibilidad de contraseña
  const btnTogglePass = document.getElementById("btn-toggle-pass");
  if (btnTogglePass) {
    btnTogglePass.addEventListener("click", () => {
      const passInput = document.getElementById("input-pass");
      const iconShow = document.getElementById("eye-icon-show");
      const iconHide = document.getElementById("eye-icon-hide");
      if (passInput.type === "password") {
        passInput.type = "text";
        iconShow.style.display = "none";
        iconHide.style.display = "block";
      } else {
        passInput.type = "password";
        iconShow.style.display = "block";
        iconHide.style.display = "none";
      }
    });
  }

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

  // Checkbox de escaneo automático
  const autoScanCheck = document.getElementById("check-auto-scan");
  if (autoScanCheck) {
    autoScanCheck.addEventListener("change", (e) => {
      state.autoScanEnabled = e.target.checked;
      saveConfigToStorage();
      updateBackendSettings();
    });
  }

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

  // Copiar par desde la vista de detalles
  const detailTitle = document.getElementById("detail-pair-name");
  if (detailTitle) {
    detailTitle.addEventListener("click", () => {
      const pairText = detailTitle.textContent.trim();
      if (pairText) copyToClipboard(pairText, `Copiado al portapapeles: ${pairText}`);
    });
  }

  const btnCopyDetail = document.getElementById("btn-copy-detail-pair");
  if (btnCopyDetail) {
    btnCopyDetail.addEventListener("click", (e) => {
      e.stopPropagation();
      const pairText = document.getElementById("detail-pair-name").textContent.trim();
      if (pairText) copyToClipboard(pairText, `Copiado al portapapeles: ${pairText}`);
    });
  }

  const btnCopyClean = document.getElementById("btn-copy-detail-clean");
  if (btnCopyClean) {
    btnCopyClean.addEventListener("click", (e) => {
      e.stopPropagation();
      const rawText = document.getElementById("detail-pair-name").textContent.trim();
      const cleanText = rawText.replace("-OTC", "");
      if (cleanText) copyToClipboard(cleanText, `Copiado par limpio: ${cleanText}`);
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

    let data = null;
    try {
      data = await response.json();
    } catch (e) {
      data = { success: false, message: `Respuesta HTTP ${response.status} no válida.` };
    }

    if (data && data.success) {
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
      const errorMsg = (data && (data.message || data.detail)) 
        ? (data.message || data.detail) 
        : "IQ Option rechazó la conexión. Si estás en modo Nube (Vercel), IQ Option suele bloquear servidores cloud. Se recomienda usar 'Servidor Local'.";
      alert(`Error al iniciar sesión: ${errorMsg}`);
    }
  } catch (err) {
    console.error(err);
    state.isConnected = false;
    updateStatusUI("error", "ERROR CONEXIÓN");
    alert("No se pudo conectar con el servidor backend.\n\n• Si usas 'Servidor Local': Asegúrate de tener corriendo 'python api/index.py' en tu computadora.\n• Si usas 'Nube (Vercel)': Cambia a modo 'Servidor Local' ya que IQ Option bloquea IPs de servidores cloud.");
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
    payload.auto_scan = state.autoScanEnabled;
    
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
      let detail = response.statusText;
      try {
        const errJson = await response.json();
        detail = errJson.detail || errJson.message || detail;
      } catch (e) {
        try {
          const errText = await response.text();
          if (errText) detail = errText.slice(0, 150);
        } catch (e2) {}
      }
      throw new Error(`HTTP ${response.status}: ${detail || 'No se pudo completar el escaneo'}`);
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
        <span class="pair-symbol" title="Click o botón para copiar">${p.pair.replace("-OTC", "")}</span>
        <button class="btn-copy-pair" title="Copiar ${p.pair}">
          <svg viewBox="0 0 24 24" class="copy-icon"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        </button>
      </div>
      <div class="pair-info-right">
        <span class="pair-score-badge ${scoreClass}">${Math.round(p.score)}</span>
        <span class="pair-adx-val">${p.adx.toFixed(1)}</span>
      </div>
    `;

    const copyBtn = row.querySelector(".btn-copy-pair");
    if (copyBtn) {
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyToClipboard(p.pair, `Copiado: ${p.pair}`);
      });
    }

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

// ─── Estado y Lógica del Temporizador / Cronómetro de Sesión ───────────────
const timerState = {
  durationMinutes: 30,
  totalSeconds: 1800,
  remainingSeconds: 1800,
  elapsedSeconds: 0,
  mode: "countdown", // "countdown" o "stopwatch"
  isRunning: false,
  isPaused: false,
  isFinished: false,
  alarmEnabled: true,
  alarmTone: "digital", // "digital", "radar", "siren", "chime"
  intervalId: null,
  alarmLoopId: null
};

function initTimerUI() {
  loadTimerConfig();
  bindTimerEvents();
  renderTimerUI();
}

function loadTimerConfig() {
  const savedMins = parseInt(localStorage.getItem("otc_timer_mins") || "30", 10);
  const savedMode = localStorage.getItem("otc_timer_mode") || "countdown";
  const savedAlarm = localStorage.getItem("otc_timer_alarm") !== "false";
  const savedTone = localStorage.getItem("otc_timer_tone") || "digital";

  timerState.durationMinutes = savedMins > 0 ? savedMins : 30;
  timerState.totalSeconds = timerState.durationMinutes * 60;
  timerState.remainingSeconds = timerState.totalSeconds;
  timerState.elapsedSeconds = 0;
  timerState.mode = savedMode;
  timerState.alarmEnabled = savedAlarm;
  timerState.alarmTone = savedTone;

  // Actualizar UI de inputs
  const customMinsInput = document.getElementById("input-custom-mins");
  if (customMinsInput) customMinsInput.value = timerState.durationMinutes;

  const alarmCheck = document.getElementById("check-session-alarm");
  if (alarmCheck) alarmCheck.checked = timerState.alarmEnabled;

  const toneSelect = document.getElementById("select-alarm-tone");
  if (toneSelect) toneSelect.value = timerState.alarmTone;

  updatePresetButtonsUI(timerState.durationMinutes);
  updateModeButtonsUI(timerState.mode);
}

function saveTimerConfig() {
  localStorage.setItem("otc_timer_mins", timerState.durationMinutes);
  localStorage.setItem("otc_timer_mode", timerState.mode);
  localStorage.setItem("otc_timer_alarm", timerState.alarmEnabled);
  localStorage.setItem("otc_timer_tone", timerState.alarmTone);
}

function bindTimerEvents() {
  // Toggle popover de configuración
  const btnTogglePopover = document.getElementById("btn-toggle-timer-menu");
  const popover = document.getElementById("timer-popover");
  const btnClosePopover = document.getElementById("btn-close-timer-popover");

  if (btnTogglePopover && popover) {
    btnTogglePopover.addEventListener("click", (e) => {
      e.stopPropagation();
      popover.style.display = popover.style.display === "none" ? "block" : "none";
    });
  }

  if (btnClosePopover && popover) {
    btnClosePopover.addEventListener("click", (e) => {
      e.stopPropagation();
      popover.style.display = "none";
    });
  }

  // Cerrar popover al hacer clic fuera
  document.addEventListener("click", (e) => {
    if (popover && popover.style.display !== "none") {
      const widget = document.getElementById("timer-widget");
      if (widget && !widget.contains(e.target)) {
        popover.style.display = "none";
      }
    }
  });

  // Botón Iniciar / Pausar
  const btnStart = document.getElementById("btn-timer-start");
  if (btnStart) {
    btnStart.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTimerPlay();
    });
  }

  // Botón Reiniciar
  const btnReset = document.getElementById("btn-timer-reset");
  if (btnReset) {
    btnReset.addEventListener("click", (e) => {
      e.stopPropagation();
      resetTimer();
    });
  }

  // Selección de Modos (Countdown vs Stopwatch)
  const modeBtnCountdown = document.getElementById("mode-btn-countdown");
  const modeBtnStopwatch = document.getElementById("mode-btn-stopwatch");

  if (modeBtnCountdown) {
    modeBtnCountdown.addEventListener("click", () => setTimerMode("countdown"));
  }
  if (modeBtnStopwatch) {
    modeBtnStopwatch.addEventListener("click", () => setTimerMode("stopwatch"));
  }

  // Presets rápidos (15m, 30m, 45m, 60m)
  const presetBtns = document.querySelectorAll(".preset-btn");
  presetBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const mins = parseInt(btn.getAttribute("data-mins"), 10);
      if (mins > 0) {
        setTimerDuration(mins);
      }
    });
  });

  // Aplicar tiempo personalizado
  const btnApplyCustom = document.getElementById("btn-apply-custom-time");
  const inputCustom = document.getElementById("input-custom-mins");
  if (btnApplyCustom && inputCustom) {
    btnApplyCustom.addEventListener("click", () => {
      const mins = parseInt(inputCustom.value, 10);
      if (mins > 0 && mins <= 300) {
        setTimerDuration(mins);
      }
    });
  }

  // Ajustes de Alarma
  const checkAlarm = document.getElementById("check-session-alarm");
  if (checkAlarm) {
    checkAlarm.addEventListener("change", (e) => {
      timerState.alarmEnabled = e.target.checked;
      saveTimerConfig();
    });
  }

  const selectTone = document.getElementById("select-alarm-tone");
  if (selectTone) {
    selectTone.addEventListener("change", (e) => {
      timerState.alarmTone = e.target.value;
      saveTimerConfig();
    });
  }

  const btnTestAlarm = document.getElementById("btn-test-alarm");
  if (btnTestAlarm) {
    btnTestAlarm.addEventListener("click", (e) => {
      e.stopPropagation();
      playAlarmSound(timerState.alarmTone);
    });
  }

  // Botones del Modal de Alarma
  const btnStopAlarm = document.getElementById("btn-stop-alarm");
  if (btnStopAlarm) {
    btnStopAlarm.addEventListener("click", stopSessionAlarm);
  }

  const btnExtend5m = document.getElementById("btn-extend-5m");
  if (btnExtend5m) {
    btnExtend5m.addEventListener("click", () => extendSession(5));
  }

  const btnNewSession = document.getElementById("btn-new-session");
  if (btnNewSession) {
    btnNewSession.addEventListener("click", startNewSession);
  }
}

function toggleTimerPlay() {
  if (timerState.isRunning) {
    pauseTimer();
  } else {
    startTimer();
  }
}

function startTimer() {
  if (timerState.isRunning) return;

  if (timerState.isFinished) {
    timerState.isFinished = false;
    timerState.remainingSeconds = timerState.totalSeconds;
    timerState.elapsedSeconds = 0;
  }

  timerState.isRunning = true;
  timerState.isPaused = false;

  if (timerState.intervalId) clearInterval(timerState.intervalId);
  timerState.intervalId = setInterval(tickTimer, 1000);

  renderTimerUI();
}

function pauseTimer() {
  if (!timerState.isRunning) return;

  timerState.isRunning = false;
  timerState.isPaused = true;

  if (timerState.intervalId) {
    clearInterval(timerState.intervalId);
    timerState.intervalId = null;
  }

  renderTimerUI();
}

function resetTimer() {
  if (timerState.intervalId) {
    clearInterval(timerState.intervalId);
    timerState.intervalId = null;
  }

  stopAlarmSoundLoop();

  timerState.isRunning = false;
  timerState.isPaused = false;
  timerState.isFinished = false;
  timerState.remainingSeconds = timerState.totalSeconds;
  timerState.elapsedSeconds = 0;

  renderTimerUI();
}

function setTimerDuration(minutes) {
  timerState.durationMinutes = minutes;
  timerState.totalSeconds = minutes * 60;
  saveTimerConfig();
  updatePresetButtonsUI(minutes);
  resetTimer();
}

function setTimerMode(mode) {
  timerState.mode = mode;
  saveTimerConfig();
  updateModeButtonsUI(mode);
  renderTimerUI();
}

function tickTimer() {
  if (timerState.mode === "countdown") {
    if (timerState.remainingSeconds > 0) {
      timerState.remainingSeconds--;
      timerState.elapsedSeconds++;
    }

    if (timerState.remainingSeconds <= 0) {
      triggerSessionFinished();
    }
  } else {
    // Modo Cronómetro
    timerState.elapsedSeconds++;
    if (timerState.totalSeconds > 0) {
      timerState.remainingSeconds = Math.max(0, timerState.totalSeconds - timerState.elapsedSeconds);
      if (timerState.elapsedSeconds >= timerState.totalSeconds) {
        triggerSessionFinished();
      }
    }
  }

  renderTimerUI();
}

function triggerSessionFinished() {
  pauseTimer();
  timerState.isFinished = true;
  renderTimerUI();

  if (timerState.alarmEnabled) {
    startAlarmSoundLoop(timerState.alarmTone);
  }

  const modalBackdrop = document.getElementById("alarm-modal-backdrop");
  const durationText = document.getElementById("alarm-session-duration");
  if (durationText) {
    durationText.textContent = formatTime(timerState.totalSeconds);
  }
  if (modalBackdrop) {
    modalBackdrop.style.display = "flex";
  }
}

function stopSessionAlarm() {
  stopAlarmSoundLoop();

  const modalBackdrop = document.getElementById("alarm-modal-backdrop");
  if (modalBackdrop) {
    modalBackdrop.style.display = "none";
  }
}

function extendSession(extraMinutes) {
  stopSessionAlarm();

  const extraSecs = extraMinutes * 60;
  timerState.totalSeconds += extraSecs;
  timerState.remainingSeconds += extraSecs;
  timerState.durationMinutes += extraMinutes;
  timerState.isFinished = false;

  const customInput = document.getElementById("input-custom-mins");
  if (customInput) customInput.value = timerState.durationMinutes;

  startTimer();
}

function startNewSession() {
  stopSessionAlarm();
  resetTimer();
  startTimer();
}

function renderTimerUI() {
  const clockEl = document.getElementById("timer-clock");
  const statusDot = document.getElementById("timer-status-dot");
  const playIcon = document.getElementById("timer-play-icon");
  const btnPlay = document.getElementById("btn-timer-start");
  const progressFill = document.getElementById("timer-progress-fill");
  const modeLabel = document.getElementById("timer-mode-label");

  let displaySeconds = timerState.mode === "countdown" ? timerState.remainingSeconds : timerState.elapsedSeconds;
  if (clockEl) {
    clockEl.textContent = formatTime(displaySeconds);
    if (timerState.isFinished) {
      clockEl.classList.add("finished");
    } else {
      clockEl.classList.remove("finished");
    }
  }

  if (modeLabel) {
    modeLabel.textContent = timerState.mode === "countdown" ? "TEMPORIZADOR" : "CRONÓMETRO";
  }

  if (statusDot) {
    statusDot.className = "timer-status-dot";
    if (timerState.isFinished) {
      statusDot.classList.add("finished");
    } else if (timerState.isRunning) {
      statusDot.classList.add("running");
    } else if (timerState.isPaused) {
      statusDot.classList.add("paused");
    }
  }

  if (playIcon && btnPlay) {
    if (timerState.isRunning) {
      btnPlay.title = "Pausar sesión";
      btnPlay.classList.add("running");
      playIcon.innerHTML = '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    } else {
      btnPlay.title = "Iniciar sesión";
      btnPlay.classList.remove("running");
      playIcon.innerHTML = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
    }
  }

  if (progressFill && timerState.totalSeconds > 0) {
    let pct = 100;
    if (timerState.mode === "countdown") {
      pct = (timerState.remainingSeconds / timerState.totalSeconds) * 100;
    } else {
      pct = Math.min(100, (timerState.elapsedSeconds / timerState.totalSeconds) * 100);
    }
    progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");

  if (h > 0) {
    const hh = String(h).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function updatePresetButtonsUI(activeMins) {
  const presetBtns = document.querySelectorAll(".preset-btn");
  presetBtns.forEach(btn => {
    const mins = parseInt(btn.getAttribute("data-mins"), 10);
    if (mins === activeMins) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

function updateModeButtonsUI(activeMode) {
  const modeBtnCountdown = document.getElementById("mode-btn-countdown");
  const modeBtnStopwatch = document.getElementById("mode-btn-stopwatch");

  if (modeBtnCountdown && modeBtnStopwatch) {
    if (activeMode === "countdown") {
      modeBtnCountdown.classList.add("active");
      modeBtnStopwatch.classList.remove("active");
    } else {
      modeBtnStopwatch.classList.add("active");
      modeBtnCountdown.classList.remove("active");
    }
  }
}

// ─── Sintetizador de Sonidos de Alarma (Web Audio API) ───────────────────────
function playAlarmSound(tone) {
  try {
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = state.audioContext;
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const now = ctx.currentTime;

    switch (tone) {
      case "digital":
        playBeepTone(880, now, 0.08, "square", 0.1);
        playBeepTone(880, now + 0.12, 0.08, "square", 0.1);
        playBeepTone(1200, now + 0.24, 0.15, "square", 0.15);
        break;

      case "radar":
        playBeepTone(1046.5, now, 0.15, "sine", 0.2);
        playBeepTone(1318.5, now + 0.18, 0.25, "sine", 0.25);
        break;

      case "siren":
        playSirenSweep(now, 0.4);
        break;

      case "chime":
        playBeepTone(523.25, now, 0.3, "sine", 0.12);
        playBeepTone(659.25, now + 0.08, 0.3, "sine", 0.12);
        playBeepTone(783.99, now + 0.16, 0.3, "sine", 0.12);
        playBeepTone(1046.5, now + 0.24, 0.5, "sine", 0.15);
        break;

      default:
        playBeepTone(880, now, 0.1, "sine", 0.15);
        break;
    }
  } catch (err) {
    console.warn("Error reproduciendo tono de alarma:", err);
  }
}

function playBeepTone(freq, startTime, duration, type = "sine", gainVal = 0.1) {
  const ctx = state.audioContext;
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(gainVal, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playSirenSweep(startTime, duration) {
  const ctx = state.audioContext;
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(600, startTime);
  osc.frequency.exponentialRampToValueAtTime(1400, startTime + duration * 0.5);
  osc.frequency.exponentialRampToValueAtTime(600, startTime + duration);

  gain.gain.setValueAtTime(0.12, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function startAlarmSoundLoop(tone) {
  stopAlarmSoundLoop();

  playAlarmSound(tone);

  timerState.alarmLoopId = setInterval(() => {
    playAlarmSound(tone);
  }, 1500);
}

function stopAlarmSoundLoop() {
  if (timerState.alarmLoopId) {
    clearInterval(timerState.alarmLoopId);
    timerState.alarmLoopId = null;
  }
}

// ─── Funciones Auxiliares de Portapapeles y Notificaciones (Toasts) ────────
function copyToClipboard(text, customMessage) {
  if (!text) return;
  const message = customMessage || `Copiado: ${text}`;
  
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(message);
    }).catch(() => {
      fallbackCopyToClipboard(text, message);
    });
  } else {
    fallbackCopyToClipboard(text, message);
  }
}

function fallbackCopyToClipboard(text, message) {
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);
    if (successful) {
      showToast(message);
    } else {
      showToast(`Copia manualmente: ${text}`);
    }
  } catch (err) {
    console.error("Error copiando texto al portapapeles:", err);
  }
}

function showToast(message) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = "toast-item";
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 2200);
}
