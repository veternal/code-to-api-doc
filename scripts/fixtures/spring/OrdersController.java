@RestController
@RequestMapping(
    value = "/api/v1"
)
public class OrdersController {
    @GetMapping(
        "/orders/{id}"
    )
    public Order get(@PathVariable String id) { return null; }

    @PostMapping("/orders")
    public Order create() { return null; }

    @RequestMapping(
        path = "/health",
        method = RequestMethod.HEAD
    )
    public void health() {}
}
