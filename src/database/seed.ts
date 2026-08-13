import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "./connection.js";

// Datos de prueba para desarrollo local. Este script se puede correr
// varias veces sin duplicar el negocio (usa INSERT OR IGNORE por teléfono único).

const businessId = randomUUID();

const existing = db.prepare("SELECT id FROM business LIMIT 1").get();

if (existing) {
  console.log("Ya existe un negocio en la base de datos, no se crea uno nuevo.");
} else {
  db.prepare(
    `INSERT INTO business (id, name, phone, address, booking_mode, timezone)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(businessId, "Barbería Don Carlos", "+59899123456", "18 de Julio 1234, Montevideo", "approval", "America/Montevideo");

  const serviceId = randomUUID();
  db.prepare(
    `INSERT INTO service (id, business_id, name, duration_minutes, price, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(serviceId, businessId, "Corte clásico", 30, 500);

  console.log("Negocio y servicio de prueba creados.");
  console.log({ businessId, serviceId });
}