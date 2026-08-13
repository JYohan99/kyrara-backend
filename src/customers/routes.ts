import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../database/connection.js";

export async function customerRoutes(app: FastifyInstance) {
  function getBusinessId(): string | null {
    const business = db.prepare("SELECT id FROM business LIMIT 1").get() as { id: string } | undefined;
    return business?.id ?? null;
  }

  // Lista todos los clientes, con búsqueda opcional por nombre o teléfono:
  // GET /customers?search=carlos
  app.get("/", async (request) => {
    const { search } = request.query as { search?: string };
    const businessId = getBusinessId();
    if (!businessId) return [];

    if (search) {
      const like = `%${search}%`;
      return db
        .prepare(
          `SELECT * FROM customer WHERE business_id = ? AND (name LIKE ? OR phone LIKE ?) ORDER BY name`
        )
        .all(businessId, like, like);
    }

    return db.prepare("SELECT * FROM customer WHERE business_id = ? ORDER BY name").all(businessId);
  });

  // Detalle de un cliente + su historial básico de reservas
  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const customer = db.prepare("SELECT * FROM customer WHERE id = ?").get(id);
    if (!customer) return reply.status(404).send({ error: "Cliente no encontrado" });

    const appointments = db
      .prepare(
        `SELECT a.*, s.name as service_name FROM appointment a
         JOIN service s ON s.id = a.service_id
         WHERE a.customer_id = ? ORDER BY a.date DESC, a.start_time DESC`
      )
      .all(id);

    return { ...customer, appointments };
  });

  app.post("/", async (request, reply) => {
    const body = request.body as { name?: string; phone?: string; notes?: string };

    if (!body.phone) {
      return reply.status(400).send({ error: "phone es obligatorio" });
    }

    const businessId = getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

    const existing = db
      .prepare("SELECT id FROM customer WHERE business_id = ? AND phone = ?")
      .get(businessId, body.phone);
    if (existing) {
      return reply.status(409).send({ error: "Ya existe un cliente con ese teléfono" });
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO customer (id, business_id, name, phone, notes) VALUES (?, ?, ?, ?, ?)`
    ).run(id, businessId, body.name ?? null, body.phone, body.notes ?? null);

    return reply.status(201).send(db.prepare("SELECT * FROM customer WHERE id = ?").get(id));
  });

  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; phone?: string; notes?: string };

    const existing = db.prepare("SELECT * FROM customer WHERE id = ?").get(id) as any;
    if (!existing) return reply.status(404).send({ error: "Cliente no encontrado" });

    db.prepare("UPDATE customer SET name = ?, phone = ?, notes = ? WHERE id = ?").run(
      body.name ?? existing.name,
      body.phone ?? existing.phone,
      body.notes !== undefined ? body.notes : existing.notes,
      id
    );

    return db.prepare("SELECT * FROM customer WHERE id = ?").get(id);
  });
}