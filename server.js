const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json());

const DB_FILE = path.join(__dirname, 'db.json');

const loadData = () => {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initialData = { users: [], invoices: [], products: [], categories: [], customers: [], keys: [] };
            fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const fileContent = fs.readFileSync(DB_FILE, 'utf8');
        // 如果文件是空的，返回初始结构
        if (!fileContent.trim()) {
            return { users: [], invoices: [], products: [], categories: [], customers: [], keys: [] };
        }
        const data = JSON.parse(fileContent);
        
        // 关键修正：确保所有字段都存在，不要轻易返回空
        return {
            users: Array.isArray(data.users) ? data.users : [],
            invoices: Array.isArray(data.invoices) ? data.invoices : [],
            products: Array.isArray(data.products) ? data.products : [],
            categories: Array.isArray(data.categories) ? data.categories : [],
            customers: Array.isArray(data.customers) ? data.customers : [],
            keys: Array.isArray(data.keys) ? data.keys : []
        };
    } catch (e) {
        console.error("数据库读取出错，已备份旧文件并初始化新结构:", e);
        // 出错时备份，防止彻底丢失
        fs.renameSync(DB_FILE, `${DB_FILE}.error.${Date.now()}`);
        return { users: [], invoices: [], products: [], categories: [], customers: [], keys: [] };
    }
};

const saveData = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

const getUserTokens = (user) => {
    if (Array.isArray(user.tokens)) return user.tokens;
    if (user.token) return [user.token];
    return [];
};

const setUserTokens = (user, tokens) => {
    user.tokens = tokens;
    if (tokens.length > 0) {
        user.token = tokens[tokens.length - 1];
    } else {
        delete user.token;
    }
};

const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token required' });
    }

    const db = loadData();
    const user = db.users.find(u => getUserTokens(u).includes(token));

    if (!user) {
        return res.status(403).json({ error: 'Invalid token' });
    }

    req.userId = user.id;
    next();
};

// Auth APIs
app.post('/api/auth/register', (req, res) => {
    const { username, password, key } = req.body;

    if (!username || !password || !key) {
        return res.status(400).json({ error: 'Username, password and key required' });
    }

    const db = loadData();

    // Key validation
    const keyRecord = db.keys.find(k => k.key === key);
    if (!keyRecord) {
        return res.status(400).json({ error: '无效的注册密钥' });
    }
    if (keyRecord.isUsed) {
        return res.status(400).json({ error: '该注册密钥已被使用' });
    }

    if (db.users.find(u => u.username === username)) {
        return res.status(409).json({ error: 'User already exists' });
    }

    const userId = Date.now().toString();
    const token = crypto.randomBytes(32).toString('hex');

    db.users.push({
        id: userId,
        username: username,
        password: hashPassword(password),
        tokens: [token],
        token: token,
        createdAt: Date.now()
    });

    // Mark key as used
    keyRecord.isUsed = true;
    keyRecord.usedBy = username;
    keyRecord.usedAt = Date.now();

    saveData(db);

    res.json({
        success: true,
        token: token,
        user: { id: userId, username: username }
    });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    const db = loadData();
    const user = db.users.find(u => u.username === username);

    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokens = getUserTokens(user);
    if (!tokens.includes(token)) tokens.push(token);
    setUserTokens(user, tokens);
    saveData(db);

    res.json({
        success: true,
        token: token,
        user: { id: user.id, username: user.username }
    });
});

app.post('/api/auth/verify', (req, res) => {
    const token = req.body.token;

    if (!token) {
        return res.status(400).json({ error: 'Token required' });
    }

    const db = loadData();
    const user = db.users.find(u => getUserTokens(u).includes(token));

    if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    res.json({
        valid: true,
        user: { id: user.id, username: user.username }
    });
});

// Invoices APIs with incremental sync support
app.get('/api/invoices', authenticateToken, (req, res) => {
    const db = loadData();
    const since = req.query.since ? parseInt(req.query.since) : 0;
    let userInvoices = db.invoices.filter(inv => inv.userId === req.userId);

    if (since > 0) {
        userInvoices = userInvoices.filter(inv => (inv.lastModified || inv.updatedAt || 0) >= since);
    }

    res.json(userInvoices);
});

app.post('/api/invoices', authenticateToken, (req, res) => {
    const db = loadData();
    const invoices = Array.isArray(req.body) ? req.body : [req.body];
    const now = Date.now();

    // Support deletions without wiping other device data
    const deleteIds = new Set(invoices.filter(inv => inv && inv.deleted).map(inv => inv.id));
    if (deleteIds.size > 0) {
        db.invoices = db.invoices.filter(inv => !(inv.userId === req.userId && deleteIds.has(inv.id)));
    }

    // Upsert non-deleted invoices with fresh metadata
    const payload = invoices.filter(inv => inv && !inv.deleted);
    payload.forEach(inv => {
        inv.userId = req.userId;
        inv.lastModified = now;
    });

    if (payload.length > 0) {
        const userInvoiceIds = new Set(payload.map(i => i.id));
        db.invoices = db.invoices.filter(inv => inv.userId !== req.userId || !userInvoiceIds.has(inv.id));
        db.invoices = db.invoices.concat(payload);
    }

    saveData(db);
    res.json({ success: true, deleted: Array.from(deleteIds) });
});

