require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios'); // n8n'e istek atmak için eklendi

// n8n Production Webhook Adresiniz
const N8N_WEBHOOK_URL = 'https://n8n.emregormez.com/webhook/3243acbc-d136-4570-8d9c-0138bd1bc07a';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Error Handler
const errorHandler = require('./middlewares/errorHandler');

app.use((req, res, next) => {
  res.sendError = errorHandler.bind(null, req, res);
  next();
});

// Response Handler
const responseHandler = require('./middlewares/responseHandler');

app.use((req, res, next) => {
  res.sendResponse = responseHandler.bind(null, res);
  next();
});

// CORS
const corsOptions = {
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));

// Routes
app.use('/session', require('./routes/session'));
app.use('/message', require('./routes/message'));

// Logger
const { logger } = require('./utils/logger');

// --- WHATSAPP MESAJLARINI n8n'E İLETEN FONKSİYON ---
// Bu fonksiyonu WhatsApp istemcinizin (client) oluşturulduğu yerde 
// client.on('message', handleIncomingMessage); şeklinde çağırabilirsiniz.
const handleIncomingMessage = async (msg) => {
  // Botun kendi gönderdiği mesajları ve durum/hikayeleri yoksay
  if (msg.fromMe || msg.isStatus) return;

  try {
    const contact = await msg.getContact();

    // n8n workflow'unun 'Bilgiler' adımında beklediği veri formatı
    const payload = {
      chat_id: msg.from,
      message: msg.body,
      timestamp: new Date().toISOString(),
      attendees: [
        {
          attendee_name: contact.pushname || contact.name || "Bilinmeyen Kullanıcı"
        }
      ],
      account_info: {
        phone_number: contact.number || msg.from.replace('@c.us', '')
      }
    };

    await axios.post(N8N_WEBHOOK_URL, payload);
    logger.info(`[n8n] Mesaj iletildi: ${msg.body}`);
  } catch (error) {
    logger.error(`[n8n Webhook Hatası]: ${error.message}`);
  }
};

// Fonksiyonu diğer dosyalardan erişebilmek için dışa aktarıyoruz
module.exports = { app, handleIncomingMessage };

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3000;
app.listen(PORT, HOST, () => {
  logger.info(`Server running at http://${HOST}:${PORT}/`);
});
