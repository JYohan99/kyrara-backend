export interface Service {
  id: string;
  business_id: string;
  name: string;
  duration_minutes: number;
  price: number | null;
  active: number;
  is_deleted?: number;
  created_at: string;
}

export interface CreateServiceInput {
  name: string;
  duration_minutes: number;
  price?: number | null;
}

export interface UpdateServiceInput {
  name?: string;
  duration_minutes?: number;
  price?: number | null;
}
