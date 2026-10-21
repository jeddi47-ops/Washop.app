import { useState } from "react";
import { ArrowRight, Check, Eye, EyeOff, Lock, ScanLine, Store, User } from "lucide-react";
import { useAuth } from "../state/auth";
import { useRouter } from "../lib/router";
import { useIsDesktop } from "../lib/useMedia";
import { Button, Logo, cx } from "../components/ui";
import { errorText } from "../state/toast";

export function homeFor(a) {
  if (!a) return "/login";
  if (a.device === "scanner") return "/scanner";
  return a.user.role === "owner" ? "/dashboard" : "/caisse";
}

function ModeOption({ on, icon: Icon, title, text, onClick }) {
  return (
    <button type="button" className={cx("mode-opt", on && "on")} onClick={onClick} aria-pressed={on}>
      <span className="mode-icon"><Icon size={26} /></span>
      <span className="mode-check">{on && <Check size={14} strokeWidth={3} />}</span>
      <strong>{title}</strong>
      <span>{text}</span>
    </button>
  );
}

export default function Login() {
  const { login } = useAuth();
  const { navigate } = useRouter();
  const desktop = useIsDesktop();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [step, setStep] = useState("credentials"); // credentials | mode
  const [mode, setMode] = useState("caisse");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Le rôle n'est connu qu'après /auth/login, or le mode doit être envoyé AVEC la connexion
  // (sinon on remplacerait la caisse ouverte sur le PC). Règle retenue : sur téléphone, une connexion
  // par identifiant (caissier) passe par le choix du mode ; par e-mail (propriétaire) elle va directement au tableau de bord.
  const needsMode = !desktop && !identifier.includes("@");

  async function doLogin(device) {
    setLoading(true);
    setError(null);
    try {
      const a = await login(identifier, password, device);
      navigate(homeFor(a), { replace: true });
    } catch (e) {
      setError(errorText(e));
      setStep("credentials");
    } finally {
      setLoading(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (!identifier.trim() || !password) { setError("Saisis ton identifiant et ton mot de passe."); return; }
    if (needsMode) { setError(null); setStep("mode"); return; }
    doLogin("caisse");
  }

  if (step === "mode") {
    return (
      <div className="login-phone">
        <Logo />
        <h1 className="login-title">Ce téléphone,<br />tu l'utilises comment ?</h1>
        <div className="mode-list">
          <ModeOption on={mode === "caisse"} icon={Store} title="Ouvrir la caisse" text="Panier, paiement et reçu sur ce téléphone." onClick={() => setMode("caisse")} />
          <ModeOption on={mode === "scanner"} icon={ScanLine} title="Utiliser comme scanner" text="Tu scannes, les produits arrivent sur ta caisse." onClick={() => setMode("scanner")} />
        </div>
        <div className="login-bottom">
          <Button className="btn-block btn-lg" loading={loading} onClick={() => doLogin(mode)}>Continuer</Button>
          <Button kind="ghost-plain" className="btn-block" onClick={() => setStep("credentials")}>Retour</Button>
        </div>
      </div>
    );
  }

  const form = (
    <form className="login-form" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field-label">Identifiant ou e-mail</span>
        <span className="input-icon"><User size={18} />
          <input autoComplete="username" autoCapitalize="none" spellCheck={false} value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
        </span>
      </label>
      <label className="field">
        <span className="field-label">Mot de passe</span>
        <span className="input-icon"><Lock size={18} />
          <input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="input-eye" aria-label={show ? "Masquer" : "Afficher"} onClick={() => setShow((s) => !s)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
        </span>
      </label>
      {error && <div className="alert alert-error">{error}</div>}
      <Button type="submit" className="btn-block btn-lg" icon={ArrowRight} loading={loading}>Se connecter</Button>
    </form>
  );

  if (!desktop) {
    return (
      <div className="login-phone">
        <Logo />
        <h1 className="login-title">Bon retour<br />à la boutique.</h1>
        <p className="muted">Connecte-toi pour ouvrir ta journée.</p>
        {form}
      </div>
    );
  }

  return (
    <div className="login-desk">
      <div className="login-art">
        <Logo light />
        <div className="login-art-glow" />
        <p className="login-art-line">La caisse de ta boutique,<br />un scan à la fois.</p>
      </div>
      <div className="login-panel">
        <div className="login-panel-inner">
          <h1>Connexion</h1>
          <p className="muted">Propriétaire ou caissier, avec ton identifiant.</p>
          {form}
        </div>
      </div>
    </div>
  );
}
