import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../database/connection.js";

export async function availabilityRoutes(app: FastifyInstance) {
  function getBusinessId(): string | null {
    const business = db.prepare("SELECT id FROM business LIMIT 1").get() as { id: string } | undefined;
    return business?.id ?? null;
  }

  // --- Horario semanal recurrente ---

  app.get("/", async () => {
    const businessId = getBusinessId();
    if (!businessId) return [];
    return db
      .prepare("SELECT * FROM availability WHERE business_id = ? ORDER BY day_of_week, start_time")
      .all(businessId);
  });

  app.post("/", async (request, reply) => {
    const body = request.body as { day_of_week?: number; start_time?: string; end_time?: string };

    if (body.day_of_week === undefined || !body.start_time || !body.end_time) {
      return reply.status(400).send({ error: "day_of_week, start_time y end_time son obligatorios" });
    }
    if (body.day_of_week < 0 || body.day_of_week > 6) {
      return reply.status(400).send({ error: "day_of_week debe ser 0 (domingo) a 6 (sábado)" });
    }

    const businessId = getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const id = randomUUID();
    db.prepare(
      `INSERT INTO availability (id, business_id, day_of_week, start_time, end_time, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(id, businessId, body.day_of_week, body.start_time, body.end_time);

    return reply.status(201).send(db.prepare("SELECT * FROM availability WHERE id = ?").get(id));
  });

  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { start_time?: string; end_time?: string };

    const existing = db.prepare("SELECT * FROM availability WHERE id = ?").get(id) as any;
    if (!existing) return reply.status(404).send({ error: "Horario no encontrado" });

    db.prepare("UPDATE availability SET start_time = ?, end_time = ? WHERE id = ?").run(
      body.start_time ?? existing.start_time,
      body.end_time ?? existing.end_time,
      id
    );

    return db.prepare("SELECT * FROM availability WHERE id = ?").get(id);
  });

  app.patch("/:id/toggle-active", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare("SELECT * FROM availability WHERE id = ?").get(id) as { active: number } | undefined;
    if (!existing) return reply.status(404).send({ error: "Horario no encontrado" });

    const newActive = existing.active ? 0 : 1;
    db.prepare("UPDATE availability SET active = ? WHERE id = ?").run(newActive, id);
    return db.prepare("SELECT * FROM availability WHERE id = ?").get(id);
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare("SELECT * FROM availability WHERE id = ?").get(id);
    if (!existing) return reply.status(404).send({ error: "Horario no encontrado" });

    db.prepare("DELETE FROM availability WHERE id = ?").run(id);
    return reply.status(204).send();
  });

  // --- Excepciones puntuales (feriados, cierres, vacaciones) ---

  app.get("/exceptions", async () => {
    const businessId = getBusinessId();
    if (!businessId) return [];
    return db
      .prepare("SELECT * FROM availability_exception WHERE business_id = ? ORDER BY date")
      .all(businessId);
  });

  app.post("/exceptions", async (request, reply) => {
    const body = request.body as {
      date?: string;
      closed_all_day?: boolean;
      start_time?: string;
      end_time?: string;
      reason?: string;
    };

    if (!body.date) {
      return reply.status(400).send({ error: "date es obligatorio (formato YYYY-MM-DD)" });
    }

    const businessId = getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const id = randomUUID();
    const closedAllDay = body.closed_all_day === false ? 0 : 1;

    db.prepare(
      `INSERT INTO availability_exception (id, business_id, date, closed_all_day, start_time, end_time, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, businessId, body.date, closedAllDay, body.start_time ?? null, body.end_time ?? null, body.reason ?? null);

    return reply.status(201).send(db.prepare("SELECT * FROM availability_exception WHERE id = ?").get(id));
  });

  app.delete("/exceptions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare("SELECT * FROM availability_exception WHERE id = ?").get(id);
    if (!existing) return reply.status(404).send({ error: "Excepción no encontrada" });

    db.prepare("DELETE FROM availability_exception WHERE id = ?").run(id);
    return reply.status(204).send();
  });
}
