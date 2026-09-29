import type { CalendarEvent, EventGroup, EventResizeEdge } from "./types";
import type { FolderColor } from "@/lib/folders/types";
import type { CalendarRepeat } from "@/lib/calendar/types";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";

export const CALENDAR_START_HOUR = 0;
export const CALENDAR_END_HOUR = 24;
export const CALENDAR_HOUR_HEIGHT = 36;
export const UPCOMING_BATCH_SIZE = 14;
export const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sun" }, { value: 1, label: "Mon" }, { value: 2, label: "Tue" },
  { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;

export const EVENT_COLOR_CLASSES: Record<FolderColor, string> = {
  "#2563eb": "bg-blue-600 text-white",
  "#7c3aed": "bg-violet-600 text-white",
  "#db2777": "bg-pink-600 text-white",
  "#dc2626": "bg-red-600 text-white",
  "#ea580c": "bg-orange-600 text-white",
  "#d97706": "bg-amber-600 text-white",
  "#16a34a": "bg-green-600 text-white",
  "#0d9488": "bg-teal-600 text-white",
};

export const PAST_EVENT_COLOR_CLASSES: Record<FolderColor, string> = {
  "#2563eb": "bg-blue-200 text-blue-900",
  "#7c3aed": "bg-violet-200 text-violet-900",
  "#db2777": "bg-pink-200 text-pink-900",
  "#dc2626": "bg-red-200 text-red-900",
  "#ea580c": "bg-orange-200 text-orange-900",
  "#d97706": "bg-amber-200 text-amber-900",
  "#16a34a": "bg-green-200 text-green-900",
  "#0d9488": "bg-teal-200 text-teal-900",
};

function recurringStart(first: Date, repeat: CalendarRepeat, index: number, anchorDay = first.getDate()): Date {
  if (repeat === "monthly") {
    const monthStart = new Date(first.getFullYear(), first.getMonth() + index, 1);
    const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    return new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(anchorDay, lastDay), first.getHours(), first.getMinutes(), first.getSeconds(), first.getMilliseconds());
  }
  return new Date(first.getFullYear(), first.getMonth(), first.getDate() + index * (repeat === "weekly" ? 7 : 1), first.getHours(), first.getMinutes(), first.getSeconds(), first.getMilliseconds());
}

