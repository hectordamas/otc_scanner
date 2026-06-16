"""
Escáner de Contexto OTC — IQ Option
===============================================
Detecta pares OTC con contexto direccional fuerte y limpio:

    - Tendencia clara (ADX + EMA)
    - Momentum acelerando / estable
    - Fase de la tendencia (fresca / activa / extendida)
    - Integridad de estructura del mercado
    - Pocos retrocesos (R² + Eficiencia)
    - Camino despejado sin S/R cercanos

Requisitos:
        iqoptionapi (instalado desde GitHub)
        pip install colorama

Uso:
        python otc_scanner.py
"""

import time, sys, os
from datetime import datetime

try:
    from login_config import USE_INTERACTIVE_LOGIN, FIXED_EMAIL, FIXED_PASSWORD
except Exception:
    USE_INTERACTIVE_LOGIN = True
    FIXED_EMAIL = ""
    FIXED_PASSWORD = ""

try:
    from iqoptionapi.stable_api import IQ_Option
    import iqoptionapi.constants as OP_code
except ImportError:
    print("ERROR: iqoptionapi no encontrado.")
    sys.exit(1)

try:
    from colorama import Fore, Style, init
    init(autoreset=True)
    GREEN  = Fore.GREEN
    RED    = Fore.RED
    YELLOW = Fore.YELLOW
    CYAN   = Fore.CYAN
    RESET  = Style.RESET_ALL
    BOLD   = Style.BRIGHT
except ImportError:
    GREEN = RED = YELLOW = CYAN = RESET = BOLD = ""

# ─── Configuración ────────────────────────────────────────────────────────────

TIMEFRAME     = 60       # 1 minuto
CANDLES_COUNT = 40       # velas a analizar

# Umbrales base para contexto lineal fuerte
ADX_MIN       = 50
ADX_WATCH_MIN = 40
R2_MIN        = 0.84
EFF_MIN       = 0.54
FREE_PATH_MIN = 0.0005   # 0.05%

# Filtros duros minimos
ADX_HARD_MIN  = 28

# Objetivos para score (100 = alta calidad)
ADX_TARGET    = 60
R2_TARGET     = 0.84
EFF_TARGET    = 0.58
SPACE_TARGET  = 0.0009   # 0.09%

# Continuidad de velas
CANDLES_IN_FAVOR_N      = 10
CANDLES_IN_FAVOR_TARGET = 6

# Volatilidad relativa (ATR / precio)
ATR_IDEAL_PCT = 0.0018   # 0.18%
ATR_MAX_PCT   = 0.0030   # 0.30%

# Umbrales de ranking
SCORE_TOP_MIN   = 72
SCORE_WATCH_MIN = 52

# Momentum / aceleracion del ADX
ADX_MOMENTUM_LOOKBACK = 5
ADX_ACCELERATING_PCT  = 0.05
ADX_DECELERATING_PCT  = -0.05

# Fase de tendencia (en velas)
PHASE_FRESCA_MAX     = 12
PHASE_EXTENDIDA_MIN  = 25

# Volatility Contraction Ratio (compresion de rango)
VCR_RECENT_N   = 4     # velas recientes para medir rango comprimido
VCR_PRIOR_N    = 10    # velas anteriores para comparar
VCR_COMPRESS   = 0.50  # < 0.50 = COMPRIMIENDO
VCR_ADJUSTING  = 0.75  # < 0.75 = AJUSTANDO

# Breakout candle detection
BO_BODY_MULT  = 1.5    # cuerpo actual > X veces promedio reciente
BO_RANGE_EXP  = 1.3    # rango actual > X veces rango comprimido

SOUND_ALERT   = True
MAX_NO_SIGNAL = 10      # Maximo de pares "Sin señal" que se muestran en pantalla
DISPLAY_ADX_MIN = 30    # Mostrar solo activos con ADX >= este valor

# ─── Obtener pares OTC activos ────────────────────────────────────────────────

def refresh_active_codes(api):
    """
    iqoptionapi trae una tabla local de codigos de activos. Cuando IQ Option
    agrega OTC nuevos, esa tabla puede quedar vieja y get_candles imprime:
    "Asset XXX not found on consts". Esta funcion la actualiza desde la API.
    """
    before = len(OP_code.ACTIVES)
    try:
        api.update_ACTIVES_OPCODE()
    except Exception as e:
        print(f"  Aviso: no se pudo actualizar la tabla de activos: {e}")
    return max(0, len(OP_code.ACTIVES) - before)


