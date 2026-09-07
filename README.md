<div align="center">

# 📉 Parabolic Scanner — Binance 

**Watches the top 60 USDT perpetuals on Binance by 24h volume and flags the ones most likely to fall hard in the next 12 hours.**

_It ranks and records — it never places a trade._

![status](https://img.shields.io/badge/status-live-brightgreen?style=for-the-badge)
![port](https://img.shields.io/badge/port-8805-blue?style=for-the-badge)
![data](https://img.shields.io/badge/data-Binance-F0B90B?style=for-the-badge)
![trades](https://img.shields.io/badge/places%20trades-never-lightgrey?style=for-the-badge)
![license](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/richardcuyk)
[![Donate USDT (BEP20)](https://img.shields.io/badge/Donate-USDT_BEP20-26A17B?style=for-the-badge&logo=tether&logoColor=white)](#-donate)

[Overview](#-overview) ·
[Quick Start](#-quick-start) ·
[How grading works](#-how-a-coin-gets-graded) ·
[Why this isn't a port](#-why-this-isnt-just-a-port-of-the-gate-version) ·
[30-day results](#-30-day-results) ·
[API](#-api) ·
[Honest summary](#-the-honest-summary)

</div>

* * *

> **This is a fork, not a port.** Binance publishes no market-wide liquidation
> feed — the single strongest signal the original Gate.io scanner has does not
> exist here. Every rule below was independently re-measured on Binance's own
> 30 days of open-interest, taker-flow and price data. Read
> [why this isn't a port](#-why-this-isnt-just-a-port-of-the-gate-version)
> before assuming the two scanners agree on anything beyond their shape.

* * *

## ✨ Overview

Same architecture as the original: one process (`scanner.cjs`) polls Binance's
public futures API, grades every coin against rules measured on real
historical outcomes, and serves the result over a small dashboard
(`server.cjs`, port 8805). It holds no exchange keys, places no orders, and
reads no other local service.

Five tiers, same as the original: **PRIME → IMMINENT → DANGER → WARNING →
QUIET**. What differs is *what the rules are measured on* and, for PRIME,
*how the conditions combine* — see below.

## 🚀 Quick Start

### 1. Prerequisites
Node.js 18+, no exchange account needed (public data only).

### 2. Install
```bash
npm install
```

### 3. Run
```bash
node scanner.cjs   # the detector — polls Binance, writes data/state.json
node server.cjs     # the dashboard — reads state.json, serves :8805
```

### 4. Open it
http://localhost:8805

## 🧠 How a coin gets graded

### PRIME — a joint condition, not four independent paths

```js
ret24 >= 30%  AND  (
  open interest +30%+ in 24h   OR
  20%+ below the 7d high        OR
  a violent 4h move (>5%)
)
```

Price move ≥30% is a **required gate**. It started as four independent
either/or rules (matching the original's shape) but real candidates showed
open-interest-only or distance-from-high-only coins reaching PRIME with price
barely moving — one, `PONS`, was actually *down* -10.4% while flagged PRIME on
OI alone. Requiring both together roughly **doubled precision** (see
[30-day results](#-30-day-results)) at the cost of firing far less often.

### IMMINENT / DANGER / WARNING — single measured conditions

| Tier | Condition | Lift (train/test) |
|---|---|---|
| IMMINENT | open interest +30%+ in 24h (OI-only) | 10.38x / 6.30x |
| IMMINENT | violent 4h move down (< -5%) | 8.39x / 4.78x |
| IMMINENT | open interest +5%+ in 6h | 4.28x / 3.20x |
| IMMINENT | volume surge above 4x | 2.24x / 2.81x |
| IMMINENT | RSI 80+ | 2.52x / 2.18x |
| DANGER | 24h move +5..20% | 2.74x / 1.98x |
| DANGER | open interest +10..30% in 24h | 3.34x / 1.92x |
| DANGER | open interest unwinding (< -10%/24h) | 1.74x / 1.74x |
| DANGER | RSI 70-80 | 2.55x / 1.66x |
| DANGER | taker ratio, neutral 0.95-1.05 band | 1.78x / 1.73x |
| WARNING | taker ratio 1.05-1.2 | 1.34x / 1.32x |
| WARNING | volume surge 2-4x | 1.97x / 1.64x |
| WARNING | funding rate 0.01-0.05% | 1.45x / 1.36x |

Every number above is printed on the card that fires it — reproduce with
`node dump-study.cjs --symbols=60`.

### Dampeners

Conditions measured **below** the base rate, on both halves — evidence
*against* a dump, cost one tier no matter how many fire:

| Condition | Lift |
|---|---|
| Flat 24h move (-5%..5%) | 0.21x / 0.33x |
| OI flat-to-down (-10%..0%/24h) | 0.14x / 0.48x |
| Taker ratio at an extreme (<0.85 or ≥1.2) | 0.48x/0.62x low · 0.46x/0.55x high |

That last one is the finding that shapes the whole file: **a low taker ratio
looks bearish and measures the opposite.** Extremes on both ends are *less*
likely to dump than the neutral band. Do not "fix" this back.

## 🆚 Why this isn't just a port of the Gate version

Gate's `contract_stats` bundles open interest, taker ratio, top-trader
positioning **and liquidation volume** in one call. Liquidation share of OI
was Gate's single best-measured signal (5.98x/6.28x). Binance was checked
directly, not assumed:

| Data | Binance public API | Verdict |
|---|---|---|
| Open interest | `/fapi/v1/openInterest`, `/futures/data/openInterestHist` | ✅ available |
| Taker buy/sell ratio | `/futures/data/takerlongshortRatio` | ✅ available |
| Top-trader position/account ratio | `/futures/data/topLongShort*Ratio` | ✅ available |
| Market-wide liquidations | `/fapi/v1/allForceOrders` | ❌ **404s — removed by Binance.** `/fapi/v1/forceOrders` still exists but is account-scoped only, useless as a market signal |

So this fork keeps everything Gate has *except* liquidation, and every
threshold was re-measured from scratch on Binance's own data rather than
copied — a rule that scored well on Gate's coin mix (small-cap, degen-heavy)
was not assumed to transfer to Binance's (larger, more liquid).

## 📊 30-day results

Measured on 37,620 real hourly observations across 57 USDT perpetuals, last
30 days, odd/even symbol split (train vs. test, each scored against its own
base rate). Outcome = price fell 10%+ within 12h. Reproduce with
`node dump-study.cjs --symbols=60` (raw features) then
`node validate-tiers.cjs` (the actual joint `grade()` output against real
outcomes — not just individual features in isolation).

| Tier | n (test) | Real dump rate | vs. base (3.99%) | 95% CI |
|---|---|---|---|---|
| **PRIME** | 256 | **55.08%** | **13.81x** | 49.0–61.1% |
| IMMINENT | 1,309 | 12.07% | 3.03x | 10.4–13.9% |
| DANGER | 4,395 | 5.98% | 1.50x | 5.3–6.7% |
| WARNING | 3,973 | 2.47% | 0.62x | 2.0–3.0% |
| QUIET | 8,547 | 0.90% | 0.23x | 0.7–1.1% |

Tier ordering is monotonic (each tier's real rate ≥ the one below) on the
test half — the ranking itself is correct, not just "elevated vs. base."

**Caveats, stated plainly:**
- One 30-day window, one market regime. Re-run periodically; do not treat
  55% as fixed.
- PRIME's n=256 is a real sample, not a huge one — the 49–61% CI is the
  honest range.
- "Dumped 10% in 12h" validates the *detection*, not the trade rules built on
  top of it (entry/target/stop, fees, slippage, fills).
- Train/test base rates disagreed 1.9x in the underlying single-feature
  study — real volatility in the data, a reason for caution, not dismissal.

## 🛰️ Where the data comes from

Universe: top 60 USDT-margined perpetuals on Binance by 24h volume,
`exchangeInfo`-filtered to `contractType=PERPETUAL` (excludes dated delivery
contracts, which expire and carry no funding rate). Re-ranked every 5
minutes. **This will not be the same 60 coins every day** — the rules are
fixed, the membership is not.

## 🧩 API

| Endpoint | Returns |
|---|---|
| `GET /api/scan?tf=h1` | Full candidate list with tiers, reasons, features |
| `GET /api/pairlist` | Freqtrade `RemotePairList`-compatible pair list |
| `GET /api/outcomes` | Live outcome tracking (open + resolved signals) |
| `GET /api/bars?symbol=...` | Raw OHLC for one symbol |

Same shape as the Gate scanner's API — a Freqtrade bot pointed at Gate's
scanner can be repointed here by changing only the URL.

## 🗂️ Project structure

```
binance.cjs      Binance data layer (klines, OI, taker, funding) - no liquidation fields
score.cjs        Grading rules, measured on Binance data (this file's numbers ≠ Gate's)
scanner.cjs      Poll loop, hysteresis, outcome tracking
server.cjs       Dashboard + API
dashboard.html   The UI
dump-study.cjs   The 30-day study - re-run this to re-measure everything
validate-tiers.cjs   Checks the actual joint grade() output against real outcomes
```

## 📝 The honest summary

PRIME's 55%/13.81x is real evidence from real data, not a guess — but it's
one month, one regime, and 256 events. Good enough to trust as a genuine
signal in **paper trading**, not yet proven enough to run real capital on
without watching it closely. The live tracker (`data/outcomes.jsonl`) is
what eventually settles this — re-run the studies as episodes accumulate.

* * *

## 💜 Donate

If this saved you a bad short, a tip is appreciated.

☕ **Buy Me a Coffee:** https://www.buymeacoffee.com/richardcuyk

| token | network | address |
|---|---|---|
| **USDT** | **BNB Smart Chain (BEP20)** | `0x2f74e92620dbf20be51c7530bd96dd0a274c7d77` |

> ⚠️ **BEP20 only.** Sending on any other network (ERC20, TRC20, …) will lose the
> funds. Minimum 0.001 USDT.

* * *

## 📄 License & disclaimer

MIT — see [LICENSE](LICENSE).

**Not financial advice.** This software produces statistical signals from public
market data for research and monitoring. It does not place orders. Trading
leveraged perpetuals can lose more than your deposit. Every number here is
measured on a small sample and may not hold out of sample. You are responsible
for what you do with any signal it produces.
