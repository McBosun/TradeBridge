# TradeBridge API

Node.js (Express) backend for TradeBridge: login and roles, listings with photo upload, orders, shipments, RFQs, chat and an admin console.
Stack: **Render** (this API) + **Neon** (Postgres) + **Cloudflare R2** (photos).

```
Phone app -> Render API -> Neon (data)
                        -> R2   (photos)
```

## Deploy
1. **Neon:** create a project and copy the connection string (`postgresql://...`).
2. **Cloudflare R2:** create a bucket, an API token (Object Read & Write), a CORS rule allowing `PUT` from your site, and a public custom domain for the bucket.
3. **GitHub:** push this folder to a repo (keep `.env` out of git).
4. **Render:** New > Web Service (or Blueprint using `render.yaml`) from that repo.
5. In Render **Environment**, set the variables below. `JWT_SECRET` is generated for you by `render.yaml`.
6. Deploy. On start it creates the tables and, if `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set, your first admin.
7. **Delete `ADMIN_PASSWORD` from Render after the first successful start.**
8. Check `https://YOUR-SERVICE.onrender.com/health` returns `{"ok":true}`.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `JWT_SECRET` | 32+ random characters (auto-generated on Render) |
| `ALLOWED_ORIGIN` | Your site, e.g. `https://mcbosun.github.io` (comma-separate several) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | From Cloudflare |
| `R2_ENDPOINT` | Optional. Only for EU or FedRAMP jurisdiction buckets, e.g. `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com` |
| `R2_PUBLIC_URL` | Public bucket address, e.g. `https://photos.yourdomain.com` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin only (password 12+ characters) |

## Run locally
```bash
cp .env.example .env     # fill in values
npm install
node --env-file=.env scripts/migrate.js
node --env-file=.env server.js
```

## Endpoints
Send `Authorization: Bearer <token>` where login is needed.

| Method and path | Who | What |
|---|---|---|
| `POST /auth/signup` | public | name, email, password (8+), role: buyer, seller or logistics, country |
| `POST /auth/login` | public | returns token and user |
| `GET /me` | any | current user |
| `GET /listings`, `GET /listings/:id` | public | browse (`category`, `q`, `limit`, `offset`) |
| `POST /uploads/sign` | seller | `{contentType}` returns a 5-minute R2 upload link and the public photo URL |
| `POST /listings` | seller | title, category, originCountry, moq, price, optional tiers, photos |
| `GET /listings/mine`, `DELETE /listings/:id` | seller | manage own listings |
| `GET/PUT /favorites` | any | list or toggle saved listings |
| `POST /orders`, `GET /orders` | buyer / all | place order (creates a shipment) / list by role |
| `PATCH /orders/:id/status` | buyer, seller, admin | seller: preparing, in_transit; buyer: delivered, cancelled |
| `GET /track/:ref` | public | shipment tracking |
| `GET /shipments`, `PATCH /shipments/:id` | logistics, admin | update status 0 to 5, delay, ETA; admin assigns `carrierId` |
| `POST/GET /rfqs` | buyer / seller, admin | requests for quotation |
| `POST/GET /messages` | buyer, seller | chat about a listing |
| `GET /admin/stats`, `GET /admin/users`, `PATCH /admin/users/:id` | admin | monitor, suspend, verify (verifying a seller activates their pending listings) |

Photo upload flow: call `/uploads/sign`, `PUT` the file to `uploadUrl` with the returned `Content-Type` header, then send `publicUrl` in `photos` when creating the listing. Resize images in the app before upload.

## Security notes
- Passwords are hashed with bcrypt. Logins use signed tokens that expire after 7 days.
- Rate limits on all routes, stricter on login and signup. Inputs are validated and queries are parameterised.
- Keep secrets only in Render environment settings, never in GitHub or the front end. Regenerate any key that leaks.
- Presigned upload links do not enforce a file size limit. Add Cloudflare limits or server-side checks before launch.

## Not built yet
- **Real escrow and payments:** `escrow` is only an order status. Connect Paystack, Flutterwave or Stripe before moving money.
- Carrier APIs for live rates and tracking, email and SMS alerts, password reset, seller document verification, dispute handling, reviews, live (WebSocket) chat.
- Render's free tier sleeps when idle, so the first request after a quiet period is slow.