def get_otc_pairs(api):
    try:
        all_assets = api.get_all_open_time()
    except Exception as e:
        print(f"  Error al obtener activos: {e}")
        return []
    pairs = []
    for category in all_assets.values():
        for name, info in category.items():
            if "OTC" in name.upper() and info.get("open", False):
                pairs.append(name)
    return sorted(set(pairs))

# ─── Indicadores ──────────────────────────────────────────────────────────────

def calc_ema(prices, period):
    k = 2 / (period + 1)
    e = prices[0]
    for p in prices[1:]:
        e = p * k + e * (1 - k)
    return e

def calc_adx(highs, lows, closes, period=14):
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

def calc_atr(highs, lows, closes, period=14):
    trs = []
    for i in range(1, len(closes)):
        tr = max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
        trs.append(tr)
    if len(trs) < period:
        return 0
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = (atr * (period-1) + tr) / period
    return atr

def calc_r2(prices):
    n = len(prices)
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(prices) / n
    num   = sum((x-mx)*(y-my) for x,y in zip(xs,prices))
    den_x = sum((x-mx)**2 for x in xs)
    slope = num / den_x if den_x else 0
    ss_res = sum((y-(my+slope*(x-mx)))**2 for x,y in zip(xs,prices))
    ss_tot = sum((y-my)**2 for y in prices)
    return 1 - ss_res/ss_tot if ss_tot else 0

def calc_efficiency(prices):
    if len(prices) < 2:
        return 0
    net   = abs(prices[-1] - prices[0])
    total = sum(abs(prices[i]-prices[i-1]) for i in range(1, len(prices)))
    return net / total if total else 0

def calc_candles_in_favor(opens, closes, direction, last_n=CANDLES_IN_FAVOR_N):
    opens  = opens[-last_n:]
    closes = closes[-last_n:]
    count = 0
    for o, c in zip(opens, closes):
        if direction == "UP" and c > o:
            count += 1
        if direction == "DOWN" and c < o:
            count += 1
    return count

# ─── Momentum / Fase / Estructura ───────────────────────────────────────────────

def calc_adx_prev(highs, lows, closes, period=14, offset=5):
    """Calcula ADX excluyendo las ultimas 'offset' velas para comparar pendiente."""
    if len(closes) <= period + offset + 2:
        return None
    sub_highs  = highs[:-offset]
    sub_lows   = lows[:-offset]
    sub_closes = closes[:-offset]
    result = calc_adx(sub_highs, sub_lows, sub_closes, period)
    return result[0] if result else None

def calc_adx_momentum(adx_current, highs, lows, closes):
    """Calcula pendiente del ADX vs hace N velas. Retorna (slope_pct, status)."""
    adx_prev = calc_adx_prev(highs, lows, closes, offset=ADX_MOMENTUM_LOOKBACK)
    if adx_prev and adx_prev > 0:
        slope_pct = (adx_current - adx_prev) / adx_prev
    else:
        slope_pct = 0.0
    if slope_pct >= ADX_ACCELERATING_PCT:
        status = "ACELE"
    elif slope_pct <= ADX_DECELERATING_PCT:
        status = "FRENA"
    else:
        status = "ESTAB"
    return slope_pct, status

def _find_swing_points(highs, lows, window=2):
    """Encuentra indices y precios de swing highs y swing lows."""
    sw_highs = []
    sw_lows = []
    n = len(highs)
    for i in range(window, n - window):
        if all(highs[i] >= highs[i - k] and highs[i] >= highs[i + k] for k in range(1, window + 1)):
            sw_highs.append((i, highs[i]))
        if all(lows[i] <= lows[i - k] and lows[i] <= lows[i + k] for k in range(1, window + 1)):
            sw_lows.append((i, lows[i]))
    return sw_highs, sw_lows

def detect_trend_phase(highs, lows, closes, direction):
    """Detecta fase de la tendencia: FRESCA, ACTIVA o EXTEND."""
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

    if candles_in_trend <= PHASE_FRESCA_MAX:
        phase = "FRESCA"
    elif candles_in_trend < PHASE_EXTENDIDA_MIN:
        phase = "ACTIVA"
    else:
        phase = "EXTEND"

    return phase, candles_in_trend

def check_market_structure(highs, lows, direction):
    """Verifica si la estructura de mercado respeta la tendencia."""
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

