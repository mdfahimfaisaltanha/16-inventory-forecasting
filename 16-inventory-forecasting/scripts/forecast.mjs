// Forecast + backtest engine — the heart of StockSense.
//
// Three methods, all from scratch:
//   seasonal_naive : forecast(day) = actual(day - 7). The baseline to beat.
//   moving_avg_28  : flat mean of the last 28 days.
//   holt_winters   : additive triple exponential smoothing (level + trend +
//                    weekly seasonality, m=7), grid-searched α/β/γ.
//
// Backtest protocol (rolling origin, honest):
//   4 folds × 14 days over the last 8 weeks (origins at N-56, N-42, N-28, N-14).
//   HW's smoothing params are chosen by average WAPE on folds 1-3 ONLY.
//   Reported metrics come from fold 4 — a clean holdout no method tuned on.
//   Champion per SKU = lowest fold-4 WAPE. Sometimes a baseline wins; good.
//
// Finally: fit the champion on the full year, write a 28-day forecast with an
// 80% band from the std of one-step-ahead errors over the last 90 days, and
// stamp champion_method + residual_std onto the product for reorder math.
//
// Why not Prophet/ARIMA? They're Python. This project's stack is Node, so it
// implements the classical method those libraries wrap — and proves it against
// baselines instead of trusting a library default (see README).

import { readFileSync } from "node:fs"
import pg from "pg"

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
  process.exit(1)
}

const SEASON = 7
const HORIZON = 28
const FOLD_LEN = 14
const FOLDS = 4
const GRID = {
  alpha: [0.1, 0.2, 0.35, 0.5],
  beta: [0.01, 0.05, 0.1],
  gamma: [0.05, 0.15, 0.3],
}

// ---- methods -----------------------------------------------------------------

function seasonalNaive(train, h) {
  const out = []
  for (let i = 0; i < h; i++) out.push(train[train.length - SEASON + (i % SEASON)] ?? train[train.length - 1] ?? 0)
  return out
}

function movingAvg28(train, h) {
  const tail = train.slice(-28)
  const mean = tail.reduce((s, v) => s + v, 0) / Math.max(tail.length, 1)
  return new Array(h).fill(mean)
}

// Additive Holt-Winters, season length 7. Returns { forecast, oneStepErrors }.
// Seasonal index s[t % 7] is tied to the absolute position in the series, so
// forecasts for index N+i use s[(N+i) % 7].
function holtWinters(train, h, { alpha, beta, gamma }) {
  const n = train.length
  if (n < SEASON * 3) {
    // Not enough history for seasonal init — degrade to a flat mean.
    const mean = train.reduce((s, v) => s + v, 0) / Math.max(n, 1)
    return { forecast: new Array(h).fill(mean), oneStepErrors: [] }
  }

  // init: level = mean of week 1; trend = (mean week 2 - mean week 1) / 7;
  // seasonal = average deviation from that week's mean over the first 4 weeks.
  const weekMean = (w) => train.slice(w * SEASON, (w + 1) * SEASON).reduce((s, v) => s + v, 0) / SEASON
  let level = weekMean(0)
  let trend = (weekMean(1) - weekMean(0)) / SEASON
  const s = new Array(SEASON).fill(0)
  const initWeeks = Math.min(4, Math.floor(n / SEASON))
  for (let d = 0; d < SEASON; d++) {
    let sum = 0
    for (let w = 0; w < initWeeks; w++) sum += train[w * SEASON + d] - weekMean(w)
    s[d] = sum / initWeeks
  }

  const oneStepErrors = []
  for (let t = 0; t < n; t++) {
    const si = t % SEASON
    const predicted = level + trend + s[si]
    oneStepErrors.push(train[t] - predicted)
    const prevLevel = level
    level = alpha * (train[t] - s[si]) + (1 - alpha) * (level + trend)
    trend = beta * (level - prevLevel) + (1 - beta) * trend
    s[si] = gamma * (train[t] - level) + (1 - gamma) * s[si]
  }

  const forecast = []
  for (let i = 1; i <= h; i++) {
    forecast.push(Math.max(0, level + i * trend + s[(n + i - 1) % SEASON]))
  }
  return { forecast, oneStepErrors }
}

// ---- metrics -------------------------------------------------------------------

function mape(actual, forecast) {
  let sum = 0
  let count = 0
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === 0) continue // undefined on zero-demand days — skip (and report WAPE too)
    sum += Math.abs((actual[i] - forecast[i]) / actual[i])
    count++
  }
  return count === 0 ? null : sum / count
}

function wape(actual, forecast) {
  let errSum = 0
  let actSum = 0
  for (let i = 0; i < actual.length; i++) {
    errSum += Math.abs(actual[i] - forecast[i])
    actSum += actual[i]
  }
  return actSum === 0 ? null : errSum / actSum
}

