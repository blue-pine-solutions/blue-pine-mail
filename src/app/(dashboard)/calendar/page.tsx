"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import toast, { Toaster } from "react-hot-toast";
import { AlignLeft, ChevronDown, ChevronLeft, ChevronRight, Clock3, MapPin, Palette, Plus, Repeat2, Trash2, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/auth/client";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { DEFAULT_REPEAT_DAYS, parseCalendarRepeatDays } from "@/lib/calendar/recurrence";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_OPTIONS } from "@/lib/folders/colors";
import type { CalendarRepeat } from "@/lib/calendar/types";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useSidebar } from "@/components/sidebar-state";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import type { CalendarEvent, CalendarView, EventDragPreview, EventResizeEdge, EventResizeSession } from "./types";
import {
  addDays, CALENDAR_END_HOUR, CALENDAR_HOUR_HEIGHT, CALENDAR_START_HOUR,
  currentTimePosition, dateKey, dropStartForPosition, EVENT_COLOR_CLASSES, eventEndAfterMinutes, eventPosition, expandCalendarEvents,
  formatEventRange, formatHour, formatLocalDateTime, groupUpcomingEvents,
  monthGridDates, nextCalendarOccurrence, PAST_EVENT_COLOR_CLASSES, resizeEventTimes, startOfDay, startOfWeek, takeUpcomingGroups, UPCOMING_BATCH_SIZE, WEEKDAY_OPTIONS,
} from "./utils";
import clsx from "clsx";

const eventFieldClass = "h-9 border-transparent bg-transparent px-2 shadow-none hover:bg-white/60 focus:border-blue-600 focus:bg-white focus:shadow-sm";

