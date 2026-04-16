/**
 * Message Queue - Cold Start Implementation
 *
 * Gerencia fila de envio de mensagens com controle de concorrência.
 * Máximo de N sessões ativas simultâneas (padrão: 3).
 *
 * Uso:
 *   const queue = require('./messageQueue').default;
 *   const queue = new Queue({ baseURL, secretKey, maxSessions: 3 });
 *
 *   await queue.enqueue(sessionId, number, message);
 *
 *   // Obter status da fila
 *   const status = queue.getStatus();
 */

const WhatsAppSessionManager =
  require('./whatsappSessionManager').SessionManager;

class MessageQueue {
  /**
   * Inicializa a fila de mensagens
   * @param {object} config - Configurações
   * @param {string} config.baseURL - URL base do WPPConnect Server
   * @param {string} config.secretKey - Secret key
   * @param {number} config.maxSessions - Máximo sessões ativas (default: 3)
   * @param {number} config.idleTimeout - Timeout para fechar sessão inativa (ms)
   * @param {number} config.maxQueueSize - Tamanho máximo da fila (default: 100)
   * @param {number} config.processInterval - Intervalo entre tentativas de processar fila (ms)
   * @param {object} config.logger - Logger
   */
  constructor(config = {}) {
    // Cria Session Manager
    this.sessionManager = new WhatsAppSessionManager({
      baseURL:
        config.baseURL ||
        process.env.WPPCONNECT_URL ||
        'http://localhost:21465',
      secretKey:
        config.secretKey ||
        process.env.WPPCONNECT_SECRET_KEY ||
        'THISISMYSECURETOKEN',
      maxActiveSessions: config.maxSessions || 3,
      idleTimeout: config.idleTimeout || 300000, // 5 minutos
      logger: config.logger || console,
    });

    // Configurações da fila
    this.maxQueueSize = config.maxQueueSize || 100;
    this.processInterval = config.processInterval || 1000; // Tenta a cada 1s
    this.logger = config.logger || console;

    // Fila em memória
    this.queue = [];
    this.processing = false;

    // Configura auto-cleanup de sessões inativas
    if (config.enableAutoCleanup !== false) {
      setInterval(() => {
        this.sessionManager
          .cleanupIdleSessions(config.idleTimeout)
          .catch(() => {});
      }, config.cleanupInterval || 30000); // Verifica a cada 30s
    }

    // Inicia processador de fila
    this._startProcessor();

    this.logger.info(
      `MessageQueue inicializado. Max sessões: ${config.maxSessions || 3}`
    );
  }

  /**
   * Envia mensagem (enqueue + processar se estiver disponível)
   * @param {string} sessionId
   * @param {string} number
   * @param {string} message
   * @param {object} options
   * @returns {Promise<object>}
   */
  async enqueue(sessionId, number, message, options = {}) {
    // Verifica tamanho da fila
    if (this.queue.length >= this.maxQueueSize) {
      this.logger.warn(`Fila cheia (${this.maxQueueSize}). Rejeitando envio.`);
      throw new Error('Fila cheia. Aguarde envios anteriores.');
    }

    // Cria job
    const job = {
      id: Date.now() + Math.random().toString(36).substring(7),
      sessionId,
      number,
      message,
      options,
      status: 'pending',
      createdAt: Date.now(),
      retries: 0,
      lastError: null,
    };

    this.queue.push(job);
    this.logger.debug(
      `Job enfileirado: ${job.id} (${this.queue.length}/${this.maxQueueSize})`
    );

    // Se houver slots disponíveis, processa imediatamente
    if (this._hasAvailableSlot()) {
      await this._processNextJob();
    }

    return {
      success: true,
      jobId: job.id,
      queuePosition: this._getQueuePosition(job.id),
    };
  }

  /**
   * Processa próximo job da fila
   * @private
   */
  async _processNextJob() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      const job = this.queue.shift();

      if (!job) return;

      job.status = 'processing';

      // Verifica slot disponível
      if (!this._hasAvailableSlot()) {
        // Devolve na fila e sai
        this.queue.unshift(job);
        this.logger.debug(
          `Slot indisponível. Devolvendo job ${job.id} para fila.`
        );
        return;
      }

