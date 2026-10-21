import { useEffect } from "react";
import { matchPath, RouterProvider, useRouter } from "./lib/router";
import { AuthProvider, useAuth } from "./state/auth";
import { CartProvider, ProductsProvider } from "./state/data";
import { CaisseLiveProvider } from "./state/live";
import { ToastProvider } from "./state/toast";
import Layout from "./components/Layout";
import BlockingScreen from "./components/BlockingScreen";
import { Spinner } from "./components/ui";
import Login, { homeFor } from "./pages/Login";
import Caisse from "./pages/Caisse";
import ScannerMode from "./pages/ScannerMode";
import Products from "./pages/Products";
import { ProductEdit, ProductNew } from "./pages/ProductForm";
import Stock from "./pages/Stock";
import Sales, { MySales } from "./pages/Sales";
import Dashboard from "./pages/Dashboard";
import Users from "./pages/Users";
import Audit from "./pages/Audit";
import Settings from "./pages/Settings";
import More from "./pages/More";

// Écrans réservés au propriétaire : un caissier qui tape l'URL est renvoyé sur la caisse, sans erreur.
const OWNER_ONLY = ["/dashboard", "/ventes", "/utilisateurs", "/journal", "/parametres"];
const SELLER_ONLY = ["/mes-ventes"];

// Une clé par utilisateur : le panier et la tentative de paiement se rechargent au bon compte.
function CartScope({ children }) {
  const { auth } = useAuth();
  return <CartProvider key={auth?.user?.id || "anon"}>{children}</CartProvider>;
}

function resolve(path) {
  if (path === "/caisse") return <Caisse />;
  if (path === "/produits") return <Products />;
  if (path === "/produits/nouveau") return <ProductNew />;
  const prod = matchPath("/produits/:id", path);
  if (prod) return <ProductEdit key={prod.id} id={prod.id} />;
  if (path === "/stock") return <Stock />;
  if (path === "/ventes") return <Sales />;
  if (path === "/mes-ventes") return <MySales />;
  if (path === "/dashboard") return <Dashboard />;
  if (path === "/utilisateurs") return <Users />;
  if (path === "/journal") return <Audit />;
  if (path === "/parametres") return <Settings />;
  if (path === "/plus") return <More />;
  return null;
}

function redirectFor(auth, path) {
  if (!auth) return path === "/login" ? null : "/login";
  if (path === "/login" || path === "/") return homeFor(auth);
  // Téléphone en mode scanner : uniquement l'écran scanner.
  if (auth.device === "scanner") return path === "/scanner" ? null : "/scanner";
  if (path === "/scanner") return "/caisse";
  const owner = auth.user.role === "owner";
  if (!owner && OWNER_ONLY.some((p) => path === p || path.startsWith(`${p}/`))) return "/caisse";
  if (owner && SELLER_ONLY.includes(path)) return "/ventes";
  if (!resolve(path)) return homeFor(auth);
  return null;
}

function Routes() {
  const { auth, ready, block } = useAuth();
  const { path, navigate } = useRouter();
  const target = redirectFor(auth, path);

  useEffect(() => { if (target && !block) navigate(target, { replace: true }); }, [target, block, navigate]);

  if (block) return <BlockingScreen />;
  if (!ready) return <div className="boot"><Spinner label="Ouverture…" /></div>;
  if (target) return null;
  if (!auth) return <Login />;
  if (path === "/scanner") return <ScannerMode />;
  return <Layout>{resolve(path)}</Layout>;
}

export default function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <AuthProvider>
          <ProductsProvider>
            <CartScope>
              <CaisseLiveProvider>
                <Routes />
              </CaisseLiveProvider>
            </CartScope>
          </ProductsProvider>
        </AuthProvider>
      </ToastProvider>
    </RouterProvider>
  );
}
