import webpush from "web-push";

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
    console.log("[WebPush] No hay suscripción de navegador registrada en la base de datos.");
    return null;
  }

  let subscription: webpush.PushSubscription;
  try {
    subscription =
      typeof subscriptionRaw === "string"
        ? JSON.parse(subscriptionRaw)
        : subscriptionRaw;
  } catch (err) {
    console.error("[WebPush] Error parseando la suscripción JSON:", err);
    return null;
  }

  if (!subscription || !subscription.endpoint) {
    console.warn("[WebPush] Suscripción inválida (falta endpoint).");
    return null;
  }

  const payload = JSON.stringify({
    title,
    body,
    icon: "/assets/images/icon.png",
    badge: "/assets/images/icon.png",
    data: {
      url: "/",
      ...extraData,
    },
  });

  try {
    const response = await webpush.sendNotification(subscription, payload);
    console.log(`[WebPush] Notificación enviada con éxito (status ${response.statusCode})`);
    return response;
  } catch (err: any) {
    console.error("[WebPush] Error enviando notificación web push:", err?.message || err);
    // Si la suscripción expiró o fue desuscrita en el navegador (HTTP 410 o 404)
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.warn("[WebPush] La suscripción ha expirado en el dispositivo del usuario.");
    }
    return null;
  }
}
