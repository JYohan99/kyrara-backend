import makeWASocket, {
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto,
  Browsers,
  type AuthenticationState,
  type WASocket,
} from "baileys";
import { Boom } from "@hapi/boom";
import qrcodeTerminal from "qrcode-terminal";
import pino from "pino";
import { pool } from "../database/connection.js";
import { handleIncomingMessage } from "./engine.js";

const logger = pino({ level: "silent" });

let currentSock: WASocket | null = null;
let latestQR: string | null = null;
let connectionStatus: "open" | "connecting" | "close" = "connecting";
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// PERSISTENCIA DE CREDENCIALES EN POSTGRES
// ============================================================================
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
  let creds = storedCreds;

  // Si no está registrado y tenía un intento previo fallido, limpiar credenciales intermedias
  if (creds && !creds.registered && creds.me) {
    delete creds.me;
    delete creds.pairingCode;
  }
  if (!creds) {
    creds = initAuthCreds();
  }

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

// ============================================================================
// FUNCIONES PÚBLICAS DE ESTADO Y VINCULACIÓN
// ============================================================================

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    isRegistered: currentSock?.authState?.creds?.registered ?? false,
    hasQR: Boolean(latestQR),
    qr: latestQR,
  };
}

export async function requestPairingCode(phoneNumber: string): Promise<string> {
  let cleanNumber = phoneNumber.replace(/[^0-9]/g, "");

  // Auto-formateo inteligente para números de Uruguay:
  // Si empieza con 09 (ej. 093927667, 9 dígitos): convertir a 59893927667
  if (cleanNumber.startsWith("09") && cleanNumber.length === 9) {
    cleanNumber = "598" + cleanNumber.slice(1);
  } else if (cleanNumber.startsWith("9") && cleanNumber.length === 8) {
    // Si escribió 93927667 (8 dígitos sin el 0 ni el 598): convertir a 59893927667
    cleanNumber = "598" + cleanNumber;
  }

  if (cleanNumber.length < 10) {
    throw new Error(
      `Número inválido (${cleanNumber}). Asegúrate de ingresar el número completo con código de país (ej. 59893927667).`
    );
  }

  // Si el socket está cerrado o no existe, reiniciar
  if (!currentSock || connectionStatus === "close") {
    console.log("Socket desconectado, reiniciando antes de pedir pairing code...");
    await startWhatsApp();
  }

  // Esperar hasta que el socket esté conectado y emitiendo handshake
  let attempts = 0;
  while (!latestQR && connectionStatus !== "open" && attempts < 30) {
    await new Promise((r) => setTimeout(r, 500));
    attempts++;
  }

  if (!currentSock || connectionStatus === "close") {
    throw new Error("El socket de WhatsApp no pudo conectar. Presiona de nuevo el botón.");
  }

  if (currentSock.authState?.creds?.registered) {
    throw new Error("WhatsApp ya se encuentra vinculado y conectado.");
  }

  console.log(`Solicitando código de vinculación para ${cleanNumber}...`);
  const code = await currentSock.requestPairingCode(cleanNumber);
  console.log(`✅ Código de vinculación obtenido: ${code}`);
  return code;
}

export async function restartWhatsApp() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (currentSock) {
    try {
      currentSock.end(undefined);
    } catch {}
  }
  latestQR = null;
  connectionStatus = "connecting";
  return startWhatsApp();
}

export async function logoutWhatsApp() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (currentSock) {
    try {
      await currentSock.logout();
    } catch {}
  }
  await pool.query("DELETE FROM whatsapp_auth");
  latestQR = null;
  connectionStatus = "close";
  return startWhatsApp();
}

// ============================================================================
// ARRANQUE PRINCIPAL DEL SOCKET DE WHATSAPP
// ============================================================================

export async function startWhatsApp() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  const { state, saveCreds } = await usePostgresAuthState();

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  currentSock = sock;
  connectionStatus = "connecting";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      console.log("\nEscaneá este código QR con WhatsApp (Dispositivos vinculados) en el teléfono del negocio:\n");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      connectionStatus = "close";
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `Conexión de WhatsApp cerrada (status: ${statusCode}).`,
        isLoggedOut ? "Sesión desvinculada." : "Reintentando reconexión en 3 segundos..."
      );

      latestQR = null;

      if (isLoggedOut) {
        pool.query("DELETE FROM whatsapp_auth").catch(() => {});
      }

      if (!reconnectTimeout) {
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          startWhatsApp();
        }, 3000);
      }
    } else if (connection === "open") {
      connectionStatus = "open";
      latestQR = null;
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

/**
 * Retorna la instancia activa del socket de WhatsApp si está conectado.
 */
export function getWhatsAppSocket(): WASocket | null {
  return currentSock;
}

/**
 * Envía un mensaje directo al número personal de WhatsApp del barbero.
 */
export async function sendBarberWhatsAppAlert(phone: string | null | undefined, text: string): Promise<boolean> {
  if (!phone || !currentSock || connectionStatus !== "open") {
    return false;
  }

  try {
    const cleanNumber = phone.replace(/[^0-9]/g, "");
    if (!cleanNumber) return false;

    const barberJid = `${cleanNumber}@s.whatsapp.net`;
    await currentSock.sendMessage(barberJid, { text });
    console.log(`[WhatsApp Alert] Notificación enviada al barbero (${barberJid})`);
    return true;
  } catch (err) {
    console.error("[WhatsApp Alert] Error enviando alerta al barbero:", err);
    return false;
  }
}