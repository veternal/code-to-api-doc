func routes() {
    r.GET("/go/items", getItems)
    mux.HandleFunc("/go/health", health)
}
