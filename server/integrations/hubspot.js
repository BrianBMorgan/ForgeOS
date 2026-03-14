const settingsManager = require("../settings/manager");

const HUBSPOT_BASE = "https://api.hubapi.com";

async function getToken() {
  const token = await settingsManager.getSecret("HUBSPOT_ACCESS_TOKEN");
  if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN not set in Global Secrets Vault");
  return token;
}

async function hubspotFetch(path, options = {}) {
  const token = await getToken();
  const url = `${HUBSPOT_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HubSpot API error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function searchContacts(query) {
  return hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      query,
      limit: 10,
      properties: ["email", "firstname", "lastname", "phone", "company", "hs_lead_status", "createdate"],
    }),
  });
}

async function getContact(id) {
  return hubspotFetch(`/crm/v3/objects/contacts/${id}?properties=email,firstname,lastname,phone,company,hs_lead_status`);
}

async function createContact(properties) {
  return hubspotFetch("/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties }),
  });
}

async function updateContact(id, properties) {
  return hubspotFetch(`/crm/v3/objects/contacts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function searchDeals(query) {
  return hubspotFetch("/crm/v3/objects/deals/search", {
    method: "POST",
    body: JSON.stringify({
      query,
      limit: 10,
      properties: ["dealname", "amount", "dealstage", "pipeline", "closedate", "createdate"],
    }),
  });
}

async function createDeal(properties, associatedContactId = null) {
  const deal = await hubspotFetch("/crm/v3/objects/deals", {
    method: "POST",
    body: JSON.stringify({ properties }),
  });
  if (associatedContactId && deal.id) {
    try {
      await hubspotFetch(
        `/crm/v4/objects/deals/${deal.id}/associations/contacts/${associatedContactId}/deal_to_contact`,
        {
          method: "PUT",
          body: JSON.stringify([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }]),
        }
      );
    } catch (err) {
      console.error("[hubspot] Failed to associate contact with deal:", err.message);
    }
  }
  return deal;
}

async function getStatus() {
  try {
    await hubspotFetch("/crm/v3/objects/contacts?limit=1");
    return { connected: true, message: "HubSpot API connected" };
  } catch (err) {
    return { connected: false, message: err.message };
  }
}

module.exports = { searchContacts, getContact, createContact, updateContact, searchDeals, createDeal, getStatus };
