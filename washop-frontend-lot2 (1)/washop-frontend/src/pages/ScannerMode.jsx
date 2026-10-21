// Mode scanner (téléphone) : bouton Scanner plein écran, aucun panier ni total.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LogOut, MonitorSmartphone, RefreshCw, ScanLine, Store, Wifi, WifiOff, X } from "lucide-react";
import { LiveSocket } from "../lib/socket";
import { beepError, beepOk, unlockAudio } from "../lib/feedback";
import { useRouter } from "../lib/router";
import { useAuth } from "../state/auth";
import { errorText, useToast } from "../state/toast";
import { Button, Logo, cx } from "../components/ui";
import CameraScanner from "../components/CameraScanner";

const ACK_TIMEOUT = 6000;

function Connection({ status }) {
  const map = {
    connected: ["Connecté", "on", Wifi],
    connecting: ["Connexion…", "re", RefreshCw],
    reconnecting: ["Reconnexion en cours", "re", RefreshCw],
    offline: ["Hors ligne", "off", WifiOff],
    stopped: ["Hors ligne", "off", WifiOff],
  };
  const [label, tone, Icon] = map[status] || map.offline;
  return (
    <span className={`conn conn-${tone}`} role="status">
      <i />{label}<Icon size={14} className={tone === "re" ? "spin" : ""} />
    </span>
  );
}

export default function ScannerMode() {
  const { auth, block, getToken, onSocketFatal, switchMode, logout } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const [status, setStatus] = useState("connecting");
  const [caisseOpen, setCaisseOpen] = useState(null);
  const [noCaisse, setNoCaisse] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const [camera, setCamera] = useState(false);
  const [last, setLast] = useState(null); // {kind:"ok"|"not_found"|"refused"|"pending", text, code, at}
  const [switching, setSwitching] = useState(false);
  const sockRef = useRef(null);
  const pending = useRef(new Map());
  const seq = useRef(0);
  const fatalRef = useRef(onSocketFatal);
  fatalRef.current = onSocketFatal;

  useEffect(() => {
    if (!auth?.token || block) return undefined;
    const sock = new LiveSocket("scanner", getToken, {
      onStatus: setStatus,
      onFatal: (msg) => {
        if (msg.type === "closed" && msg.code === 4000) setElsewhere(true);
        else fatalRef.current(msg, "scanner");
      },
      onMessage: (msg) => {
        if (msg.type === "auth_ok") setCaisseOpen(Boolean(msg.caisse_connected));
        else if (msg.type === "caisse_connected") { setCaisseOpen(true); setNoCaisse(false); }
        else if (msg.type === "caisse_disconnected") setCaisseOpen(false);
        else if (msg.type === "scan_ack") {
          const t = pending.current.get(msg.scan_id);
          if (t) { clearTimeout(t); pending.current.delete(msg.scan_id); }
          const at = Date.now();
          if (msg.status === "ok") { beepOk(); setLast({ kind: "ok", text: msg.product_name || "Produit envoyé", code: msg.code, at }); }
          else if (msg.status === "not_found") { beepError(); setLast({ kind: "not_found", text: "Code inconnu", code: msg.code, at }); }
          else if (msg.status === "no_caisse") { beepError(); setLast(null); setCaisseOpen(false); setNoCaisse(true); setCamera(false); }
        }
      },
    });
    sockRef.current = sock;
    return () => { sock.stop(); pending.current.forEach(clearTimeout); pending.current.clear(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.user?.id, auth?.device, block]);

  // Pas de file d'attente : sans connexion, le scan est refusé et on le dit.
  const sendScan = useCallback((code) => {
    const sock = sockRef.current;
    if (!sock || !sock.connected) {
      beepError();
      setLast({ kind: "refused", text: "Pas connecté : scan non envoyé", code, at: Date.now() });
      return;
    }
    seq.current += 1;
    const scanId = `${Date.now()}-${seq.current}`;
    sock.send({ type: "scan", code, scan_id: scanId });
    setLast({ kind: "pending", text: "Envoi…", code, at: Date.now() });
    pending.current.set(scanId, setTimeout(() => {
      pending.current.delete(scanId);
      beepError();
      setLast({ kind: "refused", text: "Pas de réponse : rescanne", code, at: Date.now() });
    }, ACK_TIMEOUT));
  }, []);

  async function openCaisseHere() {
    setSwitching(true);
    try {
      await switchMode("caisse");
      navigate("/caisse", { replace: true });
    } catch (e) {
      toast.push(errorText(e), "error");
      setSwitching(false);
    }
  }

  const feedback = last && (
    <div key={last.at} className={cx("scan-result", `scan-result-${last.kind}`)} role="status">
      <span className="scan-result-icon">{last.kind === "ok" ? <Check size={22} strokeWidth={3} /> : last.kind === "pending" ? <RefreshCw size={20} className="spin" /> : <X size={22} strokeWidth={3} />}</span>
      <div><strong>{last.text}</strong>{last.code && <span className="mono">{last.code}</span>}</div>
    </div>
  );

  const header = (
    <div className="scanner-top">
      <Logo light small />
      <Connection status={elsewhere ? "stopped" : status} />
    </div>
  );

  if (noCaisse) {
    return (
      <div className="scanner-screen">
        {header}
        <div className="scanner-center">
          <span className="scanner-big-icon"><MonitorSmartphone size={44} /></span>
          <h1>Aucune caisse ouverte</h1>
          <p>Ouvre la caisse sur le PC avec ton compte, ou fais tout depuis ce téléphone.</p>
        </div>
        <div className="scanner-actions">
          <Button className="btn-block btn-lg" icon={Store} loading={switching} onClick={openCaisseHere}>Ouvrir la caisse ici</Button>
          <Button kind="glass" className="btn-block btn-lg" icon={RefreshCw} onClick={() => setNoCaisse(false)}>Réessayer</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="scanner-screen">
      {header}
      <div className="scanner-link">
        <span>Relié à</span>
        <strong>la caisse de {auth.user.name}</strong>
        {caisseOpen === false && <em>Aucune caisse ouverte pour l'instant</em>}
        {elsewhere && <em>Scanner ouvert dans un autre onglet</em>}
      </div>
      <button type="button" className="scanner-button" onClick={() => { unlockAudio(); setCamera(true); }}>
        <span className="scanner-frame"><span className="laser" /><ScanLine size={54} strokeWidth={1.6} /></span>
        <strong>Scanner</strong>
        <span>Touche pour ouvrir la caméra</span>
      </button>
      <div className="scanner-feedback">{feedback}</div>
      <div className="scanner-foot">
        <button type="button" onClick={openCaisseHere} disabled={switching}><Store size={16} /> Passer en mode caisse</button>
        <button type="button" onClick={async () => { await logout(); navigate("/login", { replace: true }); }}><LogOut size={16} /> Déconnexion</button>
      </div>
      {camera && <CameraScanner title="Mode scanner" onClose={() => setCamera(false)} onCode={sendScan} feedback={feedback} />}
    </div>
  );
}
