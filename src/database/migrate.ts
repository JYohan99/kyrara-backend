import "dotenv/config";
import { pool } from "./connection.js";

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      booking_mode TEXT NOT NULL DEFAULT 'approval' CHECK (booking_mode IN ('auto', 'approval')),
      timezone TEXT NOT NULL DEFAULT 'America/Montevideo',
      slot_step_minutes INTEGER NOT NULL DEFAULT 30,
      logo_base64 TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS service (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES business(id),
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      price REAL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES business(id),
      name TEXT,
      phone TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
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
      approval_expires_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customer(id),
      state TEXT NOT NULL DEFAULT 'START',
      last_message TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversation(id),
      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
      text TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    ALTER TABLE conversation ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}';

    CREATE INDEX IF NOT EXISTS idx_appointment_slot ON appointment(business_id, date, start_time, end_time);

    ALTER TABLE customer ALTER COLUMN phone DROP NOT NULL;
    ALTER TABLE customer ADD COLUMN IF NOT EXISTS whatsapp_lid TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_business_lid ON customer(business_id, whatsapp_lid) WHERE whatsapp_lid IS NOT NULL;

  `);

  console.log("Migración completa en Postgres (Supabase).");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Error en la migración:", err);
  process.exit(1);
});