import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pool, q } from "./db.js";

const env = process.env;
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be set (32+ characters)");

// ---------- Cloudflare R2 (photo uploads) ----------
const r2Ready = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"].every((k) => env[k]);
const r2 = r2Ready
  ? new S3Client({
      region: "auto",
      endpoint: (env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, ""),
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    })
  : null;
const PUBLIC = (env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// ---------- helpers ----------
const bad = (res, m) => res.status(400).json({ error: m });
const str = (v, max = 200) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
const num = (v) => (v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const int = (v) => (Number.isInteger(num(v)) ? num(v) : null);
const sign = (u) => jwt.sign({ sub: u.id, role: u.role }, env.JWT_SECRET, { expiresIn: "7d" });
const tierPrice = (tiers, qty) => tiers.reduce((p, t) => (qty >= t.min ? t.price : p), tiers[0].price);

function parseTiers(v, moq, price) {
  if (v === undefined) {
    return [
      { min: moq, price },
      { min: moq * 5, price: +(price * 0.92).toFixed(4) },
      { min: moq * 20, price: +(price * 0.85).toFixed(4) },
    ];
  }
  if (!Array.isArray(v) || v.length < 1 || v.length > 5) return null;
  const t = v.map((x) => ({ min: int(x?.min), price: num(x?.price) }));
  if (t.some((x) => !(x.min >= 1) || !(x.price > 0))) return null;
  t.sort((a, b) => a.min - b.min);
  if (t[0].min !== moq) return null;
  for (let i = 1; i < t.length; i++) if (t[i].min === t[i - 1].min || t[i].price > t[i - 1].price) return null;
  return t;
}

const auth = (...roles) => async (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Login required" });
  let payload;
  try { payload = jwt.verify(token, env.JWT_SECRET); } catch { return res.status(401).json({ error: "Invalid or expired login" }); }
  const { rows } = await q("select id,name,email,role,country,status,verified from users where id=$1", [payload.sub]);
  const u = rows[0];
  if (!u || u.status !== "active") return res.status(403).json({ error: "Account unavailable" });
  if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: "Not allowed" });
  req.user = u;
  next();
};

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const origins = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)) }));
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, message: { error: "Too many attempts, try again later" } });

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- auth ----------
app.post("/auth/signup", authLimiter, async (req, res) => {
  const { name, email, password, role, country } = req.body || {};
  const n = str(name, 100), e = str(email, 200)?.toLowerCase();
  if (!n || !e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return bad(res, "Valid name and email required");
  if (typeof password !== "string" || password.length < 8 || password.length > 72) return bad(res, "Password must be 8 to 72 characters");
  if (!["buyer", "seller", "logistics"].includes(role)) return bad(res, "Role must be buyer, seller or logistics");
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await q(
      `insert into users (name,email,password_hash,role,country,verified) values ($1,$2,$3,$4,$5,$6)
       returning id,name,email,role,country,verified`,
      [n, e, hash, role, str(country, 60), role === "buyer"]
    );
    res.status(201).json({ token: sign(rows[0]), user: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Email already registered" });
    throw err;
  }
});

app.post("/auth/login", authLimiter, async (req, res) => {
  const e = str(req.body?.email, 200)?.toLowerCase(), p = req.body?.password;
  if (!e || typeof p !== "string") return bad(res, "Email and password required");
  const { rows } = await q("select * from users where email=$1", [e]);
  const u = rows[0];
  const ok = u && (await bcrypt.compare(p, u.password_hash));
  if (!ok) return res.status(401).json({ error: "Wrong email or password" });
  if (u.status !== "active") return res.status(403).json({ error: "This account is suspended" });
  const user = { id: u.id, name: u.name, email: u.email, role: u.role, country: u.country, verified: u.verified };
  res.json({ token: sign(user), user });
});

app.get("/me", auth(), (req, res) => res.json(req.user));

// ---------- photo uploads (Cloudflare R2) ----------
app.post("/uploads/sign", auth("seller", "admin"), async (req, res) => {
  if (!r2) return res.status(503).json({ error: "Photo storage is not configured" });
  const ct = req.body?.contentType;
  if (!EXT[ct]) return bad(res, "Only JPEG, PNG or WebP images are allowed");
  const key = `listings/${req.user.id}/${crypto.randomUUID()}.${EXT[ct]}`;
  const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: ct }), { expiresIn: 300 });
  res.json({ uploadUrl, publicUrl: `${PUBLIC}/${key}`, method: "PUT", headers: { "Content-Type": ct } });
});

