import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((text, tone = "info", ms = 4000) => {
    idRef.current += 1;
    const id = idRef.current;
    setItems((xs) => [...xs.slice(-2), { id, text, tone }]);
    if (ms) setTimeout(() => dismiss(id), ms);
  }, [dismiss]);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button type="button" aria-label="Fermer" onClick={() => dismiss(t.id)}><X size={16} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// Message d'erreur commun. 403 : texte imposé par le cahier, jamais de donnée masquée.
export function errorText(err) {
  if (!err) return "Une erreur est survenue.";
  if (err.status === 403) return "Tu n'as pas accès à cette action.";
  if (err.status === 0) return "Pas de connexion au serveur. Réessaie.";
  return err.detail || err.message || "Une erreur est survenue.";
}
