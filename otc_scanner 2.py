"""
Escáner de Tendencias Fuertes OTC — IQ Option
===============================================
Detecta pares OTC con:
  - Tendencia fuerte y sostenida (ADX + EMA)
  - Pocos retrocesos (eficiencia + R²)
  - Mayoría de velas a favor (4-6 de cada 10)
  - Volatilidad controlada (ATR relativo bajo)
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
    from iqoptionapi.stable_api import IQ_Option
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

# Momentum / tendencia
ADX_MIN       = 28       # fuerza mínima de tendencia
R2_MIN        = 0.82     # linealidad del movimiento
EFF_MIN       = 0.52     # eficiencia (pocos retrocesos)

# Velas a favor: de las últimas 10 velas, mínimo N cierran en dirección correcta
CANDLES_IN_FAVOR_MIN = 6   # entre 4 y 6 — sube para más exigencia

# Volatilidad: ATR como % del precio — si es muy alto hay saltos bruscos
ATR_MAX_PCT   = 0.0025   # máximo 0.25% de ATR relativo

# Camino libre antes del próximo S/R
FREE_PATH_MIN = 0.0005   # 0.05%

SOUND_ALERT   = True

# ─── Obtener pares OTC activos ────────────────────────────────────────────────

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

def calc_candles_in_favor(opens, closes, direction, last_n=10):
    """Cuenta cuántas de las últimas N velas cierran en la dirección correcta."""
    opens  = opens[-last_n:]
    closes = closes[-last_n:]
    count  = 0
    for o, c in zip(opens, closes):
        if direction == "UP"   and c > o: count += 1
        if direction == "DOWN" and c < o: count += 1
    return count

def calc_sr_levels(highs, lows):
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
        if not merged or abs(lv - merged[-1]) / merged[-1] > FREE_PATH_MIN:
            merged.append(lv)
    return merged

def free_path(closes, highs, lows, direction):
    current = closes[-1]
    levels  = calc_sr_levels(highs, lows)
    if direction == "UP":
        obstacles = [l for l in levels if l > current * 1.0001]
        if not obstacles:
            return 1.0
        return (min(obstacles) - current) / current
    else:
        obstacles = [l for l in levels if l < current * 0.9999]
        if not obstacles:
            return 1.0
        return (current - max(obstacles)) / current

def analyze(candles):
    if len(candles) < 20:
        return None

    closes = [c["close"] for c in candles]
    highs  = [c["max"]   for c in candles]
    lows   = [c["min"]   for c in candles]
    opens  = [c["open"]  for c in candles]

    # ADX y dirección
    adx_result = calc_adx(highs, lows, closes)
    if not adx_result:
        return None
    adx, adx_dir = adx_result

    # EMA confirma dirección
    ema5    = calc_ema(closes, 5)
    ema13   = calc_ema(closes, 13)
    ema_dir = "UP" if ema5 > ema13 else "DOWN"
    direction = adx_dir if adx_dir == ema_dir else None

    # Calidad del movimiento
    r2  = calc_r2(closes[-20:])
    eff = calc_efficiency(closes[-20:])

    # Velas a favor
    cif = calc_candles_in_favor(opens, closes, direction, last_n=10) if direction else 0

    # Volatilidad controlada
    atr     = calc_atr(highs, lows, closes)
    atr_pct = atr / closes[-1] if closes[-1] else 1

    # Camino libre
    space = free_path(closes, highs, lows, direction) if direction else 0

    passes = (
        adx       >= ADX_MIN             and
        r2        >= R2_MIN              and
        eff       >= EFF_MIN             and
        cif       >= CANDLES_IN_FAVOR_MIN and
        atr_pct   <= ATR_MAX_PCT         and
        space     >= FREE_PATH_MIN       and
        direction is not None
    )

    return {
        "passes":    passes,
        "direction": direction,
        "adx":       adx,
        "r2":        r2,
        "eff":       eff,
        "cif":       cif,
        "atr_pct":   atr_pct,
        "space":     space,
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

def scan_once(api, pairs):
    results = []
    total = len(pairs)
    for i, pair in enumerate(pairs, 1):
        sys.stdout.write(f"\r  Analizando {i}/{total}: {pair:<25}")
        sys.stdout.flush()
        try:
            candles = api.get_candles(pair, TIMEFRAME, CANDLES_COUNT, time.time())
            if candles:
                res = analyze(candles)
                if res:
                    results.append((pair, res))
        except:
            pass
        time.sleep(0.25)
    sys.stdout.write("\r" + " "*60 + "\r")
    return results

def print_results(results, n_pairs, scan_time):
    clear()
    print(f"{BOLD}{CYAN}{'═'*70}")
    print(f"  ESCÁNER OTC — Tendencias Fuertes y Limpias")
    print(f"  Escaneado: {scan_time}  |  Pares revisados: {n_pairs}")
    print(f"  ADX≥{ADX_MIN}  R²≥{R2_MIN}  Efic≥{EFF_MIN}  "
          f"Velas a favor≥{CANDLES_IN_FAVOR_MIN}/10  Espacio≥{FREE_PATH_MIN*100:.2f}%")
    print(f"{'═'*70}{RESET}\n")

    clean = [(p,r) for p,r in results if r["passes"]]
    noisy = [(p,r) for p,r in results if not r["passes"]]

    if clean:
        beep()
        print(f"{BOLD}{GREEN}  ✅ TENDENCIAS FUERTES Y LIMPIAS ({len(clean)}){RESET}\n")
        print(f"  {BOLD}{'PAR':<22} {'DIR':<9} {'ADX':>5} {'R²':>5} "
              f"{'EFIC':>5} {'V/10':>5} {'ESPACIO':>8}{RESET}")
        print(f"  {'─'*63}")
        for pair, r in sorted(clean, key=lambda x: (-x[1]["adx"], -x[1]["eff"])):
            color = GREEN if r["direction"] == "UP" else RED
            arrow = "▲ SUBE" if r["direction"] == "UP" else "▼ BAJA"
            sp    = f"{r['space']*100:.3f}%"
            print(f"  {color}{pair:<22} {arrow:<9}"
                  f"{r['adx']:>5.1f} {r['r2']:>5.2f} {r['eff']:>5.2f} "
                  f"{r['cif']:>5}/10 {sp:>8}{RESET}")
    else:
        print(f"  {YELLOW}Sin tendencias fuertes y limpias ahora mismo.{RESET}\n")
        print(f"  {YELLOW}Todos los pares tienen correcciones o volatilidad alta.{RESET}\n")

    if noisy:
        print(f"\n  {BOLD}Pares cercanos pero sin señal ({len(noisy)}):{RESET}")
        # Mostrar solo los que pasaron al menos 3 filtros (los más cercanos)
        def score(r):
            s = 0
            if r["adx"]     >= ADX_MIN:             s += 1
            if r["r2"]      >= R2_MIN:              s += 1
            if r["eff"]     >= EFF_MIN:             s += 1
            if r["cif"]     >= CANDLES_IN_FAVOR_MIN: s += 1
            if r["atr_pct"] <= ATR_MAX_PCT:         s += 1
            if r["space"]   >= FREE_PATH_MIN:       s += 1
            return s

        near = [(p,r) for p,r in noisy if score(r) >= 3]
        rest = [(p,r) for p,r in noisy if score(r) < 3]

        for pair, r in sorted(near, key=lambda x: -score(x[1])):
            d  = r["direction"] or "─"
            sp = f"{r['space']*100:.3f}%" if r["direction"] else "─"
            ok = score(r)
            print(f"  {pair:<22}  {ok}/6 filtros  ADX:{r['adx']:>5.1f}  "
                  f"R²:{r['r2']:.2f}  Efic:{r['eff']:.2f}  "
                  f"V:{r['cif']}/10  Esp:{sp}  Dir:{d}")

        if rest:
            names = ", ".join(p for p,_ in rest)
            print(f"\n  {RESET}Descartados (≤2 filtros): {names}")

    print(f"\n{'─'*70}")
    print(f"\n  Presiona {BOLD}Enter{RESET} para volver a escanear  |  "
          f"{BOLD}Ctrl+C{RESET} para salir\n")

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{BOLD}Escáner OTC — Tendencias Fuertes y Limpias{RESET}\n")
    email    = input("  Email IQ Option:  ").strip()
    password = input("  Contraseña:       ").strip()

    print("\n  Conectando...")
    api = IQ_Option(email, password)
    check, reason = api.connect()
    if not check:
        print(f"\n{RED}Error de conexión: {reason}{RESET}")
        sys.exit(1)

    api.change_balance("PRACTICE")
    print(f"  {GREEN}Conectado correctamente.{RESET}\n")

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
            results   = scan_once(api, pairs)
            print_results(results, len(pairs), scan_time)

            input()

    except KeyboardInterrupt:
        print(f"\n\n  {YELLOW}Escáner detenido.{RESET}\n")

if __name__ == "__main__":
    main()
