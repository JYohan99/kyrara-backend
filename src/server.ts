import "dotenv/config";
import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "kyrara-backend" }));

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`Kyrara backend escuchando en el puerto ${port}`);
});