import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, configureApi } from "../lib/api";
import { clearAll, load, save } from "../lib/storage";

const AuthContext = createContext(null);

// Texte des écrans bloquants (cahier, section 5).
export const BLOCK_TEXT = {
  replaced: (device) =>
    device === "scanner"
      ? "Tu as été déconnecté : ton scanner a été ouvert sur un autre appareil"
      : "Tu as été déconnecté : ta caisse a été ouverte sur un autre appareil",
  disabled: "Ton compte a été désactivé. Contacte le propriétaire.",
};

export function AuthProvider({ children }) {
  const [auth, setAuthState] = useState(() => load("session"));
  const [block, setBlock] = useState(null); // {kind:"replaced"|"disabled"|"ended", device?, message?}
  const [ready, setReady] = useState(!load("session"));
  const authRef = useRef(auth);
  const switchingRef = useRef(false);

  const setAuth = useCallback((next) => {
    authRef.current = next;
    save("session", next);
    setAuthState(next);
  }, []);

  const fromResponse = (res) => ({
    token: res.access_token,
    user: res.user,
    business: res.business,
    device: res.session?.device_type || "caisse",
  });

  const raiseBlock = useCallback((b) => {
    setBlock((cur) => cur || b); // un seul écran bloquant, jamais en boucle
  }, []);

  const onAuthFailure = useCallback((err) => {
    if (switchingRef.current) return;
    const device = authRef.current?.device;
    if (err.code === "ACCOUNT_DISABLED") raiseBlock({ kind: "disabled" });
    else if (err.code === "SESSION_REPLACED") raiseBlock({ kind: "replaced", device });
    else if (err.code === "SESSION_ENDED") raiseBlock({ kind: "ended", message: err.detail });
    else raiseBlock({ kind: "ended", message: "Ta session a expiré. Reconnecte-toi." });
  }, [raiseBlock]);

  // Messages de fin de session reçus par WebSocket (caisse ou scanner).
  const onSocketFatal = useCallback((msg, device) => {
    if (switchingRef.current) return;
    if (msg.type === "session_replaced" || msg.code === "SESSION_REPLACED") {
      raiseBlock({ kind: "replaced", device });
    } else if (msg.type === "session_ended") {
      if (msg.reason === "account_disabled") raiseBlock({ kind: "disabled" });
      else raiseBlock({ kind: "ended", message: msg.message || "Session terminée. Reconnecte-toi." });
    } else if (msg.type === "auth_error") {
      if (msg.code === "SESSION_ENDED") raiseBlock({ kind: "ended", message: msg.message });
      else if (msg.code !== "WRONG_DEVICE_TYPE") raiseBlock({ kind: "ended", message: "Ta session a expiré. Reconnecte-toi." });
    }
  }, [raiseBlock]);

  // Configuré pendant le rendu, et pas dans un effet : les effets des enfants (produits, panier) s'exécutent
  // avant ceux du parent, et leurs premières requêtes partiraient sans jeton après un rechargement.
  configureApi({ getToken: () => authRef.current?.token, onAuthFailure });

  // Au démarrage : on revalide la session et le rôle auprès de /auth/me (source de vérité).
  useEffect(() => {
    if (!authRef.current?.token) return;
    let alive = true;
    api.get("/auth/me")
      .then((me) => {
        if (!alive) return;
        setAuth({ ...authRef.current, user: me.user, business: me.business, device: me.session.device_type });
      })
      .catch(() => { /* 401 : écran bloquant ; réseau : on garde la session locale */ })
      .finally(() => alive && setReady(true));
    return () => { alive = false; };
  }, [setAuth]);

  // Jeton renouvelé régulièrement pour la même session.
  useEffect(() => {
    if (!auth?.token) return undefined;
    const t = setInterval(() => {
      api.post("/auth/refresh").then((r) => setAuth({ ...authRef.current, token: r.access_token })).catch(() => {});
    }, 3 * 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [auth?.token, setAuth]);

  const login = useCallback(async (identifier, password, deviceType = "caisse") => {
    const id = identifier.trim().toLowerCase();
    const body = { password, device_type: deviceType, ...(id.includes("@") ? { email: id } : { username: id }) };
    const res = await api.post("/auth/login", body, { auth: false });
    clearAll([`cart.${res.user.id}`, `attempt.${res.user.id}`]); // on garde seulement le panier et la tentative de ce compte
    setBlock(null);
    setAuth(fromResponse(res));
    return fromResponse(res);
  }, [setAuth]);

  const switchMode = useCallback(async (deviceType) => {
    switchingRef.current = true;
    try {
      const res = await api.post("/auth/switch-mode", { device_type: deviceType });
      const cart = load(`cart.${authRef.current?.user?.id}`);
      setAuth(fromResponse(res));
      if (cart) save(`cart.${res.user.id}`, cart);
      return fromResponse(res);
    } finally {
      setTimeout(() => { switchingRef.current = false; }, 1500);
    }
  }, [setAuth]);

  // keepCart : après un écran bloquant (session remplacée, expirée), le panier du compte est gardé
  // pour la reconnexion. La déconnexion volontaire efface tout.
  const wipe = useCallback((keepCart = false) => {
    const uid = authRef.current?.user?.id;
    clearAll(keepCart && uid ? [`cart.${uid}`, `attempt.${uid}`] : []);
    authRef.current = null;
    setAuthState(null);
    setBlock(null);
  }, []);

  const logout = useCallback(async () => {
    switchingRef.current = true;
    try { await api.post("/auth/logout"); } catch { /* la session locale est effacée quoi qu'il arrive */ }
    wipe(false);
    setTimeout(() => { switchingRef.current = false; }, 500);
  }, [wipe]);

  const updateBusiness = useCallback((business) => setAuth({ ...authRef.current, business }), [setAuth]);

  const value = useMemo(() => ({
    auth,
    ready,
    block,
    isOwner: auth?.user?.role === "owner",
    login,
    logout,
    switchMode,
    wipe,
    onSocketFatal,
    updateBusiness,
    getToken: () => authRef.current?.token,
  }), [auth, ready, block, login, logout, switchMode, wipe, onSocketFatal, updateBusiness]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
