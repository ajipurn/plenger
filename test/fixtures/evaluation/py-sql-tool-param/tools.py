import sqlite3

from langchain_core.tools import tool

DB = sqlite3.connect("orders.db")


@tool
def find_orders(customer: str) -> list:
    """Find a customer's orders."""
    cursor = DB.execute("SELECT id, total FROM orders WHERE customer = ?", (customer,))
    return cursor.fetchall()
