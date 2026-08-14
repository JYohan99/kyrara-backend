import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../database/connection.js";

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
  // dateStr en formato YYYY-MM-DD. Usamos UTC para evitar corrimientos
  // de día por la zona horaria del servidor.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export async function appointmentRoutes(app: FastifyInstance) {
  function getBusinessId(): string | null {
    const business = db.prepare("SELECT id FROM business LIMIT 1").get() as { id: string } | undefined;
    return business?.id ?? null;
  }

  // Agenda de un día (pantalla "Inicio" de la app)
  app.get("/", async (request) => {
    const { date } = request.query as { date?: string };
    const day = date ?? new Date().toISOString().slice(0, 10);
    return db
      .prepare(
        `SELECT a.*, c.name as customer_name, c.phone as customer_phone, s.name as service_name
         FROM appointment a
         JOIN customer c ON c.id = a.customer_id
         JOIN service s ON s.id = a.service_id
         WHERE a.date = ? AND a.status != 'CANCELLED'
         ORDER BY a.start_time`
      )
      .all(day);
  });

  // --- Fase 6: motor de disponibilidad ---
  // Calcula los horarios de inicio disponibles para un servicio en una fecha dada.
  // GET /appointments/available-slots?date=2026-08-20&service_id=xxxx
  app.get("/available-slots", async (request, reply) => {
    const { date, service_id } = request.query as { date?: string; service_id?: string };
    if (!date || !service_id) {
      return reply.status(400).send({ error: "date y service_id son obligatorios" });
    }

    const businessId = getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const service = db.prepare("SELECT * FROM service WHERE id = ? AND active = 1").get(service_id) as
      | { duration_minutes: number }
      | undefined;
    if (!service) return reply.status(404).send({ error: "Servicio no encontrado o inactivo" });

    // 1. ¿Hay una excepción (feriado/cierre) que bloquee el día completo?
    const exceptions = db
      .prepare("SELECT * FROM availability_exception WHERE business_id = ? AND date = ?")
      .all(businessId, date) as { closed_all_day: number; start_time: string | null; end_time: string | null }[];

    if (exceptions.some((e) => e.closed_all_day)) {
      return { date, service_id, slots: [] };
    }

    // 2. Horario laboral recurrente de ese día de la semana
    const dow = dayOfWeek(date);
    const windows = db
      .prepare("SELECT * FROM availability WHERE business_id = ? AND day_of_week = ? AND active = 1")
      .all(businessId, dow) as { start_time: string; end_time: string }[];

    if (windows.length === 0) return { date, service_id, slots: [] };

    // 3. Reservas ya existentes ese día (bloquean horario)
    const busy = db
      .prepare(
        `SELECT start_time, end_time FROM appointment
         WHERE business_id = ? AND date = ? AND status != 'CANCELLED'`
      )
      .all(businessId, date) as { start_time: string; end_time: string }[];

    // Bloques ocupados: reservas existentes + excepciones parciales del día
    const blocked = [
      ...busy.map((b) => ({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) })),
      ...exceptions
        .filter((e) => !e.closed_all_day && e.start_time && e.end_time)
        .map((e) => ({ start: timeToMinutes(e.start_time!), end: timeToMinutes(e.end_time!) })),
    ];

    const duration = service.duration_minutes;
    const STEP = 15; // generamos candidatos cada 15 minutos
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

  // --- Fase 5: creación manual de reservas (Regla 008) ---
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

    const businessId = getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const service = db.prepare("SELECT duration_minutes FROM service WHERE id = ?").get(body.service_id) as
      | { duration_minutes: number }
      | undefined;
    if (!service) return reply.status(404).send({ error: "Servicio no encontrado" });

    const customer = db.prepare("SELECT id FROM customer WHERE id = ?").get(body.customer_id);
    if (!customer) return reply.status(404).send({ error: "Cliente no encontrado" });

    const startMin = timeToMinutes(body.start_time);
    const endMin = startMin + service.duration_minutes;
    const endTime = minutesToTime(endMin);

    // Regla 004: validar disponibilidad dentro de una transacción atómica,
    // para evitar que dos reservas se superpongan si llegan casi al mismo tiempo.
    const createAppointment = db.transaction(() => {
      const conflict = db
        .prepare(
          `SELECT id FROM appointment
           WHERE business_id = ? AND date = ? AND status != 'CANCELLED'
           AND start_time < ? AND end_time > ?`
        )
        .get(businessId, body.date, endTime, body.start_time);

      if (conflict) {
        throw new Error("SLOT_TAKEN");
      }

      const id = randomUUID();
      const isManual = (body.created_via ?? "manual") === "manual";
      db.prepare(
        `INSERT INTO appointment
           (id, business_id, customer_id, service_id, date, start_time, end_time, status, created_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        businessId,
        body.customer_id,
        body.service_id,
        body.date,
        body.start_time,
        endTime,
        isManual ? "CONFIRMED" : "PENDING_APPROVAL",
        isManual ? "manual" : "whatsapp"
      );

      return id;
    });

    try {
      const id = createAppointment();
      return reply.status(201).send(db.prepare("SELECT * FROM appointment WHERE id = ?").get(id));
    } catch (err: any) {
      if (err.message === "SLOT_TAKEN") {
        return reply.status(409).send({ error: "Ese horario ya no está disponible" });
      }
      throw err;
    }
  });

  // Cancelar una reserva (Regla 006: libera el horario automáticamente,
  // ya que las canceladas se excluyen de los chequeos de conflicto)
  app.patch("/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare("SELECT * FROM appointment WHERE id = ?").get(id);
    if (!existing) return reply.status(404).send({ error: "Reserva no encontrada" });

    db.prepare("UPDATE appointment SET status = 'CANCELLED' WHERE id = ?").run(id);
    return db.prepare("SELECT * FROM appointment WHERE id = ?").get(id);
  });

  // Aceptar/rechazar desde la notificación push (ya existente)
  app.post("/:id/respond", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { decision } = request.body as { decision: "accept" | "reject" };

    const appointment = db.prepare("SELECT * FROM appointment WHERE id = ?").get(id);
    if (!appointment) return reply.status(404).send({ error: "Reserva no encontrada" });

    const newStatus = decision === "accept" ? "CONFIRMED" : "CANCELLED";
    db.prepare("UPDATE appointment SET status = ? WHERE id = ?").run(newStatus, id);

    return { id, status: newStatus };
  });

    // Devuelve el negocio piloto junto con sus servicios (usado por la
  // pantalla de Inicio de la app)
  app.get("/business", async () => {
    const business = db.prepare("SELECT * FROM business LIMIT 1").get();
    if (!business) return { error: "No hay negocio cargado todavía" };

    const services = db
      .prepare("SELECT * FROM service WHERE business_id = ?")
      .all((business as any).id);

    return { business, services };
  });
}