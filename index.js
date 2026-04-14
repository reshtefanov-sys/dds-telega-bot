require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const https = require('https');
const { Readable } = require('stream');
const fs = require('fs');

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Настройка Google Sheets API
const credentials = process.env.GOOGLE_CREDENTIALS.startsWith('{') ? JSON.parse(process.env.GOOGLE_CREDENTIALS) : JSON.parse(fs.readFileSync(process.env.GOOGLE_CREDENTIALS, 'utf8'));
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ],
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// Хранилище состояний пользователей
const userStates = new Map();

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
  USER_ID: 'M',
  RECEIPT: 'N'
};

// ============================================
// ФУНКЦИИ РАБОТЫ С GOOGLE SHEETS
// ============================================

async function getSheetData(sheetName, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${range}`,
    });
    return response.data.values || [];
  } catch (error) {
    console.error('Error reading sheet:', error.message);
    return [];
  }
}

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

async function checkUserAccess(userId) {
  const users = await getUsers();
  return users.find(u => u.id === userId);
}

async function getDirections() {
  const data = await getSheetData(SHEETS_CONFIG.DIRECTIONS, 'A2:A');
  return data.map(row => row[0]).filter(val => val);
}

async function getWallets() {
  const data = await getSheetData(SHEETS_CONFIG.WALLETS, 'A3:A');
  return data.map(row => row[0]).filter(val => val);
}

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

async function getTransferArticle(type) {
  const articles = await getArticles(type, false);
  return articles.find(a => a.includes('Перевод между счетами')) || 
         `${type} — Перевод между счетами`;
}

// ============================================
// ФУНКЦИИ РАБОТЫ С GOOGLE DRIVE
// ============================================

async function uploadReceiptToDrive(fileBuffer, fileName, description) {
  try {
    const fileMetadata = {
      name: fileName,
      parents: [DRIVE_FOLDER_ID],
      description: description
    };

    const media = {
      mimeType: 'image/jpeg',
      body: Readable.from(fileBuffer)
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink'
    });

    // Делаем файл доступным по ссылке
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    return file.data.webViewLink;
  } catch (error) {
    console.error('Error uploading to Drive:', error);
    throw error;
  }
}

async function downloadTelegramFile(fileId) {
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    
    return new Promise((resolve, reject) => {
      https.get(fileLink.href, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      });
    });
  } catch (error) {
    console.error('Error downloading file from Telegram:', error);
    throw error;
  }
}

// ============================================
// ФУНКЦИИ ЗАПИСИ В ТАБЛИЦУ
// ============================================

async function addRecord(data, user, receiptLink = null) {
  try {
    const existingData = await getSheetData(SHEETS_CONFIG.MAIN, 'C:C');
    const targetRow = existingData.length + 1;

    // Записываем данные: C-I
    const valuesCI = [
      [
        data.date,
        data.amount,
        data.wallet,
        data.direction,
        data.counterparty || '',
        data.purpose || '',
        data.article
      ]
    ];
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEETS_CONFIG.MAIN}!C${targetRow}:I${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: valuesCI },
    });

    // Записываем L:M (ФИО и ID)
    const valuesLM = [
      [
        user.fullName || user.username || 'Неизвестный',
        user.id
      ]
    ];
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEETS_CONFIG.MAIN}!L${targetRow}:M${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: valuesLM },
    });

    // Записываем ссылку на чек в N, если есть
    if (receiptLink) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEETS_CONFIG.MAIN}!N${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[receiptLink]] },
      });
    }

    return targetRow;
  } catch (error) {
    console.error('Error adding record:', error);
    throw error;
  }
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function getTodayDate() {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const year = today.getFullYear();
  return `${day}.${month}.${year}`;
}

function getYesterdayDate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const day = String(yesterday.getDate()).padStart(2, '0');
  const month = String(yesterday.getMonth() + 1).padStart(2, '0');
  const year = yesterday.getFullYear();
  return `${day}.${month}.${year}`;
}

// ============================================
// КЛАВИАТУРЫ
// ============================================

function getMainKeyboard(isAdmin = false) {
  const buttons = isAdmin
    ? [
        [Markup.button.callback('📤 Расход', 'expense'), Markup.button.callback('📥 Поступление', 'income')],
        [Markup.button.callback('🔄 Перевод', 'transfer'), Markup.button.callback('💰 Денег на счетах', 'balances')]
      ]
    : [
        [Markup.button.callback('📤 Расход', 'expense'), Markup.button.callback('📥 Поступление', 'income')]
      ];
  
  return Markup.inlineKeyboard(buttons);
}

function getDateKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📅 Сегодня', 'date_today'), Markup.button.callback('📅 Вчера', 'date_yesterday')],
    [Markup.button.callback('📝 Другая дата', 'date_custom')],
    [Markup.button.callback('❌ Отмена', 'cancel')]
  ]);
}

function getCancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel')]]);
}

function getReceiptKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📎 Прикрепить чек', 'attach_receipt')],
    [Markup.button.callback('➡️ Пропустить', 'skip_receipt')],
    [Markup.button.callback('❌ Отмена', 'cancel')]
  ]);
}

function getListKeyboard(items, prefix = 'select') {
  const buttons = [];
  for (let i = 0; i < items.length; i++) {
    buttons.push([Markup.button.callback(items[i], `${prefix}_${i}`)]);
  }
  buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);
  return Markup.inlineKeyboard(buttons);
}

// ============================================
// КОМАНДА START
// ============================================

bot.start(async (ctx) => {
  const userId = ctx.from.id;
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
  if (!user?.isAdmin) {
    return ctx.reply('❌ Эта функция доступна только администраторам.');
  }
  await startTransfer(ctx);
});

// Показать остатки на счетах
bot.action('balances', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const user = await checkUserAccess(userId);
    
    if (!user) {
      await ctx.answerCbQuery('❌ У вас нет доступа');
      return;
    }

    await ctx.answerCbQuery();
    
    // Получаем данные с листа "ДДС: месяц" (строки 1-3, колонки A-I)
    const data = await getSheetData(SHEETS_CONFIG.MAIN, 'A1:I3');
    
    if (!data || data.length < 3) {
      await ctx.reply('❌ Не удалось получить данные о счетах', getMainKeyboard(user.isAdmin));
      return;
    }
    
    // Формируем сообщение
    let message = '💰 <b>Остатки на счетах:</b>\n\n';
    
    // Пары колонок: название (B=1, D=3, F=5, H=7) и сумма (C=2, E=4, G=6, I=8)
    const columnPairs = [
      { name: 1, amount: 2 },  // B, C
      { name: 3, amount: 4 },  // D, E
      { name: 5, amount: 6 },  // F, G
      { name: 7, amount: 8 }   // H, I
    ];
    
    // Проходим по всем строкам (0, 1, 2) и колонкам
    for (let row = 0; row < 3; row++) {
      columnPairs.forEach(pair => {
        const walletName = data[row][pair.name];
        const balanceValue = data[row][pair.amount];
        
        if (walletName && balanceValue) {
          const balanceStr = String(balanceValue).replace(',', '.');
          const balance = parseFloat(balanceStr) || 0;
          const formatted = balance.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          message += `💼 ${walletName}: <b>${formatted} ₽</b>\n`;
        }
      });
    }
    
// Берем итого из A3
    const totalValue = data[2][0]; // Строка 3, колонка A (индексы с 0)
    if (totalValue) {
      const totalStr = String(totalValue).replace(',', '.').replace(/\s/g, '');
      const total = parseFloat(totalStr) || 0;
      const formatted = total.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      message += `\n━━━━━━━━━━━━━━━━\n📊 <b>Итого: ${formatted} ₽</b>`;
    }
    
    await ctx.reply(message, { parse_mode: 'HTML', ...getMainKeyboard(user.isAdmin) });
    
  } catch (error) {
    console.error('Error showing balances:', error);
    await ctx.reply('❌ Ошибка при получении остатков', getMainKeyboard(false));
  }
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  userStates.delete(userId);
  const user = await checkUserAccess(userId);
  await ctx.reply('❌ Операция отменена', getMainKeyboard(user?.isAdmin));
});

bot.action('date_today', async (ctx) => {
  await ctx.answerCbQuery();
  await processDate(ctx, getTodayDate());
});

bot.action('date_yesterday', async (ctx) => {
  await ctx.answerCbQuery();
  await processDate(ctx, getYesterdayDate());
});

bot.action('date_custom', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  if (state) {
    state.waitingCustomDate = true;
    userStates.set(userId, state);
  }
  
  await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ\nНапример: 31.12.2025', getCancelKeyboard());
});

bot.action('attach_receipt', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  if (state) {
    state.waitingReceipt = true;
    userStates.set(userId, state);
  }
  
  await ctx.reply('📸 Отправьте фото чека', getCancelKeyboard());
});

bot.action('skip_receipt', async (ctx) => {
  await ctx.answerCbQuery();
  await finalizeRecord(ctx, null);
});

bot.action(/^select_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const index = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  if (!state || !state.currentList) {
    return ctx.reply('❌ Ошибка. Начните заново с /start');
  }
  
  const selectedItem = state.currentList[index];
  await processSelection(ctx, selectedItem);
});

// ============================================
// ОБРАБОТКА ФОТО
// ============================================

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  if (!state || !state.waitingReceipt) {
    return;
  }
  
  try {
    await ctx.reply('⏳ Загружаю чек на Google Drive...');
    
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileBuffer = await downloadTelegramFile(photo.file_id);
    
    const fileName = `Чек_${state.data.date}_${state.data.counterparty || 'без_контрагента'}_${Date.now()}.jpg`;
    const description = `Дата: ${state.data.date}, Сумма: ${state.data.amount}, Контрагент: ${state.data.counterparty}`;
    
    const driveLink = await uploadReceiptToDrive(fileBuffer, fileName, description);
    
    state.waitingReceipt = false;
    userStates.set(userId, state);
    
    await finalizeRecord(ctx, driveLink);
  } catch (error) {
    console.error('Error processing photo:', error);
    await ctx.reply('❌ Ошибка при загрузке чека. Попробуйте еще раз или пропустите.');
  }
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
    data: {},
    currentList: null,
    waitingCustomDate: false,
    waitingReceipt: false
  });
  
  await ctx.reply(
    `📅 <b>${operationName} - Шаг 1 из 6: Дата</b>\n\nВыберите дату:`,
    { parse_mode: 'HTML', ...getDateKeyboard() }
  );
}

async function startTransfer(ctx) {
  const userId = ctx.from.id;
  
  userStates.set(userId, {
    operation: 'transfer',
    state: 'transfer_waiting_date',
    data: {},
    currentList: null,
    waitingCustomDate: false
  });
  
  await ctx.reply(
    '📅 <b>Перевод - Шаг 1 из 5: Дата</b>\n\nВыберите дату:',
    { parse_mode: 'HTML', ...getDateKeyboard() }
  );
}

async function processDate(ctx, date) {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  if (!state) return;
  
  state.data.date = date;
  state.waitingCustomDate = false;
  
  const operationName = state.operation === 'expense' ? 'Расход' : 
                       state.operation === 'income' ? 'Поступление' : 'Перевод';
  
  if (state.operation === 'transfer') {
    state.state = 'transfer_waiting_amount';
    userStates.set(userId, state);
    await ctx.reply(
      `💰 <b>${operationName} - Шаг 2 из 5: Сумма</b>\n\nВведите сумму перевода:\nНапример: 50000`,
      { parse_mode: 'HTML', ...getCancelKeyboard() }
    );
  } else {
    state.state = 'waiting_amount';
    userStates.set(userId, state);
    await ctx.reply(
      `💰 <b>${operationName} - Шаг 2 из 6: Сумма</b>\n\nВведите сумму (только число):\nНапример: 50000`,
      { parse_mode: 'HTML', ...getCancelKeyboard() }
    );
  }
}

async function processSelection(ctx, selectedItem) {
  const userId = ctx.from.id;
  const user = await checkUserAccess(userId);
  const state = userStates.get(userId);
  
  if (!state) return;
  
  const { operation, state: currentState, data } = state;
  
  try {
    if (operation === 'transfer') {
      await handleTransferSelection(ctx, selectedItem, currentState, data, user, state);
    } else {
      await handleRegularSelection(ctx, selectedItem, currentState, data, user, operation, state);
    }
  } catch (error) {
    console.error('Error processing selection:', error);
    await ctx.reply('❌ Произошла ошибка. Попробуйте снова.');
  }
}

async function finalizeRecord(ctx, receiptLink) {
  const userId = ctx.from.id;
  const user = await checkUserAccess(userId);
  const state = userStates.get(userId);
  if (!state) return;
  
  try {
    const rowNumber = await addRecord(state.data, user, receiptLink);
    
    let summary = `✅ <b>Запись успешно добавлена!</b>\n\n📅 Дата: ${state.data.date}\n💰 Сумма: ${state.data.amount}\n👛 Кошелек: ${state.data.wallet}\n🎯 Направление: ${state.data.direction}\n🤝 Контрагент: ${state.data.counterparty}\n📝 Назначение: ${state.data.purpose}\n📊 Статья: ${state.data.article}`;
    
    if (receiptLink) {
      summary += `\n📎 Чек: <a href="${receiptLink}">Открыть</a>`;
    }
    
    summary += `\n\nСтрока: ${rowNumber}`;
    
    // Проверка на автоматические переводы для поступлений на Т-Банк
    if (state.operation === 'income' && state.data.wallet === 'Счет Т-банк') {
      await ctx.reply(summary, { parse_mode: 'HTML' });
      await ctx.reply(
        '🔄 <b>Автоматические переводы</b>\n\nСделать переводы:\n• 10% на маркетинг\n• 7% на налоги\n• 1% на стратсессию?',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Да', 'auto_transfer_yes'),
              Markup.button.callback('❌ Нет', 'auto_transfer_no')
            ]
          ])
        }
      );
      
      userStates.set(userId, {
        stage: 'awaiting_auto_transfer',
        incomeAmount: parseFloat(String(state.data.amount).replace(',', '.')),
        incomeDate: state.data.date,
        direction: state.data.direction
      });
      return;
    }
    
    // Проверка на платежное поручение для расходов с Т-Банк
    if (state.operation === 'expense' && state.data.wallet === 'Счет Т-банк') {
      await ctx.reply(summary, { parse_mode: 'HTML' });
      await ctx.reply(
        '📄 <b>Платежное поручение</b>\n\nСоздать расход на платежное поручение?',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Да', 'payment_order_yes'),
              Markup.button.callback('❌ Нет', 'payment_order_no')
            ]
          ])
        }
      );
      
      userStates.set(userId, {
        stage: 'awaiting_payment_order',
        expenseDate: state.data.date,
        direction: state.data.direction
      });
      return;
    }
    
    await ctx.reply(summary, { parse_mode: 'HTML', ...getMainKeyboard(user.isAdmin) });
    userStates.delete(userId);
  } catch (error) {
    console.error('Error finalizing record:', error);
    await ctx.reply('❌ Ошибка при сохранении записи: ' + error.message);
  }
}

// ============================================
// ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ
// ============================================

// ============================================
// ОБРАБОТЧИКИ АВТОПЕРЕВОДОВ
// ============================================

bot.action('auto_transfer_yes', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    const user = await checkUserAccess(userId);
    
    if (!state || state.stage !== 'awaiting_auto_transfer') {
      await ctx.answerCbQuery('❌ Ошибка состояния');
      return;
    }
    
    await ctx.answerCbQuery();
    
    const amount = state.incomeAmount;
    const date = state.incomeDate;
    const direction = state.direction;
    
    const transfers = [
      { percent: 10, account: 'На маркетинг', amount: amount * 0.10 },
      { percent: 7, account: 'На налоги', amount: amount * 0.07 },
      { percent: 1, account: 'На страт сессию', amount: amount * 0.01 }
    ];
    
    let message = '✅ <b>Автопереводы выполнены:</b>\n\n';
    
    for (const transfer of transfers) {
      const recordOut = {
        date: date,
        amount: String('-' + transfer.amount.toFixed(2)).replace('.', ','),
        wallet: 'Счет Т-банк',
        direction: direction,
        counterparty: transfer.account,
        purpose: 'Перевод между счетами',
        article: 'Выбытие — Перевод между счетами'
      };
      const rowOut = await addRecord(recordOut, user);
      
      const recordIn = {
        date: date,
        amount: String(transfer.amount.toFixed(2)).replace('.', ','),
        wallet: transfer.account,
        direction: direction,
        counterparty: 'Счет Т-банк',
        purpose: 'Перевод между счетами',
        article: 'Поступление — Перевод между счетами'
      };
      const rowIn = await addRecord(recordIn, user);
      
      message += `💼 ${transfer.percent}% → ${transfer.account}: <b>${transfer.amount.toFixed(2)} ₽</b> (строки ${rowOut}, ${rowIn})\n`;
    }
    
    await ctx.reply(message, { parse_mode: 'HTML', ...getMainKeyboard(user.isAdmin) });
    userStates.delete(userId);
    
  } catch (error) {
    console.error('Error in auto transfer:', error);
    await ctx.reply('❌ Ошибка при создании переводов', getMainKeyboard(false));
  }
});

bot.action('auto_transfer_no', async (ctx) => {
  const userId = ctx.from.id;
  const user = await checkUserAccess(userId);
  await ctx.answerCbQuery();
  await ctx.reply('✅ Операция завершена', { ...getMainKeyboard(user.isAdmin) });
  userStates.delete(userId);
});

bot.action('payment_order_yes', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await ctx.reply('💰 Введите сумму платежного поручения:', { parse_mode: 'HTML' });
  
  const state = userStates.get(userId);
  state.stage = 'awaiting_payment_order_amount';
  userStates.set(userId, state);
});

bot.action('payment_order_no', async (ctx) => {
  const userId = ctx.from.id;
  const user = await checkUserAccess(userId);
  await ctx.answerCbQuery();
  await ctx.reply('✅ Операция завершена', { ...getMainKeyboard(user.isAdmin) });
  userStates.delete(userId);
});
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  
  const user = await checkUserAccess(userId);
  if (!user) {
    return ctx.reply(`🚫 У вас нет доступа. Ваш ID: ${userId}`);
  }
  
  const state = userStates.get(userId);
  if (!state) {
    return ctx.reply('Используйте /start для начала работы');
  }
  
  if (state.waitingCustomDate) {
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
      return ctx.reply('❌ Неверный формат даты. Используйте ДД.ММ.ГГГГ\nНапример: 30.08.2025');
    }
    await processDate(ctx, text);
    return;
  }
  
  await handleTextInput(ctx, text, user, state);
});

async function handleTextInput(ctx, text, user, state) {
  const userId = ctx.from.id;
  const { operation, state: currentState, data } = state;
  // Обработка платежного поручения
  if (state.stage === 'awaiting_payment_order_amount') {
    const poAmount = text.trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(poAmount)) {
      await ctx.reply('❌ Неверный формат суммы. Введите число:', { parse_mode: 'HTML' });
      return;
    }
    
    const poRecord = {
      date: state.expenseDate,
      amount: String('-' + poAmount).replace('.', ','),
      wallet: 'Счет Т-банк',
      direction: state.direction,
      counterparty: 'АО ТБанк',
      purpose: 'Платежное поручение',
      article: 'РКО'
    };
    
    const poRow = await addRecord(poRecord, user);
    
    const poSummary = `✅ <b>Платежное поручение создано!</b>\n\n📅 Дата: ${state.expenseDate}\n💰 Сумма: -${poAmount} ₽\n💼 Кошелек: Счет Т-банк\n👤 Контрагент: АО ТБанк\n📝 Назначение: Платежное поручение\n📊 Статья: РКО\n\nСтрока: ${poRow}`;
    
    await ctx.reply(poSummary, { parse_mode: 'HTML', ...getMainKeyboard(user.isAdmin) });
    userStates.delete(userId);
    return;
  }

  
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
  const state = userStates.get(userId);
  const operationName = operation === 'expense' ? 'Расход' : 'Поступление';
  
  switch (currentState) {
    case 'waiting_amount':
      const amount = text.replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return ctx.reply('❌ Неверный формат суммы. Введите положительное число.');
      }
      data.amount = operation === 'expense' ? '-' + amount : amount;
      state.state = 'waiting_wallet';
      state.data = data;
      
      const wallets = await getWallets();
      if (wallets.length === 0) {
        return ctx.reply('❌ Список кошельков пуст.');
      }
      
      state.currentList = wallets;
      userStates.set(userId, state);
      await ctx.reply(
        `👛 <b>${operationName} - Шаг 3 из 6: Кошелек</b>\n\nВыберите кошелек:`,
        { parse_mode: 'HTML', ...getListKeyboard(wallets) }
      );
      break;
      
    case 'waiting_counterparty':
      data.counterparty = text;
      state.state = 'waiting_purpose';
      state.data = data;
      userStates.set(userId, state);
      await ctx.reply(
        `📝 <b>${operationName} - Шаг 6 из 6: Назначение платежа</b>\n\nВведите назначение платежа:`,
        { parse_mode: 'HTML', ...getCancelKeyboard() }
      );
      break;
      
    case 'waiting_purpose':
      data.purpose = text;
      state.state = 'waiting_article';
      state.data = data;
      
      const articleType = operation === 'expense' ? 'Выбытие' : 'Поступление';
      const articles = await getArticles(articleType, true);
      
      if (articles.length === 0) {
        return ctx.reply('❌ Список статей пуст.');
      }
      
      state.currentList = articles;
      userStates.set(userId, state);
      await ctx.reply(
        `📊 <b>${operationName} - Выбор статьи</b>\n\nВыберите статью:`,
        { parse_mode: 'HTML', ...getListKeyboard(articles) }
      );
      break;
  }
}

async function handleRegularSelection(ctx, selectedItem, currentState, data, user, operation, state) {
  const userId = ctx.from.id;
  const operationName = operation === 'expense' ? 'Расход' : 'Поступление';
  
  switch (currentState) {
    case 'waiting_wallet':
      data.wallet = selectedItem;
      state.state = 'waiting_direction';
      state.data = data;
      
      const directions = await getDirections();
      if (directions.length === 0) {
        return ctx.reply('❌ Список направлений пуст.');
      }
      
      state.currentList = directions;
      userStates.set(userId, state);
      await ctx.reply(
        `🎯 <b>${operationName} - Шаг 4 из 6: Направление бизнеса</b>\n\nВыберите направление:`,
        { parse_mode: 'HTML', ...getListKeyboard(directions) }
      );
      break;
      
    case 'waiting_direction':
      data.direction = selectedItem;
      state.state = 'waiting_counterparty';
      state.data = data;
      state.currentList = null;
      userStates.set(userId, state);
      await ctx.reply(
        `🤝 <b>${operationName} - Шаг 5 из 6: Контрагент</b>\n\nВведите название контрагента:`,
        { parse_mode: 'HTML', ...getCancelKeyboard() }
      );
      break;
      
    case 'waiting_article':
      data.article = selectedItem;
      state.data = data;
      state.currentList = null;
      userStates.set(userId, state);
      
      // Предлагаем прикрепить чек
      await ctx.reply(
        `📎 <b>Хотите прикрепить чек?</b>\n\nВы можете загрузить фото чека, и оно будет сохранено на Google Drive со ссылкой в таблице.`,
        { parse_mode: 'HTML', ...getReceiptKeyboard() }
      );
      break;
  }
}

// ============================================
// ОБРАБОТКА ПЕРЕВОДОВ
// ============================================

async function handleTransferState(ctx, text, currentState, data, user) {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  switch (currentState) {
    case 'transfer_waiting_amount':
      const amount = text.replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return ctx.reply('❌ Неверный формат суммы.');
      }
      data.amount = amount;
      state.state = 'transfer_waiting_direction';
      state.data = data;
      
      const directions = await getDirections();
      state.currentList = directions;
      userStates.set(userId, state);
      await ctx.reply(
        '🎯 <b>Перевод - Шаг 3 из 5: Направление бизнеса</b>\n\nВыберите направление:',
        { parse_mode: 'HTML', ...getListKeyboard(directions) }
      );
      break;
  }
}

async function handleTransferSelection(ctx, selectedItem, currentState, data, user, state) {
  const userId = ctx.from.id;
  
  switch (currentState) {
    case 'transfer_waiting_direction':
      data.direction = selectedItem;
      state.state = 'transfer_waiting_wallet_from';
      state.data = data;
      
      const walletsFrom = await getWallets();
      state.currentList = walletsFrom;
      userStates.set(userId, state);
      await ctx.reply(
        '📤 <b>Перевод - Шаг 4 из 5: Кошелек выбытия</b>\n\nВыберите кошелек, ИЗ которого переводятся средства:',
        { parse_mode: 'HTML', ...getListKeyboard(walletsFrom) }
      );
      break;
      
    case 'transfer_waiting_wallet_from':
      data.walletFrom = selectedItem;
      state.state = 'transfer_waiting_wallet_to';
      state.data = data;
      
      const walletsTo = await getWallets();
      state.currentList = walletsTo;
      userStates.set(userId, state);
      await ctx.reply(
        '📥 <b>Перевод - Шаг 5 из 5: Кошелек поступления</b>\n\nВыберите кошелек, В который переводятся средства:',
        { parse_mode: 'HTML', ...getListKeyboard(walletsTo) }
      );
      break;
      
    case 'transfer_waiting_wallet_to':
      data.walletTo = selectedItem;
      
      if (data.walletFrom === data.walletTo) {
        return ctx.reply('❌ Кошельки не могут быть одинаковыми.');
      }
      
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
      // Продолжение функции handleTransferSelection
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch().then(() => {
  console.log('✅ Бот запущен!');
}).catch((error) => {
  console.error('❌ Ошибка запуска:', error);
});

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}`, err);
});