function std(values) {
  if (values.length === 0) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// ---- main ------------------------------------------------------------------------

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const { rows: products } = await client.query(`SELECT id, sku, name FROM products ORDER BY sku`)
if (products.length === 0) {
  console.error("No products — run: npm run setup && npm run generate")
  await client.end()
  process.exit(1)
}

console.log(`Backtesting ${products.length} SKUs (4 rolling folds × ${FOLD_LEN}d, HW grid ${GRID.alpha.length * GRID.beta.length * GRID.gamma.length} combos on folds 1-3)…\n`)
console.log("  SKU       naive-7  ma-28   holt-w  champion            holdout WAPE")

for (const p of products) {
  const { rows: sales } = await client.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, qty FROM daily_sales WHERE product_id = $1 ORDER BY day`,
    [p.id],
  )
  const y = sales.map((r) => Number(r.qty))
  const n = y.length
  if (n < 120) {
    console.log(`  ${p.sku}  skipped (only ${n} days of history)`)
    continue
  }

  const origins = []
  for (let f = 0; f < FOLDS; f++) origins.push(n - (FOLDS - f) * FOLD_LEN)

  // 1) grid-search HW params on folds 1-3 (never fold 4)
  let bestParams = null
  let bestScore = Infinity
  for (const alpha of GRID.alpha) {
    for (const beta of GRID.beta) {
      for (const gamma of GRID.gamma) {
        let total = 0
        let valid = 0
        for (let f = 0; f < FOLDS - 1; f++) {
          const train = y.slice(0, origins[f])
          const actual = y.slice(origins[f], origins[f] + FOLD_LEN)
          const fc = holtWinters(train, FOLD_LEN, { alpha, beta, gamma }).forecast
          const w = wape(actual, fc)
          if (w !== null) {
            total += w
            valid++
          }
        }
        const score = valid > 0 ? total / valid : Infinity
        if (score < bestScore) {
          bestScore = score
          bestParams = { alpha, beta, gamma }
        }
      }
    }
  }

  // 2) evaluate all methods per fold; report fold 4 as the clean holdout
  const methods = {
    seasonal_naive: (train, h) => seasonalNaive(train, h),
    moving_avg_28: (train, h) => movingAvg28(train, h),
    holt_winters: (train, h) => holtWinters(train, h, bestParams).forecast,
  }

  const results = {}
  for (const [name, fn] of Object.entries(methods)) {
    const wapes = []
    let holdoutMape = null
    let holdoutWape = null
    for (let f = 0; f < FOLDS; f++) {
      const train = y.slice(0, origins[f])
      const actual = y.slice(origins[f], origins[f] + FOLD_LEN)
      const fc = fn(train, FOLD_LEN)
      const w = wape(actual, fc)
      if (w !== null) wapes.push(w)
      if (f === FOLDS - 1) {
        holdoutMape = mape(actual, fc)
        holdoutWape = w ?? 999
      }
    }
    results[name] = {
      mape_fold4: holdoutMape,
      wape_fold4: holdoutWape,
      wape_avg: wapes.length > 0 ? wapes.reduce((s, v) => s + v, 0) / wapes.length : 999,
    }
  }

  const champion = Object.entries(results).sort((a, b) => a[1].wape_fold4 - b[1].wape_fold4)[0][0]

  // 3) fit champion on the full year → 28-day forecast + residual band
  let finalForecast
  let residuals
  if (champion === "holt_winters") {
    const fit = holtWinters(y, HORIZON, bestParams)
    finalForecast = fit.forecast
    residuals = fit.oneStepErrors.slice(-90)
  } else if (champion === "seasonal_naive") {
    finalForecast = seasonalNaive(y, HORIZON)
    residuals = []
    for (let t = Math.max(SEASON, n - 90); t < n; t++) residuals.push(y[t] - y[t - SEASON])
  } else {
    finalForecast = movingAvg28(y, HORIZON)
    residuals = []
    for (let t = Math.max(28, n - 90); t < n; t++) {
      const mean = y.slice(t - 28, t).reduce((s, v) => s + v, 0) / 28
      residuals.push(y[t] - mean)
    }
  }
  const residualStd = std(residuals)

  // 4) persist (transactional per SKU; rerunnable)
  await client.query("BEGIN")
  await client.query(`DELETE FROM forecasts WHERE product_id = $1`, [p.id])
  await client.query(`DELETE FROM backtests WHERE product_id = $1`, [p.id])

  const lastDay = new Date(sales[sales.length - 1].day + "T00:00:00Z")
  const fParams = []
  const fValues = finalForecast
    .map((v, i) => {
      const d = new Date(lastDay.getTime() + (i + 1) * 86400_000).toISOString().slice(0, 10)
      const p50 = Math.max(0, Math.round(v * 10) / 10)
      const lo = Math.max(0, Math.round((v - 1.28 * residualStd) * 10) / 10)
      const hi = Math.round((v + 1.28 * residualStd) * 10) / 10
      fParams.push(p.id, d, p50, lo, hi, champion)
      const o = i * 6
      return `($${o + 1}, $${o + 2}::date, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`
    })
    .join(", ")
  await client.query(`INSERT INTO forecasts (product_id, day, p50, lo, hi, method) VALUES ${fValues}`, fParams)

  for (const [name, r] of Object.entries(results)) {
    await client.query(
      `INSERT INTO backtests (product_id, method, mape_fold4, wape_fold4, wape_avg, params)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.id, name, r.mape_fold4, r.wape_fold4, r.wape_avg, name === "holt_winters" ? JSON.stringify(bestParams) : null],
    )
  }

  await client.query(`UPDATE products SET champion_method = $1, residual_std = $2 WHERE id = $3`, [
    champion,
    residualStd,
    p.id,
  ])
  await client.query("COMMIT")

  const f = (x) => (x === null || x === undefined ? "  —  " : `${(x * 100).toFixed(1)}%`.padStart(6))
  console.log(
    `  ${p.sku}  ${f(results.seasonal_naive.wape_fold4)} ${f(results.moving_avg_28.wape_fold4)} ${f(results.holt_winters.wape_fold4)}  ${champion.padEnd(18)} ${f(results[champion].wape_fold4)}`,
  )
}

console.log("\n(Numbers above are fold-4 WAPE — the clean holdout. See EVAL.md for interpretation.)")
console.log("Done. Open the dashboard: npm run dev → http://localhost:3000")
await client.end()
