/**
 * Exemplo de Integração - WhatsApp SaaS
 *
 * Demonstra como integrar cold-start sessions ao seu backend de SaaS
 */

const SessionManager = require('./whatsappSessionManager').default;
const MessageQueue = require('./messageQueue').default;

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================

const config = {
  wppConnectUrl: process.env.WPPCONNECT_URL || 'http://localhost:21465',
  secretKey: process.env.WPPCONNECT_SECRET_KEY || 'THISISMYSECURETOKEN',
  maxActiveSessions: 3, // Comece com 3, ajuste conforme necessário
  idleTimeout: 300000, // 5 minutos (300s)
  maxQueueSize: 50,
};

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

// Cria Session Manager
const sessionManager = new SessionManager({
  baseURL: config.wppConnectUrl,
  secretKey: config.secretKey,
  maxActiveSessions: config.maxActiveSessions,
  idleTimeout: config.idleTimeout,
  logger: console, // Use seu logger em produção
});

// Cria Message Queue (opcional, para fila)
const messageQueue = new MessageQueue({
  baseURL: config.wppConnectUrl,
  secretKey: config.secretKey,
  maxSessions: config.maxActiveSessions,
  maxQueueSize: config.maxQueueSize,
});

// ============================================================================
// FUNÇÕES DE ENVIO
// ============================================================================

/**
 * Envia mensagem (simples, sem fila)
 * @param {string} sessionId - ID da sessão (ex: tenantId)
 * @param {string} number - Número do cliente
 * @param {string} message - Texto da mensagem
 * @returns {Promise<object>}
 */
