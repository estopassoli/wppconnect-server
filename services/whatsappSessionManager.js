/**
 * WhatsApp Session Manager - Cold Start Implementation
 *
 * Gerencia sessões WhatsApp com Chromium fechado quando inativo.
 * Usa endpoints existentes do WPPConnect Server via HTTP.
 *
 * Uso:
 *   const sessionManager = require('./whatsappSessionManager').default;
 *
 *   const client = await sessionManager.ensureConnected(sessionId);
 *   await client.sendMessage(phone, message);
 *   await sessionManager.closeIfNeeded(sessionId);
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');

class WhatsAppSessionManager {
  /**
   * Inicializa o Session Manager
   * @param {object} config - Configurações
   * @param {string} config.baseURL - URL base do WPPConnect Server
   * @param {string} config.secretKey - Secret key para autenticação
   * @param {number} config.maxActiveSessions - Máximo de sessões ativas (default: 3)
   * @param {number} config.idleTimeout - Timeout para fechar sessão inativa (ms, default: 5min)
   * @param {object} config.logger - Logger
   */
  constructor(config = {}) {
    this.baseURL =
      config.baseURL || process.env.WPPCONNECT_URL || 'http://localhost:21465';
    this.secretKey =
      config.secretKey ||
      process.env.WPPCONNECT_SECRET_KEY ||
      'THISISMYSECURETOKEN';
    this.maxActiveSessions = config.maxActiveSessions || 3;
    this.idleTimeout = config.idleTimeout || 300000; // 5 minutos
    this.logger = config.logger || console;

    // Estado das sessões em memória
    this.sessions = new Map(); // sessionId -> sessionInfo
    this.clients = new Map(); // sessionId -> axios client instance
    this.activeSessionCount = 0; // Contagem de sessões ativas

    // Configuração do client axios
    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      timeout: 60000, // 60 segundos para operações lentas
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Middleware para adicionar session ao request
    this.axiosInstance.interceptors.request.use((config) => {
      if (config.params) {
        config.params.session =
          config.params.session || config.params['session:'];
      }
      return config;
    });
  }

  /**
   * Garante que uma sessão esteja conectada
   * @param {string} sessionId - ID da sessão
   * @param {object} options - Opcional: phone, deviceName, etc.
   * @returns {Promise<object>} - Cliente axios para enviar mensagens
   */
  async ensureConnected(sessionId, options = {}) {
    // Atualiza timestamp de uso
    this._updateLastUsed(sessionId);

    // Verifica se já temos uma sessão ativa
    const existingSession = this.sessions.get(sessionId);
    if (existingSession) {
      // Verifica se está conectado
      const connected = await this._checkConnection(sessionId);
      if (connected) {
        this.logger.info(`[${sessionId}] Sessão já conectada`);
        return this.clients.get(sessionId);
      }

      // Sessão existe mas não conectada, re-inicia
      this.logger.warn(
        `[${sessionId}] Sessão existe mas não conectada, reiniciando...`
      );
    }

    // Verifica limite de sessões ativas
    if (this.activeSessionCount >= this.maxActiveSessions) {
      throw new Error(
        `Limite de sessões ativas atingido (${this.maxActiveSessions}). Aguarde sessões liberarem.`
      );
    }

    // Inicia nova sessão
    await this._startSession(sessionId, options);

    // Aguarda conexão com retry
    const connected = await this._waitForConnection(sessionId);

    if (!connected) {
      await this._closeSession(sessionId);
      throw new Error(
        `Falha ao conectar sessão ${sessionId} após múltiplos retries`
      );
    }

    // Armazena sessão
    const sessionInfo = {
      sessionId,
      connectedAt: Date.now(),
      lastUsed: Date.now(),
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, sessionInfo);
    this.activeSessionCount++;

    this.logger.info(`[${sessionId}] Sessão conectada com sucesso`);

    return this._getClient(sessionId);
  }

  /**
   * Verifica conexão da sessão
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async _checkConnection(sessionId) {
    try {
      const params = { secretkey: this.secretKey };

      const response = await this.axiosInstance.post(
        `/api/${sessionId}/check-connection-session`,
        null,
        { params }
      );

      return response.data.status === true;
    } catch (error) {
      this.logger.warn(
        `[${sessionId}] Erro ao verificar conexão: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Inicia nova sessão
   * @param {string} sessionId
   * @param {object} options
   */
  async _startSession(sessionId, options = {}) {
    try {
      const params = {
        secretkey: this.secretKey,
        waitQrCode: false, // Não espera QR, assume que já foi escaneado
      };

      // Tenta iniciar sessão (se token já existe)
      await this.axiosInstance.post(`/api/${sessionId}/start-session`, null, {
        params,
      });

      // Se falhar por token não existir, pode ser necessário autenticar
      // O QR code deve ser mostrado e escaneado via frontend/outra interface
      this.logger.info(
        `[${sessionId}] Sessão iniciada (QR code deve ser escaneado)`
      );
    } catch (error) {
      if (
        error.response?.status === 404 ||
        error.message?.includes('not found')
      ) {
        this.logger.info(
          `[${sessionId}] Token não encontrado - precisa autenticar`
        );
      } else {
        throw error;
      }
    }
  }

  /**
   * Aguarda sessão conectar com retry
   * @param {string} sessionId
   * @param {number} maxRetries
   * @returns {Promise<boolean>}
   */
  async _waitForConnection(sessionId, maxRetries = 10) {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const connected = await this._checkConnection(sessionId);

        if (connected) {
          return true;
        }

        // Verifica status atual
        const sessionStatus = this.sessions.get(sessionId);
        const status = sessionStatus
          ? this._getClient(sessionId).data?.status
          : 'unknown';

        this.logger.debug(
          `[${sessionId}] Aguardando conexão... Status: ${status} (retry ${
            retries + 1
          }/${maxRetries})`
        );

        retries++;
        await this._delay(1000 + retries * 500); // Delay crescente: 1s, 1.5s, 2s, ...
      } catch (error) {
        retries++;
        this.logger.debug(
          `[${sessionId}] Verificação falhou: ${error.message}`
        );
        await this._delay(1000);
      }
    }

    return false;
  }

  /**
   * Fecha sessão se necessário
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async closeIfNeeded(sessionId) {
    const sessionInfo = this.sessions.get(sessionId);

    if (!sessionInfo) {
      return { success: true, message: 'Session not found' };
    }

    // Verifica se está conectado
    const connected = await this._checkConnection(sessionId);

    if (!connected) {
      this.logger.info(`[${sessionId}] Sessão já desconectada`);
      return { success: true, message: 'Already disconnected' };
    }

    return this._closeSession(sessionId);
  }

  /**
   * Encerra sessão
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async _closeSession(sessionId) {
    const sessionInfo = this.sessions.get(sessionId);

    if (!sessionInfo) {
      return { success: true, message: 'Session not found' };
    }

    try {
      const params = { secretkey: this.secretKey };

      // Chama close-session via HTTP
      await this.axiosInstance.post(`/api/${sessionId}/close-session`, null, {
        params,
      });

      this.logger.info(`[${sessionId}] Sessão fechada com sucesso`);

      // Remove do mapa e decrementa contador
      this.sessions.delete(sessionId);
      this.activeSessionCount--;

      return { success: true, message: 'Session closed successfully' };
    } catch (error) {
      this.logger.error(
        `[${sessionId}] Erro ao fechar sessão: ${error.message}`
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Envia mensagem
   * @param {string} sessionId
   * @param {string} number
   * @param {string} message
   * @param {object} options
   * @returns {Promise<object>}
   */
  async sendMessage(sessionId, number, message, options = {}) {
    const sessionStatus = await this._prepareForSend(sessionId);

    if (!sessionStatus.active) {
      throw new Error(`Sessão ${sessionId} não está conectada`);
    }

    try {
      const params = { secretkey: this.secretKey };

      // Envia mensagem via API existente
      const payload = {
        phone: number,
        ...message,
        ...options,
      };

      const response = await this.axiosInstance.post(
        `/api/${sessionId}/send-message`,
        payload,
        { params }
      );

      this._updateLastUsed(sessionId);

      this.logger.info(`[${sessionId}] Mensagem enviada para ${number}`);

      return {
        success: true,
        messageId: response.data.response,
      };
    } catch (error) {
      this.logger.error(
        `[${sessionId}] Erro ao enviar mensagem: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Prepara sessão para envio
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async _prepareForSend(sessionId) {
    const sessionStatus = this.sessions.get(sessionId);

    if (!sessionStatus) {
      throw new Error(`Sessão ${sessionId} não encontrada`);
    }

    const connected = await this._checkConnection(sessionId);

    if (!connected) {
      throw new Error(
        `Sessão ${sessionId} não está conectada. Chame ensureConnected().`
      );
    }

    return { active: true, connected: true };
  }

  /**
   * Garante que Chromium esteja rodando para a sessão
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async ensureChromiumRunning(sessionId, options = {}) {
    // Verifica se sessão está ativa
    if (!this.sessions.has(sessionId)) {
      // Inicia nova
      await this.ensureConnected(sessionId, options);
      return { created: true, sessionId };
    }

    const sessionInfo = this.sessions.get(sessionId);
    const connected = await this._checkConnection(sessionId);

    if (connected) {
      return { exists: true, connected: true, sessionId };
    }

    // Sessão existe mas não conectada, tenta reconectar
    this.logger.warn(
      `[${sessionId}] Sessão existe mas não conectada. Tentando reconectar...`
    );
    await this.ensureConnected(sessionId, options);

    return { exists: true, connected: true, sessionId };
  }

  /**
   * Verifica e fecha sessões inativas
   * @param {number} idleTime - Tempo mínimo de inatividade para fechar (ms)
   */
  async cleanupIdleSessions(idleTime = null) {
    const checkTime = idleTime || this.idleTimeout;

    const now = Date.now();
    const sessionsToRemove = [];

    for (const [sessionId, sessionInfo] of this.sessions) {
      const age = now - sessionInfo.lastUsed;

      if (age > checkTime) {
        this.logger.info(
          `[${sessionId}] Sessão inativa (${age}ms) sendo encerrada`
        );
        sessionsToRemove.push(sessionId);
      }
    }

    // Fecha sessões inativas
    const closePromises = sessionsToRemove.map((sessionId) =>
      this._closeSession(sessionId).catch((error) => {
        this.logger.error(
          `[${sessionId}] Erro ao fechar sessão inativa: ${error.message}`
        );
      })
    );

    await Promise.all(closePromises);

    this.logger.info(
      `Cleanup: encerradas ${sessionsToRemove.length} sessões inativas`
    );
  }

  /**
   * Verifica status de sessão
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async getStatus(sessionId) {
    const sessionInfo = this.sessions.get(sessionId);

    if (!sessionInfo) {
      return {
        sessionId,
        status: 'NOT_FOUND',
        active: false,
        lastUsed: null,
      };
    }

    const connected = await this._checkConnection(sessionId);

    return {
      sessionId,
      status: connected ? 'CONNECTED' : 'DISCONNECTED',
      active: connected,
      lastUsed: sessionInfo.lastUsed,
      age: Date.now() - sessionInfo.lastUsed,
    };
  }

  /**
   * Retorna estatísticas
   * @returns {object}
   */
  getStats() {
    return {
      activeSessions: this.activeSessionCount,
      maxActiveSessions: this.maxActiveSessions,
      availableSlots: this.maxActiveSessions - this.activeSessionCount,
      totalSessions: this.sessions.size,
      idleTimeout: this.idleTimeout,
    };
  }

  /**
   * Limpa todas as sessões (cuidado!)
   */
  async closeAllSessions() {
    const sessionIds = Array.from(this.sessions.keys());
    const promises = sessionIds.map((sessionId) =>
      this._closeSession(sessionId).catch(() => {})
    );

    await Promise.all(promises);

    this.sessions.clear();
    this.logger.info('Todas as sessões encerradas');
  }

  // --- Métodos Internos ---

  /**
   * Obtém instance do axios para a sessão
   */
  _getClient(sessionId) {
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, {
        sessionId,
        lastUsed: Date.now(),
      });
    }
    return this.clients.get(sessionId);
  }

  /**
   * Atualiza timestamp de última vez usada
   */
  _updateLastUsed(sessionId) {
    const sessionInfo = this.sessions.get(sessionId);
    if (sessionInfo) {
      sessionInfo.lastUsed = Date.now();
    }
  }

  /**
   * Delay utility
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Exporta padrão e funcionalidades standalone
const SessionManager = WhatsAppSessionManager;

// Funções utilitárias standalone (para quem prefere usar sem class)
const utils = {
  ensureConnected: async (sessionId, manager, options = {}) => {
    return manager.ensureConnected(sessionId, options);
  },

  closeIfNeeded: async (sessionId, manager) => {
    return manager.closeIfNeeded(sessionId);
  },

  sendMessage: async (sessionId, manager, number, message, options = {}) => {
    return manager.sendMessage(sessionId, number, message, options);
  },

  cleanup: async (manager, idleTime = null) => {
    return manager.cleanupIdleSessions(idleTime);
  },

  getStatus: async (sessionId, manager) => {
    return manager.getStatus(sessionId);
  },
};

module.exports = {
  default: SessionManager,
  SessionManager,
  utils,
};
