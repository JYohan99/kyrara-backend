import { pool } from "../database/connection.js";
import { getBusinessId, getBusinessProfile } from "../core/business.js";
import { getCurrentDateAndMinutes } from "../core/time.js";

export type PeriodType = "today" | "week" | "month" | "previous_month" | "custom";

export interface PeriodRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  label: string;
  formattedRange: string;
  comparisonSuffix: string;
}

export interface MetricComparison {
  current: number;
  previous: number;
  difference: number;
  percentage: number | null;
  direction: "up" | "down" | "equal";
  comparisonText: string;
}

export interface DailyPoint {
  date: string;
  dayLabel: string;
  fullDayName: string;
  dayNumber: number;
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  revenue: number;
  isPeak: boolean;
}

export interface PopularService {
  id: string;
  name: string;
  durationMinutes: number;
  price: number;
  totalBookings: number;
  completedBookings: number;
  totalRevenue: number;
  percentage: number;
}

export interface StatisticsResponse {
  period: PeriodType;
  currentRange: PeriodRange;
  previousRange: PeriodRange;
  metrics: {
    totalReservations: MetricComparison;
    completed: { count: number; rate: number };
    cancelled: { count: number; rate: number };
    noShow: { count: number; rate: number };
    newCustomers: MetricComparison;
    revenue: MetricComparison;
  };
  dailyReservations: DailyPoint[];
  peakDayInfo: {
    dayName: string;
    date: string;
    total: number;
    insight: string;
  } | null;
  popularServices: PopularService[];
  revenueDisclaimer: string;
}

const MONTH_NAMES_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

const MONTH_ABBR_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic"
];

const DAY_NAMES_ES = [
  "Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"
];

const DAY_SHORT_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDateISO(d: Date): string {
  const year = d.getUTCFullYear();
  const month = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  return `${year}-${month}-${day}`;
}

function parseDateISO(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, days: number): Date {
  const res = new Date(d.getTime());
  res.setUTCDate(res.getUTCDate() + days);
  return res;
}

function formatPrettyRange(startStr: string, endStr: string): string {
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);

  const startAbbr = MONTH_ABBR_ES[sm - 1] || "";
  const endAbbr = MONTH_ABBR_ES[em - 1] || "";

  if (startStr === endStr) {
    return `${sd} ${startAbbr} ${sy}`;
  }

  if (sy === ey && sm === em) {
    return `${sd} - ${ed} ${startAbbr} ${sy}`;
  }

  if (sy === ey) {
    return `${sd} ${startAbbr} - ${ed} ${endAbbr} ${sy}`;
  }

  return `${sd} ${startAbbr} ${sy} - ${ed} ${endAbbr} ${ey}`;
}

export function computeComparison(
  current: number,
  previous: number,
  suffix: string
): MetricComparison {
  const difference = current - previous;
  let percentage: number | null = null;
  let direction: "up" | "down" | "equal" = "equal";

  if (previous > 0) {
    percentage = Math.round(((current - previous) / previous) * 100);
  } else if (current > 0) {
    percentage = 100;
  } else {
    percentage = 0;
  }

  if (percentage > 0) {
    direction = "up";
  } else if (percentage < 0) {
    direction = "down";
  } else {
    direction = "equal";
  }

  let comparisonText = "";
  if (direction === "up") {
    comparisonText = `↑ ${Math.abs(percentage)}% ${suffix}`;
  } else if (direction === "down") {
    comparisonText = `↓ ${Math.abs(percentage)}% ${suffix}`;
  } else {
    comparisonText = `= Igual ${suffix}`;
  }

  return {
    current,
    previous,
    difference,
    percentage,
    direction,
    comparisonText,
  };
}

