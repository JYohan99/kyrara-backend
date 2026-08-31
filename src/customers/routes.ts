import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";

export async function customerRoutes(app: FastifyInstance) {
  async function getBusinessId(): Promise<string | null> {
    const { rows } = await pool.query("SELECT id FROM business LIMIT 1");
    return rows[0]?.id ?? null;
  }

  app.get("/", async (request) => {
    const { search } = request.query as { search?: string };
    const businessId = await getBusinessId();
    if (!businessId) return [];

    if (search) {
      const like = `%${search}%`;
      const { rows } = await pool.query(
        `SELECT * FROM customer WHERE business_id = $1 AND active = 1 AND (name ILIKE $2 OR phone ILIKE $2) ORDER BY name`,
        [businessId, like]
      );
      return rows;
    }

    const { rows } = await pool.query(
      "SELECT * FROM customer WHERE business_id = $1 AND active = 1 ORDER BY name",
      [businessId]
    );
    return rows;
  });

  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const customerRes = await pool.query("SELECT * FROM customer WHERE id = $1", [id]);
    const customer = customerRes.rows[0];
    if (!customer) return reply.status(404).send({ error: "Cliente no encontrado" });

    const appointmentsRes = await pool.query(
      `SELECT a.*, s.name as service_name FROM appointment a
       JOIN service s ON s.id = a.service_id
       WHERE a.customer_id = $1 ORDER BY a.date DESC, a.start_time DESC`,
      [id]
    );

    return { ...customer, appointments: appointmentsRes.rows };
  });

  app.post("/", async (request, reply) => {
    const body = request.body as { name?: string; phone?: string; notes?: string };

    if (!body.phone) {
      return reply.status(400).send({ error: "phone es obligatorio" });
    }

    const businessId = await getBusinessId();
    if (!businessId) return reply.status(400).send({ error: "No hay negocio cargado" });

        const existingRes = await pool.query(
      "SELECT id, active FROM customer WHERE business_id = $1 AND phone = $2",
      [businessId, body.phone]
    );
    if (existingRes.rows[0]) {
      if (existingRes.rows[0].active === 0) {
        // Si el cliente estaba eliminado, lo reactivamos con los datos ingresados
        await pool.query(
          "UPDATE customer SET active = 1, name = COALESCE($1, name), notes = COALESCE($2, notes) WHERE id = $3",
          [body.name ?? null, body.notes ?? null, existingRes.rows[0].id]
        );
        const { rows } = await pool.query("SELECT * FROM customer WHERE id = $1", [existingRes.rows[0].id]);
        return reply.status(200).send(rows[0]);
      }
      return reply.status(409).send({ error: "Ya existe un cliente con ese teléfono" });
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO customer (id, business_id, name, phone, notes) VALUES ($1, $2, $3, $4, $5)`,
      [id, businessId, body.name ?? null, body.phone, body.notes ?? null]
    );

    const { rows } = await pool.query("SELECT * FROM customer WHERE id = $1", [id]);
    return reply.status(201).send(rows[0]);
  });

  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; phone?: string; notes?: string };

    const existingRes = await pool.query("SELECT * FROM customer WHERE id = $1", [id]);
    const existing = existingRes.rows[0];
    if (!existing) return reply.status(404).send({ error: "Cliente no encontrado" });

    await pool.query(
      "UPDATE customer SET name = $1, phone = $2, notes = $3 WHERE id = $4",
      [
        body.name ?? existing.name,
        body.phone ?? existing.phone,
        body.notes !== undefined ? body.notes : existing.notes,
        id,
      ]
    );

    const { rows } = await pool.query("SELECT * FROM customer WHERE id = $1", [id]);
    return rows[0];
  });

  // Borrado suave: no elimina la fila (preserva el historial de reservas
  // asociadas), solo lo marca como inactivo y deja de aparecer en el listado.
  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existingRes = await pool.query("SELECT * FROM customer WHERE id = $1", [id]);
    if (!existingRes.rows[0]) return reply.status(404).send({ error: "Cliente no encontrado" });

    await pool.query("UPDATE customer SET active = 0 WHERE id = $1", [id]);
    return reply.status(204).send();
  });
}