def calc_volatility_contraction(highs, lows, recent_n=VCR_RECENT_N, prior_n=VCR_PRIOR_N):
    """Ratio de compresion: rango reciente vs rango previo. < 1 = comprimiendo."""
    if len(highs) < recent_n + prior_n:
        return 1.0
    recent_ranges = [highs[i] - lows[i] for i in range(-recent_n, 0)]
    prior_start   = -(recent_n + prior_n)
    prior_ranges  = [highs[i] - lows[i] for i in range(prior_start, -recent_n)]
    recent_avg = sum(recent_ranges) / recent_n
    prior_avg  = sum(prior_ranges) / prior_n
    return recent_avg / prior_avg if prior_avg > 0 else 1.0

def detect_breakout_candle(highs, lows, opens, closes, direction, vcr):
    """Detecta si la vela actual muestra senales de breakout de la compresion."""
    current_body  = abs(closes[-1] - opens[-1])
    current_range = highs[-1] - lows[-1]

    # Cuerpos promedio de las ultimas 8 velas (excluyendo la actual)
    recent_bodies = [abs(closes[i] - opens[i]) for i in range(-9, -1)]
    avg_body = sum(recent_bodies) / len(recent_bodies) if recent_bodies else 0

    # Rango promedio de las velas comprimidas recientes (excluyendo la actual)
    recent_ranges = [highs[i] - lows[i] for i in range(-5, -1)]
    avg_range = sum(recent_ranges) / len(recent_ranges) if recent_ranges else 0

    # Direccion correcta
    if direction == "UP" and closes[-1] <= opens[-1]:
        return False
    if direction == "DOWN" and closes[-1] >= opens[-1]:
        return False

    # Cuerpo grande + rango expandido + habia compresion previa
    body_big  = avg_body > 0 and current_body > avg_body * BO_BODY_MULT
    range_exp = avg_range > 0 and current_range > avg_range * BO_RANGE_EXP
    was_tight = vcr < VCR_COMPRESS

    return body_big and range_exp and was_tight

def bounded_ratio(value, lower, upper):
    if upper <= lower:
        return 1.0
    if value <= lower:
        return 0.0
    if value >= upper:
        return 1.0
    return (value - lower) / (upper - lower)

def bounded_inverse_ratio(value, ideal, worst):
    if worst <= ideal:
        return 1.0
    if value <= ideal:
        return 1.0
    if value >= worst:
        return 0.0
    return 1.0 - (value - ideal) / (worst - ideal)

def compute_quality_score(adx, r2, eff, cif, atr_pct, space_pct, adx_slope_pct, phase, structure_ok):
    # Pesos base: ADX 30%, R2 24%, efic 18%, cont 8%, ATR 6%, espacio 7%, momentum 5%, fase 1%, estructura 1%
    adx_s   = bounded_ratio(adx, ADX_HARD_MIN, ADX_TARGET)
    r2_s    = bounded_ratio(r2, 0.65, R2_TARGET)
    eff_s   = bounded_ratio(eff, 0.40, EFF_TARGET)
    cif_s   = bounded_ratio(cif, 4, CANDLES_IN_FAVOR_TARGET)
    atr_s   = bounded_inverse_ratio(atr_pct, ATR_IDEAL_PCT, ATR_MAX_PCT)
    space_s = bounded_ratio(space_pct, 0.0002, SPACE_TARGET)
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

    components = {
        "adx":   adx_s,
        "r2":    r2_s,
        "eff":   eff_s,
        "cif":   cif_s,
        "atr":   atr_s,
        "space": space_s,
        "mom":   mom_s,
        "phase": phase_s,
        "struct": struct_s,
    }
    return max(0.0, min(100.0, score)), components

def calc_sr_levels(highs, lows, closes, n_levels=5):
    """
    Detecta niveles de soporte y resistencia usando
    máximos y mínimos locales de las últimas velas.
    Devuelve lista de precios que son zonas S/R.
    """
    levels = []
    window = 3  # velas a cada lado para confirmar un nivel local

    for i in range(window, len(highs) - window):
        # Resistencia: máximo local
        if all(highs[i] >= highs[i-j] and highs[i] >= highs[i+j] for j in range(1, window+1)):
            levels.append(highs[i])
        # Soporte: mínimo local
        if all(lows[i] <= lows[i-j] and lows[i] <= lows[i+j] for j in range(1, window+1)):
            levels.append(lows[i])

    # Agrupar niveles muy cercanos (dentro del 0.05%)
    levels = sorted(set(levels))
    merged = []
    for lv in levels:
        if not merged or abs(lv - merged[-1]) / merged[-1] > FREE_PATH_MIN:
            merged.append(lv)

    return merged

