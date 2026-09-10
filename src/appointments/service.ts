import { randomUUID } from "node:crypto";
import { findExceptionsByBusinessId, findBlocksByBusinessId } from "../availability/repository.js";
import { getBusinessId, getBusinessProfile } from "../core/business.js";
import { sendWebPushNotification } from "../notifications/webpush.js";
import {
  dayOfWeek,
  getCurrentDateAndMinutes,
  minutesToTime,
  timeToMinutes,
} from "../core/time.js";
import { findCustomerById } from "../customers/repository.js";
import { findServiceById } from "../services/repository.js";
import {
  Appointment,
  AvailableSlotsResult,
  CreateAppointmentInput,
} from "./models.js";
import {
  findAppointmentById,
  findAppointmentsByDate,
  findBusySlots,
  insertAppointmentTransaction,
  updateAppointmentStatusRecord,
} from "./repository.js";

export async function listAppointmentsForDay(date?: string): Promise<Appointment[]> {
  const day = date ?? new Date().toISOString().slice(0, 10);
  return findAppointmentsByDate(day);
}

export async function calculateAvailableSlots(
  date: string,
  serviceId: string
): Promise<AvailableSlotsResult> {
  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio cargado");

  const business = await getBusinessProfile();
  const STEP = business?.slot_step_minutes ?? 30;
  const timezone = business?.timezone ?? "America/Montevideo";

  const { currentDate, currentMinutes } = getCurrentDateAndMinutes(timezone);

  // Descartar fechas anteriores a hoy
  if (date < currentDate) {
    return { date, service_id: serviceId, duration_minutes: 0, slots: [] };
  }

  const service = await findServiceById(serviceId);
  if (!service || !service.active) {
    throw new Error("Servicio no encontrado o inactivo");
  }

  // Excepciones de disponibilidad (vacaciones, feriados, etc.)
  const exceptions = await findExceptionsByBusinessId(businessId);
  const dayExceptions = exceptions.filter((e) => e.date === date);

  if (dayExceptions.some((e) => e.closed_all_day === 1)) {
    return { date, service_id: serviceId, duration_minutes: service.duration_minutes, slots: [] };
  }

  // Horarios de apertura semanales
  const dow = dayOfWeek(date);
  const blocks = await findBlocksByBusinessId(businessId);
  const windows = blocks.filter((b) => b.day_of_week === dow && b.active === 1);
  if (windows.length === 0) {
    return { date, service_id: serviceId, duration_minutes: service.duration_minutes, slots: [] };
  }

  // Turnos ocupados ya reservados
  const busy = await findBusySlots(businessId, date);

  const blocked = [
    ...busy.map((b) => ({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) })),
    ...dayExceptions
      .filter((e) => !e.closed_all_day && e.start_time && e.end_time)
      .map((e) => ({ start: timeToMinutes(e.start_time!), end: timeToMinutes(e.end_time!) })),
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

  return { date, service_id: serviceId, duration_minutes: duration, slots };
}

export async function bookAppointment(input: CreateAppointmentInput): Promise<Appointment> {
  if (!input.customer_id || !input.service_id || !input.date || !input.start_time) {
    throw new Error("customer_id, service_id, date y start_time son obligatorios");
  }

  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio cargado");

  const business = await getBusinessProfile();
  const timezone = business?.timezone ?? "America/Montevideo";
  const { currentDate, currentMinutes } = getCurrentDateAndMinutes(timezone);

  if (
    input.date < currentDate ||
    (input.date === currentDate && timeToMinutes(input.start_time) <= currentMinutes)
  ) {
    throw new Error("No es posible agendar un turno en un horario o fecha que ya pasó.");
  }

  const service = await findServiceById(input.service_id);
  if (!service) throw new Error("Servicio no encontrado");

  const customer = await findCustomerById(input.customer_id);
  if (!customer) throw new Error("Cliente no encontrado");

  const startMin = timeToMinutes(input.start_time);
  const endMin = startMin + service.duration_minutes;
  const endTime = minutesToTime(endMin);

  const id = randomUUID();
  const appointment = await insertAppointmentTransaction({
    id,
    businessId,
    customerId: input.customer_id,
    serviceId: input.service_id,
    date: input.date,
    startTime: input.start_time,
    endTime,
    createdVia: input.created_via ?? "manual",
  });

  // Notificar al dispositivo del barbero
  try {
    const freshBiz = await getBusinessProfile();
    if (freshBiz?.web_push_subscription) {
      await sendWebPushNotification(
        freshBiz.web_push_subscription,
        "💈 Nueva cita agendada",
        `${customer.name || "Cliente"} — ${service.name} — ${input.date} ${input.start_time}`
      );
    }
  } catch (err) {
    console.error("[Appointments] Error enviando web push de nueva cita:", err);
  }

  return appointment;
}

export async function cancelAppointment(id: string): Promise<Appointment> {
  const existing = await findAppointmentById(id);
  if (!existing) throw new Error("Reserva no encontrada");
  return updateAppointmentStatusRecord(id, "CANCELLED");
}

export async function completeAppointment(id: string): Promise<Appointment> {
  const existing = await findAppointmentById(id);
  if (!existing) throw new Error("Reserva no encontrada");
  return updateAppointmentStatusRecord(id, "COMPLETED");
}

export async function updateAppointment(id: string, status?: string): Promise<Appointment> {
  const existing = await findAppointmentById(id);
  if (!existing) throw new Error("Reserva no encontrada");
  if (status) {
    return updateAppointmentStatusRecord(id, status);
  }
  return existing;
}

export async function respondAppointmentApproval(
  id: string,
  decision: "accept" | "reject"
): Promise<{ id: string; status: string }> {
  const existing = await findAppointmentById(id);
  if (!existing) throw new Error("Reserva no encontrada");

  const newStatus = decision === "accept" ? "CONFIRMED" : "CANCELLED";
  await updateAppointmentStatusRecord(id, newStatus);
  return { id, status: newStatus };
}
