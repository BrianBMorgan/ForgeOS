"use strict";

const { googleFetch, jsonOrThrow } = require("./auth");

const PEOPLE_BASE = "https://people.googleapis.com/v1";
const DEFAULT_FIELDS = "names,emailAddresses,phoneNumbers,organizations,metadata";

async function searchContacts(query, { pageSize = 20 } = {}) {
  // Warm the cache first — People API requires this before the first search.
  await googleFetch(`${PEOPLE_BASE}/people:searchContacts?query=&pageSize=1&readMask=names`);
  const url = `${PEOPLE_BASE}/people:searchContacts?query=${encodeURIComponent(query || "")}&pageSize=${Math.min(30, pageSize)}&readMask=${encodeURIComponent(DEFAULT_FIELDS)}`;
  const res = await googleFetch(url);
  const data = await jsonOrThrow(res, "people.searchContacts");
  return (data.results || []).map((r) => normalizePerson(r.person));
}

function normalizePerson(p) {
  if (!p) return null;
  return {
    resourceName: p.resourceName,
    names: (p.names || []).map((n) => ({ displayName: n.displayName, givenName: n.givenName, familyName: n.familyName })),
    emails: (p.emailAddresses || []).map((e) => ({ value: e.value, type: e.type })),
    phones: (p.phoneNumbers || []).map((ph) => ({ value: ph.value, type: ph.type })),
    organizations: (p.organizations || []).map((o) => ({ name: o.name, title: o.title })),
  };
}

module.exports = {
  searchContacts,
};
