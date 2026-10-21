# Washop backend (vague 1 + corrections)

API FastAPI + MongoDB (Motor). Toutes les routes sont préfixées par `/api`.

## 1. Lancer MongoDB (replica set, requis pour les transactions)

```bash
docker compose up -d
```

Le service `mongo-init` initialise le replica set `rs0` automatiquement. Si le serveur démarre sur un MongoDB qui n'est pas en replica set, il s'arrête avec un message clair.

## 2. Installer et lancer le serveur

```bash
cp .env.example .env          # puis remplacer JWT_SECRET par une vraie chaîne (32 caractères minimum)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export $(grep -v '^#' .env | xargs)
uvicorn server:app --reload
```

Documentation interactive : http://localhost:8000/docs

En développement, `SMTP_HOST` reste vide : le lien de réinitialisation du mot de passe s'affiche dans les logs du serveur.

## 3. Lancer les tests

Tests unitaires (sans base) :

```bash
pytest tests/test_rules.py
```

Tests complets, unitaires + intégration (MongoDB du docker-compose requis, base `washop_test` recréée à chaque test) :

```bash
MONGO_URL_TEST="mongodb://localhost:27017/?replicaSet=rs0" pytest
```

Sans `MONGO_URL_TEST`, les tests d'intégration sont ignorés (ils apparaissent comme « skipped »).

## Notes

- Montants en décimal, 2 décimales maximum.
- Dates stockées en UTC. Les journées (stats, filtres, facture) sont découpées dans le fuseau du commerce (`timezone`, nom IANA, défaut `UTC`).
- Connexion : limite par couple email + IP (5 échecs / 15 min) et par IP seule (20 échecs / 15 min). Inscription : 10 par IP par heure.
- Session : token valable `JWT_EXPIRE_MINUTES` (720 par défaut). `POST /api/auth/refresh` en renvoie un nouveau.

## Adresse IP derrière un proxy

Par défaut (`TRUSTED_PROXY_COUNT=0`), l'IP utilisée pour les limites est celle de la connexion. Derrière un reverse proxy, toutes les requêtes viendraient de la même IP : réglez `TRUSTED_PROXY_COUNT` sur le nombre de proxys de confiance devant l'app (1 pour un seul proxy). L'app lit alors l'entrée située à cette position depuis la fin de `X-Forwarded-For`. La première entrée n'est jamais utilisée, car un client peut la falsifier. N'activez cette option que si le proxy réécrit bien `X-Forwarded-For`.

## Production

- Le replica set du `docker-compose.yml` (hôte `localhost`, membre `localhost:27017`) est pour le développement uniquement.
- En production, utilisez MongoDB Atlas ou un replica set dont chaque membre est joignable par le serveur, avec des hôtes réels (pas `localhost`), et `MONGO_URL` pointant vers ce replica set.
- Définissez un `JWT_SECRET` aléatoire et propre à la production, et `CORS_ORIGINS` limité à votre frontend.
- Configurez `SMTP_HOST` (et les identifiants) pour que les emails de réinitialisation partent réellement.
- Définissez `TRUSTED_PROXY_COUNT` si l'app est derrière un proxy.
- Note : les tokens émis avant cette version n'ont pas de `tv` dans le JWT et sont refusés. Les utilisateurs doivent se reconnecter une seule fois après le déploiement.

## Lot 2 : comptes, sessions, codes produits, scan à distance

### Migration (à lancer une fois après le déploiement, relançable sans risque)

```bash
python -m scripts.migrate_lot2
```

Elle donne aux produits existants `code_type = "qr"` et `code` = leur `qr_code`, complète les anciennes ventes (`cashier_id`, `cashier_name`, code des lignes) et recrée les index (email et code uniques en partiel, sessions, journal).

Les jetons émis avant ce lot n'ont pas de `session_id` : tout le monde doit se reconnecter une fois.

### Correspondance avec le cahier des charges

| Cahier | Backend |
| --- | --- |
| `proprietaire` / `caissier` | `role` = `owner` / `seller` |
| `shop_id` | `business_id` (le jeton contient aussi `shop_id`) |
| `actif` | `is_active` |
| `identifiant` | `username` |
| `archive` | `is_archived` |
| `validee` / `annulee` | `status` = `completed` / `cancelled` |
| `/auth/...`, `/products/...` | `/api/auth/...`, `/api/products/...` |
| `/ws/caisse`, `/ws/scanner` | `/api/ws/caisse`, `/api/ws/scanner` |

### Sessions

- Connexion : `POST /api/auth/login` avec `email` (patron) ou `username` (caissier), `password` et `device_type` (`caisse` par défaut, ou `scanner`).
- Un caissier a au plus une session active par appareil. Une nouvelle connexion remplace l'ancienne, qui reçoit `session_replaced` sur sa WebSocket. Ses requêtes HTTP répondent alors `401` avec `{"detail": "...", "code": "SESSION_REPLACED"}`.
- Le patron n'a pas de limite d'appareils.
- `POST /api/auth/switch-mode` change de mode sans mot de passe. `POST /api/auth/logout` termine la session. `GET /api/auth/me` renvoie la session et `connections.caisse_connected` / `connections.scanner_connected` (vus il y a moins de 2 minutes).
- Panier de l'ancienne caisse : il n'est pas stocké sur le serveur. La nouvelle caisse démarre avec un panier vide.