export function expandCalendarEvents(events: CalendarEvent[], rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
  const occurrences: CalendarEvent[] = [];
  for (const event of events) {
    const first = new Date(event.startsAt);
    const duration = new Date(event.endsAt).getTime() - first.getTime();
    if (event.repeat === "none") {
      if (first < rangeEnd && first.getTime() + duration > rangeStart.getTime()) occurrences.push(event);
      continue;
    }
    const until = event.repeatUntil ? new Date(event.repeatUntil).getTime() : Infinity;
    const repeatDays = parseCalendarRepeatDays(event.repeatDays);
    const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
    for (let index = 0; index < 20_000; index++) {
      const startsAt = recurringStart(first, event.repeat, index, event.repeatAnchorDay ?? first.getDate());
      if (startsAt >= rangeEnd || startsAt.getTime() >= until) break;
      if (excluded.has(startsAt.getTime()) || (event.repeat === "weekdays" && !repeatDays.includes(startsAt.getDay()))) continue;
      const endsAt = new Date(startsAt.getTime() + duration);
      if (endsAt > rangeStart) occurrences.push({ ...event, id: `${event.id}@${startsAt.getTime()}`, seriesStartsAt: event.startsAt, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    }
  }
  return occurrences.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export function nextCalendarOccurrence(event: CalendarEvent, after: Date): Date | null {
  const first = new Date(event.seriesStartsAt ?? event.startsAt);
  const until = event.repeatUntil ? new Date(event.repeatUntil).getTime() : Infinity;
  const repeatDays = parseCalendarRepeatDays(event.repeatDays);
  const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
  for (let index = 0; index < 20_000; index++) {
    const startsAt = recurringStart(first, event.repeat, index, event.repeatAnchorDay ?? first.getDate());
    if (startsAt.getTime() >= until) return null;
    if (startsAt < after || excluded.has(startsAt.getTime()) || (event.repeat === "weekdays" && !repeatDays.includes(startsAt.getDay()))) continue;
    return startsAt;
  }
  return null;
}

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

export function monthGridDates(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

export function startOfWeek(value: Date): Date {
  return addDays(startOfDay(value), -value.getDay());
}

export function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function formatLocalDateTime(value: Date): string {
  return `${dateKey(value)}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

export function eventEndAfterMinutes(start: string, minutes: number): string {
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return "";
  return formatLocalDateTime(new Date(startDate.getTime() + minutes * 60_000));
}

export function currentTimePosition(value: Date): number {
  return ((value.getHours() - CALENDAR_START_HOUR) * 60 + value.getMinutes() + value.getSeconds() / 60) * CALENDAR_HOUR_HEIGHT / 60;
}

export function formatHour(hour: number): string {
  return new Date(2026, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

export function formatEventTime(value: Date): string {
  return value.toLocaleTimeString(undefined, { hour: "numeric", minute: value.getMinutes() ? "2-digit" : undefined });
}

export function formatEventRange(event: CalendarEvent): string {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  return `${formatEventTime(start)} – ${formatEventTime(end)}`;
}

export function groupUpcomingEvents(events: CalendarEvent[], today: Date): EventGroup[] {
  const todayStart = startOfDay(today);
  const tomorrowStart = addDays(todayStart, 1);
  const groups: EventGroup[] = [];

  for (const event of events) {
    const eventDate = startOfDay(new Date(event.startsAt));
    if (eventDate < todayStart) continue;
    const key = dateKey(eventDate);
    const label = key === dateKey(todayStart)
      ? "Today"
      : key === dateKey(tomorrowStart)
        ? "Tomorrow"
        : eventDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.key === key) lastGroup.events.push(event);
    else groups.push({ key, label, events: [event] });
  }

  return groups;
}

export function takeUpcomingGroups(groups: EventGroup[], count: number): EventGroup[] {
  const visible: EventGroup[] = [];
  let remaining = count;
  for (const group of groups) {
    if (remaining <= 0) break;
    const events = group.events.slice(0, remaining);
    if (events.length) visible.push({ ...group, events });
    remaining -= events.length;
  }
  return visible;
}

export function eventPosition(event: CalendarEvent, day: Date): { top: number; height: number } | null {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const dayStart = startOfDay(day).getTime();
  const startMinutes = Math.max(CALENDAR_START_HOUR * 60, (start.getTime() - dayStart) / 60_000);
  const endMinutes = Math.min(CALENDAR_END_HOUR * 60, (end.getTime() - dayStart) / 60_000);
  if (endMinutes <= startMinutes) return null;
  return {
    top: (startMinutes - CALENDAR_START_HOUR * 60) * CALENDAR_HOUR_HEIGHT / 60,
    height: (endMinutes - startMinutes) * CALENDAR_HOUR_HEIGHT / 60,
  };
}

export function dropStartForPosition(day: Date, pixelsFromTop: number): Date {
  const minutes = Math.max(0, Math.min(24 * 60 - 15, Math.round(pixelsFromTop * 60 / CALENDAR_HOUR_HEIGHT / 15) * 15));
  const start = startOfDay(day);
  start.setMinutes(minutes);
  return start;
}

export function resizeEventTimes(event: CalendarEvent, day: Date, edge: EventResizeEdge, pixelsFromTop: number): { startsAt: Date; endsAt: Date } {
  const minimum = edge === "start" ? 0 : 15;
  const maximum = edge === "start" ? 24 * 60 - 15 : 24 * 60;
  const minutes = Math.max(minimum, Math.min(maximum, Math.round(pixelsFromTop * 60 / CALENDAR_HOUR_HEIGHT / 15) * 15));
  const boundary = startOfDay(day);
  boundary.setMinutes(minutes);
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  if (edge === "start") {
    return { startsAt: new Date(Math.min(boundary.getTime(), endsAt.getTime() - 15 * 60_000)), endsAt };
  }
  return { startsAt, endsAt: new Date(Math.max(boundary.getTime(), startsAt.getTime() + 15 * 60_000)) };
}
