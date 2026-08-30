import { sendPushNotification } from "../notifications/firebase.js";
import type { WASocket } from "baileys";
import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";

function extractLid(jid: string): string {
  return jid.split("@")[0];
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function getCurrentDateAndMinutes(timezone: string = "America/Montevideo"): { currentDate: string; currentMinutes: number } {
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

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDateOption(dateStr: string, currentDate: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const label = `${weekday} ${d.toString().padStart(2, "0")}/${m.toString().padStart(2, "0")}`;
  if (dateStr === currentDate) return `Hoy (${label})`;
  if (dateStr === addDays(currentDate, 1)) return `Mañana (${label})`;
  return label;
}

function formatFullDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} de ${MESES[m - 1]}`;
}

async function getBusiness() {
  const { rows } = await pool.query("SELECT * FROM business LIMIT 1");
  return rows[0];
}

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

async function updateConversation(id: string, state: string, data: any) {
  await pool.query("UPDATE conversation SET state = $1, data = $2, updated_at = NOW() WHERE id = $3", [
    state,
    JSON.stringify(data),
    id,
  ]);
}

async function sendBarberPushNotification(expoPushToken: string | null, title: string, body: string) {
  await sendPushNotification(expoPushToken, title, body);
}

async function getAvailableSlots(businessId: string, date: string, serviceId: string, timezone: string = "America/Montevideo"): Promise<string[]> {
  const { currentDate, currentMinutes } = getCurrentDateAndMinutes(timezone);

  // Si la fecha es anterior a hoy, no hay disponibilidad
  if (date < currentDate) return [];

  const businessRes = await pool.query("SELECT slot_step_minutes FROM business WHERE id = $1", [businessId]);
  const STEP = businessRes.rows[0]?.slot_step_minutes ?? 30;

  const serviceRes = await pool.query("SELECT * FROM service WHERE id = $1 AND active = 1", [serviceId]);
  const service = serviceRes.rows[0];
  if (!service) return [];

  const exceptionsRes = await pool.query(
    "SELECT * FROM availability_exception WHERE business_id = $1 AND date = $2",
    [businessId, date]
  );
  const exceptions = exceptionsRes.rows;
  if (exceptions.some((e: any) => e.closed_all_day)) return [];

  const dow = dayOfWeek(date);
  const windowsRes = await pool.query(
    "SELECT * FROM availability WHERE business_id = $1 AND day_of_week = $2 AND active = 1",
    [businessId, dow]
  );
  const windows = windowsRes.rows;
  if (windows.length === 0) return [];

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
      // Filtrar turnos que ya pasaron en el día de hoy
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

  // Comandos globales
  if (trimmed === "cancelar" || trimmed === "menu" || trimmed === "inicio" || trimmed === "reiniciar") {
    await updateConversation(conversation.id, "START", {});
    await reply("Conversación reiniciada. Escribí 'hola' para ver los servicios disponibles.");
    return;
  }

  if (state === "START") {
    const { rows: services } = await pool.query(
      "SELECT * FROM service WHERE business_id = $1 AND active = 1 ORDER BY created_at",
      [business.id]
    );

    if (services.length === 0) {
      await reply("¡Hola! En este momento no tenemos servicios disponibles. Consultanos más tarde.");
      return;
    }

    const list = services
      .map((s: any, i: number) => {
        const precio = s.price ? ` — $${s.price}` : "";
        return `${i + 1}. ${s.name} (${s.duration_minutes} min)${precio}`;
      })
      .join("\n");

    const saludo = business.name ? `¡Hola! Bienvenido a *${business.name}* ??` : "¡Hola! Bienvenido ??";
    await updateConversation(conversation.id, "SELECT_SERVICE", {
      serviceIds: services.map((s: any) => s.id),
    });
    await reply(`${saludo}\n\nElegí el servicio que querés agendar:\n\n${list}\n\nEscribí el número de la opción.`);
    return;
  }

  if (state === "SELECT_SERVICE") {
    const choice = parseInt(trimmed, 10);
    const serviceIds: string[] = data.serviceIds || [];

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
      await reply("No hay horarios disponibles en los próximos días para ese servicio. Probá consultando más tarde.");
      return;
    }

    const list = datesWithSlots
      .map((d, i) => `${i + 1}. ${formatDateOption(d, currentDate)}`)
      .join("\n");

    await updateConversation(conversation.id, "SELECT_DATE", { ...data, service_id: serviceId, dates: datesWithSlots });
    await reply(`Perfecto. ¿Para qué día?\n\n${list}\n\nEscribí el número de la opción.`);
    return;
  }

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
      await reply(`Ese día no tiene horarios disponibles. Elegí otro:\n\n${list}`);
      return;
    }

    const shown = slots.slice(0, 12);
    const list = shown.map((s, i) => `${i + 1}. ${s}`).join("\n");

    await updateConversation(conversation.id, "SELECT_TIME", { ...data, date, slots: shown });
    await reply(`Horarios disponibles:\n\n${list}\n\nEscribí el número del horario que preferís.`);
    return;
  }

  if (state === "SELECT_TIME") {
    const choice = parseInt(trimmed, 10);
    const slots = data.slots || [];

    if (isNaN(choice) || choice < 1 || choice > slots.length) {
      await reply("No entendí esa opción. Escribí el número del horario.");
      return;
    }

    const startTime = slots[choice - 1];

    const serviceRes = await pool.query("SELECT * FROM service WHERE id = $1", [data.service_id]);
    const service = serviceRes.rows[0];
    const serviceName = service?.name || "Servicio";
    const precio = service?.price ? ` ($${service.price})` : "";
    const fechaLegible = formatFullDate(data.date);

    if (!customer.name) {
      await updateConversation(conversation.id, "ASK_NAME", {
        ...data,
        start_time: startTime,
        service_name: serviceName,
        price_text: precio,
      });
      await reply(`Excelente. Antes de confirmar, ¿cuál es tu nombre?`);
      return;
    }

    await updateConversation(conversation.id, "CONFIRM", {
      ...data,
      start_time: startTime,
      service_name: serviceName,
      price_text: precio,
    });

    await reply(
      `¿Confirmás la reserva?\n\n` +
      `?? *Cliente:* ${customer.name}\n` +
      `?? *Servicio:* ${serviceName}${precio}\n` +
      `?? *Fecha:* ${fechaLegible}\n` +
      `? *Hora:* ${startTime}\n\n` +
      `1. Confirmar\n` +
      `2. Cambiar datos`
    );
    return;
  }

  if (state === "ASK_NAME") {
    const name = text.trim();
    if (!name || name.length < 2) {
      await reply("Por favor ingresá un nombre válido.");
      return;
    }

    await pool.query("UPDATE customer SET name = $1 WHERE id = $2", [name, customer.id]);
    customer.name = name;

    const fechaLegible = formatFullDate(data.date);

    await updateConversation(conversation.id, "CONFIRM", { ...data, customer_name: name });

    await reply(
      `¿Confirmás la reserva?\n\n` +
      `?? *Cliente:* ${name}\n` +
      `?? *Servicio:* ${data.service_name}${data.price_text || ""}\n` +
      `?? *Fecha:* ${fechaLegible}\n` +
      `? *Hora:* ${data.start_time}\n\n` +
      `1. Confirmar\n` +
      `2. Cambiar datos`
    );
    return;
  }

  if (state === "CONFIRM") {
    if (trimmed === "1" || trimmed === "si" || trimmed === "confirmar") {
      const serviceRes = await pool.query("SELECT * FROM service WHERE id = $1", [data.service_id]);
      const service = serviceRes.rows[0];
      const serviceName = service?.name || "Servicio";
      const duration = service?.duration_minutes || 30;
      const endTime = minutesToTime(timeToMinutes(data.start_time) + duration);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const conflictRes = await client.query(
          `SELECT id FROM appointment
           WHERE business_id = $1 AND date = $2 AND status != 'CANCELLED'
           AND start_time < $3 AND end_time > $4`,
          [business.id, data.date, endTime, data.start_time]
        );

        if (conflictRes.rows[0]) {
          await client.query("ROLLBACK");
          await updateConversation(conversation.id, "START", {});
          await reply("¡Ups! Justo alguien tomó ese horario hace un instante. Escribí 'hola' para elegir otro.");
          return;
        }

        const appointmentId = randomUUID();
        const isApproval = business.booking_mode === "approval";

        await client.query(
          `INSERT INTO appointment (id, business_id, customer_id, service_id, date, start_time, end_time, status, created_via)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'whatsapp')`,
          [
            appointmentId,
            business.id,
            customer.id,
            data.service_id,
            data.date,
            data.start_time,
            endTime,
            isApproval ? "PENDING_APPROVAL" : "CONFIRMED",
          ]
        );

        await client.query("COMMIT");
        await updateConversation(conversation.id, "START", {});

        const fechaLegible = formatFullDate(data.date);

        if (isApproval) {
          await reply("¡Gracias! Tu reserva está pendiente de confirmación del barbero. Te avisamos apenas la acepte.");
        } else {
          await reply(`¡Listo! Tu reserva quedó confirmada para el ${fechaLegible} a las ${data.start_time}. Te esperamos ??`);
        }

        await sendBarberPushNotification(
          business.expo_push_token,
          "?? Nueva cita",
          `${customer.name} — ${serviceName} — ${fechaLegible} ${data.start_time}`
        );

        if (business.phone) {
          const barberJid = business.phone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
          await sock.sendMessage(barberJid, {
            text: `?? Nueva cita\nCliente: ${customer.name}\nServicio: ${serviceName}\nFecha: ${fechaLegible}\nHora: ${data.start_time}`,
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