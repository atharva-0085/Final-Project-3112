const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const port = 3000;

// Middleware
app.use(express.static(path.join(__dirname, 'static')));
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));
app.use(session({
    secret: 'expense_secret_key',
    resave: false,
    saveUninitialized: true
}));

// DB Setup
const db = new sqlite3.Database('./instance/expense.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT, amount REAL, payer_id INTEGER, timestamp TEXT DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS participants (id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER, user_id INTEGER)");
});

// Middleware to protect pages
function authRequired(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
}

// Routes
app.get('/register', (req, res) => res.render('register'));

app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    db.run("INSERT INTO accounts (name, email, password) VALUES (?, ?, ?)", [name, email, hashed], err => {
        if (err) return res.send("Email already registered.");
        req.session.user = { name, email };
        res.redirect('/');
    });
});

app.get('/login', (req, res) => res.render('login'));

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM accounts WHERE email = ?", [email], async (err, row) => {
        if (!row || !(await bcrypt.compare(password, row.password))) {
            return res.send("Invalid credentials.");
        }
        req.session.user = { id: row.id, name: row.name, email: row.email };
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/', authRequired, (req, res) => {
    db.all("SELECT * FROM expenses", [], (err, expenses) => {
        db.all("SELECT * FROM users", [], (err2, users) => {
            const chart = { labels: [], values: [] };
            users.forEach(u => {
                chart.labels.push(u.name);
                const total = expenses
                    .filter(e => e.payer_id === u.id)
                    .reduce((sum, e) => sum + e.amount, 0);
                chart.values.push(total);
            });
            res.render("dashboard", {
                user: req.session.user,
                chart,
                users
            });
        });
    });
});

app.get('/add_user', authRequired, (req, res) => {
    res.render("add_user");
});

app.post('/add_user', authRequired, (req, res) => {
    db.run("INSERT INTO users (name) VALUES (?)", [req.body.name], () => {
        res.redirect('/');
    });
});

app.post('/delete_user/:id', authRequired, (req, res) => {
    const userId = req.params.id;
    db.run("DELETE FROM participants WHERE user_id = ?", [userId], () => {
        db.run("DELETE FROM expenses WHERE payer_id = ?", [userId], () => {
            db.run("DELETE FROM users WHERE id = ?", [userId], () => {
                res.redirect('/');
            });
        });
    });
});

app.get('/log_expense', authRequired, (req, res) => {
    db.all("SELECT * FROM users", [], (err, rows) => {
        res.render("log_expense", { users: rows });
    });
});

app.post('/log_expense', authRequired, (req, res) => {
    const { description, amount, payer, participants } = req.body;
    db.run("INSERT INTO expenses (description, amount, payer_id) VALUES (?, ?, ?)",
        [description, amount, payer],
        function(err) {
            const id = this.lastID;
            const arr = Array.isArray(participants) ? participants : [participants];
            arr.forEach(uid => db.run("INSERT INTO participants (expense_id, user_id) VALUES (?, ?)", [id, uid]));
            res.redirect('/');
        });
});

app.get('/report', authRequired, (req, res) => {
    db.all("SELECT e.*, u.name as payer_name FROM expenses e JOIN users u ON e.payer_id = u.id", [], (err, expenses) => {
        db.all("SELECT p.expense_id, u.name FROM participants p JOIN users u ON p.user_id = u.id", [], (err, parts) => {
            const map = {};
            parts.forEach(p => {
                if (!map[p.expense_id]) map[p.expense_id] = [];
                map[p.expense_id].push({ name: p.name });
            });
            expenses.forEach(e => {
                e.payer = { name: e.payer_name };
                e.participants = map[e.id] || [];
                e.timestamp = e.timestamp.split("T")[0];
            });
            res.render("report", { expenses });
        });
    });
});

app.get('/edit_expense/:id', authRequired, (req, res) => {
    const expenseId = req.params.id;

    db.get("SELECT * FROM expenses WHERE id = ?", [expenseId], (err, expense) => {
        if (!expense) return res.send("Expense not found.");
        db.all("SELECT * FROM users", [], (err, users) => {
            db.all("SELECT user_id FROM participants WHERE expense_id = ?", [expenseId], (err, rows) => {
                const participantIds = rows.map(r => r.user_id);
                expense.participants = participantIds; // ✅ ensure array is passed
                res.render("edit_expense", { expense, users });
            });
        });
    });
});



