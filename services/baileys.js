const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const pino = require('pino');
const fs = require('fs').promises;
const { logger, errorLogger } = require('../utils/logger');

const N8N_WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://n8n.emregormez.com/webhook/3243acbc-d136-4570-8d9c-0138bd1bc07a';

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.qr = null;
    this.sessionPath = path.join(__dirname, '../sessions');
    this.connectionUpdateHandler = null;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 5;
    this.heartbeatInterval = null;
  }

  resetReconnectAttempts() {
    this.reconnectAttempts = 0;
  }

  async waitForQR(timeout = 60000) {
    return new Promise((resolve) => {
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.connectionUpdateHandler && this.sock?.ev) {
          this.sock.ev.off('connection.update', this.connectionUpdateHandler);
          this.connectionUpdateHandler = null;
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);

      if (this.sock) {
        this.connectionUpdateHandler = (update) => {
          const { connection, qr } = update;

          if (qr) {
            cleanup();
            this.qr = qr;
            resolve(qr);
          } else if (connection === 'open') {
            cleanup();
            resolve(null);
          }
        };

        this.sock.ev.on('connection.update', this.connectionUpdateHandler);
      } else {
        cleanup();
        resolve(null);
      }
    });
  }

  // Socket, eventler ve heartbeat döngüsünü güvenli temizleme
  async cleanupSocket() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
      } catch (err) {
        // Sessiz hata yakalama
      }
      this.sock = null;
    }
  }

  async initialize(isReconnecting = false) {
    try {
      if (isReconnecting) {
        this.reconnectAttempts += 1;
        if (this.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
          logger.warn(`Maximum reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) exceeded`);
          await this.handleLogout('max_attempts_exceeded');
          return await this.initialize(false);
        }
        logger.info(`Attempting to reconnect... (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
      } else {
        this.resetReconnectAttempts();
      }

      await this.cleanupSocket();

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // WhatsApp'ın bağlantıyı düşürmemesi için kararlı masaüstü kimliği
        logger: pino({ level: 'silent' }),
        syncFullHistory: false, // Bellek taşmasını engeller
        keepAliveIntervalMs: 10000, // 10 saniyede bir ping atarak soketi canlı tutar
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        emitOwnEvents: false,
        markOnlineOnConnect: true, // Her zaman çevrim içi/aktif kalmasını sağlar
      });

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qr = qr;
        }

        if (connection === 'close') {
          this.isConnected = false;
          if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
          }

          const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          logger.info(`Connection closed. Status code: ${statusCode}, Should reconnect: ${shouldReconnect}`);

          if (shouldReconnect) {
            await this.initialize(true);
          } else {
            logger.info({ msg: 'Session terminated by WhatsApp / Logged out' });
            await this.handleLogout('connection_closed');
            await this.initialize(false);
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          this.qr = null;
          this.resetReconnectAttempts();
          logger.info({ msg: 'WhatsApp connection successful!' });

          // 15 saniyede bir WhatsApp'a varlık sinyali (heartbeat) göndererek uyku modunu engeller
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = setInterval(async () => {
            if (this.sock && this.isConnected) {
              try {
                await this.sock.sendPresenceUpdate('available');
              } catch (err) {
                // Sessiz geç
              }
            }
          }, 15000);

          await WhatsAppService.notifyWebhook('connection', { status: 'connected' });
        }
      });

      this.sock.ev.on('creds.update', saveCreds);

      // --- GELEN MESAJLARI İŞLEME ---
      this.sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        try {
          await Promise.all(m.messages.map(async (msg) => {
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith('@g.us')) {
              return;
            }

            const textContent = 
              msg.message.conversation || 
              msg.message.extendedTextMessage?.text || 
              msg.message.imageMessage?.caption || 
              msg.message.videoMessage?.caption || 
              msg.message.buttonsResponseMessage?.selectedButtonId || 
              msg.message.templateButtonReplyMessage?.selectedId || 
              msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || 
              '';

            if (!textContent) return;

            // Gerçek JID tespiti (LID veya standart telefon numarası)
            const senderJid = msg.key.remoteJid;
            const actualSender = msg.key.participant || msg.participant || senderJid;
            const cleanNumber = actualSender.replace(/@.+/, '').replace(/[^\d]/g, '');

            const senderName = msg.pushName || 'WhatsApp Kullanıcısı';

            const n8nPayload = {
              chat_id: senderJid,
              sender: actualSender,
              message: textContent,
              timestamp: new Date().toISOString(),
              attendees: [{ attendee_name: senderName }],
              account_info: { phone_number: cleanNumber }
            };

            try {
              const response = await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'Baileys-n8n-Bridge'
                },
                body: JSON.stringify(n8nPayload),
              });

              if (!response.ok) {
                throw new Error(`n8n HTTP ${response.status}: ${response.statusText}`);
              }

              logger.info({
                msg: 'Mesaj başarıyla n8n sistemine iletildi',
                from: senderJid,
                content: textContent,
              });
            } catch (n8nError) {
              errorLogger.error({
                msg: 'n8n iletim hatası',
                error: n8nError.message,
              });
            }
          }));
        } catch (error) {
          errorLogger.error({
            msg: 'Error processing incoming message',
            error: error.message,
          });
        }
      });

      const qr = await this.waitForQR();

      if (qr) {
        await WhatsAppService.notifyWebhook('connection', { status: 'waiting_qr', qr });
        return { success: true, status: 'waiting_qr', qr };
      }

      if (this.isConnected) {
        return { success: true, status: 'connected', message: 'WhatsApp connection successful' };
      }

      return { success: false, status: 'error', message: 'Failed to get QR code or establish connection' };
    } catch (error) {
      errorLogger.error({
        msg: 'Error during WhatsApp connection initialization',
        error: error?.message || error,
      });
      await WhatsAppService.notifyWebhook('error', { error: error.message });
      return {
        success: false,
        status: 'error',
        message: 'Failed to initialize WhatsApp connection',
        error: error.message,
      };
    }
  }

  async handleLogout(reason = 'normal_logout') {
    try {
      await this.cleanupSocket();
      await fs.rm(this.sessionPath, { recursive: true, force: true });

      this.isConnected = false;
      this.qr = null;

      await WhatsAppService.notifyWebhook('connection', {
        status: 'logged_out',
        reason,
      });

      logger.info(`Session files cleaned and session terminated (${reason})`);
      return { success: true, status: 'logged_out', message: 'Session successfully terminated', reason };
    } catch (error) {
      errorLogger.error({
        msg: 'Error during session cleanup',
        error: error?.message || error,
      });
      return { success: false, status: 'error', message: 'Error occurred while terminating session', error: error.message };
    }
  }

  async logout() {
    try {
      if (this.sock) {
        await this.sock.logout();
        return await this.handleLogout('user_logout');
      }
      return { success: false, status: 'error', message: 'No active session found' };
    } catch (error) {
      errorLogger.error({
        msg: 'Error during logout',
        error: error?.message || error,
      });
      return { success: false, status: 'error', message: 'Error occurred while logging out', error: error.message };
    }
  }

  static async notifyWebhook(event, data) {
    const webhookUrl = process.env.WEBHOOK_URL || N8N_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Baileys-API-Webhook',
          'X-Event-Type': event,
        },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          data,
        }),
      });

      if (!response.ok) {
        throw new Error(`Webhook request failed with status ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      errorLogger.error({
        msg: 'Error during webhook notification',
        event,
        error: error.message,
      });
    }
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      qr: this.qr,
    };
  }

  async sendMessage(to, message) {
    if (!this.isConnected) {
      throw new Error('WhatsApp connection is not active');
    }

    try {
      let targetJid = String(to).trim();

      // n8n veya dış kaynaktan gelebilecek baş eşittir işaretlerini temizle
      targetJid = targetJid.replace(/^=+/, '');

      // @ işareti yoksa sadece rakamları alıp standart WhatsApp numarasına çevir
      if (!targetJid.includes('@')) {
        const cleanNumber = targetJid.replace(/[^\d]/g, '');
        targetJid = `${cleanNumber}@s.whatsapp.net`;
      }

      const result = await this.sock.sendMessage(targetJid, { text: message });
      logger.info({
        msg: 'Message sent',
        to: targetJid,
        messageId: result?.key?.id,
      });
      return result;
    } catch (error) {
      errorLogger.error({
        msg: 'Failed to send message',
        error: error.message,
      });
      throw error;
    }
  }

  async checkNumber(phoneNumber) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp connection is not active');
    }

    try {
      const cleanNumber = phoneNumber.replace(/[^\d]/g, '');
      const [result] = await this.sock.onWhatsApp(cleanNumber);

      return {
        exists: !!result?.exists,
        jid: result?.jid || null,
      };
    } catch (error) {
      errorLogger.error({ msg: 'Failed to check phone number', phoneNumber, error: error.message });
      throw error;
    }
  }
}

module.exports = new WhatsAppService();
