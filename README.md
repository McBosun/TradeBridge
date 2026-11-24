<p align="center"><img src="assets/logo.svg" width="96" alt="TradeBridge logo"></p>

# TradeBridge

A mobile-first B2B trade and logistics platform prototype (marketplace + shipping + admin), built with plain HTML, CSS and JavaScript. No build step.

## Features
- Marketplace with tiered bulk pricing, MOQ, verified sellers, escrow-style orders, landed cost to your country
- Sell tab: photo upload (up to 4) and Smart Assist (category, HS code, price range, listing score)
- RFQ (request for quotation), supplier chat, favourites
- Shipping quote calculator and shipment tracking
- Multi-currency (USD, NGN, EUR, GBP, CNY, AED, KES)
- Login / sign up for Buyer, Seller and Logistics partner roles
- Side menu and Admin console (monitor buyers, sellers, logistics partners and shipments)
- Deep orange and sky blue theme with light and dark mode

## Run locally
Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Deploy on GitHub Pages
1. Create a new GitHub repository and push these files to the `main` branch.
2. In the repo go to **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow under **Actions**). Your site appears at `https://<username>.github.io/<repo>/`.

## Demo logins
| Role | Email | Password |
|---|---|---|
| Admin | admin@tradebridge.com | admin123 |
| Buyer | buyer@demo.com | demo123 |
| Seller | sun@demo.com | demo123 |
| Logistics | swift@demo.com | demo123 |

## Important
This is a front-end prototype. Accounts, listings, photos, orders and shipments live in browser memory and reset on reload. Rates and shipping costs are demo estimates. Do not use these credentials or this auth in production.

## Next steps to make it real
- Backend and database (Postgres, e.g. Supabase) with real authentication and role-based access
- Image storage for product photos
- Payment and escrow provider, carrier APIs, live FX rates, customs and duty data
- Server-side admin permissions and audit logs

## Structure
```
index.html
assets/styles.css
assets/app.js
assets/logo.svg       (full-colour logo, favicon)
assets/logo-mark.svg  (white mark for coloured headers)
.github/workflows/pages.yml
.nojekyll  LICENSE  .gitignore  README.md
```
