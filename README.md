# TradeBridge

A mobile-first B2B trade and logistics platform: marketplace, bulk orders, shipment tracking, quote requests, seller photo uploads and an admin console.

The website is a single `index.html` hosted on GitHub Pages. It talks to a separate backend (Render + Neon Postgres + Cloudflare R2) for accounts, listings, photos, orders and shipments.

## Deploy
Push `index.html` to the root of the `main` branch and enable **Settings → Pages**.

## Notes
- Payments and escrow are not connected yet: orders carry a status only, no money moves.
- Shipping prices are estimates, not live carrier quotes.
