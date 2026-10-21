// Connexion temps réel de la caisse : reçoit les scans du téléphone scanner du même compte.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { LiveSocket } from "../lib/socket";
import { beepError, beepOk } from "../lib/feedback";
import { useAuth } from "./auth";
import { useCart, useProducts } from "./data";

const LiveContext = createContext({ status: "stopped", scannerConnected: false, unknownCode: null });

export function CaisseLiveProvider({ children }) {
  const { auth, block, getToken, onSocketFatal } = useAuth();
  const { add } = useCart();
  const { upsert } = useProducts();
  const [status, setStatus] = useState("stopped");
  const [scannerConnected, setScannerConnected] = useState(false);
  const [unknownCode, setUnknownCode] = useState(null); // {code, at}
  const [elsewhere, setElsewhere] = useState(false);
  const handlers = useRef({});
  handlers.current = { add, upsert, onSocketFatal };

  const active = Boolean(auth?.token) && auth.device === "caisse" && !block;
  const token = auth?.token;

  useEffect(() => {
    if (!active) { setStatus("stopped"); setScannerConnected(false); return undefined; }
    setElsewhere(false);
    const sock = new LiveSocket("caisse", getToken, {
      onStatus: (s) => { setStatus(s); if (s !== "connected") setScannerConnected(false); },
      onFatal: (msg) => {
        if (msg.type === "closed" && msg.code === 4000) setElsewhere(true);
        else handlers.current.onSocketFatal(msg, "caisse");
      },
      onMessage: (msg) => {
        switch (msg.type) {
          case "auth_ok": setScannerConnected(Boolean(msg.scanner_connected)); break;
          case "scanner_connected": setScannerConnected(true); break;
          case "scanner_disconnected": setScannerConnected(false); break;
          case "product_scanned":
            handlers.current.upsert(msg.product);
            handlers.current.add(msg.product, msg.code);
            setUnknownCode(null);
            beepOk();
            break;
          case "scan_error":
            if (msg.reason === "not_found") { setUnknownCode({ code: msg.code, at: Date.now() }); beepError(); }
            break;
          default: break;
        }
      },
    });
    return () => sock.stop();
    // le jeton change après un renouvellement : la socket existante reste valable (même session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, auth?.user?.id, auth?.device]);

  const value = useMemo(() => ({ status, scannerConnected, unknownCode, setUnknownCode, elsewhere, token }),
    [status, scannerConnected, unknownCode, elsewhere, token]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
