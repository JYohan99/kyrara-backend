import "dotenv/config";
import Fastify from "fastify";
import { appointmentRoutes } from "./appointments/routes.js";
import { serviceRoutes } from "./services/routes.js";
import { availabilityRoutes } from "./availability/routes.js";
import { customerRoutes } from "./customers/routes.js";
import { startWhatsApp } from "./whatsapp/connection.js";
import { startNotificationScheduler } from "./notifications/scheduler.js";

// ============================================================================
// INICIALIZACIÓN DEL SERVIDOR FASTIFY
// ============================================================================
const app = Fastify({ logger: true });

// Ruta de comprobación de estado de salud (Health check)
app.get("/health", async () => ({ status: "ok", service: "kyrara-backend" }));

// Registro de rutas modulares
app.register(appointmentRoutes, { prefix: "/appointments" });
app.register(serviceRoutes, { prefix: "/services" });
app.register(availabilityRoutes, { prefix: "/availability" });
app.register(customerRoutes, { prefix: "/customers" });

const port = Number(process.env.PORT ?? 3000);

// ============================================================================
// ARRANQUE DE SERVICIOS EN SEGUNDO PLANO
// ============================================================================

// Iniciar conexión y motor de WhatsApp Baileys
startWhatsApp();

// Iniciar temporizador de recordatorios de citas próximas (5 minutos antes)
startNotificationScheduler();

// Iniciar escucha del servidor HTTP
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`Kyrara backend escuchando en el puerto ${port}`);
});
