"""
OTC Scanner 3 — Detector de Micro-Pausas en Momentum
=====================================================
Encuentra pares OTC con tendencias de momentum fuerte y detecta
micro-acumulaciones (dojis, velas contrarias débiles, rangos
comprimidos) que están a punto de romper en dirección de la tendencia.

3 categorías de señal:
  🔥  ROMPIENDO  —  La vela actual rompe la micro-pausa → ABRIR YA
  ⏳  PAUSADO    —  Micro-pausa activa, esperando ruptura → VIGILAR
  📈  MOMENTUM   —  Tendencia fuerte sin pausa clara → WATCHLIST

Requisitos:
    iqoptionapi (instalado desde GitHub)
    pip install colorama

Uso:
    python otc_scanner3.py
"""

import time, sys, os, threading
from datetime import datetime

# Reconfigure stdout/stderr to UTF-8 on Windows to prevent UnicodeEncodeError
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# ─── Login config ─────────────────────────────────────────────────────────────

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
    print("Instálalo desde: https://github.com/iqoptionapi/iqoptionapi")
    sys.exit(1)

try:
    from colorama import Fore, Style, init
    init(autoreset=True)
    GREEN  = Fore.GREEN
    RED    = Fore.RED
    YELLOW = Fore.YELLOW
    CYAN   = Fore.CYAN
    WHITE  = Fore.WHITE
    MAGENTA = Fore.MAGENTA
    RESET  = Style.RESET_ALL
    BOLD   = Style.BRIGHT
    DIM    = Style.DIM
except ImportError:
    GREEN = RED = YELLOW = CYAN = WHITE = MAGENTA = RESET = BOLD = DIM = ""

# ─── Configuración ────────────────────────────────────────────────────────────

TIMEFRAME       = 60        # velas de 1 minuto
CANDLES_FETCH   = 50        # velas a descargar (más contexto para la tendencia)
TREND_WINDOW    = 20        # ventana para medir slope/tendencia
FAVOR_WINDOW    = 15        # últimas N velas para ratio de velas a favor

# Umbrales de tendencia
SLOPE_MIN       = 0.08      # slope normalizado mínimo para considerar tendencia
SLOPE_STRONG    = 0.20      # slope para tendencia "fuerte"
FAVOR_MIN       = 0.40      # mínimo 40% de velas a favor
FAVOR_STRONG    = 0.55      # 55%+ = tendencia muy consistente

# Micro-pausa
PAUSE_MAX_CANDLES  = 6      # máximo velas que puede durar una pausa
PAUSE_MIN_CANDLES  = 2      # mínimo velas para considerar pausa
BODY_SMALL_RATIO   = 0.55   # cuerpo < 55% del ATR = vela pequeña
DOJI_RATIO         = 0.25   # cuerpo < 25% del rango de la vela = doji
COUNTER_WEAK_RATIO = 0.65   # vela contraria con cuerpo < 65% del promedio = débil
RANGE_COMPRESS     = 0.70   # rango de pausa < 70% del rango promedio previo

# Breakout
BREAK_BODY_MULT    = 1.1    # cuerpo de breakout > 1.1x cuerpo promedio de pausa
BREAK_THRESHOLD    = 0.0001 # margen para considerar que rompió el nivel (0.01%)

# Volatilidad
ATR_MAX_PCT     = 0.0050    # máximo ATR relativo (permisivo para OTC)

# Auto-refresh (solo cuando no hay resultados)
REFRESH_SECONDS = 30        # segundos entre scans automáticos sin resultados

SOUND_ALERT     = True

# ─── Obtener pares OTC activos ────────────────────────────────────────────────

def refresh_active_codes(api):
    """Actualiza la tabla de códigos de activos desde la API."""
    before = len(OP_code.ACTIVES)
    try:
        api.update_ACTIVES_OPCODE()
    except Exception as e:
        print(f"  Aviso: no se pudo actualizar tabla de activos: {e}")
    return max(0, len(OP_code.ACTIVES) - before)


def get_otc_pairs(api):
    """Obtiene todos los pares OTC actualmente abiertos."""
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
    """EMA simple."""
    k = 2 / (period + 1)
    e = prices[0]
    for p in prices[1:]:
        e = p * k + e * (1 - k)
    return e


