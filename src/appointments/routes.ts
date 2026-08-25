import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export async function appointmentRoutes(app: FastifyInstance) {
  async function getBusinessId(): Promise<string | null> {
    const { rows } = await pool.query("SELECT id FROM business LIMIT 1");
    return rows[0]?.id ?? null;
  }

  app.get("/", async (request) => {
    const { date } = request.query as { date?: string };
    const day = date ?? new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT a.*, c.name as customer_name, c.phone as customer_phone, s.name as service_name
       FROM appointment a
       JOIN customer c ON c.id = a.customer_id
       JOIN service s ON s.id = a.service_id
       WHERE a.date = $1 AND a.status != 'CANCELLED'
       ORDER BY a.start_time`,
      [day]
    );
    return rows;
  });

  app.get("/available-slots", async (request, reply) => {
    const { date, service_id } = request.query as { date?: string; service_id?: string };
    if (!date || !service_id) {
      return reply.status(400).send({ error: "date y service_id son obligatorios" });
    }

    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const businessRes = await pool.query("SELECT slot_step_minutes FROM business WHERE id = $1", [businessId]);
    const STEP = businessRes.rows[0]?.slot_step_minutes ?? 30;

    const serviceRes = await pool.query("SELECT * FROM service WHERE id = $1 AND active = 1", [service_id]);
    const service = serviceRes.rows[0];
    if (!service) return reply.status(404).send({ error: "Servicio no encontrado o inactivo" });

    const exceptionsRes = await pool.query(
      "SELECT * FROM availability_exception WHERE business_id = $1 AND date = $2",
      [businessId, date]
    );
    const exceptions = exceptionsRes.rows as {
      closed_all_day: number;
      start_time: string | null;
      end_time: string | null;
    }[];

    if (exceptions.some((e) => e.closed_all_day)) {
      return { date, service_id, slots: [] };
    }

    const dow = dayOfWeek(date);
    const windowsRes = await pool.query(
      "SELECT * FROM availability WHERE business_id = $1 AND day_of_week = $2 AND active = 1",
      [businessId, dow]
    );
    const windows = windowsRes.rows as { start_time: string; end_time: string }[];

    if (windows.length === 0) return { date, service_id, slots: [] };

    const busyRes = await pool.query(
      `SELECT start_time, end_time FROM appointment
       WHERE business_id = $1 AND date = $2 AND status != 'CANCELLED'`,
      [businessId, date]
    );
    const busy = busyRes.rows as { start_time: string; end_time: string }[];

    const blocked = [
      ...busy.map((b) => ({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) })),
      ...exceptions
        .filter((e) => !e.closed_all_day && e.start_time && e.end_time)
        .map((e) => ({ start: timeToMinutes(e.start_time!), end: timeToMinutes(e.end_time!) })),
    ];

    const duration = service.duration_minutes;
    const slots: string[] = [];

    for (const w of windows) {
      const windowStart = timeToMinutes(w.start_time);
      const windowEnd = timeToMinutes(w.end_time);

      for (let start = windowStart; start + duration <= windowEnd; start += STEP) {
        const end = start + duration;
        const overlaps = blocked.some((b) => start < b.end && end > b.start);
        if (!overlaps) slots.push(minutesToTime(start));
      }
    }

    return { date, service_id, duration_minutes: duration, slots };
  });

  app.post("/", async (request, reply) => {
    const body = request.body as {
      customer_id?: string;
      service_id?: string;
      date?: string;
      start_time?: string;
      created_via?: "whatsapp" | "manual";
    };

    if (!body.customer_id || !body.service_id || !body.date || !body.start_time) {
      return reply.status(400).send({ error: "customer_id, service_id, date y start_time son obligatorios" });
    }

    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const serviceRes = await pool.query("SELECT duration_minutes FROM service WHERE id = $1", [body.service_id]);
    const service = serviceRes.rows[0];
    if (!service) return reply.status(404).send({ error: "Servicio no encontrado" });

    const customerRes = await pool.query("SELECT id FROM customer WHERE id = $1", [body.customer_id]);
    if (!customerRes.rows[0]) return reply.status(404).send({ error: "Cliente no encontrado" });

    const startMin = timeToMinutes(body.start_time);
    const endMin = startMin + service.duration_minutes;
    const endTime = minutesToTime(endMin);

    // Regla 004: transacción real de Postgres (BEGIN/COMMIT/ROLLBACK) para
    // evitar que dos reservas se superpongan si llegan casi al mismo tiempo.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const conflictRes = await client.query(
        `SELECT id FROM appointment
         WHERE business_id = $1 AND date = $2 AND status != 'CANCELLED'
         AND start_time < $3 AND end_time > $4`,
        [businessId, body.date, endTime, body.start_time]
      );

      if (conflictRes.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ error: "Ese horario ya no está disponible" });
      }

      const id = randomUUID();
      const isManual = (body.created_via ?? "manual") === "manual";

      await client.query(
        `INSERT INTO appointment
           (id, business_id, customer_id, service_id, date, start_time, end_time, status, created_via)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          businessId,
          body.customer_id,
          body.service_id,
          body.date,
          body.start_time,
          endTime,
          isManual ? "CONFIRMED" : "PENDING_APPROVAL",
          isManual ? "manual" : "whatsapp",
        ]
      );

      await client.query("COMMIT");

      const createdRes = await pool.query("SELECT * FROM appointment WHERE id = $1", [id]);
      return reply.status(201).send(createdRes.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.patch("/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existingRes = await pool.query("SELECT * FROM appointment WHERE id = $1", [id]);
    if (!existingRes.rows[0]) return reply.status(404).send({ error: "Reserva no encontrada" });

    await pool.query("UPDATE appointment SET status = 'CANCELLED' WHERE id = $1", [id]);
    const updatedRes = await pool.query("SELECT * FROM appointment WHERE id = $1", [id]);
    return updatedRes.rows[0];
  });

  app.post("/:id/respond", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { decision } = request.body as { decision: "accept" | "reject" };

    const existingRes = await pool.query("SELECT * FROM appointment WHERE id = $1", [id]);
    if (!existingRes.rows[0]) return reply.status(404).send({ error: "Reserva no encontrada" });

    const newStatus = decision === "accept" ? "CONFIRMED" : "CANCELLED";
    await pool.query("UPDATE appointment SET status = $1 WHERE id = $2", [newStatus, id]);

    return { id, status: newStatus };
  });

  app.put("/business", async (request, reply) => {
    const body = request.body as {
      name?: string;
      phone?: string;
      address?: string;
      logo_base64?: string;
    };
    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const existingRes = await pool.query("SELECT * FROM business WHERE id = $1", [businessId]);
    const existing = existingRes.rows[0];

    await pool.query(
      "UPDATE business SET name = $1, phone = $2, address = $3, logo_base64 = $4 WHERE id = $5",
      [
        body.name ?? existing.name,
        body.phone ?? existing.phone,
        body.address ?? existing.address,
        body.logo_base64 !== undefined ? body.logo_base64 : existing.logo_base64,
        businessId,
      ]
    );

    const updatedRes = await pool.query("SELECT * FROM business WHERE id = $1", [businessId]);
    return updatedRes.rows[0];
  });

   app.patch("/business/settings", async (request, reply) => {
    const { slot_step_minutes, booking_mode } = request.body as {
      slot_step_minutes?: number;
      booking_mode?: "auto" | "approval";
    };
    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    if (slot_step_minutes && ![15, 30, 45, 60].includes(slot_step_minutes)) {
      return reply.status(400).send({ error: "slot_step_minutes debe ser 15, 30, 45 o 60" });
    }

    if (slot_step_minutes) {
      await pool.query("UPDATE business SET slot_step_minutes = $1 WHERE id = $2", [slot_step_minutes, businessId]);
    }

    if (booking_mode && ["auto", "approval"].includes(booking_mode)) {
      await pool.query("UPDATE business SET booking_mode = $1 WHERE id = $2", [booking_mode, businessId]);
    }

    const updatedRes = await pool.query("SELECT * FROM business WHERE id = $1", [businessId]);
    return updatedRes.rows[0];
  });

  app.get("/business", async () => {
    const businessRes = await pool.query("SELECT * FROM business LIMIT 1");
    const business = businessRes.rows[0];
    if (!business) return { error: "No hay negocio cargado todavía" };

    const servicesRes = await pool.query("SELECT * FROM service WHERE business_id = $1", [business.id]);
    return { business, services: servicesRes.rows };
  });
}