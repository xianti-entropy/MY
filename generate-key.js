const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'db.json');

// 允许的字符集：大写字母和数字，排除了容易混淆的字符如 O, 0, I, 1
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_LENGTH = 5;

// 加载数据库
const loadData = () => {
    if (!fs.existsSync(DB_FILE)) {
        return { users: [], invoices: [], products: [], categories: [], customers: [], keys: [] };
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
        users: data.users || [],
        invoices: data.invoices || [],
        products: data.products || [],
        categories: data.categories || [],
        customers: data.customers || [],
        keys: data.keys || [] // 确保包含 keys 数组
    };
};

// 保存数据库
const saveData = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

// 生成单个随机密钥
const generateSingleKey = () => {
    let key = '';
    const bytes = crypto.randomBytes(KEY_LENGTH);
    for (let i = 0; i < KEY_LENGTH; i++) {
        const randomIndex = bytes[i] % CHARSET.length;
        key += CHARSET[randomIndex];
    }
    return key;
};

// 主函数
const main = () => {
    // 获取需要生成的密钥数量，默认为 1
    const countArg = process.argv[2];
    const count = countArg ? parseInt(countArg, 10) : 1;

    if (isNaN(count) || count <= 0) {
        console.error('❌ 请提供一个有效的正整数作为生成的密钥数量。');
        process.exit(1);
    }

    const db = loadData();
    const existingKeys = new Set(db.keys.map(k => k.key));

    console.log(`\n🔑 准备生成 ${count} 个独一无二的注册密钥...\n`);

    let generatedCount = 0;
    const newKeys = [];

    // 生成指定数量的不重复密钥
    while (generatedCount < count) {
        const newKey = generateSingleKey();

        // 确保密钥不重复
        if (!existingKeys.has(newKey)) {
            existingKeys.add(newKey);

            const keyRecord = {
                key: newKey,
                isUsed: false,         // 初始状态为未使用
                usedBy: null,          // 绑定到的用户名/ID
                usedAt: null,          // 使用时间
                createdAt: Date.now()  // 创建时间
            };

            db.keys.push(keyRecord);
            newKeys.push(newKey);
            generatedCount++;
        }
    }

    // 保存到文件
    saveData(db);

    // 打印结果
    console.log('✅ 密钥生成成功！');
    console.log('----------------------------------------');
    newKeys.forEach((key, index) => {
        console.log(`[${(index + 1).toString().padStart(3, '0')}] ${key}`);
    });
    console.log('----------------------------------------');
    console.log(`💾 已成功将 ${count} 个新密钥保存至 ${DB_FILE}`);
};

main();
