import { api } from "./api";

// Annulation : le caissier envoie un motif (fenêtre 4.7), le propriétaire n'en a pas besoin.
export function cancelSale(saleId, motif) {
  return api.post(`/sales/${saleId}/cancel`, motif ? { motif_code: motif.motif_code, motif_note: motif.motif_note } : {});
}
