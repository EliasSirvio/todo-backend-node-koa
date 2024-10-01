const router = require('koa-router')();

const sqlite3 = require('sqlite3').verbose;
const db = new sqlite3.Database('mydb.sqlite');

const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');

const app = new Koa();

// Database
db.serialize(() => {
  db.run(`
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT 0,
      "order" INTEGER
    )
  `);

  db.run(`
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )
  `);

  db.run(`
    CREATE TABLE todo_tags (
      todo_id INTEGER,
      tag_id INTEGER,
      FOREIGN KEY (todo_id) REFERENCES todos (id),
      FOREIGN KEY (tag_id) REFERENCES tags (id),
      PRIMARY KEY (todo_id, tag_id)
    )
  `);
});


//TODOS
let todos = {
  0: {'title': 'build an API', 'order': 1, 'completed': false},
  1: {'title': '?????', 'order': 2, 'completed': false},
  2: {'title': 'profit!', 'order': 3, 'completed': false}
};
let nextId = 3;

router.get('/todos/', list)
  .del('/todos/', clear)
  .post('/todos/', add)
  .get('todo', '/todos/:id', show)
  .patch('/todos/:id', update)
  .del('/todos/:id', remove);

  async function list(ctx) {
    db.all(`SELECT * FROM todos`, (err, todos) => {
      if (err) {
        ctx.throw(500, { 'error': 'Failed to list todos' });
      }
  
      // Get tags for each todo
      const todoPromises = todos.map(todo => {
        return new Promise((resolve, reject) => {
          db.all(
            `SELECT name FROM tags INNER JOIN todo_tags ON tags.id = todo_tags.tag_id WHERE todo_tags.todo_id = ?`,
            [todo.id],
            (err, tags) => {
              if (err) {
                reject(err);
              } else {
                todo.tags = tags.map(tag => tag.name);
                resolve(todo);
              }
            }
          );
        });
      });
  
      Promise.all(todoPromises)
        .then(results => {
          ctx.body = results;
        })
        .catch(err => {
          ctx.throw(500, { 'error': 'Failed to retrieve tags' });
        });
    });
  }
  

async function clear(ctx) {
  todos = {};
  ctx.status = 204;
}

// Function to add a new todo with tags parsed from the title
async function add(ctx) {
  const { title, completed = false } = ctx.request.body;

  // Validate title
  if (!title || typeof title !== 'string' || !title.length) {
    ctx.throw(400, { 'error': '"title" must be a string with at least one character' });
  }

  // Extract tags from the title using a regular expression
  const tagRegex = /#(\w+)/g;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(title)) !== null) {
    tags.push(match[1]);
  }

  // Remove tags from the title to store the plain title
  const cleanedTitle = title.replace(tagRegex, '').trim();

  db.serialize(() => {
    // Insert the cleaned todo title into the todos table
    db.run(
      `INSERT INTO todos (title, completed, "order") VALUES (?, ?, ?)`,
      [cleanedTitle, completed, nextId],
      function (err) {
        if (err) {
          ctx.throw(500, { 'error': 'Failed to add todo' });
        }

        const todoId = this.lastID;

        // Insert tags into the tags table and link them to the todo
        tags.forEach(tag => {
          db.get(`SELECT id FROM tags WHERE name = ?`, [tag], (err, row) => {
            if (err) {
              ctx.throw(500, { 'error': 'Failed to add tag' });
            }

            if (row) {
              // Tag already exists, use its id
              db.run(`INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`, [todoId, row.id]);
            } else {
              // Insert new tag and link it to the todo
              db.run(`INSERT INTO tags (name) VALUES (?)`, [tag], function () {
                const tagId = this.lastID;
                db.run(`INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`, [todoId, tagId]);
              });
            }
          });
        });

        ctx.status = 201;
        ctx.body = { id: todoId, title: cleanedTitle, completed, tags };
      }
    );
  });
}

async function show(ctx) {
  const id = ctx.params.id;
  const todo = todos[id]
  if (!todo) ctx.throw(404, {'error': 'Todo not found'});
  todo.id = id;
  ctx.body = todo;
}

async function update(ctx) {
  const id = ctx.params.id;
  const { title, completed, tags } = ctx.request.body;

  db.serialize(() => {
    // Update todo fields
    if (title || completed !== undefined) {
      db.run(
        `UPDATE todos SET title = COALESCE(?, title), completed = COALESCE(?, completed) WHERE id = ?`,
        [title, completed, id],
        (err) => {
          if (err) {
            ctx.throw(500, { 'error': 'Failed to update todo' });
          }
        }
      );
    }

    // Update tags if provided
    if (tags) {
      db.run(`DELETE FROM todo_tags WHERE todo_id = ?`, [id], (err) => {
        if (err) {
          ctx.throw(500, { 'error': 'Failed to clear old tags' });
        }

        tags.forEach(tag => {
          db.get(`SELECT id FROM tags WHERE name = ?`, [tag], (err, row) => {
            if (err) {
              ctx.throw(500, { 'error': 'Failed to update tags' });
            }

            if (row) {
              // Tag already exists, link it
              db.run(`INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`, [id, row.id]);
            } else {
              // Insert new tag and link it
              db.run(`INSERT INTO tags (name) VALUES (?)`, [tag], function () {
                const tagId = this.lastID;
                db.run(`INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`, [id, tagId]);
              });
            }
          });
        });
      });
    }

    ctx.status = 200;
    ctx.body = { id, title, completed, tags };
  });
}


async function remove(ctx) {
  const id = ctx.params.id;
  if (!todos[id]) ctx.throw(404, {'error': 'Todo not found'});

  delete todos[id];

  ctx.status = 204;
}

app
  .use(bodyParser())
  .use(cors())
  .use(router.routes())
  .use(router.allowedMethods());

app.listen(8080);

