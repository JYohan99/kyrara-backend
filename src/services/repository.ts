import { pool } from "../database/connection.js";
import { Service } from "./models.js";

export async function findServicesByBusinessId(businessId: string): Promise<Service[]> {
  const { rows } = await pool.query(
    "SELECT * FROM service WHERE business_id = $1 AND (is_deleted = 0 OR is_deleted IS NULL) ORDER BY created_at",
    [businessId]
  );
  return rows;
}

export async function findActiveServicesByBusinessId(businessId: string): Promise<Service[]> {
  const { rows } = await pool.query(
    "SELECT * FROM service WHERE business_id = $1 AND active = 1 AND (is_deleted = 0 OR is_deleted IS NULL) ORDER BY created_at",
    [businessId]
  );
  return rows;
}

export async function findServiceById(id: string): Promise<Service | null> {
  const { rows } = await pool.query("SELECT * FROM service WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function insertService(data: {
  id: string;
  businessId: string;
  name: string;
  duration_minutes: number;
  price?: number | null;
}): Promise<Service> {
  await pool.query(
    `INSERT INTO service (id, business_id, name, duration_minutes, price, active)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [data.id, data.businessId, data.name, data.duration_minutes, data.price ?? null]
  );
  const service = await findServiceById(data.id);
  if (!service) throw new Error("Error creando servicio");
  return service;
}

export async function updateServiceRecord(
  id: string,
  data: { name: string; duration_minutes: number; price?: number | null }
): Promise<Service> {
  await pool.query(
    "UPDATE service SET name = $1, duration_minutes = $2, price = $3 WHERE id = $4",
    [data.name, data.duration_minutes, data.price !== undefined ? data.price : null, id]
  );
  const service = await findServiceById(id);
  if (!service) throw new Error("Servicio no encontrado");
  return service;
}

export async function toggleServiceActiveRecord(id: string, newActive: number): Promise<Service> {
  await pool.query("UPDATE service SET active = $1 WHERE id = $2", [newActive, id]);
  const service = await findServiceById(id);
  if (!service) throw new Error("Servicio no encontrado");
  return service;
}

export async function deleteServiceRecord(id: string): Promise<void> {
  const check = await pool.query(
    "SELECT COUNT(*)::int as count FROM appointment WHERE service_id = $1",
    [id]
  );
  const count = check.rows[0]?.count ?? 0;
  if (count > 0) {
    await pool.query(
      "UPDATE service SET is_deleted = 1, active = 0 WHERE id = $1",
      [id]
    );
  } else {
    await pool.query("DELETE FROM service WHERE id = $1", [id]);
  }
}