def calc_atr(highs, lows, closes, period=14):
    """Average True Range suavizado."""
    trs = []
    for i in range(1, len(closes)):
        tr = max(highs[i] - lows[i],
                 abs(highs[i] - closes[i - 1]),
                 abs(lows[i] - closes[i - 1]))
        trs.append(tr)
    if len(trs) < period:
        return 0
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = (atr * (period - 1) + tr) / period
    return atr


def calc_slope_normalized(closes, atr, window=TREND_WINDOW):
    """
    Pendiente de regresión lineal de los últimos N cierres,
    normalizada por ATR. Valores > 1 indican tendencia real.
    Positivo = UP, Negativo = DOWN.
    """
    if len(closes) < window or atr <= 0:
        return 0.0
    segment = closes[-window:]
    n = len(segment)
    x_mean = (n - 1) / 2.0
    y_mean = sum(segment) / n
    num = sum((i - x_mean) * (segment[i] - y_mean) for i in range(n))
    den = sum((i - x_mean) ** 2 for i in range(n))
    slope = num / den if den else 0
    # Normalizar: cuántos ATRs se mueve por vela
    return slope / atr


def calc_candles_in_favor(opens, closes, direction, last_n=FAVOR_WINDOW):
    """Ratio de velas que cierran en dirección de la tendencia."""
    o = opens[-last_n:]
    c = closes[-last_n:]
    count = 0
    for oi, ci in zip(o, c):
        if direction == "UP" and ci > oi:
            count += 1
        elif direction == "DOWN" and ci < oi:
            count += 1
    return count / last_n if last_n > 0 else 0


# ─── Detección de Micro-Pausa ─────────────────────────────────────────────────

def detect_micro_pause(highs, lows, opens, closes, direction, atr):
    """
    Busca una micro-pausa/acumulación en las últimas 2-5 velas.

    Una micro-pausa se forma cuando hay 2+ velas consecutivas (desde la más
    reciente hacia atrás) que muestran:
      - Cuerpos pequeños (< 40% del ATR)
      - Dojis (cuerpo < 20% del rango de la vela)
      - Velas contrarias pero débiles (cuerpo < 50% del promedio)
      - Rango comprimido respecto al movimiento previo

    Retorna:
      - pause_candles: número de velas en la pausa (0 si no hay pausa)
      - zone_high: máximo de la zona de acumulación
      - zone_low: mínimo de la zona de acumulación
      - pause_quality: calidad de la pausa (0-1), cuánto se comprime
    """
    if len(closes) < PAUSE_MAX_CANDLES + 10 or atr <= 0:
        return 0, 0, 0, 0

    # Cuerpo promedio de las velas previas (antes de la posible pausa)
    pre_bodies = [abs(closes[i] - opens[i]) for i in range(-(PAUSE_MAX_CANDLES + 10), -(PAUSE_MAX_CANDLES))]
    avg_body = sum(pre_bodies) / len(pre_bodies) if pre_bodies else atr * 0.5

    # Rango promedio previo
    pre_ranges = [highs[i] - lows[i] for i in range(-(PAUSE_MAX_CANDLES + 8), -(PAUSE_MAX_CANDLES))]
    avg_range = sum(pre_ranges) / len(pre_ranges) if pre_ranges else atr

    # Escanear desde la vela más reciente hacia atrás
    pause_count = 0
    for offset in range(1, PAUSE_MAX_CANDLES + 1):
        idx = -offset
        body = abs(closes[idx] - opens[idx])
        rng = highs[idx] - lows[idx]

        is_small_body = body < atr * BODY_SMALL_RATIO
        is_doji = rng > 0 and body < rng * DOJI_RATIO
        is_weak_counter = False

        # Vela contraria pero débil
        if direction == "UP" and closes[idx] < opens[idx]:
            is_weak_counter = body < avg_body * COUNTER_WEAK_RATIO
        elif direction == "DOWN" and closes[idx] > opens[idx]:
            is_weak_counter = body < avg_body * COUNTER_WEAK_RATIO

        # Vela neutral/a favor pero con cuerpo pequeño también cuenta
        is_tiny_favor = False
        if direction == "UP" and closes[idx] >= opens[idx]:
            is_tiny_favor = body < avg_body * COUNTER_WEAK_RATIO
        elif direction == "DOWN" and closes[idx] <= opens[idx]:
            is_tiny_favor = body < avg_body * COUNTER_WEAK_RATIO

        if is_small_body or is_doji or is_weak_counter or is_tiny_favor:
            pause_count += 1
        else:
            break  # la cadena de pausa se rompió

    if pause_count < PAUSE_MIN_CANDLES:
        return 0, 0, 0, 0

    # Delimitar la zona de acumulación
    pause_highs = [highs[i] for i in range(-pause_count, 0)]
    pause_lows = [lows[i] for i in range(-pause_count, 0)]
    zone_high = max(pause_highs)
    zone_low = min(pause_lows)
    zone_range = zone_high - zone_low

    # Calidad: qué tan comprimida es la pausa respecto al movimiento previo
    pause_quality = 1.0 - min(1.0, (zone_range / avg_range) if avg_range > 0 else 1.0)

    # Bonus si el rango está realmente comprimido
    if avg_range > 0 and zone_range / avg_range < RANGE_COMPRESS:
        pause_quality = min(1.0, pause_quality + 0.15)

    return pause_count, zone_high, zone_low, pause_quality