export default function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsVersion, setEventsVersion] = useState(0);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [visibleDate, setVisibleDate] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>("week");
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState(() => new Date());
  const monthPickerRef = useRef<HTMLDivElement | null>(null);
  const upcomingScrollRef = useRef<HTMLDivElement | null>(null);
  const upcomingSentinelRef = useRef<HTMLDivElement | null>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [draggedEvent, setDraggedEvent] = useState<CalendarEvent | null>(null);
  const [resizingEvent, setResizingEvent] = useState<CalendarEvent | null>(null);
  const [dragPreview, setDragPreview] = useState<EventDragPreview | null>(null);
  const dragOffsetPixels = useRef(0);
  const resizeSession = useRef<EventResizeSession | null>(null);
  const [title, setTitle] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_FOLDER_COLOR);
  const [repeat, setRepeat] = useState<CalendarRepeat>("none");
  const [repeatDays, setRepeatDays] = useState<number[]>(DEFAULT_REPEAT_DAYS);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [adding, setAdding] = useState(false);
  const [closingEventEditor, setClosingEventEditor] = useState(false);
  const [guests, setGuests] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | string | null>(null);
  const [visibleUpcomingCount, setVisibleUpcomingCount] = useState(UPCOMING_BATCH_SIZE);
  const { selectedMailbox } = useSelectedMailbox();
  const { minimal } = useSidebar();

  const today = useMemo(() => startOfDay(new Date()), []);
  const now = new Date(currentTime);
  const weekStart = useMemo(() => startOfWeek(visibleDate), [visibleDate]);
  const days = useMemo(
    () => view === "day" ? [startOfDay(visibleDate)] : Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [view, visibleDate, weekStart],
  );
  const upcomingGroups = useMemo(() => groupUpcomingEvents(events, today), [events, today]);
  const upcomingTotal = useMemo(() => upcomingGroups.reduce((count, group) => count + group.events.length, 0), [upcomingGroups]);
  const visibleUpcomingGroups = useMemo(() => takeUpcomingGroups(upcomingGroups, visibleUpcomingCount), [upcomingGroups, visibleUpcomingCount]);
  const pickerDates = useMemo(() => monthGridDates(pickerMonth), [pickerMonth]);
  const previewEvent = useMemo(() => dragPreview && (draggedEvent || resizingEvent)
    ? {
      ...(draggedEvent || resizingEvent)!,
      startsAt: dragPreview.startsAt.toISOString(),
      endsAt: dragPreview.endsAt.toISOString(),
    }
    : null, [dragPreview, draggedEvent, resizingEvent]);
  const previewPosition = useMemo(() => dragPreview && previewEvent
    ? eventPosition(previewEvent, dragPreview.day)
    : null, [dragPreview, previewEvent]);

  useEffect(() => {
    setHeaderTarget(document.getElementById("calendar-header-slot"));
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setVisibleUpcomingCount(UPCOMING_BATCH_SIZE);
  }, [events]);

  useEffect(() => {
    if (minimal || visibleUpcomingCount >= upcomingTotal || !upcomingScrollRef.current || !upcomingSentinelRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      setVisibleUpcomingCount((count) => Math.min(count + UPCOMING_BATCH_SIZE, upcomingTotal));
    }, { root: upcomingScrollRef.current, rootMargin: "0px 0px 100px 0px" });
    observer.observe(upcomingSentinelRef.current);
    return () => observer.disconnect();
  }, [minimal, upcomingTotal, visibleUpcomingCount]);

  useEffect(() => {
    if (!monthPickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!monthPickerRef.current?.contains(event.target as Node)) setMonthPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMonthPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [monthPickerOpen]);

  useEffect(() => {
    const start = new Date(Math.min(today.getTime(), weekStart.getTime(), startOfDay(visibleDate).getTime()));
    const end = new Date(Math.max(addDays(today, 90).getTime(), addDays(weekStart, 7).getTime(), addDays(visibleDate, 1).getTime()));
    void authFetch(`/api/calendar/events?start=${start.toISOString()}&end=${end.toISOString()}`)
      .then((response) => {
        if (!response.ok) throw new Error("Could not load calendar events.");
        return response.json();
      })
      .then((data) => setEvents(expandCalendarEvents(data.events ?? [], start, end)))
      .catch(() => toast.error("Could not load calendar events."));
  }, [today, visibleDate, weekStart, eventsVersion]);

  function openNewEvent(day = visibleDate, startAt?: Date) {
    const start = startAt ? new Date(startAt) : new Date(day);
    if (!startAt) start.setHours(Math.min(Math.max(new Date().getHours() + 1, CALENDAR_START_HOUR), CALENDAR_END_HOUR - 1), 0, 0, 0);
    setEditing(null);
    setTitle("");
    setColor(DEFAULT_FOLDER_COLOR);
    setRepeat("none");
    setRepeatDays(DEFAULT_REPEAT_DAYS);
    setGuests("");
    setLocation("");
    setDescription("");
    setStartsAt(formatLocalDateTime(start));
    setEndsAt(formatLocalDateTime(new Date(start.getTime() + 60 * 60_000)));
    setClosingEventEditor(false);
    setAdding(true);
  }

  async function addEvent() {
    setPendingAction("save");
    try {
      const editedStart = editing && startsAt === formatLocalDateTime(new Date(editing.startsAt)) ? new Date(editing.startsAt) : new Date(startsAt);
      const editedEnd = editing && endsAt === formatLocalDateTime(new Date(editing.endsAt)) ? new Date(editing.endsAt) : new Date(endsAt);
      const movingToPast = Boolean(editing && editing.repeat !== "none" && editedStart.getTime() < Date.now() && editedStart.getTime() !== new Date(editing.startsAt).getTime());
      const effectiveFrom = editing && editing.repeat !== "none" && !movingToPast ? new Date() : null;
      let savedStart = editedStart;
      let savedEnd = editedEnd;
      if (editing && effectiveFrom) {
        const offset = editedStart.getTime() - new Date(editing.startsAt).getTime();
        const next = nextCalendarOccurrence(editing, new Date(effectiveFrom.getTime() - offset));
        if (!next) { toast.error("No future occurrences remain to update."); return; }
        savedStart = new Date(next.getTime() + offset);
        savedEnd = new Date(savedStart.getTime() + editedEnd.getTime() - editedStart.getTime());
      }
      const repeatAnchorDay = editing?.repeat === "monthly" && startsAt.slice(0, 10) === formatLocalDateTime(new Date(editing.startsAt)).slice(0, 10)
        ? editing.repeatAnchorDay ?? new Date(editing.seriesStartsAt ?? editing.startsAt).getDate()
        : editedStart.getDate();
      const response = await authFetch(editing ? `/api/calendar/events/${editing.id}` : "/api/calendar/events", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title, startsAt: savedStart.toISOString(), endsAt: savedEnd.toISOString(), color, repeat, repeatDays, repeatAnchorDay, effectiveFrom: effectiveFrom?.toISOString(), moveOccurrenceToPast: movingToPast, attendees: guests.split(","),
          description,
          location,
          mailboxId: selectedMailbox?.id,
          from: selectedMailbox?.senderAddresses?.[0] ??
            (selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : ""),
        }),
      });
      if (response.ok) {
        setEventsVersion((version) => version + 1);
        setClosingEventEditor(true);
      } else {
        const result = await response.json();
        toast.error(result.error ?? "Could not save the event. Please try again.");
      }
    } catch {
      toast.error("Could not save the event. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteEvent(id: string) {
    const recurring = editing && editing.repeat !== "none";
    if (!window.confirm(recurring ? "Delete future occurrences from now?" : "Delete this event?")) return;
    setPendingAction(id);
    try {
      const effectiveFrom = recurring ? new Date().toISOString() : undefined;
      const response = await authFetch(`/api/calendar/events/${id}`, { method: "DELETE", headers: effectiveFrom ? { "Content-Type": "application/json" } : undefined, body: effectiveFrom ? JSON.stringify({ effectiveFrom }) : undefined });
      if (response.ok) {
        setEventsVersion((version) => version + 1);
        setClosingEventEditor(true);
      } else {
        const result = await response.json();
        toast.error(result.error ?? "Could not delete the event. Please try again.");
      }
    } catch {
      toast.error("Could not delete the event. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  function editEvent(event: CalendarEvent) {
    setEditing(event);
    setTitle(event.title);
    setColor(normalizeCalendarColor(event.color));
    setRepeat(event.repeat);
    setRepeatDays(event.repeat === "weekdays" ? parseCalendarRepeatDays(event.repeatDays) : DEFAULT_REPEAT_DAYS);
    setLocation(event.location ?? "");
    setDescription(event.description ?? "");
    setStartsAt(formatLocalDateTime(new Date(event.startsAt)));
    setEndsAt(formatLocalDateTime(new Date(event.endsAt)));
    setGuests(JSON.parse(event.attendees || "[]").join(", "));
    setClosingEventEditor(false);
    setAdding(true);
  }

  async function saveEventTimes(event: CalendarEvent, startsAt: Date, endsAt: Date) {
    if (startsAt.getTime() === new Date(event.startsAt).getTime() && endsAt.getTime() === new Date(event.endsAt).getTime()) {
      setDraggedEvent(null);
      setResizingEvent(null);
      setDragPreview(null);
      return;
    }
    setPendingAction(event.id);
    try {
      const movingToPast = event.repeat !== "none" && startsAt.getTime() < Date.now();
      const effectiveFrom = event.repeat !== "none" && !movingToPast ? new Date() : null;
      let savedStart = startsAt;
      let savedEnd = endsAt;
      if (effectiveFrom) {
        const offset = startsAt.getTime() - new Date(event.startsAt).getTime();
        const next = nextCalendarOccurrence(event, new Date(effectiveFrom.getTime() - offset));
        if (!next) { toast.error("No future occurrences remain to update."); return; }
        savedStart = new Date(next.getTime() + offset);
        savedEnd = new Date(savedStart.getTime() + endsAt.getTime() - startsAt.getTime());
      }
      const response = await authFetch(`/api/calendar/events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: event.title,
          description: event.description,
          location: event.location,
          attendees: JSON.parse(event.attendees || "[]"),
          color: event.color,
          repeat: event.repeat,
          repeatDays: parseCalendarRepeatDays(event.repeatDays),
          repeatAnchorDay: event.repeat === "monthly" && dateKey(startsAt) === dateKey(new Date(event.startsAt))
            ? event.repeatAnchorDay ?? new Date(event.seriesStartsAt ?? event.startsAt).getDate()
            : startsAt.getDate(),
          effectiveFrom: effectiveFrom?.toISOString(),
          moveOccurrenceToPast: movingToPast,
          startsAt: savedStart.toISOString(),
          endsAt: savedEnd.toISOString(),
          from: selectedMailbox?.senderAddresses?.[0] ??
            (selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : ""),
        }),
      });
      if (!response.ok) {
        toast.error("Could not update the event time. Please try again.");
        return;
      }
      setEventsVersion((version) => version + 1);
    } catch {
      toast.error("Could not update the event time. Please try again.");
    } finally {
      setDraggedEvent(null);
      setResizingEvent(null);
      setDragPreview(null);
      setPendingAction(null);
    }
  }

  function moveEvent(event: CalendarEvent, day: Date, pixelsFromTop: number) {
    const startsAt = dropStartForPosition(day, pixelsFromTop);
    const endsAt = new Date(startsAt.getTime() + new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime());
    void saveEventTimes(event, startsAt, endsAt);
  }

  function startResize(pointerEvent: ReactPointerEvent<HTMLButtonElement>, event: CalendarEvent, day: Date, edge: EventResizeEdge) {
    if (pendingAction !== null) return;
    const column = pointerEvent.currentTarget.parentElement;
    if (!column) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
    resizeSession.current = { event, day, edge, columnTop: column.getBoundingClientRect().top, pointerY: pointerEvent.clientY, moved: false };
    setResizingEvent(event);
    setDragPreview({ eventId: event.id, day, startsAt: new Date(event.startsAt), endsAt: new Date(event.endsAt) });
  }

  function updateResize(pointerEvent: ReactPointerEvent<HTMLButtonElement>) {
    const session = resizeSession.current;
    if (!session) return;
    if (Math.abs(pointerEvent.clientY - session.pointerY) < 3) return;
    session.moved = true;
    const times = resizeEventTimes(session.event, session.day, session.edge, pointerEvent.clientY - session.columnTop);
    setDragPreview({
      eventId: session.event.id,
      day: session.day,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
    });
  }

  function finishResize(pointerEvent: ReactPointerEvent<HTMLButtonElement>) {
    const session = resizeSession.current;
    if (!session) return;
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    resizeSession.current = null;
    if (!session.moved) {
      setResizingEvent(null);
      setDragPreview(null);
      return;
    }
    const times = resizeEventTimes(session.event, session.day, session.edge, pointerEvent.clientY - session.columnTop);
    void saveEventTimes(session.event, times.startsAt, times.endsAt);
  }

  function cancelResize() {
    resizeSession.current = null;
    setResizingEvent(null);
    setDragPreview(null);
  }

  return (
    <div className={clsx("flex h-full min-h-0 flex-col bg-[#f6f8fc] pl-3 lg:flex-row transition-[gap] duration-200 ease-in-out motion-reduce:transition-none", minimal ? "gap-0" : "gap-3")}>
      <Toaster position="bottom-right" />
      {headerTarget && createPortal(
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <div ref={monthPickerRef} className="relative shrink-0">
            <button type="button" onClick={() => {
              setPickerMonth(new Date(visibleDate.getFullYear(), visibleDate.getMonth(), 1));
              setMonthPickerOpen((open) => !open);
            }} className="flex items-center gap-2 whitespace-nowrap text-lg font-semibold text-neutral-900" aria-haspopup="dialog" aria-expanded={monthPickerOpen}>
              {visibleDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
              <ChevronDown className="h-5 w-5 text-neutral-500" />
            </button>
            {monthPickerOpen && (
              <div role="dialog" aria-label="Choose a calendar date" className="absolute left-0 top-full z-50 mt-3 w-[448px] max-w-[calc(100vw-24px)] rounded-2xl bg-[#f7f9fc] p-5 shadow-xl ring-1 ring-neutral-200/70">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold text-neutral-900">
                    {pickerMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                  </h2>
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label="Previous month" onClick={() => setPickerMonth(new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() - 1, 1))} className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/70">
                      <ChevronLeft className="h-6 w-6" />
                    </button>
                    <button type="button" aria-label="Next month" onClick={() => setPickerMonth(new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() + 1, 1))} className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/70">
                      <ChevronRight className="h-6 w-6" />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-7">
                  {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((weekday) => (
                    <span key={weekday} aria-label={weekday} className="flex h-10 items-center justify-center text-sm font-medium text-neutral-500">{weekday[0]}</span>
                  ))}
                  {pickerDates.map((day) => {
                    const selected = dateKey(day) === dateKey(visibleDate);
                    const isToday = dateKey(day) === dateKey(today);
                    const outsideMonth = day.getMonth() !== pickerMonth.getMonth();
                    return (
                      <button key={dateKey(day)} type="button" aria-label={day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} aria-pressed={selected}
                        onClick={() => { setVisibleDate(day); setMonthPickerOpen(false); }}
                        className={clsx("mx-auto my-0.5 flex h-11 w-11 items-center justify-center rounded-full text-base font-medium hover:bg-neutral-200/80",
                          selected ? "bg-blue-600 text-white hover:bg-blue-600" : isToday ? "bg-neutral-200 text-neutral-900" : outsideMonth ? "text-neutral-400" : "text-neutral-900")}>
                        {day.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" aria-label={`Previous ${view}`} onClick={() => setVisibleDate(addDays(visibleDate, view === "week" ? -7 : -1))} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-white"><ChevronLeft className="h-6 w-6" /></button>
            <button type="button" aria-label={`Next ${view}`} onClick={() => setVisibleDate(addDays(visibleDate, view === "week" ? 7 : 1))} className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-white"><ChevronRight className="h-6 w-6" /></button>
            <button type="button" onClick={() => setVisibleDate(new Date())} className="h-10 rounded-full bg-white px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Today</button>
            <div className="relative">
              <select value={view} onChange={(event) => setView(event.target.value as CalendarView)} aria-label="Calendar view" className="h-10 appearance-none rounded-full border-0 bg-white pl-4 pr-10 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
                <option value="week">Week</option>
                <option value="day">Day</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-600" />
            </div>
            <Button disabled={pendingAction !== null} onClick={() => openNewEvent()} className="ml-1 h-10 rounded-full bg-blue-600 px-4 text-white hover:bg-neutral-50"><Plus className="h-5 w-5" />New event</Button>
          </div>
        </div>,
        headerTarget,
      )}
      <aside className={clsx("relative shrink-0 rounded-t-3xl bg-white transition-[width,max-height] duration-200 ease-in-out motion-reduce:transition-none lg:h-full lg:max-h-none", minimal ? "w-0 max-h-0" : "w-full max-h-[36vh] lg:w-[var(--sidebar-width)]")} aria-hidden={minimal}>
        {!minimal && (
          <div ref={upcomingScrollRef} className="h-full overflow-y-auto overscroll-contain rounded-t-3xl px-5 py-5">
            {upcomingGroups.length === 0 ? (
              <div>
                <h2 className="text-lg font-semibold text-neutral-900">Upcoming</h2>
                <p className="mt-4 text-sm text-neutral-400">No upcoming events.</p>
              </div>
            ) : visibleUpcomingGroups.map((group) => (
              <section key={group.key} className="mb-6 last:mb-0">
                <h2 className="sticky -top-5 z-10 -mx-5 mb-2 bg-white px-5 py-2 text-base font-semibold text-neutral-900">{group.label}</h2>
                <div className="space-y-2">
                  {group.events.map((event) => (
                    <button key={event.id} type="button" onClick={() => editEvent(event)} className="group flex w-full items-start gap-3 text-left">
                      <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-white ring-1 ring-neutral-200" style={{ backgroundColor: normalizeCalendarColor(event.color) }} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-neutral-700 group-hover:text-neutral-950">{event.title}</span>
                        <span className="block text-xs text-neutral-400">{formatEventRange(event)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {visibleUpcomingCount < upcomingTotal && <div ref={upcomingSentinelRef} aria-hidden="true" className="h-1" />}
          </div>
        )}
        {!minimal && <div className="hidden lg:block"><SidebarResizeBoundary /></div>}
      </aside>

      <section className="min-h-0 min-w-0 flex-1 rounded-t-3xl bg-white flex flex-col overflow-hidden">
        <div className="sticky top-0 z-30 grid border-b border-neutral-200 bg-white h-14" style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div />
          {days.map((day) => (
            <div key={dateKey(day)} className={`border-l border-neutral-100 px-3 py-2 text-xs ${dateKey(day) === dateKey(today) ? "text-blue-700" : "text-neutral-700"}`}>
              {day.toLocaleDateString(undefined, { weekday: "short" })}
              <span className="text-2xl block font-medium">
                {day.toLocaleDateString(undefined, { day: "numeric" })}
              </span>
            </div>
          ))}
        </div>
        <div className={clsx("overflow-auto overscroll-contain flex-1 min-h-0", view === "week" ? "min-w-190" : "min-w-90")}>

          <div className="grid" style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))`, height: (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * CALENDAR_HOUR_HEIGHT }}>
            <div className="relative">
              {Array.from({ length: CALENDAR_END_HOUR - CALENDAR_START_HOUR }, (_, index) => (
                <span key={index} className={`absolute right-3 text-xs text-neutral-700 ${index === 0 ? "" : "-translate-y-1/2"}`} style={{ top: index * CALENDAR_HOUR_HEIGHT }}>{index % 2 == 0 ? null : formatHour(CALENDAR_START_HOUR + index)}</span>
              ))}
            </div>
            {days.map((day) => (
              <div key={dateKey(day)} className={"relative border-l border-neutral-100"}
                onDragOver={(event) => {
                  if (!draggedEvent) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const start = dropStartForPosition(day, event.clientY - event.currentTarget.getBoundingClientRect().top - dragOffsetPixels.current);
                  const end = new Date(start.getTime() + new Date(draggedEvent.endsAt).getTime() - new Date(draggedEvent.startsAt).getTime());
                  setDragPreview((current) => current?.eventId === draggedEvent.id && dateKey(current.day) === dateKey(day) && current.startsAt.getTime() === start.getTime()
                    ? current : { eventId: draggedEvent.id, day, startsAt: start, endsAt: end });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedEvent) void moveEvent(draggedEvent, day, event.clientY - event.currentTarget.getBoundingClientRect().top - dragOffsetPixels.current);
                }}
                style={{ backgroundImage: "linear-gradient(to bottom, transparent calc(100% - 1px), #f0f0f0 calc(100% - 1px))", backgroundSize: `100% ${CALENDAR_HOUR_HEIGHT}px` }}>
                <button type="button" aria-label={`Add event on ${day.toLocaleDateString()}`} onClick={(event) => openNewEvent(day, dropStartForPosition(day, event.nativeEvent.offsetY))} className="absolute inset-0 z-0 cursor-crosshair" />
                {events.filter((event) => new Date(event.startsAt) < addDays(day, 1) && new Date(event.endsAt) > day).map((event) => {
                  const position = eventPosition(event, day);
                  if (!position) return null;
                  const eventColor = normalizeCalendarColor(event.color);
                  const isPastEvent = new Date(event.endsAt).getTime() <= currentTime;
                  const canResizeStart = dateKey(new Date(event.startsAt)) === dateKey(day);
                  const canResizeEnd = new Date(event.endsAt).getTime() <= addDays(day, 1).getTime();
                  return (
                    <Fragment key={event.id}>
                      <button type="button" draggable={pendingAction === null} onClick={() => editEvent(event)}
                        onDragStart={(dragEvent) => { dragOffsetPixels.current = dragEvent.clientY - dragEvent.currentTarget.getBoundingClientRect().top; dragEvent.dataTransfer.setData("text/plain", event.id); dragEvent.dataTransfer.effectAllowed = "move"; setDraggedEvent(event); }}
                        onDragEnd={() => { setDraggedEvent(null); setDragPreview(null); }}
                        title={`${event.title} · ${formatEventRange(event)}`}
                        className={`absolute left-1 right-1 z-10 flex cursor-move flex-col items-start justify-start overflow-hidden rounded-lg pr-2 pl-4 text-left hover:brightness-95 ${isPastEvent ? PAST_EVENT_COLOR_CLASSES[eventColor] : EVENT_COLOR_CLASSES[eventColor]} ${position.height >= 20 ? "py-1.5" : "py-0"} ${draggedEvent?.id === event.id || resizingEvent?.id === event.id ? "opacity-40" : ""}`}
                        style={{ top: position.top, height: position.height }}>
                          <span className="absolute top-1 left-1 block h-[calc(100%-8px)] w-1 rounded-xl bg-current" />
                        {position.height >= 15 && <span className="block w-full truncate text-[12px] font-semibold leading-4">{event.title}</span>}
                        {position.height >= 34 && <span className="block w-full truncate text-[11px] leading-4 opacity-70">{formatEventRange(event)}</span>}
                      </button>
                      {(["start", "end"] as const).filter((edge) => edge === "start" ? canResizeStart : canResizeEnd).map((edge) => (
                        <button key={edge} type="button" draggable={false}
                          aria-label={`Resize ${edge} of ${event.title}`}
                          onPointerDown={(pointerEvent) => startResize(pointerEvent, event, day, edge)}
                          onPointerMove={updateResize}
                          onPointerUp={finishResize}
                          onPointerCancel={cancelResize}
                          onClick={(clickEvent) => clickEvent.stopPropagation()}
                          className={clsx(edge === "start" ? "cursor-n-resize" : "cursor-s-resize", "absolute left-1 right-1 z-20 h-2 touch-none bg-transparent focus-visible:outline-2 focus-visible:outline-blue-500")}
                          style={{ top: edge === "start" ? position.top - 4 : position.top + position.height - 4 }} />
                      ))}
                    </Fragment>
                  );
                })}
                {dragPreview && previewEvent && previewPosition && dateKey(dragPreview.day) === dateKey(day) && (
                  <div className={`pointer-events-none absolute left-1 right-1 z-20 rounded-lg border-2 border-dashed border-white ${new Date(previewEvent.endsAt).getTime() <= currentTime ? PAST_EVENT_COLOR_CLASSES[normalizeCalendarColor(previewEvent.color)] : EVENT_COLOR_CLASSES[normalizeCalendarColor(previewEvent.color)]}`}
                    style={{ top: previewPosition.top, height: previewPosition.height }}>
                    <span className="absolute left-1 top-0 z-10 whitespace-nowrap rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {formatEventRange(previewEvent)}
                    </span>
                    {previewPosition.height >= 50 && <span className="block truncate px-2 pt-6 text-[12px] font-semibold">{previewEvent.title}</span>}
                  </div>
                )}
                {dateKey(day) === dateKey(now) && (
                  <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-30" style={{ top: currentTimePosition(now) }}>
                    <div className="h-1 w-full bg-blue-600" />
                    <div className="absolute -left-2.5 -top-2 h-5 w-5 rounded-full bg-blue-600" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {adding && (
        <div className={clsx("dialog-overlay fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/35 p-4", closingEventEditor && "pointer-events-none")} data-state={closingEventEditor ? "closed" : "open"}>
          <div role="dialog" aria-modal="true" aria-label={editing ? "Edit event" : "Create event"} className="dialog-content max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6" data-state={closingEventEditor ? "closed" : "open"}
            onAnimationEnd={(event) => {
              if (!closingEventEditor || event.target !== event.currentTarget) return;
              setAdding(false);
              setEditing(null);
              setClosingEventEditor(false);
            }}>
            <div className="flex items-start gap-3">
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add title" aria-label="Event name"
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-2xl font-medium text-neutral-900 outline-none placeholder:text-neutral-500 hover:bg-white/60 focus:border-blue-600 focus:bg-white" />
              <button type="button" aria-label="Close event editor" disabled={pendingAction === "save"} onClick={() => setClosingEventEditor(true)} className="shrink-0 rounded-full p-1 text-neutral-600 hover:bg-neutral-200 disabled:opacity-50"><X className="h-5 w-5" /></button>
            </div>
            <div className="mt-4 space-y-2">
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3">
                <Repeat2 aria-hidden="true" className="mt-2 h-5 w-5 text-neutral-600" />
                <div className="min-w-0">
                  <select value={repeat} onChange={(event) => setRepeat(event.target.value as CalendarRepeat)} aria-label="Repeat"
                    className="h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-sm text-neutral-700 outline-none hover:bg-neutral-50 focus:border-blue-600 focus:bg-white">
                    <option value="none">Does not repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="weekdays">Weekdays</option>
                  </select>
                  {repeat === "weekdays" && (
                    <div role="group" aria-label="Repeat on weekdays" className="flex flex-wrap gap-1.5 px-2 pt-1">
                      {WEEKDAY_OPTIONS.map((day) => (
                        <button key={day.value} type="button" aria-label={`Repeat on ${day.label}`} aria-pressed={repeatDays.includes(day.value)}
                          onClick={() => setRepeatDays((selected) => selected.includes(day.value) ? selected.filter((value) => value !== day.value) : [...selected, day.value].sort((a, b) => a - b))}
                          className={clsx("rounded-full px-2.5 py-1 text-xs font-medium", repeatDays.includes(day.value) ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")}>
                          {day.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3">
                <Clock3 aria-hidden="true" className="mt-2 h-5 w-5 text-neutral-600" />
                <div className="group min-w-0">
                  <div className="grid gap-1 sm:grid-cols-2">
                    <label className="relative block min-w-0">
                      <span className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 text-xs font-medium text-neutral-500">From</span>
                      <Input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} aria-label="From date and time" className={`${eventFieldClass} pl-14`} />
                    </label>
                    <label className="relative block min-w-0">
                      <span className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2 text-xs font-medium text-neutral-500">To</span>
                      <Input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} aria-label="To date and time" className={`${eventFieldClass} pl-14`} />
                    </label>
                  </div>
                  <div className="hidden flex-wrap gap-1 pt-1 group-focus-within:flex" aria-label="Set event duration">
                    {([{ label: "15 mins", minutes: 15 }, { label: "30 mins", minutes: 30 }, { label: "1 hour", minutes: 60 }, { label: "1 day", minutes: 1440 }] as const).map((preset) => (
                      <Button key={preset.minutes} type="button" variant="ghost" disabled={!startsAt || Number.isNaN(new Date(startsAt).getTime())} onClick={() => setEndsAt(eventEndAfterMinutes(startsAt, preset.minutes))} className="h-7 rounded-full px-2 text-xs text-neutral-600 hover:bg-neutral-100">
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-3">
                <UsersRound aria-hidden="true" className="h-5 w-5 text-neutral-600" />
                <Input value={guests} onChange={(event) => setGuests(event.target.value)} placeholder="Add guests" aria-label="Guests (comma-separated emails)" className={eventFieldClass} />
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-3">
                <MapPin aria-hidden="true" className="h-5 w-5 text-neutral-600" />
                <Input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Add location" aria-label="Location" className={eventFieldClass} />
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3">
                <AlignLeft aria-hidden="true" className="mt-2 h-5 w-5 text-neutral-600" />
                <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description" aria-label="Description" rows={1} className="min-h-9 resize-none border-transparent bg-transparent px-2 py-2 shadow-none hover:bg-white/60 focus:min-h-24 focus:resize-y focus:border-blue-600 focus:bg-white focus-visible:ring-0" />
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-3">
                <Palette aria-hidden="true" className="h-5 w-5 text-neutral-600" />
                <div role="radiogroup" aria-label="Event color" className="flex flex-wrap items-center gap-1.5 px-2">
                  {FOLDER_COLOR_OPTIONS.map((option) => (
                    <button key={option.value} type="button" role="radio" aria-label={option.label} title={option.label} aria-checked={color === option.value} onClick={() => setColor(option.value)}
                      className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${color === option.value ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2" : "border-transparent"}`}
                      style={{ backgroundColor: option.value }} />
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 pt-6">
                <div />
                <div className="flex justify-between gap-2">
                  <div>{editing && <Button variant="ghost" disabled={pendingAction !== null} onClick={() => void deleteEvent(editing.id)} className="px-2 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" />Delete</Button>}</div>
                  <Button onClick={() => void addEvent()} disabled={!title.trim() || !startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt) || (repeat === "weekdays" && repeatDays.length === 0) || pendingAction === "save"} className="rounded-full bg-blue-600 px-6 text-white hover:bg-blue-700">
                    {pendingAction === "save" ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
