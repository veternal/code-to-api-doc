@Controller({ path: '/dynamic' + suffix })
class DynamicController {
  @Get()
  dynamic() {}
}

@Controller("/notes/path: '/fake'")
class LiteralController {
  @Get()
  literalText() {}
}

@Controller({ path: '/static', version: '1' })
class StaticController {
  @Get()
  staticPath() {}
}
