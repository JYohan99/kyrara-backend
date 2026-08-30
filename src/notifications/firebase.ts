import admin from "firebase-admin";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;

  const keyPath = path.resolve(__dirname, "../../firebase-service-account.json");
  if (fs.existsSync(keyPath)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      firebaseInitialized = true;
      console.log("Firebase Admin SDK inicializado correctamente con credenciales.");
    } catch (err) {
      console.error("Error al inicializar Firebase Admin:", err);
    }
  } else {
    console.warn("No se encontró firebase-service-account.json en el backend.");
  }
}

initFirebase();

export async function sendPushNotification(
  token: string | null | undefined,
  title: string,
  body: string,
  data: Record<string, string> = {}
) {
  if (!token) {
    console.log("No hay token de notificación registrado para enviar push.");
    return;
  }

  // 1. Si es un token nativo de Firebase (FCM)
  if (!token.startsWith("ExponentPushToken[")) {
    if (!firebaseInitialized) {
      initFirebase();
    }

    try {
      const response = await admin.messaging().send({
        token,
        notification: {
          title,
          body,
        },
        data,
        android: {
          priority: "high",
          notification: {
            sound: "default",
            channelId: "default",
            priority: "max",
          },
        },
      });
      console.log("Notificación push enviada exitosamente vía Firebase FCM:", response);
      return response;
    } catch (err) {
      console.error("Error enviando push por Firebase FCM:", err);
    }
  }

  // 2. Si es un token de Expo (Fallback)
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ to: token, title, body, sound: "default", data }),
    });
    console.log("Notificación push enviada vía Expo Push API, status:", res.status);
  } catch (err) {
    console.error("Error enviando push por Expo API:", err);
  }
}