@RequestMapping("/api")
public class NamedController {
    @GetMapping(path = "/dynamic" + SUFFIX)
    public void dynamic() {}

    @GetMapping(value = PREFIX + "/dynamic")
    public void dynamicPrefix() {}

    @GetMapping("/notes/path = '/fake'")
    public void literalText() {}

    @GetMapping(path = "/static", produces = "application/json")
    public void staticPath() {}
}
