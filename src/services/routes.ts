import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";


export async function serviceRoutes(app: FastifyInstance) {
  async function getBusinessId(): Promise<string | null> {
    const { rows } = await pool.query("SELECT id FROM business LIMIT 1");
    return rows[0]?.id ?? null;
  }

  app.get("/", async () => {
    const businessId = await getBusinessId();
    if (!businessId) return [];
    const { rows } = await pool.query(
      "SELECT * FROM service WHERE business_id = $1 ORDER BY created_at",
      [businessId]
    );
    return rows;
  });

  app.post("/", async (request, reply) => {
    const body = request.body as { name?: string; duration_minutes?: number; price?: number };

    if (!body.name || !body.duration_minutes) {
      return reply.status(400).send({ error: "name y duration_minutes son obligatorios" });
    }

    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const id = randomUUID();
    await pool.query(
      `INSERT INTO service (id, business_id, name, duration_minutes, price, active)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [id, businessId, body.name, body.duration_minutes, body.price ?? null]
    );

    const { rows } = await pool.query("SELECT * FROM service WHERE id = $1", [id]);
    return reply.status(201).send(rows[0]);
  });

  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; duration_minutes?: number; price?: number };

    const existingRes = await pool.query("SELECT * FROM service WHERE id = $1", [id]);
    const existing = existingRes.rows[0];
    if (!existing) return reply.status(404).send({ error: "Servicio no encontrado" });

    await pool.query(
      "UPDATE service SET name = $1, duration_minutes = $2, price = $3 WHERE id = $4",
      [
        body.name ?? existing.name,
        body.duration_minutes ?? existing.duration_minutes,
        body.price !== undefined ? body.price : existing.price,
        id,
      ]
    );

    const { rows } = await pool.query("SELECT * FROM service WHERE id = $1", [id]);
    return rows[0];
  });

  app.patch("/:id/toggle-active", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existingRes = await pool.query("SELECT * FROM service WHERE id = $1", [id]);
    const existing = existingRes.rows[0];
    if (!existing) return reply.status(404).send({ error: "Servicio no encontrado" });

    const newActive = existing.active ? 0 : 1;
    await pool.query("UPDATE service SET active = $1 WHERE id = $2", [newActive, id]);

    const { rows } = await pool.query("SELECT * FROM service WHERE id = $1", [id]);
    return rows[0];
  });
}