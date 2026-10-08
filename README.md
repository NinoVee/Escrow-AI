# EscrowFlow

Administrative workflow support for residential and commercial escrow staff (California pilot).

EscrowFlow is software used by escrow professionals. It is **not** an escrow company, title insurer or law firm, and it does **not** hold or move client funds.

> Full setup, feature and production-readiness documentation is in progress; see `docs/`.

Quick start (local):

```bash
docker compose up -d            # or run PostgreSQL 16 + Redis yourself
cp .env.example .env            # then fill in the three generated secrets
npm install
npx prisma migrate deploy
npm run db:seed                 # fictional demo data
npm run dev
```
