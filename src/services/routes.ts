import type { FastifyInstance } from "fastify";
import { CreateServiceInput, UpdateServiceInput } from "./models.js";
import {
  createService,
  deleteService,
  listServices,
  toggleService,
  updateService,
} from "./service.js";

export async function serviceRoutes(app: FastifyInstance) {
  // GET /services -> Listar todos los servicios del catálogo
  app.get("/", async () => {
    return listServices();
  });

  // POST /services -> Crear un nuevo servicio
  app.post("/", async (request, reply) => {
    const body = request.body as CreateServiceInput;
    try {
      const created = await createService(body);
      return reply.status(201).send(created);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // PUT /services/:id -> Modificar un servicio existente
  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateServiceInput;
    try {
      return await updateService(id, body);
    } catch (err: any) {
      const status = err.message === "Servicio no encontrado" ? 404 : 400;
      return reply.status(status).send({ error: err.message });
    }
  });

  // PATCH /services/:id/toggle-active -> Activar o desactivar un servicio
  app.patch("/:id/toggle-active", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await toggleService(id);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  // DELETE /services/:id -> Eliminar un servicio
  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteService(id);
      return { success: true, id };
    } catch (err: any) {
      const status = err.message === "Servicio no encontrado" ? 404 : 400;
      return reply.status(status).send({ error: err.message });
    }
  });
}