      // Processa job
      await this._executeJob(job);
    } catch (error) {
      this.logger.error(`Erro ao processar fila: ${error.message}`);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Executa job
   * @param {object} job
   * @returns {Promise<void>}
   */
  async _executeJob(job) {
    job.status = 'processing';

    try {
      // Garante que sessão está conectada
      await this.sessionManager.ensureConnected(job.sessionId, {
        phone: job.number?.split('@')[0] || null,
      });

      // Envia mensagem
      const result = await this.sessionManager.sendMessage(
        job.sessionId,
        job.number,
        job.message,
        job.options
      );

      // Sucesso
      job.status = 'completed';
      job.result = result;
      job.completedAt = Date.now();

      this.logger.info(
        `Job ${job.id} completado. Mensagem enviada para ${job.number}`
      );

      // Notifica webhook se configurado
      if (this.onComplete) {
        await this.onComplete(job, result);
      }
    } catch (error) {
      job.status = 'failed';
      job.lastError = error.message;
      job.retries++;

      this.logger.error(`Job ${job.id} falhou: ${error.message}`);

      // Decisão de re-enfileirar ou abandonar
      if (job.retries >= this.maxRetries || !this.shouldRetry()) {
        throw error; // Abandona job
      }

      // Re-enfileira com delay
      const delay = this._getRetryDelay(job.retries);
      this.logger.debug(
        `Re-enfileirando job ${job.id} em ${delay}ms (retries: ${job.retries})`
      );

      await this._delay(delay);
      this.queue.push(job);
    }
  }

  /**
   * Verifica se há slot disponível
   * @returns {boolean}
   */
  _hasAvailableSlot() {
    return this.sessionManager.getStats().availableSlots > 0;
  }

  /**
   * Obtém posição do job na fila
   * @param {string} jobId
   * @returns {number}
   */
  _getQueuePosition(jobId) {
    const index = this.queue.findIndex((j) => j.id === jobId);
    return index + 1;
  }

  /**
   * Configura max retries (default: 3)
   */
  setMaxRetries(maxRetries) {
    this.maxRetries = maxRetries;
  }

  /**
   * Decide se deve re-enfileirar (default: true)
   */
  shouldRetry() {
    return true; // Pode sobrescrever
  }

  /**
   * Obtém delay de retry exponencial (default: 1s, 2s, 4s, 8s)
   */
  _getRetryDelay(retry) {
    const baseDelay = 1000;
    const maxDelay = 30000; // 30s max
    return Math.min(baseDelay * Math.pow(2, retry - 1), maxDelay);
  }

  /**
   * Delay utility
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Callback de completion (opcional)
   */
  setOnComplete(callback) {
    this.onComplete = callback;
  }

  /**
   * Verifica status da fila
   * @returns {object}
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      availableSlots: this.sessionManager.getStats().availableSlots,
      maxSessions: this.sessionManager.getStats().maxActiveSessions,
      activeSessions: this.sessionManager.getStats().activeSessions,
      pendingJobs: this.queue.filter((j) => j.status === 'pending').length,
      processingJobs: this.queue.filter((j) => j.status === 'processing')
        .length,
      failedJobs: this.queue.filter((j) => j.status === 'failed').length,
      totalJobs: this.queue.length,
    };
  }

  /**
   * Limpa fila
   */
  async clearQueue() {
    const jobs = this.queue;
    this.queue = [];

    // Fecha sessões correspondentes
    const sessionIds = jobs
      .map((j) => j.sessionId)
      .filter((_, i, arr) => arr.indexOf(j) === i);
    await Promise.all(
      sessionIds.map((sessionId) =>
        this.sessionManager.closeIfNeeded(sessionId).catch(() => {})
      )
    );

    this.logger.info(`Fila limpa. ${jobs.length} jobs removidos.`);
  }

  /**
   * Inicia processador (método interno)
   * @private
   */
  _startProcessor() {
    if (!this.queue.length) {
      return;
    }

    this.logger.info(
      `Processador de fila iniciado. Intervalo: ${this.processInterval}ms`
    );

    // Processa imediatamente se houver jobs pendentes
    this._processNextJob();

    // Loop contínuo
    setInterval(() => {
      this._processNextJob().catch((error) => {
        this.logger.error(`Erro no processador de fila: ${error.message}`);
      });
    }, this.processInterval);
  }

  /**
   * Garante que sessões estejam ativas (para quem quer controle manual)
   * @param {string[]} sessionIds
   * @param {object[]} options - Array de { sessionId, options }
   */
  async ensureSessionsActive(sessionIds, options = []) {
    const promises = sessionIds.map((sessionId, i) =>
      this.sessionManager
        .ensureConnected(sessionIds[i], options[i] || {})
        .catch((error) => {
          this.logger.error(
            `[${sessionId}] Erro ao garantir sessão: ${error.message}`
          );
          throw error;
        })
    );

    await Promise.all(promises);

    return this.getStats();
  }

  /**
   * Método estático para usar sem instância
   */
  static async send(sessionManager, sessionId, number, message, options = {}) {
    return sessionManager.sendMessage(sessionId, number, message, options);
  }
}

module.exports = MessageQueue;
