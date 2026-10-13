// Synthetic demand generator — 365 days × 12 SKUs, deterministic (DATA_SEED).
//
// Each SKU's demand_profile (seeded by setup.mjs) is a recipe:
//   base:    average units/day
//   trend:   fractional change per day (compounds linearly: base * (1 + trend*t))
//   weekend: Sat/Sun multiplier (Fri gets half the lift)
//   promo:   2-day promotional spikes roughly monthly (4-5x)
//   intermittent: {p, mean, std} — demand occurs only on ~p of days (lumpy;
//                 the case that breaks MAPE and humbles smoothing models)
//
// Multiplicative gaussian noise (σ=12%) on top of everything. History ends
// yesterday so "today" is the forecast origin.

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

const SEED = Number(process.env.DATA_SEED || 42)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(SEED)
function gaussian(mean, std) {
  const u1 = Math.max(rng(), 1e-9)
  const u2 = rng()
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

const DAYS = 365

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const already = await client.query(`SELECT count(*)::int AS n FROM daily_sales`)
if (already.rows[0].n > 0) {
  console.log(`daily_sales already has ${already.rows[0].n} rows — refusing to double-generate.`)
  console.log(`To regenerate: TRUNCATE daily_sales, forecasts, backtests;`)
  await client.end()
  process.exit(0)
}

const { rows: products } = await client.query(`SELECT id, sku, name, demand_profile FROM products ORDER BY sku`)
if (products.length === 0) {
  console.error("No products found — run: npm run setup")
  await client.end()
  process.exit(1)
}

// History ends yesterday.
const end = new Date()
end.setHours(0, 0, 0, 0)
const start = new Date(end.getTime() - DAYS * 86400_000)

console.log(`Seed ${SEED}: generating ${DAYS} days × ${products.length} SKUs…`)

const rows = [] // [product_id, day(iso), qty]
for (const p of products) {
  const prof = p.demand_profile
  for (let t = 0; t < DAYS; t++) {
    const d = new Date(start.getTime() + t * 86400_000)
    const dow = d.getDay() // 0=Sun .. 6=Sat
    let qty

    if (prof.intermittent) {
      // Lumpy: most days zero, occasional multi-unit orders.
      const { p: prob, mean, std } = prof.intermittent
      qty = rng() < prob ? Math.max(1, Math.round(gaussian(mean, std))) : 0
    } else {
      let level = prof.base * (1 + (prof.trend ?? 0) * t)
      const weekend = prof.weekend ?? 1
      if (dow === 0 || dow === 6) level *= weekend
      else if (dow === 5) level *= 1 + (weekend - 1) * 0.5
      // ~monthly 2-day promo spikes
      if (prof.promo && (t % 31 === 17 || t % 31 === 18)) level *= 4 + rng()
      qty = Math.max(0, Math.round(level * gaussian(1, 0.12)))
    }

    rows.push([p.id, d.toISOString().slice(0, 10), qty])
  }
}

const BATCH = 500
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH)
  const params = []
  const values = batch
    .map((r, j) => {
      params.push(...r)
      const o = j * 3
      return `($${o + 1}, $${o + 2}::date, $${o + 3})`
    })
    .join(", ")
  await client.query(`INSERT INTO daily_sales (product_id, day, qty) VALUES ${values}`, params)
}

const summary = await client.query(
  `SELECT p.sku, sum(s.qty)::int AS total, round(avg(s.qty), 1) AS per_day
   FROM daily_sales s JOIN products p ON p.id = s.product_id
   GROUP BY p.sku ORDER BY p.sku`,
)
console.log("\nGenerated demand history:")
for (const r of summary.rows) console.log(`  ${r.sku}  total ${String(r.total).padStart(6)}  avg ${r.per_day}/day`)
console.log(`\nTotal rows: ${rows.length}. Next: npm run forecast`)

await client.end()
