# StockSense — 6-step demo walkthrough

A scripted tour for interviews (~5 minutes). Run `npm run setup`, `npm run generate`,
`npm run forecast`, `npm run dev` first.

## 1. Read the terminal table first

`npm run forecast` prints the SKU × method WAPE comparison. Point at a row where a **baseline
beats Holt-Winters** (BC-1004 seasonal-naive, or BC-1003/BC-1009 ma-28) and say: "my evaluation
is capable of telling me my model lost — that's the feature." Then point at the trend SKUs where
HW wins clearly and explain why (naive-7 structurally lags a trend).

## 2. Forecast explorer — the weekend SKU

Open 📈 Forecast explorer, pick **BC-1004 Folding Camp Chair**. The history shows the weekly
sawtooth (weekends ×2.2); the dashed 28-day forecast continues the pattern with an 80% band.
Note the champion badge — on this SKU it's often seasonal-naive, and the chart makes it obvious
why: the pattern repeats almost perfectly.

## 3. Forecast explorer — the honest failure

Switch to **BC-1009 Cast Iron Skillet** (intermittent, ~75% zero days). The forecast is a flat
smear over lumpy spikes — exactly what smoothing does to intermittent demand. Say the phrase
"Croston's method" and that it's deliberately called out as future work rather than hidden.

## 4. Backtests tab — the protocol

Open 🧪 Backtests. Walk the protocol out loud: 4 rolling folds, HW tuned on folds 1-3, *reported*
on fold 4 — tuning and scoring never share a window. Point at the MAPE “—” cells on the
intermittent SKU and explain the MAPE-vs-WAPE distinction in one sentence: "MAPE divides by
actual, so zero-demand days break it; WAPE divides by total volume, which is what dollars care
about."

## 5. Reorder desk — forecasts becoming money

Open 📦 Reorder desk. A few SKUs are flagged: **BC-1004** (long lead + thin stock → stockout
risk: it runs dry before a reorder placed today could land) and **BC-1005/BC-1012** (below ROP).
Click BC-1005, sign in (`planner@bluecrate.test` / `ChangeMe123!`), and in the what-if panel push
service level 95% → 99%: safety stock and order cost jump. One sentence: "service level is a
business knob, not a math constant — this panel prices it."

## 6. Prove determinism (optional, terminal)

```bash
npm run forecast   # run twice — identical table both times (seeded data, deterministic fit)
```

## Curl quickies

```bash
# replenishment overview
curl 'http://localhost:3000/api/products' | head -c 800

# full backtest table
curl 'http://localhost:3000/api/metrics' | head -c 800

# one SKU's history + forecast + backtests
curl 'http://localhost:3000/api/products?sku=BC-1005' | head -c 800
```
