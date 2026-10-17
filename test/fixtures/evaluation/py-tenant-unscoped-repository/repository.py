import sqlite3

DB = sqlite3.connect("app.db", check_same_thread=False)
DB.row_factory = sqlite3.Row


class InvoiceRepository:
    def get(self, user, invoice_id):
        row = DB.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        return dict(row) if row else None
