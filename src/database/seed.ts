import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pool } from "./connection.js";

async function seed() {
  const { rows: existing } = await pool.query("SELECT id FROM business LIMIT 1");

  if (existing.length > 0) {
    console.log("Ya existe un negocio en la base de datos, no se crea uno nuevo.");
    await pool.end();
    return;
  }

  const businessId = randomUUID();
  await pool.query(
    `INSERT INTO business (id, name, phone, address, booking_mode, timezone)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [businessId, "Barbería Don Carlos", "+59899123456", "18 de Julio 1234, Montevideo", "approval", "America/Montevideo"]
  );

  const serviceId = randomUUID();
  await pool.query(
    `INSERT INTO service (id, business_id, name, duration_minutes, price, active)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [serviceId, businessId, "Corte clásico", 30, 500]
  );

  console.log("Negocio y servicio de prueba creados.");
  console.log({ businessId, serviceId });
  await pool.end();
}

seed().catch((err) => {
  console.error("Error en el seed:", err);
  process.exit(1);
});