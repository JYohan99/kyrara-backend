import webpush from "web-push";
import { pool } from "../database/connection.js";

const DEFAULT_VAPID_PUBLIC = "BF3u91cF8g9rd45fQLnk7rLcpgJytgAmX5Oht6aKYY2iNPcyBvEZ6J_bQl96sU7PVd2lydMrcQl7gUTIYK1wLbE";
const DEFAULT_VAPID_PRIVATE = "EWqRHYNuJ1HQgZytua6fmzGjGgnaFipvOayn1694lZ8";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@kyrara.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log("Web Push (VAPID) inicializado correctamente.");
  } catch (err) {
    console.error("Error al configurar VAPID en web-push:", err);
  }
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export async function sendWebPushNotification(
  subscriptionRaw: string | object | null | undefined,
  title: string,
  body: string,
  extraData: Record<string, any> = {}
) {
  if (!subscriptionRaw) {
    console.log("[WebPush] No hay suscripciones de navegador registradas en la base de datos.");
    return null;
  }

  let subsList: webpush.PushSubscription[] = [];
  try {
    const parsed =
      typeof subscriptionRaw === "string"
        ? JSON.parse(subscriptionRaw)
        : subscriptionRaw;

    if (Array.isArray(parsed)) {
      subsList = parsed.filter((s) => s && s.endpoint);
    } else if (parsed && parsed.endpoint) {
      subsList = [parsed];
    }
  } catch (err) {
    console.error("[WebPush] Error parseando la suscripción JSON:", err);
    return null;
  }

  if (subsList.length === 0) {
    console.warn("[WebPush] No se encontraron suscripciones válidas en el registro.");
    return null;
  }

  const payload = JSON.stringify({
    title,
    body,
    icon: "/icon.png",
    badge: "/icon.png",
    data: {
      url: "/",
      ...extraData,
    },
  });

  const options: webpush.RequestOptions = {
    TTL: 3600,
    urgency: "high",
  };

  let successCount = 0;
  const expiredEndpoints: string[] = [];

  for (const sub of subsList) {
    try {
      const response = await webpush.sendNotification(sub, payload, options);
      console.log(`[WebPush] Notificación enviada con éxito a ${sub.endpoint.slice(0, 40)}... (status ${response.statusCode})`);
      successCount++;
    } catch (err: any) {
      console.error(`[WebPush] Error enviando a ${sub.endpoint.slice(0, 40)}...:`, err?.message || err);
      // HTTP 410 (Gone) o 404 (Not Found) indican que el dispositivo revocó permisos o desinstaló
      if (err.statusCode === 410 || err.statusCode === 404) {
        expiredEndpoints.push(sub.endpoint);
      }
    }
  }

  // Si algún dispositivo expiró, eliminarlo automáticamente para mantener la base de datos limpia
  if (expiredEndpoints.length > 0) {
    try {
      const cleanList = subsList.filter((s) => !expiredEndpoints.includes(s.endpoint));
      await pool.query(
        "UPDATE business SET web_push_subscription = $1 WHERE web_push_subscription IS NOT NULL",
        [cleanList.length > 0 ? JSON.stringify(cleanList) : null]
      );
      console.log(`[WebPush] Se purgaron ${expiredEndpoints.length} suscripciones inactivas/expiradas.`);
    } catch (e) {
      console.warn("[WebPush] Error al purgar suscripciones expiradas:", e);
    }
  }

  return successCount > 0 ? { success: true, count: successCount } : null;
}
