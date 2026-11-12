@app.get('/items/{id}')
async def get_item(id):
    return {}

@bp.route('/submit', methods=['POST', 'PUT'])
def submit():
    return {}
