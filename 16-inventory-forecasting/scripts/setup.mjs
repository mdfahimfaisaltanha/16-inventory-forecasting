// Idempotent schema + seed for StockSense.
// Usage: npm run setup   (then: npm run generate, npm run forecast)

import { readFileSync } from "node:fs"
import { randomBytes, scryptSync } from "node:crypto"
import pg from "pg"

// ---- .env.local loader (no dotenv dependency) -----------------------------
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {
  // fine — rely on real environment variables
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
  process.exit(1)
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

console.log("Creating schema (idempotent)…")

await client.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('planner', 'admin')),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS users_sessions (
    token TEXT PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit_cost_cents INT NOT NULL CHECK (unit_cost_cents > 0),
    lead_time_days INT NOT NULL CHECK (lead_time_days BETWEEN 1 AND 28),
    on_hand INT NOT NULL CHECK (on_hand >= 0),
    service_level NUMERIC(4,3) NOT NULL DEFAULT 0.95,
    -- generator recipe for this SKU's demand personality (read by generate.mjs)
    demand_profile JSONB NOT NULL,
    -- written by scripts/forecast.mjs
    champion_method TEXT,
    residual_std REAL
  );

  CREATE TABLE IF NOT EXISTS daily_sales (
    product_id INT NOT NULL REFERENCES products(id),
    day DATE NOT NULL,
    qty INT NOT NULL CHECK (qty >= 0),
    PRIMARY KEY (product_id, day)
  );

  CREATE TABLE IF NOT EXISTS forecasts (
    product_id INT NOT NULL REFERENCES products(id),
    day DATE NOT NULL,
    p50 REAL NOT NULL,
    lo REAL NOT NULL,
    hi REAL NOT NULL,
    method TEXT NOT NULL,
    PRIMARY KEY (product_id, day)
  );

  CREATE TABLE IF NOT EXISTS backtests (
    product_id INT NOT NULL REFERENCES products(id),
    method TEXT NOT NULL,
    mape_fold4 REAL,
    wape_fold4 REAL NOT NULL,
    wape_avg REAL NOT NULL,
    params JSONB,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, method)
  );
`)

// ---- users -----------------------------------------------------------------
const existingUsers = await client.query(`SELECT count(*)::int AS user_count FROM users`)
if (existingUsers.rows[0].user_count > 0) {
  console.log("Users already seeded — skipping.")
} else {
  const password = process.env.SEED_PASSWORD || "ChangeMe123!"
  const seedUsers = [
    { name: "Anika Rahman", email: "planner@bluecrate.test", role: "planner" },
    { name: "Diego Fuentes", email: "ops@bluecrate.test", role: "admin" },
  ]
  for (const u of seedUsers) {
    await client.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, $3, $4)`, [
      u.name,
      u.email,
      u.role,
      hashPassword(password),
    ])
  }
  console.log("Seeded users (password = SEED_PASSWORD, default ChangeMe123!):")
  for (const u of seedUsers) console.log(`  ${u.email}  (${u.role})`)
}

// ---- products ----------------------------------------------------------------
// demand_profile fields: base (units/day), trend (fractional change per day),
// weekend (Sat/Sun multiplier), promo (periodic 2-day spikes), intermittent
// (mostly-zero lumpy demand — the honest hard case for smoothing models).
const existingProducts = await client.query(`SELECT count(*)::int AS product_count FROM products`)
if (existingProducts.rows[0].product_count > 0) {
  console.log("Products already seeded — skipping.")
} else {
  const products = [
    { sku: "BC-1001", name: "Steel Water Bottle 750ml", category: "outdoor", cost: 899, lead: 5, onHand: 1400, profile: { base: 40, weekend: 1.1 } },
    { sku: "BC-1002", name: "Camp Lantern LED", category: "lighting", cost: 1499, lead: 7, onHand: 900, profile: { base: 25, weekend: 1.8 } },
    { sku: "BC-1003", name: "Trail Mix 1kg", category: "food", cost: 1099, lead: 3, onHand: 2500, profile: { base: 120, weekend: 1.15 } },
    { sku: "BC-1004", name: "Folding Camp Chair", category: "furniture", cost: 2499, lead: 10, onHand: 260, profile: { base: 18, weekend: 2.2 } },
    { sku: "BC-1005", name: "Thermal Flask 1L", category: "outdoor", cost: 1299, lead: 5, onHand: 320, profile: { base: 20, trend: 0.0025, weekend: 1.1 } },
    { sku: "BC-1006", name: "Canvas Tote Bag", category: "apparel", cost: 799, lead: 4, onHand: 2200, profile: { base: 60, trend: -0.0015 } },
    { sku: "BC-1007", name: "Rain Poncho", category: "apparel", cost: 599, lead: 6, onHand: 400, profile: { base: 15, promo: true } },
    { sku: "BC-1008", name: "Headlamp 300lm", category: "lighting", cost: 1899, lead: 8, onHand: 1000, profile: { base: 30 } },
    { sku: "BC-1009", name: "Cast Iron Skillet 12in", category: "kitchen", cost: 3499, lead: 14, onHand: 60, profile: { intermittent: { p: 0.25, mean: 4, std: 2 } } },
    { sku: "BC-1010", name: "Sleeping Bag -5C", category: "outdoor", cost: 4999, lead: 12, onHand: 130, profile: { base: 12, weekend: 1.6, trend: 0.002 } },
    { sku: "BC-1011", name: "First Aid Kit Compact", category: "safety", cost: 1599, lead: 4, onHand: 700, profile: { base: 22 } },
    { sku: "BC-1012", name: "Insect Repellent 200ml", category: "safety", cost: 499, lead: 3, onHand: 380, profile: { base: 35, trend: 0.003, promo: true } },
  ]
  for (const p of products) {
    await client.query(
      `INSERT INTO products (sku, name, category, unit_cost_cents, lead_time_days, on_hand, demand_profile)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [p.sku, p.name, p.category, p.cost, p.lead, p.onHand, JSON.stringify(p.profile)],
    )
  }
  console.log(`Seeded ${products.length} products with distinct demand personalities.`)
}

console.log("\nDone. Next steps:")
console.log("  npm run generate   # 365 days of synthetic demand history (seed 42)")
console.log("  npm run forecast   # backtest 3 methods, pick champions, write forecasts")
console.log("  npm run dev        # open the dashboard")

await client.end()
