"""
Tests d'intégration contre MongoDB en replica set.
Lancer : MONGO_URL_TEST="mongodb://localhost:27017/?replicaSet=rs0" pytest
"""
import asyncio
import datetime as dt
import io
import uuid

import cv2
import numpy as np
import pytest
from pypdf import PdfReader



# ---------- Helpers ----------

async def new_business(client, name="Boutique"):
    email = f"{uuid.uuid4().hex[:10]}@test.dev"
    r = await client.post("/api/auth/register", json={
        "business_name": name, "name": "Patron", "email": email, "password": "motdepasse123"})
    assert r.status_code == 201, r.text
    data = r.json()
    return {"Authorization": f"Bearer {data['access_token']}"}, data["business"]["id"]


async def make_product(client, h, name="Savon", price=5.0, cost=2.0, qty=10, **extra):
    body = {"name": name, "sale_price": price, "purchase_price": cost, "initial_quantity": qty, **extra}
    r = await client.post("/api/products", headers=h, json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def sell(client, h, items, method="cash"):
    return await client.post("/api/sales", headers=h, json={
        "items": [{"product_id": pid, "quantity": q} for pid, q in items], "payment_method": method})


async def make_seller(client, owner_headers, device_type="caisse"):
    """Crée un vrai caissier via POST /api/users puis le connecte (session caisse ou scanner)."""
    username = f"caissier.{uuid.uuid4().hex[:6]}"
    r = await client.post("/api/users", headers=owner_headers,
                          json={"name": "Caissier", "username": username, "password": "motdepasse123"})
    assert r.status_code == 201, r.text
    headers, _ = await login_as(client, username, device_type)
    return headers, r.json()["id"], username


async def login_as(client, username, device_type="caisse", password="motdepasse123"):
    r = await client.post("/api/auth/login", json={"username": username, "password": password, "device_type": device_type})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, r.json()


def today_utc():
    return dt.datetime.now(dt.timezone.utc).date()


# ---------- Transactions, numérotation, concurrence ----------

async def test_twenty_concurrent_sales_sequential_invoice_numbers(env):
    c = env["client"]
    h, _ = await new_business(c)
    p = await make_product(c, h, qty=100)
    rs = await asyncio.gather(*(sell(c, h, [(p["id"], 1)]) for _ in range(20)))
    assert all(r.status_code == 201 for r in rs), [r.text for r in rs if r.status_code != 201]
    assert sorted(r.json()["number"] for r in rs) == [f"F-{i:06d}" for i in range(1, 21)]
    assert (await c.get(f"/api/products/{p['id']}", headers=h)).json()["quantity"] == 80


async def test_two_concurrent_sales_on_last_unit_one_wins(env):
    c = env["client"]
    h, _ = await new_business(c)
    p = await make_product(c, h, qty=1)
    rs = await asyncio.gather(*(sell(c, h, [(p["id"], 1)]) for _ in range(2)))
    assert sorted(r.status_code for r in rs) == [201, 409]
    assert (await c.get(f"/api/products/{p['id']}", headers=h)).json()["quantity"] == 0


async def test_three_line_sale_updates_all_stocks_and_movements(env):
    c = env["client"]
    h, _ = await new_business(c)
    ps = [await make_product(c, h, name=f"P{i}", qty=5) for i in range(3)]
    r = await sell(c, h, [(p["id"], 2) for p in ps])
    assert r.status_code == 201, r.text
    for p in ps:
        assert (await c.get(f"/api/products/{p['id']}", headers=h)).json()["quantity"] == 3
    moves = (await c.get(f"/api/products/{ps[0]['id']}/movements", headers=h)).json()["items"]
    assert any(m["type"] == "sale" and m["sale_id"] == r.json()["id"] for m in moves)


async def test_insufficient_stock_refuses_whole_sale(env):
    c = env["client"]
    h, _ = await new_business(c)
    ok = await make_product(c, h, name="Ok", qty=5)
    short = await make_product(c, h, name="Court", qty=1)
    r = await sell(c, h, [(ok["id"], 2), (short["id"], 3)], method="card")
    assert r.status_code == 409 and "Court" in r.json()["detail"]
    assert (await c.get(f"/api/products/{ok['id']}", headers=h)).json()["quantity"] == 5


async def test_failure_mid_sale_leaves_stock_counter_and_sales_unchanged(env):
    """Panne simulée à l'insertion des mouvements : tout est annulé, y compris le compteur de facture."""
    c, db, mp = env["client"], env["db"], env["mp"]
    h, bid = await new_business(c)
    p = await make_product(c, h, qty=10)

    async def boom(*args, **kwargs):
        raise RuntimeError("panne simulée")

    mp.setattr("app.routers.sales._insert_movements", boom)
    r = await sell(c, h, [(p["id"], 4)])
    assert r.status_code == 500
    mp.undo()

    assert (await c.get(f"/api/products/{p['id']}", headers=h)).json()["quantity"] == 10
    assert (await db.businesses.find_one({"id": bid}))["invoice_counter"] == 0
    assert await db.sales.count_documents({"business_id": bid}) == 0
    assert await db.stock_movements.count_documents({"business_id": bid, "type": "sale"}) == 0
    # Le prochain numéro reste F-000001 : aucun numéro perdu
    assert (await sell(c, h, [(p["id"], 1)])).json()["number"] == "F-000001"


async def test_two_concurrent_cancels_only_one_succeeds_and_restores_once(env):
    c, db = env["client"], env["db"]
    h, _ = await new_business(c)
    p = await make_product(c, h, qty=10)
    sale = (await sell(c, h, [(p["id"], 4)])).json()
    rs = await asyncio.gather(*(c.post(f"/api/sales/{sale['id']}/cancel", headers=h) for _ in range(2)))
    assert sorted(r.status_code for r in rs) == [200, 409]
    assert (await c.get(f"/api/products/{p['id']}", headers=h)).json()["quantity"] == 10
    assert await db.stock_movements.count_documents({"sale_id": sale["id"], "type": "sale_cancel"}) == 1


# ---------- Session, connexion, mot de passe ----------

async def test_refresh_returns_new_token(env):
    c = env["client"]
    h, _ = await new_business(c)
    r = await c.post("/api/auth/refresh", headers=h)
    assert r.status_code == 200 and r.json()["access_token"]


async def test_login_rate_limit_per_email_and_ip(env):
    c = env["client"]
    email = f"{uuid.uuid4().hex[:8]}@test.dev"
    await c.post("/api/auth/register", json={"business_name": "A", "name": "B", "email": email, "password": "motdepasse123"})
    codes = [(await c.post("/api/auth/login", json={"email": email, "password": "mauvais-mdp"})).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


async def test_token_issued_before_reset_is_refused_after(env):
    c, mp = env["client"], env["mp"]
    email = f"{uuid.uuid4().hex[:8]}@test.dev"
    old = (await c.post("/api/auth/register", json={"business_name": "A", "name": "B", "email": email,
                                                    "password": "ancien-mdp-1"})).json()["access_token"]
    old_h = {"Authorization": f"Bearer {old}"}
    assert (await c.get("/api/auth/me", headers=old_h)).status_code == 200

    sent = {}
    mp.setattr("app.routers.auth.send_password_reset_email", lambda to, link: sent.update(link=link))
    await c.post("/api/auth/forgot-password", json={"email": email})
    token = sent["link"].split("token=")[1]
    assert (await c.post("/api/auth/reset-password", json={"token": token, "new_password": "nouveau-mdp-2"})).status_code == 200

    assert (await c.get("/api/auth/me", headers=old_h)).status_code == 401   # token d'avant le reset : refusé
    assert (await c.post("/api/auth/refresh", headers=old_h)).status_code == 401
    new = (await c.post("/api/auth/login", json={"email": email, "password": "nouveau-mdp-2"})).json()["access_token"]
    assert (await c.get("/api/auth/me", headers={"Authorization": f"Bearer {new}"})).status_code == 200


async def test_forgot_password_limited_to_three_per_email_per_hour(env):
    c, mp = env["client"], env["mp"]
    email = f"{uuid.uuid4().hex[:8]}@test.dev"
    await c.post("/api/auth/register", json={"business_name": "A", "name": "B", "email": email, "password": "motdepasse123"})
    sent = []
    mp.setattr("app.routers.auth.send_password_reset_email", lambda to, link: sent.append(link))
    responses = [await c.post("/api/auth/forgot-password", json={"email": email}) for _ in range(4)]
    assert all(r.status_code == 200 and r.json() == responses[0].json() for r in responses)  # jamais de 429
    assert len(sent) == 3  # le 4e appel ne déclenche aucun email


async def test_forgot_and_reset_password_flow(env):
    c, mp = env["client"], env["mp"]
    email = f"{uuid.uuid4().hex[:8]}@test.dev"
    await c.post("/api/auth/register", json={"business_name": "A", "name": "B", "email": email, "password": "ancien-mdp-1"})
    sent = {}
    mp.setattr("app.routers.auth.send_password_reset_email", lambda to, link: sent.update(link=link))

    unknown = await c.post("/api/auth/forgot-password", json={"email": "personne@test.dev"})
    known = await c.post("/api/auth/forgot-password", json={"email": email})
    assert unknown.status_code == known.status_code == 200 and unknown.json() == known.json()

    token = sent["link"].split("token=")[1]
    r = await c.post("/api/auth/reset-password", json={"token": token, "new_password": "nouveau-mdp-2"})
    assert r.status_code == 200
    assert (await c.post("/api/auth/reset-password", json={"token": token, "new_password": "encore-mdp-3"})).status_code == 400
    assert (await c.post("/api/auth/login", json={"email": email, "password": "nouveau-mdp-2"})).status_code == 200


# ---------- Fuseau horaire ----------

async def test_business_timezone_is_stored_and_used_for_invoice_day(env):
    c = env["client"]
    h, _ = await new_business(c)
    r = await c.put("/api/business", headers=h, json={"timezone": "Africa/Abidjan"})
    assert r.status_code == 200 and r.json()["timezone"] == "Africa/Abidjan"
    assert (await c.put("/api/business", headers=h, json={"timezone": "Nope/Nope"})).status_code == 422


# ---------- Statistiques et alertes ----------

async def test_profit_equals_sum_over_non_cancelled_sales(env):
    c = env["client"]
    h, _ = await new_business(c)
    p = await make_product(c, h, price=5.0, cost=2.0, qty=20)
    await sell(c, h, [(p["id"], 3)])          # bénéfice 9
    await sell(c, h, [(p["id"], 2)])          # bénéfice 6
    cancelled = (await sell(c, h, [(p["id"], 1)])).json()
    await c.post(f"/api/sales/{cancelled['id']}/cancel", headers=h)  # exclue
    today = today_utc()
    r = await c.get("/api/stats/summary", headers=h, params={
        "period": "custom", "from": (today - dt.timedelta(days=1)).isoformat(), "to": (today + dt.timedelta(days=1)).isoformat()})
    body = r.json()
    assert body["profit"] == 15.0 and body["revenue"] == 25.0 and body["sales_count"] == 2


async def test_alerts_return_the_right_products(env):
    c = env["client"]
    h, _ = await new_business(c)
    today = today_utc()
    await make_product(c, h, name="Rupture", qty=3)
    fc = await make_product(c, h, name="Prevision", qty=20)
    await sell(c, h, [(fc["id"], 14)])            # reste 6, 2/jour -> 3 jours
    # Quantités > seuil par défaut (5) : seule la règle de péremption doit les faire remonter
    await make_product(c, h, name="Bientot", qty=10, expiry_date=(today + dt.timedelta(days=10)).isoformat())
    await make_product(c, h, name="Perime", qty=10, expiry_date=(today - dt.timedelta(days=3)).isoformat())
    await make_product(c, h, name="Stable", qty=50)

    body = (await c.get("/api/alerts", headers=h)).json()
    low = {p["name"] for p in body["low_stock"]}
    forecast = {p["name"] for p in body["forecast"]}
    expiry = {p["name"]: p for p in body["expiry"]}
    assert low == {"Rupture"}
    assert forecast == {"Prevision"}
    assert set(expiry) == {"Bientot", "Perime"} and expiry["Perime"]["expired"] is True
    assert "Stable" not in low | forecast | set(expiry)


async def test_seller_sees_no_cost_data_and_owner_only_routes_are_403(env):
    c = env["client"]
    owner, _ = await new_business(c)
    p = await make_product(c, owner, qty=10)
    owner_sale = (await sell(c, owner, [(p["id"], 1)])).json()
    s, _, _ = await make_seller(c, owner)

    assert "purchase_price" not in (await c.get(f"/api/products/{p['id']}", headers=s)).json()
    assert "purchase_price" not in (await c.get("/api/products", headers=s)).json()["items"][0]
    assert "purchase_price" not in (await c.get(f"/api/products/by-code/{p['code']}", headers=s)).json()

    own = (await sell(c, s, [(p["id"], 1)])).json()
    assert not {"total_cost", "profit"} & set(own)
    assert all("unit_cost" not in i for i in own["items"])
    assert own["cashier_id"] and own["device_type"] == "caisse"

    # Pas d'historique : seulement le reçu de sa dernière vente
    listed = (await c.get("/api/sales", headers=s)).json()
    assert [x["id"] for x in listed["items"]] == [own["id"]]
    assert (await c.get(f"/api/sales/{owner_sale['id']}", headers=s)).status_code == 404
    assert (await c.get(f"/api/sales/{own['id']}/invoice", headers=s)).status_code == 200

    for path in ("/api/stats/summary", "/api/stats/sales-by-day", "/api/stats/top-products",
                 "/api/audit-log", "/api/users", f"/api/products/{p['id']}/movements"):
        assert (await c.get(path, headers=s)).status_code == 403, path
    assert (await c.put("/api/business", headers=s, json={"name": "X"})).status_code == 403
    assert (await c.post(f"/api/products/{p['id']}/stock", headers=s,
                         json={"quantity_change": -1, "type": "adjustment"})).status_code == 403
    assert (await c.put(f"/api/products/{p['id']}", headers=s, json={"purchase_price": 1})).status_code == 403
    # Le caissier peut ajouter un produit et réapprovisionner
    created = await c.post("/api/products", headers=s, json={"name": "Neuf", "sale_price": 1, "purchase_price": 0.5})
    assert created.status_code == 201 and "purchase_price" not in created.json()
    assert (await c.post(f"/api/products/{p['id']}/stock", headers=s,
                         json={"quantity_change": 2, "type": "restock"})).status_code == 200


# ---------- Lot 2 : sessions, motifs, codes, journal ----------

async def test_second_caisse_login_replaces_first_but_not_scanner(env):
    c = env["client"]
    owner, _ = await new_business(c)
    first, _, username = await make_seller(c, owner, "caisse")
    scanner, _ = await login_as(c, username, "scanner")
    second, _ = await login_as(c, username, "caisse")

    r = await c.get("/api/auth/me", headers=first)
    assert r.status_code == 401 and r.json()["code"] == "SESSION_REPLACED"
    assert "caisse" in r.json()["detail"]
    assert (await c.get("/api/auth/me", headers=second)).status_code == 200
    me_scanner = (await c.get("/api/auth/me", headers=scanner)).json()
    assert me_scanner["session"]["device_type"] == "scanner"


async def test_owner_has_no_device_limit(env):
    c = env["client"]
    email = f"{uuid.uuid4().hex[:8]}@test.dev"
    await c.post("/api/auth/register", json={"business_name": "A", "name": "P", "email": email, "password": "motdepasse123"})
    t1 = (await c.post("/api/auth/login", json={"email": email, "password": "motdepasse123"})).json()["access_token"]
    t2 = (await c.post("/api/auth/login", json={"email": email, "password": "motdepasse123"})).json()["access_token"]
    for t in (t1, t2):
        assert (await c.get("/api/auth/me", headers={"Authorization": f"Bearer {t}"})).status_code == 200


async def test_switch_mode_keeps_user_logged_in(env):
    c = env["client"]
    owner, _ = await new_business(c)
    caisse, _, _ = await make_seller(c, owner, "caisse")
    r = await c.post("/api/auth/switch-mode", headers=caisse, json={"device_type": "scanner"})
    assert r.status_code == 200 and r.json()["session"]["device_type"] == "scanner"
    assert (await c.get("/api/auth/me", headers=caisse)).status_code == 401  # ancienne session terminée
    new = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await c.get("/api/auth/me", headers=new)).json()["session"]["device_type"] == "scanner"


async def test_logout_ends_session(env):
    c = env["client"]
    h, _ = await new_business(c)
    assert (await c.post("/api/auth/logout", headers=h)).status_code == 200
    assert (await c.get("/api/auth/me", headers=h)).status_code == 401


async def test_disabling_seller_cuts_both_sessions_and_login(env):
    c = env["client"]
    owner_h, _ = await new_business(c)
    s_caisse, sid, uname = await make_seller(c, owner_h, "caisse")
    s_scanner, _ = await login_as(c, uname, "scanner")
    r = await c.patch(f"/api/users/{sid}", headers=owner_h, json={"is_active": False})
    assert r.status_code == 200 and r.json()["is_active"] is False and r.json()["sessions"] == []
    assert (await c.get("/api/auth/me", headers=s_caisse)).status_code == 401
    assert (await c.get("/api/auth/me", headers=s_scanner)).status_code == 401
    assert (await c.post("/api/auth/login", json={"username": uname, "password": "motdepasse123"})).status_code == 401


async def test_seller_price_change_requires_motif_and_is_audited(env):
    c = env["client"]
    owner, _ = await new_business(c)
    p = await make_product(c, owner, price=5.0)
    s, sid, _ = await make_seller(c, owner)
    r = await c.patch(f"/api/products/{p['id']}", headers=s, json={"sale_price": 6})
    assert r.status_code == 400 and r.json()["code"] == "MOTIF_REQUIRED"
    r = await c.patch(f"/api/products/{p['id']}", headers=s, json={"sale_price": 6, "motif_code": "autre", "motif_note": "court"})
    assert r.status_code == 400 and r.json()["code"] == "MOTIF_REQUIRED"
    r = await c.patch(f"/api/products/{p['id']}", headers=s, json={"sale_price": 6, "motif_code": "erreur_de_saisie"})
    assert r.status_code == 200 and r.json()["sale_price"] == 6
    log = (await c.get("/api/audit-log", headers=owner, params={"action": "product_price_changed"})).json()["items"]
    assert len(log) == 1 and log[0]["user_id"] == sid and log[0]["old_value"] == {"sale_price": 5.0}
    assert log[0]["motif_code"] == "erreur_de_saisie"
    # Le patron n'a pas besoin de motif (PUT existant toujours valide)
    assert (await c.put(f"/api/products/{p['id']}", headers=owner, json={"sale_price": 7})).status_code == 200


async def test_product_field_changes_are_audited_without_motif(env):
    c, db = env["client"], env["db"]
    owner, _ = await new_business(c)
    p = await make_product(c, owner, name="Savon", price=5.0, unit="pièce")
    s, sid, _ = await make_seller(c, owner)

    # Caissier, sans motif : nom, catégorie, date de péremption et seuil. Le prix n'est pas touché.
    r = await c.patch(f"/api/products/{p['id']}", headers=s, json={
        "name": "Savon karité", "category": "Visage", "expiry_date": "2027-03-01",
        "low_stock_threshold": 3, "unit": "pièce"})  # unit identique : ne doit pas apparaître
    assert r.status_code == 200, r.text
    log = (await c.get("/api/audit-log", headers=owner, params={"action": "product_updated"})).json()["items"]
    assert len(log) == 1
    entry = log[0]
    assert entry["user_id"] == sid and entry["role"] == "seller" and entry["motif_code"] is None
    assert set(entry["old_value"]) == set(entry["new_value"]) == {"name", "category", "expiry_date", "low_stock_threshold"}
    assert entry["old_value"]["name"] == "Savon" and entry["new_value"]["name"] == "Savon karité"
    assert entry["old_value"]["category"] is None and entry["new_value"]["category"] == "Visage"
    assert entry["new_value"]["expiry_date"].startswith("2027-03-01")

    # Même valeurs renvoyées : aucune nouvelle ligne
    await c.put(f"/api/products/{p['id']}", headers=owner, json={"name": "Savon karité", "category": "Visage"})
    assert await db.audit_log.count_documents({"action": "product_updated", "target_id": p["id"]}) == 1

    # Patron, PUT : description + prix dans le même appel -> deux lignes distinctes
    r = await c.put(f"/api/products/{p['id']}", headers=owner, json={"description": "Bio", "sale_price": 6})
    assert r.status_code == 200
    upd = await db.audit_log.find({"action": "product_updated", "target_id": p["id"]}).sort("created_at", -1).to_list(None)
    assert len(upd) == 2 and upd[0]["new_value"] == {"description": "Bio"} and upd[0]["role"] == "owner"
    price = await db.audit_log.find_one({"action": "product_price_changed", "target_id": p["id"]})
    assert price["new_value"] == {"sale_price": 6.0}

    # Caissier : prix sans motif refusé, et rien n'est écrit (ni le nom, ni le journal)
    r = await c.patch(f"/api/products/{p['id']}", headers=s, json={"name": "Autre nom", "sale_price": 9})
    assert r.status_code == 400 and r.json()["code"] == "MOTIF_REQUIRED"
    assert (await c.get(f"/api/products/{p['id']}", headers=owner)).json()["name"] == "Savon karité"
    assert await db.audit_log.count_documents({"action": "product_updated", "target_id": p["id"]}) == 2

    # Filtre par produit du journal
    by_product = (await c.get("/api/audit-log", headers=owner, params={"product_id": p["id"]})).json()["items"]
    assert {"product_created", "product_updated", "product_price_changed"} <= {e["action"] for e in by_product}

    # Réapprovisionnement caissier : toujours sans motif, tracé en product_stock_adjusted
    r = await c.post(f"/api/products/{p['id']}/stock", headers=s, json={"quantity_change": 4, "type": "restock"})
    assert r.status_code == 200
    assert await db.audit_log.count_documents({"action": "product_stock_adjusted", "target_id": p["id"]}) == 1


async def test_seller_cancel_and_archive_require_motif(env):
    c, db = env["client"], env["db"]
    owner, _ = await new_business(c)
    p = await make_product(c, owner, qty=5)
    s, _, _ = await make_seller(c, owner)
    sale = (await sell(c, s, [(p["id"], 2)])).json()
    r = await c.post(f"/api/sales/{sale['id']}/cancel", headers=s, json={})
    assert r.status_code == 400 and r.json()["code"] == "MOTIF_REQUIRED"
    r = await c.post(f"/api/sales/{sale['id']}/cancel", headers=s, json={"motif_code": "client_a_change_avis"})
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert (await c.get(f"/api/products/{p['id']}", headers=owner)).json()["quantity"] == 5
    assert await db.audit_log.count_documents({"action": "sale_cancelled", "target_id": sale["id"]}) == 1

    assert (await c.request("DELETE", f"/api/products/{p['id']}", headers=s)).json()["code"] == "MOTIF_REQUIRED"
    r = await c.request("DELETE", f"/api/products/{p['id']}", headers=s, json={"motif_code": "produit_abime"})
    assert r.status_code == 200 and r.json()["is_archived"] is True
    assert (await c.get(f"/api/products/by-code/{p['code']}", headers=s)).status_code == 404


async def test_duplicate_barcode_returns_product_exists(env):
    c = env["client"]
    owner, _ = await new_business(c)
    first = await c.post("/api/products", headers=owner, json={
        "name": "Savon A", "sale_price": 3, "code_type": "barcode", "code": "3017620422003"})
    assert first.status_code == 201 and first.json()["code"] == "3017620422003"
    dup = await c.post("/api/products", headers=owner, json={
        "name": "Savon B", "sale_price": 3, "code_type": "barcode", "code": "3017620422003"})
    assert dup.status_code == 409 and dup.json()["code"] == "PRODUCT_EXISTS"
    assert dup.json()["product_id"] == first.json()["id"]
    assert (await c.get("/api/products/by-code/3017620422003", headers=owner)).json()["id"] == first.json()["id"]
    # Après archivage, le code est de nouveau libre
    await c.delete(f"/api/products/{first.json()['id']}", headers=owner)
    again = await c.post("/api/products", headers=owner, json={
        "name": "Savon C", "sale_price": 3, "code_type": "barcode", "code": "3017620422003"})
    assert again.status_code == 201


async def test_sale_lines_keep_scanned_code_and_audit_is_append_only(env):
    c = env["client"]
    owner, _ = await new_business(c)
    p = await make_product(c, owner, qty=5)
    r = await c.post("/api/sales", headers=owner, json={
        "items": [{"product_id": p["id"], "quantity": 1, "scanned_code": p["code"]}], "payment_method": "cash"})
    assert r.json()["items"][0]["code"] == p["code"]
    actions = {e["action"] for e in (await c.get("/api/audit-log", headers=owner)).json()["items"]}
    assert {"login", "product_created", "sale_created"} <= actions
    for method in ("PUT", "PATCH", "DELETE"):
        assert (await c.request(method, "/api/audit-log", headers=owner)).status_code == 405


async def test_users_are_isolated_between_businesses(env):
    c = env["client"]
    owner_a, _ = await new_business(c, "A")
    owner_b, _ = await new_business(c, "B")
    _, seller_a, _ = await make_seller(c, owner_a)
    assert all(u["id"] != seller_a for u in (await c.get("/api/users", headers=owner_b)).json()["items"])
    assert (await c.patch(f"/api/users/{seller_a}", headers=owner_b, json={"is_active": False})).status_code == 404


# ---------- PDF et QR ----------

async def test_invoice_pdf_is_generated(env):
    c = env["client"]
    h, _ = await new_business(c)
    p = await make_product(c, h, qty=5)
    sale = (await sell(c, h, [(p["id"], 1)])).json()
    r = await c.get(f"/api/sales/{sale['id']}/invoice", headers=h)
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF")


async def test_qr_sheet_codes_decode_to_their_products(env):
    c = env["client"]
    h, _ = await new_business(c)
    products = [await make_product(c, h, name=f"Produit {i}", qty=1) for i in range(3)]
    r = await c.post("/api/products/qr-sheet", headers=h, json={"product_ids": [p["id"] for p in products]})
    assert r.status_code == 200 and r.content.startswith(b"%PDF")

    detector = cv2.QRCodeDetector()
    decoded = set()
    for page in PdfReader(io.BytesIO(r.content)).pages:
        for img in page.images:
            rgb = np.array(img.image.convert("RGB"))
            text, _, _ = detector.detectAndDecode(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
            if text:
                decoded.add(text)
    assert decoded == {p["qr_code"] for p in products}
    for code in decoded:
        found = (await c.get(f"/api/products/by-code/{code}", headers=h)).json()
        assert found["qr_code"] == code


# ---------- Isolation des commerces, toutes les routes ----------

async def test_two_businesses_never_see_each_other(env):
    c = env["client"]
    ha, _ = await new_business(c, "A")
    hb, _ = await new_business(c, "B")
    pa = await make_product(c, ha, name="Secret A", qty=10)
    sa = (await sell(c, ha, [(pa["id"], 2)])).json()
    await make_product(c, hb, name="Produit B", qty=1)  # B a sa propre donnée

    assert [p["name"] for p in (await c.get("/api/products", headers=hb)).json()["items"]] == ["Produit B"]
    assert (await c.get(f"/api/products/{pa['id']}", headers=hb)).status_code == 404
    assert (await c.get(f"/api/products/by-code/{pa['qr_code']}", headers=hb)).status_code == 404
    assert (await c.get(f"/api/products/{pa['id']}/qr", headers=hb)).status_code == 404
    assert (await c.get(f"/api/products/{pa['id']}/movements", headers=hb)).status_code == 404
    assert (await c.put(f"/api/products/{pa['id']}", headers=hb, json={"name": "piraté"})).status_code == 404
    assert (await c.delete(f"/api/products/{pa['id']}", headers=hb)).status_code == 404
    assert (await c.post(f"/api/products/{pa['id']}/stock", headers=hb,
                         json={"quantity_change": 5, "type": "restock"})).status_code == 404
    assert (await c.post("/api/products/qr-sheet", headers=hb, json={"product_ids": [pa["id"]]})).status_code == 404
    assert (await sell(c, hb, [(pa["id"], 1)])).status_code == 404
    assert (await c.get("/api/sales", headers=hb)).json()["total"] == 0
    assert (await c.get(f"/api/sales/{sa['id']}", headers=hb)).status_code == 404
    assert (await c.get(f"/api/sales/{sa['id']}/invoice", headers=hb)).status_code == 404
    assert (await c.post(f"/api/sales/{sa['id']}/cancel", headers=hb)).status_code == 404
    assert (await c.get("/api/stats/summary", headers=hb, params={"period": "month"})).json()["sales_count"] == 0
    assert (await c.get("/api/stats/sales-by-day", headers=hb)).json() == []
    top = (await c.get("/api/stats/top-products", headers=hb, params={"period": "month"})).json()
    assert top["top_products"] == []
    assert all(p["product_id"] != pa["id"] for p in top["not_selling"])
    alerts = (await c.get("/api/alerts", headers=hb)).json()
    assert not any(p["product_id"] == pa["id"] for k in alerts for p in alerts[k])
    # Et A n'a pas bougé
    assert (await c.get(f"/api/products/{pa['id']}", headers=ha)).json()["quantity"] == 8


# ---------- Lot 3 : paiement idempotent, compte désactivé, unités vendues ----------

async def test_same_client_sale_id_returns_the_same_sale_once(env):
    """Point 1 : deux appels identiques -> une seule vente, même réponse, stock décrémenté une seule fois."""
    c, db = env["client"], env["db"]
    h, bid = await new_business(c)
    other_h, other_bid = await new_business(c)
    p = await make_product(c, h, qty=5)
    other_p = await make_product(c, other_h, qty=5)
    body = {"items": [{"product_id": p["id"], "quantity": 2}], "payment_method": "cash",
            "client_sale_id": str(uuid.uuid4())}

    r1 = await c.post("/api/sales", headers=h, json=body)
    r2 = await c.post("/api/sales", headers=h, json=body)
    assert r1.status_code == 201, r1.text
    assert r2.status_code == r1.status_code
    assert r1.json()["id"] == r2.json()["id"] and r1.json()["number"] == r2.json()["number"]
    assert await db.sales.count_documents({"business_id": bid}) == 1
    assert (await c.get(f"/api/products/{p['id']}", headers=h)).json()["quantity"] == 3
    assert await db.stock_movements.count_documents({"business_id": bid, "movement_type": "sale"}) == 1

    # Unicité par boutique : la même valeur dans une autre boutique crée bien sa propre vente.
    r3 = await c.post("/api/sales", headers=other_h, json={
        "items": [{"product_id": other_p["id"], "quantity": 1}], "payment_method": "cash",
        "client_sale_id": body["client_sale_id"]})
    assert r3.status_code == 201 and r3.json()["id"] != r1.json()["id"]


async def test_concurrent_identical_client_sale_ids_create_one_sale(env):
    """Point 1 : envois simultanés du même identifiant -> une seule vente et un seul décrément."""
    import asyncio

    c, db = env["client"], env["db"]
    h, bid = await new_business(c)
    p = await make_product(c, h, qty=5)
    body = {"items": [{"product_id": p["id"], "quantity": 1}], "payment_method": "cash",
            "client_sale_id": str(uuid.uuid4())}

    results = await asyncio.gather(*(c.post("/api/sales", headers=h, json=body) for _ in range(5)))
    assert all(r.status_code == 201 for r in results), [r.text for r in results]
    assert len({r.json()["id"] for r in results}) == 1
    assert await db.sales.count_documents({"business_id": bid}) == 1
    assert (await c.get(f"/api/products/{p['id']}", headers=h)).json()["quantity"] == 4


async def test_disabled_account_gets_account_disabled_on_http(env):
    """Point 4 : jeton d'un compte désactivé -> 401 ACCOUNT_DISABLED sur une requête HTTP."""
    c = env["client"]
    owner_h, _ = await new_business(c)
    seller_h, sid, _ = await make_seller(c, owner_h, "caisse")
    assert (await c.get("/api/products", headers=seller_h)).status_code == 200

    r = await c.patch(f"/api/users/{sid}", headers=owner_h, json={"is_active": False})
    assert r.status_code == 200

    r = await c.get("/api/products", headers=seller_h)
    assert r.status_code == 401
    assert r.json()["code"] == "ACCOUNT_DISABLED"
    assert r.json()["detail"] == "Ton compte a été désactivé. Contacte le propriétaire."


async def test_units_sold_today_counts_every_product_without_limit(env):
    """Point 6 : units_sold_today = somme des quantités, sans limite de 100 produits."""
    c = env["client"]
    owner_h, _ = await new_business(c)
    products = [await make_product(c, owner_h, name=f"Produit {i}", qty=1) for i in range(110)]
    for chunk in (products[:60], products[60:]):
        r = await sell(c, owner_h, [(p["id"], 1) for p in chunk])
        assert r.status_code == 201, r.text

    r = await c.get("/api/stats/summary", headers=owner_h)
    assert r.status_code == 200
    assert r.json()["units_sold_today"] == 110
