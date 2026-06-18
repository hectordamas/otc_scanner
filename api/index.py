import os
import sys
import time
import threading
from datetime import datetime
from typing import Dict, List, Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# Importar IQ Option API
try:
    from iqoptionapi.stable_api import IQ_Option
    import iqoptionapi.constants as OP_code
except ImportError:
    print("ERROR: iqoptionapi no encontrado.")
    # No detenemos el inicio del backend para permitir que Vercel compile o el usuario vea la UI
    IQ_Option = None
    OP_code = None

app = FastAPI(title="OTC Scanner API", version="1.0.0")

# Permitir CORS para desarrollo local y Vercel
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Configuración por defecto ────────────────────────────────────────────────
DEFAULT_SETTINGS = {
    "timeframe": 60,
    "candles_count": 40,
    "adx_min": 50,
    "adx_watch_min": 40,
    "r2_min": 0.84,
    "eff_min": 0.54,
    "free_path_min": 0.0005,
    "adx_hard_min": 28,
    "adx_target": 60,
    "r2_target": 0.84,
    "eff_target": 0.58,
    "space_target": 0.0009,
    "candles_in_favor_n": 10,
    "candles_in_favor_target": 6,
    "atr_ideal_pct": 0.0018,
    "atr_max_pct": 0.0030,
    "adx_momentum_lookback": 5,
    "adx_accelerating_pct": 0.05,
    "adx_decelerating_pct": -0.05,
    "display_adx_min": 30,
}

# Estado Global
GLOBAL_STATE = {
    "email": "",
    "password": "",
    "api": None,
    "is_connected": False,
    "conn_error": "",
    "settings": DEFAULT_SETTINGS.copy(),
    "latest_results": [],
    "last_scan_time": "",
    "pairs_scanned": 0,
    "missing_consts": [],
    "is_scanning": False,
    "scan_progress": 0, # Progreso en porcentaje (0-100)
    "scan_active_pair": "", # Par que se está escaneando actualmente
    "scan_index": 0, # Índice actual escaneado
    "scan_total": 0, # Total de pares a escanear
    "bg_loop_active": False,
}

class LoginRequest(BaseModel):
    email: str
    password: str
    mode: str = "local" # "local" o "cloud"

class SettingsUpdateRequest(BaseModel):
    settings: Dict[str, float]

# ─── Funciones Matemáticas (Copiadas exactamente de otc_scanner.py) ───────────

def calc_ema(prices: List[float], period: int) -> float:
    k = 2 / (period + 1)
    e = prices[0]
    for p in prices[1:]:
        e = p * k + e * (1 - k)
    return e

def calc_adx(highs: List[float], lows: List[float], closes: List[float], period: int = 14):
    if len(closes) < period + 2:
        return None
    tr_list, pdm_list, ndm_list = [], [], []
    for i in range(1, len(closes)):
        tr  = max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
        pdm = max(highs[i]-highs[i-1], 0) if (highs[i]-highs[i-1]) > (lows[i-1]-lows[i]) else 0
        ndm = max(lows[i-1]-lows[i], 0)   if (lows[i-1]-lows[i]) > (highs[i]-highs[i-1]) else 0
        tr_list.append(tr); pdm_list.append(pdm); ndm_list.append(ndm)

    def smooth(lst, p):
        s = sum(lst[:p])
        result = [s]
        for v in lst[p:]:
            s = s - s/p + v
            result.append(s)
        return result

    atr = smooth(tr_list, period)
    pDI = smooth(pdm_list, period)
    nDI = smooth(ndm_list, period)

    dx_list = []
    for a, p, n in zip(atr, pDI, nDI):
        pdi = 100 * p / a if a else 0
        ndi = 100 * n / a if a else 0
        dx  = 100 * abs(pdi-ndi) / (pdi+ndi) if (pdi+ndi) else 0
        dx_list.append(dx)

    adx = sum(dx_list[:period]) / period
    for dx in dx_list[period:]:
        adx = (adx * (period-1) + dx) / period

    last_atr = atr[-1]
    pdi_last = 100 * pDI[-1] / last_atr if last_atr else 0
    ndi_last = 100 * nDI[-1] / last_atr if last_atr else 0
    direction = "UP" if pdi_last > ndi_last else "DOWN"
    return adx, direction

