# StockSense — Supply Chain / Inventory Forecasting

Demand forecasting and replenishment planning for a fictional wholesale distributor
(**Bluecrate Distribution**): 365 days of seeded synthetic sales across 12 SKUs with distinct
demand personalities, **Holt-Winters triple exponential smoothing implemented from scratch**
backtested against two baselines with rolling-origin **MAPE/WAPE**, and **reorder points with
safety stock** that turn the forecasts into actual purchasing decisions.

Next.js 14 (App Router) + TypeScript + PostgreSQL. No forecasting libraries.

## Architecture

```
scripts/generate.mjs          scripts/forecast.mjs                  Next.js app
┌───────────────────┐    ┌───────────────────────────┐    ┌───────────────────────┐
│ 12 SKU demand      │    │ rolling-origin backtest:      │    │ /api/products (ROP calc) │
│ personalities      │───▶│  naive-7 vs ma-28 vs HW grid  │───▶│ /api/metrics  (backtests)│
│ (steady, seasonal, │    │ champion per SKU (fold-4 WAPE)│    │ /api/reorder  (what-if)  │
│ trend, promo,      │    │ 28d forecast + 80% band       │    │ forecast charts, backtest│
│ intermittent)      │    │ residual_std for safety stock │    │ table, reorder desk      │
└───────────────────┘    └───────────────────────────┘    └───────────────────────┘
            Postgres: products · daily_sales · forecasts · backtests
```

## Design

1. **Why not Prophet/ARIMA?** They're Python libraries; this stack is Node. Instead of shelling
   out to a Python sidecar, the project implements the classical method those libraries wrap —
   additive Holt-Winters (level + trend + weekly seasonality) — in ~50 lines, and then **proves
   it against baselines instead of trusting a library default**. If you'd rather show Python
   chops, the honest swap is a FastAPI microservice running Prophet; the backtest harness here
   wouldn't change at all, which is the actual lesson.

2. **The baseline must be on the podium.** Seasonal-naive (forecast = last week's same weekday)
   is embarrassingly strong on stable weekly-seasonal series. Every forecasting claim in this
   project is relative to it — and on some SKUs it *wins*. A forecasting system that never
   compares against naive baselines is a red flag; this one prints the comparison in the terminal
   on every run.

3. **Rolling-origin backtesting with a clean holdout.** 4 folds × 14 days over the last 8 weeks.
   Holt-Winters' smoothing parameters are grid-searched on folds 1–3 **only**; all reported
   numbers come from fold 4, which nothing tuned on. Tuning and reporting on the same window is
   the most common forecasting evaluation sin; the protocol here makes it structurally impossible.

4. **MAPE and WAPE, both, on purpose.** MAPE is undefined on zero-demand days and explodes on
   small actuals — for the intermittent SKU (cast iron skillet, ~75% zero days) it's nearly
   meaningless. WAPE (Σ|error| / Σactual) stays defined and weights by volume. Reporting both and
   knowing when each fails is the point of including a lumpy SKU at all.

5. **Safety stock from forecast errors, not demand variance.** σ in `z × σ√L` is the std of
   recent *one-step-ahead forecast errors*. If the model already explains the weekly cycle, that
   predictable variance shouldn't be bought as inventory — only the unexplained part should.

6. **Forecasts become decisions.** The reorder desk computes ROP = lead-time demand + safety
   stock, projects the first stockout day against on-hand stock, flags SKUs where a reorder
   placed *today* would arrive too late, and prices the suggested order. The what-if panel makes
   the service-level trade-off tangible: 95% → 99% service is a visible jump in safety stock and
   order cost.

7. **Determinism.** Seeded RNG (`DATA_SEED=42`) → same history, same backtests, same champions on
   every run. `EVAL.md` numbers are reproducible, not cherry-picked.

## Getting started

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Neon/Supabase free tier)
npm run setup                # schema + 2 users + 12 products
npm run generate             # 365 days × 12 SKUs of demand history (seed 42)
npm run forecast             # backtest, pick champions, write forecasts + print table
npm run dev                  # http://localhost:3000
```

Sign-in (what-if desk): `planner@bluecrate.test` / `ops@bluecrate.test` with `SEED_PASSWORD`
(default `ChangeMe123!`).

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/products` | — | All SKUs with computed reorder info + stock status |
| GET | `/api/products?sku=` | — | 120d history, 28d forecast + band, backtests, reorder info |
| GET | `/api/metrics` | — | Full backtest table (fold-4 MAPE/WAPE + 4-fold avg) |
| POST | `/api/reorder` | session | What-if: recompute ROP under different service level / lead time / on-hand |
| GET/POST/DELETE | `/api/auth` | — | Session check / login / logout |

## The 12 demand personalities

| SKU | Personality | Expected champion |
| --- | --- | --- |
| BC-1001, BC-1003, BC-1008, BC-1011 | Steady (± noise) | ma-28 or HW — near tie |
| BC-1002, BC-1004 | Strong weekend seasonality | HW or seasonal-naive |
| BC-1005, BC-1010, BC-1012 | Upward trend (+ seasonality/promos) | HW — trend term earns its keep |
| BC-1006 | Downward trend | HW |
| BC-1007 | Promo spikes (~monthly, 2-day, 4-5×) | messy — spikes wreck everyone |
| BC-1009 | Intermittent/lumpy (75% zero days) | nobody looks good; WAPE ~50%+ |

## Edge cases handled

| # | Edge case | Behavior |
| --- | --- | --- |
| 1 | Zero-demand days | MAPE skips them (reported as “—” when all-zero); WAPE always defined |
| 2 | Intermittent SKU | Honest bad numbers + EVAL.md explains why (Croston's is the real fix) |
| 3 | Promo spikes in holdout | Spike days blow up fold WAPE — visible, not hidden |
| 4 | Short history | HW degrades to flat mean below 3 seasons; backtest skips below 120 days |
| 5 | Negative forecasts | Floored at 0 (trend-down SKUs would otherwise go negative) |
| 6 | Band floor | `lo` clamped at 0 |
| 7 | Stockout before replenishment | Status distinguishes `reorder_now` from `stockout_risk` (dry before a reorder placed today lands) |
| 8 | What-if bad inputs | 422 with allowed service levels / ranges; unknown SKU 404; unforecasted SKU 409 |
| 9 | Double generation | `generate` refuses if rows exist; prints exact TRUNCATE to reset |
| 10 | Forecast rerun | Per-SKU transaction deletes + rewrites — rerunnable any time |

## Honesty notes

- **Synthetic demand is tamer than real demand.** No holidays-of-varying-date, no supply-driven
  censoring (stockouts masking true demand), no cannibalization. The generator's weekly cycle is
  exactly the structure HW models, which flatters it; the promo and intermittent SKUs are there
  as the antidote.
- **√L safety-stock scaling assumes independent daily errors.** Positively autocorrelated errors
  (e.g. a promo the model didn't know about) make it optimistic. Real systems add a review-period
  term and model supply variability too.
- **The intermittent SKU deserves Croston's method** (separate demand-size and demand-interval
  smoothing) — deliberately out of scope, and the first thing to add. Saying so beats pretending
  HW handles it.

## Deploying

- **App:** Vercel (Next.js defaults).
- **Postgres:** Neon or Supabase free tier.
- Run `setup`/`generate`/`forecast` once from your machine against the production `DATABASE_URL`.
  Re-run `forecast` on a schedule (cron) as new sales land — it's transactional and rerunnable.
