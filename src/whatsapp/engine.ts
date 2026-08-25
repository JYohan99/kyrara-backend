import type { WASocket } from "baileys";
import { randomUUID } from "node:crypto";
import { pool } from "../database/connection.js";

function normalizePhone(jid: string): string {
  const digits = jid.split("@")[0].replace(/[^0-9]/g, "");
  return `+${digits}`;
}

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function formatFullDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} de ${MESES[m - 1]}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function sendBarberPushNotification(expoPushToken: string | null, title: string, body: string) {
  if (!expoPushToken) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ to: expoPushToken, title, body, sound: "default" }),
    });
  } catch (err) {
    console.error("Error enviando push al barbero:", err);
  }
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDateOption(dateStr: string, index: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const label = `${weekday} ${d.toString().padStart(2, "0")}/${m.toString().padStart(2, "0")}`;
  if (index === 0) return `Hoy (${label})`;
  if (index === 1) return `Mañana (${label})`;
  return label;
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

async function getBusiness() {
  const { rows } = await pool.query("SELECT * FROM business LIMIT 1");
  return rows[0];
}

async function getOrCreateCustomer(businessId: string, phone: string) {
  const existing = await pool.query(
    "SELECT * FROM customer WHERE business_id = $1 AND phone = $2",
    [businessId, phone]
  );
  if (existing.rows[0]) return existing.rows[0];

  const id = randomUUID();
  await pool.query("INSERT INTO customer (id, business_id, phone) VALUES ($1, $2, $3)", [
    id,
    businessId,
    phone,
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

async function getAvailableSlots(businessId: string, date: string, serviceId: string): Promise<string[]> {
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

  for (const w of windows) {
    const windowStart = timeToMinutes(w.start_time);
    const windowEnd = timeToMinutes(w.end_time);
    for (let start = windowStart; start + duration <= windowEnd; start += STEP) {
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

  const phone = normalizePhone(from);
  const customer = await getOrCreateCustomer(business.id, phone);
  const conversation = await getOrCreateConversation(customer.id);
  const state = conversation.state;
  const data = conversation.data || {};
  const trimmed = text.trim().toLowerCase();

  async function reply(msg: string) {
    await sock.sendMessage(from, { text: msg });
  }

  // Comandos globales, disponibles en cualquier estado
  if (trimmed === "cancelar" || trimmed === "reiniciar") {
    await updateConversation(conversation.id, "START", {});
    await reply("Listo, reiniciamos. Escribí 'hola' cuando quieras reservar un turno.");
    return;
  }

  if (state === "START") {
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
    await reply(`Hola 👋 ¿Qué servicio querés reservar?\n\n${list}\n\nEscribí el número de la opción.`);
    return;
  }

  if (state === "SELECT_SERVICE") {
    const choice = parseInt(trimmed, 10);
    const serviceIds = data.serviceIds || [];

    if (isNaN(choice) || choice < 1 || choice > serviceIds.length) {
      await reply("No entendí esa opción. Escribí el número del servicio que querés.");
      return;
    }

    const serviceId = serviceIds[choice - 1];

    // Calculamos disponibilidad real de los próximos 8 días (hoy + 7) y
    // solo mostramos los que efectivamente tienen algún horario libre.
    const candidateDates = Array.from({ length: 8 }, (_, i) => addDays(todayStr(), i));
    const datesWithSlots: string[] = [];

    for (const d of candidateDates) {
      const slots = await getAvailableSlots(business.id, d, serviceId);
      if (slots.length > 0) datesWithSlots.push(d);
    }

    if (datesWithSlots.length === 0) {
      await updateConversation(conversation.id, "START", {});
      await reply("No hay horarios disponibles en los próximos días para ese servicio. Probá escribiendo más tarde 🙏");
      return;
    }

    const list = datesWithSlots
      .map((d, i) => `${i + 1}. ${formatDateOption(d, candidateDates.indexOf(d))}`)
      .join("\n");

    await updateConversation(conversation.id, "SELECT_DATE", { ...data, service_id: serviceId, dates: datesWithSlots });
    await reply(`Perfecto. ¿Para qué día?\n\n${list}\n\nEscribí el número de la opción.`);
    return;
  }

  if (state === "SELECT_DATE") {
    const choice = parseInt(trimmed, 10);
    const dates = data.dates || [];

    if (isNaN(choice) || choice < 1 || choice > dates.length) {
      await reply("No entendí esa opción. Escribí el número del día que preferís.");
      return;
    }

    const date = dates[choice - 1];
    const slots = await getAvailableSlots(business.id, date, data.service_id);

    if (slots.length === 0) {
      const list = dates.map((d: string, i: number) => `${i + 1}. ${formatDateOption(d, i)}`).join("\n");
      await reply(`Ese día no hay horarios disponibles. Elegí otro:\n\n${list}`);
      return; // se queda en SELECT_DATE, con la misma lista de fechas guardada
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
    const serviceRes = await pool.query("SELECT name FROM service WHERE id = $1", [data.service_id]);
    const serviceName = serviceRes.rows[0]?.name ?? "";

    await updateConversation(conversation.id, "CONFIRMATION", { ...data, start_time: startTime });
    await reply(
      `Servicio: ${serviceName}\nFecha: ${formatFullDate(data.date)}\nHora: ${startTime}\n\n¿Confirmás?\n1. Sí\n2. Cambiar`
    );
    return;
  }

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

               await client.query("COMMIT");
        await updateConversation(conversation.id, "START", {});

        const [y, m, d] = data.date.split("-");
        const fechaLegible = formatFullDate(data.date);

        if (isApproval) {
          await reply("¡Gracias! Tu reserva está pendiente de confirmación del barbero. Te avisamos apenas la acepte.");
        } else {
          await reply(`¡Listo! Tu reserva quedó confirmada para el ${fechaLegible} a las ${data.start_time}. Te esperamos 🙌`);
        }

        // Notificación al barbero: push si tiene token guardado, y siempre
        // también por WhatsApp como respaldo (por si no tiene la app abierta
        // o instalada todavía).
        await sendBarberPushNotification(
          business.expo_push_token,
          "📅 Nueva cita",
          `${customer.name || phone} — ${serviceName} — ${fechaLegible} ${data.start_time}`
        );

        if (business.phone) {
          const barberJid = business.phone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
          await sock.sendMessage(barberJid, {
            text: `📅 Nueva cita\nCliente: ${phone}\nServicio: ${serviceName}\nFecha: ${fechaLegible}\nHora: ${data.start_time}`,
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