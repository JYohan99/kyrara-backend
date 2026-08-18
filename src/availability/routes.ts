import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";

export async function availabilityRoutes(app: FastifyInstance) {
  async function getBusinessId(): Promise<string | null> {
    const { rows } = await pool.query("SELECT id FROM business LIMIT 1");
    return rows[0]?.id ?? null;
  }

  app.get("/", async () => {
    const businessId = await getBusinessId();
    if (!businessId) return [];
    const { rows } = await pool.query(
      "SELECT * FROM availability WHERE business_id = $1 ORDER BY day_of_week, start_time",
      [businessId]
    );
    return rows;
  });

  app.post("/", async (request, reply) => {
    const body = request.body as { day_of_week?: number; start_time?: string; end_time?: string };

    if (body.day_of_week === undefined || !body.start_time || !body.end_time) {
      return reply.status(400).send({ error: "day_of_week, start_time y end_time son obligatorios" });
    }
    if (body.day_of_week < 0 || body.day_of_week > 6) {
      return reply.status(400).send({ error: "day_of_week debe ser 0 (domingo) a 6 (sábado)" });
    }

    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const id = randomUUID();
    await pool.query(
      `INSERT INTO availability (id, business_id, day_of_week, start_time, end_time, active)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [id, businessId, body.day_of_week, body.start_time, body.end_time]
    );

    const { rows } = await pool.query("SELECT * FROM availability WHERE id = $1", [id]);
    return reply.status(201).send(rows[0]);
  });

  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { start_time?: string; end_time?: string };

    const existingRes = await pool.query("SELECT * FROM availability WHERE id = $1", [id]);
    const existing = existingRes.rows[0];
    if (!existing) return reply.status(404).send({ error: "Horario no encontrado" });

    await pool.query(
      "UPDATE availability SET start_time = $1, end_time = $2 WHERE id = $3",
      [body.start_time ?? existing.start_time, body.end_time ?? existing.end_time, id]
    );

    const { rows } = await pool.query("SELECT * FROM availability WHERE id = $1", [id]);
    return rows[0];
  });

  app.patch("/:id/toggle-active", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existingRes = await pool.query("SELECT * FROM availability WHERE id = $1", [id]);
    const existing = existingRes.rows[0];
    if (!existing) return reply.status(404).send({ error: "Horario no encontrado" });

    const newActive = existing.active ? 0 : 1;
    await pool.query("UPDATE availability SET active = $1 WHERE id = $2", [newActive, id]);

    const { rows } = await pool.query("SELECT * FROM availability WHERE id = $1", [id]);
    return rows[0];
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existingRes = await pool.query("SELECT * FROM availability WHERE id = $1", [id]);
    if (!existingRes.rows[0]) return reply.status(404).send({ error: "Horario no encontrado" });

    await pool.query("DELETE FROM availability WHERE id = $1", [id]);
    return reply.status(204).send();
  });

  app.get("/exceptions", async () => {
    const businessId = await getBusinessId();
    if (!businessId) return [];
    const { rows } = await pool.query(
      "SELECT * FROM availability_exception WHERE business_id = $1 ORDER BY date",
      [businessId]
    );
    return rows;
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

    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const id = randomUUID();
    const closedAllDay = body.closed_all_day === false ? 0 : 1;

    await pool.query(
      `INSERT INTO availability_exception (id, business_id, date, closed_all_day, start_time, end_time, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, businessId, body.date, closedAllDay, body.start_time ?? null, body.end_time ?? null, body.reason ?? null]
    );

    const { rows } = await pool.query("SELECT * FROM availability_exception WHERE id = $1", [id]);
    return reply.status(201).send(rows[0]);
  });

  app.delete("/exceptions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existingRes = await pool.query("SELECT * FROM availability_exception WHERE id = $1", [id]);
    if (!existingRes.rows[0]) return reply.status(404).send({ error: "Excepción no encontrada" });

    await pool.query("DELETE FROM availability_exception WHERE id = $1", [id]);
    return reply.status(204).send();
  });
}