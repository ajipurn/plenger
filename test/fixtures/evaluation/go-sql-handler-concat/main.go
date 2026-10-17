package main

import (
	"database/sql"
	"encoding/json"
	"net/http"

	_ "github.com/mattn/go-sqlite3"
)

var db *sql.DB

func ordersHandler(w http.ResponseWriter, r *http.Request) {
	customer := r.URL.Query().Get("customer")
	rows, err := db.Query("SELECT id, total FROM orders WHERE customer = '" + customer + "'")
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	orders := []map[string]any{}
	for rows.Next() {
		var id string
		var total float64
		if err := rows.Scan(&id, &total); err != nil {
			continue
		}
		orders = append(orders, map[string]any{"id": id, "total": total})
	}
	json.NewEncoder(w).Encode(orders)
}

func main() {
	var err error
	db, err = sql.Open("sqlite3", "orders.db")
	if err != nil {
		panic(err)
	}
	http.HandleFunc("/orders", ordersHandler)
	http.ListenAndServe(":8080", nil)
}
