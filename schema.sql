create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('buyer','seller','logistics','admin')),
  country text,
  status text not null default 'active' check (status in ('active','suspended')),
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references users(id) on delete cascade,
  title text not null,
  description text,
  category text not null,
  hs_code text,
  origin_country text not null,
  moq integer not null check (moq >= 1),
  price_tiers jsonb not null,
  photos text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','active','removed')),
  created_at timestamptz not null default now()
);
create index if not exists listings_browse on listings (status, category, created_at desc);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  buyer_id uuid not null references users(id),
  seller_id uuid not null references users(id),
  listing_id uuid not null references listings(id),
  qty integer not null check (qty >= 1),
  unit_price numeric(14,4) not null,
  total numeric(14,2) not null,
  dest_country text not null,
  status text not null default 'escrow'
    check (status in ('escrow','preparing','in_transit','delivered','cancelled','disputed')),
  created_at timestamptz not null default now()
);
create index if not exists orders_buyer on orders (buyer_id);
create index if not exists orders_seller on orders (seller_id);

create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id) on delete cascade,
  carrier_id uuid references users(id),
  tracking_ref text not null unique,
  route text not null,
  status smallint not null default 0 check (status between 0 and 5),
  eta text,
  delayed boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists rfqs (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references users(id) on delete cascade,
  product text not null,
  qty integer not null check (qty >= 1),
  dest_country text not null,
  budget_usd numeric(14,2),
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_thread on messages (listing_id, created_at);

create table if not exists favorites (
  user_id uuid not null references users(id) on delete cascade,
  listing_id uuid not null references listings(id) on delete cascade,
  primary key (user_id, listing_id)
);
