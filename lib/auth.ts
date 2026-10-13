import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { query } from "./db"
import type { User } from "./types"

const COOKIE = "ss_session"
const SESSION_HOURS = 8

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(":")
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, "hex")
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, { N: 16384 })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function createSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex")
  await query(
    `INSERT INTO users_sessions (token, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [token, userId, String(SESSION_HOURS)],
  )
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  })
}

export async function currentUser(): Promise<User | null> {
  const token = cookies().get(COOKIE)?.value
  if (!token) return null
  const { rows } = await query<User & Record<string, unknown>>(
    `SELECT u.id, u.name, u.email, u.role
     FROM users_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )
  return rows[0] ?? null
}

export async function destroySession(): Promise<void> {
  const token = cookies().get(COOKIE)?.value
  if (token) await query(`DELETE FROM users_sessions WHERE token = $1`, [token])
  cookies().delete(COOKIE)
}
