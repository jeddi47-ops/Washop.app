import { LockKeyhole, LogIn, Smartphone } from "lucide-react";
import { BLOCK_TEXT, useAuth } from "../state/auth";
import { useRouter } from "../lib/router";
import { Button } from "./ui";

const capitalize = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;

// Écran bloquant : pas de nouvel essai automatique, l'utilisateur choisit de se reconnecter.
export default function BlockingScreen() {
  const { block, wipe } = useAuth();
  const { navigate } = useRouter();
  if (!block) return null;
  const replaced = block.kind === "replaced";
  const disabled = block.kind === "disabled";
  const text = replaced ? BLOCK_TEXT.replaced(block.device) : disabled ? BLOCK_TEXT.disabled : block.message;
  const [head, ...rest] = text.split(" : ");
  return (
    <div className="blocking" role="alertdialog" aria-live="assertive">
      <div className="blocking-inner">
        <span className="blocking-icon">{replaced ? <Smartphone size={36} /> : <LockKeyhole size={34} />}</span>
        <h1>{rest.length ? head : disabled ? "Ton compte a été désactivé" : "Session terminée"}</h1>
        <p>{rest.length ? capitalize(rest.join(" : ")) : disabled ? "Contacte le propriétaire." : text}</p>
        <Button kind="white" icon={LogIn} className="btn-block btn-lg" onClick={() => { wipe(!disabled); navigate("/login", { replace: true }); }}>
          Se reconnecter
        </Button>
      </div>
    </div>
  );
}
