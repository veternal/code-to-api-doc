router.get('/users/:id', getUser);
app.post('/login', async (req, res) => {});
router.get('/members', auth(), controllers.list);
router.post(
  '/multiline',
  validate({ message: 'keep (commas, and parentheses)' }),
  saveUser
);
router.get('/named', function namedHandler(req, res) {});
router.get('/anonymous', function (req, res) {});
router.get('/wrapped', wrap(getUser));
router.get('/left', left); router.get('/right', right);
// router.get('/commented', absent);
router.get('/no-handler');
router.get('/next', async (req, res) => {});
const sample = "router.get('/inside-string', absent)";
/* router.get('/inside-comment', absent); */
router.get(`/dynamic/${id}`, getUser);
router.get('/with-regex', (req, res) => res.send(/[)]/.test(req.query.q)));
