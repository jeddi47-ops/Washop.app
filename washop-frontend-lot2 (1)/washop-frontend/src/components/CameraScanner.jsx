// Scan par la caméra du téléphone.
// 1) BarcodeDetector natif (Chrome Android) ; 2) sinon @zxing/browser (iPhone / Safari).
// La caméra exige HTTPS (ou localhost).
import { useEffect, useRef, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { Button } from "./ui";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "codabar", "qr_code", "data_matrix"];
const SAME_CODE_COOLDOWN = 1500;

export default function CameraScanner({ onCode, onClose, title = "Scanner", feedback, continuous = true }) {
  const videoRef = useRef(null);
  const [error, setError] = useState(null);
  const [manual, setManual] = useState(false);
  const [typed, setTyped] = useState("");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stopped = false;
    let stream = null;
    let zxingControls = null;
    let timer = null;
    let last = { code: null, at: 0 };

    const emit = (raw) => {
      const code = String(raw || "").trim();
      if (!code) return;
      const now = Date.now();
      if (code === last.code && now - last.at < SAME_CODE_COOLDOWN) return; // même code tenu devant la caméra
      last = { code, at: now };
      onCodeRef.current(code);
      if (!continuous) onClose?.();
    };

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(window.isSecureContext ? "Ce navigateur ne permet pas d'utiliser la caméra." : "La caméra demande une connexion sécurisée (https).");
        return;
      }
      const video = videoRef.current;
      try {
        if ("BarcodeDetector" in window) {
          const supported = (await window.BarcodeDetector.getSupportedFormats?.()) || FORMATS;
          const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
          if (stopped) return;
          video.srcObject = stream;
          await video.play();
          const loop = async () => {
            if (stopped) return;
            try {
              if (video.readyState >= 2) {
                const found = await detector.detect(video);
                if (found[0]) emit(found[0].rawValue);
              }
            } catch { /* image illisible : on continue */ }
            timer = setTimeout(loop, 160);
          };
          loop();
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          const reader = new BrowserMultiFormatReader();
          zxingControls = await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: "environment" } }, audio: false },
            video,
            (result) => { if (result) emit(result.getText()); },
          );
          if (stopped) zxingControls.stop();
        }
      } catch (e) {
        if (stopped) return;
        if (e?.name === "NotAllowedError") setError("Autorise l'accès à la caméra pour scanner.");
        else if (e?.name === "NotFoundError") setError("Aucune caméra trouvée sur cet appareil.");
        else setError("Impossible d'ouvrir la caméra.");
      }
    }

    start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      zxingControls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [continuous, onClose]);

  const submitTyped = (e) => {
    e.preventDefault();
    const c = typed.trim();
    if (!c) return;
    setTyped("");
    onCodeRef.current(c);
    if (!continuous) onClose?.();
  };

  return (
    <div className="camera" role="dialog" aria-label={title}>
      <video ref={videoRef} playsInline muted />
      <div className="camera-top">
        <strong>{title}</strong>
        <button type="button" className="camera-close" aria-label="Fermer la caméra" onClick={onClose}><X size={22} /></button>
      </div>
      {!error && <div className="camera-frame"><span className="laser" /></div>}
      {error && <div className="camera-error">{error}</div>}
      <div className="camera-bottom">
        {feedback}
        {manual ? (
          <form className="camera-manual" onSubmit={submitTyped}>
            <input autoFocus inputMode="numeric" placeholder="Numéro du code" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button type="submit">OK</Button>
          </form>
        ) : (
          <Button kind="glass" icon={Keyboard} onClick={() => setManual(true)}>Saisir le code</Button>
        )}
      </div>
    </div>
  );
}
