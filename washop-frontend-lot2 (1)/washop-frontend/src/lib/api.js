// Client HTTP. Le jeton passe UNIQUEMENT dans l'en-tête Authorization, jamais dans l'URL.
const env = import.meta.env || {};
export const API_ROOT = `${String(env.VITE_API_URL || "").replace(/\/+$/, "")}/api`;

export class ApiError extends Error {
  constructor(status, detail, code, data) {
    super(detail || "Erreur");
    this.status = status; // 0 = erreur réseau (aucune réponse du serveur)
    this.detail = detail;
    this.code = code || null;
    this.data = data || {};
  }
  get isNetwork() { return this.status === 0; }
  get isForbidden() { return this.status === 403; }
}

let tokenGetter = () => null;
let authFailureHandler = () => {};

export function configureApi({ getToken, onAuthFailure }) {
  tokenGetter = getToken;
  authFailureHandler = onAuthFailure;
}

async function request(method, path, { body, query, raw, auth = true, signal } = {}) {
  let url = API_ROOT + path;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers = {};
  const token = auth ? tokenGetter() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, "Pas de connexion au serveur.", "NETWORK");
  }

  if (res.ok) {
    if (raw) return res.blob();
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  let data = {};
  try { data = await res.json(); } catch { /* corps vide */ }
  const detail = typeof data.detail === "string" ? data.detail : "Une erreur est survenue.";
  const err = new ApiError(res.status, detail, data.code, data);
  // 401 sur une requête authentifiée : session remplacée, terminée ou expirée. Un seul traitement central.
  if (res.status === 401 && token) authFailureHandler(err);
  throw err;
}

export const api = {
  get: (path, opts) => request("GET", path, opts),
  post: (path, body, opts) => request("POST", path, { ...opts, body }),
  patch: (path, body, opts) => request("PATCH", path, { ...opts, body }),
  put: (path, body, opts) => request("PUT", path, { ...opts, body }),
  del: (path, body, opts) => request("DELETE", path, { ...opts, body }),
  blob: (method, path, body) => request(method, path, { body, raw: true }),
};

export function wsUrl(path) {
  const u = new URL(API_ROOT + path, window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

// Ouvre un PDF ou une image protégée (facture, planche de QR) sans mettre le jeton dans l'URL.
export async function openBlob(method, path, body) {
  const win = window.open("", "_blank");
  try {
    const blob = await api.blob(method, path, body);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

// Récupère tous les produits actifs (pages de 100). Pour un petit commerce, c'est quelques requêtes.
export async function fetchAllProducts({ includeArchived = false } = {}) {
  const out = [];
  let page = 1;
  for (;;) {
    const res = await api.get("/products", { query: { page, page_size: 100, include_archived: includeArchived || undefined } });
    out.push(...res.items);
    if (out.length >= res.total || res.items.length === 0) break;
    page += 1;
  }
  return out;
}
