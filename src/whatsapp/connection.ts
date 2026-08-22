import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";

const logger = pino({ level: "silent" }); // silenciamos los logs internos de Baileys, muy verborrágicos

export async function startWhatsApp() {
  // Guarda la sesión (las "credenciales del dispositivo vinculado") en esta carpeta,
  // así no hay que escanear el QR cada vez que reiniciamos el servidor.
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

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
      console.log("Conexión de WhatsApp cerrada.", shouldReconnect ? "Reintentando..." : "Sesión cerrada, hay que volver a escanear el QR.");
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("✅ WhatsApp conectado correctamente.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return; // ignoramos mensajes propios y notificaciones vacías

    const from = msg.key.remoteJid!;
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    console.log(`📩 Mensaje de ${from}: "${text}"`);

    // Por ahora, solo respondemos con un eco para confirmar que la conexión funciona.
    // En el próximo paso acá va a ir la lógica real del flujo de reservas.
    await sock.sendMessage(from, { text: `Recibí tu mensaje: "${text}"` });
  });

  return sock;
}