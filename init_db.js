const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Use absolute path for the database file
const dbPath = path.join(__dirname, 'mydb.sqlite');

// Open the database (or create it if it doesn't exist)
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// Database setup and population
db.serialize(() => {
  // Create tables
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

  // Check if the 'todos' table is empty
  db.get(`SELECT COUNT(*) AS count FROM todos`, (err, row) => {
    if (err) {
      console.error('Error checking todos table:', err.message);
      db.close();
      process.exit(1);
    }

    if (row.count === 0) {
      // Table is empty, insert default todos
      const defaultTodos = [
        { title: 'Buy groceries', completed: false, order: 1, tags: ['miscellaneous'] },
        { title: 'Call Alice', completed: false, order: 2, tags: ['social'] },
        { title: 'Finish report', completed: false, order: 3, tags: ['work'] },
        { title: 'Plan weekend trip', completed: false, order: 4, tags: ['social'] },
        { title: 'Read a book', completed: false, order: 5, tags: ['miscellaneous'] },
      ];

      // Insert tags into the 'tags' table
      const tags = ['work', 'social', 'miscellaneous'];
      const tagIds = {};

      const insertTag = db.prepare(`INSERT INTO tags (name) VALUES (?)`);

      tags.forEach((tag) => {
        insertTag.run([tag], function (err) {
          if (err) {
            console.error(`Error inserting tag '${tag}':`, err.message);
          } else {
            tagIds[tag] = this.lastID;
          }
        });
      });

      insertTag.finalize(() => {
        // Insert todos into the 'todos' table
        const insertTodo = db.prepare(`INSERT INTO todos (title, completed, "order") VALUES (?, ?, ?)`);
        const insertTodoTag = db.prepare(`INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)`);

        defaultTodos.forEach((todo) => {
          insertTodo.run([todo.title, todo.completed ? 1 : 0, todo.order], function (err) {
            if (err) {
              console.error(`Error inserting todo '${todo.title}':`, err.message);
            } else {
              const todoId = this.lastID;
              // Link tags to todos
              todo.tags.forEach((tag) => {
                const tagId = tagIds[tag];
                if (tagId) {
                  insertTodoTag.run([todoId, tagId], (err) => {
                    if (err) {
                      console.error(`Error linking todo '${todo.title}' with tag '${tag}':`, err.message);
                    }
                  });
                }
              });
            }
          });
        });

        insertTodo.finalize(() => {
          insertTodoTag.finalize(() => {
            console.log('Database initialized with default data.');
            db.close();
          });
        });
      });
    } else {
      console.log('Database already contains data. No action taken.');
      db.close();
    }
  });
});
