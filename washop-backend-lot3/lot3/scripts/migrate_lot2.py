"""
Migration du lot 2 (comptes, sessions, codes produits). Peut être relancée sans risque.
Usage, depuis le dossier backend, avec les mêmes variables d'environnement que le serveur :
    python -m scripts.migrate_lot2
"""
import asyncio

from app.db import close_db, connect_db, create_indexes, ensure_replica_set


async def main() -> None:
    db = await connect_db()
    await ensure_replica_set(db)

    # Produits vague 1 : code_type qr et code = identifiant du QR actuel
    r_code = await db.products.update_many(
        {"code": {"$exists": False}, "qr_code": {"$type": "string"}},
        [{"$set": {"code": "$qr_code", "code_type": "qr"}}],
    )
    r_del = await db.products.update_many(
        {"deleted_at": {"$exists": False}}, {"$set": {"deleted_at": None, "deleted_by": None}}
    )
    r_tv = await db.users.update_many({"token_version": {"$exists": False}}, {"$set": {"token_version": 0}})

    # Ventes vague 1 : caissier = créateur, code de ligne = code du produit
    names = {u["id"]: u.get("name") async for u in db.users.find({}, {"_id": 0, "id": 1, "name": 1})}
    codes = {p["id"]: p.get("code") or p.get("qr_code") async for p in db.products.find({}, {"_id": 0, "id": 1, "code": 1, "qr_code": 1})}
    sales_done = 0
    async for sale in db.sales.find({"cashier_id": {"$exists": False}}, {"_id": 0}):
        items = [{**i, "code": i.get("code") or codes.get(i["product_id"])} for i in sale["items"]]
        res = await db.sales.update_one(
            {"id": sale["id"], "cashier_id": {"$exists": False}},
            {"$set": {
                "cashier_id": sale.get("created_by"),
                "cashier_name": names.get(sale.get("created_by")),
                "session_id": None,
                "device_type": None,
                "cancelled_by": sale.get("cancelled_by"),
                "items": items,
            }},
        )
        sales_done += res.modified_count

    # Index : email et code uniques en partiel, sessions, journal (recréés si l'ancienne version existe)
    await create_indexes(db)
    close_db()
    print(f"Produits avec code : {r_code.modified_count}, deleted_at ajouté : {r_del.modified_count}, "
          f"comptes avec token_version : {r_tv.modified_count}, ventes complétées : {sales_done}. Index à jour.")


if __name__ == "__main__":
    asyncio.run(main())
