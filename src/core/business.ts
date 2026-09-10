import { pool } from "../database/connection.js";

// ============================================================================
// SERVICIO DE NEGOCIO (PERFIL, CONFIGURACIÓN Y HORARIOS)
// ============================================================================

/**
 * Obtiene el ID del negocio registrado en la base de datos.
 */
export async function getBusinessId(): Promise<string | null> {
  const { rows } = await pool.query("SELECT id FROM business LIMIT 1");
  return rows[0]?.id ?? null;
}

/**
 * Consulta la información completa del negocio registrado.
 */
export async function getBusinessProfile(): Promise<any | null> {
  const { rows } = await pool.query("SELECT * FROM business LIMIT 1");
  return rows[0] ?? null;
}

/**
 * Actualiza los datos generales del perfil del negocio.
 */
export async function updateBusinessProfile(data: {
  name?: string;
  phone?: string;
  address?: string;
  logo_base64?: string | null;
}): Promise<any> {
  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio registrado");

  const existing = await getBusinessProfile();

  await pool.query(
    "UPDATE business SET name = $1, phone = $2, address = $3, logo_base64 = $4 WHERE id = $5",
    [
      data.name ?? existing.name,
      data.phone ?? existing.phone,
      data.address ?? existing.address,
      data.logo_base64 !== undefined ? data.logo_base64 : existing.logo_base64,
      businessId,
    ]
  );

  return getBusinessProfile();
}

/**
 * Actualiza la configuración operativa (intervalos, modo y recordatorios).
 */
export async function updateBusinessSettings(data: {
  slot_step_minutes?: number;
  booking_mode?: "auto" | "approval";
  notify_upcoming_appointments?: number | boolean;
}): Promise<any> {
  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio registrado");

  if (data.slot_step_minutes) {
    if (![15, 30, 45, 60].includes(data.slot_step_minutes)) {
      throw new Error("slot_step_minutes debe ser 15, 30, 45 o 60");
    }
    await pool.query("UPDATE business SET slot_step_minutes = $1 WHERE id = $2", [
      data.slot_step_minutes,
      businessId,
    ]);
  }

  if (data.booking_mode) {
    if (!["auto", "approval"].includes(data.booking_mode)) {
      throw new Error("booking_mode debe ser auto o approval");
    }
    await pool.query("UPDATE business SET booking_mode = $1 WHERE id = $2", [
      data.booking_mode,
      businessId,
    ]);
  }

  if (data.notify_upcoming_appointments !== undefined) {
    const val =
      data.notify_upcoming_appointments === true ||
      data.notify_upcoming_appointments === 1
        ? 1
        : 0;
    await pool.query(
      "UPDATE business SET notify_upcoming_appointments = $1 WHERE id = $2",
      [val, businessId]
    );
  }

  return getBusinessProfile();
}

/**
 * Registra el token de notificaciones FCM para el negocio (legacy).
 */
export async function setBusinessPushToken(token: string): Promise<void> {
  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio registrado");
  await pool.query("UPDATE business SET expo_push_token = $1 WHERE id = $2", [
    token,
    businessId,
  ]);
}

/**
 * Registra o actualiza la suscripción Web Push del dispositivo del barbero.
 */
export async function setBusinessWebPushSubscription(subscription: any): Promise<void> {
  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio registrado");
  const value = typeof subscription === "string" ? subscription : JSON.stringify(subscription);
  await pool.query("UPDATE business SET web_push_subscription = $1 WHERE id = $2", [
    value,
    businessId,
  ]);
}