// ---------- listings ----------
const LIST_COLS = `l.id,l.title,l.description,l.category,l.hs_code,l.origin_country,l.moq,l.price_tiers,l.photos,l.status,l.created_at,
  u.name as seller_name,u.verified as seller_verified,l.seller_id`;

app.get("/listings", async (req, res) => {
  const limit = Math.min(int(req.query.limit) || 24, 60), offset = Math.max(int(req.query.offset) || 0, 0);
  const { rows } = await q(
    `select ${LIST_COLS} from listings l join users u on u.id=l.seller_id
     where l.status='active' and u.status='active'
       and ($1::text is null or l.category=$1) and ($2::text is null or l.title ilike '%'||$2||'%')
     order by l.created_at desc limit $3 offset $4`,
    [str(req.query.category, 60), str(req.query.q, 100), limit, offset]
  );
  res.json(rows);
});

app.get("/listings/mine", auth("seller", "admin"), async (req, res) => {
  const { rows } = await q(`select ${LIST_COLS} from listings l join users u on u.id=l.seller_id where l.seller_id=$1 and l.status<>'removed' order by l.created_at desc`, [req.user.id]);
  res.json(rows);
});

app.get("/listings/:id", async (req, res) => {
  const { rows } = await q(`select ${LIST_COLS} from listings l join users u on u.id=l.seller_id where l.id=$1 and l.status='active'`, [req.params.id]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: "Listing not found" });
});