export function resolvePeriodRanges(
  period: PeriodType,
  todayStr: string,
  customStart?: string,
  customEnd?: string,
  selectedMonth?: string
): { current: PeriodRange; previous: PeriodRange } {
  const todayDate = parseDateISO(todayStr);
  const year = todayDate.getUTCFullYear();
  const month = todayDate.getUTCMonth(); // 0-indexed
  const dayOfWeek = todayDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  if (period === "today") {
    const yesterday = addDays(todayDate, -1);
    const yesterdayStr = formatDateISO(yesterday);

    return {
      current: {
        startDate: todayStr,
        endDate: todayStr,
        label: "Hoy",
        formattedRange: formatPrettyRange(todayStr, todayStr),
        comparisonSuffix: "respecto a ayer",
      },
      previous: {
        startDate: yesterdayStr,
        endDate: yesterdayStr,
        label: "Ayer",
        formattedRange: formatPrettyRange(yesterdayStr, yesterdayStr),
        comparisonSuffix: "día previo",
      },
    };
  }

  if (period === "week") {
    // Semana de Lunes a Domingo
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = addDays(todayDate, diffToMonday);
    const sunday = addDays(monday, 6);

    const prevMonday = addDays(monday, -7);
    const prevSunday = addDays(sunday, -7);

    const curStart = formatDateISO(monday);
    const curEnd = formatDateISO(sunday);
    const prevStart = formatDateISO(prevMonday);
    const prevEnd = formatDateISO(prevSunday);

    return {
      current: {
        startDate: curStart,
        endDate: curEnd,
        label: "Esta semana",
        formattedRange: formatPrettyRange(curStart, curEnd),
        comparisonSuffix: "respecto a la semana anterior",
      },
      previous: {
        startDate: prevStart,
        endDate: prevEnd,
        label: "Semana anterior",
        formattedRange: formatPrettyRange(prevStart, prevEnd),
        comparisonSuffix: "semana previa",
      },
    };
  }

  if (period === "previous_month") {
    // Mes anterior
    const firstOfPrevMonth = new Date(Date.UTC(year, month - 1, 1));
    const lastOfPrevMonth = new Date(Date.UTC(year, month, 0));

    const firstOfTwoMonthsAgo = new Date(Date.UTC(year, month - 2, 1));
    const lastOfTwoMonthsAgo = new Date(Date.UTC(year, month - 1, 0));

    const curStart = formatDateISO(firstOfPrevMonth);
    const curEnd = formatDateISO(lastOfPrevMonth);
    const prevStart = formatDateISO(firstOfTwoMonthsAgo);
    const prevEnd = formatDateISO(lastOfTwoMonthsAgo);

    return {
      current: {
        startDate: curStart,
        endDate: curEnd,
        label: "Mes anterior",
        formattedRange: formatPrettyRange(curStart, curEnd),
        comparisonSuffix: "respecto al mes anterior",
      },
      previous: {
        startDate: prevStart,
        endDate: prevEnd,
        label: "Mes anteúltimo",
        formattedRange: formatPrettyRange(prevStart, prevEnd),
        comparisonSuffix: "dos meses atrás",
      },
    };
  }

  if (period === "custom") {
    const startStr = customStart || todayStr;
    const endStr = customEnd || todayStr;
    const sDate = parseDateISO(startStr);
    const eDate = parseDateISO(endStr);

    const diffDays = Math.max(1, Math.round((eDate.getTime() - sDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);

    const prevEnd = addDays(sDate, -1);
    const prevStart = addDays(prevEnd, -(diffDays - 1));

    const prevStartStr = formatDateISO(prevStart);
    const prevEndStr = formatDateISO(prevEnd);

    return {
      current: {
        startDate: startStr,
        endDate: endStr,
        label: "Personalizado",
        formattedRange: formatPrettyRange(startStr, endStr),
        comparisonSuffix: "respecto al período anterior",
      },
      previous: {
        startDate: prevStartStr,
        endDate: prevEndStr,
        label: "Período anterior",
        formattedRange: formatPrettyRange(prevStartStr, prevEndStr),
        comparisonSuffix: "período previo",
      },
    };
  }

  // Default: "month" (Este mes o mes seleccionado)
  let targetYear = year;
  let targetMonth = month; // 0-indexed
  if (selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth)) {
    const [y, m] = selectedMonth.split("-").map(Number);
    targetYear = y;
    targetMonth = m - 1;
  }

  const isCurrentMonth = targetYear === year && targetMonth === month;
  const firstOfMonth = new Date(Date.UTC(targetYear, targetMonth, 1));
  const lastOfMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0));

  const firstOfPrevMonth = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
  const lastOfPrevMonth = new Date(Date.UTC(targetYear, targetMonth, 0));

  const curStart = formatDateISO(firstOfMonth);
  const curEnd = formatDateISO(lastOfMonth);
  const prevStart = formatDateISO(firstOfPrevMonth);
  const prevEnd = formatDateISO(lastOfPrevMonth);

  const prevMonthIdx = (targetMonth - 1 + 12) % 12;
  const prevMonthYear = targetMonth === 0 ? targetYear - 1 : targetYear;
  const prevMonthName = MONTH_NAMES_ES[prevMonthIdx];
  const curMonthName = MONTH_NAMES_ES[targetMonth];

  return {
    current: {
      startDate: curStart,
      endDate: curEnd,
      label: isCurrentMonth ? "Este mes" : `${curMonthName} ${targetYear}`,
      formattedRange: formatPrettyRange(curStart, curEnd),
      comparisonSuffix: `respecto a ${prevMonthName.toLowerCase()}`,
    },
    previous: {
      startDate: prevStart,
      endDate: prevEnd,
      label: `${prevMonthName} ${prevMonthYear}`,
      formattedRange: formatPrettyRange(prevStart, prevEnd),
      comparisonSuffix: "mes previo",
    },
  };
}

