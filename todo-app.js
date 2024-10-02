const Koa = require('koa');
const Router = require('koa-router');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');

const app = new Koa();
const router = new Router();

// Open the database (or create it if it doesn't exist)
const db = new sqlite3.Database('mydb.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// Database setup
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT 0,
      "order" INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS todo_tags (
      todo_id INTEGER,
      tag_id INTEGER,
      FOREIGN KEY (todo_id) REFERENCES todos (id),
      FOREIGN KEY (tag_id) REFERENCES tags (id),
      PRIMARY KEY (todo_id, tag_id)
    )
  `);
});

// Route Handlers

// List all todos
async function list(ctx) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM todos`, (err, todos) => {
      if (err) {
        ctx.throw(500, { error: 'Failed to list todos' });
        reject(err);
      }

      const todoPromises = todos.map((todo) => {
        return new Promise((resolveTodo, rejectTodo) => {
          db.all(
            `SELECT name FROM tags INNER JOIN todo_tags ON tags.id = todo_tags.tag_id WHERE todo_tags.todo_id = ?`,
            [todo.id],
            (err, tags) => {
              if (err) {
                rejectTodo(err);
              } else {
                todo.tags = tags.map((tag) => tag.name);
                resolveTodo(todo);
              }
            }
          );
        });
      });

      Promise.all(todoPromises)
        .then((results) => {
          ctx.body = results;
          resolve();
        })
        .catch((err) => {
          ctx.throw(500, { error: 'Failed to retrieve tags' });
          reject(err);
        });
    });
  });
}

// Clear all todos
async function clear(ctx) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM todos`, (err) => {
      if (err) {
        ctx.throw(500, { error: 'Failed to clear todos' });
        reject(err);
      } else {
        ctx.status = 204;
        resolve();
      }
    });
  });
}

// Add a new todo
async function add(ctx) {
  const { title, completed = false } = ctx.request.body;

  // Validate title
  if (!title || typeof title !== 'string' || !title.length) {
    ctx.throw(400, { error: '"title" must be a string with at least one character' });
  }

  // Extract tags from the title
  const tagRegex = /#(\w+)/g;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(title)) !== null) {
    tags.push(match[1]);
  }

  const cleanedTitle = title.replace(tagRegex, '').trim();

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO todos (title, completed, "order") VALUES (?, ?, ?)`,
      [cleanedTitle, completed, Date.now()],
      function (err) {
        if (err) {
          ctx.throw(500, { error: 'Failed to add todo' });
          reject(err);
        }

        const todoId = this.lastID;

        // Handle tag creation and linking
        const tagPromises = tags.map((tag) => {
          return new Promise((resolveTag, rejectTag) => {
            db.get(`SELECT id FROM tags WHERE name = ?`, [tag], (err, row) => {
              if (err) {
                rejectTag(err);
              } else if (row) {
                db.run(
                  `INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`,
                  [todoId, row.id],
                  (err) => {
                    if (err) rejectTag(err);
                    else resolveTag();
                  }
                );
              } else {
                db.run(`INSERT INTO tags (name) VALUES (?)`, [tag], function () {
                  db.run(
                    `INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`,
                    [todoId, this.lastID],
                    (err) => {
                      if (err) rejectTag(err);
                      else resolveTag();
                    }
                  );
                });
              }
            });
          });
        });

        Promise.all(tagPromises)
          .then(() => {
            ctx.status = 201;
            ctx.body = { id: todoId, title: cleanedTitle, completed, tags };
            resolve();
          })
          .catch((err) => {
            ctx.throw(500, { error: 'Failed to add tags' });
            reject(err);
          });
      }
    );
  });
}

// Setup the routes
router.get('/todos/', list)
  .del('/todos/', clear)
  .post('/todos/', add)
  .get('/todos/:id', show)
  .patch('/todos/:id', update)
  .del('/todos/:id', remove);

// Use middleware
app
  .use(bodyParser())
  .use(cors())
  .use(router.routes())
  .use(router.allowedMethods());

app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