app.post('/delete_expense/:id', authRequired, (req, res) => {
    const expenseId = req.params.id;
    db.run("DELETE FROM participants WHERE expense_id = ?", [expenseId], () => {
        db.run("DELETE FROM expenses WHERE id = ?", [expenseId], () => {
            res.redirect('/report');
        });
    });
});

app.get('/edit_expense/:id', authRequired, (req, res) => {
    const expenseId = req.params.id;
    db.get("SELECT * FROM expenses WHERE id = ?", [expenseId], (err, expense) => {
        db.all("SELECT * FROM users", [], (err, users) => {
            res.render("edit_expense", { expense, users });
        });
    });
});

app.post('/edit_expense/:id', authRequired, (req, res) => {
    const { description, amount, payer } = req.body;
    const expenseId = req.params.id;
    db.run("UPDATE expenses SET description = ?, amount = ?, payer_id = ? WHERE id = ?",
        [description, amount, payer, expenseId],
        () => {
            res.redirect('/report');
        });
});

app.get('/balances', authRequired, (req, res) => {
    db.all("SELECT * FROM users", [], (err, users) => {
        const uMap = {}, balances = {};
        users.forEach(u => { uMap[u.id] = u.name; balances[u.name] = 0; });
        db.all("SELECT * FROM expenses", [], (err, expenses) => {
            if (!expenses.length) return res.render("balances", { balances });
            const ids = expenses.map(e => e.id);
            const q = `SELECT * FROM participants WHERE expense_id IN (${ids.map(() => '?').join(',')})`;
            db.all(q, ids, (err, parts) => {
                expenses.forEach(e => {
                    const payer = uMap[e.payer_id];
                    const shares = parts.filter(p => p.expense_id === e.id).map(p => uMap[p.user_id]);
                    const each = e.amount / shares.length;
                    shares.forEach(s => {
                        if (s !== payer) {
                            balances[s] -= each;
                            balances[payer] += each;
                        }
                    });
                });
                res.render("balances", { balances });
            });
        });
    });
});

app.listen(port, () => {
    console.log(`App running at http://localhost:${port}`);
});

// Edit expense form
app.get('/edit_expense/:id', authRequired, (req, res) => {
    const expenseId = req.params.id;
    db.get("SELECT * FROM expenses WHERE id = ?", [expenseId], (err, expense) => {
        if (!expense) return res.send("Expense not found.");
        db.all("SELECT * FROM users", [], (err2, users) => {
            db.all("SELECT user_id FROM participants WHERE expense_id = ?", [expenseId], (err3, parts) => {
                const selected = parts.map(p => p.user_id);
                res.render("edit_expense", { expense, users, selected });
            });
        });
    });
});

// Save edited expense
app.post('/edit_expense/:id', authRequired, (req, res) => {
    const id = req.params.id;
    const { description, amount, payer, participants } = req.body;
    db.run("UPDATE expenses SET description = ?, amount = ?, payer_id = ? WHERE id = ?", [description, amount, payer, id], () => {
        db.run("DELETE FROM participants WHERE expense_id = ?", [id], () => {
            const arr = Array.isArray(participants) ? participants : [participants];
            arr.forEach(uid => {
                db.run("INSERT INTO participants (expense_id, user_id) VALUES (?, ?)", [id, uid]);
            });
            res.redirect('/report');
        });
    });
});

app.post('/edit_expense/:id', authRequired, (req, res) => {
    const id = req.params.id;
    const { description, amount, payer, participants } = req.body;

    db.run("UPDATE expenses SET description = ?, amount = ?, payer_id = ? WHERE id = ?",
        [description, amount, payer, id], () => {
            db.run("DELETE FROM participants WHERE expense_id = ?", [id], () => {
                const arr = Array.isArray(participants) ? participants : [participants];
                arr.forEach(uid => {
                    db.run("INSERT INTO participants (expense_id, user_id) VALUES (?, ?)", [id, uid]);
                });
                res.redirect('/report');
            });
        });
});

app.post('/delete_expense/:id', authRequired, (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM participants WHERE expense_id = ?", [id], () => {
        db.run("DELETE FROM expenses WHERE id = ?", [id], () => {
            res.redirect('/report');
        });
    });
});

