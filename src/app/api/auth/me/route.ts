import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

/** GET /api/auth/me → {user:{id,username}|null} */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req)
  return NextResponse.json({ user })
}
