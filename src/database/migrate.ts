import "dotenv/config";
import { db } from "./connection.js";

// Esquema inicial basado en el modelo de datos del documento técnico (sección 12)

db.exec(`
CREATE TABLE IF NOT EXISTS business (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  booking_mode TEXT NOT NULL DEFAULT 'approval' CHECK (booking_mode IN ('auto', 'approval')),
  timezone TEXT NOT NULL DEFAULT 'America/Montevideo',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS service (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id),
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  price REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id),
  name TEXT,
  phone TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(business_id, phone)
);

CREATE TABLE IF NOT EXISTS availability (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS availability_exception (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id),
  date TEXT NOT NULL,
  closed_all_day INTEGER NOT NULL DEFAULT 1,
  start_time TEXT,
  end_time TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS appointment (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id),
  customer_id TEXT NOT NULL REFERENCES customer(id),
  service_id TEXT NOT NULL REFERENCES service(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
    CHECK (status IN ('PENDING','PENDING_APPROVAL','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')),
  created_via TEXT NOT NULL DEFAULT 'whatsapp' CHECK (created_via IN ('whatsapp','manual')),
  approval_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer(id),
  state TEXT NOT NULL DEFAULT 'START',
  last_message TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_appointment_slot ON appointment(business_id, date, start_time, end_time);
`);

console.log(`Migración completa. Base de datos en: ${process.env.DATABASE_PATH ?? "./data/kyrara.db"}`);