def detect_breakout(closes, opens, highs, lows, direction, zone_high, zone_low, pause_count, atr):
    """
    Detecta si la vela ACTUAL (la que está formándose) está rompiendo
    la zona de acumulación en la dirección de la tendencia.

    Retorna:
      - is_breaking: bool
      - break_strength: 0-1 cuán fuerte es la ruptura
    """
    if pause_count == 0:
        return False, 0

    current_close = closes[-1]
    current_open = opens[-1]
    current_body = abs(current_close - current_open)

    # Cuerpo promedio de la pausa
    pause_bodies = [abs(closes[i] - opens[i]) for i in range(-pause_count - 1, -1)]
    avg_pause_body = sum(pause_bodies) / len(pause_bodies) if pause_bodies else 0

    # ¿La vela actual rompe el nivel?
    threshold = atr * BREAK_THRESHOLD * 10  # margen pequeño

    if direction == "UP":
        # El precio debe superar el máximo de la zona
        is_above = current_close > zone_high + threshold
        correct_dir = current_close > current_open  # vela alcista
        body_strong = avg_pause_body > 0 and current_body > avg_pause_body * BREAK_BODY_MULT
    else:
        # El precio debe romper por debajo del mínimo de la zona
        is_above = current_close < zone_low - threshold
        correct_dir = current_close < current_open  # vela bajista
        body_strong = avg_pause_body > 0 and current_body > avg_pause_body * BREAK_BODY_MULT

    is_breaking = is_above and correct_dir

    # Fuerza del breakout
    break_strength = 0.0
    if is_breaking:
        break_strength = 0.5
        if body_strong:
            break_strength += 0.3
        # Bonus si la vela se alejó bien del nivel
        if direction == "UP" and zone_high > 0:
            dist = (current_close - zone_high) / atr if atr > 0 else 0
            break_strength += min(0.2, dist * 0.5)
        elif direction == "DOWN" and zone_low > 0:
            dist = (zone_low - current_close) / atr if atr > 0 else 0
            break_strength += min(0.2, dist * 0.5)
        break_strength = min(1.0, break_strength)

    return is_breaking, break_strength


# ─── Análisis Principal ───────────────────────────────────────────────────────

