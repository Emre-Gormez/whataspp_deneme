require('dotenv').config();

const express = require('express');
const cors = require('cors');

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

// 404
// app.use((req, res) => { res.status(404).send(null); });

// Logger
const { logger } = require('./utils/logger');

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3000;
app.listen(PORT, HOST, () => {
  logger.info(`Server running at http://${HOST}:${PORT}/`);
});

const axios = require('axios');
const N8N_WEBHOOK_URL = 'https://n8n.emregormez.com/webhook/3243acbc-d136-4570-8d9c-0138bd1bc07a';

module.exports = app;
