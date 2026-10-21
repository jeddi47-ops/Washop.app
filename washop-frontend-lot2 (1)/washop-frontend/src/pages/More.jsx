// Onglet « Plus » (téléphone) : le reste du menu du rôle, et la déconnexion.
import { ChevronRight, LogOut } from "lucide-react";
import { Link, useRouter } from "../lib/router";
import { ROLE_LABELS } from "../lib/labels";
import { initials } from "../lib/format";
import { useAuth } from "../state/auth";
import { OWNER_NAV, SELLER_NAV } from "../components/Layout";

export default function More() {
  const { auth, isOwner, logout } = useAuth();
  const { navigate } = useRouter();
  const shown = isOwner ? ["/dashboard", "/caisse", "/produits"] : ["/caisse", "/produits", "/stock"];
  const items = (isOwner ? OWNER_NAV : SELLER_NAV).filter((i) => !shown.includes(i.to));
  return (
    <div className="page page-narrow">
      <div className="me-card">
        <span className="avatar avatar-lg">{initials(auth.user.name)}</span>
        <div><strong>{auth.user.name}</strong><span className="muted">{ROLE_LABELS[auth.user.role]} · {auth.business?.name}</span></div>
      </div>
      <nav className="more-list">
        {items.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} className="more-item"><Icon size={20} /><span>{label}</span><ChevronRight size={18} /></Link>
        ))}
        <button type="button" className="more-item more-logout" onClick={async () => { await logout(); navigate("/login", { replace: true }); }}>
          <LogOut size={20} /><span>Déconnexion</span>
        </button>
      </nav>
    </div>
  );
}