export async function getStatisticsData(options: {
  period?: PeriodType;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  month?: string;
}): Promise<StatisticsResponse> {
  const businessId = await getBusinessId();
  if (!businessId) {
    throw new Error("No hay negocio cargado");
  }

  const business = await getBusinessProfile();
  const tz = options.timezone || business?.timezone || "America/Montevideo";
  const { currentDate: todayStr } = getCurrentDateAndMinutes(tz);

  const period: PeriodType = options.period || "month";
  const { current: currentRange, previous: prevRange } = resolvePeriodRanges(
    period,
    todayStr,
    options.startDate,
    options.endDate,
    options.month
  );

  // 1. Obtener todas las citas del período actual con detalles del servicio
  const currentApptsQuery = await pool.query(
    `SELECT
       a.id,
       a.customer_id,
       a.service_id,
       a.date,
       a.start_time,
       a.status,
       s.name as service_name,
       s.duration_minutes,
       COALESCE(s.price, 0) as price
     FROM appointment a
     JOIN service s ON s.id = a.service_id
     WHERE a.business_id = $1
       AND a.date >= $2 AND a.date <= $3
     ORDER BY a.date ASC, a.start_time ASC`,
    [businessId, currentRange.startDate, currentRange.endDate]
  );
  const currentAppointments = currentApptsQuery.rows;

  // 2. Obtener todas las citas del período previo para comparación
  const prevApptsQuery = await pool.query(
    `SELECT
       a.id,
       a.status,
       COALESCE(s.price, 0) as price
     FROM appointment a
     JOIN service s ON s.id = a.service_id
     WHERE a.business_id = $1
       AND a.date >= $2 AND a.date <= $3`,
    [businessId, prevRange.startDate, prevRange.endDate]
  );
  const prevAppointments = prevApptsQuery.rows;

  // 3. Clientes nuevos del período actual
  const currentNewCustomersQuery = await pool.query(
    `SELECT COUNT(DISTINCT c.id)::int as count
     FROM customer c
     WHERE c.business_id = $1
       AND (
         (c.created_at >= ($2 || ' 00:00:00')::timestamp AND c.created_at <= ($3 || ' 23:59:59.999')::timestamp)
         OR c.id IN (
           SELECT customer_id FROM appointment
           WHERE business_id = $1
           GROUP BY customer_id
           HAVING MIN(date) >= $2 AND MIN(date) <= $3
         )
       )`,
    [businessId, currentRange.startDate, currentRange.endDate]
  );
  const currentNewCustomers = Number(currentNewCustomersQuery.rows[0]?.count ?? 0);

  // 4. Clientes nuevos del período previo
  const prevNewCustomersQuery = await pool.query(
    `SELECT COUNT(DISTINCT c.id)::int as count
     FROM customer c
     WHERE c.business_id = $1
       AND (
         (c.created_at >= ($2 || ' 00:00:00')::timestamp AND c.created_at <= ($3 || ' 23:59:59.999')::timestamp)
         OR c.id IN (
           SELECT customer_id FROM appointment
           WHERE business_id = $1
           GROUP BY customer_id
           HAVING MIN(date) >= $2 AND MIN(date) <= $3
         )
       )`,
    [businessId, prevRange.startDate, prevRange.endDate]
  );
  const prevNewCustomers = Number(prevNewCustomersQuery.rows[0]?.count ?? 0);

  // CÁLCULO DE MÉTRICAS ACTUALES
  const totalReservationsCount = currentAppointments.length;
  let completedCount = 0;
  let cancelledCount = 0;
  let noShowCount = 0;
  let totalRevenue = 0;

  for (const appt of currentAppointments) {
    if (appt.status === "COMPLETED") {
      completedCount++;
      totalRevenue += Number(appt.price ?? 0);
    } else if (appt.status === "CANCELLED") {
      cancelledCount++;
    } else if (appt.status === "NO_SHOW") {
      noShowCount++;
    }
  }

  // CÁLCULO DE MÉTRICAS PREVIAS
  const prevTotalReservationsCount = prevAppointments.length;
  let prevRevenue = 0;

  for (const appt of prevAppointments) {
    if (appt.status === "COMPLETED") {
      prevRevenue += Number(appt.price ?? 0);
    }
  }

  // Tasas porcentuales
  const completedRate = totalReservationsCount > 0
    ? Math.round((completedCount / totalReservationsCount) * 100)
    : 0;
  const cancelledRate = totalReservationsCount > 0
    ? Math.round((cancelledCount / totalReservationsCount) * 100)
    : 0;
  const noShowRate = totalReservationsCount > 0
    ? Math.round((noShowCount / totalReservationsCount) * 100)
    : 0;

  // Comparaciones
  const totalReservationsComparison = computeComparison(
    totalReservationsCount,
    prevTotalReservationsCount,
    currentRange.comparisonSuffix
  );

  const revenueComparison = computeComparison(
    totalRevenue,
    prevRevenue,
    currentRange.comparisonSuffix
  );

  const newCustomersComparison = computeComparison(
    currentNewCustomers,
    prevNewCustomers,
    currentRange.comparisonSuffix
  );

  // 5. CONSTRUCCIÓN DEL GRÁFICO 1: Reservas por día
  const startDateObj = parseDateISO(currentRange.startDate);
  const endDateObj = parseDateISO(currentRange.endDate);

  const dailyMap = new Map<string, {
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    revenue: number;
  }>();

  for (const appt of currentAppointments) {
    const existing = dailyMap.get(appt.date) || {
      total: 0,
      completed: 0,
      cancelled: 0,
      noShow: 0,
      revenue: 0,
    };
    existing.total++;
    if (appt.status === "COMPLETED") {
      existing.completed++;
      existing.revenue += Number(appt.price ?? 0);
    } else if (appt.status === "CANCELLED") {
      existing.cancelled++;
    } else if (appt.status === "NO_SHOW") {
      existing.noShow++;
    }
    dailyMap.set(appt.date, existing);
  }

  const dailyReservations: DailyPoint[] = [];
  let curr = new Date(startDateObj.getTime());
  let maxDailyTotal = 0;

  while (curr <= endDateObj) {
    const dateStr = formatDateISO(curr);
    const dayOfWeekIdx = curr.getUTCDay();
    const dayNum = curr.getUTCDate();
    const data = dailyMap.get(dateStr) || {
      total: 0,
      completed: 0,
      cancelled: 0,
      noShow: 0,
      revenue: 0,
    };

    if (data.total > maxDailyTotal) {
      maxDailyTotal = data.total;
    }

    dailyReservations.push({
      date: dateStr,
      dayLabel: period === "week" ? DAY_SHORT_ES[dayOfWeekIdx] : `${DAY_SHORT_ES[dayOfWeekIdx]} ${dayNum}`,
      fullDayName: DAY_NAMES_ES[dayOfWeekIdx],
      dayNumber: dayNum,
      total: data.total,
      completed: data.completed,
      cancelled: data.cancelled,
      noShow: data.noShow,
      revenue: data.revenue,
      isPeak: false,
    });

    curr = addDays(curr, 1);
  }

  // Marcar el pico de mayor actividad
  let peakDayInfo: {
    dayName: string;
    date: string;
    total: number;
    insight: string;
  } | null = null;

  if (maxDailyTotal > 0) {
    const peakPoints = dailyReservations.filter((d) => d.total === maxDailyTotal);
    for (const p of peakPoints) {
      p.isPeak = true;
    }

    const firstPeak = peakPoints[0];
    const peakDayName = firstPeak.fullDayName;
    peakDayInfo = {
      dayName: peakDayName,
      date: firstPeak.date,
      total: firstPeak.total,
      insight: `${peakDayName} es tu día de mayor actividad con ${firstPeak.total} ${firstPeak.total === 1 ? "reserva" : "reservas"}`,
    };
  }

  // 6. CONSTRUCCIÓN DEL GRÁFICO 2: Servicios más solicitados
  const serviceStatsMap = new Map<string, {
    id: string;
    name: string;
    durationMinutes: number;
    price: number;
    totalBookings: number;
    completedBookings: number;
    totalRevenue: number;
  }>();

  for (const appt of currentAppointments) {
    const existing = serviceStatsMap.get(appt.service_id) || {
      id: appt.service_id,
      name: appt.service_name || "Servicio",
      durationMinutes: appt.duration_minutes || 30,
      price: Number(appt.price || 0),
      totalBookings: 0,
      completedBookings: 0,
      totalRevenue: 0,
    };

    existing.totalBookings++;
    if (appt.status === "COMPLETED") {
      existing.completedBookings++;
      existing.totalRevenue += Number(appt.price || 0);
    }
    serviceStatsMap.set(appt.service_id, existing);
  }

  const popularServices: PopularService[] = Array.from(serviceStatsMap.values())
    .map((s) => ({
      ...s,
      percentage: totalReservationsCount > 0
        ? Math.round((s.totalBookings / totalReservationsCount) * 100)
        : 0,
    }))
    .sort((a, b) => b.totalBookings - a.totalBookings || b.totalRevenue - a.totalRevenue);

  return {
    period,
    currentRange,
    previousRange: prevRange,
    metrics: {
      totalReservations: totalReservationsComparison,
      completed: { count: completedCount, rate: completedRate },
      cancelled: { count: cancelledCount, rate: cancelledRate },
      noShow: { count: noShowCount, rate: noShowRate },
      newCustomers: newCustomersComparison,
      revenue: revenueComparison,
    },
    dailyReservations,
    peakDayInfo,
    popularServices,
    revenueDisclaimer: "Ingresos calculados a partir de los precios registrados en Kyrara.",
  };
}
