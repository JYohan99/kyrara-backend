import { randomUUID } from "node:crypto";
import { getBusinessId } from "../core/business.js";
import { CreateServiceInput, Service, UpdateServiceInput } from "./models.js";
import {
  deleteServiceRecord,
  findServiceById,
  findServicesByBusinessId,
  insertService,
  toggleServiceActiveRecord,
  updateServiceRecord,
} from "./repository.js";

export async function listServices(): Promise<Service[]> {
  const businessId = await getBusinessId();
  if (!businessId) return [];
  return findServicesByBusinessId(businessId);
}

export async function createService(input: CreateServiceInput): Promise<Service> {
  if (!input.name || !input.duration_minutes) {
    throw new Error("name y duration_minutes son obligatorios");
  }

  const businessId = await getBusinessId();
  if (!businessId) throw new Error("No hay negocio cargado");

  const id = randomUUID();
  return insertService({
    id,
    businessId,
    name: input.name,
    duration_minutes: input.duration_minutes,
    price: input.price,
  });
}

export async function updateService(id: string, input: UpdateServiceInput): Promise<Service> {
  const existing = await findServiceById(id);
  if (!existing) throw new Error("Servicio no encontrado");

  return updateServiceRecord(id, {
    name: input.name ?? existing.name,
    duration_minutes: input.duration_minutes ?? existing.duration_minutes,
    price: input.price !== undefined ? input.price : existing.price,
  });
}

export async function toggleService(id: string): Promise<Service> {
  const existing = await findServiceById(id);
  if (!existing) throw new Error("Servicio no encontrado");

  const newActive = existing.active ? 0 : 1;
  return toggleServiceActiveRecord(id, newActive);
}

export async function deleteService(id: string): Promise<void> {
  const existing = await findServiceById(id);
  if (!existing) throw new Error("Servicio no encontrado");
  await deleteServiceRecord(id);
}
