require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Настройка Google Sheets API
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Хранилище состояний пользователей (в продакшене лучше использовать Redis)
const userStates = new Map();
const processedMessages = new Set();

// Названия листов
const SHEETS_CONFIG = {
  MAIN: 'ДДС: месяц',
  USERS: 'Пользователи',
  DIRECTIONS: 'Справочники',
  WALLETS: 'ДДС: настройки (для ввода сальдо)',
  ARTICLES: 'ДДС: статьи'
};

// Колонки для записи
const COLUMNS = {
  DATE: 'C',
  AMOUNT: 'D',
  WALLET: 'E',
  DIRECTION: 'F',
  COUNTERPARTY: 'G',
  PURPOSE: 'H',
  ARTICLE: 'I',
  USER_NAME: 'L',
  USER_ID: 'M'
};

// ============================================
// ФУНКЦИИ РАБОТЫ С GOOGLE SHEETS
// ============================================

// Получить данные из листа
async function getSheetData(sheetName, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${range}`,
    });
    return response.data.values || [];
  } catch (error) {
    console.error('Error reading sheet:', error);
    return [];
  }
}

// Получить пользователей
async function getUsers() {
  const data = await getSheetData(SHEETS_CONFIG.USERS, 'A2:D');
  return data.map(row => ({
    id: parseInt(row[0]),
    username: row[1] || '',
    fullName: row[2] || '',
    position: row[3] || '',
    isAdmin: (row[3] || '').toLowerCase().includes('админ')
  }));
}

// Проверить доступ пользователя
async function checkUserAccess(userId) {
  const users = await getUsers();
  return users.find(u => u.id === userId);
}

// Получить направления
async function getDirections() {
  const data = await getSheetData(SHEETS_CONFIG.DIRECTIONS, 'A2:A');
  return data.map(row => row[0]).filter(val => val);
}

// Получить кошельки
async function getWallets() {
  const data = await getSheetData(SHEETS_CONFIG.WALLETS, 'A3:A');
  return data.map(row => row[0]).filter(val => val);
}

// Получить статьи по типу
async function getArticles(type, excludeTransfers = false) {
  const data = await getSheetData(SHEETS_CONFIG.ARTICLES, 'A2:B');
  return data
    .filter(row => {
      if (!row[0]) return false;
      if (type && row[1] !== type) return false;
      if (excludeTransfers && row[0].includes('Перевод между счетами')) return false;
      return true;
    })
    .map(row => row[0]);
}

// Получить статью перевода
async function getTransferArticle(type) {
  const articles = await getArticles(type, false);
  return articles.find(a => a.includes('Перевод между счетами')) || 
         `${type} — Перевод между счетами`;
}

// Конвертировать букву колонки в номер
function columnToNumber(column) {
  let num = 0;
  for (let i = 0; i < column.length; i++) {
    num = num * 26 + (column.charCodeAt(i) - 64);
  }
  return num;
}

// Добавить запись в таблицу
async function addRecord(data, user) {
  try {
    // Получить последнюю заполненную строку
    const existingData = await getSheetData(SHEETS_CONFIG.MAIN, 'C:C');
    const targetRow = existingData.length + 1;

    // Подготовить данные для записи
    const values = [
      [
        data.date,
        data.amount,
        data.wallet,
        data.direction,
        data.counterparty || '',
        data.purpose || '',
        data.article,
        '', '', '', // Пустые колонки J, K, L (если есть)
        user.fullName || user.username || 'Неизвестный',
        user.id
      ]
    ];

    // Записать данные
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEETS_CONFIG.MAIN}!C${targetRow}:M${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    return targetRow;
  } catch (error) {
    console.error('Error adding record:', error);
    throw error;
  }
}

// ============================================
// КЛАВИАТУРЫ
// ============================================

function getMainKeyboard(isAdmin = false) {
  const buttons = isAdmin
    ? [
        [Markup.button.callback('📤 Расход', 'expense'), Markup.button.callback('📥 Поступление', 'income')],
        [Markup.button.callback('🔄 Перевод', 'transfer')]
      ]
    : [
        [Markup.button.callback('📤 Расход', 'expense'), Markup.button.callback('📥 Поступление', 'income')]
      ];
  
  return Markup.inlineKeyboard(buttons);
}

function getCancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel')]]);
}

function getListKeyboard(items, prefix = 'select') {
  const buttons = items.map((item, index) => [
    Markup.button.callback(item, `${prefix}_${index}`)
  ]);
  buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
}

// ============================================
// ОБРАБОТЧИКИ КОМАНД
// ============================================

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  
  // ============================================
  // ДИАГНОСТИКА - показываем все листы
  // ============================================
  try {
    console.log('\n🔍 === ДИАГНОСТИКА (вызвана через /start) ===');
    console.log('📊 SPREADSHEET_ID:', SPREADSHEET_ID);
    
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    
    console.log('✅ Доступ к таблице ЕСТЬ!');
    console.log('📋 Название таблицы:', spreadsheet.data.properties.title);
    console.log('\n📄 Все листы в таблице:');
    
    spreadsheet.data.sheets.forEach((sheet, index) => {
      const title = sheet.properties.title;
      console.log(`  ${index + 1}. "${title}"`);
    });
    
    console.log('\n🎯 Ожидаемые названия из конфига:');
    console.log('  USERS:', SHEETS_CONFIG.USERS);
    console.log('  MAIN:', SHEETS_CONFIG.MAIN);
    console.log('  DIRECTIONS:', SHEETS_CONFIG.DIRECTIONS);
    console.log('  WALLETS:', SHEETS_CONFIG.WALLETS);
    console.log('  ARTICLES:', SHEETS_CONFIG.ARTICLES);
    
    console.log('\n🔍 Проверка совпадений:');
    const userSheet = spreadsheet.data.sheets.find(s => s.properties.title === SHEETS_CONFIG.USERS);
    if (userSheet) {
      console.log('  ✅ Лист USERS найден!');
    } else {
      console.log('  ❌ Лист USERS НЕ найден!');
      console.log('  Ищем:', `"${SHEETS_CONFIG.USERS}"`);
    }
    
    console.log('=== КОНЕЦ ДИАГНОСТИКИ ===\n');
    
  } catch (diagError) {
    console.error('❌ Ошибка диагностики:', diagError.message);
    if (diagError.code === 404) {
      console.error('   Таблица не найдена или нет доступа к Service Account');
    }
  }
  // ============================================
  
  const user = await checkUserAccess(userId);
  
  if (!user) {
    return ctx.reply(
      `🚫 У вас нет доступа к этому боту.\n\nВаш ID: ${userId}\n\nОбратитесь к администратору для получения доступа.`
    );
  }
  
  userStates.delete(userId);
  
  const greeting = `👋 Здравствуйте, ${user.fullName || user.username}!\n\nЭтот бот поможет вам вносить данные о финансовых операциях.\n\nВыберите тип операции:`;
  
  await ctx.reply(greeting, getMainKeyboard(user.isAdmin));
});
```

4. **Commit changes**

---

## 🚀 После commit:

1. Дождитесь деплоя (1-2 минуты)
2. Напишите боту `/start`
3. **Сразу откройте Logs** и покажите мне всё между:
```
   🔍 === ДИАГНОСТИКА
```
   и
```
   === КОНЕЦ ДИАГНОСТИКИ ===
// ============================================
// ОБРАБОТЧИКИ КНОПОК
// ============================================

bot.action('expense', async (ctx) => {
  await ctx.answerCbQuery();
  await startOperation(ctx, 'expense');
});

bot.action('income', async (ctx) => {
  await ctx.answerCbQuery();
  await startOperation(ctx, 'income');
});

bot.action('transfer', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await checkUserAccess(ctx.from.id);
  if (!user.isAdmin) {
    return ctx.reply('❌ Эта функция доступна только администраторам.');
  }
  await startTransfer(ctx);
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  userStates.delete(userId);
  const user = await checkUserAccess(userId);
  await ctx.reply('❌ Операция отменена', getMainKeyboard(user?.isAdmin));
});

// Обработка выбора из списка
bot.action(/^select_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const index = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  if (!state || !state.currentList) {
    return ctx.reply('❌ Ошибка. Начните заново с /start');
  }
  
  const selectedItem = state.currentList[index];
  await handleTextInput(ctx, selectedItem);
});

// ============================================
// ЛОГИКА ОПЕРАЦИЙ
// ============================================

async function startOperation(ctx, type) {
  const userId = ctx.from.id;
  const operationName = type === 'expense' ? 'Расход' : 'Поступление';
  
  userStates.set(userId, {
    operation: type,
    state: 'waiting_date',
    data: {}
  });
  
  await ctx.reply(
    `📅 <b>${operationName} - Шаг 1 из 6: Дата</b>\n\nВведите дату в формате ДД.ММ.ГГГГ\nНапример: 30.08.2025`,
    { parse_mode: 'HTML', ...getCancelKeyboard() }
  );
}

async function startTransfer(ctx) {
  const userId = ctx.from.id;
  
  userStates.set(userId, {
    operation: 'transfer',
    state: 'transfer_waiting_date',
    data: {}
  });
  
  await ctx.reply(
    '📅 <b>Перевод - Шаг 1 из 5: Дата</b>\n\nВведите дату в формате ДД.ММ.ГГГГ\nНапример: 30.08.2025',
    { parse_mode: 'HTML', ...getCancelKeyboard() }
  );
}

// ============================================
// ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ
// ============================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const messageId = ctx.message.message_id;
  const text = ctx.message.text;
  
  // Защита от дублирования
  const msgKey = `${userId}_${messageId}`;
  if (processedMessages.has(msgKey)) return;
  processedMessages.add(msgKey);
  
  // Очистка старых сообщений (храним только последние 100)
  if (processedMessages.size > 100) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }
  
  // Проверка доступа
  const user = await checkUserAccess(userId);
  if (!user) {
    return ctx.reply(`🚫 У вас нет доступа. Ваш ID: ${userId}`);
  }
  
  const state = userStates.get(userId);
  if (!state) {
    return ctx.reply('Используйте /start для начала работы');
  }
  
  await handleTextInput(ctx, text);
});

async function handleTextInput(ctx, text) {
  const userId = ctx.from.id;
  const user = await checkUserAccess(userId);
  const state = userStates.get(userId);
  
  if (!state) return;
  
  const { operation, state: currentState, data } = state;
  
  try {
    if (operation === 'transfer') {
      await handleTransferState(ctx, text, currentState, data, user);
    } else {
      await handleRegularOperationState(ctx, text, currentState, data, user, operation);
    }
  } catch (error) {
    console.error('Error handling state:', error);
    await ctx.reply('❌ Произошла ошибка. Попробуйте снова.');
  }
}

// ============================================
// ОБРАБОТКА ОБЫЧНЫХ ОПЕРАЦИЙ
// ============================================

async function handleRegularOperationState(ctx, text, currentState, data, user, operation) {
  const userId = ctx.from.id;
  const operationName = operation === 'expense' ? 'Расход' : 'Поступление';
  
  switch (currentState) {
    case 'waiting_date':
      if (!/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
        return ctx.reply('❌ Неверный формат даты. Используйте ДД.ММ.ГГГГ\nНапример: 30.08.2025');
      }
      data.date = text;
      userStates.get(userId).state = 'waiting_amount';
      userStates.get(userId).data = data;
      await ctx.reply(
        `💰 <b>${operationName} - Шаг 2 из 6: Сумма</b>\n\nВведите сумму (только число):\nНапример: 50000`,
        { parse_mode: 'HTML', ...getCancelKeyboard() }
      );
      break;
      
    case 'waiting_amount':
      const amount = text.replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return ctx.reply('❌ Неверный формат суммы. Введите положительное число.');
      }
      data.amount = operation === 'expense' ? '-' + amount : amount;
      userStates.get(userId).state = 'waiting_wallet';
      userStates.get(userId).data = data;
      
      const wallets = await getWallets();
      if (wallets.length === 0) {
        return ctx.reply('❌ Список кошельков пуст.');
      }
      
      userStates.get(userId).currentList = wallets;
      await ctx.reply(
        `👛 <b>${operationName} - Шаг 3 из 6: Кошелек</b>\n\nВыберите кошелек:`,
        { parse_mode: 'HTML', ...getListKeyboard(wallets) }
      );
      break;
      
    case 'waiting_wallet':
      data.wallet = text;
      userStates.get(userId).state = 'waiting_direction';
      userStates.get(userId).data = data;
      
      const directions = await getDirections();
      if (directions.length === 0) {
        return ctx.reply('❌ Список направлений пуст.');
      }
      
      userStates.get(userId).currentList = directions;
      await ctx.reply(
        `🎯 <b>${operationName} - Шаг 4 из 6: Направление бизнеса</b>\n\nВыберите направление:`,
        { parse_mode: 'HTML', ...getListKeyboard(directions) }
      );
      break;
      
    case 'waiting_direction':
      data.direction = text;
      userStates.get(userId).state = 'waiting_counterparty';
      userStates.get(userId).data = data;
      await ctx.reply(
        `🤝 <b>${operationName} - Шаг 5 из 6: Контрагент</b>\n\nВведите название контрагента:`,
        { parse_mode: 'HTML', ...getCancelKeyboard() }
      );
      break;
      
    case 'waiting_counterparty':
      data.counterparty = text;
      userStates.get(userId).state = 'waiting_purpose';
      userStates.get(userId).data = data;
      await ctx.reply(
        `📝 <b>${operationName} - Шаг 6 из 6: Назначение платежа</b>\n\nВведите назначение платежа:`,
        { parse_mode: 'HTML', ...getCancelKeyboard() }
      );
      break;
      
    case 'waiting_purpose':
      data.purpose = text;
      userStates.get(userId).state = 'waiting_article';
      userStates.get(userId).data = data;
      
      const articleType = operation === 'expense' ? 'Выбытие' : 'Поступление';
      const articles = await getArticles(articleType, true);
      
      if (articles.length === 0) {
        return ctx.reply('❌ Список статей пуст.');
      }
      
      userStates.get(userId).currentList = articles;
      await ctx.reply(
        `📊 <b>${operationName} - Выбор статьи</b>\n\nВыберите статью:`,
        { parse_mode: 'HTML', ...getListKeyboard(articles) }
      );
      break;
      
    case 'waiting_article':
      data.article = text;
      
      const rowNumber = await addRecord(data, user);
      
      const summary = `✅ <b>Запись успешно добавлена!</b>\n\n📅 Дата: ${data.date}\n💰 Сумма: ${data.amount}\n👛 Кошелек: ${data.wallet}\n🎯 Направление: ${data.direction}\n🤝 Контрагент: ${data.counterparty}\n📝 Назначение: ${data.purpose}\n📊 Статья: ${data.article}\n\nСтрока: ${rowNumber}`;
      
      await ctx.reply(summary, { parse_mode: 'HTML', ...getMainKeyboard(user.isAdmin) });
      userStates.delete(userId);
      break;
  }
}

// ============================================
// ОБРАБОТКА ПЕРЕВОДОВ
// ============================================

async function handleTransferState(ctx, text, currentState, data, user) {
  const userId = ctx.from.id;
  
  switch (currentState) {
    case 'transfer_waiting_date':
      if (!/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
        return ctx.reply('❌ Неверный формат даты. Используйте ДД.ММ.ГГГГ');
      }
      data.date = text;
      userStates.get(userId).state = 'transfer_waiting_amount';
      userStates.get(userId).data = data;
      await ctx.reply(
        '💰 <b>Перевод - Шаг 2 из 5: Сумма</b>\n\nВведите сумму перевода:\nНапример: 50000',
        { parse_mode: 'HTML', ...getCancelKeyboard() }
      );
      break;
      
    case 'transfer_waiting_amount':
      const amount = text.replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return ctx.reply('❌ Неверный формат суммы.');
      }
      data.amount = amount;
      userStates.get(userId).state = 'transfer_waiting_direction';
      userStates.get(userId).data = data;
      
      const directions = await getDirections();
      userStates.get(userId).currentList = directions;
      await ctx.reply(
        '🎯 <b>Перевод - Шаг 3 из 5: Направление бизнеса</b>\n\nВыберите направление:',
        { parse_mode: 'HTML', ...getListKeyboard(directions) }
      );
      break;
      
    case 'transfer_waiting_direction':
      data.direction = text;
      userStates.get(userId).state = 'transfer_waiting_wallet_from';
      userStates.get(userId).data = data;
      
      const walletsFrom = await getWallets();
      userStates.get(userId).currentList = walletsFrom;
      await ctx.reply(
        '📤 <b>Перевод - Шаг 4 из 5: Кошелек выбытия</b>\n\nВыберите кошелек, С которого переводятся средства:',
        { parse_mode: 'HTML', ...getListKeyboard(walletsFrom) }
      );
      break;
      
    case 'transfer_waiting_wallet_from':
      data.walletFrom = text;
      userStates.get(userId).state = 'transfer_waiting_wallet_to';
      userStates.get(userId).data = data;
      
      const walletsTo = await getWallets();
      userStates.get(userId).currentList = walletsTo;
      await ctx.reply(
        '📥 <b>Перевод - Шаг 5 из 5: Кошелек поступления</b>\n\nВыберите кошелек, НА который переводятся средства:',
        { parse_mode: 'HTML', ...getListKeyboard(walletsTo) }
      );
      break;
      
    case 'transfer_waiting_wallet_to':
      data.walletTo = text;
      
      if (data.walletFrom === data.walletTo) {
        return ctx.reply('❌ Кошельки не могут быть одинаковыми.');
      }
      
      // Создать две записи
      const recordIn = {
        date: data.date,
        amount: data.amount,
        wallet: data.walletTo,
        direction: data.direction,
        counterparty: data.walletFrom,
        purpose: 'Перевод между счетами',
        article: await getTransferArticle('Поступление')
      };
      const rowIn = await addRecord(recordIn, user);
      
      const recordOut = {
        date: data.date,
        amount: '-' + data.amount,
        wallet: data.walletFrom,
        direction: data.direction,
        counterparty: data.walletTo,
        purpose: 'Перевод между счетами',
        article: await getTransferArticle('Выбытие')
      };
      const rowOut = await addRecord(recordOut, user);
      
      const summary = `✅ <b>Перевод успешно выполнен!</b>\n\n📅 Дата: ${data.date}\n💰 Сумма: ${data.amount}\n🎯 Направление: ${data.direction}\n\n📤 Из кошелька: ${data.walletFrom} (строка ${rowOut})\n📥 В кошелек: ${data.walletTo} (строка ${rowIn})`;
      
      await ctx.reply(summary, { parse_mode: 'HTML', ...getMainKeyboard(user.isAdmin) });
      userStates.delete(userId);
      break;
  }
}

// ============================================
// ЗАПУСК БОТА
// ============================================

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch().then(() => {
  console.log('✅ Бот запущен!');
}).catch((error) => {
  console.error('❌ Ошибка запуска:', error);
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}`, err);
});