app.post("/listings", auth("seller", "admin"), async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 150), category = str(b.category, 60), origin = str(b.originCountry, 60);
  const moq = int(b.moq), price = num(b.price);
  if (!title || !category || !origin || !(moq >= 1) || !(price > 0)) return bad(res, "title, category, originCountry, moq and price are required");
  const tiers = parseTiers(b.tiers, moq, price);
  if (!tiers) return bad(res, "Invalid price tiers");
  const photos = Array.isArray(b.photos) ? b.photos.slice(0, 4) : [];
  if (photos.some((p) => typeof p !== "string" || !PUBLIC || !p.startsWith(PUBLIC + "/"))) return bad(res, "Photos must be uploaded through /uploads/sign");
  const status = req.user.verified ? "active" : "pending";
  const { rows } = await q(
    `insert into listings (seller_id,title,description,category,hs_code,origin_country,moq,price_tiers,photos,status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [req.user.id, title, str(b.description, 2000), category, str(b.hsCode, 20), origin, moq, JSON.stringify(tiers), photos, status]
  );
  res.status(201).json(rows[0]);
});

app.delete("/listings/:id", auth("seller", "admin"), async (req, res) => {
  const { rowCount } = await q(
    "update listings set status='removed' where id=$1 and ($2='admin' or seller_id=$3)",
    [req.params.id, req.user.role, req.user.id]
  );
  rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Listing not found" });
});

// ---------- favorites ----------
app.get("/favorites", auth(), async (req, res) => {
  const { rows } = await q(`select ${LIST_COLS} from favorites f join listings l on l.id=f.listing_id join users u on u.id=l.seller_id where f.user_id=$1 and l.status='active'`, [req.user.id]);
  res.json(rows);
});
app.put("/favorites/:listingId", auth(), async (req, res) => {
  const del = await q("delete from favorites where user_id=$1 and listing_id=$2", [req.user.id, req.params.listingId]);
  if (del.rowCount) return res.json({ favorite: false });
  await q("insert into favorites (user_id,listing_id) values ($1,$2)", [req.user.id, req.params.listingId]);
  res.json({ favorite: true });
});

// ---------- orders (escrow here is a status flag; no real money moves yet) ----------
app.post("/orders", auth("buyer"), async (req, res) => {
  const listingId = req.body?.listingId, qty = int(req.body?.qty), dest = str(req.body?.destCountry, 60);
  if (!listingId || !(qty >= 1) || !dest) return bad(res, "listingId, qty and destCountry are required");
  const c = await pool.connect();
  try {
    await c.query("begin");
    const { rows: [l] } = await c.query(
      "select l.*, u.status as seller_status from listings l join users u on u.id=l.seller_id where l.id=$1 and l.status='active'", [listingId]);
    if (!l || l.seller_status !== "active") { await c.query("rollback"); return res.status(404).json({ error: "Listing not available" }); }
    if (l.seller_id === req.user.id) { await c.query("rollback"); return bad(res, "You cannot buy your own listing"); }
    if (qty < l.moq) { await c.query("rollback"); return bad(res, `Minimum order is ${l.moq}`); }
    const unit = tierPrice(l.price_tiers, qty), total = +(unit * qty).toFixed(2);
    const ref = `TB-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const { rows: [o] } = await c.query(
      `insert into orders (ref,buyer_id,seller_id,listing_id,qty,unit_price,total,dest_country)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [ref, req.user.id, l.seller_id, l.id, qty, unit, total, dest]);
    await c.query("insert into shipments (order_id,tracking_ref,route) values ($1,$2,$3)", [o.id, ref, `${l.origin_country} → ${dest}`]);
    await c.query("commit");
    res.status(201).json(o);
  } catch (err) { await c.query("rollback").catch(() => {}); throw err; } finally { c.release(); }
});

app.get("/orders", auth(), async (req, res) => {
  const who = { buyer: "o.buyer_id=$1", seller: "o.seller_id=$1", logistics: "s.carrier_id=$1", admin: "true" }[req.user.role];
  const { rows } = await q(
    `select o.*, l.title, s.tracking_ref, s.status as shipment_status, s.delayed, s.eta
     from orders o join listings l on l.id=o.listing_id left join shipments s on s.order_id=o.id
     where ${who} order by o.created_at desc limit 100`,
    req.user.role === "admin" ? [] : [req.user.id]
  );
  res.json(rows);
});

const STATUSES = ["escrow", "preparing", "in_transit", "delivered", "cancelled", "disputed"];
const NEXT = { seller: { escrow: ["preparing"], preparing: ["in_transit"] }, buyer: { escrow: ["cancelled"], in_transit: ["delivered"] } };
app.patch("/orders/:id/status", auth("buyer", "seller", "admin"), async (req, res) => {
  const to = req.body?.status;
  const { rows: [o] } = await q("select * from orders where id=$1", [req.params.id]);
  if (!o) return res.status(404).json({ error: "Order not found" });
  const r = req.user.role;
  const mine = r === "admin" || (r === "buyer" && o.buyer_id === req.user.id) || (r === "seller" && o.seller_id === req.user.id);
  if (!mine) return res.status(403).json({ error: "Not allowed" });
  const ok = r === "admin" ? STATUSES.includes(to) : NEXT[r]?.[o.status]?.includes(to);
  if (!ok) return bad(res, "That status change is not allowed");
  const { rows } = await q("update orders set status=$1 where id=$2 returning *", [to, o.id]);
  res.json(rows[0]);
});

// ---------- shipments and tracking ----------
app.get("/track/:ref", async (req, res) => {
  const { rows } = await q("select tracking_ref,route,status,delayed,eta,updated_at from shipments where tracking_ref=$1", [req.params.ref]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: "Tracking number not found" });
});

app.get("/shipments", auth("logistics", "admin"), async (req, res) => {
  const { rows } = await q(
    `select s.*, u.name as carrier_name from shipments s left join users u on u.id=s.carrier_id
     where ($1='admin' or s.carrier_id=$2) order by s.updated_at desc limit 200`, [req.user.role, req.user.id]);
  res.json(rows);
});

app.patch("/shipments/:id", auth("logistics", "admin"), async (req, res) => {
  const { status, delayed, eta, carrierId } = req.body || {};
  const { rows: [s] } = await q("select * from shipments where id=$1", [req.params.id]);
  if (!s) return res.status(404).json({ error: "Shipment not found" });
  if (req.user.role === "logistics" && s.carrier_id !== req.user.id) return res.status(403).json({ error: "Not your shipment" });
  let cid = s.carrier_id;
  if (carrierId !== undefined) {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins assign carriers" });
    if (carrierId !== null) {
      const { rowCount } = await q("select 1 from users where id=$1 and role='logistics' and status='active'", [carrierId]);
      if (!rowCount) return bad(res, "Carrier not found");
    }
    cid = carrierId;
  }
  const st = status === undefined ? s.status : int(status);
  if (st === null || st < 0 || st > 5) return bad(res, "status must be 0 to 5");
  const { rows } = await q(
    "update shipments set status=$1, delayed=$2, eta=$3, carrier_id=$4, updated_at=now() where id=$5 returning *",
    [st, delayed === undefined ? s.delayed : !!delayed, eta === undefined ? s.eta : str(eta, 40), cid, s.id]);
  res.json(rows[0]);
});

// ---------- RFQs ----------
app.post("/rfqs", auth("buyer"), async (req, res) => {
  const product = str(req.body?.product, 200), qty = int(req.body?.qty), dest = str(req.body?.destCountry, 60), budget = num(req.body?.budgetUsd);
  if (!product || !(qty >= 1) || !dest) return bad(res, "product, qty and destCountry are required");
  const { rows } = await q("insert into rfqs (buyer_id,product,qty,dest_country,budget_usd) values ($1,$2,$3,$4,$5) returning *", [req.user.id, product, qty, dest, budget]);
  res.status(201).json(rows[0]);
});
app.get("/rfqs", auth(), async (req, res) => {
  const { rows } = await q(
    `select r.*, u.name as buyer_name from rfqs r join users u on u.id=r.buyer_id
     where ($1='buyer' and r.buyer_id=$2) or ($1 in ('seller','admin') and r.status='open') order by r.created_at desc limit 100`,
    [req.user.role, req.user.id]);
  res.json(rows);
});

// ---------- messages (buyer <-> seller about a listing) ----------
app.post("/messages", auth("buyer", "seller"), async (req, res) => {
  const body = str(req.body?.body, 1000), listingId = req.body?.listingId;
  if (!body || !listingId) return bad(res, "listingId and body are required");
  const { rows: [l] } = await q("select seller_id from listings where id=$1 and status='active'", [listingId]);
  if (!l) return res.status(404).json({ error: "Listing not found" });
  let to = l.seller_id;
  if (req.user.role === "seller") {
    if (l.seller_id !== req.user.id) return res.status(403).json({ error: "Not your listing" });
    to = req.body?.toUserId;
    const { rowCount } = await q("select 1 from messages where listing_id=$1 and sender_id=$2 and recipient_id=$3", [listingId, to, req.user.id]);
    if (!rowCount) return bad(res, "You can only reply to buyers who messaged you");
  }
  const { rows } = await q("insert into messages (listing_id,sender_id,recipient_id,body) values ($1,$2,$3,$4) returning *", [listingId, req.user.id, to, body]);
  res.status(201).json(rows[0]);
});
app.get("/messages", auth(), async (req, res) => {
  const { rows } = await q(
    "select * from messages where listing_id=$1 and (sender_id=$2 or recipient_id=$2) order by created_at asc limit 200",
    [req.query.listingId, req.user.id]);
  res.json(rows);
});

// ---------- admin ----------
app.get("/admin/stats", auth("admin"), async (_req, res) => {
  const { rows } = await q(`select
    (select count(*) from users where role='buyer')::int as buyers,
    (select count(*) from users where role='seller')::int as sellers,
    (select count(*) from users where role='logistics')::int as logistics,
    (select count(*) from users where role='seller' and not verified)::int as pending_sellers,
    (select count(*) from orders)::int as orders,
    (select coalesce(sum(total),0) from orders where status<>'cancelled')::float as gmv,
    (select coalesce(sum(total),0) from orders where status in ('escrow','preparing','in_transit','disputed'))::float as escrow_held,
    (select count(*) from shipments where status<5)::int as live_shipments,
    (select count(*) from shipments where delayed)::int as delayed_shipments`);
  res.json(rows[0]);
});

app.get("/admin/users", auth("admin"), async (req, res) => {
  const role = ["buyer", "seller", "logistics"].includes(req.query.role) ? req.query.role : null;
  const { rows } = await q(
    "select id,name,email,role,country,status,verified,created_at from users where role<>'admin' and ($1::text is null or role=$1) order by created_at desc limit 200", [role]);
  res.json(rows);
});

app.patch("/admin/users/:id", auth("admin"), async (req, res) => {
  const { status, verified } = req.body || {};
  if (status !== undefined && !["active", "suspended"].includes(status)) return bad(res, "Invalid status");
  const { rows } = await q(
    `update users set status=coalesce($1,status), verified=coalesce($2,verified)
     where id=$3 and role<>'admin' returning id,name,email,role,country,status,verified`,
    [status ?? null, typeof verified === "boolean" ? verified : null, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "User not found" });
  if (rows[0].role === "seller" && verified === true) await q("update listings set status='active' where seller_id=$1 and status='pending'", [rows[0].id]);
  res.json(rows[0]);
});

// ---------- errors ----------
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  if (err.code === "22P02") return res.status(400).json({ error: "Invalid id" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const port = env.PORT || 3000;
app.listen(port, () => console.log(`TradeBridge API listening on ${port}`));
