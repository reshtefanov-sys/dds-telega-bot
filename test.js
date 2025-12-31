require('dotenv').config();
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

async function listSheets() {
  try {
    console.log('📊 Подключаемся к таблице...');
    console.log('SPREADSHEET_ID:', SPREADSHEET_ID);
    
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    
    console.log('\n✅ Доступ к таблице есть!');
    console.log('📋 Название таблицы:', response.data.properties.title);
    console.log('\n📄 Список всех листов:');
    
    response.data.sheets.forEach((sheet, index) => {
      console.log(`${index + 1}. "${sheet.properties.title}"`);
    });
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    if (error.code === 404) {
      console.error('Таблица не найдена или нет доступа');
    }
  }
}

listSheets();
