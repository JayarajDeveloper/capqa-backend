# Cap QA — Backend

Express + Prisma + PostgreSQL API. Auth (JWT + bcrypt), Organizations, and Projects.

## Model
`Organization → Projects`, with users joined to orgs via `Membership` (OWNER/ADMIN/MEMBER).
A seeded **admin** user owns a default org.

## Setup
```bash
npm install
cp .env.example .env            # edit secrets

# 1) Start Postgres (Docker) — or point DATABASE_URL at your own instance
docker compose up -d

# 2) Create the schema + generate the client
npx prisma migrate dev          # applies migrations
npm run generate                # (migrate already generates; here for CI)

# 3) Seed the admin user + default org
npm run seed
#   → admin@cap.local / admin123   (change in .env)

# 4) Run the API
npm run dev                     # http://localhost:4000
```

## Endpoints
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET  | `/api/health` | – | liveness |
| POST | `/api/auth/login` | – | `{ email, password }` → `{ token, user, orgs }` |
| GET  | `/api/auth/me` | Bearer | current user + orgs |
| GET  | `/api/orgs` | Bearer | orgs the user belongs to |
| POST | `/api/orgs` | Bearer | create an org (creator = OWNER) |
| GET  | `/api/projects` | Bearer | projects in the user's orgs (`?orgId=` to filter) |
| POST | `/api/projects` | Bearer | `{ name, description?, key?, orgId? }` — key auto-derived if omitted |
| GET  | `/api/projects/:id` | Bearer | one project |

## Notes
- Passwords are bcrypt-hashed; tokens are JWT (`JWT_EXPIRES_IN`, default 7d).
- `PORT` defaults to 4000; the frontend proxies `/api` → this port in dev.
- Switch to a managed Postgres for production by changing `DATABASE_URL` only.

## Next steps (planned)
- Move GitLab/Jira connector tokens here (encrypted at rest) so they leave the browser.
- Per-project connectors, test suites, runs, and members endpoints.
- Login rate-limiting + refresh tokens.
