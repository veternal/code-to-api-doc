@Controller('cats')
export class CatsController {
  @Get(':id')
  async findOne() { return {}; }

  @Post()
  create() { return {}; }
}

@Controller('/dogs/')
export class DogsController {
  @Get(
    '/:id'
  )
  findDog() { return {}; }
}

@Controller()
export class HealthController {
  @Get()
  health() { return 'ok'; }
}
