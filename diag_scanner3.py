"""
Diagnostico: muestra los valores reales de cada par para entender
por que el scanner 3 no entrega resultados.
"""
import time, sys, os
os.environ["PYTHONIOENCODING"] = "utf-8"

from login_config import USE_INTERACTIVE_LOGIN, FIXED_EMAIL, FIXED_PASSWORD
from iqoptionapi.stable_api import IQ_Option
import iqoptionapi.constants as OP_code

from otc_scanner3 import (
    calc_ema, calc_atr, calc_slope_normalized,
    calc_candles_in_favor, detect_micro_pause,
    TIMEFRAME, CANDLES_FETCH, TREND_WINDOW, FAVOR_WINDOW,
    SLOPE_MIN, FAVOR_MIN, ATR_MAX_PCT,
    refresh_active_codes, get_otc_pairs
)

def diag_analyze(candles):
    if len(candles) < 30:
        return {"reject": "pocas_velas", "count": len(candles)}

    closes = [c["close"] for c in candles]
    highs  = [c["max"]   for c in candles]
    lows   = [c["min"]   for c in candles]
    opens  = [c["open"]  for c in candles]

    atr = calc_atr(highs, lows, closes)
    atr_pct = atr / closes[-1] if closes[-1] else 1.0

    ema5 = calc_ema(closes, 5)
    ema13 = calc_ema(closes, 13)
    ema_dir = "UP" if ema5 > ema13 else "DOWN"

    slope = calc_slope_normalized(closes, atr)
    slope_dir = "UP" if slope > 0 else "DOWN"
    abs_slope = abs(slope)

    dir_match = ema_dir == slope_dir
    direction = ema_dir if dir_match else None

    favor = calc_candles_in_favor(opens, closes, ema_dir) if direction else 0

    pause_count = 0
    if direction:
        pause_count, zh, zl, pq = detect_micro_pause(highs, lows, opens, closes, direction, atr)

    reasons = []
    if not dir_match:
        reasons.append("DIR_NO_MATCH")
    if abs_slope < SLOPE_MIN:
        reasons.append(f"SLOPE_BAJO({abs_slope:.3f}<{SLOPE_MIN})")
    if direction and favor < FAVOR_MIN:
        reasons.append(f"FAVOR_BAJO({favor:.2f}<{FAVOR_MIN})")
    if atr_pct > ATR_MAX_PCT:
        reasons.append(f"ATR_ALTO({atr_pct:.4f}>{ATR_MAX_PCT})")

    return {
        "atr": atr,
        "atr_pct": atr_pct,
        "ema_dir": ema_dir,
        "slope": slope,
        "abs_slope": abs_slope,
        "slope_dir": slope_dir,
        "dir_match": dir_match,
        "favor": favor,
        "pause": pause_count,
        "reasons": reasons,
    }

def main():
    email = FIXED_EMAIL if not USE_INTERACTIVE_LOGIN else input("Email: ").strip()
    password = FIXED_PASSWORD if not USE_INTERACTIVE_LOGIN else input("Pass: ").strip()

    api = IQ_Option(email, password)
    check, reason = api.connect()
    if not check:
        print(f"Error: {reason}")
        sys.exit(1)
    api.change_balance("PRACTICE")
    refresh_active_codes(api)

    pairs = get_otc_pairs(api)
    print(f"\n{'='*90}")
    print(f"  DIAGNOSTICO -- {len(pairs)} pares OTC")
    print(f"  Umbrales: SLOPE_MIN={SLOPE_MIN}  FAVOR_MIN={FAVOR_MIN}  ATR_MAX={ATR_MAX_PCT}")
    print(f"{'='*90}\n")

    print(f"  {'PAR':<24} {'EMA':>4} {'SLOPE':>7} {'|S|':>5} {'FAV':>5} {'ATR%':>7} {'PAUS':>4}  RECHAZO")
    print(f"  {'-'*86}")

    stats = {"total": 0, "pass": 0, "dir_fail": 0, "slope_fail": 0, "favor_fail": 0, "atr_fail": 0}

    for pair in pairs:
        if pair not in OP_code.ACTIVES:
            continue
        try:
            candles = api.get_candles(pair, TIMEFRAME, CANDLES_FETCH, time.time())
            if not candles:
                continue
        except:
            continue

        r = diag_analyze(candles)
        stats["total"] += 1

        if "reject" in r:
            print(f"  {pair:<24} -- pocas velas ({r['count']})")
            continue

        reasons_str = ", ".join(r["reasons"]) if r["reasons"] else ">> PASA <<"
        prefix = ">>> " if not r["reasons"] else "    "

        if not r["reasons"]:
            stats["pass"] += 1
        if not r["dir_match"]:
            stats["dir_fail"] += 1
        if r["abs_slope"] < SLOPE_MIN:
            stats["slope_fail"] += 1
        if r["dir_match"] and r["favor"] < FAVOR_MIN:
            stats["favor_fail"] += 1
        if r["atr_pct"] > ATR_MAX_PCT:
            stats["atr_fail"] += 1

        print(f"  {prefix}{pair:<24} {r['ema_dir']:>4} {r['slope']:>+7.3f} {r['abs_slope']:>5.3f} "
              f"{r['favor']:>5.2f} {r['atr_pct']*100:>6.3f}% {r['pause']:>4}  {reasons_str}")

        time.sleep(0.2)

    print(f"\n{'='*90}")
    print(f"  RESUMEN:")
    print(f"    Total analizados:  {stats['total']}")
    print(f"    Pasan filtros:     {stats['pass']}")
    print(f"    Rechazo DIR:       {stats['dir_fail']}")
    print(f"    Rechazo SLOPE:     {stats['slope_fail']}")
    print(f"    Rechazo FAVOR:     {stats['favor_fail']}")
    print(f"    Rechazo ATR:       {stats['atr_fail']}")
    print(f"{'='*90}")

if __name__ == "__main__":
    main()
