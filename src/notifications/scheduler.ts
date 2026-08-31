import { pool } from "../database/connection.js";
import { sendPushNotification } from "./firebase.js";

// ============================================================================
// UTILIDADES DE TIEMPO Y ZONA HORARIA
// ============================================================================

/**
 * Convierte un string de hora en formato "HH:mm" a minutos totales desde las 00:00.
 * Ejemplo: "14:30" -> 14 * 60 + 30 = 870 minutos.
 */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Obtiene la fecha actual en formato "YYYY-MM-DD" y los minutos transcurridos
 * en el día según la zona horaria del negocio.
 */
function getCurrentDateAndMinutes(timezone: string = "America/Montevideo"): {
  currentDate: string;
  currentMinutes: number;
} {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return {
      currentDate: `${year}-${month}-${day}`,
      currentMinutes: hour * 60 + minute,
    };
  } catch {
    const now = new Date();
    const currentDate = now.toISOString().slice(0, 10);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    return { currentDate, currentMinutes };
  }
}

// ============================================================================
// VERIFICACIÓN PERIÓDICA DE TURNOS PRÓXIMOS (5 MINUTOS ANTES)
// ============================================================================

/**
 * Revisa si existen citas confirmadas para hoy cuya hora de inicio sea en
 * los próximos 5 minutos y que aún no hayan sido notificadas al barbero.
 */
async function checkUpcomingAppointments() {
  try {
    // 1. Obtener la configuración del negocio
    const businessRes = await pool.query(
      "SELECT id, timezone, expo_push_token, notify_upcoming_appointments FROM business LIMIT 1"
    );
    const business = businessRes.rows[0];
    if (!business) return;

    // Si la opción de aviso 5 min antes está desactivada o no hay token registrado, omitir
    if (business.notify_upcoming_appointments === 0 || !business.expo_push_token) {
      return;
    }

    const { currentDate, currentMinutes } = getCurrentDateAndMinutes(business.timezone);

    // 2. Consultar citas confirmadas de hoy pendientes de aviso
    const appointmentsRes = await pool.query(
      `SELECT a.id, a.start_time, c.name as customer_name, s.name as service_name
       FROM appointment a
       JOIN customer c ON c.id = a.customer_id
       JOIN service s ON s.id = a.service_id
       WHERE a.business_id = $1 
         AND a.date = $2 
         AND a.status = 'CONFIRMED'
         AND (a.notified_upcoming IS NULL OR a.notified_upcoming = 0)`,
      [business.id, currentDate]
    );

    const appointments = appointmentsRes.rows;

    for (const app of appointments) {
      const appStartMinutes = timeToMinutes(app.start_time);
      const minutesRemaining = appStartMinutes - currentMinutes;

      // Si faltan entre 0 y 5 minutos para comenzar el turno
      if (minutesRemaining >= 0 && minutesRemaining <= 5) {
        const cliente = app.customer_name || "Cliente";
        const servicio = app.service_name || "Servicio";
        const title = "⏰ Próximo turno en 5 min";
        const body = `${cliente} — ${servicio} a las ${app.start_time}`;

        console.log(`[Scheduler] Enviando recordatorio 5 min para cita ${app.id} (${body})`);

        // Enviar notificación push directa al barbero
        await sendPushNotification(business.expo_push_token, title, body, {
          appointmentId: app.id,
          type: "UPCOMING_REMINDER",
        });

        // Marcar la cita como ya notificada para no duplicar avisos
        await pool.query(
          "UPDATE appointment SET notified_upcoming = 1 WHERE id = $1",
          [app.id]
        );
      }
    }
  } catch (err) {
    console.error("[Scheduler] Error al verificar citas próximas:", err);
  }
}

// ============================================================================
// INICIALIZADOR DEL TEMPORIZADOR EN SEGUNDO PLANO
// ============================================================================

/**
 * Inicia el intervalo en segundo plano para revisar las citas cada 30 segundos.
 */
export function startNotificationScheduler() {
  console.log("[Scheduler] Servicio de recordatorios de turnos (5 min antes) iniciado.");
  // Ejecución inicial inmediata
  checkUpcomingAppointments();
  // Revisión periódica cada 30 segundos
  setInterval(checkUpcomingAppointments, 30 * 1000);
}