def analyze(candles):
    """
    Analiza un par y determina su categoría:
      - "ROMPIENDO": micro-pausa detectada + breakout activo
      - "PAUSADO": micro-pausa detectada, esperando ruptura
      - "MOMENTUM": tendencia fuerte sin pausa clara
      - None: no cumple criterios mínimos
    """
    if len(candles) < TREND_WINDOW + PAUSE_MAX_CANDLES + 12:
        return None

    closes = [c["close"] for c in candles]
    highs  = [c["max"]   for c in candles]
    lows   = [c["min"]   for c in candles]
    opens  = [c["open"]  for c in candles]

    # 1. ATR
    atr = calc_atr(highs, lows, closes)
    atr_pct = atr / closes[-1] if closes[-1] else 1.0

    # Filtro de volatilidad extrema
    if atr_pct > ATR_MAX_PCT:
        return None

    # 2. Dirección por EMA
    ema5 = calc_ema(closes, 5)
    ema13 = calc_ema(closes, 13)
    ema_dir = "UP" if ema5 > ema13 else "DOWN"

    # 3. Slope normalizado (momentum real)
    slope = calc_slope_normalized(closes, atr)
    slope_dir = "UP" if slope > 0 else "DOWN"

    # EMA y slope deben coincidir en dirección
    if ema_dir != slope_dir:
        return None

    direction = ema_dir
    abs_slope = abs(slope)

    # Umbral mínimo de tendencia
    if abs_slope < SLOPE_MIN:
        return None

    # 4. Velas a favor
    favor_ratio = calc_candles_in_favor(opens, closes, direction)
    if favor_ratio < FAVOR_MIN:
        return None

    # ─── Hasta aquí: el par tiene tendencia válida ───

    # 5. Detectar micro-pausa
    pause_count, zone_high, zone_low, pause_quality = detect_micro_pause(
        highs, lows, opens, closes, direction, atr
    )

    # 6. Detectar breakout
    is_breaking = False
    break_strength = 0.0
    dist_to_break = 0.0

    if pause_count >= PAUSE_MIN_CANDLES:
        is_breaking, break_strength = detect_breakout(
            closes, opens, highs, lows, direction,
            zone_high, zone_low, pause_count, atr
        )

        # Calcular distancia al borde de la zona
        if direction == "UP" and zone_high > 0 and closes[-1] > 0:
            dist_to_break = (zone_high - closes[-1]) / closes[-1]
        elif direction == "DOWN" and zone_low > 0 and closes[-1] > 0:
            dist_to_break = (closes[-1] - zone_low) / closes[-1]
        # Si ya rompió, distancia es 0 o negativa
        if is_breaking:
            dist_to_break = 0.0

    # 7. Clasificar
    if pause_count >= PAUSE_MIN_CANDLES and is_breaking:
        tier = "ROMPIENDO"
    elif pause_count >= PAUSE_MIN_CANDLES:
        tier = "PAUSADO"
    elif abs_slope >= SLOPE_STRONG and favor_ratio >= FAVOR_STRONG:
        tier = "MOMENTUM"
    elif abs_slope >= SLOPE_MIN:
        tier = "MOMENTUM"
    else:
        return None

    # Calcular velas concretas a favor (para mostrar)
    favor_count = int(round(favor_ratio * FAVOR_WINDOW))

    return {
        "tier":           tier,
        "direction":      direction,
        "slope":          slope,
        "abs_slope":      abs_slope,
        "favor_ratio":    favor_ratio,
        "favor_count":    favor_count,
        "atr_pct":        atr_pct,
        "pause_count":    pause_count,
        "zone_high":      zone_high,
        "zone_low":       zone_low,
        "pause_quality":  pause_quality,
        "is_breaking":    is_breaking,
        "break_strength": break_strength,
        "dist_to_break":  dist_to_break,
    }


# ─── Utilidades ───────────────────────────────────────────────────────────────

def beep_breaking():
    """Sonido urgente para ROMPIENDO — triple beep agudo."""
    if not SOUND_ALERT:
        return
    try:
        import winsound
        for _ in range(3):
            winsound.Beep(1200, 150)
            time.sleep(0.08)
        time.sleep(0.15)
        for _ in range(2):
            winsound.Beep(1500, 100)
            time.sleep(0.06)
    except Exception:
        print("\a")


def beep_pause():
    """Sonido suave para nuevas pausas detectadas."""
    if not SOUND_ALERT:
        return
    try:
        import winsound
        winsound.Beep(800, 200)
    except Exception:
        print("\a")


def beep_scan_done():
    """Beep simple al terminar cada escaneo (siempre suena)."""
    if not SOUND_ALERT:
        return
    try:
        import winsound
        for _ in range(3):
            winsound.Beep(1000, 200)
            time.sleep(0.1)
    except Exception:
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
        print(f"  {YELLOW}Credenciales fijas no configuradas. Login manual:{RESET}")
        email = input("  Email IQ Option:  ").strip()
        password = input("  Contraseña:       ").strip()

    return email, password


# ─── Scan y Output ────────────────────────────────────────────────────────────

def scan_once(api, pairs):
    """Escanea todos los pares y retorna resultados clasificados."""
    results = []
    total = len(pairs)
    missing = []

    for i, pair in enumerate(pairs, 1):
        sys.stdout.write(f"\r  Analizando {i}/{total}: {pair:<25}")
        sys.stdout.flush()

        if pair not in OP_code.ACTIVES:
            missing.append(pair)
            continue

        try:
            candles = api.get_candles(pair, TIMEFRAME, CANDLES_FETCH, time.time())
            if candles:
                res = analyze(candles)
                if res:
                    results.append((pair, res))
        except Exception:
            pass
        time.sleep(0.20)

    sys.stdout.write("\r" + " " * 60 + "\r")
    return results, missing


