import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../database/connection.js";

export async function serviceRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const business = db.prepare("SELECT id FROM business LIMIT 1").get() as { id: string } | undefined;
    if (!business) return [];
    return db.prepare("SELECT * FROM service WHERE business_id = ? ORDER BY created_at").all(business.id);
  });

  app.post("/", async (request, reply) => {
    const body = request.body as { name?: string; duration_minutes?: number; price?: number };

    if (!body.name || !body.duration_minutes) {
      return reply.status(400).send({ error: "name y duration_minutes son obligatorios" });
    }

    const business = db.prepare("SELECT id FROM business LIMIT 1").get() as { id: string } | undefined;
    if (!business) return reply.status(400).send({ error: "No hay negocio cargado" });

    const id = randomUUID();
    db.prepare(
      `INSERT INTO service (id, business_id, name, duration_minutes, price, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(id, business.id, body.name, body.duration_minutes, body.price ?? null);

    const created = db.prepare("SELECT * FROM service WHERE id = ?").get(id);
    return reply.status(201).send(created);
  });

  // Editar nombre, duración o precio de un servicio existente
  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; duration_minutes?: number; price?: number };

    const existing = db.prepare("SELECT * FROM service WHERE id = ?").get(id);
    if (!existing) return reply.status(404).send({ error: "Servicio no encontrado" });

    db.prepare(
      `UPDATE service SET name = ?, duration_minutes = ?, price = ? WHERE id = ?`
    ).run(
      body.name ?? (existing as any).name,
      body.duration_minutes ?? (existing as any).duration_minutes,
      body.price !== undefined ? body.price : (existing as any).price,
      id
    );

    return db.prepare("SELECT * FROM service WHERE id = ?").get(id);
  });

  // Activar o desactivar un servicio sin borrarlo (para no perder el
  // historial de reservas que ya lo usaron)
  app.patch("/:id/toggle-active", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare("SELECT * FROM service WHERE id = ?").get(id) as { active: number } | undefined;

    if (!existing) return reply.status(404).send({ error: "Servicio no encontrado" });

    const newActive = existing.active ? 0 : 1;
    db.prepare("UPDATE service SET active = ? WHERE id = ?").run(newActive, id);

    return db.prepare("SELECT * FROM service WHERE id = ?").get(id);
  });
}