import type { FastifyInstance } from "fastify";
import { db } from "../database/connection.js";

export async function appointmentRoutes(app: FastifyInstance) {
  // Endpoint de prueba: devuelve el negocio piloto y sus servicios.
  app.get("/business", async () => {
    const business = db.prepare("SELECT * FROM business LIMIT 1").get();
    if (!business) return { error: "No hay negocio cargado todavía" };

    const services = db
      .prepare("SELECT * FROM service WHERE business_id = ?")
      .all((business as any).id);

    return { business, services };
  });
}