// Products APIs with incremental sync support
app.get('/api/products', authenticateToken, (req, res) => {
    const db = loadData();
    const since = req.query.since ? parseInt(req.query.since) : 0;
    let userProducts = db.products.filter(prod => prod.userId === req.userId);

    if (since > 0) {
        userProducts = userProducts.filter(prod => (prod.lastModified || prod.updatedAt || 0) >= since);
    }

    res.json(userProducts);
});

app.post('/api/products', authenticateToken, (req, res) => {
    const db = loadData();
    const products = Array.isArray(req.body) ? req.body : [req.body];
    const now = Date.now();

    const deleteIds = new Set(products.filter(prod => prod && prod.deleted).map(prod => prod.id));
    if (deleteIds.size > 0) {
        db.products = db.products.filter(prod => !(prod.userId === req.userId && deleteIds.has(prod.id)));
    }

    const payload = products.filter(prod => prod && !prod.deleted);
    payload.forEach(prod => {
        prod.userId = req.userId;
        prod.lastModified = now;
    });

    if (payload.length > 0) {
        const userProductIds = new Set(payload.map(p => p.id));
        db.products = db.products.filter(prod => prod.userId !== req.userId || !userProductIds.has(prod.id));
        db.products = db.products.concat(payload);
    }

    saveData(db);
    res.json({ success: true, deleted: Array.from(deleteIds) });
});

// Product Categories APIs with incremental sync support
app.get('/api/categories', authenticateToken, (req, res) => {
    const db = loadData();
    const since = req.query.since ? parseInt(req.query.since) : 0;
    let userCategories = db.categories.filter(category => category.userId === req.userId);

    if (since > 0) {
        userCategories = userCategories.filter(category => (category.lastModified || category.updatedAt || 0) >= since);
    }

    res.json(userCategories);
});

app.post('/api/categories', authenticateToken, (req, res) => {
    const db = loadData();
    const categories = Array.isArray(req.body) ? req.body : [req.body];
    const now = Date.now();

    const deleteIds = new Set(categories.filter(category => category && category.deleted).map(category => category.id));
    if (deleteIds.size > 0) {
        db.categories = db.categories.filter(category => !(category.userId === req.userId && deleteIds.has(category.id)));
    }

    const payload = categories.filter(category => category && !category.deleted);
    payload.forEach(category => {
        category.userId = req.userId;
        category.lastModified = now;
    });

    if (payload.length > 0) {
        const userCategoryIds = new Set(payload.map(category => category.id));
        db.categories = db.categories.filter(category => category.userId !== req.userId || !userCategoryIds.has(category.id));
        db.categories = db.categories.concat(payload);
    }

    saveData(db);
    res.json({ success: true, deleted: Array.from(deleteIds) });
});

// Customers APIs with incremental sync support
app.get('/api/customers', authenticateToken, (req, res) => {
    const db = loadData();
    const since = req.query.since ? parseInt(req.query.since) : 0;
    let userCustomers = db.customers.filter(cust => cust.userId === req.userId);

    if (since > 0) {
        userCustomers = userCustomers.filter(cust => (cust.lastModified || cust.updatedAt || 0) >= since);
    }

    res.json(userCustomers);
});

app.post('/api/customers', authenticateToken, (req, res) => {
    const db = loadData();
    const customers = Array.isArray(req.body) ? req.body : [req.body];
    const now = Date.now();

    const deleteIds = new Set(customers.filter(cust => cust && cust.deleted).map(cust => cust.id));
    if (deleteIds.size > 0) {
        db.customers = db.customers.filter(cust => !(cust.userId === req.userId && deleteIds.has(cust.id)));
    }

    const payload = customers.filter(cust => cust && !cust.deleted);
    payload.forEach(cust => {
        cust.userId = req.userId;
        cust.lastModified = now;
    });

    if (payload.length > 0) {
        const userCustomerIds = new Set(payload.map(c => c.id));
        db.customers = db.customers.filter(cust => cust.userId !== req.userId || !userCustomerIds.has(cust.id));
        db.customers = db.customers.concat(payload);
    }

    saveData(db);
    res.json({ success: true, deleted: Array.from(deleteIds) });
});

app.listen(3000, '0.0.0.0', () => {
    console.log('Backend server started on port 3000');
});