def free_path(closes, highs, lows, direction):
    """
    Calcula qué porcentaje de espacio libre hay en la
    dirección de la tendencia antes del próximo S/R.
    Devuelve (espacio_pct, nivel_obstaculo)
    """
    current = closes[-1]
    levels  = calc_sr_levels(highs, lows, closes)

    if direction == "UP":
        # Buscar el nivel de resistencia más cercano por encima
        obstacles = [l for l in levels if l > current * 1.0001]
        if not obstacles:
            return 1.0, None   # camino completamente libre
        nearest = min(obstacles)
        space   = (nearest - current) / current
        return space, nearest
    else:
        # Buscar el nivel de soporte más cercano por debajo
        obstacles = [l for l in levels if l < current * 0.9999]
        if not obstacles:
            return 1.0, None
        nearest = max(obstacles)
        space   = (current - nearest) / current
        return space, nearest

def analyze(candles):
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

    cif = calc_candles_in_favor(opens, closes, direction) if direction else 0
    atr = calc_atr(highs, lows, closes)
    atr_pct = (atr / closes[-1]) if closes[-1] else 1.0

    # Espacio libre antes del próximo S/R
    space_pct, obstacle = free_path(closes, highs, lows, direction) if direction else (0, None)

    # Momentum del ADX (acelerando / estable / frenando)
    adx_slope_pct, mom_status = calc_adx_momentum(adx, highs, lows, closes)

    # Fase de la tendencia
    phase, phase_candles = detect_trend_phase(highs, lows, closes, direction) if direction else ("N/A", 0)

    # Estructura del mercado
    structure_ok = check_market_structure(highs, lows, direction) if direction else False

    # Compresion de volatilidad (VCR)
    vcr = calc_volatility_contraction(highs, lows)
    if vcr <= VCR_COMPRESS:
        compression = "COMPRIMIENDO"
    elif vcr <= VCR_ADJUSTING:
        compression = "AJUSTANDO"
    else:
        compression = "NORMAL"

    # Breakout candle detection
    breakout = detect_breakout_candle(highs, lows, opens, closes, direction, vcr) if direction else False

    hard_fail_reasons = []
    if direction is None:
        hard_fail_reasons.append("dir")
    if adx < ADX_HARD_MIN:
        hard_fail_reasons.append("adx_muy_bajo")
    if atr_pct > (ATR_MAX_PCT * 1.5):
        hard_fail_reasons.append("volatilidad_extrema")

    score, components = compute_quality_score(adx, r2, eff, cif, atr_pct, space_pct, adx_slope_pct, phase, structure_ok)
    if hard_fail_reasons:
        score = max(0.0, score - (18 * len(hard_fail_reasons)))

    # Modo simple: la fuerza de tendencia manda.
    if direction is not None and adx >= ADX_MIN:
        tier = "TOP"
    elif direction is not None and adx >= ADX_WATCH_MIN:
        tier = "WATCH"
    else:
        tier = "NONE"

    passes = tier == "TOP"

    soft_notes = []
    if r2 < R2_MIN:
        soft_notes.append("linealidad baja")
    if eff < EFF_MIN:
        soft_notes.append("retroceso alto")
    if cif < CANDLES_IN_FAVOR_TARGET:
        soft_notes.append("continuidad debil")
    if atr_pct > ATR_MAX_PCT:
        soft_notes.append("volatilidad alta")
    if space_pct < FREE_PATH_MIN:
        soft_notes.append("espacio corto")
    if mom_status == "FRENA":
        soft_notes.append("momentum frenando")
    if phase == "EXTEND":
        soft_notes.append("tendencia extendida")
    if not structure_ok:
        soft_notes.append("estructura debil")
    if compression == "COMPRIMIENDO":
        soft_notes.append("pausa estrecha")

    return {
        "passes":         passes,
        "tier":           tier,
        "score":          score,
        "direction":      direction,
        "adx":            adx,
        "r2":             r2,
        "eff":            eff,
        "cif":            cif,
        "atr_pct":        atr_pct,
        "space_pct":      space_pct,
        "obstacle":       obstacle,
        "momentum":       mom_status,
        "adx_slope":      adx_slope_pct,
        "phase":          phase,
        "phase_candles":  phase_candles,
        "structure":      structure_ok,
        "compression":    compression,
        "vcr":            vcr,
        "breakout":       breakout,
        "components":     components,
        "hard_fails":     hard_fail_reasons,
        "soft_notes":     soft_notes,
    }

# ─── Utilidades ───────────────────────────────────────────────────────────────

def beep():
    if SOUND_ALERT:
        try:
            import winsound
            for _ in range(3):
                winsound.Beep(1000, 200)
                time.sleep(0.1)
        except:
            print("\a")

def clear():
    os.system("cls" if os.name == "nt" else "clear")