// ============================================
// ДИАГНОСТИКА ПРИ ЗАПУСКЕ
// ============================================

async function diagnoseSheets() {
  try {
    console.log('🔍 === ДИАГНОСТИКА GOOGLE SHEETS ===');
    console.log('📊 SPREADSHEET_ID:', SPREADSHEET_ID);
    
    // Получить информацию о таблице
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    
    console.log('✅ Доступ к таблице ЕСТЬ!');
    console.log('📋 Название таблицы:', spreadsheet.data.properties.title);
    console.log('\n📄 Список всех листов в таблице:');
    
    spreadsheet.data.sheets.forEach((sheet, index) => {
      const title = sheet.properties.title;
      console.log(`  ${index + 1}. "${title}"`);
      
      // Проверяем совпадения с конфигом
      if (title === SHEETS_CONFIG.USERS) {
        console.log('     ✅ Совпадает с USERS');
      }
      if (title === SHEETS_CONFIG.MAIN) {
        console.log('     ✅ Совпадает с MAIN');
      }
      if (title === SHEETS_CONFIG.DIRECTIONS) {
        console.log('     ✅ Совпадает с DIRECTIONS');
      }
      if (title === SHEETS_CONFIG.WALLETS) {
        console.log('     ✅ Совпадает с WALLETS');
      }
      if (title === SHEETS_CONFIG.ARTICLES) {
        console.log('     ✅ Совпадает с ARTICLES');
      }
    });
    
    console.log('\n🎯 Ожидаемые названия листов из конфига:');
    console.log('  USERS:', SHEETS_CONFIG.USERS);
    console.log('  MAIN:', SHEETS_CONFIG.MAIN);
    console.log('  DIRECTIONS:', SHEETS_CONFIG.DIRECTIONS);
    console.log('  WALLETS:', SHEETS_CONFIG.WALLETS);
    console.log('  ARTICLES:', SHEETS_CONFIG.ARTICLES);
    
    console.log('\n=== КОНЕЦ ДИАГНОСТИКИ ===\n');
    
  } catch (error) {
    console.error('❌ ОШИБКА ДИАГНОСТИКИ:', error.message);
    if (error.code === 404) {
      console.error('   Таблица не найдена или Service Account не имеет доступа');
    }
  }
}
