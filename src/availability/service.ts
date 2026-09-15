import { randomUUID } from "node:crypto";
import { getBusinessId } from "../core/business.js";
import {
  AvailabilityBlock,
  AvailabilityException,
  CreateBlockInput,
  CreateExceptionInput,
  UpdateBlockInput,
} from "./models.js";
import {
  deleteBlockRecord,
  deleteExceptionRecord,
  findBlockById,
  findBlocksByBusinessId,
  findExceptionById,
  findExceptionsByBusinessId,
  insertBlockRecord,
  insertExceptionRecord,
  toggleBlockActiveRecord,
  updateBlockRecord,
} from "./repository.js";

export async function listBlocks(): Promise<AvailabilityBlock[]> {
  const businessId = await getBusinessId();
  if (!businessId) return [];
  return findBlocksByBusinessId(businessId);
}

export async function createBlock(input: CreateBlockInput): Promise<AvailabilityBlock> {
  if (input.day_of_week === undefined || !input.start_time || !input.end_time) {
    throw new Error("day_of_week, start_time y end_time son obligatorios");
  }
  if (input.day_of_week < 0 || input.day_of_week > 6) {
    throw new Error("day_of_week debe ser 0 (domingo) a 6 (sábado)");
  }

  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio cargado");

  const id = randomUUID();
  return insertBlockRecord({
    id,
    businessId,
    day_of_week: input.day_of_week,
    start_time: input.start_time,
    end_time: input.end_time,
  });
}

export async function updateBlock(id: string, input: UpdateBlockInput): Promise<AvailabilityBlock> {
  const existing = await findBlockById(id);
  if (!existing) throw new Error("Horario no encontrado");

  return updateBlockRecord(
    id,
    input.start_time ?? existing.start_time,
    input.end_time ?? existing.end_time
  );
}

export async function toggleBlock(id: string): Promise<AvailabilityBlock> {
  const existing = await findBlockById(id);
  if (!existing) throw new Error("Horario no encontrado");

  const newActive = existing.active ? 0 : 1;
  return toggleBlockActiveRecord(id, newActive);
}

export async function deleteBlock(id: string): Promise<void> {
  const existing = await findBlockById(id);
  if (!existing) throw new Error("Horario no encontrado");
  await deleteBlockRecord(id);
}

// ----------------------------------------------------------------------------
// EXCEPCIONES DE CALENDARIO
// ----------------------------------------------------------------------------

export async function listExceptions(): Promise<AvailabilityException[]> {
  const businessId = await getBusinessId();
  if (!businessId) return [];
  return findExceptionsByBusinessId(businessId);
}

export async function createException(input: CreateExceptionInput): Promise<AvailabilityException> {
  if (!input.date) {
    throw new Error("date es obligatorio");
  }

  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio cargado");

  const id = randomUUID();
  const closed =
    input.closed_all_day === 0 || input.closed_all_day === false ? 0 : 1;

  if (closed === 0) {
    if (!input.start_time || !input.end_time) {
      throw new Error("start_time y end_time son obligatorios para cierres parciales");
    }
    if (input.start_time >= input.end_time) {
      throw new Error("start_time debe ser menor a end_time");
    }
  }

  return insertExceptionRecord({
    id,
    businessId,
    date: input.date,
    closed_all_day: closed,
    start_time: closed === 0 ? (input.start_time ?? null) : null,
    end_time: closed === 0 ? (input.end_time ?? null) : null,
    reason: input.reason ?? null,
  });
}

export async function deleteException(id: string): Promise<void> {
  const existing = await findExceptionById(id);
  if (!existing) throw new Error("Excepción no encontrada");
  await deleteExceptionRecord(id);
}
