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

// Routes for Todos
router
  .get('/todos/', async (ctx) => {
    // Retrieve all todos from the database
    const todos = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM todos`, (err, rows) => {
        if (err) return reject(err);
        resolve(
          rows.map((row) => ({
            ...row,
            id: String(row.id), // Ensure id is a string
            completed: row.completed === 1, // Convert completed to boolean
            order: row.order !== null ? row.order : null,
          }))
        );
      });
    });

    // Fetch tags associated with each todo
    const todoPromises = todos.map((todo) => {
      return new Promise((resolve, reject) => {
        db.all(
          `SELECT tags.id, tags.name FROM tags
           INNER JOIN todo_tags ON tags.id = todo_tags.tag_id
           WHERE todo_tags.todo_id = ?`,
          [todo.id],
          (err, tags) => {
            if (err) return reject(err);
            // Map 'name' to 'title' and add 'url' for each tag
            todo.tags = tags.map((tag) => ({
              id: String(tag.id),
              title: tag.name,
              url: `${ctx.origin}/tags/${tag.id}`,
            }));
            resolve(todo);
          }
        );
      });
    });

    const todosWithTags = await Promise.all(todoPromises);

    // Add url property to each todo
    todosWithTags.forEach((todo) => {
      todo.url = `${ctx.origin}/todos/${todo.id}`;
    });

    ctx.body = todosWithTags;
  })
  .post('/todos/', async (ctx) => {
    const { title, completed = false, order } = ctx.request.body;

    // Validate 'order' if provided
    if (order !== undefined && typeof order !== 'number') {
      ctx.throw(400, { error: '"order" must be a number' });
    }

    // Extract tags from title (if any)
    const tagRegex = /#(\w+)/g;
    const tags = [];
    let match;
    while ((match = tagRegex.exec(title)) !== null) {
      if (match[1]) {
        tags.push(match[1]);
      }
    }

    const cleanedTitle = title.replace(tagRegex, '').trim();
    const completedValue = completed ? 1 : 0; // Convert boolean to SQLite value

    // Insert the todo into the database
    const todoId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO todos (title, completed, "order") VALUES (?, ?, ?)`,
        [cleanedTitle, completedValue, order],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    // Add tags to the database if not already present, and link them to the new todo
    await Promise.all(
      tags.map((tag) => {
        return new Promise((resolve, reject) => {
          db.get(`SELECT id FROM tags WHERE name = ?`, [tag], (err, row) => {
            if (err) return reject(err);

            if (row) {
              // If the tag already exists, link it to the todo
              db.run(
                `INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`,
                [todoId, row.id],
                (err) => {
                  if (err) reject(err);
                  else resolve();
                }
              );
            } else {
              // Insert new tag and link it to the todo
              db.run(`INSERT INTO tags (name) VALUES (?)`, [tag], function (err) {
                if (err) return reject(err);
                db.run(
                  `INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`,
                  [todoId, this.lastID],
                  (err) => {
                    if (err) reject(err);
                    else resolve();
                  }
                );
              });
            }
          });
        });
      })
    );

    // Prepare tags for the response
    const tagsResponse = tags.map((tagName) => ({
      title: tagName,
      // Since we might not have the tag ID at this point, we can omit 'id' and 'url' or fetch them if necessary
    }));

    ctx.status = 201;
    ctx.body = {
      id: String(todoId),
      title: cleanedTitle,
      completed,
      order: order !== undefined ? order : null,
      url: `${ctx.origin}/todos/${todoId}`,
      tags: tagsResponse,
    };
  })
  .get('/todos/:id', async (ctx) => {
    const id = ctx.params.id;

    const todo = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM todos WHERE id = ?`, [id], (err, row) => {
        if (err) return reject(err);
        if (!row) {
          ctx.throw(404, { error: 'Todo not found' });
          return reject(new Error('Todo not found'));
        }
        row.completed = row.completed === 1; // Convert completed to boolean
        row.id = String(row.id); // Ensure id is a string
        row.order = row.order !== null ? row.order : null;
        resolve(row);
      });
    });

    const tags = await new Promise((resolve, reject) => {
      db.all(
        `SELECT tags.id, tags.name FROM tags
         INNER JOIN todo_tags ON tags.id = todo_tags.tag_id
         WHERE todo_tags.todo_id = ?`,
        [id],
        (err, rows) => {
          if (err) return reject(err);
          const tagsWithTitles = rows.map((tag) => ({
            id: String(tag.id),
            title: tag.name,
            url: `${ctx.origin}/tags/${tag.id}`,
          }));
          resolve(tagsWithTitles);
        }
      );
    });

    todo.tags = tags;
    todo.url = `${ctx.origin}/todos/${todo.id}`;

    ctx.body = todo;
  })
  .patch('/todos/:id', async (ctx) => {
    const id = ctx.params.id;
    const { title, completed, order } = ctx.request.body;

    // Validate 'order' if provided
    if (order !== undefined && typeof order !== 'number') {
      ctx.throw(400, { error: '"order" must be a number' });
    }

    const completedValue =
      completed !== undefined ? (completed ? 1 : 0) : undefined; // Convert boolean to SQLite value if present

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE todos SET 
          title = COALESCE(?, title), 
          completed = COALESCE(?, completed), 
          "order" = COALESCE(?, "order") 
        WHERE id = ?`,
        [title, completedValue, order, id],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) {
            ctx.throw(404, { error: 'Todo not found' });
            return reject(new Error('Todo not found'));
          }
          resolve();
        }
      );
    });

    // Retrieve the updated todo
    const todo = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM todos WHERE id = ?`, [id], (err, row) => {
        if (err) return reject(err);
        row.completed = row.completed === 1;
        row.id = String(row.id);
        row.order = row.order !== null ? row.order : null;
        resolve(row);
      });
    });

    todo.url = `${ctx.origin}/todos/${todo.id}`;

    ctx.status = 200;
    ctx.body = {
      id: todo.id,
      title: todo.title,
      completed: todo.completed,
      order: todo.order,
      url: todo.url,
      // Include tags if necessary
    };
  })
  .delete('/todos/:id', async (ctx) => {
    const id = ctx.params.id;

    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM todos WHERE id = ?`, [id], function (err) {
        if (err) return reject(err);
        if (this.changes === 0) {
          ctx.throw(404, { error: 'Todo not found' });
          return reject(new Error('Todo not found'));
        }
        resolve();
      });
    });

    ctx.status = 204;
  })
  .del('/todos/', async (ctx) => {
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM todos`, (err) => {
        if (err) {
          ctx.throw(500, { error: 'Failed to clear todos' });
          reject(err);
        } else {
          resolve();
        }
      });
    });
    ctx.status = 204;
  });

// Routes for Tags
router
  .get('/tags/', async (ctx) => {
    const tags = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM tags`, (err, rows) => {
        if (err) return reject(err);
        const tagsWithIdsAsStrings = rows.map((row) => ({
          id: String(row.id), // Ensure id is a string
          title: row.name,
          url: `${ctx.origin}/tags/${row.id}`,
        }));
        resolve(tagsWithIdsAsStrings);
      });
    });

    ctx.body = tags;
  })
  .get('/tags/:id', async (ctx) => {
    const id = ctx.params.id;

    const tag = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tags WHERE id = ?`, [id], (err, row) => {
        if (err) return reject(err);
        if (!row) {
          ctx.throw(404, { error: 'Tag not found' });
          return reject(new Error('Tag not found'));
        }
        row.id = String(row.id);
        row.title = row.name;
        row.url = `${ctx.origin}/tags/${row.id}`;
        delete row.name;
        resolve(row);
      });
    });

    ctx.body = tag;
  })
  .post('/tags/', async (ctx) => {
    const { title } = ctx.request.body;

    // Validate title
    if (!title || typeof title !== 'string' || !title.length) {
      ctx.throw(400, { error: '"title" must be a non-empty string' });
    }

    const tagId = await new Promise((resolve, reject) => {
      db.run(`INSERT INTO tags (name) VALUES (?)`, [title], function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      });
    });

    ctx.status = 201;
    ctx.body = {
      id: String(tagId),
      title,
      url: `${ctx.origin}/tags/${tagId}`,
    };
  })
  .patch('/tags/:id', async (ctx) => {
    const id = ctx.params.id;
    const { title } = ctx.request.body;

    // Validate title
    if (!title || typeof title !== 'string' || !title.length) {
      ctx.throw(400, { error: '"title" must be a non-empty string' });
    }

    await new Promise((resolve, reject) => {
      db.run(`UPDATE tags SET name = ? WHERE id = ?`, [title, id], function (err) {
        if (err) return reject(err);
        if (this.changes === 0) {
          ctx.throw(404, { error: 'Tag not found' });
          return reject(new Error('Tag not found'));
        }
        resolve();
      });
    });

    ctx.status = 200;
    ctx.body = {
      id: String(id),
      title,
      url: `${ctx.origin}/tags/${id}`,
    };
  })
  .delete('/tags/:id', async (ctx) => {
    const id = ctx.params.id;

    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM tags WHERE id = ?`, [id], function (err) {
        if (err) return reject(err);
        if (this.changes === 0) {
          ctx.throw(404, { error: 'Tag not found' });
          return reject(new Error('Tag not found'));
        }
        resolve();
      });
    });

    ctx.status = 204;
  })
  .del('/tags/', async (ctx) => {
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM tags`, (err) => {
        if (err) {
          ctx.throw(500, { error: 'Failed to clear tags' });
          reject(err);
        } else {
          resolve();
        }
      });
    });
    ctx.status = 204;
  });

// Use middleware
app
  .use(bodyParser())
  .use(cors())
  .use(router.routes())
  .use(router.allowedMethods());

app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
