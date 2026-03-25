import { eq } from 'drizzle-orm'
import { db } from './client'
import { users } from './schema'

const phone = process.env.SUPER_ADMIN_PHONE
const password = process.env.SUPER_ADMIN_PASSWORD
const email = process.env.SUPER_ADMIN_EMAIL

if (!phone || !password) {
  console.error('[seed] SUPER_ADMIN_PHONE and SUPER_ADMIN_PASSWORD must be set')
  process.exit(1)
}

async function seed() {
  const existing = await db.query.users.findFirst({
    where: eq(users.role, 'super_admin'),
  })

  if (existing) {
    console.log('[seed] super_admin already exists, skipping')
    process.exit(0)
  }

  const passwordHash = await Bun.password.hash(password!)

  await db.insert(users).values({
    name: 'Super Admin',
    phone: phone!,
    email: email,
    passwordHash,
    role: 'super_admin',
    status: 'approved',
  })

  console.log('[seed] super_admin created successfully')
  process.exit(0)
}

seed().catch((err) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
