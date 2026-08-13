import "dotenv/config";
import Fastify from "fastify";
import { appointmentRoutes } from "./appointments/routes.js";
import { serviceRoutes } from "./services/routes.js";
import { availabilityRoutes } from "./availability/routes.js";
import { customerRoutes } from "./customers/routes.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "kyrara-backend" }));
app.register(appointmentRoutes, { prefix: "/appointments" });
app.register(serviceRoutes, { prefix: "/services" });
app.register(availabilityRoutes, { prefix: "/availability" });
app.register(customerRoutes, { prefix: "/customers" });

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`Kyrara backend escuchando en el puerto ${port}`);
});