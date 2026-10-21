// Données locales de session. Une déconnexion efface tout ce qui commence par « washop. ».
const PREFIX = "washop.";

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* stockage plein ou désactivé : on continue en mémoire */
  }
}

export function clearAll(keep = []) {
  const kept = keep.map((k) => PREFIX + k);
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(PREFIX) && !kept.includes(k)).forEach((k) => localStorage.removeItem(k));
    Object.keys(sessionStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* rien */
  }
}
