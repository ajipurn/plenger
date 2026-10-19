import sqlite3

connection = sqlite3.connect("orders.db", check_same_thread=False)


def find_orders(customer: str) -> list[tuple]:
    rows = connection.execute(
        "SELECT id, total FROM orders WHERE customer = ? ORDER BY id", (customer,)
    )
    return rows.fetchall()
