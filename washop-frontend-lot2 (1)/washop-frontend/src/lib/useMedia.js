import { useEffect, useState } from "react";

// PC = écran de 1024 px ou plus. En dessous : mise en page téléphone (onglets en bas).
const QUERY = "(min-width: 1024px)";

export function useIsDesktop() {
  const [desk, setDesk] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setDesk(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desk;
}
