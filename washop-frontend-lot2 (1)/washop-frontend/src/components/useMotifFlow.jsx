import { useCallback, useState } from "react";
import { useAuth } from "../state/auth";
import { errorText, useToast } from "../state/toast";
import MotifModal from "./MotifModal";

// Action sensible : le caissier passe par la fenêtre de motif, le propriétaire jamais.
// Si le backend répond 400 MOTIF_REQUIRED, le formulaire se rouvre avec son message.
export function useMotifFlow() {
  const { isOwner } = useAuth();
  const toast = useToast();
  const [flow, setFlow] = useState(null); // {title, subtitle, run, onDone, onError, serverError}
  const [loading, setLoading] = useState(false);

  const execute = useCallback(async (opts, motif) => {
    setLoading(true);
    try {
      const result = await opts.run(motif);
      setFlow(null);
      opts.onDone?.(result);
    } catch (e) {
      if (e.status === 400 && e.code === "MOTIF_REQUIRED") {
        setFlow({ ...opts, serverError: e.detail });
      } else {
        setFlow(null);
        if (opts.onError) opts.onError(e);
        else toast.push(errorText(e), "error");
      }
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const start = useCallback((opts) => {
    if (isOwner) execute(opts, null);
    else setFlow({ ...opts, serverError: null });
  }, [isOwner, execute]);

  const modal = (
    <MotifModal
      open={Boolean(flow)}
      title={flow?.title}
      subtitle={flow?.subtitle}
      serverError={flow?.serverError}
      loading={loading}
      onClose={() => setFlow(null)}
      onConfirm={(motif) => execute(flow, motif)}
    />
  );
  return { start, modal, loading };
}
