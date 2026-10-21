// Produits (cache du commerce) et panier en cours.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchAllProducts, api } from "../lib/api";
import { load, save } from "../lib/storage";
import { useAuth } from "./auth";

const ProductsContext = createContext(null);
const CartContext = createContext(null);

export function stockThreshold(product, business) {
  if (product.low_stock_threshold !== null && product.low_stock_threshold !== undefined) return product.low_stock_threshold;
  return business?.settings?.low_stock_default_threshold ?? 5;
}

// « rupture » | « faible » | « normal »
export function stockStatus(product, business) {
  const q = Number(product.quantity) || 0;
  if (q <= 0) return "rupture";
  if (q <= stockThreshold(product, business)) return "faible";
  return "normal";
}

export function ProductsProvider({ children }) {
  const { auth } = useAuth();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const loadedFor = useRef(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const items = await fetchAllProducts();
      setProducts(items);
      setError(null);
      return items;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const key = auth?.token && auth.device === "caisse" ? auth.user.id : null;
    if (!key) { loadedFor.current = null; setProducts([]); return; }
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    reload();
  }, [auth?.token, auth?.device, auth?.user?.id, reload]);

  const upsert = useCallback((p) => {
    setProducts((xs) => {
      if (p.is_archived) return xs.filter((x) => x.id !== p.id);
      const i = xs.findIndex((x) => x.id === p.id);
      const next = i >= 0 ? xs.map((x) => (x.id === p.id ? p : x)) : [...xs, p];
      return next.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    });
  }, []);

  // Code-barres ou QR : d'abord le cache, sinon le backend (le cache peut être en retard).
  const findByCode = useCallback(async (code) => {
    const c = String(code).trim();
    const local = products.find((p) => p.code === c || p.qr_code === c);
    if (local) return local;
    try {
      const p = await api.get(`/products/by-code/${encodeURIComponent(c)}`);
      upsert(p);
      return p;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }, [products, upsert]);

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr")),
    [products],
  );

  const value = useMemo(() => ({ products, loading, error, reload, upsert, findByCode, categories }),
    [products, loading, error, reload, upsert, findByCode, categories]);
  return <ProductsContext.Provider value={value}>{children}</ProductsContext.Provider>;
}

export const useProducts = () => useContext(ProductsContext);

// Le provider est remonté à chaque changement d'utilisateur (voir CartScope dans App.jsx) :
// les états se chargent donc toujours depuis le bon compte.
export function CartProvider({ children }) {
  const { auth } = useAuth();
  const { products } = useProducts();
  const uid = auth?.user?.id;
  const [lines, setLines] = useState(() => (uid ? load(`cart.${uid}`, []) : []));
  // Tentative de paiement en cours : identifiant unique (client_sale_id), gardé avec le panier.
  // uncertain = true après une coupure pendant l'envoi : plus de renvoi automatique ni manuel.
  const [attempt, setAttempt] = useState(() => (uid ? load(`attempt.${uid}`, null) : null));

  useEffect(() => { if (uid) save(`cart.${uid}`, lines.length ? lines : null); }, [uid, lines]);
  useEffect(() => { if (uid) save(`attempt.${uid}`, attempt); }, [uid, attempt]);
  useEffect(() => { if (!lines.length && attempt) setAttempt(null); }, [lines.length, attempt]);

  // Prix et noms à jour quand le cache produits change ; produit archivé : retiré du panier.
  useEffect(() => {
    if (!products.length) return;
    setLines((xs) => {
      let changed = false;
      const next = xs.flatMap((l) => {
        const p = products.find((x) => x.id === l.product.id);
        if (!p) return [l];
        if (p.sale_price !== l.product.sale_price || p.name !== l.product.name || p.quantity !== l.product.quantity) {
          changed = true;
          return [{ ...l, product: p }];
        }
        return [l];
      });
      return changed ? next : xs;
    });
  }, [products]);

  // Deux scans du même produit : quantité + 1, pas de nouvelle ligne.
  const add = useCallback((product, code) => {
    setLines((xs) => {
      const i = xs.findIndex((l) => l.product.id === product.id);
      if (i >= 0) return xs.map((l, j) => (j === i ? { ...l, qty: l.qty + 1, product } : l));
      return [{ product, qty: 1, code: code || null }, ...xs];
    });
  }, []);
  const setQty = useCallback((id, q) => setLines((xs) => xs.map((l) => (l.product.id === id ? { ...l, qty: Math.max(1, q) } : l))), []);
  const remove = useCallback((id) => setLines((xs) => xs.filter((l) => l.product.id !== id)), []);
  // Vidage du panier (ou vente réussie) : seul moment où la tentative repart à zéro.
  const clear = useCallback(() => { setLines([]); setAttempt(null); }, []);

  const total = lines.reduce((s, l) => s + Number(l.product.sale_price) * l.qty, 0);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const value = useMemo(
    () => ({ lines, add, setQty, remove, clear, total, count, attempt, setAttempt }),
    [lines, add, setQty, remove, clear, total, count, attempt],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
