# Washop, frontend du lot 2

React 18 + Vite. Aucun framework d'interface : un fichier CSS, des icônes lucide-react, et @zxing/browser pour la caméra sur iPhone.

## Lancer

```bash
npm install
npm run dev          # http://localhost:3000, /api est relayé vers http://localhost:8000
npm run dev:https    # pour tester la caméra sur un téléphone du réseau local (https obligatoire)
npm run build        # dossier dist/ à servir avec un repli SPA (toutes les routes -> index.html)
```

- Backend sur une autre machine : `BACKEND_URL=http://192.168.1.10:8000 npm run dev`.
- En production, si l'API n'est pas sur le même domaine : `VITE_API_URL=https://api.exemple.com` (sans /api) et ajouter le domaine du frontend dans `CORS_ORIGINS` du backend.
- Le compte propriétaire se crée par `POST /api/auth/register` (page /docs du backend) : il n'y a pas d'écran d'inscription dans ce lot.

## Structure

```
index.html, vite.config.js, package.json, .env.example
src/main.jsx                 point d'entrée
src/App.jsx                  routes, garde par rôle et par mode (caisse / scanner)
src/styles.css               tout le style (mobile d'abord, PC à partir de 1024 px)
src/lib/api.js               client HTTP (jeton en en-tête uniquement), erreurs, PDF/QR protégés
src/lib/socket.js            WebSocket avec reconnexion 1 s, 2 s, 4 s… plafond 30 s, ping/pong
src/lib/router.jsx           petit routeur (History API)
src/lib/format.js            montants « 1 248 500 FC », dates, quantités
src/lib/labels.js            motifs, modes de paiement, libellés du journal
src/lib/storage.js           données locales (effacées à la déconnexion)
src/lib/feedback.js          bip et vibration après un scan
src/lib/useMedia.js          téléphone / PC
src/lib/cancelSale.js        annulation d'une vente
src/state/auth.jsx           session, connexion, changement de mode, écrans bloquants
src/state/data.jsx           cache des produits, panier (gardé en cas de coupure)
src/state/live.jsx           socket de la caisse (scans du téléphone, indicateur scanner)
src/state/toast.jsx          messages courts, texte du 403
src/components/ui.jsx        boutons, badges, vignette par défaut, fenêtres, champs
src/components/Layout.jsx    menu latéral PC, onglets du bas sur téléphone
src/components/MotifModal.jsx, useMotifFlow.jsx   fenêtre de motif (4.7)
src/components/CameraScanner.jsx                  scan par la caméra
src/components/Receipt.jsx, RestockModal.jsx, BlockingScreen.jsx
src/pages/Login.jsx, Caisse.jsx, ScannerMode.jsx, Products.jsx, ProductForm.jsx,
          Stock.jsx, Sales.jsx (Ventes + Mes ventes), Dashboard.jsx, Users.jsx,
          Audit.jsx, Settings.jsx, More.jsx
```
