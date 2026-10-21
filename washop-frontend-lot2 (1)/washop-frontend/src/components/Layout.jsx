import { Boxes, Home, LayoutDashboard, LogOut, MoreHorizontal, Package, Receipt, ScanLine, ScrollText, Settings, Users } from "lucide-react";
import { Link, useRouter } from "../lib/router";
import { useAuth } from "../state/auth";
import { useIsDesktop } from "../lib/useMedia";
import { ROLE_LABELS } from "../lib/labels";
import { Logo, cx } from "./ui";

// Menus par rôle (cahier, section 3). Le caissier n'a aucun lien vers les écrans réservés.
export const OWNER_NAV = [
  { to: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { to: "/caisse", label: "Caisse", icon: ScanLine },
  { to: "/produits", label: "Produits", icon: Package },
  { to: "/stock", label: "Stock", icon: Boxes },
  { to: "/ventes", label: "Ventes", icon: Receipt },
  { to: "/utilisateurs", label: "Utilisateurs", icon: Users },
  { to: "/journal", label: "Journal", icon: ScrollText },
  { to: "/parametres", label: "Paramètres", icon: Settings },
];
export const SELLER_NAV = [
  { to: "/caisse", label: "Caisse", icon: ScanLine },
  { to: "/produits", label: "Produits", icon: Package },
  { to: "/stock", label: "Stock", icon: Boxes },
  { to: "/mes-ventes", label: "Mes ventes", icon: Receipt },
];

const OWNER_TABS = [
  { to: "/dashboard", label: "Accueil", icon: Home },
  { to: "/caisse", label: "Caisse", icon: ScanLine },
  { to: "/produits", label: "Produits", icon: Package },
  { to: "/plus", label: "Plus", icon: MoreHorizontal },
];
const SELLER_TABS = [
  { to: "/caisse", label: "Caisse", icon: ScanLine },
  { to: "/produits", label: "Produits", icon: Package },
  { to: "/stock", label: "Stock", icon: Boxes },
  { to: "/plus", label: "Plus", icon: MoreHorizontal },
];

const isActive = (path, to) => path === to || path.startsWith(`${to}/`);

function Sidebar() {
  const { auth, isOwner, logout } = useAuth();
  const { path, navigate } = useRouter();
  const nav = isOwner ? OWNER_NAV : SELLER_NAV;
  return (
    <aside className="sidebar">
      <div className="sidebar-logo"><Logo light /></div>
      <nav className="sidebar-nav">
        {nav.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} className={cx("side-link", isActive(path, to) && "on")}>
            <Icon size={19} /> {label}
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="side-card">
          <strong>{auth.business?.name}</strong>
          <span>{auth.user?.name} · {ROLE_LABELS[auth.user?.role]}</span>
        </div>
        <button type="button" className="side-link" onClick={async () => { await logout(); navigate("/login", { replace: true }); }}>
          <LogOut size={19} /> Déconnexion
        </button>
      </div>
    </aside>
  );
}

function BottomTabs() {
  const { isOwner } = useAuth();
  const { path } = useRouter();
  const tabs = isOwner ? OWNER_TABS : SELLER_TABS;
  const inMore = !tabs.slice(0, 3).some((t) => isActive(path, t.to));
  return (
    <nav className="tabs">
      {tabs.map(({ to, label, icon: Icon }) => {
        const on = to === "/plus" ? inMore : isActive(path, to);
        return (
          <Link key={to} to={to} className={cx("tab", on && "on")}>
            <span className="tab-pill"><Icon size={21} strokeWidth={on ? 2.4 : 2} /></span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function Layout({ children }) {
  const desktop = useIsDesktop();
  return (
    <div className={cx("app", desktop ? "app-desk" : "app-phone")}>
      {desktop && <Sidebar />}
      <main className="content">{children}</main>
      {!desktop && <BottomTabs />}
    </div>
  );
}

export function PageHeader({ title, sub, actions }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
