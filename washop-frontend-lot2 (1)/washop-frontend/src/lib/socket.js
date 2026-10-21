// WebSocket caisse / scanner avec reconnexion automatique (1 s, 2 s, 4 s… plafond 30 s).
// Protocole du backend : 1er message {type:"auth", token}. Le jeton n'est jamais dans l'URL.
import { wsUrl } from "./api";

const MAX_DELAY = 30_000;
const CLIENT_PING_EVERY = 25_000;

export class LiveSocket {
  /**
   * @param {"caisse"|"scanner"} device
   * @param {() => string|null} getToken
   * @param {{onStatus?:Function, onMessage?:Function, onFatal?:Function}} handlers
   */
  constructor(device, getToken, handlers) {
    this.device = device;
    this.getToken = getToken;
    this.h = handlers;
    this.ws = null;
    this.delay = 1000;
    this.stopped = false;
    this.timer = null;
    this.pingTimer = null;
    this.status = "connecting";
    this.fatalSent = false;
    this.onOnline = () => { if (!this.stopped && this.status !== "connected") this.reconnectNow(); };
    this.onOffline = () => this.setStatus("offline");
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    this.connect();
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.h.onStatus?.(s);
  }

  connect() {
    if (this.stopped) return;
    const token = this.getToken();
    if (!token) { this.stop(); return; }
    this.setStatus(navigator.onLine === false ? "offline" : this.delay > 1000 ? "reconnecting" : "connecting");
    let ws;
    try {
      ws = new WebSocket(wsUrl(`/ws/${this.device}`));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // ancienne socket remplacée par une reconnexion
      clearInterval(this.pingTimer);
      this.ws = null;
      if (this.stopped) return;
      // 4401 : session remplacée/terminée (le message a déjà été traité). 4403 : mauvais mode.
      // 4000 : la même session a ouvert une autre connexion (autre onglet) : on ne se bat pas avec elle.
      if (ev.code === 4401 || ev.code === 4403 || ev.code === 4000) {
        if (!this.fatalSent) this.h.onFatal?.({ type: "closed", code: ev.code });
        this.stop();
        return;
      }
      this.scheduleReconnect();
    };
  }

  handle(msg) {
    switch (msg.type) {
      case "auth_ok":
        this.delay = 1000;
        this.setStatus("connected");
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ type: "ping" }), CLIENT_PING_EVERY);
        break;
      case "ping":
        this.send({ type: "pong" }); // réponse au ping du serveur, rien à afficher
        return;
      case "pong":
        return;
      case "auth_error":
      case "session_replaced":
      case "session_ended":
        this.fatalSent = true;
        this.h.onFatal?.(msg);
        this.stop();
        return;
      default:
        break;
    }
    this.h.onMessage?.(msg);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.status === "connected") {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  get connected() {
    return this.status === "connected";
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.setStatus(navigator.onLine === false ? "offline" : "reconnecting");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, MAX_DELAY);
  }

  reconnectNow() {
    clearTimeout(this.timer);
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(); } catch { /* rien */ } }
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000); } catch { /* rien */ } }
    this.setStatus("stopped");
  }
}
