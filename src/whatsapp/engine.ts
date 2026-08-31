import { sendPushNotification } from "../notifications/firebase.js";
import type { WASocket } from "baileys";
import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";

// ============================================================================
// SECCIÓN 1: UTILIDADES AUXILIARES (WHATSAPP, TIEMPO, FECHAS Y TEXTO)
// ============================================================================

/**
 * Extrae el identificador LID único de WhatsApp para esta conversación.
 */
function extractLid(jid: string): string {
  return jid.split("@")[0];
}

/**
 * Convierte un string "HH:mm" a minutos totales desde las 00:00.
 */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Convierte minutos totales a string con formato "HH:mm".
 */
function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Obtiene el índice del día de la semana (0 = Domingo ... 6 = Sábado).
 */
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Obtiene la fecha actual ("YYYY-MM-DD") y la hora actual en minutos para la zona horaria del negocio.
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

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * Suma N días a una fecha en formato "YYYY-MM-DD".
 */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Genera el texto legible para una opción de día (ej: "Hoy (Lunes 31/08)", "Mañana (Martes 01/09)").
 */
function formatDateOption(dateStr: string, currentDate: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const label = `${weekday} ${d.toString().padStart(2, "0")}/${m.toString().padStart(2, "0")}`;
  if (dateStr === currentDate) return `Hoy (${label})`;
  if (dateStr === addDays(currentDate, 1)) return `Mañana (${label})`;
  return label;
}

/**
 * Formatea una fecha completa para la confirmación (ej: "Lunes 31 de agosto").
 */
function formatFullDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} de ${MESES[m - 1]}`;
}

// ============================================================================
// SECCIÓN 2: CONSULTAS Y GESTIÓN DE CLIENTES Y CONVERSACIONES
// ============================================================================

/**
 * Obtiene la información general del negocio.
 */
async function getBusiness() {
  const { rows } = await pool.query("SELECT * FROM business LIMIT 1");
  return rows[0];
}

/**
 * Busca o crea un cliente en la base de datos a partir de su ID de WhatsApp (LID).
 */
async function getOrCreateCustomer(businessId: string, lid: string) {
  const existing = await pool.query(
    "SELECT * FROM customer WHERE business_id = $1 AND whatsapp_lid = $2",
    [businessId, lid]
  );
  if (existing.rows[0]) return existing.rows[0];

  const id = randomUUID();
  await pool.query("INSERT INTO customer (id, business_id, whatsapp_lid) VALUES ($1, $2, $3)", [
    id,
    businessId,
    lid,
  ]);
  const { rows } = await pool.query("SELECT * FROM customer WHERE id = $1", [id]);
  return rows[0];
}

/**
 * Busca o inicializa el estado de la conversación con el cliente.
 */
async function getOrCreateConversation(customerId: string) {
  const existing = await pool.query("SELECT * FROM conversation WHERE customer_id = $1", [customerId]);
  if (existing.rows[0]) return existing.rows[0];

  const id = randomUUID();
  await pool.query(
    "INSERT INTO conversation (id, customer_id, state, data) VALUES ($1, $2, 'START', '{}')",
    [id, customerId]
  );
  const { rows } = await pool.query("SELECT * FROM conversation WHERE id = $1", [id]);
  return rows[0];
}

/**
 * Actualiza el estado y datos temporales de la conversación en PostgreSQL.
 */
async function updateConversation(id: string, state: string, data: any) {
  await pool.query("UPDATE conversation SET state = $1, data = $2, updated_at = NOW() WHERE id = $3", [
    state,
    JSON.stringify(data),
    id,
  ]);
}

/**
 * Envía una notificación push directa al teléfono del barbero vía Firebase FCM.
 */
async function sendBarberPushNotification(expoPushToken: string | null, title: string, body: string) {
  await sendPushNotification(expoPushToken, title, body);
}

// ============================================================================
// SECCIÓN 3: CÁLCULO Y FILTRADO DE HORARIOS DISPONIBLES (SLOTS)
// ============================================================================

/**
 * Calcula los turnos libres para una fecha y servicio determinados.
 * Descarta automáticamente turnos pasados del día de hoy y horarios ocupados.
 */
async function getAvailableSlots(businessId: string, date: string, serviceId: string, timezone: string = "America/Montevideo"): Promise<string[]> {
  const { currentDate, currentMinutes } = getCurrentDateAndMinutes(timezone);

  // Si la fecha ya pasó respecto a hoy, no hay disponibilidad
  if (date < currentDate) return [];

  const businessRes = await pool.query("SELECT slot_step_minutes FROM business WHERE id = $1", [businessId]);
  const STEP = businessRes.rows[0]?.slot_step_minutes ?? 30;

  const serviceRes = await pool.query("SELECT * FROM service WHERE id = $1 AND active = 1", [serviceId]);
  const service = serviceRes.rows[0];
  if (!service) return [];

  // Excepciones (días cerrados o bloqueos parciales)
  const exceptionsRes = await pool.query(
    "SELECT * FROM availability_exception WHERE business_id = $1 AND date = $2",
    [businessId, date]
  );
  const exceptions = exceptionsRes.rows;
  if (exceptions.some((e: any) => e.closed_all_day)) return [];

  // Ventanas de horario del día de la semana
  const dow = dayOfWeek(date);
  const windowsRes = await pool.query(
    "SELECT * FROM availability WHERE business_id = $1 AND day_of_week = $2 AND active = 1",
    [businessId, dow]
  );
  const windows = windowsRes.rows;
  if (windows.length === 0) return [];

  // Citas ya reservadas y activas
  const busyRes = await pool.query(
    `SELECT start_time, end_time FROM appointment WHERE business_id = $1 AND date = $2 AND status != 'CANCELLED'`,
    [businessId, date]
  );
  const busy = busyRes.rows;

  const blocked = [
    ...busy.map((b: any) => ({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) })),
    ...exceptions
      .filter((e: any) => !e.closed_all_day && e.start_time && e.end_time)
      .map((e: any) => ({ start: timeToMinutes(e.start_time), end: timeToMinutes(e.end_time) })),
  ];

  const duration = service.duration_minutes;
  const slots: string[] = [];
  const isToday = date === currentDate;

  for (const w of windows) {
    const windowStart = timeToMinutes(w.start_time);
    const windowEnd = timeToMinutes(w.end_time);
    for (let start = windowStart; start + duration <= windowEnd; start += STEP) {
      // Filtrar horarios que ya pasaron hoy
      if (isToday && start <= currentMinutes) {
        continue;
      }

      const end = start + duration;
      const overlaps = blocked.some((b) => start < b.end && end > b.start);
      if (!overlaps) slots.push(minutesToTime(start));
    }
  }
  return slots;
}

// ============================================================================
// SECCIÓN 4: MOTOR DE CONVERSACIÓN Y MÁQUINA DE ESTADOS DE WHATSAPP
// ============================================================================

/**
 * Procesa cada mensaje entrante de WhatsApp y avanza el flujo de reserva.
 */
export async function handleIncomingMessage(sock: WASocket, from: string, text: string) {
  const business = await getBusiness();
  if (!business) return;

  const lid = extractLid(from);
  const customer = await getOrCreateCustomer(business.id, lid);
  const conversation = await getOrCreateConversation(customer.id);
  const state = conversation.state;
  const data = conversation.data || {};
  const trimmed = text.trim().toLowerCase();
  const timezone = business.timezone || "America/Montevideo";

  async function reply(msg: string) {
    await sock.sendMessage(from, { text: msg });
  }

  // --------------------------------------------------------------------------
  // COMANDOS GLOBALES DE REINICIO
  // --------------------------------------------------------------------------
  if (trimmed === "cancelar" || trimmed === "reiniciar") {
    await updateConversation(conversation.id, "START", {});
    await reply("Listo, reiniciamos. Escribí 'hola' cuando quieras reservar un turno.");
    return;
  }

  // --------------------------------------------------------------------------
  // ESTADO: START (Saludo y Solicitud de Nombre o Menú de Servicios)
  // --------------------------------------------------------------------------
  if (state === "START") {
    if (!customer.name) {
      await updateConversation(conversation.id, "ASK_NAME", {});
      await reply(`Hola 👋 Soy el asistente de ${business.name || "la barbería"}. ¿Cómo te llamás?`);
      return;
    }

    const servicesRes = await pool.query(
      "SELECT * FROM service WHERE business_id = $1 AND active = 1 ORDER BY created_at",
      [business.id]
    );
    const services = servicesRes.rows;

    if (services.length === 0) {
      await reply("Por ahora no hay servicios disponibles. Probá más tarde.");
      return;
    }

    const list = services.map((s: any, i: number) => `${i + 1}. ${s.name} - ${s.duration_minutes} min`).join("\n");

    await updateConversation(conversation.id, "SELECT_SERVICE", { serviceIds: services.map((s: any) => s.id) });
    await reply(`¡Hola ${customer.name}! ¿Qué servicio querés reservar?\n\n${list}\n\nEscribí el número de la opción.`);
    return;
  }

  // --------------------------------------------------------------------------
  // ESTADO: ASK_NAME (Registro del Nombre del Cliente)
  // --------------------------------------------------------------------------
  if (state === "ASK_NAME") {
    const name = text.trim();
    if (!name) {
      await reply("No entendí. ¿Cómo te llamás?");
      return;
    }

    await pool.query("UPDATE customer SET name = $1 WHERE id = $2", [name, customer.id]);
    customer.name = name;

    const servicesRes = await pool.query(
      "SELECT * FROM service WHERE business_id = $1 AND active = 1 ORDER BY created_at",
      [business.id]
    );
    const services = servicesRes.rows;

    const list = services.map((s: any, i: number) => `${i + 1}. ${s.name} - ${s.duration_minutes} min`).join("\n");

    await updateConversation(conversation.id, "SELECT_SERVICE", { serviceIds: services.map((s: any) => s.id) });
    await reply(`¡Gracias, ${name}! ¿Qué servicio querés reservar?\n\n${list}\n\nEscribí el número de la opción.`);
    return;
  }

  // --------------------------------------------------------------------------
  // ESTADO: SELECT_SERVICE (Elección de Servicio y Presentación de Días)
  // --------------------------------------------------------------------------
  if (state === "SELECT_SERVICE") {
    const choice = parseInt(trimmed, 10);
    const serviceIds = data.serviceIds || [];

    if (isNaN(choice) || choice < 1 || choice > serviceIds.length) {
      await reply("No entendí esa opción. Escribí el número del servicio que querés.");
      return;
    }

    const serviceId = serviceIds[choice - 1];
    const { currentDate } = getCurrentDateAndMinutes(timezone);
    const candidateDates = Array.from({ length: 8 }, (_, i) => addDays(currentDate, i));
    const datesWithSlots: string[] = [];

    for (const d of candidateDates) {
      const slots = await getAvailableSlots(business.id, d, serviceId, timezone);
      if (slots.length > 0) datesWithSlots.push(d);
    }

    if (datesWithSlots.length === 0) {
      await updateConversation(conversation.id, "START", {});
      await reply("No hay horarios disponibles en los próximos días para ese servicio. Probá escribiendo más tarde 🙏");
      return;
    }

    const list = datesWithSlots
      .map((d, i) => `${i + 1}. ${formatDateOption(d, currentDate)}`)
      .join("\n");

    await updateConversation(conversation.id, "SELECT_DATE", { ...data, service_id: serviceId, dates: datesWithSlots });
    await reply(`Perfecto. ¿Para qué día?\n\n${list}\n\nEscribí el número de la opción.`);
    return;
  }

  // --------------------------------------------------------------------------
  // ESTADO: SELECT_DATE (Elección de Día y Presentación de Horarios Libres)
  // --------------------------------------------------------------------------
  if (state === "SELECT_DATE") {
    const choice = parseInt(trimmed, 10);
    const dates = data.dates || [];
    const { currentDate } = getCurrentDateAndMinutes(timezone);

    if (isNaN(choice) || choice < 1 || choice > dates.length) {
      await reply("No entendí esa opción. Escribí el número del día que preferís.");
      return;
    }

    const date = dates[choice - 1];
    const slots = await getAvailableSlots(business.id, date, data.service_id, timezone);

    if (slots.length === 0) {
      const list = dates.map((d: string, i: number) => `${i + 1}. ${formatDateOption(d, currentDate)}`).join("\n");
      await reply(`Ese día no hay horarios disponibles. Elegí otro:\n\n${list}`);
      return;
    }

    const shown = slots.slice(0, 12);
    const list = shown.map((s, i) => `${i + 1}. ${s}`).join("\n");

    await updateConversation(conversation.id, "SELECT_TIME", { ...data, date, slots: shown });
    await reply(`Horarios disponibles:\n\n${list}\n\nEscribí el número del horario que preferís.`);
    return;
  }

  // --------------------------------------------------------------------------
  // ESTADO: SELECT_TIME (Elección de Horario y Resumen de Confirmación)
  // --------------------------------------------------------------------------
  if (state === "SELECT_TIME") {
    const choice = parseInt(trimmed, 10);
    const slots = data.slots || [];

    if (isNaN(choice) || choice < 1 || choice > slots.length) {
      await reply("No entendí esa opción. Escribí el número del horario.");
      return;
    }

    const startTime = slots[choice - 1];
    const serviceRes = await pool.query("SELECT name FROM service WHERE id = $1", [data.service_id]);
    const serviceName = serviceRes.rows[0]?.name ?? "";

    await updateConversation(conversation.id, "CONFIRMATION", { ...data, start_time: startTime });
    await reply(
      `Servicio: ${serviceName}\nFecha: ${formatFullDate(data.date)}\nHora: ${startTime}\n\n¿Confirmás?\n1. Sí\n2. Cambiar`
    );
    return;
  }

  // --------------------------------------------------------------------------
  // ESTADO: CONFIRMATION (Guardado en Base de Datos, Notificación y Cierre)
  // --------------------------------------------------------------------------
  if (state === "CONFIRMATION") {
    if (trimmed === "1" || trimmed === "si" || trimmed === "sí") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const serviceRes = await client.query("SELECT duration_minutes, name FROM service WHERE id = $1", [
          data.service_id,
        ]);
        const duration = serviceRes.rows[0].duration_minutes;
        const serviceName = serviceRes.rows[0].name;
        const startMin = timeToMinutes(data.start_time);
        const endTime = minutesToTime(startMin + duration);

        // Comprobar conflicto de concurrencia
        const conflictRes = await client.query(
          `SELECT id FROM appointment WHERE business_id = $1 AND date = $2 AND status != 'CANCELLED'
           AND start_time < $3 AND end_time > $4`,
          [business.id, data.date, endTime, data.start_time]
        );

        if (conflictRes.rows[0]) {
          await client.query("ROLLBACK");
          await updateConversation(conversation.id, "SELECT_DATE", { service_id: data.service_id });
          await reply("Uy, justo se ocupó ese horario. Probá con otra fecha (DD/MM).");
          return;
        }

        const isApproval = business.booking_mode === "approval";
        const id = randomUUID();

        // Insertar la nueva cita
        await client.query(
          `INSERT INTO appointment (id, business_id, customer_id, service_id, date, start_time, end_time, status, created_via)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'whatsapp')`,
          [
            id,
            business.id,
            customer.id,
            data.service_id,
            data.date,
            data.start_time,
            endTime,
            isApproval ? "PENDING_APPROVAL" : "CONFIRMED",
          ]
        );

        // Reactivar automáticamente al cliente si estaba marcado como inactivo/eliminado
        await client.query(
          "UPDATE customer SET active = 1 WHERE id = $1 AND active = 0",
          [customer.id]
        );

        await client.query("COMMIT");
        await updateConversation(conversation.id, "START", {});

        const fechaLegible = formatFullDate(data.date);

        if (isApproval) {
          await reply("¡Gracias! Tu reserva está pendiente de confirmación del barbero. Te avisamos apenas la acepte.");
        } else {
          await reply(`¡Listo! Tu reserva quedó confirmada para el ${fechaLegible} a las ${data.start_time}. Te esperamos 🙌`);
        }

        // Notificación push directa al teléfono del barbero por Firebase FCM
        await sendBarberPushNotification(
          business.expo_push_token,
          "📅 Nueva cita",
          `${customer.name} — ${serviceName} — ${fechaLegible} ${data.start_time}`
        );

        // Envío complementario por WhatsApp al teléfono personal del barbero (si está cargado)
        if (business.phone) {
          const barberJid = business.phone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
          await sock.sendMessage(barberJid, {
            text: `📅 Nueva cita\nCliente: ${customer.name}\nServicio: ${serviceName}\nFecha: ${fechaLegible}\nHora: ${data.start_time}`,
          });
        }
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return;
    }

    if (trimmed === "2" || trimmed === "cambiar") {
      await updateConversation(conversation.id, "START", {});
      await reply("Dale, arranquemos de nuevo. Escribí 'hola' para ver los servicios.");
      return;
    }

    await reply("Respondé 1 para confirmar o 2 para cambiar.");
    return;
  }
}
