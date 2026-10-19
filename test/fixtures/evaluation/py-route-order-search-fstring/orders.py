import sqlite3

connection = sqlite3.connect("orders.db", check_same_thread=False)


def find_orders(customer: str) -> list[tuple]:
    rows = connection.execute(
        f"SELECT id, total FROM orders WHERE customer = '{customer}' ORDER BY id"
    )
    return rows.fetchall()