async function sendMessageSimple(sessionId, number, message) {
  try {
    // Garante que sessão está conectada
    const client = await sessionManager.ensureConnected(sessionId);

    // Envia mensagem
    const result = await client.sendMessage(number, message);

    // Fecha sessão se estiver inativa (opcional)
    await sessionManager.closeIfNeeded(sessionId);

    return {
      success: true,
      messageId: result,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error(`Erro ao enviar para ${number}:`, error.message);
    throw error;
  }
}

/**
 * Envia lembrete de agendamento
 * @param {string} tenantId - ID do tenant (empresa)
 * @param {string} clientPhone - Telefone do cliente
 * @param {object} appointment - Detalhes do agendamento
 * @returns {Promise<object>}
 */
async function sendAppointmentReminder(tenantId, clientPhone, appointment) {
  const sessionId = `tenant_${tenantId}`;
  const message = generateReminderMessage(appointment);

  return sendMessageSimple(sessionId, clientPhone, message);
}

/**
 * Envia mensagem de boas-vindas
 */
async function sendWelcomeMessage(tenantId, clientPhone) {
  const sessionId = `tenant_${tenantId}`;
  const message = 'Olá! Bem-vindo ao nosso agendamento online.';

  return sendMessageSimple(sessionId, clientPhone, message);
}

/**
 * Envia confirmation de agendamento
 */
async function sendConfirmation(tenantId, clientPhone, appointment) {
  const sessionId = `tenant_${tenantId}`;

  const message = `
Sua agendamento foi confirmado!

📅 Data: ${appointment.date}
⏰ Horário: ${appointment.time}
📍 Local: ${appointment.location || 'Online'}

Aguarde nossa mensagem de lembrete.

Att, Equipe Agendamento Online
  `;

  return sendMessageSimple(sessionId, clientPhone, message);
}

/**
 * Envia mensagem de lembrete 24h antes
 */
async function send24hReminder(tenantId, clientPhone, appointment) {
  const sessionId = `tenant_${tenantId}`;

  const message = `
Lembrete do seu agendamento!

⏰ Seu horário é às ${appointment.time}
📅 Data: ${appointment.date}

Estamos ansiosos para atendê-lo!

Att, Equipe Agendamento
  `;

  return sendMessageSimple(sessionId, clientPhone, message);
}

/**
 * Envia mensagem de lembrete 1h antes
 */
async function send1hReminder(tenantId, clientPhone, appointment) {
  const sessionId = `tenant_${tenantId}`;

  const message = `
🔔 Lembrete Importante!

Seu agendamento começa em 1 hora.
⏰ Horário: ${appointment.time}
📅 Data: ${appointment.date}

Não se esqueça de estar no horário!

Atenciosamente,
Equipe Agendamento
  `;

  return sendMessageSimple(sessionId, clientPhone, message);
}

/**
 * Envia mensagem de cancelamento
 */
async function sendCancellation(tenantId, clientPhone, reason) {
  const sessionId = `tenant_${tenantId}`;

  const message = `
Desculpe o inconveniente, mas seu agendamento precisou ser cancelado.

Motivo: ${reason}

Entraremos em contato para reagendar.

Att, Equipe Agendamento
  `;

  return sendMessageSimple(sessionId, clientPhone, message);
}

// ============================================================================
// EXEMPLOS DE MENSAGENS
// ============================================================================

function generateReminderMessage(appointment) {
  const date = new Date(appointment.date);
  const time = date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const day = date.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return `
📅 Lembrete de Agendamento

Olá! Isso é um lembrete para o seu atendimento.

Dia: ${day}
Horário: ${time}

Por favor, esteja no horário agendado.

Caso precise cancelar, entre em contato conosco.

Att, Equipe Agendamento Online
  `;
}

// ============================================================================
// USO COM FILA (MessageQueue)
// ============================================================================

/**
 * Envia mensagem usando fila (para alta concorrência)
 */
async function sendWithQueue(tenantId, clientPhone, message) {
  const sessionId = `tenant_${tenantId}`;

  try {
    // Enfileira envio
    const result = await messageQueue.enqueue(sessionId, clientPhone, message);

    console.log(`Mensagem enfileirada: ${result.queuePosition}ª na fila`);

    return {
      success: true,
      jobId: result.jobId,
      queuePosition: result.queuePosition,
    };
  } catch (error) {
    console.error(`Erro ao enfileirar:`, error.message);
    throw error;
  }
}

/**
 * Verifica status da fila
 */
function checkQueueStatus() {
  const status = messageQueue.getStatus();

  console.log('Status da Fila:', {
    jobsPending: status.pendingJobs,
    queueLength: status.queueLength,
    availableSlots: status.availableSlots,
    activeSessions: status.activeSessions,
  });
}

// ============================================================================
// MONITORAMENTO
// ============================================================================

/**
 * Verifica status de sessão
 */
async function checkSessionStatus(sessionId) {
  const status = await sessionManager.getStatus(sessionId);

  return status;
}

/**
 * Limpa sessões inativas (manual)
 */
async function cleanupIdleSessions() {
  console.log('Limpando sessões inativas...');
  await sessionManager.cleanupIdleSessions(config.idleTimeout);
  console.log('Limpeza concluída.');
}

/**
 * Estatísticas do sistema
 */
function getSystemStats() {
  const stats = sessionManager.getStats();

  return {
    activeSessions: stats.activeSessions,
    maxSessions: stats.maxActiveSessions,
    availableSlots: stats.availableSlots,
    queue: messageQueue.getStatus(),
  };
}

// ============================================================================
// MONITORAMENTO AUTOMÁTICO
// ============================================================================

/**
 * Monitoramento de sessões (opcional)
 */
setInterval(() => {
  const stats = getSystemStats();

  if (stats.activeSessions >= stats.maxSessions * 0.8) {
    console.warn(
      `⚠️  Alta carga de sessões: ${stats.activeSessions}/${stats.maxSessions}`
    );
  }

  if (stats.queue.queueLength > stats.maxQueueSize * 0.8) {
    console.warn(
      `⚠️  Fila quase cheia: ${stats.queue.queueLength}/${stats.queue.maxQueueSize}`
    );
  }
}, 30000); // Verifica a cada 30s

// ============================================================================
// WEBHOOKS (Exemplo)
// ============================================================================

/**
 * Handler para webhook de agendamento
 */
async function handleAppointmentWebhook(req) {
  const { tenantId, clientPhone, appointment, type } = req.body;

  try {
    switch (type) {
      case 'confirmation':
        await sendConfirmation(tenantId, clientPhone, appointment);
        break;

      case 'reminder_24h':
        await send24hReminder(tenantId, clientPhone, appointment);
        break;

      case 'reminder_1h':
        await send1hReminder(tenantId, clientPhone, appointment);
        break;

      case 'cancellation':
        await sendCancellation(tenantId, clientPhone, appointment.reason);
        break;

      default:
        console.log(`Tipo desconhecido: ${type}`);
    }

    return { success: true };
  } catch (error) {
    console.error(`Erro no webhook:`, error.message);

    // Retorna erro para webhook original
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Middleware para rate limiting por tenant
 */
function createRateLimitMiddleware(limit = 100, windowMs = 3600000) {
  const rateLimits = new Map();

  return async (req, res, next) => {
    const tenantId = req.params.tenantId;
    const now = Date.now();

    // Limpa limites expirados
    for (const [id, data] of rateLimits) {
      if (now - data.timestamp > windowMs) {
        rateLimits.delete(id);
      }
    }

    const current = rateLimits.get(tenantId) || { count: 0, timestamp: now };

    if (current.count >= limit) {
      return res.status(429).json({
        success: false,
        error: 'Limite de mensagens atingido',
        retryAfter: Math.ceil((windowMs - (now - current.timestamp)) / 1000),
      });
    }

    current.count++;
    rateLimits.set(tenantId, current);

    // Limpa após tempo
    setTimeout(() => {
      rateLimits.delete(tenantId);
    }, windowMs);

    next();
  };
}

// ============================================================================
// EXPRESS ROUTES (Exemplo)
// ============================================================================

/*
const express = require('express');
const router = express.Router();

// Rotas com cold-start
router.post('/appointment-confirmation', async (req, res) => {
  const result = await handleAppointmentWebhook(req);

  if (result.success) {
    res.json({ success: true, message: 'Lembrete enviado' });
  } else {
    res.status(500).json(result);
  }
});

// Rotas com rate limiting
router.post('/reminder/:tenantId',
  createRateLimitMiddleware(10, 3600000),
  async (req, res) => {
    const result = await send24hReminder(
      req.params.tenantId,
      req.body.phone,
      req.body.appointment
    );

    res.json(result);
  }
);

// Rotas com fila
router.post('/queue/:tenantId', async (req, res) => {
  const result = await sendWithQueue(
    req.params.tenantId,
    req.body.phone,
    req.body.message
  );

  res.json(result);
});
*/

// ============================================================================
// TESTE DE CONEXÃO
// ============================================================================

async function testConnection() {
  console.log('Testando conexão com WPPConnect Server...');

  try {
    // Testa com uma sessão de teste
    await sessionManager.ensureConnected('TEST_SESSION', {
      phone: '5511999999999', // Número para teste
    });

    // Verifica status
    const status = await sessionManager.getStatus('TEST_SESSION');
    console.log('Status:', status);

    // Fecha sessão de teste
    await sessionManager.closeIfNeeded('TEST_SESSION');

    console.log('Teste concluído com sucesso!');
  } catch (error) {
    console.log(
      'Teste falhou (esperado se não tiver sessão conectada):',
      error.message
    );
  }
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

async function init() {
  console.log('Iniciando WhatsApp Cold-Start Services...\n');

  // Testa conexão
  await testConnection();

  // Mostra stats
  const stats = getSystemStats();
  console.log('Stats:', stats);

  console.log('\nServiços prontos para uso!');
}

// Executa se rodado direto
if (require.main === module) {
  init();
}

module.exports = {
  SessionManager,
  MessageQueue,
  sendMessageSimple,
  sendAppointmentReminder,
  checkSessionStatus,
  checkQueueStatus,
  getSystemStats,
};
