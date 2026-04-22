"use strict";

const { googleFetch, jsonOrThrow } = require("./auth");

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

async function listCalendars() {
  const res = await googleFetch(`${CAL_BASE}/users/me/calendarList`);
  const data = await jsonOrThrow(res, "calendar.calendarList.list");
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: !!c.primary,
    accessRole: c.accessRole,
    timeZone: c.timeZone,
  }));
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function listEvents({ calendarId = "primary", timeMin, timeMax, q, maxResults = 25 }) {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(250, maxResults)),
  });
  if (timeMin) params.set("timeMin", toIso(timeMin));
  if (timeMax) params.set("timeMax", toIso(timeMax));
  if (q) params.set("q", q);
  const res = await googleFetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
  const data = await jsonOrThrow(res, "calendar.events.list");
  return (data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    attendees: (e.attendees || []).map((a) => ({ email: a.email, responseStatus: a.responseStatus })),
    htmlLink: e.htmlLink,
    status: e.status,
  }));
}

async function getEvent({ calendarId = "primary", eventId }) {
  const res = await googleFetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  return jsonOrThrow(res, "calendar.events.get");
}

async function createEvent({ calendarId = "primary", summary, description, location, start, end, attendees, timeZone, sendUpdates = "none" }) {
  const payload = {
    summary,
    description,
    location,
    start: typeof start === "string" ? { dateTime: start, timeZone } : start,
    end: typeof end === "string" ? { dateTime: end, timeZone } : end,
  };
  if (attendees && attendees.length) {
    payload.attendees = attendees.map((a) => (typeof a === "string" ? { email: a } : a));
  }
  const res = await googleFetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${encodeURIComponent(sendUpdates)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
  );
  return jsonOrThrow(res, "calendar.events.insert");
}

async function updateEvent({ calendarId = "primary", eventId, patch, sendUpdates = "none" }) {
  const res = await googleFetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }
  );
  return jsonOrThrow(res, "calendar.events.patch");
}

async function deleteEvent({ calendarId = "primary", eventId, sendUpdates = "none" }) {
  const res = await googleFetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`,
    { method: "DELETE" }
  );
  if (!res.ok && res.status !== 204 && res.status !== 410) {
    return jsonOrThrow(res, "calendar.events.delete");
  }
  return { deleted: true, eventId };
}

module.exports = {
  listCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
};
