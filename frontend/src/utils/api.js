/**
 * api.js — FIS data loading utilities.
 *
 * In production, data is served from GCS public URLs or a Cloud Function proxy.
 * In development, falls back to sample JSON files in public/.
 *
 * Data sources (set in .env.local or environment):
 *   VITE_GCS_BASE_URL  — GCS base URL (e.g. https://storage.googleapis.com/water4-fis-data)
 *   VITE_API_BASE_URL  — Cloud Function base URL for on-demand refresh endpoints
 */

const GCS_BASE  = import.meta.env.VITE_GCS_BASE_URL  || `${import.meta.env.BASE_URL}sample-data`
const API_BASE  = import.meta.env.VITE_API_BASE_URL   || null

export async function fetchDonors() {
  const r = await fetch(`${GCS_BASE}/donors/latest.json`)
  if (!r.ok) throw new Error(`Failed to load donors: ${r.status}`)
  return r.json()
}

export async function fetchCampaigns() {
  const r = await fetch(`${GCS_BASE}/campaigns/latest.json`)
  if (!r.ok) throw new Error(`Failed to load campaigns: ${r.status}`)
  return r.json()
}

export async function fetchActions() {
  const r = await fetch(`${GCS_BASE}/actions/latest.json`)
  if (!r.ok) throw new Error(`Failed to load actions: ${r.status}`)
  return r.json()
}

/**
 * Trigger on-demand re-analysis of a single donor.
 * Requires VITE_API_BASE_URL to be set.
 */
export async function refreshDonor(sfId) {
  if (!API_BASE) throw new Error('VITE_API_BASE_URL not configured')
  const r = await fetch(`${API_BASE}/analyze_donor?sf_id=${encodeURIComponent(sfId)}`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`Refresh failed: ${r.status}`)
  return r.json()
}

/**
 * Trigger on-demand re-analysis of a single campaign.
 */
export async function refreshCampaign(sfId) {
  if (!API_BASE) throw new Error('VITE_API_BASE_URL not configured')
  const r = await fetch(`${API_BASE}/analyze_campaign?sf_id=${encodeURIComponent(sfId)}`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`Refresh failed: ${r.status}`)
  return r.json()
}
