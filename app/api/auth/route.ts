import { NextRequest, NextResponse } from "next/server"
import { createSession, currentUser, destroySession, verifyPassword } from "@/lib/auth"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET() {
  const user = await currentUser()
  return NextResponse.json({ user })
}

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const email = String(body.email ?? "").trim().toLowerCase()
  const password = String(body.password ?? "")
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
  }

  const { rows } = await query<{ id: number; name: string; email: string; role: string; password_hash: string }>(
    `SELECT id, name, email, role, password_hash FROM users WHERE email = $1`,
    [email],
  )
  const user = rows[0]
  // Identical response for unknown email and wrong password — no enumeration.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
  }

  await createSession(user.id)
  return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
}

export async function DELETE() {
  await destroySession()
  return NextResponse.json({ ok: true })
}