def get_credentials():
    if USE_INTERACTIVE_LOGIN:
        email = input("  Email IQ Option:  ").strip()
        password = input("  Contraseña:       ").strip()
        return email, password

    email = (FIXED_EMAIL or "").strip()
    password = (FIXED_PASSWORD or "").strip()

    if not email or not password:
        print(f"  {YELLOW}Credenciales fijas no configuradas. Se solicitara login manual.{RESET}")
        email = input("  Email IQ Option:  ").strip()
        password = input("  Contraseña:       ").strip()

    return email, password

def scan_once(api, pairs):
    results = []
    total = len(pairs)
    missing_consts = []
    for i, pair in enumerate(pairs, 1):
        sys.stdout.write(f"\r  Analizando {i}/{total}: {pair:<25}")
        sys.stdout.flush()
        if pair not in OP_code.ACTIVES:
            missing_consts.append(pair)
            continue
        try:
            candles = api.get_candles(pair, TIMEFRAME, CANDLES_COUNT, time.time())
            if candles:
                res = analyze(candles)
                if res:
                    results.append((pair, res))
        except Exception:
            pass
        time.sleep(0.25)
    sys.stdout.write("\r" + " "*60 + "\r")
    return results, missing_consts

def print_results(results, n_pairs, scan_time, missing_consts=None):
    missing_consts = missing_consts or []

    filtered = [
        item for item in results
        if item[1].get("direction") is not None
        and item[1].get("adx", 0.0) >= DISPLAY_ADX_MIN
    ]
    ordered = sorted(filtered, key=lambda item: item[1].get("adx", 0.0), reverse=True)
    top20 = ordered[:20]
    operables20 = ordered[20:40]

    def print_group(title, rows):
        print(f"\n  {BOLD}{title} ({len(rows)}){RESET}")
        print(f"  {BOLD}{'PAR':<24} {'DIR':<4} {'ADX':>8}{RESET}")
        print(f"  {'─'*64}")
        for pair, r in rows:
            direction = r.get("direction")
            if direction == "UP":
                d = "▲"
                color = GREEN
            elif direction == "DOWN":
                d = "▼"
                color = RED
            else:
                d = "-"
                color = YELLOW
            print(f"  {color}{pair:<24} {d:<4} {r.get('adx', 0.0):>8.1f}{RESET}")

    clear()
    print(f"{BOLD}{CYAN}{'═'*64}")
    print("  ACTIVOS OTC ORDENADOS POR ADX")
    print(f"  Escaneado: {scan_time}  |  Pares revisados: {n_pairs}")
    print(f"  Filtro: direccion valida y ADX >= {DISPLAY_ADX_MIN}")
    print(f"{'═'*64}{RESET}\n")

    if not ordered:
        print(f"  {YELLOW}No hay activos con direccion valida y ADX >= {DISPLAY_ADX_MIN} en este ciclo.{RESET}")
    else:
        print_group("TOP", top20)
        print_group("OPERABLES", operables20)

    if missing_consts:
        print(f"\n  {YELLOW}Pares sin codigo interno: {len(missing_consts)}{RESET}")

    print(f"\n{'─'*64}")
    print(f"\n  Presiona {BOLD}Enter{RESET} para volver a escanear  |  "
          f"{BOLD}Ctrl+C{RESET} para salir\n")

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{BOLD}Escáner OTC — Contexto de Momentum Direccional{RESET}\n")
    email, password = get_credentials()

    print("\n  Conectando...")
    api = IQ_Option(email, password)
    check, reason = api.connect()
    if not check:
        print(f"\n{RED}Error de conexión: {reason}{RESET}")
        sys.exit(1)

    api.change_balance("PRACTICE")
    print(f"  {GREEN}Conectado correctamente.{RESET}\n")
    added_codes = refresh_active_codes(api)
    print(f"  Tabla de activos actualizada (+{added_codes} codigos).\n")

    try:
        while True:
            print("  Obteniendo pares OTC disponibles...")
            pairs = get_otc_pairs(api)

            if not pairs:
                print(f"  {YELLOW}No se encontraron pares OTC activos.{RESET}")
                input("  Presiona Enter para reintentar...\n")
                continue

            print(f"  {len(pairs)} pares encontrados. Escaneando...\n")
            scan_time = datetime.now().strftime("%H:%M:%S")
            results, missing_consts = scan_once(api, pairs)
            print_results(results, len(pairs), scan_time, missing_consts)
            beep()

            input()

    except KeyboardInterrupt:
        print(f"\n\n  {YELLOW}Escáner detenido.{RESET}\n")

if __name__ == "__main__":
    main()