def calc_atr(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> float:
    trs = []
    for i in range(1, len(closes)):
        tr = max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
        trs.append(tr)
    if len(trs) < period:
        return 0.0
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = (atr * (period-1) + tr) / period
    return atr

def calc_r2(prices: List[float]) -> float:
    n = len(prices)
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(prices) / n
    num   = sum((x-mx)*(y-my) for x,y in zip(xs,prices))
    den_x = sum((x-mx)**2 for x in xs)
    slope = num / den_x if den_x else 0
    ss_res = sum((y-(my+slope*(x-mx)))**2 for x,y in zip(xs,prices))
    ss_tot = sum((y-my)**2 for y in prices)
    return 1.0 - ss_res/ss_tot if ss_tot else 0.0

def calc_efficiency(prices: List[float]) -> float:
    if len(prices) < 2:
        return 0.0
    net   = abs(prices[-1] - prices[0])
    total = sum(abs(prices[i]-prices[i-1]) for i in range(1, len(prices)))
    return net / total if total else 0.0

def calc_candles_in_favor(opens: List[float], closes: List[float], direction: str, last_n: int = 10, target_n: int = 6) -> int:
    opens_sub  = opens[-last_n:]
    closes_sub = closes[-last_n:]
    count = 0
    for o, c in zip(opens_sub, closes_sub):
        if direction == "UP" and c > o:
            count += 1
        if direction == "DOWN" and c < o:
            count += 1
    return count

def calc_adx_prev(highs: List[float], lows: List[float], closes: List[float], period: int = 14, offset: int = 5):
    if len(closes) <= period + offset + 2:
        return None
    sub_highs  = highs[:-offset]
    sub_lows   = lows[:-offset]
    sub_closes = closes[:-offset]
    result = calc_adx(sub_highs, sub_lows, sub_closes, period)
    return result[0] if result else None

def calc_adx_momentum(adx_current: float, highs: List[float], lows: List[float], closes: List[float], lookback: int, acc_pct: float, dec_pct: float):
    adx_prev = calc_adx_prev(highs, lows, closes, offset=lookback)
    if adx_prev and adx_prev > 0:
        slope_pct = (adx_current - adx_prev) / adx_prev
    else:
        slope_pct = 0.0
    if slope_pct >= acc_pct:
        status = "ACELE"
    elif slope_pct <= dec_pct:
        status = "FRENA"
    else:
        status = "ESTAB"
    return slope_pct, status

def _find_swing_points(highs: List[float], lows: List[float], window: int = 2):
    sw_highs = []
    sw_lows = []
    n = len(highs)
    for i in range(window, n - window):
        if all(highs[i] >= highs[i - k] and highs[i] >= highs[i + k] for k in range(1, window + 1)):
            sw_highs.append((i, highs[i]))
        if all(lows[i] <= lows[i - k] and lows[i] <= lows[i + k] for k in range(1, window + 1)):
            sw_lows.append((i, lows[i]))
    return sw_highs, sw_lows

def detect_trend_phase(highs: List[float], lows: List[float], closes: List[float], direction: str, fresca_max: int, extend_min: int):
    n = len(closes)
    sw_highs, sw_lows = _find_swing_points(highs, lows, window=2)

    if direction == "UP":
        candidates = [(i, p) for i, p in sw_lows if i > n // 3]
        if len(candidates) >= 1:
            start_idx = candidates[-1][0]
        elif sw_lows:
            start_idx = sw_lows[-1][0]
        else:
            start_idx = n // 2
    else:
        candidates = [(i, p) for i, p in sw_highs if i > n // 3]
        if len(candidates) >= 1:
            start_idx = candidates[-1][0]
        elif sw_highs:
            start_idx = sw_highs[-1][0]
        else:
            start_idx = n // 2

    candles_in_trend = n - 1 - start_idx

    if candles_in_trend <= fresca_max:
        phase = "FRESCA"
    elif candles_in_trend < extend_min:
        phase = "ACTIVA"
    else:
        phase = "EXTEND"

    return phase, candles_in_trend

def check_market_structure(highs: List[float], lows: List[float], direction: str) -> bool:
    sw_highs, sw_lows = _find_swing_points(highs, lows, window=2)

    if direction == "UP":
        valid_hh = len(sw_highs) >= 2
        valid_hl = len(sw_lows) >= 2
        if valid_hh and valid_hl:
            hh_ok = sw_highs[-1][1] > sw_highs[-2][1] and sw_highs[-1][0] > sw_highs[-2][0]
            hl_ok = sw_lows[-1][1] > sw_lows[-2][1] and sw_lows[-1][0] > sw_lows[-2][0]
            return hh_ok and hl_ok
        return valid_hh or valid_hl
    else:
        valid_lh = len(sw_highs) >= 2
        valid_ll = len(sw_lows) >= 2
        if valid_lh and valid_ll:
            lh_ok = sw_highs[-1][1] < sw_highs[-2][1] and sw_highs[-1][0] > sw_highs[-2][0]
            ll_ok = sw_lows[-1][1] < sw_lows[-2][1] and sw_lows[-1][0] > sw_lows[-2][0]
            return lh_ok and ll_ok
        return valid_lh or valid_ll

def bounded_ratio(value: float, lower: float, upper: float) -> float:
    if upper <= lower:
        return 1.0
    if value <= lower:
        return 0.0
    if value >= upper:
        return 1.0
    return (value - lower) / (upper - lower)

def bounded_inverse_ratio(value: float, ideal: float, worst: float) -> float:
    if worst <= ideal:
        return 1.0
    if value <= ideal:
        return 1.0
    if value >= worst:
        return 0.0
    return 1.0 - (value - ideal) / (worst - ideal)

def compute_quality_score(adx: float, r2: float, eff: float, cif: int, atr_pct: float, space_pct: float, adx_slope_pct: float, phase: str, structure_ok: bool, s: dict) -> float:
    adx_s   = bounded_ratio(adx, s["adx_hard_min"], s["adx_target"])
    r2_s    = bounded_ratio(r2, 0.65, s["r2_target"])
    eff_s   = bounded_ratio(eff, 0.40, s["eff_target"])
    cif_s   = bounded_ratio(cif, 4, s["candles_in_favor_target"])
    atr_s   = bounded_inverse_ratio(atr_pct, s["atr_ideal_pct"], s["atr_max_pct"])
    space_s = bounded_ratio(space_pct, 0.0002, s["space_target"])
    mom_s   = bounded_ratio(adx_slope_pct, -0.10, 0.15)
    phase_map = {"FRESCA": 1.0, "ACTIVA": 0.65, "EXTEND": 0.35, "N/A": 0.5}
    phase_s  = phase_map.get(phase, 0.5)
    struct_s = 1.0 if structure_ok else 0.4

    score = (
           30 * adx_s +
           24 * r2_s +
           18 * eff_s +
            8 * cif_s +
            6 * atr_s +
            7 * space_s +
            5 * mom_s +
            1 * phase_s +
            1 * struct_s
    )
    return max(0.0, min(100.0, score))

def calc_sr_levels(highs: List[float], lows: List[float], closes: List[float], free_path_min: float) -> List[float]:
    levels = []
    window = 3
    for i in range(window, len(highs) - window):
        if all(highs[i] >= highs[i-j] and highs[i] >= highs[i+j] for j in range(1, window+1)):
            levels.append(highs[i])
        if all(lows[i] <= lows[i-j] and lows[i] <= lows[i+j] for j in range(1, window+1)):
            levels.append(lows[i])

    levels = sorted(set(levels))
    merged = []
    for lv in levels:
        if not merged or abs(lv - merged[-1]) / merged[-1] > free_path_min:
            merged.append(lv)
    return merged

def free_path(closes: List[float], highs: List[float], lows: List[float], direction: str, free_path_min: float):
    current = closes[-1]
    levels  = calc_sr_levels(highs, lows, closes, free_path_min)

    if direction == "UP":
        obstacles = [l for l in levels if l > current * 1.0001]
        if not obstacles:
            return 1.0, None
        nearest = min(obstacles)
        space   = (nearest - current) / current
        return space, nearest
    else:
        obstacles = [l for l in levels if l < current * 0.9999]
        if not obstacles:
            return 1.0, None
        nearest = max(obstacles)
        space   = (current - nearest) / current
        return space, nearest

def analyze_candles(candles: List[dict], s: dict) -> Optional[dict]:
    if len(candles) < 20:
        return None

    closes = [c["close"] for c in candles]
    highs  = [c["max"]   for c in candles]
    lows   = [c["min"]   for c in candles]
    opens  = [c["open"]  for c in candles]

    adx_result = calc_adx(highs, lows, closes)
    if not adx_result:
        return None
    adx, adx_dir = adx_result

    r2  = calc_r2(closes[-20:])
    eff = calc_efficiency(closes[-20:])

    ema5    = calc_ema(closes, 5)
    ema13   = calc_ema(closes, 13)
    ema_dir = "UP" if ema5 > ema13 else "DOWN"

    direction = adx_dir if adx_dir == ema_dir else None

    cif = calc_candles_in_favor(opens, closes, direction, s["candles_in_favor_n"], s["candles_in_favor_target"]) if direction else 0
    atr = calc_atr(highs, lows, closes)
    atr_pct = (atr / closes[-1]) if closes[-1] else 1.0

    space_pct, obstacle = free_path(closes, highs, lows, direction, s["free_path_min"]) if direction else (0.0, None)
    adx_slope_pct, mom_status = calc_adx_momentum(adx, highs, lows, closes, int(s["adx_momentum_lookback"]), s["adx_accelerating_pct"], s["adx_decelerating_pct"])
    phase, phase_candles = detect_trend_phase(highs, lows, closes, direction, 12, 25) if direction else ("N/A", 0)
    structure_ok = check_market_structure(highs, lows, direction) if direction else False

    hard_fail_reasons = []
    if direction is None:
        hard_fail_reasons.append("dir")
    if adx < s["adx_hard_min"]:
        hard_fail_reasons.append("adx_muy_bajo")
    if atr_pct > (s["atr_max_pct"] * 1.5):
        hard_fail_reasons.append("volatilidad_extrema")

    score = compute_quality_score(adx, r2, eff, cif, atr_pct, space_pct, adx_slope_pct, phase, structure_ok, s)
    if hard_fail_reasons:
        score = max(0.0, score - (18 * len(hard_fail_reasons)))

    if direction is not None and adx >= s["adx_min"]:
        tier = "TOP"
    elif direction is not None and adx >= s["adx_watch_min"]:
        tier = "WATCH"
    else:
        tier = "NONE"

    soft_notes = []
    if r2 < s["r2_min"]:
        soft_notes.append("linealidad baja")
    if eff < s["eff_min"]:
        soft_notes.append("retroceso alto")
    if cif < s["candles_in_favor_target"]:
        soft_notes.append("continuidad debil")
    if atr_pct > s["atr_max_pct"]:
        soft_notes.append("volatilidad alta")
    if space_pct < s["free_path_min"]:
        soft_notes.append("espacio corto")
    if mom_status == "FRENA":
        soft_notes.append("momentum frenando")
    if phase == "EXTEND":
        soft_notes.append("tendencia extendida")
    if not structure_ok:
        soft_notes.append("estructura debil")

    # Guardar las velas de forma formateada para poder dibujar el gráfico
    chart_candles = []
    # Devolver las últimas 40 velas para dibujar
    for c in candles[-40:]:
        chart_candles.append({
            "o": c["open"],
            "h": c["max"],
            "l": c["min"],
            "c": c["close"],
            "t": c["from"]
        })

    return {
        "tier":           tier,
        "score":          round(score, 1),
        "direction":      direction,
        "adx":            round(adx, 1),
        "r2":             round(r2, 3),
        "eff":            round(eff, 3),
        "cif":            cif,
        "atr_pct":        round(atr_pct * 100, 3), # En %
        "space_pct":      round(space_pct * 100, 3), # En %
        "obstacle":       obstacle,
        "momentum":       mom_status,
        "adx_slope":      round(adx_slope_pct * 100, 1), # En %
        "phase":          phase,
        "phase_candles":  phase_candles,
        "structure":      structure_ok,
        "hard_fails":     hard_fail_reasons,
        "soft_notes":     soft_notes,
        "chart_candles":  chart_candles,
        "price":          closes[-1] if closes else 0
    }

# ─── Conectores y Motores de Escaneo ──────────────────────────────────────────

def connect_iq(email: str, password: str) -> Optional[IQ_Option]:
    if not IQ_Option:
        raise Exception("iqoptionapi no está disponible en este servidor.")
    api = IQ_Option(email, password)
    check, reason = api.connect()
    if not check:
        raise Exception(f"Fallo de conexión: {reason}")
    api.change_balance("PRACTICE")
    try:
        api.update_ACTIVES_OPCODE()
    except Exception:
        pass
    return api

def get_otc_pairs_list(api) -> List[str]:
    try:
        all_assets = api.get_all_open_time()
    except Exception as e:
        print(f"Error al obtener activos: {e}")
        return []
    pairs = []
    for category in all_assets.values():
        for name, info in category.items():
            if "OTC" in name.upper() and info.get("open", False):
                pairs.append(name)
    return sorted(set(pairs))

def scan_single_pair(api, pair: str, s: dict) -> Optional[dict]:
    if OP_code and pair not in OP_code.ACTIVES:
        return None
    try:
        candles = api.get_candles(pair, int(s["timeframe"]), int(s["candles_count"]), time.time())
        if candles:
            analysis = analyze_candles(candles, s)
            if analysis:
                return {"pair": pair, **analysis}
    except Exception:
        pass
    return None

def execute_complete_scan(api, s: dict):
    pairs = get_otc_pairs_list(api)
    if not pairs:
        yield "results", [], [], 0
        return

    results = []
    missing_consts = []
    
    # Comprobar si los pares existen en el diccionario de códigos
    valid_pairs = []
    for pair in pairs:
        if OP_code and pair not in OP_code.ACTIVES:
            missing_consts.append(pair)
        else:
            valid_pairs.append(pair)

    # Escaneo secuencial para evitar condiciones de carrera en el WebSocket de iqoptionapi
    total_valid = len(valid_pairs)
    for idx, pair in enumerate(valid_pairs, 1):
        yield "progress", pair, idx, total_valid
        res = scan_single_pair(api, pair, s)
        if res:
            results.append(res)
        time.sleep(0.01)

    # Filtrar y ordenar
    # otc_scanner.py filtra por: dirección válida y adx >= DISPLAY_ADX_MIN
    filtered = [
        r for r in results 
        if r.get("direction") is not None 
        and r.get("adx", 0.0) >= s["display_adx_min"]
    ]
    
    # Ordenar por ADX descendente
    ordered = sorted(filtered, key=lambda x: x.get("adx", 0.0), reverse=True)

    yield "results", ordered, missing_consts, len(pairs)


# ─── Bucle en Segundo Plano para Modo Local ───────────────────────────────────

def local_background_scan_loop():
    print("Ejecutando escaneo inicial en segundo plano...")
    if GLOBAL_STATE["is_connected"] and GLOBAL_STATE["api"]:
        GLOBAL_STATE["is_scanning"] = True
        GLOBAL_STATE["scan_progress"] = 0
        try:
            print(f"Escaneando activos al iniciar: {datetime.now().strftime('%H:%M:%S')}...")
            for event_type, *args in execute_complete_scan(GLOBAL_STATE["api"], GLOBAL_STATE["settings"]):
                if event_type == "progress":
                    pair, idx, total = args
                    GLOBAL_STATE["scan_active_pair"] = pair
                    GLOBAL_STATE["scan_index"] = idx
                    GLOBAL_STATE["scan_total"] = total
                    GLOBAL_STATE["scan_progress"] = int((idx / total) * 100)
                elif event_type == "results":
                    ordered, missing_consts, total_pairs = args
                    GLOBAL_STATE["latest_results"] = ordered
                    GLOBAL_STATE["missing_consts"] = missing_consts
                    GLOBAL_STATE["pairs_scanned"] = total_pairs
            
            GLOBAL_STATE["last_scan_time"] = datetime.now().strftime("%H:%M:%S")
            GLOBAL_STATE["conn_error"] = ""
        except Exception as e:
            print(f"Error en escaneo inicial: {e}")
            GLOBAL_STATE["conn_error"] = str(e)
        finally:
            GLOBAL_STATE["is_scanning"] = False
            GLOBAL_STATE["scan_progress"] = 0
            GLOBAL_STATE["scan_active_pair"] = ""
            GLOBAL_STATE["scan_index"] = 0
            GLOBAL_STATE["scan_total"] = 0

# ─── Endpoints API ────────────────────────────────────────────────────────────

@app.post("/api/login")
def login(req: LoginRequest, background_tasks: BackgroundTasks):
    """
    Inicia sesión en IQ Option.
    Si es en modo 'local', mantendrá la sesión abierta en un hilo secundario.
    Si es en modo 'cloud', verifica las credenciales y devuelve éxito, pero no deja hilo de escaneo.
    """
    GLOBAL_STATE["email"] = req.email
    GLOBAL_STATE["password"] = req.password

    try:
        # Cerrar conexión previa si existe
        if GLOBAL_STATE["api"]:
            try:
                GLOBAL_STATE["api"].disconnect()
            except Exception:
                pass
            GLOBAL_STATE["api"] = None
            GLOBAL_STATE["is_connected"] = False

        print(f"Conectando a IQ Option ({req.email})...")
        api = connect_iq(req.email, req.password)
        GLOBAL_STATE["api"] = api
        GLOBAL_STATE["is_connected"] = True
        GLOBAL_STATE["conn_error"] = ""

        # En modo local, activar el bucle en segundo plano si no está corriendo
        if req.mode == "local":
            # Si ya hay un bucle activo, no creamos otro
            if not GLOBAL_STATE["bg_loop_active"]:
                thread = threading.Thread(target=local_background_scan_loop, daemon=True)
                thread.start()
            
            # Ejecutar un escaneo inmediato asíncrono para tener datos rápido
            def init_scan():
                GLOBAL_STATE["is_scanning"] = True
                try:
                    for event_type, *args in execute_complete_scan(api, GLOBAL_STATE["settings"]):
                        if event_type == "progress":
                            pair, idx, total = args
                            GLOBAL_STATE["scan_active_pair"] = pair
                            GLOBAL_STATE["scan_index"] = idx
                            GLOBAL_STATE["scan_total"] = total
                            GLOBAL_STATE["scan_progress"] = int((idx / total) * 100)
                        elif event_type == "results":
                            ordered, missing_consts, total_pairs = args
                            GLOBAL_STATE["latest_results"] = ordered
                            GLOBAL_STATE["missing_consts"] = missing_consts
                            GLOBAL_STATE["pairs_scanned"] = total_pairs
                    GLOBAL_STATE["last_scan_time"] = datetime.now().strftime("%H:%M:%S")
                except Exception as e:
                    GLOBAL_STATE["conn_error"] = str(e)
                finally:
                    GLOBAL_STATE["is_scanning"] = False
            
            background_tasks.add_task(init_scan)

        return {
            "success": True,
            "message": "Conectado correctamente.",
            "mode": req.mode
        }
    except Exception as e:
        GLOBAL_STATE["is_connected"] = False
        GLOBAL_STATE["conn_error"] = str(e)
        return {
            "success": False,
            "message": f"Error de conexión: {str(e)}"
        }

@app.post("/api/logout")
def logout():
    """Cierra la sesión y desconecta del websocket de IQ Option."""
    if GLOBAL_STATE["api"]:
        try:
            GLOBAL_STATE["api"].disconnect()
        except Exception:
            pass
    GLOBAL_STATE["api"] = None
    GLOBAL_STATE["is_connected"] = False
    GLOBAL_STATE["email"] = ""
    GLOBAL_STATE["password"] = ""
    GLOBAL_STATE["latest_results"] = []
    GLOBAL_STATE["last_scan_time"] = ""
    GLOBAL_STATE["pairs_scanned"] = 0
    return {"success": True, "message": "Sesión cerrada correctamente."}

@app.post("/api/settings")
def update_settings(req: SettingsUpdateRequest):
    """Actualiza la configuración del escáner en caliente."""
    for k, v in req.settings.items():
        if k in GLOBAL_STATE["settings"]:
            # Convertir a tipos adecuados
            if k in ["timeframe", "candles_count", "candles_in_favor_n", "candles_in_favor_target", "adx_momentum_lookback"]:
                GLOBAL_STATE["settings"][k] = int(v)
            else:
                GLOBAL_STATE["settings"][k] = float(v)
    return {"success": True, "settings": GLOBAL_STATE["settings"]}

@app.get("/api/settings")
def get_settings():
    """Retorna la configuración actual."""
    return GLOBAL_STATE["settings"]

@app.get("/api/status")
def get_status():
    """Retorna el estado de la conexión y del scanner."""
    return {
        "is_connected": GLOBAL_STATE["is_connected"],
        "conn_error": GLOBAL_STATE["conn_error"],
        "is_scanning": GLOBAL_STATE["is_scanning"],
        "scan_progress": GLOBAL_STATE["scan_progress"],
        "scan_active_pair": GLOBAL_STATE["scan_active_pair"],
        "scan_index": GLOBAL_STATE["scan_index"],
        "scan_total": GLOBAL_STATE["scan_total"],
        "last_scan_time": GLOBAL_STATE["last_scan_time"],
        "pairs_scanned": GLOBAL_STATE["pairs_scanned"],
        "bg_loop_active": GLOBAL_STATE["bg_loop_active"],
        "email": GLOBAL_STATE["email"]
    }

@app.get("/api/results")
def get_results():
    """
    Retorna los resultados cacheados del escaneo (Modo Local).
    """
    return {
        "timestamp": GLOBAL_STATE["last_scan_time"],
        "pairs_scanned": GLOBAL_STATE["pairs_scanned"],
        "missing_consts": GLOBAL_STATE["missing_consts"],
        "data": GLOBAL_STATE["latest_results"]
    }

@app.post("/api/scan_now")
def scan_now(background_tasks: BackgroundTasks):
    """Fuerza un escaneo en segundo plano sin interrumpir ni desconectar el cliente websocket."""
    if not GLOBAL_STATE["is_connected"] or not GLOBAL_STATE["api"]:
        raise HTTPException(status_code=400, detail="No conectado a la API de IQ Option.")
    
    if GLOBAL_STATE["is_scanning"]:
        return {"success": True, "message": "Escaneo ya en curso. Espera a que termine."}
        
    def manual_scan_task():
        GLOBAL_STATE["is_scanning"] = True
        try:
            print("Escaneo manual iniciado...")
            for event_type, *args in execute_complete_scan(GLOBAL_STATE["api"], GLOBAL_STATE["settings"]):
                if event_type == "progress":
                    pair, idx, total = args
                    GLOBAL_STATE["scan_active_pair"] = pair
                    GLOBAL_STATE["scan_index"] = idx
                    GLOBAL_STATE["scan_total"] = total
                    GLOBAL_STATE["scan_progress"] = int((idx / total) * 100)
                elif event_type == "results":
                    ordered, missing_consts, total_pairs = args
                    GLOBAL_STATE["latest_results"] = ordered
                    GLOBAL_STATE["missing_consts"] = missing_consts
                    GLOBAL_STATE["pairs_scanned"] = total_pairs
            GLOBAL_STATE["last_scan_time"] = datetime.now().strftime("%H:%M:%S")
            GLOBAL_STATE["conn_error"] = ""
        except Exception as e:
            print(f"Error en escaneo manual: {e}")
            GLOBAL_STATE["conn_error"] = str(e)
        finally:
            GLOBAL_STATE["is_scanning"] = False
            GLOBAL_STATE["scan_active_pair"] = ""
            GLOBAL_STATE["scan_index"] = 0
            GLOBAL_STATE["scan_total"] = 0
            
    background_tasks.add_task(manual_scan_task)
    return {"success": True, "message": "Escaneo forzado iniciado."}

@app.get("/api/scan")
def get_instant_scan(
    email: Optional[str] = Query(None),
    password: Optional[str] = Query(None)
):
    """
    Endpoint para Vercel Cloud Serverless (Modo Nube).
    Realiza una conexión de un solo uso, escanea y transmite los datos en tiempo real mediante SSE.
    """
    use_email = email or GLOBAL_STATE["email"]
    use_pass = password or GLOBAL_STATE["password"]

    if not use_email or not use_pass:
        raise HTTPException(status_code=400, detail="Credenciales no proporcionadas.")

    from fastapi.responses import StreamingResponse
    import json

    def event_stream():
        api = None
        try:
            print(f"Modo nube: Escaneando bajo demanda para {use_email}...")
            yield f"data: {json.dumps({'type': 'status', 'message': 'Conectando a IQ Option...'})}\n\n"
            api = connect_iq(use_email, use_pass)
            
            for event_type, *args in execute_complete_scan(api, GLOBAL_STATE["settings"]):
                if event_type == "progress":
                    pair, idx, total = args
                    yield f"data: {json.dumps({'type': 'progress', 'active_pair': pair, 'index': idx, 'total': total})}\n\n"
                elif event_type == "results":
                    ordered, missing_consts, total_pairs = args
                    yield f"data: {json.dumps({'type': 'results', 'data': ordered, 'missing_consts': missing_consts, 'pairs_scanned': total_pairs})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            if api:
                try:
                    api.disconnect()
                except Exception:
                    pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")

# ─── Servir Frontend Estático en Local ────────────────────────────────────────

@app.get("/index.css")
def get_css():
    path = "index.css" if os.path.exists("index.css") else "src/index.css"
    return FileResponse(path, headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"})

@app.get("/index.js")
def get_js():
    path = "index.js" if os.path.exists("index.js") else "src/index.js"
    return FileResponse(path, headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"})

@app.get("/")
def get_index():
    return FileResponse("index.html", headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"})

@app.on_event("startup")
def startup_event():
    print("OTC Scanner API iniciada. Esperando login desde el cliente web...")

@app.on_event("shutdown")
def shutdown_event():
    GLOBAL_STATE["bg_loop_active"] = False
    if GLOBAL_STATE["api"]:
        try:
            GLOBAL_STATE["api"].disconnect()
        except Exception:
            pass

if __name__ == "__main__":
    import uvicorn
    # Si se ejecuta directamente, iniciar uvicorn en puerto 8000
    print("Iniciando servidor de desarrollo local en http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
