import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pool } from "./connection.js";

async function seedStatistics() {
  const { rows: businesses } = await pool.query("SELECT id FROM business LIMIT 1");
  if (!businesses.length) {
    console.error("No hay negocio en la DB. Correr seed.ts primero.");
    process.exit(1);
  }
  const businessId = businesses[0].id;

  // 1. Asegurar catálogo de servicios representativo
  const servicesToEnsure = [
    { name: "Corte clásico", duration: 30, price: 500 },
    { name: "Corte y Barba", duration: 45, price: 750 },
    { name: "Perfilado de Barba", duration: 25, price: 350 },
    { name: "Corte Degradé Fade", duration: 35, price: 600 },
    { name: "Lavado y Peinado", duration: 20, price: 300 },
  ];

  const serviceMap = new Map<string, string>(); // name -> id

  for (const s of servicesToEnsure) {
    const existing = await pool.query(
      "SELECT id FROM service WHERE business_id = $1 AND name = $2",
      [businessId, s.name]
    );
    if (existing.rows.length) {
      serviceMap.set(s.name, existing.rows[0].id);
    } else {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO service (id, business_id, name, duration_minutes, price, active) VALUES ($1, $2, $3, $4, $5, 1)",
        [id, businessId, s.name, s.duration, s.price]
      );
      serviceMap.set(s.name, id);
    }
  }

  // 2. Asegurar una lista de clientes
  const customerNames = [
    "Mateo Rossi", "Facundo Silva", "Emiliano Gómez", "Santiago Pereira",
    "Joaquín Rodríguez", "Lucas Martínez", "Nicolás Fernández", "Matías Ramos",
    "Agustín Álvarez", "Bruno Morales", "Rodrigo Castro", "Ignacio Méndez",
    "Felipe Benítez", "Gonzalo Romero", "Manuel Díaz", "Gabriel Acosta"
  ];

  const customerIds: string[] = [];
  for (let i = 0; i < customerNames.length; i++) {
    const name = customerNames[i];
    const phone = `+598991000${(i + 1).toString().padStart(2, "0")}`;
    const existing = await pool.query(
      "SELECT id FROM customer WHERE business_id = $1 AND phone = $2",
      [businessId, phone]
    );
    if (existing.rows.length) {
      customerIds.push(existing.rows[0].id);
    } else {
      const id = randomUUID();
      // Algunos clientes nuevos este mes, otros el mes pasado
      const createdAt = i < 6 ? "2026-09-08 14:00:00" : "2026-08-10 10:00:00";
      await pool.query(
        "INSERT INTO customer (id, business_id, name, phone, created_at, active) VALUES ($1, $2, $3, $4, $5, 1)",
        [id, businessId, name, phone, createdAt]
      );
      customerIds.push(id);
    }
  }

  // Verificar si ya hay reservas
  const { rows: apptCount } = await pool.query(
    "SELECT COUNT(*)::int as count FROM appointment WHERE business_id = $1",
    [businessId]
  );

  if (apptCount[0].count > 0) {
    console.log(`Ya existen ${apptCount[0].count} reservas en la base de datos.`);
    await pool.end();
    return;
  }

  console.log("Generando datos de prueba para estadísticas (Agosto y Septiembre 2026)...");

  const serviceKeys = Array.from(serviceMap.keys());
  const hours = ["09:00", "09:45", "10:30", "11:15", "14:00", "14:45", "15:30", "16:15", "17:00", "17:45", "18:30"];

  // Generar reservas en Agosto 2026 (~71 reservas)
  // Generar reservas en Septiembre 2026 (~86 reservas, exactamente como en el ejemplo del usuario!)
  const daysInAugust = 31;
  const daysInSeptember = 28; // hasta hoy 28 de septiembre

  let apptIndex = 0;

  // Mes anterior: Agosto (aprox 71 reservas)
  for (let d = 1; d <= daysInAugust; d++) {
    const dayStr = d.toString().padStart(2, "0");
    const date = `2026-08-${dayStr}`;
    const dateObj = new Date(Date.UTC(2026, 7, d));
    const dow = dateObj.getUTCDay(); // 0 = Sun
    if (dow === 0) continue; // Domingo cerrado

    // Sábados y Viernes más activos
    const countForDay = dow === 6 ? 4 : dow === 5 ? 3 : 2;
    for (let c = 0; c < countForDay && apptIndex < 71; c++) {
      apptIndex++;
      const sName = serviceKeys[(apptIndex + c) % serviceKeys.length];
      const sId = serviceMap.get(sName)!;
      const cId = customerIds[apptIndex % customerIds.length];
      const start = hours[c % hours.length];
      const end = hours[(c + 1) % hours.length];

      // Estados: 85% completadas, 8% canceladas, 7% no presentados
      let status = "COMPLETED";
      if (apptIndex % 13 === 0) status = "CANCELLED";
      else if (apptIndex % 15 === 0) status = "NO_SHOW";

      await pool.query(
        `INSERT INTO appointment (id, business_id, customer_id, service_id, date, start_time, end_time, status, created_via)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'whatsapp')`,
        [randomUUID(), businessId, cId, sId, date, start, end, status]
      );
    }
  }

  // Mes actual: Septiembre (86 reservas)
  let septIndex = 0;
  for (let d = 1; d <= daysInSeptember; d++) {
    const dayStr = d.toString().padStart(2, "0");
    const date = `2026-09-${dayStr}`;
    const dateObj = new Date(Date.UTC(2026, 8, d));
    const dow = dateObj.getUTCDay();
    if (dow === 0) continue; // Domingo cerrado

    // Sábado 19 y Sábado 26 como picos de actividad
    const isPeakSaturday = dow === 6;
    const countForDay = isPeakSaturday ? 5 : dow === 5 ? 4 : (d % 2 === 0 ? 3 : 2);

    for (let c = 0; c < countForDay && septIndex < 86; c++) {
      septIndex++;
      const sName = serviceKeys[(septIndex * 2 + c) % serviceKeys.length];
      const sId = serviceMap.get(sName)!;
      const cId = customerIds[septIndex % customerIds.length];
      const start = hours[c % hours.length];
      const end = hours[(c + 1) % hours.length];

      let status = "COMPLETED";
      if (septIndex % 14 === 0) status = "CANCELLED";
      else if (septIndex % 18 === 0) status = "NO_SHOW";
      else if (date === "2026-09-28" && c > 1) status = "CONFIRMED";

      await pool.query(
        `INSERT INTO appointment (id, business_id, customer_id, service_id, date, start_time, end_time, status, created_via)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'whatsapp')`,
        [randomUUID(), businessId, cId, sId, date, start, end, status]
      );
    }
  }

  console.log(`Seed completado: Agosto (~71 turnos), Septiembre (${septIndex} turnos).`);
  await pool.end();
}

seedStatistics().catch((e) => {
  console.error("Error en seedStatistics:", e);
  process.exit(1);
});