### WebSocket

1. Ouvrir `wss://<api>/api/ws/caisse` (ou `/api/ws/scanner`).
2. Premier message : `{"type": "auth", "token": "<jeton>"}`. Le jeton n'est jamais mis dans l'URL.
3. Envoyer `{"type": "ping"}` toutes les 25 secondes environ.
4. Scanner : `{"type": "scan", "code": "...", "scan_id": "facultatif"}`. Réponse `scan_ack` avec `status` = `ok`, `not_found` ou `no_caisse`.
5. Caisse : reçoit `product_scanned`, `scan_error`, `scanner_connected`, `scanner_disconnected`. Le scanner reçoit `caisse_connected` et `caisse_disconnected`.
6. Reconnexion : rouvrir la socket et renvoyer `auth` avec le même jeton, tant que la session est active.

**Important : les canaux sont gardés en mémoire. L'API doit tourner en UN seul processus** (commande de démarrage Railway : `uvicorn server:app --host 0.0.0.0 --port $PORT`, sans `--workers`). Pour plusieurs processus, il faudra un relais partagé (Redis ou change streams MongoDB).

### Journal d'audit

`GET /api/audit-log` (patron), filtres `date_from`, `date_to`, `user_id`, `action`, `product_id`, pagination `page` / `page_size`. Aucune route de modification ni de suppression.

Actions enregistrées : `product_created`, `product_updated`, `product_price_changed`, `product_stock_adjusted`, `product_archived`, `sale_created`, `sale_cancelled`, `user_created`, `user_disabled`, `user_password_reset`, `login`, `logout`, `session_replaced`.

Modifications de produit (`PUT` et `PATCH /api/products/{id}`) :

- `product_updated` : changement de `name`, `description`, `category`, `unit`, `expiry_date` ou `low_stock_threshold`, quel que soit le rôle, sans motif.
- `product_price_changed` : changement de `sale_price` ou `purchase_price`, avec motif obligatoire pour un caissier.
- `old_value` et `new_value` ne contiennent que les champs dont la valeur a réellement changé. Si rien ne change, aucune ligne n'est écrite.
- Un même appel qui change un prix et un autre champ produit deux lignes. Elles sont écrites dans la même transaction que la modification : si l'une échoue (par exemple motif manquant), rien n'est enregistré.
- Le réapprovisionnement par un caissier ne demande pas de motif et reste tracé en `product_stock_adjusted`.

Motifs : `erreur_de_saisie`, `client_a_change_avis`, `produit_abime`, `autre` (avec `motif_note` de 10 caractères minimum). Obligatoires pour un caissier sur le changement de prix, l'archivage et l'annulation (`400` avec `code: "MOTIF_REQUIRED"` sinon).

## Lot 3 : ajouts

- **Documentation API désactivée par défaut.** `/docs`, `/redoc` et `/openapi.json` ne répondent plus. Pour le développement uniquement : `ENABLE_DOCS=true` dans `.env`.
- **Paiement sans doublon** : `POST /api/sales` accepte `client_sale_id` (8 à 64 caractères). Même identifiant dans la même boutique = même vente renvoyée, sans nouveau décrément de stock. Unicité garantie par un index MongoDB.
- **Ventes** : `GET /api/sales?cashier_id=` (patron). Le caissier ne voit que son dernier reçu, le paramètre est ignoré pour lui.
- **Produits** : `GET /api/products?q=` cherche sur le nom, le code-barres et le QR, sans tenir compte de la casse.
- **Compte désactivé** : une requête HTTP avec le jeton d'un compte désactivé renvoie 401 `ACCOUNT_DISABLED`.
- **Tableau de bord** : `GET /api/stats/summary` renvoie `units_sold_today` (somme des quantités vendues aujourd'hui).
- **Coordonnées** : `PUT /api/business` avec `address`, `phone` ou `invoice_footer` vide ou `null` efface le champ.
- **Journal** : `GET /api/audit-log?sale_id=` donne la création et l'annulation d'une vente.
- **Devise** : `FC` par défaut pour les nouvelles boutiques. Les boutiques existantes gardent leur devise enregistrée.
- **Facture PDF** : montants au format « 1 248 500 FC ».

Tests d'intégration du lot 3 : `test_same_client_sale_id_returns_the_same_sale_once`, `test_concurrent_identical_client_sale_ids_create_one_sale`, `test_disabled_account_gets_account_disabled_on_http`, `test_units_sold_today_counts_every_product_without_limit`. Ils demandent MongoDB en replica set (voir section 3).
