import makeWASocket, {
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationState,
} from "baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { pool } from "../database/connection.js";
import { handleIncomingMessage } from "./engine.js";

const logger = pino({ level: "silent" });

// Guarda la sesión de WhatsApp (equivalente a "dispositivos vinculados")
// directo en Postgres, en vez de en archivos locales — así sobrevive a
// cualquier redeploy en Render, igual que el resto de los datos.
async function usePostgresAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  async function readData(key: string) {
    const res = await pool.query("SELECT value FROM whatsapp_auth WHERE key = $1", [key]);
    if (!res.rows[0]) return null;
    return JSON.parse(res.rows[0].value, BufferJSON.reviver);
  }
  async function writeData(key: string, data: any) {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await pool.query(
      `INSERT INTO whatsapp_auth (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    );
  }
  async function removeData(key: string) {
    await pool.query("DELETE FROM whatsapp_auth WHERE key = $1", [key]);
  }

  const storedCreds = await readData("creds");
  const creds = storedCreds ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: any } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in (data as any)[category]) {
              const value = (data as any)[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData("creds", creds);
    },
  };
}

export async function startWhatsApp() {
  const { state, saveCreds } = await usePostgresAuthState();

  const sock = makeWASocket({
    auth: state,
    logger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nEscaneá este código QR con WhatsApp (Dispositivos vinculados) en el teléfono del negocio:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        "Conexión de WhatsApp cerrada.",
        shouldReconnect ? "Reintentando..." : "Sesión cerrada, hay que volver a escanear el QR."
      );
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("✅ WhatsApp conectado correctamente.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid!;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    console.log(`📩 Mensaje de ${from}: "${text}"`);

    try {
      await handleIncomingMessage(sock, from, text);
    } catch (err) {
      console.error("Error procesando mensaje de WhatsApp:", err);
      await sock.sendMessage(from, { text: "Uy, tuvimos un problema. Probá de nuevo en un rato." });
    }
  });

  return sock;
}