def sort_results(results):
    """Ordena: ROMPIENDO primero (por break_strength), luego PAUSADO (por dist), luego MOMENTUM (por slope)."""
    tier_order = {"ROMPIENDO": 0, "PAUSADO": 1, "MOMENTUM": 2}

    def sort_key(item):
        _, r = item
        tier = tier_order.get(r["tier"], 9)
        if r["tier"] == "ROMPIENDO":
            secondary = -r["break_strength"]
        elif r["tier"] == "PAUSADO":
            secondary = r["dist_to_break"]
        else:
            secondary = -r["abs_slope"]
        return (tier, secondary)

    return sorted(results, key=sort_key)


def print_results(results, n_pairs, scan_time, countdown_start, missing_count=0):
    """Imprime los resultados formateados por categoría."""
    clear()

    # Header
    print(f"\n{BOLD}{CYAN}{'═' * 66}")
    print(f"  🎯  OTC SCANNER 3 — Micro-Pausas en Momentum")
    print(f"  {scan_time}  |  {n_pairs} pares  |  Auto-refresh: {REFRESH_SECONDS}s")
    print(f"{'═' * 66}{RESET}\n")

    ordered = sort_results(results)

    rompiendo = [(p, r) for p, r in ordered if r["tier"] == "ROMPIENDO"]
    pausados  = [(p, r) for p, r in ordered if r["tier"] == "PAUSADO"]
    momentum  = [(p, r) for p, r in ordered if r["tier"] == "MOMENTUM"]

    has_signals = bool(rompiendo or pausados)

    # ── ROMPIENDO ──
    if rompiendo:
        print(f"  {BOLD}{RED}🔥 ROMPIENDO AHORA ({len(rompiendo)}){RESET}")
        print(f"  {DIM}{'─' * 62}{RESET}")
        print(f"  {BOLD}{'PAR':<22} {'DIR':<8} {'SLOPE':>6} {'PAUSA':>6} {'FUERZA':>7}{RESET}")
        for pair, r in rompiendo:
            if r["direction"] == "UP":
                arrow = f"{GREEN}▲ SUBE{RESET}"
                color = GREEN
            else:
                arrow = f"{RED}▼ BAJA{RESET}"
                color = RED

            slope_str = f"{'+' if r['slope'] > 0 else ''}{r['slope']:.1f}"
            pause_str = f"{r['pause_count']}v"
            strength = "█" * int(r["break_strength"] * 5) + "░" * (5 - int(r["break_strength"] * 5))

            print(f"  {BOLD}{color}{pair:<22}{RESET} {arrow}  {slope_str:>6} {pause_str:>6} {BOLD}{color}{strength}{RESET}")
        print()

    # ── PAUSADO ──
    if pausados:
        print(f"  {BOLD}{YELLOW}⏳ PAUSADO — VIGILAR ({len(pausados)}){RESET}")
        print(f"  {DIM}{'─' * 62}{RESET}")
        print(f"  {BOLD}{'PAR':<22} {'DIR':<8} {'SLOPE':>6} {'PAUSA':>6} {'DIST':>8}{RESET}")
        for pair, r in pausados:
            if r["direction"] == "UP":
                arrow = f"{GREEN}▲ SUBE{RESET}"
                color = GREEN
            else:
                arrow = f"{RED}▼ BAJA{RESET}"
                color = RED

            slope_str = f"{'+' if r['slope'] > 0 else ''}{r['slope']:.1f}"
            pause_str = f"{r['pause_count']}v"
            dist_str = f"{r['dist_to_break'] * 100:.3f}%"

            print(f"  {color}{pair:<22}{RESET} {arrow}  {slope_str:>6} {pause_str:>6} {YELLOW}{dist_str:>8}{RESET}")
        print()

    # ── MOMENTUM ──
    if momentum:
        # Mostrar máximo 10 de momentum para no saturar
        shown = momentum[:10]
        extra = len(momentum) - len(shown)

        print(f"  {BOLD}{CYAN}📈 MOMENTUM SIN PAUSA ({len(momentum)}){RESET}")
        print(f"  {DIM}{'─' * 62}{RESET}")
        print(f"  {BOLD}{'PAR':<22} {'DIR':<8} {'SLOPE':>6} {'V.FAVOR':>8}{RESET}")
        for pair, r in shown:
            if r["direction"] == "UP":
                arrow = f"{GREEN}▲ SUBE{RESET}"
            else:
                arrow = f"{RED}▼ BAJA{RESET}"

            slope_str = f"{'+' if r['slope'] > 0 else ''}{r['slope']:.1f}"
            favor_str = f"{r['favor_count']}/{FAVOR_WINDOW}"

            print(f"  {DIM}{pair:<22}{RESET} {arrow}  {slope_str:>6} {favor_str:>8}")

        if extra > 0:
            print(f"  {DIM}  ... +{extra} más con momentum{RESET}")
        print()

    # ── Resumen si no hay señales activas ──
    if not has_signals and not momentum:
        print(f"  {YELLOW}Sin señales en este ciclo.{RESET}")
        print(f"  {DIM}Esperando tendencias con momentum...{RESET}\n")
    elif not has_signals:
        print(f"  {DIM}No hay micro-pausas activas. Los pares con momentum")
        print(f"  podrían formar pausas pronto — el scanner las detectará.{RESET}\n")

    # ── Footer ──
    if missing_count > 0:
        print(f"  {DIM}Pares sin código interno: {missing_count}{RESET}")

    total_signals = len(rompiendo) + len(pausados)
    print(f"\n  {DIM}Señales activas: {total_signals}  |  Momentum: {len(momentum)}  |  Total analizados: {n_pairs}{RESET}")
    print(f"  {'─' * 66}")
    print(f"\n  {BOLD}Ctrl+C{RESET} para salir  |  {DIM}El scanner se refresca automáticamente{RESET}\n")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{BOLD}{CYAN}🎯 OTC Scanner 3 — Micro-Pausas en Momentum{RESET}")
    print(f"  {DIM}Detecta acumulaciones micro en tendencias fuertes{RESET}\n")

    email, password = get_credentials()

    print("\n  Conectando...")
    api = IQ_Option(email, password)
    check, reason = api.connect()
    if not check:
        print(f"\n{RED}Error de conexión: {reason}{RESET}")
        sys.exit(1)

    api.change_balance("PRACTICE")
    print(f"  {GREEN}Conectado correctamente.{RESET}\n")

    added = refresh_active_codes(api)
    print(f"  Tabla de activos actualizada (+{added} códigos).\n")

    prev_rompiendo = set()

    try:
        while True:
            print("  Obteniendo pares OTC disponibles...")
            pairs = get_otc_pairs(api)

            if not pairs:
                print(f"  {YELLOW}No se encontraron pares OTC activos.{RESET}")
                time.sleep(5)
                continue

            print(f"  {len(pairs)} pares encontrados. Escaneando...\n")
            scan_time = datetime.now().strftime("%H:%M:%S")

            results, missing = scan_once(api, pairs)

            # Beep siempre al terminar el scan
            beep_scan_done()

            # Sonidos extra diferenciados por señales
            current_rompiendo = set(p for p, r in results if r["tier"] == "ROMPIENDO")
            new_rompiendo = current_rompiendo - prev_rompiendo

            if new_rompiendo:
                time.sleep(0.3)
                beep_breaking()
            elif any(r["tier"] == "PAUSADO" for _, r in results):
                time.sleep(0.3)
                beep_pause()

            prev_rompiendo = current_rompiendo

            has_signals = len(results) > 0

            print_results(results, len(pairs), scan_time, time.time(), len(missing))

            if has_signals:
                # HAY resultados → esperar Enter del usuario
                print(f"  Presiona {BOLD}Enter{RESET} para volver a escanear  |  "
                      f"{BOLD}Ctrl+C{RESET} para salir\n")
                try:
                    input()
                except EOFError:
                    pass
            else:
                # SIN resultados → auto-refresh con countdown
                # Usar threading para que Enter interrumpa el countdown
                enter_pressed = threading.Event()

                def wait_for_enter():
                    try:
                        input()
                        enter_pressed.set()
                    except (EOFError, OSError):
                        pass

                input_thread = threading.Thread(target=wait_for_enter, daemon=True)
                input_thread.start()

                try:
                    for remaining in range(REFRESH_SECONDS, 0, -1):
                        if enter_pressed.is_set():
                            break
                        sys.stdout.write(
                            f"\r  ⏱  Auto-scan en {remaining}s... "
                            f"(Enter para scan inmediato) "
                        )
                        sys.stdout.flush()
                        time.sleep(1)
                    sys.stdout.write("\r" + " " * 65 + "\r")
                except KeyboardInterrupt:
                    raise

    except KeyboardInterrupt:
        print(f"\n\n  {YELLOW}Scanner detenido.{RESET}\n")


if __name__ == "__main__":
    main()
